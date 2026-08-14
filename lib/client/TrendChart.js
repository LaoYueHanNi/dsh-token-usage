import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { daySeries } from "./day.js";
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
/** X-axis label positions: first, middle, and last day for long ranges. */
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
 * Render the daily token line chart.
 * @param props - the filtered per-day rows plus the active range bounds
 * (absent when unfiltered; the chart then spans first to last row), and the
 * `t` seat for the empty hint and the chart aria-label.
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export function TrendChart({ rows, from, to, t }) {
    const points = daySeries(rows, from, to);
    if (points.length === 0) {
        return _jsx("p", { className: styles.empty, children: t('chart.empty') });
    }
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
    return (_jsxs("svg", { role: "img", "aria-label": t('chart.aria'), viewBox: `0 0 ${WIDTH} ${HEIGHT}`, className: styles.chart, children: [ticks.map(tick => (_jsxs("g", { children: [_jsx("line", { x1: LEFT, y1: y(tick), x2: WIDTH - RIGHT, y2: y(tick), className: styles.grid }), _jsx("text", { x: LEFT - 6, y: y(tick) + 3, textAnchor: "end", className: styles.tick, children: formatTokens(tick) })] }, tick))), _jsx("line", { x1: LEFT, y1: y(0), x2: WIDTH - RIGHT, y2: y(0), className: styles.axis }), _jsx("path", { d: path, className: styles.line }), points.map((point, index) => (_jsx("circle", { cx: x(index), cy: y(point.tokens), r: radius, className: styles.dot }, point.day))), labelIndices(points.length).map(index => (_jsx("text", { x: x(index), y: HEIGHT - 6, textAnchor: index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle', className: styles.tick, children: points[index].day.slice(5) }, index)))] }));
}
//# sourceMappingURL=TrendChart.js.map