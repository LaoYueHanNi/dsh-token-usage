/**
 * Browser-side day vocabulary of the token-usage settings page: local day
 * keys, quick-range arithmetic, and the zero-filled per-day series backing
 * the trend chart. Pure functions only, so the chart and its tests share one
 * implementation.
 *
 * @module token-usage/client/day
 */

import type { UsageDayRow, UsageHourRow, UsageTotals } from '../wire.ts'

/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
export function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/** Local `YYYY-MM-DD` key of a date, matching the host's day-file convention. */
export function dayKeyOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Local day key of today shifted by whole days (test seam on `now`). */
export function shiftedDayKey(deltaDays: number, now: () => Date = () => new Date()): string {
  const date = now()
  date.setDate(date.getDate() + deltaDays)
  return dayKeyOf(date)
}

/** A month the calendar panel shows (month is 0-based like Date). */
export interface MonthView {
  year: number
  month: number
}

/** The month view holding one day key. */
export function monthViewOf(dayKey: string): MonthView {
  return { year: Number(dayKey.slice(0, 4)), month: Number(dayKey.slice(5, 7)) - 1 }
}

/** The month view shifted by whole months (year overflow normalized). */
export function shiftMonth(view: MonthView, deltaMonths: number): MonthView {
  const total = view.year * 12 + view.month + deltaMonths
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

/** One cell of a month grid: a day key plus whether it belongs to the shown month. */
export interface MonthCell {
  day: string
  inMonth: boolean
}

/**
 * The month grid of one month view: Monday-first whole weeks covering the
 * month, so every column aligns under its weekday header. Days of the
 * neighbouring months carry `inMonth: false` — the caller renders them as
 * blank placeholders, keeping the shown month's date texts unique (for
 * tests and screen readers).
 */
export function monthGrid(view: MonthView): MonthCell[] {
  // Local-time constructors only: string parsing would drag UTC offsets in.
  const leading = (new Date(view.year, view.month, 1).getDay() + 6) % 7
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()
  const total = Math.ceil((leading + daysInMonth) / 7) * 7
  const cells: MonthCell[] = []
  for (let index = 0; index < total; index++) {
    const cursor = new Date(view.year, view.month, 1 - leading + index)
    cells.push({
      day: dayKeyOf(cursor),
      inMonth: cursor.getFullYear() === view.year && cursor.getMonth() === view.month,
    })
  }
  return cells
}

/** One plotted day of the trend chart. */
export interface DayPoint {
  day: string
  tokens: number
}

/**
 * The zero-filled daily token series over a day range: every calendar day of
 * the range appears once (days without records plot as zero). Absent bounds
 * fall back to the first/last row day; no rows and no range yield [].
 * @param rows - the (already filtered) per-day rows.
 * @param from - first day key, inclusive.
 * @param to - last day key, inclusive.
 */
export function daySeries(rows: readonly UsageDayRow[], from?: string, to?: string): DayPoint[] {
  const first = from ?? rows[0]?.day
  const last = to ?? (rows.length > 0 ? rows[rows.length - 1]!.day : undefined)
  if (first === undefined || last === undefined || first > last) return []
  const tokens = new Map(rows.map(row => [row.day, totalTokens(row.totals)]))
  const points: DayPoint[] = []
  const cursor = new Date(`${first}T00:00:00`)
  const end = new Date(`${last}T00:00:00`)
  while (cursor <= end) {
    const day = dayKeyOf(cursor)
    points.push({ day, tokens: tokens.get(day) ?? 0 })
    cursor.setDate(cursor.getDate() + 1)
  }
  return points
}

/** One plotted hour of the single-day trend chart. */
export interface HourPoint {
  hour: string
  tokens: number
}

/** Local `YYYY-MM-DDTHH` key of a date, matching the host's hour convention. */
export function hourKeyOf(date: Date): string {
  const hour = String(date.getHours()).padStart(2, '0')
  return `${dayKeyOf(date)}T${hour}`
}

/**
 * The zero-filled hourly token series over a day range: every whole hour of
 * the range appears once (hours without records plot as zero), so a single
 * day yields the full 00:00–23:00 sequence and future hours of today read
 * zero. The per-(hour, model) rows fold by hour. Absent bounds fall back to
 * the first/last row hour; no rows and no range yield [].
 * @param rows - the (already filtered) per-hour × per-model rows.
 * @param from - first day key (`YYYY-MM-DD`), inclusive; the series starts
 * at that day's 00:00.
 * @param to - last day key, inclusive; the series ends at that day's 23:00.
 */
export function hourSeries(rows: readonly UsageHourRow[], from?: string, to?: string): HourPoint[] {
  const first = from !== undefined ? `${from}T00` : rows[0]?.hour
  const last = to !== undefined ? `${to}T23` : rows.length > 0 ? rows[rows.length - 1]!.hour : undefined
  if (first === undefined || last === undefined || first > last) return []
  const tokens = new Map<string, number>()
  for (const row of rows) {
    tokens.set(row.hour, (tokens.get(row.hour) ?? 0) + totalTokens(row.totals))
  }
  const points: HourPoint[] = []
  const cursor = new Date(`${first.slice(0, 10)}T${first.slice(11)}:00:00`)
  const end = new Date(`${last.slice(0, 10)}T${last.slice(11)}:00:00`)
  while (cursor <= end) {
    const hour = hourKeyOf(cursor)
    points.push({ hour, tokens: tokens.get(hour) ?? 0 })
    cursor.setHours(cursor.getHours() + 1)
  }
  return points
}
