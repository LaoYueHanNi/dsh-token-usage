import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders totals, per-day and per-model tables, and the
 * recent request list. Data arrives through plain fetch into component-local
 * state — the page owns no store because nothing outside it reads the
 * summary; a manual refresh re-fetches after new requests land.
 *
 * @module token-usage/client/TokenUsageSection
 */
import { useCallback, useEffect, useState } from 'react';
import { STATS_PATH } from "../wire.js";
import styles from './TokenUsageSection.module.css';
/** Fetch the summary; the caller owns the failure presentation. */
async function fetchSummary() {
    const response = await fetch(STATS_PATH);
    if (!response.ok)
        throw new Error(`HTTP ${String(response.status)}`);
    const value = (await response.json());
    if (typeof value !== 'object' || value === null || typeof value.total !== 'object') {
        throw new Error('unexpected stats response');
    }
    return value;
}
/** One card in the totals strip. */
function StatCard({ label, value }) {
    return (_jsxs("div", { className: styles['card'], children: [_jsx("span", { className: styles['cardLabel'], children: label }), _jsx("span", { className: styles['cardValue'], children: value.toLocaleString() })] }));
}
/** One totals row of the per-day/per-model tables. */
function TotalsRow({ name, totals }) {
    return (_jsxs("tr", { children: [_jsx("td", { children: name }), _jsx("td", { children: totals.requests.toLocaleString() }), _jsx("td", { children: totals.inputTokens.toLocaleString() }), _jsx("td", { children: totals.outputTokens.toLocaleString() }), _jsx("td", { children: totals.cacheReadTokens.toLocaleString() }), _jsx("td", { children: totals.cacheWriteTokens.toLocaleString() })] }));
}
/** Human summary of one record's token buckets. */
function usageText(record) {
    const usage = record.usage;
    if (usage === undefined)
        return '无用量数据';
    const parts = [`输入 ${usage.inputTokens.toLocaleString()}`, `输出 ${usage.outputTokens.toLocaleString()}`];
    if (usage.cacheReadTokens !== undefined)
        parts.push(`缓存读 ${usage.cacheReadTokens.toLocaleString()}`);
    if (usage.cacheWriteTokens !== undefined)
        parts.push(`缓存写 ${usage.cacheWriteTokens.toLocaleString()}`);
    return parts.join(' · ');
}
/**
 * Render the Token 用量 section content column.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel).
 * @returns the section, one of loading / error / ready.
 */
export function TokenUsageSection(_props) {
    const [state, setState] = useState({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);
    const refresh = useCallback(() => { setAttempt(previous => previous + 1); }, []);
    useEffect(() => {
        let cancelled = false;
        setState({ status: 'loading' });
        void fetchSummary()
            .then((summary) => { if (!cancelled)
            setState({ status: 'ready', summary }); })
            .catch((error) => {
            if (!cancelled) {
                setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
            }
        });
        return () => { cancelled = true; };
    }, [attempt]);
    if (state.status === 'loading') {
        return (_jsxs("div", { className: styles['section'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsx("p", { className: styles['muted'], children: "\u52A0\u8F7D\u4E2D\u2026" })] }));
    }
    if (state.status === 'error') {
        return (_jsxs("div", { className: styles['section'], children: [_jsxs("div", { className: styles['head'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsx("button", { type: "button", className: styles['button'], onClick: refresh, children: "\u91CD\u8BD5" })] }), _jsxs("p", { className: styles['error'], children: ["\u7EDF\u8BA1\u52A0\u8F7D\u5931\u8D25\uFF1A", state.message] })] }));
    }
    const { summary } = state;
    return (_jsxs("div", { className: styles['section'], children: [_jsxs("div", { className: styles['head'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsx("button", { type: "button", className: styles['button'], onClick: refresh, children: "\u5237\u65B0" })] }), _jsxs("p", { className: styles['muted'], children: ["\u6570\u636E\u76EE\u5F55\uFF1A", summary.dataDir] }), summary.total.requests === 0
                ? _jsx("p", { className: styles['empty'], children: "\u6682\u65E0\u8BB0\u5F55\u3002\u6A21\u578B\u8BF7\u6C42\u6210\u529F\u540E\u4F1A\u81EA\u52A8\u5199\u5165\uFF0C\u5386\u53F2\u8BB0\u5F55\u53EF\u901A\u8FC7\u547D\u4EE4\u9762\u677F\u7684 /token-usage-sync \u8865\u9F50\u3002" })
                : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: "\u8BF7\u6C42\u6570", value: summary.total.requests }), _jsx(StatCard, { label: "\u8F93\u5165 tokens", value: summary.total.inputTokens }), _jsx(StatCard, { label: "\u8F93\u51FA tokens", value: summary.total.outputTokens }), _jsx(StatCard, { label: "\u7F13\u5B58\u8BFB tokens", value: summary.total.cacheReadTokens }), _jsx(StatCard, { label: "\u7F13\u5B58\u5199 tokens", value: summary.total.cacheWriteTokens })] }), _jsx("h3", { className: styles['subtitle'], children: "\u6309\u65E5" }), _jsxs("table", { className: styles['table'], children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u65E5\u671F" }), _jsx("th", { children: "\u8BF7\u6C42" }), _jsx("th", { children: "\u8F93\u5165" }), _jsx("th", { children: "\u8F93\u51FA" }), _jsx("th", { children: "\u7F13\u5B58\u8BFB" }), _jsx("th", { children: "\u7F13\u5B58\u5199" })] }) }), _jsx("tbody", { children: summary.byDay.map(row => _jsx(TotalsRow, { name: row.day, totals: row.totals }, row.day)) })] }), _jsx("h3", { className: styles['subtitle'], children: "\u6309\u6A21\u578B" }), _jsxs("table", { className: styles['table'], children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6A21\u578B" }), _jsx("th", { children: "\u8BF7\u6C42" }), _jsx("th", { children: "\u8F93\u5165" }), _jsx("th", { children: "\u8F93\u51FA" }), _jsx("th", { children: "\u7F13\u5B58\u8BFB" }), _jsx("th", { children: "\u7F13\u5B58\u5199" })] }) }), _jsx("tbody", { children: summary.byModel.map(row => _jsx(TotalsRow, { name: row.model, totals: row.totals }, row.model)) })] }), _jsx("h3", { className: styles['subtitle'], children: "\u6700\u8FD1\u8BF7\u6C42" }), _jsx("ul", { className: styles['recent'], children: summary.recent.map(record => (_jsxs("li", { className: styles['recentRow'], children: [_jsx("span", { className: styles['recentTime'], children: new Date(record.time).toLocaleString() }), _jsx("span", { className: styles['recentModel'], children: record.model }), _jsx("span", { className: `${styles['recentUsage']} ${styles['muted']}`, children: usageText(record) })] }, record.requestId))) })] }))] }));
}
//# sourceMappingURL=TokenUsageSection.js.map