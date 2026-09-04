/**
 * Trend-chart SVG path geometry: a polyline, optionally patched across
 * temporal gaps. Pure functions, no React.
 *
 * @module token-usage/client/trend-chart/path
 */

/** How consecutive points are joined. */
export type PathStyle = 'polyline' | 'gap'

/**
 * Per-segment gap flags: `flags[i]` is true when the next bucket starts
 * after this bucket's exclusive `end`. Adjacent uniform buckets have
 * `next.time === prev.end` and are not gaps.
 */
export function gapAfter(points: readonly { time: number; end: number }[]): boolean[] {
  const flags: boolean[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    flags.push(points[index + 1]!.time > points[index]!.end)
  }
  return flags
}

/**
 * SVG `d` for already-scaled coordinates. Empty → `''`; one point → `M`.
 *
 * `gap` is the original polyline plus a patch: adjacent buckets stay a
 * straight `L`; a gap holds `hold` (`zero` = axis, `previous` = last y)
 * from the previous bucket's end until one bucket-width before the next
 * start, then slants in — so idle is not interpolated and dense hours
 * keep the polyline.
 */
export function seriesPath(input: {
  xs: readonly number[]
  ys: readonly number[]
  yZero: number
  style: PathStyle
  hold?: 'zero' | 'previous'
  gaps?: readonly boolean[]
  xEnds?: readonly number[]
}): string {
  const { xs, ys, yZero, style, hold, gaps, xEnds } = input
  if (xs.length === 0) return ''
  const cmd = (letter: 'M' | 'L', x: number, y: number): string =>
    `${letter}${x.toFixed(1)},${y.toFixed(1)}`
  const parts: string[] = [cmd('M', xs[0]!, ys[0]!)]
  for (let index = 0; index < xs.length - 1; index += 1) {
    const xNext = xs[index + 1]!
    const yNext = ys[index + 1]!
    if (style === 'gap' && gaps?.[index] === true) {
      const ends = xEnds ?? xs
      const xEnd = ends[index]!
      const nextWidth = Math.max(ends[index + 1]! - xNext, 0)
      const xHold = Math.max(xEnd, xNext - nextWidth)
      const holdY = hold === 'previous' ? ys[index]! : yZero
      parts.push(cmd('L', xEnd, holdY), cmd('L', xHold, holdY), cmd('L', xNext, yNext))
    } else {
      parts.push(cmd('L', xNext, yNext))
    }
  }
  return parts.join(' ')
}
