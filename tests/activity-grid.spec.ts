import { describe, expect, it } from 'vitest'
import type { UsageDayRow } from '../src/wire.ts'
import type { ActivityCell, ActivityWeek } from '../src/client/activity-grid.ts'
import { activityLevel, buildActivityGrid } from '../src/client/activity-grid.ts'

function dayRow(day: string, tokens: number): UsageDayRow {
  return { day, totals: { requests: tokens > 0 ? 1 : 0, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
}

function cells(weeks: readonly ActivityWeek[]): ActivityCell[] {
  return weeks.flatMap(week => week.cells.filter(cell => cell !== null))
}

const ROWS = [
  dayRow('2026-02-26', 10),
  dayRow('2026-02-27', 20),
  dayRow('2026-03-01', 30),
  dayRow('2026-03-02', 40),
  dayRow('2026-03-04', 60),
]
const FROM = '2026-02-26'
const TO = '2026-03-04'

describe('buildActivityGrid', () => {
  it('zero-fills days and aligns Monday-first weeks with partial-week placeholders', () => {
    const weeks = buildActivityGrid(ROWS, 'daily', FROM, TO)
    expect(weeks).toHaveLength(2)
    expect(weeks[0]?.key).toBe('2026-02-23')
    expect(weeks[1]?.key).toBe('2026-03-02')
    expect(weeks[0]?.cells.slice(0, 3)).toEqual([null, null, null])
    expect(cells(weeks).map(cell => [cell.day, cell.tokens])).toEqual([
      ['2026-02-26', 10],
      ['2026-02-27', 20],
      ['2026-02-28', 0],
      ['2026-03-01', 30],
      ['2026-03-02', 40],
      ['2026-03-03', 0],
      ['2026-03-04', 60],
    ])
    // March starts inside the first week, so that column carries its label.
    expect(weeks[0]?.month).toBe(3)
    expect(weeks[1]?.month).toBeUndefined()
  })

  it('aggregates whole calendar weeks without extending filtered partial weeks', () => {
    const weeks = buildActivityGrid(ROWS, 'weekly', FROM, TO)
    expect(weeks[0]?.cells.filter(cell => cell !== null).every(cell => cell.value === 60)).toBe(true)
    expect(weeks[1]?.cells.filter(cell => cell !== null).every(cell => cell.value === 100)).toBe(true)
    expect(cells(weeks)[0]).toMatchObject({ weekFrom: '2026-02-26', weekTo: '2026-03-01', level: 3 })
    expect(cells(weeks).at(-1)).toMatchObject({ weekFrom: '2026-03-02', weekTo: '2026-03-04', level: 4 })
    // Each distinct week's value is the sum of its original (not cumulative)
    // days: 60 + 100 equals the daily grand total below.
    expect(weeks.reduce((sum, week) => sum + (week.cells.find(cell => cell !== null)?.value ?? 0), 0)).toBe(160)
  })

  it('builds a running total over raw days and leaves the input untouched', () => {
    const before = structuredClone(ROWS)
    const weeks = buildActivityGrid(ROWS, 'cumulative', FROM, TO)
    expect(cells(weeks).map(cell => cell.value)).toEqual([10, 30, 30, 60, 100, 100, 160])
    expect(cells(weeks).map(cell => cell.tokens)).toEqual([10, 20, 0, 30, 40, 0, 60])
    expect(ROWS).toEqual(before)
  })

  it('conserves tokens across daily, weekly, and cumulative readings', () => {
    const daily = cells(buildActivityGrid(ROWS, 'daily', FROM, TO))
    const weeklyWeeks = buildActivityGrid(ROWS, 'weekly', FROM, TO)
    const cumulative = cells(buildActivityGrid(ROWS, 'cumulative', FROM, TO))
    const dailyTotal = daily.reduce((sum, cell) => sum + cell.value, 0)
    const weeklyTotal = weeklyWeeks.reduce((sum, week) => sum + (week.cells.find(cell => cell !== null)?.value ?? 0), 0)
    expect(dailyTotal).toBe(160)
    expect(weeklyTotal).toBe(dailyTotal)
    expect(cumulative.at(-1)?.value).toBe(dailyTotal)
  })

  it('uses the rows first-to-last when unfiltered and handles leap-day boundaries', () => {
    const rows = [dayRow('2028-02-28', 5), dayRow('2028-03-01', 15)]
    const grid = cells(buildActivityGrid(rows))
    expect(grid.map(cell => cell.day)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01'])
    expect(grid.at(-1)?.value).toBe(15)
  })

  it('returns no weeks for empty or inverted ranges', () => {
    expect(buildActivityGrid([])).toEqual([])
    expect(buildActivityGrid(ROWS, 'daily', TO, FROM)).toEqual([])
  })

  it('keeps an all-zero range at level zero', () => {
    const grid = cells(buildActivityGrid([dayRow('2026-01-01', 0), dayRow('2026-01-03', 0)]))
    expect(grid).toHaveLength(3)
    expect(grid.every(cell => cell.level === 0)).toBe(true)
  })
})

describe('activityLevel', () => {
  it('uses zero plus four max-relative non-zero stops with clamped boundaries', () => {
    expect([0, 1, 25, 26, 50, 51, 75, 76, 100, 120].map(value => activityLevel(value, 100)))
      .toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 4])
    expect(activityLevel(10, 0)).toBe(0)
    expect(activityLevel(0, 0)).toBe(0)
  })
})
