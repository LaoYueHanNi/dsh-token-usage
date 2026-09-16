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

/**
 * Generate a smooth cubic Bezier path using Fritsch-Carlson monotone cubic
 * Hermite interpolation. Preserves monotonicity so zero-filled plateaus stay
 * strictly flat at baseline without undershooting, and peaks round smoothly.
 *
 * @param xs - scaled x coordinates (monotonic ascending).
 * @param ys - scaled y coordinates.
 * @returns SVG `d` string containing M, L, and C commands.
 */
export function monotoneSplinePath(xs: readonly number[], ys: readonly number[]): string {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M${xs[0]!.toFixed(1)},${ys[0]!.toFixed(1)}`
  if (n === 2) {
    return `M${xs[0]!.toFixed(1)},${ys[0]!.toFixed(1)} L${xs[1]!.toFixed(1)},${ys[1]!.toFixed(1)}`
  }

  // 1. Calculate secant slopes between adjacent points.
  const dx: number[] = []
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    const dX = xs[i + 1]! - xs[i]!
    const dY = ys[i + 1]! - ys[i]!
    dx.push(dX)
    slopes.push(dX === 0 ? 0 : dY / dX)
  }

  // 2. Initialize tangent slopes at each point.
  const m: number[] = new Array(n)
  m[0] = slopes[0]!
  m[n - 1] = slopes[n - 2]!
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = slopes[i - 1]!
    const s1 = slopes[i]!
    if (s0 * s1 <= 0) {
      m[i] = 0
    } else {
      m[i] = (s0 + s1) / 2
    }
  }

  // 3. Fritsch-Carlson bounds: eliminate overshoot / undershoot.
  for (let i = 0; i < n - 1; i += 1) {
    const slope = slopes[i]!
    if (slope === 0) {
      m[i] = 0
      m[i + 1] = 0
    } else {
      const alpha = m[i]! / slope
      const beta = m[i + 1]! / slope
      const dist = alpha * alpha + beta * beta
      if (dist > 9) {
        const tau = 3 / Math.sqrt(dist)
        m[i] = tau * alpha * slope
        m[i + 1] = tau * beta * slope
      }
    }
  }

  // 4. Construct cubic Bezier commands.
  const parts: string[] = [`M${xs[0]!.toFixed(1)},${ys[0]!.toFixed(1)}`]
  for (let i = 0; i < n - 1; i += 1) {
    const dX = dx[i]!
    const x0 = xs[i]!
    const y0 = ys[i]!
    const x1 = xs[i + 1]!
    const y1 = ys[i + 1]!
    const cp1x = x0 + dX / 3
    const cp1y = y0 + m[i]! * (dX / 3)
    const cp2x = x1 - dX / 3
    const cp2y = y1 - m[i + 1]! * (dX / 3)
    parts.push(
      `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`,
    )
  }
  return parts.join(' ')
}

/**
 * Close a line/curve path down to the baseline (`yZero`) to form an area polygon.
 * Returns an empty string when the input path is empty or has fewer than 2 points.
 *
 * @param linePath - the line or curve `d` string.
 * @param xs - the plotted x coordinates.
 * @param yZero - the baseline y coordinate.
 * @returns SVG `d` string closed with Z for fill.
 */
export function areaPath(linePath: string, xs: readonly number[], yZero: number): string {
  if (linePath === '' || xs.length < 2) return ''
  const firstX = xs[0]!.toFixed(1)
  const lastX = xs[xs.length - 1]!.toFixed(1)
  const baseY = yZero.toFixed(1)
  return `${linePath} L${lastX},${baseY} L${firstX},${baseY} Z`
}

/**
 * Return coordinates with gap hold points inserted so temporal series can be
 * smoothly interpolated with monotonic cubic splines without smearing idle spans.
 */
export function gapPatchedPoints(input: {
  xs: readonly number[]
  ys: readonly number[]
  yZero: number
  hold?: 'zero' | 'previous' | undefined
  gaps?: readonly boolean[] | undefined
  xEnds?: readonly number[] | undefined
}): { xs: number[]; ys: number[] } {
  const { xs, ys, yZero, hold, gaps, xEnds } = input
  if (xs.length === 0) return { xs: [], ys: [] }
  const outXs: number[] = [xs[0]!]
  const outYs: number[] = [ys[0]!]
  for (let index = 0; index < xs.length - 1; index += 1) {
    const xNext = xs[index + 1]!
    const yNext = ys[index + 1]!
    if (gaps?.[index] === true) {
      const ends = xEnds ?? xs
      const xEnd = ends[index]!
      const nextWidth = Math.max(ends[index + 1]! - xNext, 0)
      const xHold = Math.max(xEnd, xNext - nextWidth)
      const holdY = hold === 'previous' ? ys[index]! : yZero
      if (xEnd > outXs[outXs.length - 1]!) {
        outXs.push(xEnd)
        outYs.push(holdY)
      }
      if (xHold > xEnd) {
        outXs.push(xHold)
        outYs.push(holdY)
      }
      outXs.push(xNext)
      outYs.push(yNext)
    } else {
      outXs.push(xNext)
      outYs.push(yNext)
    }
  }
  return { xs: outXs, ys: outYs }
}

/**
 * Generate a smooth spline path for either equidistant or gap-patched temporal series.
 */
export function smoothSeriesPath(input: {
  xs: readonly number[]
  ys: readonly number[]
  yZero: number
  gaps?: readonly boolean[] | undefined
  xEnds?: readonly number[] | undefined
  hold?: 'zero' | 'previous' | undefined
}): string {
  const { xs, ys, yZero, gaps, xEnds, hold } = input
  if (gaps !== undefined && gaps.some(g => g)) {
    const patched = gapPatchedPoints({ xs, ys, yZero, hold, gaps, xEnds })
    return monotoneSplinePath(patched.xs, patched.ys)
  }
  return monotoneSplinePath(xs, ys)
}



