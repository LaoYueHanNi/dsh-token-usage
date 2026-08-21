/**
 * Live-progress buffer: in-memory cache of per-session sync watermarks the
 * live hook fills as requests land, flushed to `state.json` either lazily
 * (when a cache entry is older than `ttlMs`) or on a wall-clock interval
 * (`intervalMs`). Without it, every dsh restart that processed requests
 * since the last startup would force `readFrom` on every session — JSONL
 * backends parse the whole artifact just to confirm an empty suffix, and 64
 * sessions × per-file scan shows up in the user-facing startup log. With it,
 * the watermark + revision the startup sync needs is already on disk by the
 * time the user closes dsh cleanly; a crash leaves the last flushed state
 * and the startup sync still catches the delta (its fallback is unchanged).
 *
 * Hot path (`markSynced`) is pure memory: one `Map.set`, one `Date.now()`,
 * one wall-clock comparison against `ttlMs` to decide whether to schedule a
 * lazy flush. No I/O, no `listSnapshots`. The O(N) `listSnapshots()` runs
 * only inside the serialized flush, capped at the configured interval.
 *
 * @module token-usage/live-progress
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSnapshot, SyncPersistence } from './sync.ts'
import { readSyncProgress, writeSyncProgress, type SyncProgress } from './sync-state.ts'

/** One cache entry: the most recent seq the live hook wrote for a session. */
export interface LiveProgressEntry {
  /** Last event seq the live hook successfully appended to the day file. */
  lastSyncedSeq: number
  /** Wall-clock time (`Date.now()`) when this entry was last touched. */
  touchedAt: number
}

/** Constructor inputs. */
export interface LiveProgressDeps {
  /** Absolute data directory holding `state.json`. */
  dir: string
  /**
   * Session listing with revisions; the only way to learn a session's current
   * revision token without scanning every event. The buffer calls it once per
   * flush, never per live hook.
   */
  persistence: Pick<SyncPersistence, 'listSnapshots'>
  /**
   * Live-progress entries older than this are eligible for a lazy flush even
   * without the timer firing. Long enough that a one-off burst doesn't
   * trigger I/O, short enough that a long-lived session still flushes within
   * a reasonable window. Default: 5 minutes.
   */
  ttlMs?: number
  /**
   * Wall-clock timer fires this often to drain whatever the live hook has
   * buffered, regardless of TTL. Default: 30 seconds.
   */
  intervalMs?: number
}

/**
 * In-memory watermark cache for the live hook, flushed to `state.json` on a
 * lazy TTL or a wall-clock timer. Single-process; the `dispose()` method is
 * the cleanup hook (cordis effect dispose) and drains the cache so a clean
 * dsh shutdown never loses a watermark.
 */
export class LiveProgressBuffer {
  private readonly dir: string
  private readonly persistence: LiveProgressDeps['persistence']
  private readonly ttlMs: number
  private readonly intervalMs: number
  /** sessionId string → most recent live-hook entry. */
  private readonly cache = new Map<string, LiveProgressEntry>()
  /** In-memory copy of `state.json`; the flush merges cache into it. */
  private progress: SyncProgress = { version: 2, sessions: {} }
  /** Read-only view used by tests to assert `loadBaseline` actually loaded. */
  getProgress(): SyncProgress {
    return this.progress
  }
  /** Serialize flushes: only one flush in flight at a time. */
  private flushing: Promise<void> | undefined
  /** Wall-clock timer that drives the periodic drain. */
  private timer: ReturnType<typeof setInterval> | undefined
  /**
   * Guards against flushing before `loadBaseline()` resolved: a cache entry
   * that lands before the on-disk progress is in memory would otherwise be
   * written over a stale (empty) baseline and clobber whatever the startup
   * sync just persisted.
   */
  private baselineLoaded = false

  constructor(deps: LiveProgressDeps) {
    this.dir = deps.dir
    this.persistence = deps.persistence
    this.ttlMs = deps.ttlMs ?? 5 * 60 * 1000
    this.intervalMs = deps.intervalMs ?? 30_000
  }

  /**
   * Load the on-disk progress so the first flush has the latest baseline.
   * Call once at startup, before any live hook fires, so the buffer merges
   * cache into the same baseline the startup sync just wrote.
   */
  async loadBaseline(): Promise<void> {
    const onDisk = await readSyncProgress(this.dir)
    // Replace the in-memory progress wholesale so the live hook's first
    // append merges into the same baseline the startup sync just wrote —
    // not into a partial map that lost some sessions on a previous run.
    this.progress = { version: 2, sessions: {} }
    for (const [id, entry] of Object.entries(onDisk.sessions)) {
      this.progress.sessions[id] = { ...entry }
    }
    this.baselineLoaded = true
  }

  /** Start the wall-clock drain. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.flushDirty()
    }, this.intervalMs)
    // The interval must not keep the process alive on its own; the live hook
    // (and the cordis effect's dispose) own the lifecycle.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref()
    }
  }

  /**
   * Record one live-hook success for `sessionId`. Pure memory; no I/O. The
   * entry's `touchedAt` resets so a continuously-active session never trips
   * the TTL while it's emitting events.
   */
  markSynced(sessionId: SessionId, lastSyncedSeq: number): void {
    this.cache.set(String(sessionId), { lastSyncedSeq, touchedAt: Date.now() })
  }

  /**
   * Lazy flush: drain cache entries whose `touchedAt` is older than `ttlMs`.
   * Cheap to call from the live-hook hot path — it only walks the cache and
   * bails when nothing is due, so an idle session never re-enters the I/O
   * path. The flush itself is serialized via `flushing`. Only the due
   * entries land in `state.json`; sessions not in `entries` keep their
   * last-known revision and are reconciled by the next timer tick.
   */
  flushExpired(): Promise<void> {
    const now = Date.now()
    const due: Array<[string, LiveProgressEntry]> = []
    for (const entry of this.cache.entries()) {
      if (now - entry[1].touchedAt >= this.ttlMs) due.push(entry)
    }
    if (due.length === 0) return Promise.resolve()
    return this.flushEntries(due, false)
  }

  /**
   * Drain every dirty cache entry and refresh the in-memory `progress`
   * revision for every session the persistence layer still knows about.
   * Timer-driven — fires whether or not the cache has entries, because
   * baseline sessions need their revision refreshed too (otherwise the next
   * startup walks the entire session file for sessions the live hook never
   * touched this run). Same serialization contract as {@link flushExpired}.
   */
  flushDirty(): Promise<void> {
    return this.flushEntries([...this.cache.entries()], true)
  }

  /**
   * Flush every remaining entry and stop the timer. The cordis dispose hook
   * calls this so a clean dsh shutdown leaves `state.json` carrying every
   * watermark the live hook accumulated this run. A flush failure on dispose
   * is logged but never thrown — the dsh-shutdown window can race a directory
   * migration's cleanup, and a `state.json` write that targets an already-
   * removed directory is the migration's success path, not a problem we
   * should surface as an error.
   */
  async dispose(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    try {
      await this.flushDirty()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[token-usage] live progress flush failed:', error)
      }
    }
  }

  /**
   * Internal flush implementation. Pulls the live revisions from the
   * persistence layer once, merges each cache entry's seq with its session's
   * current revision, and writes the merged `state.json` atomically. A
   * second call while a flush is in flight awaits the in-flight one — no
   * concurrent `listSnapshots` or racing renames.
   *
   * An empty `entries` array is allowed: {@link flushDirty} uses it to
   * refresh baseline revisions even when the live hook buffered nothing
   * this round.
   * @param entries - the cache entries to flush, in arbitrary order.
   * @param refreshAll - true for the timer-driven drain (refreshes every
   * session's `lastSeenRevision`); false for the lazy drain (only flushes
   * the supplied entries). The lazy path stays cheap when the live hook is
   * idle — no need to refresh a session's revision if no entry will be
   * written for it.
   */
  private flushEntries(
    entries: ReadonlyArray<readonly [string, LiveProgressEntry]>,
    refreshAll: boolean,
  ): Promise<void> {
    if (this.flushing !== undefined) return this.flushing
    const task = this.runFlush(entries, refreshAll)
    this.flushing = task.finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  private async runFlush(
    entries: ReadonlyArray<readonly [string, LiveProgressEntry]>,
    refreshAll: boolean,
  ): Promise<void> {
    // A flush that races the baseline load would write the cache entries
    // over an empty `progress` map, silently dropping every watermark the
    // startup sync just persisted. Wait for the baseline first; the
    // baseline's `readSyncProgress` already awaits any pending disk read.
    if (!this.baselineLoaded) await this.loadBaseline()
    const snapshots = await this.persistence.listSnapshots()
    const revisions = new Map<string, string>()
    for (const snapshot of snapshots as readonly SessionSnapshot[]) {
      revisions.set(String(snapshot.header.id), snapshot.revision)
    }
    if (refreshAll) {
      // Refresh every session the persistence layer still knows about: the
      // live hook only touches a subset of sessions per run, but every
      // baseline entry needs its revision refreshed too — otherwise a
      // session that was idle this run would still carry last-run's
      // revision in state.json, and the next startup would fail the
      // short-circuit and walk the entire session file for nothing.
      for (const [sessionId, revision] of revisions) {
        const cached = this.cache.get(sessionId)
        const cachedSeq = cached?.lastSyncedSeq
        const existingSeq = this.progress.sessions[sessionId]?.lastSyncedSeq ?? -1
        this.progress.sessions[sessionId] = {
          lastSyncedSeq: cachedSeq ?? existingSeq,
          lastSeenRevision: revision,
        }
      }
    } else {
      // Lazy path: only touch the entries the caller is flushing. Sessions
      // not in `entries` keep whatever revision was last on disk; the next
      // timer tick (or the next startup sync) will reconcile them.
      for (const [sessionId, entry] of entries) {
        const revision = revisions.get(sessionId)
        if (revision === undefined) continue
        this.progress.sessions[sessionId] = {
          lastSyncedSeq: entry.lastSyncedSeq,
          lastSeenRevision: revision,
        }
      }
    }
    try {
      await writeSyncProgress(this.dir, this.progress)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The data directory vanished (a migration that just removed it).
        // Drop the cache so a future flush on a new directory starts clean.
        for (const [sessionId] of entries) this.cache.delete(sessionId)
      }
      throw error
    }
    for (const [sessionId] of entries) this.cache.delete(sessionId)
  }
}