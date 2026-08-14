/**
 * Stats computation of the token-usage plugin: read the day files and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window — keeping one row per (day, model, rate identity) so every record
 * is billed at the rate its own timestamp resolved through (see
 * pricing.resolveRate). Frozen (pre-today) day files are served from the
 * on-disk rollup (see rollup.ts); only today's file is read on every call.
 * Pure aggregation lives apart from the file walk so the web route and tests
 * share one implementation.
 *
 * @module token-usage/stats
 */
import type { UsageRecord } from './usage-record.ts';
import type { PricingTable, RateKey, TokenSummary, UsageSummary, UsageTotals } from './wire.ts';
/** Bounded recent window length: only the newest records cross the wire. */
export declare const RECENT_LIMIT = 20;
/**
 * Resolves the rate identity one record was billed at. The route builds this
 * from the pricing table (pricing.resolveRate over the record's model, time,
 * and input-side tokens); the neutral default leaves every record unpriced.
 */
export type RateResolver = (record: UsageRecord) => RateKey;
/** Zeroed totals; requests counts rows, the token buckets sum reported usage. */
export declare function emptyTotals(): UsageTotals;
/**
 * Fold records into the token summary shape, one rate row per (day, model,
 * rate identity) the resolver assigns. The recent window keeps the last
 * {@link RECENT_LIMIT} records in input order (day files are chronological)
 * and then sorts them by time descending.
 * @param records - parsed records in day-file order.
 * @param resolve - the rate resolver; defaults to leaving every record unpriced.
 * @returns totals, day rows, model rows, rate rows, and the recent window.
 */
export declare function summarizeRecords(records: readonly UsageRecord[], resolve?: RateResolver): TokenSummary;
/**
 * Merge two summaries into one: totals and model rows add up, day rows fold
 * by day key (a same-day record set landing in a later file must join the
 * earlier bucket, never replace it), rate rows fold by their (day, model,
 * rate) key, and the recent window keeps the newest {@link RECENT_LIMIT}
 * records across both sides. Order-independent and associative: merging
 * partial summaries equals summarizing the concatenated records.
 * @param left - one partial summary.
 * @param right - the other partial summary.
 * @returns the folded summary.
 */
export declare function mergeSummaries(left: TokenSummary, right: TokenSummary): TokenSummary;
/**
 * Re-aggregate a summary under an optional inclusive day range and model
 * filter, drawing every dimension from the rate rows so no file is reread.
 * The recent window filters on its record timestamps
 * ([from 00:00, to 23:59:59.999] local). No filters returns the input as-is.
 * @param summary - the unfiltered summary.
 * @param from - first day key (`YYYY-MM-DD`), inclusive.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id.
 * @returns the filtered summary.
 */
export declare function filterSummary(summary: TokenSummary & {
    dataDir: string;
}, from?: string, to?: string, model?: string): TokenSummary & {
    dataDir: string;
};
/**
 * Attach the cost layer to a token-only summary: each rate row is priced at
 * the prices its rate identity resolves to under the current table, folded
 * into per-model costs, the total, the unpriced model list, and the table
 * itself. Purely additive — totals, day rows, and the recent window are
 * returned untouched, so the token aggregation (and the rollup format)
 * never carries currency, and an updated table re-prices history for free.
 * @param summary - the aggregated summary (build or filtered).
 * @param pricing - the active pricing table.
 * @returns the same summary plus the cost fields.
 */
export declare function attachCosts(summary: TokenSummary & {
    dataDir: string;
}, pricing: PricingTable): UsageSummary;
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
 * retries the absorption. The resolver prices each record as it is absorbed,
 * so the rollup carries rate identities (never prices) and a table update
 * re-prices history without rebuilding anything.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @param resolve - the rate resolver (see {@link RateResolver}).
 * @returns the summary served to the web settings page.
 */
export declare function buildSummary(dir: string, now?: () => Date, resolve?: RateResolver): Promise<TokenSummary & {
    dataDir: string;
}>;
//# sourceMappingURL=stats.d.ts.map