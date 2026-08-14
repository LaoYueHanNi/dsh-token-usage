/**
 * Browser-side day vocabulary of the token-usage settings page: local day
 * keys, quick-range arithmetic, and the zero-filled per-day series backing
 * the trend chart. Pure functions only, so the chart and its tests share one
 * implementation.
 *
 * @module token-usage/client/day
 */
/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
export function totalTokens(totals) {
    return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}
/** Local `YYYY-MM-DD` key of a date, matching the host's day-file convention. */
export function dayKeyOf(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/** Local day key of today shifted by whole days (test seam on `now`). */
export function shiftedDayKey(deltaDays, now = () => new Date()) {
    const date = now();
    date.setDate(date.getDate() + deltaDays);
    return dayKeyOf(date);
}
/**
 * The zero-filled daily token series over a day range: every calendar day of
 * the range appears once (days without records plot as zero). Absent bounds
 * fall back to the first/last row day; no rows and no range yield [].
 * @param rows - the (already filtered) per-day rows.
 * @param from - first day key, inclusive.
 * @param to - last day key, inclusive.
 */
export function daySeries(rows, from, to) {
    const first = from ?? rows[0]?.day;
    const last = to ?? (rows.length > 0 ? rows[rows.length - 1].day : undefined);
    if (first === undefined || last === undefined || first > last)
        return [];
    const tokens = new Map(rows.map(row => [row.day, totalTokens(row.totals)]));
    const points = [];
    const cursor = new Date(`${first}T00:00:00`);
    const end = new Date(`${last}T00:00:00`);
    while (cursor <= end) {
        const day = dayKeyOf(cursor);
        points.push({ day, tokens: tokens.get(day) ?? 0 });
        cursor.setDate(cursor.getDate() + 1);
    }
    return points;
}
//# sourceMappingURL=day.js.map