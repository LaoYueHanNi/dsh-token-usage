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
import { readSyncProgress, writeSyncProgress } from "./sync-state.js";
/**
 * In-memory watermark cache for the live hook, flushed to `state.json` on a
 * lazy TTL or a wall-clock timer. Single-process; the `dispose()` method is
 * the cleanup hook (cordis effect dispose) and drains the cache so a clean
 * dsh shutdown never loses a watermark.
 */
export class LiveProgressBuffer {
    dir;
    persistence;
    ttlMs;
    intervalMs;
    /** sessionId string → most recent live-hook entry. */
    cache = new Map();
    /** In-memory copy of `state.json`; the flush merges cache into it. */
    progress = { version: 2, sessions: {} };
    /** Read-only view used by tests to assert `loadBaseline` actually loaded. */
    getProgress() {
        return this.progress;
    }
    /** Serialize flushes: only one flush in flight at a time. */
    flushing;
    /** Wall-clock timer that drives the periodic drain. */
    timer;
    /**
     * Guards against flushing before `loadBaseline()` resolved: a cache entry
     * that lands before the on-disk progress is in memory would otherwise be
     * written over a stale (empty) baseline and clobber whatever the startup
     * sync just persisted.
     */
    baselineLoaded = false;
    constructor(deps) {
        this.dir = deps.dir;
        this.persistence = deps.persistence;
        this.ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
        this.intervalMs = deps.intervalMs ?? 30_000;
    }
    /**
     * Load the on-disk progress so the first flush has the latest baseline.
     * Call once at startup, before any live hook fires, so the buffer merges
     * cache into the same baseline the startup sync just wrote.
     */
    async loadBaseline() {
        const onDisk = await readSyncProgress(this.dir);
        // Replace the in-memory progress wholesale so the live hook's first
        // append merges into the same baseline the startup sync just wrote —
        // not into a partial map that lost some sessions on a previous run.
        this.progress = { version: 2, sessions: {} };
        for (const [id, entry] of Object.entries(onDisk.sessions)) {
            this.progress.sessions[id] = { ...entry };
        }
        this.baselineLoaded = true;
    }
    /** Start the wall-clock drain. Idempotent: a second call is a no-op. */
    start() {
        if (this.timer !== undefined)
            return;
        this.timer = setInterval(() => {
            void this.flushDirty();
        }, this.intervalMs);
        // The interval must not keep the process alive on its own; the live hook
        // (and the cordis effect's dispose) own the lifecycle.
        if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
            this.timer.unref();
        }
    }
    /**
     * Record one live-hook success for `sessionId`. Pure memory; no I/O. The
     * entry's `touchedAt` resets so a continuously-active session never trips
     * the TTL while it's emitting events.
     */
    markSynced(sessionId, lastSyncedSeq) {
        this.cache.set(String(sessionId), { lastSyncedSeq, touchedAt: Date.now() });
    }
    /**
     * Lazy flush: drain cache entries whose `touchedAt` is older than `ttlMs`.
     * Cheap to call from the live-hook hot path — it only walks the cache and
     * bails when nothing is due, so an idle session never re-enters the I/O
     * path. The flush itself is serialized via `flushing`. Only the due
     * entries land in `state.json`; sessions not in `entries` keep their
     * last-known revision and are reconciled by the next timer tick.
     */
    flushExpired() {
        const now = Date.now();
        const due = [];
        for (const entry of this.cache.entries()) {
            if (now - entry[1].touchedAt >= this.ttlMs)
                due.push(entry);
        }
        if (due.length === 0)
            return Promise.resolve();
        return this.flushEntries(due, false);
    }
    /**
     * Drain every dirty cache entry and refresh the in-memory `progress`
     * revision for every session the persistence layer still knows about.
     * Timer-driven — fires whether or not the cache has entries, because
     * baseline sessions need their revision refreshed too (otherwise the next
     * startup walks the entire session file for sessions the live hook never
     * touched this run). Same serialization contract as {@link flushExpired}.
     */
    flushDirty() {
        return this.flushEntries([...this.cache.entries()], true);
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
    async dispose() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        try {
            await this.flushDirty();
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[token-usage] live progress flush failed:', error);
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
    flushEntries(entries, refreshAll) {
        if (this.flushing !== undefined)
            return this.flushing;
        const task = this.runFlush(entries, refreshAll);
        this.flushing = task.finally(() => {
            this.flushing = undefined;
        });
        return this.flushing;
    }
    async runFlush(entries, refreshAll) {
        // A flush that races the baseline load would write the cache entries
        // over an empty `progress` map, silently dropping every watermark the
        // startup sync just persisted. Wait for the baseline first; the
        // baseline's `readSyncProgress` already awaits any pending disk read.
        if (!this.baselineLoaded)
            await this.loadBaseline();
        const snapshots = await this.persistence.listSnapshots();
        const revisions = new Map();
        for (const snapshot of snapshots) {
            revisions.set(String(snapshot.header.id), snapshot.revision);
        }
        if (refreshAll) {
            // Refresh every session the persistence layer still knows about: the
            // live hook only touches a subset of sessions per run, but every
            // baseline entry needs its revision refreshed too — otherwise a
            // session that was idle this run would still carry last-run's
            // revision in state.json, and the next startup would fail the
            // short-circuit and walk the entire session file for nothing.
            for (const [sessionId, revision] of revisions) {
                const cached = this.cache.get(sessionId);
                const cachedSeq = cached?.lastSyncedSeq;
                const existingSeq = this.progress.sessions[sessionId]?.lastSyncedSeq ?? -1;
                this.progress.sessions[sessionId] = {
                    lastSyncedSeq: cachedSeq ?? existingSeq,
                    lastSeenRevision: revision,
                };
            }
        }
        else {
            // Lazy path: only touch the entries the caller is flushing. Sessions
            // not in `entries` keep whatever revision was last on disk; the next
            // timer tick (or the next startup sync) will reconcile them.
            for (const [sessionId, entry] of entries) {
                const revision = revisions.get(sessionId);
                if (revision === undefined)
                    continue;
                this.progress.sessions[sessionId] = {
                    lastSyncedSeq: entry.lastSyncedSeq,
                    lastSeenRevision: revision,
                };
            }
        }
        try {
            await writeSyncProgress(this.dir, this.progress);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                // The data directory vanished (a migration that just removed it).
                // Drop the cache so a future flush on a new directory starts clean.
                for (const [sessionId] of entries)
                    this.cache.delete(sessionId);
            }
            throw error;
        }
        for (const [sessionId] of entries)
            this.cache.delete(sessionId);
    }
}
//# sourceMappingURL=live-progress.js.map