/**
 * Per-session sync progress: the seq watermark of every session already folded
 * into the durable log. Read at startup so each session's first sync on a
 * machine only walks the suffix past the watermark; writes back atomically
 * (temp + rename) so a crash mid-write leaves either the old or the new
 * progress, never a torn watermark that would double-record the next run.
 *
 * v1 (`{"initializedAt": number}`) is recognized for backward compatibility
 * and treated as an empty progress map: the first run after the upgrade
 * performs one full sync, then persists the new shape.
 *
 * @module token-usage/sync-state
 */
/** One session's persisted sync watermark. */
export interface SessionProgress {
    /** Highest event seq from this session that has been folded into the log. */
    lastSyncedSeq: number;
}
/** The full on-disk sync progress: a per-session watermark map. */
export interface SyncProgress {
    /** Schema version; currently 2. */
    version: 2;
    /** Last successful sync completion wall time (epoch ms). Optional debug breadcrumb. */
    syncedAt?: number;
    /** Per-session watermark map. */
    sessions: Record<string, SessionProgress>;
}
/**
 * Read the sync progress. A missing, malformed, or v1-only file reads as an
 * empty v2 progress map: the first run after a missing/v1 marker performs one
 * full sync, then persists the v2 shape. v2 corruption reads as empty so a
 * crash mid-write cannot strand the user on a half-finished watermark.
 * @param dir - the data directory holding the marker.
 */
export declare function readSyncProgress(dir: string): Promise<SyncProgress>;
/**
 * Persist the sync progress atomically (temp file + rename), so a crash
 * mid-write never leaves a torn watermark that would double-record the next
 * run. Absent optional fields are omitted under `exactOptionalPropertyTypes`.
 * @param dir - the data directory holding the marker.
 * @param progress - the progress to persist.
 */
export declare function writeSyncProgress(dir: string, progress: SyncProgress): Promise<void>;
//# sourceMappingURL=sync-state.d.ts.map