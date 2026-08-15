import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Daily token trend chart (browser half): a dependency-free SVG line chart
 * over the already-filtered summary. Two granularities share one renderer —
 * per-day rows (x axis spans every calendar day of the active range, days
 * without records plot as zero) and per-hour rows (a single-day window plots
 * every whole hour of that day, 00:00–23:00, future hours of today reading
 * zero). The x axis labels first/middle/last points; the y axis grid uses
 * round 1/2/2.5/5 × 10ⁿ steps (K/M/B abbreviated). Hovering (or keyboard-
 * focusing) a point highlights it and floats a label with that point's
 * date/time and total tokens. An empty range renders a placeholder instead
 * of an axis.
 *
 * @module token-usage/client/TrendChart
 */
import { useState } from 'react';
import { daySeries, hourSeries } from "./day.js";
import { formatTokens } from "./format.js";
import styles from './TrendChart.module.css';
/** SVG canvas metrics; the element scales to the section width via viewBox. */
const WIDTH = 800;
const HEIGHT = 190;
const TOP = 12;
const BOTTOM = 16;
const LEFT = 44;
const RIGHT = 16;
const X_LABELS = 22;
/** X-axis label positions: first, middle, and last point for long ranges. */
function labelIndices(length) {
    if (length <= 3)
        return Array.from({ length }, (_, index) => index);
    const middle = Math.floor((length - 1) / 2);
    return [...new Set([0, middle, length - 1])];
}
/** The roundest step from 1/2/2.5/5 × 10ⁿ not below the rough target. */
export function niceStep(rough) {
    const base = 10 ** Math.floor(Math.log10(rough));
    const fraction = rough / base;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * base;
}
/** The y-axis tick values from one step up to the chart top (inclusive). */
function tickValues(max) {
    if (max === 0)
        return { top: 1, ticks: [] };
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let value = step; value < top; value += step)
        ticks.push(value);
    ticks.push(top);
    return { top, ticks };
}
/**
 * Render the daily (or, for a single-day window, hourly) token line chart.
 * @param props - the filtered per-day rows plus the optional per-hour rows
 * (when present the chart plots hours instead of days), the active range
 * bounds (absent when unfiltered; the chart then spans first to last row),
 * and the `t` seat for the empty hint and the chart aria-label.
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export function TrendChart({ rows, hours, from, to, t }) {
    // The hourly series normalizes to the same point shape as the daily one.
    const points = hours !== undefined
        ? hourSeries(hours, from, to).map(point => ({
            key: point.hour,
            // The x axis labels the clock time (HH:00) of each plotted hour.
            label: `${point.hour.slice(11)}:00`,
            // The tooltip and aria labels carry the full date and the hour.
            full: `${point.hour.slice(0, 10)} ${point.hour.slice(11)}:00`,
            tokens: point.tokens,
        }))
        : daySeries(rows, from, to).map(point => ({
            key: point.day,
            // The x axis labels each plotted day as MM-DD.
            label: point.day.slice(5),
            full: point.day,
            tokens: point.tokens,
        }));
    if (points.length === 0) {
        return _jsx("p", { className: styles.empty, children: t('chart.empty') });
    }
    // The label text of one point, shared by its aria-label and the float.
    const pointLabel = (point) => t('chart.pointLabel', { day: point.full, tokens: formatTokens(point.tokens) });
    const max = Math.max(...points.map(point => point.tokens));
    const { top, ticks } = tickValues(max);
    const innerWidth = WIDTH - LEFT - RIGHT;
    const innerHeight = HEIGHT - TOP - BOTTOM - X_LABELS;
    const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
    const x = (index) => LEFT + (points.length > 1 ? index * step : innerWidth / 2);
    const y = (tokens) => TOP + innerHeight - (tokens / top) * innerHeight;
    const path = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.tokens).toFixed(1)}`)
        .join(' ');
    const radius = points.length > 90 ? 1.5 : points.length > 30 ? 2 : 3;
    // The hovered/focused point index (null = none); the label mirrors it.
    const [active, setActive] = useState(null);
    const activePoint = active === null ? null : points[active] ?? null;
    // The hit target around each point spans half the inter-point gap on each
    // side (the full width for a single point), so adjacent hours/days are
    // equally reachable even in wide 30d+ ranges.
    const hitWidth = points.length > 1 ? Math.max(step, 12) : innerWidth;
    return (_jsxs("svg", { role: "img", "aria-label": hours !== undefined ? t('chart.ariaHour') : t('chart.aria'), viewBox: `0 0 ${WIDTH} ${HEIGHT}`, className: styles.chart, onMouseLeave: () => setActive(null), children: [ticks.map(tick => (_jsxs("g", { children: [_jsx("line", { x1: LEFT, y1: y(tick), x2: WIDTH - RIGHT, y2: y(tick), className: styles.grid }), _jsx("text", { x: LEFT - 6, y: y(tick) + 3, textAnchor: "end", className: styles.tick, children: formatTokens(tick) })] }, tick))), _jsx("line", { x1: LEFT, y1: y(0), x2: WIDTH - RIGHT, y2: y(0), className: styles.axis }), _jsx("path", { d: path, className: styles.line }), points.map((point, index) => (_jsx("circle", { cx: x(index), cy: y(point.tokens), r: active === index ? radius + 2.5 : radius, className: active === index ? styles.dotActive : styles.dot }, point.key))), activePoint !== null
                ? (
                // The guide line drops from the active point to the x axis.
                _jsx("line", { x1: x(active), y1: y(activePoint.tokens), x2: x(active), y2: y(0), className: styles.guide }))
                : null, points.map((point, index) => (_jsx("rect", { x: x(index) - hitWidth / 2, y: TOP, width: hitWidth, height: innerHeight, fill: "transparent", "aria-label": pointLabel(point), role: "button", tabIndex: 0, className: styles.hit, onMouseEnter: () => setActive(index), onFocus: () => setActive(index), onBlur: () => setActive(current => current === index ? null : current) }, point.key))), activePoint !== null
                ? (
                // Floating label: kept inside the canvas horizontally (near the
                // edges it flips toward the center), above the point with a
                // ceiling at the canvas top.
                (() => {
                    const label = pointLabel(activePoint);
                    const charWidth = 6.2;
                    const labelWidth = label.length * charWidth + 12;
                    const center = x(active);
                    const left = Math.min(Math.max(center - labelWidth / 2, LEFT), WIDTH - RIGHT - labelWidth);
                    const labelY = Math.max(y(activePoint.tokens) - 12, TOP + 8);
                    return (_jsxs("g", { className: styles.pointLabel, pointerEvents: "none", children: [_jsx("rect", { x: left, y: labelY - 13, width: labelWidth, height: 20, rx: 5 }), _jsx("text", { x: left + labelWidth / 2, y: labelY, textAnchor: "middle", children: label })] }));
                })())
                : null, labelIndices(points.length).map(index => (_jsx("text", { x: x(index), y: HEIGHT - 6, textAnchor: index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle', className: styles.tick, children: points[index].label }, index)))] }));
}
//# sourceMappingURL=TrendChart.js.map