/**
 * Public re-exports of the trend-chart helpers, so the test suite and
 * any future module can import them from a single barrel.
 */

export { MAX_BUCKETS, bucketSeries, bucketWidth, scaleToSpan } from './bucket.ts'
export type { TrendBucket } from './bucket.ts'
export { niceStep, tickValues } from './axis.ts'
export { buildChartPoints, cumulateSeries } from './points.ts'
export type { ChartSeries } from './points.ts'
export { dotRadius, labelIndices, scaleSeries } from './scale.ts'
export type { ScaleResult } from './scale.ts'
