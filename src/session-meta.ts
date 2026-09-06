/**
 * Session-metadata index of the token-usage plugin: `sessions.json` in the
 * data directory, mapping sessionId → the identity fields the settings
 * page's session table renders — the log-backed latest-wins `session/title`
 * text (folded by this plugin, not by the host's title package) and the
 * immutable `SessionHeader` facts (cwd, subagent origin, parent session).
 *
 * The index is a derived cache: every field is recoverable from the session
 * logs, so a missing or malformed file reads as empty and the next manual
 * or automatic full sync rebuilds it — no incremental repair. Writes go
 * through one serialized queue (concurrent upserts cannot trample each
 * other) and land atomically (temp file + rename), and reads carry an
 * mtime stamp cache so the hot stats route never reparses an unchanged
 * file. The file lives inside the data directory and moves with it.
 *
 * @module token-usage/session-meta
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleLogger, type LoggerLike } from './log.ts'

const SESSIONS_FILE = 'sessions.json'
const TMP_FILE = 'sessions.json.tmp'

/** One session's identity fields; absent fields are omitted, never null. */
export interface SessionMeta {
  /** Latest `session/title` text (host-normalized); omitted when the log
   * never carried a title event (some subagents, old data). */
  title?: string
  /** Session header's working directory; omitted when the header had none. */
  cwd?: string
  /** Coarse subagent classification from the header; omitted for
   * top-level sessions (the only value today is `'subagent'`). */
  origin?: 'subagent'
  /** The parent session of a subagent child, from the header. */
  parentSession?: string
}

/** The on-disk shape: one entry per known session id. */
export type SessionMetaIndex = Record<string, SessionMeta>

function isMeta(value: unknown): SessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const title = raw.title
  const cwd = raw.cwd
  const parent = raw.parentSession
  const origin = raw.origin
  const meta: SessionMeta = {}
  if (typeof title === 'string' && title !== '') meta.title = title
  if (typeof cwd === 'string' && cwd !== '') meta.cwd = cwd
  if (typeof parent === 'string' && parent !== '') meta.parentSession = parent
  if (origin === 'subagent') meta.origin = origin
  // A row with no usable field is dropped: it carries nothing the table
  // or the fold reads, and skipping it keeps a hand-edited file honest.
  return Object.keys(meta).length === 0 ? null : meta
}

function isIndex(value: unknown): value is SessionMetaIndex {
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value as Record<string, unknown>).every(entry => entry === null || typeof entry === 'object')
}

/** Coerce an unknown document into the index, dropping unusable rows. */
function coerceIndex(value: unknown): SessionMetaIndex {
  if (!isIndex(value)) return {}
  const out: SessionMetaIndex = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (id === '') continue
    const meta = isMeta(entry)
    if (meta !== null) out[id] = meta
  }
  return out
}

/** Cached parse keyed by the on-disk stamp that produced it. */
interface StampCache {
  index: SessionMetaIndex
  size: number
  mtimeMs: number
}

/**
 * Read/write access to one data directory's session-metadata index.
 * Reads hit an mtime-stamp cache; writes serialize on one promise chain
 * and persist atomically. Every failure degrades to "empty index" —
 * the next full sync rebuilds the file from the logs.
 */
export class SessionMetaStore {
  private cache: StampCache | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly logger: LoggerLike = consoleLogger,
  ) {}

  /** Drop the cached parse (data-directory relocation, test seams). */
  invalidate(): void {
    this.cache = undefined
  }

  /**
   * Read the index. A missing, malformed, or partially unusable file reads
   * as the entries that survived coercion (an empty object when none do) —
   * the index is rebuildable, so corruption never blocks a stats read.
   */
  async read(): Promise<SessionMetaIndex> {
    const path = join(this.dir, SESSIONS_FILE)
    let stamp: { size: number; mtimeMs: number }
    try {
      const info = await stat(path)
      stamp = { size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      this.cache = undefined
      return {}
    }
    if (this.cache !== undefined && this.cache.size === stamp.size && this.cache.mtimeMs === stamp.mtimeMs) {
      return this.cache.index
    }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      this.logger.error('[token-usage] cannot read sessions.json:', error)
      this.cache = undefined
      return {}
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      this.logger.error('[token-usage] sessions.json is not valid JSON; treating as absent')
      this.cache = undefined
      return {}
    }
    const index = coerceIndex(value)
    this.cache = { index, size: stamp.size, mtimeMs: stamp.mtimeMs }
    return index
  }

  /**
   * Merge one session's fields into the index. Every field is latest-wins
   * per key: a title upsert overwrites (the caller folds the title events),
   * and header facts are idempotent (the header is immutable). A patch
   * whose values all match the current index is a no-op, so repeated syncs
   * and live ticks do not rewrite the file. Serialized: a second upsert
   * waits for the first's read-merge-write to settle.
   */
  upsert(id: string, patch: SessionMeta): Promise<void> {
    if (id === '') return Promise.resolve()
    const task = this.queue.then(async () => {
      // Shallow-copy: `read` may hand back the cache's own object, and a
      // failed write below must not leave the cache mutated past the disk.
      const index = { ...await this.read() }
      const current = index[id]
      const merged: SessionMeta = { ...current }
      if (patch.title !== undefined) merged.title = patch.title
      if (patch.cwd !== undefined) merged.cwd = patch.cwd
      if (patch.origin !== undefined) merged.origin = patch.origin
      if (patch.parentSession !== undefined) merged.parentSession = patch.parentSession
      if (current !== undefined
        && current.title === merged.title
        && current.cwd === merged.cwd
        && current.origin === merged.origin
        && current.parentSession === merged.parentSession) return
      index[id] = merged
      await this.write(index)
      this.cache = undefined
    })
    // A failed write must not poison the chain for later upserts.
    this.queue = task.catch(() => {})
    return task
  }

  /** Settle every queued write (the migration's quiescence point). */
  flush(): Promise<void> {
    return this.queue
  }

  /** Persist atomically: a crash mid-write leaves the old or the new file. */
  private async write(index: SessionMetaIndex): Promise<void> {
    const target = join(this.dir, SESSIONS_FILE)
    const tmp = join(this.dir, TMP_FILE)
    await writeFile(tmp, JSON.stringify(index), 'utf8')
    await rename(tmp, target)
  }
}
