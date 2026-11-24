/**
 * Session-metadata index of the token-usage plugin: `sessions.json` in the
 * data directory, mapping sessionId → the identity fields the settings
 * page's session table renders — the log-backed latest-wins `session/title`
 * text (folded by this plugin, not by the host's title package), the
 * immutable `SessionHeader` facts (cwd, subagent origin, parent session),
 * the subagent identity (semantic name, delegation label, lifecycle mode)
 * and the root session's team-mode selection.
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
import { isSubagentMode, type SubagentMode } from './wire.ts'

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
  /** The parent session of a subagent child. For a local child it is the
   * header's fact; for an external child (which has no session, so no
   * header) it is the session whose `subagent/catalog` lists it. An
   * external entry deliberately carries no `origin`, which is what keeps it
   * out of the lineage index and every subtree scope. */
  parentSession?: string
  /** Semantic name (`researcher`, `agent-1`, …) the PARENT's
   * `subagent/catalog` v3 gave this child; omitted for children created
   * before named subagents existed (catalog v0–v2 carry no name). */
  subagentName?: string
  /** Delegation label — the short description the child was created with.
   * The parent's catalog entry is the source; the child's own
   * `subagent/descriptor` fills it in when the catalog states none. */
  subagentLabel?: string
  /** Lifecycle mode from the catalog / descriptor; omitted when neither
   * stated a mode this build recognizes. */
  subagentMode?: SubagentMode
  /** The session's own `team/mode` selection (written only by a runtime
   * root; children inherit it by walking up to their root). Omitted when
   * the log never recorded one. */
  teamMode?: boolean
}

/** Every mergeable field, in file order. */
const META_TEXT_KEYS = ['title', 'cwd', 'parentSession', 'subagentName', 'subagentLabel'] as const
const META_KEYS = [...META_TEXT_KEYS, 'origin', 'subagentMode', 'teamMode'] as const

/** The on-disk shape: one entry per known session id. */
export type SessionMetaIndex = Record<string, SessionMeta>

function isMeta(value: unknown): SessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const meta: SessionMeta = {}
  for (const key of META_TEXT_KEYS) {
    const field = raw[key]
    if (typeof field === 'string' && field !== '') meta[key] = field
  }
  if (raw.origin === 'subagent') meta.origin = raw.origin
  if (isSubagentMode(raw.subagentMode)) meta.subagentMode = raw.subagentMode
  if (typeof raw.teamMode === 'boolean') meta.teamMode = raw.teamMode
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

/** One row of a batched upsert. */
export interface SessionMetaPatch {
  /** The session the patch applies to. */
  id: string
  /** Fields to merge in; every present field is latest-wins per key. */
  patch: SessionMeta
  /**
   * Fill-only merge: a field the index already holds is kept. For facts a
   * weaker source states — a child's own `subagent/descriptor` label — that
   * a stronger source, the parent's `subagent/catalog`, may already have
   * supplied in an earlier batch or an earlier run. Without this the merge
   * would depend on which session the sync walk happened to read first.
   */
  fillOnly?: boolean
}

/** Merge `patch` onto `current` (latest-wins per key, or fill-only). */
function mergeMeta(current: SessionMeta | undefined, patch: SessionMeta, fillOnly: boolean): SessionMeta {
  const merged: SessionMeta = { ...current }
  for (const key of META_KEYS) {
    const value = patch[key]
    if (value === undefined) continue
    if (fillOnly && merged[key] !== undefined) continue
    // Every key of META_KEYS exists on SessionMeta with patch's own type.
    (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/** Whether two entries agree on every field (an absent one reads as equal
 * to an absent one). */
function sameMeta(left: SessionMeta | undefined, right: SessionMeta | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return META_KEYS.every(key => left[key] === right[key])
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
   * @param id - the session the patch applies to.
   * @param patch - the fields to merge.
   * @param options - `fillOnly` keeps every field the index already holds
   *   (see {@link SessionMetaPatch.fillOnly}).
   */
  upsert(id: string, patch: SessionMeta, options?: { fillOnly?: boolean }): Promise<void> {
    if (id === '') return Promise.resolve()
    return this.upsertMany([{ id, patch, ...(options?.fillOnly === true ? { fillOnly: true } : {}) }])
  }

  /**
   * Merge many sessions' fields in ONE read-merge-write. A parent session
   * with dozens of subagents folds one catalog entry per child, so the
   * history sync lands them together instead of rewriting (and re-serializing
   * the whole index) once per child. Entries apply in order; a repeated id
   * merges onto what the earlier entry in this batch already produced.
   * The batch is a no-op when nothing changed.
   */
  upsertMany(entries: readonly SessionMetaPatch[]): Promise<void> {
    const task = this.queue.then(async () => {
      // Shallow-copy: `read` may hand back the cache's own object, and a
      // failed write below must not leave the cache mutated past the disk.
      const index = { ...await this.read() }
      const batch = new Map<string, SessionMeta | undefined>()
      for (const { id, patch, fillOnly } of entries) {
        if (id === '') continue
        const merged = mergeMeta(batch.has(id) ? batch.get(id) : index[id], patch, fillOnly === true)
        batch.set(id, Object.keys(merged).length === 0 ? undefined : merged)
      }
      let changed = false
      for (const [id, merged] of batch) {
        if (sameMeta(index[id], merged)) continue
        if (merged === undefined) continue
        index[id] = merged
        changed = true
      }
      if (!changed) return
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
