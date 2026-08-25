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
export function niceStep(rough: number): number {
  const base = 10 ** Math.floor(Math.log10(rough))
  const fraction = rough / base
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return nice * base
}

/** The y-axis tick values from one step up to the chart top (inclusive). */
export function tickValues(max: number): { top: number; ticks: number[] } {
  if (max === 0) return { top: 1, ticks: [] }
  const step = niceStep(max / 4)
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = step; value < top; value += step) ticks.push(value)
  ticks.push(top)
  return { top, ticks }
}
