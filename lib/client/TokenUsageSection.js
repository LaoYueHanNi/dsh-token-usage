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
/** The filter bar: quick range select, day range, model select — one row. */
function FilterBar({ filters, models, onChange, t }) {
    // 'custom' when the day inputs no longer hold one of the quick ranges.
    const quickValue = QUICK_DAYS.find(days => isQuickActive(days, filters)) ?? 'custom';
    return (_jsxs("div", { className: styles['filters'], children: [_jsxs("select", { "aria-label": t('filter.quickRange'), className: styles['control'], value: quickValue, onChange: event => {
                    const days = Number(event.target.value);
                    if (days > 0)
                        onChange({ ...filters, ...quickRange(days) });
                }, children: [_jsx("option", { value: "1", children: "1d" }), _jsx("option", { value: "7", children: "7d" }), _jsx("option", { value: "30", children: "30d" }), _jsx("option", { value: "custom", children: t('filter.custom') })] }), _jsx("input", { type: "date", "aria-label": t('filter.from'), className: styles['dateControl'], value: filters.from, onChange: event => onChange({ ...filters, from: event.target.value }) }), _jsx("span", { className: styles['rangeSeparator'], children: t('filter.separator') }), _jsx("input", { type: "date", "aria-label": t('filter.to'), className: styles['dateControl'], value: filters.to, onChange: event => onChange({ ...filters, to: event.target.value }) }), _jsxs("select", { "aria-label": t('filter.model'), className: styles['modelControl'], value: filters.model, onChange: event => onChange({ ...filters, model: event.target.value }), children: [_jsx("option", { value: "", children: t('filter.allModels') }), models.map(model => _jsx("option", { value: model, children: model }, model))] })] }));
}
/**
 * Render the Token Usage section content column. The `t` seat arrives from
 * the registration's `locale:` declaration and follows the active locale.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel) plus the framework-injected translate seat.
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection({ t }) {
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
        return (_jsxs("div", { className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: t('nav.label') }), _jsx("p", { className: styles['muted'], children: t('loading') })] }));
    }
    if (state.status === 'error') {
        return (_jsxs("div", { className: styles['section'], children: [_jsxs("div", { className: styles['head'], children: [_jsx("h2", { className: styles['title'], children: t('nav.label') }), _jsx("button", { type: "button", className: styles['button'], onClick: retry, children: t('retry') })] }), _jsx("p", { className: styles['error'], children: t('loadFailed', { message: state.message }) })] }));
    }
    const { total } = state.summary;
    return (_jsxs("div", { className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: t('nav.label') }), _jsx("p", { className: styles['muted'], children: t('dataDir', { path: state.summary.dataDir }) }), _jsx(FilterBar, { filters: filters, models: models, onChange: setFilters, t: t }), total.requests === 0
                ? (
                // One hint covers both an empty log and an empty filtered window:
                // the page opens on today (1d), so the two are indistinguishable
                // from the filtered response alone.
                _jsx("p", { className: styles['empty'], children: t('empty') }))
                : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: t('stat.requests'), value: total.requests.toLocaleString() }), _jsx(StatCard, { label: t('stat.totalTokens'), value: formatTokens(totalTokens(total)) }), _jsx(StatCard, { label: t('stat.hitRate'), value: formatHitRate(total) })] }), _jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: t('stat.input'), value: formatTokens(total.inputTokens) }), _jsx(StatCard, { label: t('stat.output'), value: formatTokens(total.outputTokens) }), _jsx(StatCard, { label: t('stat.cacheRead'), value: formatTokens(total.cacheReadTokens) }), _jsx(StatCard, { label: t('stat.cacheWrite'), value: formatTokens(total.cacheWriteTokens) })] }), _jsx(TrendChart, { rows: state.summary.byDay, t: t, ...filters.from !== '' ? { from: filters.from } : {}, ...filters.to !== '' ? { to: filters.to } : {} }), state.summary.byModel.length > 0
                            ? (_jsxs(_Fragment, { children: [_jsx("h3", { className: styles['subtitle'], children: t('byModel.title') }), _jsxs("table", { className: styles['table'], children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: t('filter.model') }), _jsx("th", { children: t('stat.requests') }), _jsx("th", { children: t('stat.totalTokens') }), _jsx("th", { children: t('stat.input') }), _jsx("th", { children: t('stat.output') }), _jsx("th", { children: t('stat.cacheRead') }), _jsx("th", { children: t('stat.cacheWrite') }), _jsx("th", { children: t('stat.hitRate') })] }) }), _jsx("tbody", { children: state.summary.byModel.map(row => (_jsxs("tr", { children: [_jsx("td", { children: row.model }), _jsx("td", { children: row.totals.requests.toLocaleString() }), _jsx("td", { children: formatTokens(totalTokens(row.totals)) }), _jsx("td", { children: formatTokens(row.totals.inputTokens) }), _jsx("td", { children: formatTokens(row.totals.outputTokens) }), _jsx("td", { children: formatTokens(row.totals.cacheReadTokens) }), _jsx("td", { children: formatTokens(row.totals.cacheWriteTokens) }), _jsx("td", { children: formatHitRate(row.totals) })] }, row.model))) })] })] }))
                            : null] }))] }));
}
//# sourceMappingURL=TokenUsageSection.js.map