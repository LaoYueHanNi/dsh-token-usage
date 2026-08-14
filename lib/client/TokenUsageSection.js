import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the filter bar (inclusive day range, model
 * select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
 * total-usage strip, the daily-token trend chart, and the per-model detail
 * table with the hit rate last — all following the active filters. There is
 * no refresh button: entering the page or changing a filter refetches (the
 * route answers no-store); only the error state keeps a retry.
 *
 * @module token-usage/client/TokenUsageSection
 */
import { useCallback, useEffect, useState } from 'react';
import { STATS_PATH } from "../wire.js";
import { shiftedDayKey, totalTokens } from "./day.js";
import { formatHitRate, formatTokens } from "./format.js";
import { TrendChart } from "./TrendChart.js";
import styles from './TokenUsageSection.module.css';
// Re-exported for tests and sibling consumers; the implementations live in
// the leaf modules (day / format) so the chart can share them without a cycle.
export { totalTokens } from "./day.js";
export { formatTokens, formatHitRate } from "./format.js";
/** Fetch the summary for one query string; the caller owns the failure presentation. */
async function fetchSummary(query) {
    const response = await fetch(STATS_PATH + query);
    if (!response.ok)
        throw new Error(`HTTP ${String(response.status)}`);
    const value = (await response.json());
    if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
        throw new Error('unexpected stats response');
    }
    return value;
}
/**
 * The query string of one filter selection ('' when unconstrained), or null
 * while the range is mid-edit (`from > to`): editing the two date inputs
 * one at a time passes through inverted ranges, and fetching those would
 * only flash an HTTP 400 — the request waits until the range settles.
 */
function filterQuery(filters) {
    if (filters.from !== '' && filters.to !== '' && filters.from > filters.to)
        return null;
    const params = new URLSearchParams();
    if (filters.from !== '')
        params.set('from', filters.from);
    if (filters.to !== '')
        params.set('to', filters.to);
    if (filters.model !== '')
        params.set('model', filters.model);
    return Array.from(params).length > 0 ? `?${params.toString()}` : '';
}
/** Quick-range day span in days (1 = today only, inclusive on both ends). */
const QUICK_DAYS = [1, 7, 30];
/** The day keys of one quick range: today minus (days - 1) through today. */
function quickRange(days) {
    return { from: shiftedDayKey(-(days - 1)), to: shiftedDayKey(0) };
}
/** Whether the filters exactly hold one quick range. */
function isQuickActive(days, filters) {
    const range = quickRange(days);
    return filters.from === range.from && filters.to === range.to;
}
/** One card in a metric row. */
function StatCard({ label, value }) {
    return (_jsxs("div", { className: styles['card'], children: [_jsx("span", { className: styles['cardLabel'], children: label }), _jsx("span", { className: styles['cardValue'], children: value })] }));
}
/** The filter bar: date range, model select, quick range buttons. */
function FilterBar({ filters, models, onChange }) {
    return (_jsxs("div", { className: styles['filters'], children: [_jsx("input", { type: "date", "aria-label": "\u5F00\u59CB\u65E5\u671F", className: styles['control'], value: filters.from, onChange: event => onChange({ ...filters, from: event.target.value }) }), _jsx("span", { className: styles['rangeSeparator'], children: "\u81F3" }), _jsx("input", { type: "date", "aria-label": "\u7ED3\u675F\u65E5\u671F", className: styles['control'], value: filters.to, onChange: event => onChange({ ...filters, to: event.target.value }) }), _jsxs("select", { "aria-label": "\u6A21\u578B", className: styles['control'], value: filters.model, onChange: event => onChange({ ...filters, model: event.target.value }), children: [_jsx("option", { value: "", children: "\u5168\u90E8\u6A21\u578B" }), models.map(model => _jsx("option", { value: model, children: model }, model))] }), _jsx("div", { className: styles['quickButtons'], children: QUICK_DAYS.map(days => (_jsx("button", { type: "button", className: styles['button'], "aria-pressed": isQuickActive(days, filters), onClick: () => onChange({ ...filters, ...quickRange(days) }), children: `${String(days)}d` }, days))) })] }));
}
/**
 * Render the Token 用量 section content column.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel).
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection(_props) {
    const [state, setState] = useState({ status: 'loading' });
    // Entering the page starts on today's window (the 1d quick range).
    const [filters, setFilters] = useState(() => ({ model: '', ...quickRange(1) }));
    const [models, setModels] = useState([]);
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => { setAttempt(previous => previous + 1); }, []);
    useEffect(() => {
        const query = filterQuery(filters);
        // A mid-edit inverted range keeps the current data until it settles.
        if (query === null)
            return;
        let cancelled = false;
        setState({ status: 'loading' });
        void fetchSummary(query)
            .then((summary) => {
            if (cancelled)
                return;
            setState({ status: 'ready', summary });
            // While every model is shown, keep the option list from collapsing
            // to the filtered selection.
            if (filters.model === '')
                setModels(summary.byModel.map(row => row.model));
        })
            .catch((error) => {
            if (!cancelled) {
                setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
            }
        });
        return () => { cancelled = true; };
    }, [filters, attempt]);
    if (state.status === 'loading') {
        return (_jsxs("div", { className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsx("p", { className: styles['muted'], children: "\u52A0\u8F7D\u4E2D\u2026" })] }));
    }
    if (state.status === 'error') {
        return (_jsxs("div", { className: styles['section'], children: [_jsxs("div", { className: styles['head'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsx("button", { type: "button", className: styles['button'], onClick: retry, children: "\u91CD\u8BD5" })] }), _jsxs("p", { className: styles['error'], children: ["\u7EDF\u8BA1\u52A0\u8F7D\u5931\u8D25\uFF1A", state.message] })] }));
    }
    const { total } = state.summary;
    return (_jsxs("div", { className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsxs("p", { className: styles['muted'], children: ["\u6570\u636E\u76EE\u5F55\uFF1A", state.summary.dataDir] }), _jsx(FilterBar, { filters: filters, models: models, onChange: setFilters }), total.requests === 0
                ? (
                // One hint covers both an empty log and an empty filtered window:
                // the page opens on today (1d), so the two are indistinguishable
                // from the filtered response alone.
                _jsx("p", { className: styles['empty'], children: "\u6682\u65E0\u6570\u636E\u3002\u53EF\u8C03\u6574\u7B5B\u9009\u6761\u4EF6\uFF1B\u6A21\u578B\u8BF7\u6C42\u6210\u529F\u540E\u4F1A\u81EA\u52A8\u5199\u5165\uFF0C\u5386\u53F2\u8BB0\u5F55\u53EF\u901A\u8FC7\u547D\u4EE4\u9762\u677F\u7684 /token-usage-sync \u8865\u9F50\u3002" }))
                : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: "\u8BF7\u6C42\u6570", value: total.requests.toLocaleString() }), _jsx(StatCard, { label: "\u603B token", value: formatTokens(totalTokens(total)) }), _jsx(StatCard, { label: "\u7F13\u5B58\u547D\u4E2D\u7387", value: formatHitRate(total) })] }), _jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: "\u8F93\u5165", value: formatTokens(total.inputTokens) }), _jsx(StatCard, { label: "\u8F93\u51FA", value: formatTokens(total.outputTokens) }), _jsx(StatCard, { label: "\u7F13\u5B58\u8BFB", value: formatTokens(total.cacheReadTokens) }), _jsx(StatCard, { label: "\u7F13\u5B58\u5199", value: formatTokens(total.cacheWriteTokens) })] }), _jsx(TrendChart, { rows: state.summary.byDay, ...filters.from !== '' ? { from: filters.from } : {}, ...filters.to !== '' ? { to: filters.to } : {} }), state.summary.byModel.length > 0
                            ? (_jsxs(_Fragment, { children: [_jsx("h3", { className: styles['subtitle'], children: "\u6309\u6A21\u578B" }), _jsxs("table", { className: styles['table'], children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6A21\u578B" }), _jsx("th", { children: "\u8BF7\u6C42\u6570" }), _jsx("th", { children: "\u603B token" }), _jsx("th", { children: "\u8F93\u5165" }), _jsx("th", { children: "\u8F93\u51FA" }), _jsx("th", { children: "\u7F13\u5B58\u8BFB" }), _jsx("th", { children: "\u7F13\u5B58\u5199" }), _jsx("th", { children: "\u547D\u4E2D\u7387" })] }) }), _jsx("tbody", { children: state.summary.byModel.map(row => (_jsxs("tr", { children: [_jsx("td", { children: row.model }), _jsx("td", { children: row.totals.requests.toLocaleString() }), _jsx("td", { children: formatTokens(totalTokens(row.totals)) }), _jsx("td", { children: formatTokens(row.totals.inputTokens) }), _jsx("td", { children: formatTokens(row.totals.outputTokens) }), _jsx("td", { children: formatTokens(row.totals.cacheReadTokens) }), _jsx("td", { children: formatTokens(row.totals.cacheWriteTokens) }), _jsx("td", { children: formatHitRate(row.totals) })] }, row.model))) })] })] }))
                            : null] }))] }));
}
//# sourceMappingURL=TokenUsageSection.js.map