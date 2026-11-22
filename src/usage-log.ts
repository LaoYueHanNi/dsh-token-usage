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
import { backupDayFiles } from './backup.ts'
import { consoleLogger, type LoggerLike } from './log.ts'
import {
  coerceRecord,
  extractFirstTokenTimeFromStream,
  isReconcilableKind,
  parseRecord,
  serializeRecord,
  type UsageRecord,
} from './usage-record.ts'
import { readerOf, type SyncPersistence } from './sync.ts'
import type { FieldCompleter } from './field-completion.ts'

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
   * Fill absent fields declared by `completers` from the session logs.
   * Runs on the append queue. A thrown walk reports nothing settled, so
   * the caller does not stamp the pass and the next startup retries it.
   * @param persistence - host session persistence.
   * @param completers - the still-pending completers.
   */
  completeFields(persistence: SyncPersistence, completers: readonly FieldCompleter[]): Promise<FieldCompletionResult> {
    let result: FieldCompletionResult = { patched: 0, cleanIds: [], retriedIds: [], failedSessions: 0 }
    const task = this.queue.then(async () => {
      await this.ensureDir()
      result = await completeDayFiles(this.dir, persistence, completers, this.logger)
    })
    this.queue = task.catch(() => {})
    return task.then(() => result).catch((error: unknown) => {
      this.logger.error('[token-usage] field completion failed:', error)
      return { patched: 0, cleanIds: [], retriedIds: [], failedSessions: 0 }
    })
  }

  /**
   * Drop every saved row that the authoritative session walk did not
   * reproduce (and reassign session-log-derived rows whose owning session was
   * misattributed by an older walk order). A row whose request id no longer
   * appears in any session log is a relic of an older stored format or an
   * inherited fork prefix that the child session once duplicated.
   *
   * Four guards keep this pass from destroying live or bypass data:
   * - only ids in `eligible` (the snapshot taken before the walk) are
   *   candidates, so a row a live request appended during the walk survives;
   * - non-session-log rows (`kind: 'aux'` and any unknown future kind) are
   *   unconditionally exempt from both deletion and reassignment; web-search
   *   rows are session-log derived and stay reconcilable;
   * - a row is dropped only when its owning session was read **in full** by
   *   the walk, so "the walk did not see it" is never inferred from a session
   *   that failed to load, from a session missing out of the list (deleted,
   *   or hidden behind a header this build cannot read), or from a row whose
   *   owner is unknown;
   * - malformed lines are never candidates and stay where they are.
   *
   * Touched day files are backed up atomically to `.backups/` before rewriting,
   * and rewritten only when a row changes or drops. Runs on the append queue
   * so a live write cannot interleave with it.
   * @param keep - request ids the walk reproduced from readable sessions.
   * @param readableSessions - sessions the walk read in full.
   * @param eligible - the pre-walk snapshot of saved request ids.
   * @param expectedOwners - optional unique owning session per reproduced id.
   * @param onReassigned - optional callback reporting how many rows changed owner.
   * @returns the number of rows removed.
   */
  reconcile(
    keep: ReadonlySet<string>,
    readableSessions: ReadonlySet<string>,
    eligible: ReadonlySet<string>,
    expectedOwners?: ReadonlyMap<string, string>,
    onReassigned?: (count: number) => void,
  ): Promise<number> {
    let removed = 0
    const task = this.queue.then(async () => {
      // Deliberately no ensureDir: a reconcile still queued when this store's
      // directory is relocated away would otherwise resurrect it. A missing
      // directory has nothing to reconcile, and readdir reports exactly that.
      const result = await reconcileDayFiles(
        this.dir,
        { keep, readableSessions, eligible, owners: this.owners, expectedOwners },
        this.logger,
      )
      removed = result.dropped.length
      for (const id of result.dropped) {
        this.seen.delete(id)
        this.owners.delete(id)
      }
      for (const [id, owner] of result.reassigned) {
        this.owners.set(id, owner)
      }
      if (result.reassigned.size > 0) {
        onReassigned?.(result.reassigned.size)
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

/** One parsed day-file line: a record, its original raw `kind`, and original text. */
interface DayLine {
  record: UsageRecord | null
  rawKind: unknown
  raw: string
  dirty?: boolean
}

function parseDayLine(raw: string): DayLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { record: null, rawKind: undefined, raw }
  }
  const rawKind = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).kind
    : undefined
  return { record: coerceRecord(parsed), rawKind, raw }
}

async function listDayFileNames(dir: string, logger: LoggerLike): Promise<string[] | null> {
  try {
    return (await readdir(dir)).filter(name => DAY_FILE.test(name)).sort()
  } catch (error) {
    logger.error('[token-usage] cannot list data dir ' + dir + ':', error)
    return null
  }
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
    lines.push(parseDayLine(raw))
  }
  return lines
}

/**
 * Replace a file with new content, atomically for the reader: the new bytes
 * land in a sibling temp file, and the rename swaps it in. `rename` replaces
 * an existing target on Windows (MoveFileEx + REPLACE_EXISTING), so no window
 * exists in which the day file is missing — unlinking the target first would
 * drop every row of that day should the process die between the two calls.
 * The unlink survives only as a fallback for filesystems that refuse to
 * overwrite.
 * @param tmp - the temp file holding the new content.
 * @param target - the file to replace.
 */
async function replaceFile(tmp: string, target: string): Promise<void> {
  try {
    await rename(tmp, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw error
    await unlink(target).catch(() => undefined)
    await rename(tmp, target)
  }
}

/**
 * Atomically rewrite one day file from its surviving lines. Unmodified lines
 * keep their exact original JSON text so unknown future fields and malformed
 * lines round-trip untouched.
 */
async function writeDayLines(dir: string, name: string, lines: readonly DayLine[]): Promise<void> {
  const target = join(dir, name)
  if (lines.length === 0) {
    await unlink(target).catch(() => undefined)
    return
  }
  const body = `${lines.map(line => (line.dirty === true && line.record !== null ? serializeRecord(line.record) : line.raw)).join('\n')}\n`
  const tmp = join(dir, `${name}.tmp`)
  await writeFile(tmp, body, 'utf8')
  await replaceFile(tmp, target)
}

/**
 * Redistribute parsed rows onto the day file their event time names.
 * Malformed lines stay in the source file so a bad row is never dropped.
 */
async function refileDayFiles(dir: string, logger: LoggerLike): Promise<number> {
  const names = await listDayFileNames(dir, logger)
  if (names === null) return 0
  const sourceLines = new Map<string, DayLine[]>()
  const sourcePlans = new Map<string, DayLine[]>()
  const incomingByTarget = new Map<string, DayLine[]>()
  let moved = 0
  for (const source of names) {
    const lines = await readDayLines(dir, source, logger)
    sourceLines.set(source, lines)
    const stay: DayLine[] = []
    let sourceChanged = false
    for (const line of lines) {
      if (line.record === null) {
        stay.push(line)
        continue
      }
      const target = dayFileNameOf(line.record.time)
      if (target === source) {
        stay.push(line)
        continue
      }
      const bucket = incomingByTarget.get(target) ?? []
      bucket.push(line)
      incomingByTarget.set(target, bucket)
      sourceChanged = true
      moved += 1
    }
    if (sourceChanged) {
      sourcePlans.set(source, stay)
    }
  }
  if (moved === 0) return 0

  const finalContents = new Map<string, DayLine[]>()
  for (const [source, stay] of sourcePlans) {
    finalContents.set(source, stay)
  }
  for (const [target, incoming] of incomingByTarget) {
    const base = finalContents.get(target)
      ?? sourceLines.get(target)
      ?? await readDayLines(dir, target, logger)
    const seen = new Set<string>()
    for (const line of base) {
      if (line.record !== null) seen.add(line.record.requestId)
    }
    const appended: DayLine[] = []
    for (const line of incoming) {
      /* v8 ignore next -- only lines with a valid record enter incomingByTarget. */
      if (line.record === null) continue
      if (seen.has(line.record.requestId)) continue
      seen.add(line.record.requestId)
      appended.push(line)
    }
    finalContents.set(target, [...base, ...appended])
  }

  await backupDayFiles(dir, [...finalContents.keys()], 'refile', logger)
  for (const [name, lines] of finalContents) {
    await writeDayLines(dir, name, lines)
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
  /** Authoritative owning session per reproduced id when unique across sessions. */
  expectedOwners?: ReadonlyMap<string, string> | undefined
}

/** Result of reconciling day files on disk. */
interface ReconcileDayFilesResult {
  dropped: string[]
  reassigned: Map<string, string>
}

/**
 * Rewrite touched day files without stale droppable rows and with unique
 * session-owner reassignments applied. Non-session-log origins (`kind: 'aux'`
 * and any unknown future kind) are exempt; `kind: 'web'` is session-log
 * derived and therefore reconcilable like a plain request. Unreadable-session
 * rows, mid-walk live rows, and malformed lines remain intact. Touched files
 * are backed up before any rewrite.
 */
async function reconcileDayFiles(
  dir: string,
  sets: ReconcileSets,
  logger: LoggerLike,
): Promise<ReconcileDayFilesResult> {
  const names = await listDayFileNames(dir, logger)
  if (names === null) return { dropped: [], reassigned: new Map() }
  const dropped: string[] = []
  const reassigned = new Map<string, string>()
  const touched = new Map<string, DayLine[]>()
  for (const name of names) {
    const lines = await readDayLines(dir, name, logger)
    const stay: DayLine[] = []
    let fileChanged = false
    for (const line of lines) {
      if (line.record === null) {
        stay.push(line)
        continue
      }
      if (!isReconcilableKind(line.rawKind)) {
        stay.push(line)
        continue
      }
      const id = line.record.requestId
      const currentOwner = sets.owners.get(id) ?? line.record.sessionId
      const doomed = sets.eligible.has(id)
        && !sets.keep.has(id)
        && sets.readableSessions.has(currentOwner)
      if (doomed) {
        dropped.push(id)
        fileChanged = true
        continue
      }
      const expectedOwner = sets.expectedOwners?.get(id)
      if (sets.eligible.has(id)
        && expectedOwner !== undefined
        && expectedOwner !== line.record.sessionId
        && sets.readableSessions.has(line.record.sessionId)
        && sets.readableSessions.has(expectedOwner)) {
        line.record.sessionId = expectedOwner
        line.dirty = true
        reassigned.set(id, expectedOwner)
        fileChanged = true
      }
      stay.push(line)
    }
    if (fileChanged) {
      touched.set(name, stay)
    }
  }
  if (touched.size === 0) return { dropped, reassigned }
  await backupDayFiles(dir, [...touched.keys()], 'reconcile', logger)
  for (const [name, lines] of touched) {
    await writeDayLines(dir, name, lines)
  }
  return { dropped, reassigned }
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
  const names = await listDayFileNames(dir, logger)
  if (names === null) return 0
  const fileLines = new Map<string, DayLine[]>()
  const missingBySession = new Map<string, Map<string, { line: DayLine; fileName: string }>>()

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
        sessionMap.set(line.record.requestId, { line, fileName: name })
      }
    }
    if (fileHasMissing) {
      fileLines.set(name, lines)
    }
  }

  if (missingBySession.size === 0) return 0

  const reader = readerOf(persistence)
  const changedFiles = new Set<string>()
  let patchedCount = 0

  for (const [sessionId, targetMap] of missingBySession) {
    try {
      const inspection = await reader.read(sessionId as SessionId)
      let openStep: { turn: number; step: number; startTime: number } | null = null
      for (const event of inspection.events) {
        if (event.type === 'session/end-seed') {
          openStep = null
        } else if (event.type === 'step/start') {
          openStep = {
            turn: event.data.turn,
            step: event.data.step,
            startTime: event.time,
          }
        } else if (event.type === 'assistant/message') {
          const targetEntry = targetMap.get(event.data.message.id)
          if (targetEntry !== undefined && targetEntry.line.record !== null) {
            const targetRecord = targetEntry.line.record
            if (openStep !== null
              && openStep.turn === event.data.turn
              && openStep.step === event.data.step) {
              const latencyMs = Math.max(0, event.time - openStep.startTime)
              // The timed model stream embedded in assistant/message carries
              // the first token delta's timestamp.
              const firstTokenTime = extractFirstTokenTimeFromStream(event.data.stream)
              const firstTokenLatencyMs = firstTokenTime !== undefined
                ? Math.max(0, firstTokenTime - openStep.startTime)
                : undefined
              let rowUpdated = false
              if (targetRecord.latencyMs !== latencyMs) {
                targetRecord.latencyMs = latencyMs
                rowUpdated = true
              }
              if (firstTokenLatencyMs !== undefined && targetRecord.firstTokenLatencyMs !== firstTokenLatencyMs) {
                targetRecord.firstTokenLatencyMs = firstTokenLatencyMs
                rowUpdated = true
              }
              if (rowUpdated) {
                targetEntry.line.dirty = true
                changedFiles.add(targetEntry.fileName)
                patchedCount += 1
              }
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

  await backupDayFiles(dir, [...changedFiles], 'backfill-timing', logger)
  for (const name of changedFiles) {
    const lines = fileLines.get(name)
    if (lines === undefined) continue
    await writeDayLines(dir, name, lines)
  }

  return patchedCount
}

/** What one field-completion pass did, per completer: `cleanIds` settled
 * with every candidate session readable; `retriedIds` still had unreadable
 * candidate sessions, so the caller decides via its retry budget whether
 * to stamp or re-run them. */
export interface FieldCompletionResult {
  /** Rows that gained at least one field. */
  patched: number
  /** Completer ids whose every candidate session was readable. */
  cleanIds: readonly string[]
  /** Completer ids with at least one unreadable candidate session. */
  retriedIds: readonly string[]
  /** Candidate sessions whose log could not be read. */
  failedSessions: number
}

/**
 * Fill absent fields from session logs. A day file is rewritten only when a
 * row changed. An unreadable session does not block the others; it moves
 * the completer from `cleanIds` to `retriedIds` so the caller's retry
 * budget, not this walk, decides when the completer settles. Rows the
 * walk cannot prove stay blank; that does not block settlement.
 */
export async function completeDayFiles(
  dir: string,
  persistence: SyncPersistence,
  completers: readonly FieldCompleter[],
  logger: LoggerLike = consoleLogger,
): Promise<FieldCompletionResult> {
  const none: FieldCompletionResult = { patched: 0, cleanIds: [], retriedIds: [], failedSessions: 0 }
  if (completers.length === 0) return none
  const names = await listDayFileNames(dir, logger)
  if (names === null) return none
  const fileLines = new Map<string, DayLine[]>()
  const candidates = new Map<string, Set<string>>()
  for (const name of names) {
    const lines = await readDayLines(dir, name, logger)
    let fileHasCandidate = false
    for (const line of lines) {
      const record = line.record
      if (record === null) continue
      for (const completer of completers) {
        if (!completer.needs(record)) continue
        fileHasCandidate = true
        let sessions = candidates.get(completer.id)
        if (sessions === undefined) {
          sessions = new Set()
          candidates.set(completer.id, sessions)
        }
        sessions.add(record.sessionId)
      }
    }
    if (fileHasCandidate) fileLines.set(name, lines)
  }
  if (fileLines.size === 0) {
    return { patched: 0, cleanIds: completers.map(completer => completer.id), retriedIds: [], failedSessions: 0 }
  }
  const reader = readerOf(persistence)
  const sessions = new Set<string>()
  for (const ids of candidates.values()) for (const id of ids) sessions.add(id)
  const failed = new Set<string>()
  const changedFiles = new Set<string>()
  let patched = 0
  for (const sessionId of sessions) {
    let events: Awaited<ReturnType<typeof reader.read>>['events']
    try {
      events = (await reader.read(sessionId as SessionId)).events
    } catch (error) {
      failed.add(sessionId)
      logger.warn(`[token-usage] session ${sessionId} unreadable during field completion, skipped:`, error instanceof Error ? error.message : String(error))
      continue
    }
    const proofs = new Map<string, ReadonlyMap<string, unknown>>()
    for (const completer of completers) {
      if (!candidates.get(completer.id)?.has(sessionId)) continue
      proofs.set(completer.id, completer.prove(sessionId, events))
    }
    for (const [name, lines] of fileLines) {
      let fileChanged = false
      for (const line of lines) {
        const record = line.record
        if (record === null || record.sessionId !== sessionId) continue
        let rowChanged = false
        for (const completer of completers) {
          if (!completer.needs(record)) continue
          const proof = proofs.get(completer.id)?.get(record.requestId)
          if (proof === undefined) continue
          if (completer.fill(record, proof)) rowChanged = true
        }
        if (rowChanged) {
          line.dirty = true
          patched += 1
          fileChanged = true
        }
      }
      if (fileChanged) changedFiles.add(name)
    }
  }
  if (changedFiles.size > 0) {
    await backupDayFiles(dir, [...changedFiles], 'complete-fields', logger)
    for (const name of changedFiles) {
      const lines = fileLines.get(name)
      if (lines === undefined) continue
      await writeDayLines(dir, name, lines)
    }
  }
  const cleanIds: string[] = []
  const retriedIds: string[] = []
  for (const completer of completers) {
    const hasFailedCandidate = [...(candidates.get(completer.id) ?? [])].some(id => failed.has(id))
    ;(hasFailedCandidate ? retriedIds : cleanIds).push(completer.id)
  }
  return { patched, cleanIds, retriedIds, failedSessions: failed.size }
}

