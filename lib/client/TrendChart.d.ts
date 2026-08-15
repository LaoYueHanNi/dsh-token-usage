/**
 * Daily token trend chart (browser half): a dependency-free SVG line chart
 * over the already-filtered summary. Two granularities share one renderer —
 * per-day rows (x axis spans every calendar day of the active range, days
 * without records plot as zero) and per-hour rows (a single-day window plots
 * every whole hour of that day, 00:00–23:00, future hours of today reading
 * zero). The x axis labels first/middle/last points; the y axis grid uses
 * round 1/2/2.5/5 × 10ⁿ steps (K/M/B abbreviated). Hovering (or keyboard-
 * focusing) a point highlights it and floats a label with that point's
 * date/time and total tokens. An empty range renders a placeholder instead
 * of an axis.
 *
 * @module token-usage/client/TrendChart
 */
import type { ReactNode } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { UsageDayRow, UsageHourRow } from '../wire.ts';
/** The roundest step from 1/2/2.5/5 × 10ⁿ not below the rough target. */
export declare function niceStep(rough: number): number;
/**
 * Render the daily (or, for a single-day window, hourly) token line chart.
 * @param props - the filtered per-day rows plus the optional per-hour rows
 * (when present the chart plots hours instead of days), the active range
 * bounds (absent when unfiltered; the chart then spans first to last row),
 * and the `t` seat for the empty hint and the chart aria-label.
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export declare function TrendChart({ rows, hours, from, to, t }: {
    rows: readonly UsageDayRow[];
    hours?: readonly UsageHourRow[];
    from?: string;
    to?: string;
    t: TranslateNS<'token-usage'>;
}): ReactNode;
//# sourceMappingURL=TrendChart.d.ts.map