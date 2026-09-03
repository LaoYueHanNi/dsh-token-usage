/**
 * Trend-chart point series: fold the three render-mode inputs (per-day
 * rows, per-hour rows, per-request series) into one discriminated-union
 * series with the mode decided at the top. Pure functions, no React.
 *
 * @module token-usage/client/trend-chart/points
 */

import type { RequestPoint, UsageDayRow, UsageHourRow } from '../../wire.ts'
import { daySeries, hourSeries } from '../day.ts'
import type { DayPoint, HourPoint } from '../day.ts'
import { bucketSeries } from './bucket.ts'
import type { TrendBucket } from './bucket.ts'

/**
 * The chart series, normalised over the three render modes. Equidistant
 * modes (days, hours) advance `index` one step per point; temporal mode
 * (request buckets) attaches the wall time so the renderer scales each
 * point at its real temporal proportion of the span.
 */
export type ChartSeries =
  | { mode: 'equidistant'; points: { key: string; label: string; full: string; tokens: number }[] }
  | { mode: 'temporal'; points: { key: string; label: string; full: string; tokens: number; time: number; count: number }[] }

interface BuildPointsInput {
  rows: readonly UsageDayRow[]
  hours?: readonly UsageHourRow[] | undefined
  requests?: readonly RequestPoint[] | undefined
  from?: string | undefined
  to?: string | undefined
}

/** Render-mode priority: request buckets outrank per-hour, which
 * outranks per-day. A session-scoped read passes `requests`; the settings
 * page passes `hours` for a single-day range; everything else plots days. */
export function buildChartPoints(input: BuildPointsInput): ChartSeries | null {
  if (input.requests !== undefined && input.requests.length > 0) {
    const buckets = bucketsOf(input.requests)
    if (buckets.length > 0) {
      const firstDate = new Date(buckets[0]!.start).toDateString()
      const lastDate = new Date(buckets[buckets.length - 1]!.start).toDateString()
      const crossDay = firstDate !== lastDate
      return {
        mode: 'temporal',
        points: buckets.map((bucket, index) => ({
          key: `b${index}`,
          label: bucketLabel(bucket.start, crossDay),
          full: `${bucketLabel(bucket.start, crossDay)}–${bucketLabel(bucket.end, crossDay)}`,
          tokens: bucket.tokens,
          time: bucket.start,
          count: bucket.count,
        })),
      }
    }
  }
  if (input.hours !== undefined) {
    const points = hourSeries(input.hours, input.from, input.to)
    if (points.length > 0) {
      return { mode: 'equidistant', points: points.map(hourToPoint) }
    }
  }
  const points = daySeries(input.rows, input.from, input.to)
  if (points.length > 0) {
    return { mode: 'equidistant', points: points.map(dayToPoint) }
  }
  return null
}

/**
 * The cumulative view of a series: every point's `tokens` replaced by the
 * running total up to and including that point (a prefix sum), so the chart
 * reads as a monotonic rise. Orthogonal to the mode — all three input
 * shapes are time-ascending, so a plain forward fold is order-correct. The
 * input series is left untouched; each point is copied with only `tokens`
 * rewritten, so the renderer's shape probes (`'time' in point`) keep working.
 * @param series - the series from {@link buildChartPoints}.
 * @returns a new series of the same mode and shape.
 */
export function cumulateSeries(series: ChartSeries): ChartSeries {
  let running = 0
  const fold = <T extends { tokens: number }>(points: readonly T[]): T[] =>
    points.map(point => {
      running += point.tokens
      return { ...point, tokens: running }
    })
  if (series.mode === 'equidistant') return { mode: 'equidistant', points: fold(series.points) }
  return { mode: 'temporal', points: fold(series.points) }
}

/** A series that already carries `count` (the host's `fields=session`
 * downsample) is plotted as-is; a raw per-request series is folded here. */
function bucketsOf(requests: readonly RequestPoint[]): TrendBucket[] {
  if (requests[0]?.count !== undefined) {
    return requests.map(point => ({
      start: point.time,
      end: point.end ?? point.time,
      tokens: point.tokens,
      count: point.count ?? 1,
    }))
  }
  return bucketSeries(requests)
}

function dayToPoint(point: DayPoint): { key: string; label: string; full: string; tokens: number } {
  return { key: point.day, label: point.day.slice(5), full: point.day, tokens: point.tokens }
}

function hourToPoint(point: HourPoint): { key: string; label: string; full: string; tokens: number } {
  return {
    key: point.hour,
    label: `${point.hour.slice(11)}:00`,
    full: `${point.hour.slice(0, 10)} ${point.hour.slice(11)}:00`,
    tokens: point.tokens,
  }
}

/** Zero-padded HH:mm of one wall time, local-time. */
function clockOf(time: number): string {
  const d = new Date(time)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The x-axis label of one bucket start: HH:mm within one day,
 * MM-DD HH:mm once the session crosses midnight. */
function bucketLabel(time: number, crossDay: boolean): string {
  if (!crossDay) return clockOf(time)
  const d = new Date(time)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockOf(time)}`
}
