// @vitest-environment node
/**
 * Trend-chart pure helpers: the temporal x scaling, the time-bucket
 * folding of the request-mode chart (points land at their real proportion
 * of the session's first-to-last time span, folded into a bounded number
 * of uniformly sized buckets), and the absolute-coordinate x scale.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_BUCKETS, bucketSeries, bucketWidth, buildChartPoints, cumulateSeries, scaleSeries, scaleToSpan,
} from '../src/client/TrendChart.tsx'
import type { ChartSeries } from '../src/client/TrendChart.tsx'
import type { RequestPoint } from '../src/wire.ts'

function reqSeries(times: number[]): ChartSeries {
  return {
    mode: 'temporal',
    points: times.map((time, index) => ({ key: `b${index}`, label: '', full: '', tokens: 0, time })),
  }
}

function eqSeries(count: number): ChartSeries {
  return {
    mode: 'equidistant',
    points: Array.from({ length: count }, (_, index) => ({
      key: `e${index}`, label: '', full: '', tokens: 0,
    })),
  }
}

describe('scaleToSpan', () => {
  const FIRST = 1_700_000_000_000
  const LAST = FIRST + 3_600_000 // one hour later

  it('pins the first and last requests to the axis ends', () => {
    expect(scaleToSpan(FIRST, LAST, FIRST, 800)).toBe(0)
    expect(scaleToSpan(FIRST, LAST, LAST, 800)).toBe(800)
  })

  it('places a mid-span request at its real time proportion', () => {
    // 15 minutes into a 60-minute span → 25% of the width.
    expect(scaleToSpan(FIRST, LAST, FIRST + 900_000, 800)).toBe(200)
  })

  it('bunches a burst inside one minute toward the left', () => {
    // 10 seconds into a 10-second span lands at the far end…
    expect(scaleToSpan(FIRST, FIRST + 10_000, FIRST + 10_000, 800)).toBe(800)
    // …and 1/5 of that span at 20%.
    expect(scaleToSpan(FIRST, FIRST + 10_000, FIRST + 2_000, 800)).toBe(160)
  })

  it('centres every point when all requests share one timestamp', () => {
    expect(scaleToSpan(FIRST, FIRST, FIRST, 800)).toBe(400)
  })
})

describe('bucketWidth', () => {
  it('picks finer steps for short spans and coarser ones for long spans', () => {
    expect(bucketWidth(10_000)).toBe(5_000) // 10s → two 5s buckets
    expect(bucketWidth(60_000)).toBe(5_000) // 1 min → 12 buckets
    expect(bucketWidth(10 * 60_000)).toBe(15_000) // 10 min → 40 buckets
    expect(bucketWidth(2 * 3_600_000)).toBe(300_000) // 2 h → 24 buckets
    expect(bucketWidth(2 * 86_400_000)).toBe(3_600_000) // 2 d → 48 buckets
  })

  it('always stays within the render cap', () => {
    for (const span of [5_000, 60_000, 3_600_000, 86_400_000, 30 * 86_400_000, 365 * 86_400_000]) {
      expect(Math.ceil(span / bucketWidth(span))).toBeLessThanOrEqual(MAX_BUCKETS)
    }
  })

  it('aligns multi-month spans up to whole hours', () => {
    expect(bucketWidth(365 * 86_400_000) % 3_600_000).toBe(0)
  })
})

describe('bucketSeries', () => {
  const FIRST = 1_700_000_000_000

  function req(time: number, tokens: number): RequestPoint {
    return { time, tokens }
  }

  it('folds requests into uniform time buckets over their own window', () => {
    // Ten minute-apart requests → 15-second buckets: one bucket each.
    const series = Array.from({ length: 10 }, (_, index) => req(FIRST + index * 60_000, 100))
    const buckets = bucketSeries(series)
    expect(buckets).toHaveLength(10)
    expect(buckets[0]!.start).toBe(FIRST)
    expect(buckets[0]!.tokens).toBe(100)
    // The window starts at the first record; the last bucket starts at the
    // latest record's own bucket boundary (the axis end = latest time).
    expect(buckets[9]!.start).toBe(FIRST + 9 * 60_000)
    expect(buckets[9]!.end - buckets[9]!.start).toBe(15_000)
  })

  it('aggregates bursts inside one bucket', () => {
    // 55 requests inside 5 seconds → one 5s bucket holding all of them.
    const series = Array.from({ length: 55 }, (_, index) => req(FIRST + index * 90, 10))
    const buckets = bucketSeries(series)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.count).toBe(55)
    expect(buckets[0]!.tokens).toBe(550)
  })

  it('spans across midnight with the window starting at the first record', () => {
    // 23:50 → 00:05 crosses midnight: a 15-minute window → 1-minute buckets.
    const start = new Date(2026, 0, 1, 23, 50).getTime()
    const buckets = bucketSeries([req(start, 5), req(start + 300_000, 7), req(start + 900_000, 9)])
    expect(buckets[0]!.start).toBe(start)
    expect(buckets[buckets.length - 1]!.start).toBe(start + 15 * 60_000)
    expect(buckets).toHaveLength(3)
  })

  it('returns an empty list for an empty series', () => {
    expect(bucketSeries([])).toEqual([])
  })
})

describe('buildChartPoints', () => {
  it('plots a pre-bucketed series (with count) without folding again', () => {
    const requests: RequestPoint[] = [
      { time: 1_000, end: 6_000, tokens: 50, count: 10 },
      { time: 6_000, end: 11_000, tokens: 80, count: 5 },
    ]
    const series = buildChartPoints({ rows: [], requests })
    expect(series?.mode).toBe('temporal')
    expect(series?.points).toHaveLength(2)
    expect(series?.points[0]?.tokens).toBe(50)
    expect(series?.points[1]?.tokens).toBe(80)
    if (series?.mode === 'temporal') {
      expect(series.points[0]?.count).toBe(10)
      expect(series.points[0]?.full).toContain('–')
    }
  })
})

describe('cumulateSeries', () => {
  it('replaces each temporal point with the running total, keeping shape fields', () => {
    const series: ChartSeries = {
      mode: 'temporal',
      points: [
        { key: 'b0', label: '10:00', full: '10:00', tokens: 50, time: 1_000, count: 3 },
        { key: 'b1', label: '10:05', full: '10:05', tokens: 80, time: 6_000, count: 5 },
        { key: 'b2', label: '10:10', full: '10:10', tokens: 20, time: 11_000, count: 1 },
      ],
    }
    const cumulative = cumulateSeries(series)
    expect(cumulative.mode).toBe('temporal')
    expect(cumulative.points.map(point => point.tokens)).toEqual([50, 130, 150])
    if (cumulative.mode === 'temporal') {
      // The x-axis inputs (time / count) ride along untouched, so the
      // renderer's temporal scale and the bucket tooltip stay correct.
      expect(cumulative.points[0]).toMatchObject({ time: 1_000, count: 3 })
      expect(cumulative.points[2]).toMatchObject({ time: 11_000, count: 1 })
    }
  })

  it('turns an empty equidistant point into a flat plateau instead of a dip to zero', () => {
    const series: ChartSeries = {
      mode: 'equidistant',
      points: [
        { key: '2026-09-01', label: '09-01', full: '2026-09-01', tokens: 100 },
        { key: '2026-09-02', label: '09-02', full: '2026-09-02', tokens: 0 },
        { key: '2026-09-03', label: '09-03', full: '2026-09-03', tokens: 30 },
      ],
    }
    expect(cumulateSeries(series).points.map(point => point.tokens)).toEqual([100, 100, 130])
  })

  it('maps a single point to its own total', () => {
    const series: ChartSeries = {
      mode: 'equidistant',
      points: [{ key: 'd0', label: '', full: '', tokens: 42 }],
    }
    expect(cumulateSeries(series).points[0]?.tokens).toBe(42)
  })

  it('leaves the input series untouched', () => {
    const series: ChartSeries = {
      mode: 'equidistant',
      points: [
        { key: 'd0', label: '', full: '', tokens: 10 },
        { key: 'd1', label: '', full: '', tokens: 10 },
      ],
    }
    cumulateSeries(series)
    expect(series.points.map(point => point.tokens)).toEqual([10, 10])
  })
})

describe('scaleSeries', () => {
  // The contract: every value returned in `xs` is an absolute SVG viewBox
  // coordinate already offset by `leftEdge`. Without that contract the
  // renderer would have to add `LEFT` at every call site, which is the
  // exact regression a previous refactor introduced — the line hugged
  // x=0 and the x-axis labels fell under the y-axis gutter. These tests
  // pin the offsets down so the bug cannot creep back.

  const LEFT = 44
  const RIGHT = 16
  const WIDTH = 800

  it('pins equidistant points to the [leftEdge, rightEdge] span', () => {
    const { xs, innerWidth } = scaleSeries(eqSeries(5), LEFT, WIDTH - RIGHT)
    expect(innerWidth).toBe(WIDTH - LEFT - RIGHT)
    // First point on the y-axis, last point on the right margin, three
    // points evenly stepped in between.
    expect(xs[0]).toBe(LEFT)
    expect(xs[4]).toBe(WIDTH - RIGHT)
    expect(xs[1]).toBeCloseTo(LEFT + (innerWidth / 4))
    expect(xs[2]).toBeCloseTo(LEFT + (innerWidth / 2))
    expect(xs[3]).toBeCloseTo(LEFT + (3 * innerWidth / 4))
  })

  it('pins temporal points to the same [leftEdge, rightEdge] span', () => {
    const FIRST = 1_700_000_000_000
    const LAST = FIRST + 3_600_000
    // 5 points across one hour, anchored at the chart's edges (not at 0).
    const { xs } = scaleSeries(
      reqSeries([FIRST, FIRST + 900_000, FIRST + 1_800_000, FIRST + 2_700_000, LAST]),
      LEFT, WIDTH - RIGHT,
    )
    expect(xs[0]).toBe(LEFT)
    expect(xs[4]).toBe(WIDTH - RIGHT)
    // The 15-minute midpoint lands at the centre of the plottable span,
    // not at the centre of the viewBox.
    expect(xs[2]).toBeCloseTo(LEFT + (WIDTH - LEFT - RIGHT) / 2)
  })

  it('centres a single point in the plottable span (not the viewBox)', () => {
    // Without the LEFT offset the lone dot would render at viewBox x=0,
    // collapsing into the y-axis label gutter.
    const { xs } = scaleSeries(eqSeries(1), LEFT, WIDTH - RIGHT)
    expect(xs[0]).toBe((LEFT + (WIDTH - RIGHT)) / 2)
  })

  it('honours a custom leftEdge / rightEdge pair (compact chart layouts)', () => {
    // Tiny card: plottable span is [12, 36]. The line still anchors at
    // both ends of that span instead of leaking into the gutter.
    const { xs } = scaleSeries(eqSeries(3), 12, 36)
    expect(xs[0]).toBe(12)
    expect(xs[2]).toBe(36)
    expect(xs[1]).toBe(24)
  })
})