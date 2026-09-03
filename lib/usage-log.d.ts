/**
 * Durable JSONL store of the token-usage plugin: per-local-day files, a
 * serialized append queue, and the process-wide request-id dedupe set that
 * both the live hook and the manual sync share.
 *
 * @module token-usage/usage-log
 */
import { type LoggerLike } from './log.ts';
import { type UsageRecord } from './usage-record.ts';
declare const DAY_FILE: RegExp;
/** Test for this store's per-day file names; the migration shares the naming contract. */
export { DAY_FILE };
/** Day-file name for a local-time date, e.g. `usage-2026-01-15.jsonl`. */
export declare function dayFileName(date: Date): string;
/**
 * Append-only per-day JSONL log with request-id dedupe.
 *
 * Ordering: every append runs on one promise chain, so concurrent callers
 * land in call order. Dedupe: a request id is claimed synchronously before
 * its append is queued; a failed append releases the claim, so the row can
 * be retried later.
 */
export declare class UsageLog {
    private readonly dir;
    private readonly now;
    private readonly logger;
    private readonly seen;
    private queue;
    private ready;
    /**
   * @param dir - absolute data directory (created lazily on first write).
   * @param now - clock source for day-file selection (test seam).
   * @param logger - diagnostic sink; defaults to console.
   */
    constructor(dir: string, now?: () => Date, logger?: LoggerLike);
    /** Whether a request id is already known to this log. */
    has(requestId: string): boolean;
    /**
     * Settle every queued append. The chain never rejects (each task absorbs
     * its own failure), so this is the quiescence point a data-directory
     * migration waits on before reading the files.
     * @returns settlement after the last queued append.
     */
    flush(): Promise<void>;
    /**
     * Rebuild the dedupe set from every existing day file. Malformed lines are
     * skipped with a console diagnostic; unreadable files are skipped the same
     * way, so a corrupt log never blocks the sync.
     */
    scan(): Promise<void>;
    /**
     * Persist one record unless its request id was already written.
     * @returns true when the row was appended, false when deduped.
     */
    record(record: UsageRecord): Promise<boolean>;
    /** The directory is created once and remembered; an external deletion
     * forces a rebuild on the next append (see {@link appendOnce}). */
    private ensureDir;
    /**
     * Append one row, self-healing once when the directory vanished after the
     * cached creation: the data location may be removed underneath a running
     * process (a migration that stayed behind, a user cleanup), and failing
     * every append forever after would silently drop the whole session's rows.
     */
    private appendOnce;
}
//# sourceMappingURL=usage-log.d.ts.map