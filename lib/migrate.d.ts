/**
 * Data-directory migration of the token-usage plugin: copies every file from
 * one data directory into another, physically and verbatim — the per-day
 * JSONL shards, the pricing files, the sync marker, and the stats rollup all
 * keep their exact names and contents; no row is re-bucketed or rewritten.
 *
 * Two-phase commit, in the shape of a database switch: every file copies
 * first (a failure aborts with the source untouched); the caller then flips
 * its running configuration to the new directory; only after that switch
 * succeeds does the caller run the cleanup, which removes the source files
 * that verifiably landed (same size) and the emptied directory. At every
 * intermediate point the data exists in both places or only in the source —
 * never only in the target.
 *
 * The caller guarantees a quiesced source (no active sessions, log flushed)
 * before starting, so a file copied once cannot change underneath.
 *
 * @module token-usage/migrate
 */
import { type LoggerLike } from './log.ts';
/** Progress report of one migration phase. */
export interface MigrationProgress {
    /** Files finished so far, across copy and cleanup phases. */
    done: number;
    /** Total files this migration will touch. */
    total: number;
    /** Human-readable phase label ('copying' | 'cleaning'). */
    phase: 'copying' | 'cleaning';
}
/** What one migration did, for the startup line and the tests. */
export interface MigrationResult {
    /** Files copied into the target directory. */
    copied: number;
    /** Files removed from the source after the switch. */
    cleaned: number;
}
/**
 * Phase one: copy every owned file into the target, verbatim. A target file
 * with the same name is NOT overwritten — the caller switched writes to the
 * target first, so a same-named file there is either newer live data or a
 * user placement, and either way it wins. Any copy failure aborts with the
 * source directory fully intact (the half-copied target is left behind; it
 * is outside every configured directory until the switch names it).
 * @param oldDir - the quiesced source directory.
 * @param newDir - the target directory (created when missing).
 * @param onProgress - per-file progress callback.
 * @returns names of the files that were copied.
 */
export declare function copyData(oldDir: string, newDir: string, onProgress?: (progress: MigrationProgress) => void): Promise<string[]>;
/**
 * Phase three (after the caller's configuration switch): remove the source
 * files that verifiably landed — same name present in the target with the
 * same size — then the emptied directory. A source file whose copy cannot be
 * proven stays; unknown files keep the directory in place.
 * @param oldDir - the previous data directory.
 * @param newDir - the directory now in force.
 * @param onProgress - per-file progress callback.
 * @returns what the cleanup did.
 */
export declare function cleanSource(oldDir: string, newDir: string, onProgress?: (progress: MigrationProgress) => void, logger?: LoggerLike): Promise<MigrationResult>;
//# sourceMappingURL=migrate.d.ts.map