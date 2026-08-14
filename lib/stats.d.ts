/**
 * Stats computation of the token-usage plugin: read the day files and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window. Frozen (pre-today) day files are served from the on-disk rollup
 * (see rollup.ts); only today's file is read on every call. Pure aggregation
 * lives apart from the file walk so the web route and tests share one
 * implementation.
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
 * Merge two summaries into one: totals and model rows add up, day rows fold
 * by day key (a same-day record set landing in a later file must join the
 * earlier bucket, never replace it), crossed rows fold by their (day, model)
 * key, and the recent window keeps the newest {@link RECENT_LIMIT} records
 * across both sides. Order-independent and associative: merging partial
 * summaries equals summarizing the concatenated records.
 * @param left - one partial summary.
 * @param right - the other partial summary.
 * @returns the folded summary.
 */
export declare function mergeSummaries(left: Omit<UsageSummary, 'dataDir'>, right: Omit<UsageSummary, 'dataDir'>): Omit<UsageSummary, 'dataDir'>;
/**
 * Re-aggregate a summary under an optional inclusive day range and model
 * filter, drawing every dimension from the crossed (day × model) rows so no
 * file is reread. The recent window filters on its record timestamps
 * ([from 00:00, to 23:59:59.999] local). No filters returns the input as-is.
 * @param summary - the unfiltered summary.
 * @param from - first day key (`YYYY-MM-DD`), inclusive.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id.
 * @returns the filtered summary.
 */
export declare function filterSummary(summary: UsageSummary, from?: string, to?: string, model?: string): UsageSummary;
/**
 * Read every day file into records, in day-file order. An absent data
 * directory (nothing written yet) yields an empty list.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */
export declare function readAllRecords(dir: string): Promise<UsageRecord[]>;
/**
 * Build the full stats payload for one data directory: the rollup over every
 * frozen day file (advanced lazily and rewritten atomically when unabsorbed
 * frozen files appear) merged with a fresh read of today's file. Day files
 * named at or after today but already absorbed by a later rollup `upto` are
 * skipped, so a clock stepping back cannot count an absorbed file twice.
 * A failed rollup write logs and does not block the response — the next read
 * retries the absorption.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @returns the summary served to the web settings page.
 */
export declare function buildSummary(dir: string, now?: () => Date): Promise<UsageSummary>;
//# sourceMappingURL=stats.d.ts.map