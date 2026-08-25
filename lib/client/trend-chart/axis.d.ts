/**
 * Trend-chart axis helpers: the roundest step from 1/2/2.5/5 × 10ⁿ not
 * below a rough target, and the y-axis tick values (one nice step apart,
 * inclusive of the chart top). Pure functions, no React, no I/O.
 *
 * @module token-usage/client/trend-chart/axis
 */
/**
 * The roundest step from {1, 2, 2.5, 5, 10} × 10ⁿ not below `rough`.
 * A `niceStep(0)` returns 1; a `niceStep(80)` returns 100 (the next nice
 * step above 80 in the same decade).
 * @param rough - the target value (positive).
 * @returns the nice step.
 */
export declare function niceStep(rough: number): number;
/** The y-axis tick values from one step up to the chart top (inclusive). */
export declare function tickValues(max: number): {
    top: number;
    ticks: number[];
};
//# sourceMappingURL=axis.d.ts.map