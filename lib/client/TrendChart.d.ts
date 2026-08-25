/**
 * Daily / hourly / request-bucketed token trend chart (browser half):
 * a dependency-free SVG line chart over the already-filtered summary.
 * The renderer is pure presentation; the bucketing, scaling, and
 * point-shape decisions live in `./trend-chart/*` so each piece can be
 * tested in isolation.
 *
 * Two granularities share one renderer — per-day rows (x axis spans
 * every calendar day of the active range, days without records plot as
 * zero) and per-hour rows (a single-day window plots every whole hour of
 * that day, 00:00–23:00, future hours of today reading zero). The
 * third mode — request buckets — folds the request series into uniformly
 * sized time buckets spanning the session's actual first-to-last window
 * and scales each bucket at its real temporal proportion of the span.
 *
 * Hovering (or keyboard-focusing) a point highlights it and floats a
 * label with that point's date/time and total tokens.
 *
 * @module token-usage/client/TrendChart
 */
import type { ReactNode } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { RequestPoint, UsageDayRow, UsageHourRow } from '../wire.ts';
/** Re-export the chart's pure helpers for the test suite. */
export { MAX_BUCKETS, bucketSeries, bucketWidth, buildChartPoints, dotRadius, labelIndices, niceStep, scaleSeries, scaleToSpan, tickValues, } from './trend-chart/index.ts';
export type { TrendBucket } from './trend-chart/bucket.ts';
export type { ChartSeries, ScaleResult } from './trend-chart/index.ts';
/**
 * Render the daily / hourly / request-bucketed token line chart. Pure
 * presentation: every data-driven decision (bucketing, axis scaling,
 * point ordering) lives in `./trend-chart/*`; this component picks the
 * right `chartAria` string for screen readers and forwards hover /
 * focus state to the dot + label.
 *
 * Empty ranges (no data on any branch) render a placeholder instead of an
 * axis so the layout does not collapse to an empty SVG.
 *
 * @param props - the filtered per-day rows plus the optional per-hour rows
 * (when present the chart plots hours instead of days), the optional
 * per-request series (session-scoped reads), the active range bounds
 * (absent when unfiltered; the chart then spans first to last row), and
 * the `t` seat for the empty hint and chart aria-label.
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export declare function TrendChart({ rows, hours, requests, from, to, t }: {
    rows: readonly UsageDayRow[];
    hours?: readonly UsageHourRow[];
    requests?: readonly RequestPoint[];
    from?: string;
    to?: string;
    t: TranslateNS<'token-usage'>;
}): ReactNode;
//# sourceMappingURL=TrendChart.d.ts.map