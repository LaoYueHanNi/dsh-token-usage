/**
 * Durable JSONL store of the token-usage plugin: per-local-day files, a
 * serialized append queue, and the process-wide request-id dedupe set that
 * both the live hook and the manual sync share. A row lands in the day
 * file of its event time (`record.time` in local Y-M-D), never the wall
 * clock of the append — live events and history backfill share that rule.
 *
 * @module token-usage/usage-log
 */

import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { consoleLogger, type LoggerLike } from './log.ts'
import { extractFirstTokenTimeFromStream, parseRecord, serializeRecord, type UsageRecord } from './usage-record.ts'
import { readerOf, type SyncPersistence } from './sync.ts'

const DAY_FILE = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/u

/** Test for this store's per-day file names; the migration shares the naming contract. */
export { DAY_FILE }

/** Day-file name for a local-time date, e.g. `usage-2026-01-15.jsonl`. */
export function dayFileName(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `usage-${year}-${month}-${day}.jsonl`
}

/** Day-file name of a record's event time, matching {@link dayFileName}. */
export function dayFileNameOf(time: number): string {
  return dayFileName(new Date(time))
}

function dayFilePath(dir: string, time: number): string {
  return join(dir, dayFileNameOf(time))
}

/**
 * Append-only per-day JSONL log with request-id dedupe.
 *
 * Ordering: every append (and a refile pass) runs on one promise chain, so
 * concurrent callers land in call order. Dedupe: a request id is claimed
 * synchronously before its append is queued; a failed append releases the
 * claim, so the row can be retried later.
 */
export class UsageLog {
  private readonly seen = new Set<string>()
  /** Owning session of every saved id; the reconcile pass uses it to protect
   * the rows of sessions whose log could not be read. */
  private readonly owners = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()
  private ready: Promise<void> | undefined

  /**
   * @param dir - absolute data directory (created lazily on first write).
   * @param logger - diagnostic sink; defaults to console.
   */
  constructor(
    private readonly dir: string,
    private readonly logger: LoggerLike = consoleLogger,
  ) {}

  /** Whether a request id is already known to this log. */
  has(requestId: string): boolean {
    return this.seen.has(requestId)
  }

  /**
   * Snapshot every saved request id. A reconcile pass takes this *before* the
   * session walk so a row appended by a live request while the walk runs is
   * never a deletion candidate.
   */
  ids(): ReadonlySet<string> {
    return new Set(this.seen)
  }

  /**
   * Settle every queued append. The chain never rejects (each task absorbs
   * its own failure), so this is the quiescence point a data-directory
   * migration waits on before reading the files.
   * @returns settlement after the last queued append.
   */
  flush(): Promise<void> {
    return this.queue
  }

  /**
   * Rebuild the dedupe set from every existing day file. Malformed lines are
   * skipped with a console diagnostic; unreadable files are skipped the same
   * way, so a corrupt log never blocks the sync.
   */
  async scan(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined)
    await this.ready
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      this.logger.error('[token-usage] cannot list data dir ' + this.dir + ':', error)
      return
    }
    for (const name of names) {
      if (!DAY_FILE.test(name)) continue
      const text = await readFile(join(this.dir, name), 'utf8').catch((error: unknown) => {
        this.logger.error(`[token-usage] cannot read ${name}:`, error)
        return ''
      })
      for (const line of text.split('\n')) {
        if (line === '') continue
        const record = parseRecord(line)
        if (record === null) {
          this.logger.error(`[token-usage] skipping malformed line in ${name}: ${line.slice(0, 120)}`)
          continue
        }
        this.seen.add(record.requestId)
        this.owners.set(record.requestId, record.sessionId)
      }
    }
  }

  /**
   * Persist one record unless its request id was already written.
   * @returns true when the row was appended, false when deduped.
   */
  record(record: UsageRecord): Promise<boolean> {
    if (this.seen.has(record.requestId)) return Promise.resolve(false)
    // Claim before queueing: a concurrent call with the same id dedupes here.
    this.seen.add(record.requestId)
    this.owners.set(record.requestId, record.sessionId)
    const task = this.queue.then(async () => {
      await this.ensureDir()
      await this.appendOnce(record)
    })
    // A failed append must not poison the chain for later rows.
    this.queue = task.catch(() => {})
    return task
      .then(() => true)
      .catch((error: unknown) => {
        // Release the claim so a later sync can retry this row.
        this.seen.delete(record.requestId)
        this.owners.delete(record.requestId)
        this.logger.error('[token-usage] append failed:', error)
        return false
      })
  }

  /**
   * Move rows that sit in the wrong day file onto `dayFileNameOf(record.time)`.
   * Idempotent: a crash after the target already holds a request id just
   * strips it from the source on the next pass. Runs on the append queue so
   * a live write cannot interleave with the rewrite.
   * @returns the number of rows that had to move.
   */
  refileByEventDay(): Promise<number> {
    let moved = 0
    const task = this.queue.then(async () => {
      await this.ensureDir()
      moved = await refileDayFiles(this.dir, this.logger)
    })
    this.queue = task.catch(() => {})
    return task.then(() => moved).catch((error: unknown) => {
      this.logger.error('[token-usage] refile by event day failed:', error)
      return 0
    })
  }

  /**
   * Backfill missing latencyMs and firstTokenLatencyMs into existing day files
   * from the authoritative session persistence events.
   * Runs on the append queue so a live write cannot interleave with the rewrite.
   * @param persistence - host session persistence.
   * @returns the number of rows that were backfilled with timing.
   */
  backfillTiming(persistence: SyncPersistence): Promise<number> {
    let patched = 0
    const task = this.queue.then(async () => {
      await this.ensureDir()
      patched = await backfillDayFilesTiming(this.dir, persistence, this.logger)
    })
    this.queue = task.catch(() => {})
    return task.then(() => patched).catch((error: unknown) => {
      this.logger.error('[token-usage] timing backfill failed:', error)
      return 0
    })
  }

  /**
   * Drop every saved row that the authoritative session walk did not
   * reproduce. A row whose request id no longer appears in any session log is
   * a relic of an older stored format: the host rewrote the event coordinates
   * when it migrated the log to the current format generation, so the walk
   * reproduces the same requests under new ids.
   *
   * Three guards keep this pass from destroying live data:
   * - only ids in `eligible` (the snapshot taken before the walk) are
   *   candidates, so a row a live request appended during the walk survives;
   * - a row is dropped only when its owning session was read **in full** by
   *   the walk, so "the walk did not see it" is never inferred from a session
   *   that failed to load, from a session missing out of the list (deleted,
   *   or hidden behind a header this build cannot read), or from a row whose
   *   owner is unknown;
   * - malformed lines are never candidates and stay where they are.
   *
   * A day file is rewritten only when it actually loses a row, and the
   * rewrite is atomic. Runs on the append queue so a live write cannot
   * interleave with it.
   * @param keep - request ids the walk reproduced from readable sessions.
   * @param readableSessions - sessions the walk read in full.
   * @param eligible - the pre-walk snapshot of saved request ids.
   * @returns the number of rows removed.
   */
  reconcile(
    keep: ReadonlySet<string>,
    readableSessions: ReadonlySet<string>,
    eligible: ReadonlySet<string>,
  ): Promise<number> {
    let removed = 0
    const task = this.queue.then(async () => {
      // Deliberately no ensureDir: a reconcile still queued when this store's
      // directory is relocated away would otherwise resurrect it. A missing
      // directory has nothing to reconcile, and readdir reports exactly that.
      const dropped = await reconcileDayFiles(
        this.dir,
        { keep, readableSessions, eligible, owners: this.owners },
        this.logger,
      )
      removed = dropped.length
      for (const id of dropped) {
        this.seen.delete(id)
        this.owners.delete(id)
      }
    })
    this.queue = task.catch(() => {})
    return task.then(() => removed).catch((error: unknown) => {
      this.logger.error('[token-usage] reconcile failed:', error)
      return 0
    })
  }

  /** The directory is created once and remembered; an external deletion
   * forces a rebuild on the next append (see {@link appendOnce}). */
  private async ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined)
    await this.ready
  }

  /**
   * Append one row, self-healing once when the directory vanished after the
   * cached creation: the data location may be removed underneath a running
   * process (a migration that stayed behind, a user cleanup), and failing
   * every append forever after would silently drop the whole session's rows.
   * The destination is the local day of {@link UsageRecord.time}, so a
   * history sync lands each row on the day the request happened.
   */
  private async appendOnce(record: UsageRecord): Promise<void> {
    const path = dayFilePath(this.dir, record.time)
    try {
      await appendFile(path, `${serializeRecord(record)}\n`, { flag: 'a' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.ready = undefined
      await this.ensureDir()
      await appendFile(path, `${serializeRecord(record)}\n`, { flag: 'a' })
    }
  }
}

/** One parsed day-file line: a record, or a raw malformed line kept in place. */
interface DayLine {
  record: UsageRecord | null
  raw: string
}

async function readDayLines(dir: string, name: string, logger: LoggerLike): Promise<DayLine[]> {
  const text = await readFile(join(dir, name), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(`[token-usage] cannot read ${name}:`, error)
    }
    return ''
  })
  const lines: DayLine[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    lines.push({ record: parseRecord(raw), raw })
  }
  return lines
}

async function rewriteDayFile(dir: string, name: string, records: UsageRecord[]): Promise<void> {
  const target = join(dir, name)
  if (records.length === 0) {
    await unlink(target).catch(() => undefined)
    return
  }
  const tmp = join(dir, `${name}.tmp`)
  await writeFile(tmp, `${records.map(serializeRecord).join('\n')}\n`, 'utf8')
  await unlink(target).catch(() => undefined)
  await rename(tmp, target)
}

/**
 * Redistribute parsed rows onto the day file their event time names.
 * Malformed lines stay in the source file so a bad row is never dropped.
 */
async function refileDayFiles(dir: string, logger: LoggerLike): Promise<number> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => DAY_FILE.test(name)).sort()
  } catch (error) {
    logger.error('[token-usage] cannot list data dir ' + dir + ':', error)
    return 0
  }
  let moved = 0
  for (const source of names) {
    const lines = await readDayLines(dir, source, logger)
    const stay: UsageRecord[] = []
    const stray: string[] = []
    const leave = new Map<string, UsageRecord[]>()
    for (const line of lines) {
      if (line.record === null) {
        stray.push(line.raw)
        continue
      }
      const target = dayFileNameOf(line.record.time)
      if (target === source) {
        stay.push(line.record)
        continue
      }
      const bucket = leave.get(target) ?? []
      bucket.push(line.record)
      leave.set(target, bucket)
      moved += 1
    }
    if (leave.size === 0) continue
    for (const [target, records] of leave) {
      const existing = (await readDayLines(dir, target, logger))
        .map(line => line.record)
        .filter((record): record is UsageRecord => record !== null)
      const seen = new Set(existing.map(record => record.requestId))
      const appended = records.filter(record => !seen.has(record.requestId))
      await rewriteDayFile(dir, target, [...existing, ...appended])
    }
    if (stray.length > 0) {
      const target = join(dir, source)
      const body = `${stay.map(serializeRecord).join('\n')}${stay.length > 0 ? '\n' : ''}${stray.join('\n')}\n`
      const tmp = join(dir, `${source}.tmp`)
      await writeFile(tmp, body, 'utf8')
      await unlink(target).catch(() => undefined)
      await rename(tmp, target)
    } else {
      await rewriteDayFile(dir, source, stay)
    }
  }
  return moved
}

/** The decision inputs of one reconcile pass. */
interface ReconcileSets {
  /** Request ids the session walk reproduced from readable sessions. */
  keep: ReadonlySet<string>
  /** Sessions the walk read in full; only their rows may be dropped. */
  readableSessions: ReadonlySet<string>
  /** Saved ids as of the walk's start — the only rows that may be dropped. */
  eligible: ReadonlySet<string>
  /** Owning session of every saved id. */
  owners: ReadonlyMap<string, string>
}

/**
 * Rewrite every day file without the rows {@link ReconcileSets} marks
 * droppable, and report the dropped ids. A file is touched only when it
 * actually loses a row; malformed lines stay in place so a bad row is never
 * silently dropped by the pass that exists to remove rows on purpose.
 */
async function reconcileDayFiles(dir: string, sets: ReconcileSets, logger: LoggerLike): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => DAY_FILE.test(name)).sort()
  } catch (error) {
    logger.error('[token-usage] cannot list data dir ' + dir + ':', error)
    return []
  }
  const dropped: string[] = []
  for (const name of names) {
    const lines = await readDayLines(dir, name, logger)
    const stay: UsageRecord[] = []
    const stray: string[] = []
    let lost = 0
    for (const line of lines) {
      if (line.record === null) {
        stray.push(line.raw)
        continue
      }
      const id = line.record.requestId
      const doomed = sets.eligible.has(id)
        && !sets.keep.has(id)
        && sets.readableSessions.has(sets.owners.get(id) ?? '')
      if (doomed) {
        dropped.push(id)
        lost += 1
        continue
      }
      stay.push(line.record)
    }
    if (lost === 0) continue
    if (stray.length > 0) {
      const target = join(dir, name)
      const body = `${stay.map(serializeRecord).join('\n')}${stay.length > 0 ? '\n' : ''}${stray.join('\n')}\n`
      const tmp = join(dir, `${name}.tmp`)
      await writeFile(tmp, body, 'utf8')
      await unlink(target).catch(() => undefined)
      await rename(tmp, target)
    } else {
      await rewriteDayFile(dir, name, stay)
    }
  }
  return dropped
}

/**
 * Scan day files for plain requests lacking latencyMs, resolve their timing
 * from session persistence events, and rewrite touched day files atomically.
 */
export async function backfillDayFilesTiming(
  dir: string,
  persistence: SyncPersistence,
  logger: LoggerLike = consoleLogger,
): Promise<number> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => DAY_FILE.test(name)).sort()
  } catch (error) {
    logger.error('[token-usage] cannot list data dir ' + dir + ':', error)
    return 0
  }
  const fileLines = new Map<string, DayLine[]>()
  const missingBySession = new Map<string, Map<string, UsageRecord>>()

  for (const name of names) {
    const lines = await readDayLines(dir, name, logger)
    let fileHasMissing = false
    for (const line of lines) {
      if (line.record === null) continue
      // Only plain requests lacking latencyMs or firstTokenLatencyMs are backfill candidates
      if (line.record.kind === undefined && (line.record.latencyMs === undefined || line.record.firstTokenLatencyMs === undefined)) {
        fileHasMissing = true
        let sessionMap = missingBySession.get(line.record.sessionId)
        if (sessionMap === undefined) {
          sessionMap = new Map()
          missingBySession.set(line.record.sessionId, sessionMap)
        }
        sessionMap.set(line.record.requestId, line.record)
      }
    }
    if (fileHasMissing) {
      fileLines.set(name, lines)
    }
  }

  if (missingBySession.size === 0) return 0

  const reader = readerOf(persistence)
  let patchedCount = 0

  for (const [sessionId, targetMap] of missingBySession) {
    try {
      const inspection = await reader.read(sessionId as SessionId)
      let openStep: { turn: number; step: number; startTime: number } | null = null
      for (const event of inspection.events) {
        if (event.type === 'step/start') {
          openStep = {
            turn: event.data.turn,
            step: event.data.step,
            startTime: event.time,
          }
        } else if (event.type === 'assistant/message') {
          if (targetMap.has(event.data.message.id)) {
            const targetRecord = targetMap.get(event.data.message.id)!
            if (openStep !== null
              && openStep.turn === event.data.turn
              && openStep.step === event.data.step) {
              targetRecord.latencyMs = Math.max(0, event.time - openStep.startTime)
              // dsh 0.1.7 embeds the timed model stream inside assistant/message.
              const firstTokenTime = 'stream' in event.data && event.data.stream
                ? extractFirstTokenTimeFromStream(event.data.stream)
                : undefined
              if (firstTokenTime !== undefined) {
                targetRecord.firstTokenLatencyMs = Math.max(0, firstTokenTime - openStep.startTime)
              }
              patchedCount += 1
            }
          }
          openStep = null
        } else if (event.type === 'step/end' || event.type === 'turn/end') {
          openStep = null
        }
      }
    } catch (error) {
      logger.warn(`[token-usage] session ${sessionId} unreadable during timing backfill, skipped:`, error instanceof Error ? error.message : String(error))
    }
  }

  if (patchedCount === 0) return 0

  for (const [name, lines] of fileLines) {
    const stay: UsageRecord[] = []
    const stray: string[] = []
    for (const line of lines) {
      if (line.record === null) {
        stray.push(line.raw)
      } else {
        stay.push(line.record)
      }
    }
    if (stray.length > 0) {
      const target = join(dir, name)
      const body = `${stay.map(serializeRecord).join('\n')}${stay.length > 0 ? '\n' : ''}${stray.join('\n')}\n`
      const tmp = join(dir, `${name}.tmp`)
      await writeFile(tmp, body, 'utf8')
      await unlink(target).catch(() => undefined)
      await rename(tmp, target)
    } else {
      await rewriteDayFile(dir, name, stay)
    }
  }

  return patchedCount
}

