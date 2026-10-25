/**
 * Calendar-grid projection of the filtered daily token rows. The grid is
 * Monday-first, seven rows per week, and zero-fills the same inclusive range
 * as the line chart. Daily, whole-week, and running-total readings share the
 * exact same cells so switching modes never changes the calendar geometry.
 *
 * @module token-usage/client/activity-grid
 */

import type { UsageDayRow } from '../wire.ts'
import { dayKeyOf, daySeries } from './day.ts'

/** The three readings exposed by the activity view. */
export type ActivityMode = 'daily' | 'weekly' | 'cumulative'

/** One real day in the activity grid. */
export interface ActivityCell {
  day: string
  /** This day's own total, retained for daily tooltips and tests. */
  tokens: number
  /** The active reading: day total, containing-week total, or running total. */
  value: number
  /** First/last included day of this cell's week (clamped to the filter). */
  weekFrom: string
  weekTo: string
  /** Five theme-driven color stops: zero plus four non-zero intensities. */
  level: 0 | 1 | 2 | 3 | 4
}

/** One calendar week column; null cells align partial first/last weeks. */
export interface ActivityWeek {
  /** Monday's local day key, also the React key. */
  key: string
  /** One-based month label shown on the first week and at each month start. */
  month?: number
  cells: Array<ActivityCell | null>
}

interface WeekTotal {
  from: string
  to: string
  tokens: number
}

/** Local date of a day key; string parsing is avoided everywhere else. */
function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00`)
}

/** Monday-first weekday index (Monday 0 … Sunday 6). */
function weekdayOf(day: string): number {
  return (dateOf(day).getDay() + 6) % 7
}

/** Monday key of the week containing one local day. */
function weekKeyOf(day: string): string {
  const cursor = dateOf(day)
  cursor.setDate(cursor.getDate() - weekdayOf(day))
  return dayKeyOf(cursor)
}

/** Quantize a non-negative value against the grid maximum into five stops. */
export function activityLevel(value: number, maximum: number): ActivityCell['level'] {
  if (value <= 0 || maximum <= 0) return 0
  return Math.max(1, Math.min(4, Math.ceil((value / maximum) * 4))) as ActivityCell['level']
}

/**
 * Build the activity calendar over the filtered rows/range. Weekly mode is a
 * whole-week reading of the included days, repeated across that week's cells
 * (a partial week at either filter boundary includes only the filtered days).
 * Cumulative mode is the running total in chronological order.
 */
export function buildActivityGrid(
  rows: readonly UsageDayRow[],
  mode: ActivityMode = 'daily',
  from?: string,
  to?: string,
): ActivityWeek[] {
  const points = daySeries(rows, from, to)
  if (points.length === 0) return []

  const totals = new Map<string, WeekTotal>()
  for (const point of points) {
    const key = weekKeyOf(point.day)
    const current = totals.get(key)
    if (current === undefined) totals.set(key, { from: point.day, to: point.day, tokens: point.tokens })
    else {
      current.to = point.day
      current.tokens += point.tokens
    }
  }

  let cumulative = 0
  const valued = points.map(point => {
    cumulative += point.tokens
    const key = weekKeyOf(point.day)
    const week = totals.get(key)!
    const value = mode === 'weekly' ? week.tokens : mode === 'cumulative' ? cumulative : point.tokens
    return { ...point, key, value, weekFrom: week.from, weekTo: week.to }
  })
  const maximum = Math.max(...valued.map(point => point.value))
  const weeks: ActivityWeek[] = []
  const byKey = new Map<string, ActivityWeek>()

  for (const point of valued) {
    let week = byKey.get(point.key)
    if (week === undefined) {
      week = { key: point.key, cells: Array<ActivityCell | null>(7).fill(null) }
      byKey.set(point.key, week)
      weeks.push(week)
    }
    const weekday = weekdayOf(point.day)
    week.cells[weekday] = {
      day: point.day,
      tokens: point.tokens,
      value: point.value,
      weekFrom: point.weekFrom,
      weekTo: point.weekTo,
      level: activityLevel(point.value, maximum),
    }
    // The first visible column names its month even when the filter starts
    // mid-month; subsequent labels appear at the week containing day 1.
    if (weeks.length === 1 || point.day.endsWith('-01')) {
      week.month = dateOf(point.day).getMonth() + 1
    }
  }
  return weeks
}
