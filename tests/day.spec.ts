import { describe, expect, it } from 'vitest'
import { daySeries, hourSeries, hourKeyOf, shiftedDayKey } from '../src/client/day.ts'
import type { UsageDayRow, UsageHourRow } from '../src/wire.ts'

function dayRow(day: string, tokens: number): UsageDayRow {
  return { day, totals: { requests: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

function hourRow(hour: string, model: string, tokens: number): UsageHourRow {
  return { hour, model, totals: { requests: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
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

describe('hourKeyOf', () => {
  it('keys the local hour of a date', () => {
    expect(hourKeyOf(new Date(2026, 7, 15, 9, 30))).toBe('2026-08-15T09')
    expect(hourKeyOf(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31T23')
    expect(hourKeyOf(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01T00')
  })
})

describe('hourSeries', () => {
  it('spans one day as the full 00:00-23:00 sequence, folding models per hour', () => {
    const points = hourSeries([
      hourRow('2026-01-15T09', 'deepseek-chat', 5),
      hourRow('2026-01-15T09', 'deepseek-reasoner', 7),
      hourRow('2026-01-15T14', 'deepseek-chat', 3),
    ], '2026-01-15', '2026-01-15')
    expect(points).toHaveLength(24)
    expect(points[0]!.hour).toBe('2026-01-15T00')
    expect(points[23]!.hour).toBe('2026-01-15T23')
    // Both models fold into the 09:00 bucket; empty hours plot as zero.
    expect(points[9]!.tokens).toBe(12)
    expect(points[14]!.tokens).toBe(3)
    expect(points[15]!.tokens).toBe(0)
    expect(points.every(point => point.tokens >= 0)).toBe(true)
  })

  it('spans the rows first to last when unfiltered', () => {
    const points = hourSeries([
      hourRow('2026-01-15T09', 'deepseek-chat', 5),
      hourRow('2026-01-16T10', 'deepseek-chat', 7),
    ])
    expect(points.map(point => point.hour)).toEqual([
      '2026-01-15T09', '2026-01-15T10', '2026-01-15T11', '2026-01-15T12', '2026-01-15T13',
      '2026-01-15T14', '2026-01-15T15', '2026-01-15T16', '2026-01-15T17', '2026-01-15T18',
      '2026-01-15T19', '2026-01-15T20', '2026-01-15T21', '2026-01-15T22', '2026-01-15T23',
      '2026-01-16T00', '2026-01-16T01', '2026-01-16T02', '2026-01-16T03', '2026-01-16T04',
      '2026-01-16T05', '2026-01-16T06', '2026-01-16T07', '2026-01-16T08', '2026-01-16T09',
      '2026-01-16T10',
    ])
    expect(points.map(point => point.tokens)).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])
  })

  it('zero-fills hours outside the rows within the requested range', () => {
    const points = hourSeries([hourRow('2026-01-15T12', 'deepseek-chat', 5)], '2026-01-15', '2026-01-15')
    expect(points).toHaveLength(24)
    expect(points[12]!.tokens).toBe(5)
    expect(points[0]!.tokens).toBe(0)
    expect(points[23]!.tokens).toBe(0)
  })

  it('returns an empty series without rows and without a range', () => {
    expect(hourSeries([])).toEqual([])
  })

  it('returns an empty series for an inverted range', () => {
    expect(hourSeries([hourRow('2026-01-15T09', 'deepseek-chat', 5)], '2026-01-16', '2026-01-15')).toEqual([])
  })
})
