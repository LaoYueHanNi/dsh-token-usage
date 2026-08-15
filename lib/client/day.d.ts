/**
 * Browser-side day vocabulary of the token-usage settings page: local day
 * keys, quick-range arithmetic, and the zero-filled per-day series backing
 * the trend chart. Pure functions only, so the chart and its tests share one
 * implementation.
 *
 * @module token-usage/client/day
 */
import type { UsageDayRow, UsageHourRow, UsageTotals } from '../wire.ts';
/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
export declare function totalTokens(totals: UsageTotals): number;
/** Local `YYYY-MM-DD` key of a date, matching the host's day-file convention. */
export declare function dayKeyOf(date: Date): string;
/** Local day key of today shifted by whole days (test seam on `now`). */
export declare function shiftedDayKey(deltaDays: number, now?: () => Date): string;
/** One plotted day of the trend chart. */
export interface DayPoint {
    day: string;
    tokens: number;
}
/**
 * The zero-filled daily token series over a day range: every calendar day of
 * the range appears once (days without records plot as zero). Absent bounds
 * fall back to the first/last row day; no rows and no range yield [].
 * @param rows - the (already filtered) per-day rows.
 * @param from - first day key, inclusive.
 * @param to - last day key, inclusive.
 */
export declare function daySeries(rows: readonly UsageDayRow[], from?: string, to?: string): DayPoint[];
/** One plotted hour of the single-day trend chart. */
export interface HourPoint {
    hour: string;
    tokens: number;
}
/** Local `YYYY-MM-DDTHH` key of a date, matching the host's hour convention. */
export declare function hourKeyOf(date: Date): string;
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
export declare function hourSeries(rows: readonly UsageHourRow[], from?: string, to?: string): HourPoint[];
//# sourceMappingURL=day.d.ts.map