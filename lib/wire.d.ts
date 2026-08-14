/**
 * Browser-safe wire vocabulary of the token-usage plugin: the stats endpoint
 * path and the JSON shapes the web settings page consumes. No runtime imports
 * and no I/O, so the host half (route handler) and the browser half (settings
 * page) share one vocabulary, and the client bundle can inline this module.
 *
 * @module token-usage/wire
 */
import type { UsageRecord } from './usage-record.ts';
export type { UsageFields, UsageRecord } from './usage-record.ts';
/** The stats endpoint path, served by the host half's webServer route. */
export declare const STATS_PATH = "/token-usage/stats";
/** Aggregated token counts over one group of records. */
export interface UsageTotals {
    /** Number of recorded requests (records without provider usage count here). */
    requests: number;
    /** Uncached input tokens; billed input = input + cacheRead + cacheWrite. */
    inputTokens: number;
    /** Output tokens. */
    outputTokens: number;
    /** Cache-hit input tokens. */
    cacheReadTokens: number;
    /** Cache-write input tokens. */
    cacheWriteTokens: number;
}
/** One per-day aggregation row, keyed by local date `YYYY-MM-DD`. */
export interface UsageDayRow {
    day: string;
    totals: UsageTotals;
}
/** One per-model aggregation row. */
export interface UsageModelRow {
    model: string;
    totals: UsageTotals;
}
/** One per-day per-model aggregation row (the day × model cross). */
export interface UsageDayModelRow {
    day: string;
    model: string;
    totals: UsageTotals;
}
/** The full stats payload served at {@link STATS_PATH}. */
export interface UsageSummary {
    /** Absolute data directory the summary was computed from. */
    dataDir: string;
    /** Totals over every recorded request. */
    total: UsageTotals;
    /** Per-local-day rows, ascending by day. */
    byDay: UsageDayRow[];
    /** Per-model rows, descending by request count. */
    byModel: UsageModelRow[];
    /** Per-day × per-model rows, day then model ascending; lets the route
     * re-aggregate any day range × model filter without rereading files. */
    byDayModel: UsageDayModelRow[];
    /** The most recent records, descending by time. */
    recent: UsageRecord[];
}
//# sourceMappingURL=wire.d.ts.map