import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { daySeries } from "./day.js";
import styles from './TrendChart.module.css';
/** SVG canvas metrics; the element scales to the section width via viewBox. */
const WIDTH = 800;
const HEIGHT = 190;
const PAD = 16;
const AXIS_LABELS = 22;
/** X-axis label positions: first, middle, and last day for long ranges. */
function labelIndices(length) {
    if (length <= 3)
        return Array.from({ length }, (_, index) => index);
    const middle = Math.floor((length - 1) / 2);
    return [...new Set([0, middle, length - 1])];
}
/**
 * Render the daily token line chart.
 * @param props - the filtered per-day rows plus the active range bounds
 * (absent when unfiltered; the chart then spans first to last row).
 * @returns the SVG chart, or a placeholder for an empty range.
 */
export function TrendChart({ rows, from, to }) {
    const points = daySeries(rows, from, to);
    if (points.length === 0) {
        return _jsx("p", { className: styles.empty, children: "\u533A\u95F4\u5185\u6682\u65E0\u6570\u636E" });
    }
    const max = Math.max(...points.map(point => point.tokens), 1);
    const innerWidth = WIDTH - PAD * 2;
    const innerHeight = HEIGHT - PAD * 2 - AXIS_LABELS;
    const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
    const x = (index) => PAD + (points.length > 1 ? index * step : innerWidth / 2);
    const y = (tokens) => PAD + innerHeight - (tokens / max) * innerHeight;
    const path = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.tokens).toFixed(1)}`)
        .join(' ');
    const radius = points.length > 90 ? 1.5 : points.length > 30 ? 2 : 3;
    return (_jsxs("svg", { role: "img", "aria-label": "\u6BCF\u65E5\u603B token \u66F2\u7EBF", viewBox: `0 0 ${WIDTH} ${HEIGHT}`, className: styles.chart, children: [_jsx("line", { x1: PAD, y1: PAD + innerHeight, x2: WIDTH - PAD, y2: PAD + innerHeight, className: styles.axis }), _jsx("path", { d: path, className: styles.line }), points.map((point, index) => (_jsx("circle", { cx: x(index), cy: y(point.tokens), r: radius, className: styles.dot }, point.day))), labelIndices(points.length).map(index => (_jsx("text", { x: x(index), y: HEIGHT - 6, textAnchor: index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle', className: styles.tick, children: points[index].day.slice(5) }, index)))] }));
}
//# sourceMappingURL=TrendChart.js.map