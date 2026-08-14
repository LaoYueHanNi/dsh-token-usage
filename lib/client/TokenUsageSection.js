import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the total-usage strip — requests / total tokens
 * / cache hit rate on one row, the four token buckets on the next. Token
 * counts are abbreviated (K below 1M, M below 亿, B at 亿+); the page owns no
 * store because nothing outside it reads the summary, and a manual refresh
 * re-fetches after new requests land.
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
/**
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 1 亿
 * (1e8), `xxB` from 1 亿 up with B = 10 亿 (1e9) — 1 亿 is `0.1B`, 3 亿 is
 * `0.3B`, 10 亿 is `1B`, 30 亿 is `3B`. One decimal while the scaled value is
 * below 10, integer otherwise — `950K`, `1.5M`, `50M`, `0.5B`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export function formatTokens(count) {
    if (count < 1_000)
        return String(count);
    if (count < 1_000_000)
        return scale(count / 1_000) + 'K';
    if (count < 100_000_000)
        return scale(count / 1_000_000) + 'M';
    return scale(count / 1_000_000_000) + 'B';
}
/** One decimal below 10, integer otherwise, trailing `.0` stripped. */
function scale(value) {
    if (value >= 10)
        return String(Math.round(value));
    const oneDecimal = value.toFixed(1);
    return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal;
}
/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
export function totalTokens(totals) {
    return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}
/**
 * Cache hit rate as display text: cache reads over served input
 * (missed input + cache reads). `—` when nothing was served.
 * @param totals - the aggregated totals.
 * @returns e.g. `87.5%`, or `—` for an empty denominator.
 */
export function formatHitRate(totals) {
    const served = totals.inputTokens + totals.cacheReadTokens;
    if (served === 0)
        return '—';
    return `${scale(totals.cacheReadTokens / served * 100)}%`;
}
/** One card in a metric row. */
function StatCard({ label, value }) {
    return (_jsxs("div", { className: styles['card'], children: [_jsx("span", { className: styles['cardLabel'], children: label }), _jsx("span", { className: styles['cardValue'], children: value })] }));
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
    const { total } = state.summary;
    return (_jsxs("div", { className: styles['section'], children: [_jsxs("div", { className: styles['head'], children: [_jsx("h2", { className: styles['title'], children: "Token \u7528\u91CF" }), _jsx("button", { type: "button", className: styles['button'], onClick: refresh, children: "\u5237\u65B0" })] }), _jsxs("p", { className: styles['muted'], children: ["\u6570\u636E\u76EE\u5F55\uFF1A", state.summary.dataDir] }), total.requests === 0
                ? _jsx("p", { className: styles['empty'], children: "\u6682\u65E0\u8BB0\u5F55\u3002\u6A21\u578B\u8BF7\u6C42\u6210\u529F\u540E\u4F1A\u81EA\u52A8\u5199\u5165\uFF0C\u5386\u53F2\u8BB0\u5F55\u53EF\u901A\u8FC7\u547D\u4EE4\u9762\u677F\u7684 /token-usage-sync \u8865\u9F50\u3002" })
                : (_jsxs(_Fragment, { children: [_jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: "\u8BF7\u6C42\u6570", value: total.requests.toLocaleString() }), _jsx(StatCard, { label: "\u603B token", value: formatTokens(totalTokens(total)) }), _jsx(StatCard, { label: "\u7F13\u5B58\u547D\u4E2D\u7387", value: formatHitRate(total) })] }), _jsxs("div", { className: styles['cards'], children: [_jsx(StatCard, { label: "\u8F93\u5165", value: formatTokens(total.inputTokens) }), _jsx(StatCard, { label: "\u8F93\u51FA", value: formatTokens(total.outputTokens) }), _jsx(StatCard, { label: "\u7F13\u5B58\u8BFB", value: formatTokens(total.cacheReadTokens) }), _jsx(StatCard, { label: "\u7F13\u5B58\u5199", value: formatTokens(total.cacheWriteTokens) })] })] }))] }));
}
//# sourceMappingURL=TokenUsageSection.js.map