/**
 * Request-series time bucketing shared by the host stats route (wire
 * downsample) and the conversation-view chart. Pure functions, no React,
 * no I/O — the client bundle can inline this module.
 *
 * @module token-usage/trend-bucket
 */
import type { RequestPoint } from './wire.ts';
/** One time bucket of the request-mode trend: requests folded by time span. */
export interface TrendBucket {
    /** Bucket start, wall time. */
    start: number;
    /** Bucket end (exclusive). */
    end: number;
    /** Summed token totals of the requests inside the bucket. */
    tokens: number;
    /** Requests folded into the bucket. */
    count: number;
}
/** Render / wire cap: the request trend never draws more points than this. */
export declare const MAX_BUCKETS = 60;
/** The bucket width for one span: the finest step whose count fits the cap. */
export declare function bucketWidth(spanMs: number): number;
/**
 * Fold a request series into uniformly sized time buckets spanning the
 * series' own first-to-last window. The axis starts at the series' first
 * record, ends at its latest, and the middle is evenly divided — the chart
 * shows the trend over TIME, not one point per request. Buckets align to
 * the window's first record, not to wall-clock round hours.
 *
 * Implementation note: the buckets are tracked in a `Map` keyed by their
 * 0-based index, not in a sparse array. A multi-month session could
 * otherwise blow past V8's sparse-array bounds (the indices approach
 * `spanMs / 5_000` which is unbounded); the Map collapses absent keys
 * cleanly.
 *
 * @param requests - the per-request series, time-ascending.
 * @returns the buckets in time order (empty for an empty series; only
 * buckets holding at least one request are emitted).
 */
export declare function bucketSeries(requests: readonly RequestPoint[]): TrendBucket[];
/**
 * Project buckets back onto the wire {@link RequestPoint} shape: `time` is
 * the bucket start, `end` / `count` mark a pre-bucketed point so the chart
 * can plot it without folding again.
 */
export declare function pointsOfBuckets(buckets: readonly TrendBucket[]): RequestPoint[];
//# sourceMappingURL=trend-bucket.d.ts.map