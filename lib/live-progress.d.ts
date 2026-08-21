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
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SyncPersistence } from './sync.ts';
import { type SyncProgress } from './sync-state.ts';
/** One cache entry: the most recent seq the live hook wrote for a session. */
export interface LiveProgressEntry {
    /** Last event seq the live hook successfully appended to the day file. */
    lastSyncedSeq: number;
    /** Wall-clock time (`Date.now()`) when this entry was last touched. */
    touchedAt: number;
}
/** Constructor inputs. */
export interface LiveProgressDeps {
    /** Absolute data directory holding `state.json`. */
    dir: string;
    /**
     * Session listing with revisions; the only way to learn a session's current
     * revision token without scanning every event. The buffer calls it once per
     * flush, never per live hook.
     */
    persistence: Pick<SyncPersistence, 'listSnapshots'>;
    /**
     * Live-progress entries older than this are eligible for a lazy flush even
     * without the timer firing. Long enough that a one-off burst doesn't
     * trigger I/O, short enough that a long-lived session still flushes within
     * a reasonable window. Default: 5 minutes.
     */
    ttlMs?: number;
    /**
     * Wall-clock timer fires this often to drain whatever the live hook has
     * buffered, regardless of TTL. Default: 30 seconds.
     */
    intervalMs?: number;
}
/**
 * In-memory watermark cache for the live hook, flushed to `state.json` on a
 * lazy TTL or a wall-clock timer. Single-process; the `dispose()` method is
 * the cleanup hook (cordis effect dispose) and drains the cache so a clean
 * dsh shutdown never loses a watermark.
 */
export declare class LiveProgressBuffer {
    private readonly dir;
    private readonly persistence;
    private readonly ttlMs;
    private readonly intervalMs;
    /** sessionId string → most recent live-hook entry. */
    private readonly cache;
    /** In-memory copy of `state.json`; the flush merges cache into it. */
    private progress;
    /** Read-only view used by tests to assert `loadBaseline` actually loaded. */
    getProgress(): SyncProgress;
    /** Serialize flushes: only one flush in flight at a time. */
    private flushing;
    /** Wall-clock timer that drives the periodic drain. */
    private timer;
    /**
     * Guards against flushing before `loadBaseline()` resolved: a cache entry
     * that lands before the on-disk progress is in memory would otherwise be
     * written over a stale (empty) baseline and clobber whatever the startup
     * sync just persisted.
     */
    private baselineLoaded;
    constructor(deps: LiveProgressDeps);
    /**
     * Load the on-disk progress so the first flush has the latest baseline.
     * Call once at startup, before any live hook fires, so the buffer merges
     * cache into the same baseline the startup sync just wrote.
     */
    loadBaseline(): Promise<void>;
    /** Start the wall-clock drain. Idempotent: a second call is a no-op. */
    start(): void;
    /**
     * Record one live-hook success for `sessionId`. Pure memory; no I/O. The
     * entry's `touchedAt` resets so a continuously-active session never trips
     * the TTL while it's emitting events.
     */
    markSynced(sessionId: SessionId, lastSyncedSeq: number): void;
    /**
     * Lazy flush: drain cache entries whose `touchedAt` is older than `ttlMs`.
     * Cheap to call from the live-hook hot path — it only walks the cache and
     * bails when nothing is due, so an idle session never re-enters the I/O
     * path. The flush itself is serialized via `flushing`. Only the due
     * entries land in `state.json`; sessions not in `entries` keep their
     * last-known revision and are reconciled by the next timer tick.
     */
    flushExpired(): Promise<void>;
    /**
     * Drain every dirty cache entry and refresh the in-memory `progress`
     * revision for every session the persistence layer still knows about.
     * Timer-driven — fires whether or not the cache has entries, because
     * baseline sessions need their revision refreshed too (otherwise the next
     * startup walks the entire session file for sessions the live hook never
     * touched this run). Same serialization contract as {@link flushExpired}.
     */
    flushDirty(): Promise<void>;
    /**
     * Flush every remaining entry and stop the timer. The cordis dispose hook
     * calls this so a clean dsh shutdown leaves `state.json` carrying every
     * watermark the live hook accumulated this run. A flush failure on dispose
     * is logged but never thrown — the dsh-shutdown window can race a directory
     * migration's cleanup, and a `state.json` write that targets an already-
     * removed directory is the migration's success path, not a problem we
     * should surface as an error.
     */
    dispose(): Promise<void>;
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
    private flushEntries;
    private runFlush;
}
//# sourceMappingURL=live-progress.d.ts.map