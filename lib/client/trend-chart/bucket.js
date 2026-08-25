/**
 * Trend-chart bucket folding and temporal x scaling (browser half).
 * Folding lives in the shared `trend-bucket` module so the host route can
 * downsample the request series onto the wire; this file re-exports it and
 * keeps the SVG-only `scaleToSpan`.
 *
 * @module token-usage/client/trend-chart/bucket
 */
export { MAX_BUCKETS, bucketSeries, bucketWidth, pointsOfBuckets } from "../../trend-bucket.js";
/**
 * Scale one wall time into an x offset across the series' actual span —
 * the first and last points pin the axis ends, and everything in between
 * lands at its real proportion of that span (a 55-request session
 * spreads across the full width, a burst inside one minute bunches up).
 * @param firstTime - the series' first record time.
 * @param lastTime - the series' last record time.
 * @param time - the record's wall time.
 * @param innerWidth - the plottable width in pixels.
 * @returns the x offset from the left edge; the center when every record
 * shares one timestamp (a zero span cannot scale).
 */
export function scaleToSpan(firstTime, lastTime, time, innerWidth) {
    const span = lastTime - firstTime;
    if (span <= 0)
        return innerWidth / 2;
    return (time - firstTime) / span * innerWidth;
}
//# sourceMappingURL=bucket.js.map