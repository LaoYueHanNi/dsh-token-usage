/**
 * Stats computation of the token-usage plugin: read every day file and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window. Pure aggregation lives apart from the file walk so the web route
 * and tests share one implementation.
 *
 * @module token-usage/stats
 */
import type { UsageRecord } from './usage-record.ts';
import type { UsageSummary, UsageTotals } from './wire.ts';
/** Bounded recent window length: only the newest records cross the wire. */
export declare const RECENT_LIMIT = 20;
/** Zeroed totals; requests counts rows, the token buckets sum reported usage. */
export declare function emptyTotals(): UsageTotals;
/**
 * Fold records into the summary shape. The recent window keeps the last
 * {@link RECENT_LIMIT} records in input order (day files are chronological)
 * and then sorts them by time descending.
 * @param records - parsed records in day-file order.
 * @returns totals, day rows, model rows, and the recent window.
 */
export declare function summarizeRecords(records: readonly UsageRecord[]): Omit<UsageSummary, 'dataDir'>;
/**
 * Read every day file into records, in day-file order. Malformed lines are
 * skipped silently — unlike the sync scan's dedupe pass, the stats read runs
 * on every page refresh and must not spam the console over one bad row.
 * An absent data directory (nothing written yet) yields an empty list.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */
export declare function readAllRecords(dir: string): Promise<UsageRecord[]>;
/**
 * Build the full stats payload for one data directory.
 * @param dir - the plugin's data directory.
 * @returns the summary served to the web settings page.
 */
export declare function buildSummary(dir: string): Promise<UsageSummary>;
//# sourceMappingURL=stats.d.ts.map