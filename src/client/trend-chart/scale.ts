/**
 * Trend-chart x scaling: pick the right scale for a series mode and
 * return the per-point offsets in one pass. Pure functions, no React.
 *
 * @module token-usage/client/trend-chart/scale
 */

import type { ChartSeries } from './points.ts'
import { scaleToSpan } from './bucket.ts'

/** A scale decision plus the per-point x offsets, expressed as **absolute
 * SVG viewBox coordinates** (already offset by `leftEdge`). Returning
 * absolute coords prevents the "renderer forgot to add `LEFT`" bug that
 * shows up as a line hugging the very-left edge of the chart area. */
export interface ScaleResult {
  /** The x offset of every point in SVG viewBox coordinates (range
   * `[leftEdge, rightEdge]`). */
  xs: number[]
  /** Temporal only: each bucket's exclusive `end` on the same scale as
   * `xs`, clamped to `[leftEdge, rightEdge]`. Gap paths use
   * `xEnds[i] − xs[i]` as the bucket width so the hold ends one bucket
   * before the next cluster. */
  xEnds?: number[]
  /** The plottable width (rightEdge − leftEdge); the renderer can use it
   * for hit-target extents and label clamps. */
  innerWidth: number
}

function clampX(value: number, leftEdge: number, rightEdge: number): number {
  return Math.min(Math.max(value, leftEdge), rightEdge)
}

/**
 * Pick the right x scale for a {@link ChartSeries} and produce the
 * per-point offsets in absolute viewBox coordinates. Equidistant modes
 * lay points one stride apart across the `[leftEdge, rightEdge]` span;
 * temporal mode uses each point's wall time against the series' own
 * first-start to last-start span and adds `leftEdge` to the result.
 * A zero span (one point, or every start equal) pins to the centerline.
 * Temporal results include `xEnds` for the gap-path bucket width.
 *
 * @param series - the discriminated-union series from {@link buildChartPoints}.
 * @param leftEdge - the absolute SVG x of the chart's left edge (the
 * y-axis line in the renderer).
 * @param rightEdge - the absolute SVG x of the chart's right edge
 * (typically `viewBox.width − RIGHT.margin`).
 * @returns the per-point x offsets plus `innerWidth = rightEdge − leftEdge`.
 */
export function scaleSeries(series: ChartSeries, leftEdge: number, rightEdge: number): ScaleResult {
  const innerWidth = rightEdge - leftEdge
  const { points } = series
  if (series.mode === 'equidistant') {
    const xs: number[] = []
    if (points.length === 1) {
      xs.push((leftEdge + rightEdge) / 2)
    } else {
      const stride = innerWidth / (points.length - 1)
      for (let i = 0; i < points.length; i += 1) xs.push(leftEdge + i * stride)
    }
    return { xs, innerWidth }
  }
  // Temporal: wall time into the first-start to last-start span. `end`
  // uses the same domain; an end past the last start clamps to the right edge.
  const temporal = series.points
  const first = temporal[0]!.time
  const lastStart = temporal[temporal.length - 1]!.time
  if (temporal.length === 1 || first === lastStart) {
    const mid = (leftEdge + rightEdge) / 2
    const xs = temporal.map(() => mid)
    return { xs, xEnds: [...xs], innerWidth }
  }
  const xs: number[] = []
  const xEnds: number[] = []
  for (const point of temporal) {
    const x = clampX(leftEdge + scaleToSpan(first, lastStart, point.time, innerWidth), leftEdge, rightEdge)
    const xEnd = clampX(leftEdge + scaleToSpan(first, lastStart, point.end, innerWidth), leftEdge, rightEdge)
    xs.push(x)
    xEnds.push(Math.max(x, xEnd))
  }
  return { xs, xEnds, innerWidth }
}

/** Approximate 11px tabular-nums character width and minimum pixel clearance
 * between adjacent x-axis tick labels. */
const TICK_CHAR_WIDTH = 6.6
const MIN_TICK_GAP = 16

function tickWidth(label: string): number {
  return label.length * TICK_CHAR_WIDTH
}

/**
 * Pick non-overlapping x-axis label indices from scaled coordinates and
 * label strings. Anchors start (left-aligned) and end (right-aligned)
 * when both fit without colliding, then picks the candidate closest to
 * the geometric midpoint that keeps {@link MIN_TICK_GAP} clearance from
 * both endpoints — skipping the middle label when temporal clustering
 * leaves no point safely centered.
 *
 * @param xs - scaled x coordinates of the plotted points.
 * @param labels - rendered x-axis tick strings matching `xs`.
 * @returns sorted indices into `xs` / `labels` to render.
 */
export function labelIndices(xs: readonly number[], labels: readonly string[]): number[] {
  const length = xs.length
  if (length === 0) return []
  if (length === 1) return [0]

  const last = length - 1
  const leftEnd = xs[0]! + tickWidth(labels[0] ?? '')
  const rightStart = xs[last]! - tickWidth(labels[last] ?? '')
  if (leftEnd + MIN_TICK_GAP > rightStart) return [0]
  if (length === 2) return [0, 1]

  const midTarget = (xs[0]! + xs[last]!) / 2
  const minCenterLeft = leftEnd + MIN_TICK_GAP
  const maxCenterRight = rightStart - MIN_TICK_GAP

  let bestIndex = -1
  let bestDistance = Infinity
  for (let i = 1; i < last; i += 1) {
    const halfWidth = tickWidth(labels[i] ?? '') / 2
    const x = xs[i]!
    if (x - halfWidth < minCenterLeft || x + halfWidth > maxCenterRight) continue
    const distance = Math.abs(x - midTarget)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }

  return bestIndex === -1 ? [0, last] : [0, bestIndex, last]
}

/** Choose a dot radius that survives dense point clouds without
 * overlapping but stays visible for sparse ones. Three tiers, picked by
 * point count. */
export function dotRadius(pointCount: number): number {
  if (pointCount > 90) return 1.5
  if (pointCount > 30) return 2
  return 3
}
