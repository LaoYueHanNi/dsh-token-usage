/**
 * Daily total-token trend chart (browser half): a dependency-free SVG line
 * chart over the per-day rows of the already-filtered summary. The x axis
 * spans every calendar day of the active range — days without records plot
 * as zero — and an empty range renders a placeholder instead of an axis.
 *
 * @module token-usage/client/TrendChart
 */
import type { ReactNode } from 'react';
import type { UsageDayRow } from '../wire.ts';
/**
 * Render the daily token line chart.
 * @param props - the filtered per-day rows plus the active range bounds
 * (absent when unfiltered; the chart then spans first to last row).
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export declare function TrendChart({ rows, from, to }: {
    rows: readonly UsageDayRow[];
    from?: string;
    to?: string;
}): ReactNode;
//# sourceMappingURL=TrendChart.d.ts.map