/**
 * Request-series time bucketing shared by the host stats route (wire
 * downsample) and the conversation-view chart. Pure functions, no React,
 * no I/O — the client bundle can inline this module.
 *
 * @module token-usage/trend-bucket
 */

import type { RequestPoint } from './wire.ts'

/** One time bucket of the request-mode trend: requests folded by time span. */
export interface TrendBucket {
  /** Bucket start, wall time. */
  start: number
  /** Bucket end (exclusive). */
  end: number
  /** Summed token totals of the requests inside the bucket. */
  tokens: number
  /** Requests folded into the bucket. */
  count: number
}

/**
 * Bucket widths tried from fine to coarse (ms); the first whose bucket count
 * stays at or under {@link MAX_BUCKETS} wins, so a short session gets
 * fine-grained 5-second buckets and a multi-day session one per several
 * hours — always within the render cap.
 */
const BUCKET_STEPS_MS = [
  5_000, 15_000, 60_000, 300_000, 900_000,
  3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
] as const

/** Render / wire cap: the request trend never draws more points than this. */
export const MAX_BUCKETS = 60

/** The bucket width for one span: the finest step whose count fits the cap. */
export function bucketWidth(spanMs: number): number {
  for (const step of BUCKET_STEPS_MS) {
    if (Math.ceil(spanMs / step) <= MAX_BUCKETS) return step
  }
  // Beyond the coarsest step (multi-month sessions): keep the cap by
  // aligning a custom width up to the next whole hour.
  return Math.ceil(spanMs / MAX_BUCKETS / 3_600_000) * 3_600_000
}

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
export function bucketSeries(requests: readonly RequestPoint[]): TrendBucket[] {
  if (requests.length === 0) return []
  const first = requests[0]!.time
  const last = requests[requests.length - 1]!.time
  const width = bucketWidth(Math.max(last - first, 1))
  const buckets = new Map<number, TrendBucket>()
  for (const request of requests) {
    const index = Math.floor((request.time - first) / width)
    const existing = buckets.get(index)
    if (existing === undefined) {
      buckets.set(index, {
        start: first + index * width,
        end: first + (index + 1) * width,
        tokens: request.tokens,
        count: 1,
      })
    } else {
      existing.tokens += request.tokens
      existing.count += 1
    }
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bucket]) => bucket)
}

/**
 * Project buckets back onto the wire {@link RequestPoint} shape: `time` is
 * the bucket start, `end` / `count` mark a pre-bucketed point so the chart
 * can plot it without folding again.
 */
export function pointsOfBuckets(buckets: readonly TrendBucket[]): RequestPoint[] {
  return buckets.map(bucket => ({
    time: bucket.start,
    end: bucket.end,
    tokens: bucket.tokens,
    count: bucket.count,
  }))
}
