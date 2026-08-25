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
import type { CostedSummary, PricingTable, RateKey, RequestPoint, TokenSummary, UsageTotals } from './wire.ts';
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
 * Keep only the records owned by one of the listed sessions. The rollup
 * carries no session dimension (its rows are (day, model, rate) cells), so a
 * session-scoped read cannot reuse it and must fold the filtered raw records
 * instead — cheap in practice (the JSONL day files are a few hundred KB) and
 * only triggered by per-session fetches (view switches), never the settings
 * page's whole-log read.
 * @param records - parsed records in day-file order.
 * @param sessionIds - the sessions whose requests stay; [] yields no records.
 * @returns the records owned by those sessions, in the original order.
 */
export declare function filterRecordsBySessions(records: readonly UsageRecord[], sessionIds: readonly string[]): UsageRecord[];
/** Inclusive day-range bounds derived from optional day keys; the window
 * covers `[from 00:00, to 23:59:59.999]` local time on the boundary days. */
export interface DayRangeFilter {
    /** Inclusive lower bound, epoch ms; undefined when unconstrained. */
    start?: number;
    /** Inclusive upper bound (with the day's millisecond span folded in), epoch ms. */
    end?: number;
    /** Exact model id; undefined matches any model. */
    model?: string;
}
/**
 * Derive the half-open day-range bounds from optional `YYYY-MM-DD` keys. A
 * missing key leaves that side unbounded; the upper bound inherits the day's
 * full millisecond span (the day-key convention used everywhere else).
 * @param from - first day key (`YYYY-MM-DD`), inclusive; '' ignores both ends.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id; undefined matches any model.
 * @returns the bounds (every field may be undefined).
 */
export declare function dayRangeFilter(from?: string, to?: string, model?: string): DayRangeFilter;
/**
 * Combine a day-range filter with a session-id filter. The session ids are
 * applied first (cheap, preroll), the day-range second (per-record); the
 * model id, if any, is per-record too. Returns the records passing both.
 * @param records - parsed records in chronological order.
 * @param sessions - the session ids whose records stay; undefined skips that
 * dimension.
 * @param range - the day-range + model filter; undefined skips every dimension.
 */
export declare function filterRecordsByRange(records: readonly UsageRecord[], sessions: readonly string[] | undefined, range?: DayRangeFilter): UsageRecord[];
/**
 * The per-request token series of a record set, in time order — one point
 * per request, so a 55-request session plots 55 points. The conversation
 * view tab draws this at request granularity; the settings page's hourly
 * aggregation is unchanged (this field is session-scope only).
 * @param records - the scoped records (day-file order is chronological).
 * @param from - optional inclusive day key; the series keeps those requests.
 * @param to - optional inclusive day key.
 * @param model - optional exact model id.
 * @returns one point per kept request, in the original time order.
 */
export declare function requestSeriesOf(records: readonly UsageRecord[], from?: string, to?: string, model?: string): RequestPoint[];
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
}, pricing: PricingTable): CostedSummary;
/**
 * Read every day file into records, in day-file order. An absent data
 * directory (nothing written yet) yields an empty list. Uncached — the
 * session-scoped route uses `readCachedRecords` so repeated chip /
 * usage-tab polls do not re-parse frozen files.
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