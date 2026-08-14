import { describe, expect, it } from 'vitest'
import { daySeries, shiftedDayKey } from '../src/client/day.ts'
import type { UsageDayRow } from '../src/wire.ts'

function dayRow(day: string, tokens: number): UsageDayRow {
  return { day, totals: { requests: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

describe('shiftedDayKey', () => {
  it('keys local calendar days, crossing month boundaries', () => {
    const now = (): Date => new Date(2026, 0, 31, 23, 30)
    expect(shiftedDayKey(0, now)).toBe('2026-01-31')
    expect(shiftedDayKey(1, now)).toBe('2026-02-01')
    expect(shiftedDayKey(-30, now)).toBe('2026-01-01')
  })
})

describe('daySeries', () => {
  it('spans the rows first to last when unfiltered', () => {
    const points = daySeries([dayRow('2026-01-15', 5), dayRow('2026-01-18', 7)])
    expect(points.map(point => point.day)).toEqual(['2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18'])
    expect(points.map(point => point.tokens)).toEqual([5, 0, 0, 7])
  })

  it('spans the requested inclusive range, zero-filling outside the rows', () => {
    const points = daySeries([dayRow('2026-01-15', 5)], '2026-01-14', '2026-01-16')
    expect(points.map(point => point.tokens)).toEqual([0, 5, 0])
  })

  it('returns an empty series without rows and without a range', () => {
    expect(daySeries([])).toEqual([])
  })

  it('returns an empty series for an inverted range', () => {
    expect(daySeries([dayRow('2026-01-15', 5)], '2026-01-16', '2026-01-15')).toEqual([])
  })
})
