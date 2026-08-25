import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Daily / hourly / request-bucketed token trend chart (browser half):
 * a dependency-free SVG line chart over the already-filtered summary.
 * The renderer is pure presentation; the bucketing, scaling, and
 * point-shape decisions live in `./trend-chart/*` so each piece can be
 * tested in isolation.
 *
 * Two granularities share one renderer — per-day rows (x axis spans
 * every calendar day of the active range, days without records plot as
 * zero) and per-hour rows (a single-day window plots every whole hour of
 * that day, 00:00–23:00, future hours of today reading zero). The
 * third mode — request buckets — folds the request series into uniformly
 * sized time buckets spanning the session's actual first-to-last window
 * and scales each bucket at its real temporal proportion of the span.
 *
 * Hovering (or keyboard-focusing) a point highlights it and floats a
 * label with that point's date/time and total tokens.
 *
 * @module token-usage/client/TrendChart
 */
import { useState } from 'react';
import { formatTokens } from "./format.js";
import { tickValues } from "./trend-chart/axis.js";
import { buildChartPoints } from "./trend-chart/points.js";
import { dotRadius, labelIndices, scaleSeries } from "./trend-chart/scale.js";
import styles from './TrendChart.module.css';
/** Re-export the chart's pure helpers for the test suite. */
export { MAX_BUCKETS, bucketSeries, bucketWidth, buildChartPoints, dotRadius, labelIndices, niceStep, scaleSeries, scaleToSpan, tickValues, } from "./trend-chart/index.js";
/** SVG canvas metrics; the element scales to the section width via viewBox. */
const WIDTH = 800;
const HEIGHT = 190;
const TOP = 12;
const BOTTOM = 16;
const LEFT = 44;
const RIGHT = 16;
const X_LABELS = 22;
const HIT_TARGET_FLOOR = 6;
/**
 * Apply the `t`-based localisation to a point's `full` tooltip. The pre-shape
 * labels live in points.ts; the chart's aria-label and the floating tooltip
 * both use this single source so the two stay consistent.
 * @param t - the locale seat.
 * @param point - the pre-shaped point.
 * @returns the tooltip / aria-label text.
 */
function tipOf(t, point) {
    if (point.time !== undefined) {
        return t('chart.bucket', {
            window: point.full,
            count: String(point.count ?? 0),
            tokens: formatTokens(point.tokens),
        });
    }
    return t('chart.pointLabel', { day: point.full, tokens: formatTokens(point.tokens) });
}
/**
 * Render the daily / hourly / request-bucketed token line chart. Pure
 * presentation: every data-driven decision (bucketing, axis scaling,
 * point ordering) lives in `./trend-chart/*`; this component picks the
 * right `chartAria` string for screen readers and forwards hover /
 * focus state to the dot + label.
 *
 * Empty ranges (no data on any branch) render a placeholder instead of an
 * axis so the layout does not collapse to an empty SVG.
 *
 * @param props - the filtered per-day rows plus the optional per-hour rows
 * (when present the chart plots hours instead of days), the optional
 * per-request series (session-scoped reads), the active range bounds
 * (absent when unfiltered; the chart then spans first to last row), and
 * the `t` seat for the empty hint and chart aria-label.
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export function TrendChart({ rows, hours, requests, from, to, t }) {
    const series = buildChartPoints({ rows, hours, requests, from, to });
    if (series === null) {
        return _jsx("p", { className: styles.empty, children: t('chart.empty') });
    }
    // Materialise the points (and apply t() through `tipOf` at render time).
    const points = series.points.map(point => ({
        key: point.key,
        label: point.label,
        full: point.full,
        tokens: point.tokens,
        time: 'time' in point ? point.time : undefined,
        count: 'count' in point ? point.count : undefined,
    }));
    const { top, ticks } = tickValues(Math.max(...points.map(p => p.tokens)));
    const innerHeight = HEIGHT - TOP - BOTTOM - X_LABELS;
    // scaleSeries returns absolute viewBox coordinates already offset by LEFT,
    // so the dots / path / x-axis labels can plug xs[i] straight into the
    // SVG `cx`/`x` attributes without re-adding the y-axis margin.
    const { xs, innerWidth } = scaleSeries(series, LEFT, WIDTH - RIGHT);
    const radius = dotRadius(points.length);
    const [active, setActive] = useState(null);
    const activePoint = active === null ? null : points[active] ?? null;
    const y = (tokens) => TOP + innerHeight - (tokens / top) * innerHeight;
    const path = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${xs[index].toFixed(1)},${y(point.tokens).toFixed(1)}`)
        .join(' ');
    const chartAria = series.mode === 'temporal'
        ? t('chart.ariaRequests')
        : hours !== undefined ? t('chart.ariaHour') : t('chart.aria');
    // The hit target around each point spans to the midpoint of each
    // neighbour (the full width for a single point), with a floor so
    // bunched-up request-mode points stay individually reachable — no
    // fixed grid width survives a temporal scale.
    const hitExtent = (index) => {
        if (points.length === 1)
            return { start: LEFT, width: innerWidth };
        const center = xs[index];
        const before = index === 0 ? undefined : xs[index - 1];
        const after = index === points.length - 1 ? undefined : xs[index + 1];
        const toPrev = before === undefined ? innerWidth : (center - before) / 2;
        const toNext = after === undefined ? innerWidth : (after - center) / 2;
        const half = Math.max(Math.min(toPrev, toNext), HIT_TARGET_FLOOR);
        return { start: center - half, width: half * 2 };
    };
    return (_jsxs("svg", { role: "img", "aria-label": chartAria, viewBox: `0 0 ${WIDTH} ${HEIGHT}`, className: styles.chart, onMouseLeave: () => setActive(null), children: [ticks.map(tick => (_jsxs("g", { children: [_jsx("line", { x1: LEFT, y1: y(tick), x2: WIDTH - RIGHT, y2: y(tick), className: styles.grid }), _jsx("text", { x: LEFT - 6, y: y(tick) + 3, textAnchor: "end", className: styles.tick, children: formatTokens(tick) })] }, tick))), _jsx("line", { x1: LEFT, y1: y(0), x2: WIDTH - RIGHT, y2: y(0), className: styles.axis }), _jsx("path", { d: path, className: styles.line }), points.map((point, index) => (_jsx("circle", { cx: xs[index], cy: y(point.tokens), r: active === index ? radius + 2.5 : radius, className: active === index ? styles.dotActive : styles.dot }, point.key))), activePoint !== null
                ? (
                // The guide line drops from the active point to the x axis.
                _jsx("line", { x1: xs[active], y1: y(activePoint.tokens), x2: xs[active], y2: y(0), className: styles.guide }))
                : null, points.map((point, index) => {
                const hit = hitExtent(index);
                return (_jsx("rect", { x: hit.start, y: TOP, width: hit.width, height: innerHeight, fill: "transparent", "aria-label": tipOf(t, point), role: "button", tabIndex: 0, className: styles.hit, onMouseEnter: () => setActive(index), onFocus: () => setActive(index), onBlur: () => setActive(current => current === index ? null : current) }, point.key));
            }), activePoint !== null
                ? (() => {
                    // Floating label: kept inside the canvas horizontally (near
                    // the edges it flips toward the center), above the point with
                    // a ceiling at the canvas top.
                    const label = tipOf(t, activePoint);
                    const charWidth = 6.2;
                    const labelWidth = label.length * charWidth + 12;
                    const center = xs[active];
                    const left = Math.min(Math.max(center - labelWidth / 2, LEFT), WIDTH - RIGHT - labelWidth);
                    const labelY = Math.max(y(activePoint.tokens) - 12, TOP + 8);
                    return (_jsxs("g", { className: styles.pointLabel, pointerEvents: "none", children: [_jsx("rect", { x: left, y: labelY - 13, width: labelWidth, height: 20, rx: 5 }), _jsx("text", { x: left + labelWidth / 2, y: labelY, textAnchor: "middle", children: label })] }));
                })()
                : null, labelIndices(points.length).map(index => (_jsx("text", { x: xs[index], y: HEIGHT - 6, textAnchor: index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle', className: styles.tick, children: points[index].label }, index)))] }));
}
//# sourceMappingURL=TrendChart.js.map