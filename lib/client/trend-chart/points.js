/**
 * Trend-chart point series: fold the three render-mode inputs (per-day
 * rows, per-hour rows, per-request series) into one discriminated-union
 * series with the mode decided at the top. Pure functions, no React.
 *
 * @module token-usage/client/trend-chart/points
 */
import { daySeries, hourSeries } from "../day.js";
import { bucketSeries } from "./bucket.js";
/** Render-mode priority: request buckets outrank per-hour, which
 * outranks per-day. A session-scoped read passes `requests`; the settings
 * page passes `hours` for a single-day range; everything else plots days. */
export function buildChartPoints(input) {
    if (input.requests !== undefined && input.requests.length > 0) {
        const buckets = bucketsOf(input.requests);
        if (buckets.length > 0) {
            const firstDate = new Date(buckets[0].start).toDateString();
            const lastDate = new Date(buckets[buckets.length - 1].start).toDateString();
            const crossDay = firstDate !== lastDate;
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
            };
        }
    }
    if (input.hours !== undefined) {
        const points = hourSeries(input.hours, input.from, input.to);
        if (points.length > 0) {
            return { mode: 'equidistant', points: points.map(hourToPoint) };
        }
    }
    const points = daySeries(input.rows, input.from, input.to);
    if (points.length > 0) {
        return { mode: 'equidistant', points: points.map(dayToPoint) };
    }
    return null;
}
/** A series that already carries `count` (the host's `fields=session`
 * downsample) is plotted as-is; a raw per-request series is folded here. */
function bucketsOf(requests) {
    if (requests[0]?.count !== undefined) {
        return requests.map(point => ({
            start: point.time,
            end: point.end ?? point.time,
            tokens: point.tokens,
            count: point.count ?? 1,
        }));
    }
    return bucketSeries(requests);
}
function dayToPoint(point) {
    return { key: point.day, label: point.day.slice(5), full: point.day, tokens: point.tokens };
}
function hourToPoint(point) {
    return {
        key: point.hour,
        label: `${point.hour.slice(11)}:00`,
        full: `${point.hour.slice(0, 10)} ${point.hour.slice(11)}:00`,
        tokens: point.tokens,
    };
}
/** Zero-padded HH:mm of one wall time, local-time. */
function clockOf(time) {
    const d = new Date(time);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** The x-axis label of one bucket start: HH:mm within one day,
 * MM-DD HH:mm once the session crosses midnight. */
function bucketLabel(time, crossDay) {
    if (!crossDay)
        return clockOf(time);
    const d = new Date(time);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clockOf(time)}`;
}
//# sourceMappingURL=points.js.map