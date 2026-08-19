/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B), the cache hit rate, and the cost/rate figures of the
 * pricing layer (wire amounts are RMB; the currency view converts them to
 * the region-picked display currency, ¥ or $). Pure functions only, shared
 * by the section and the trend chart.
 *
 * @module token-usage/client/format
 */
/** One decimal below 10, integer otherwise, trailing `.0` stripped. */
function scale(value) {
    if (value >= 10)
        return String(Math.round(value));
    const oneDecimal = value.toFixed(1);
    return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal;
}
/**
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 10 亿
 * (1e9) — 1 亿 is `100M`, 2.5 亿 is `250M`, 9.5 亿 is `950M` — and `xxB`
 * only from 10 亿 up (B = 10 亿, no fractional-B tier): `1B`, `1.5B`, `3B`.
 * One decimal while the scaled value is below 10, integer otherwise —
 * `950K`, `1.5M`, `950M`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export function formatTokens(count) {
    if (count < 1_000)
        return String(count);
    if (count < 1_000_000)
        return scale(count / 1_000) + 'K';
    if (count < 1_000_000_000)
        return scale(count / 1_000_000) + 'M';
    return scale(count / 1_000_000_000) + 'B';
}
/** Always one decimal (stripped when `.0`), unlike {@link scale}: percentages keep their precision. */
function percent(value) {
    const oneDecimal = value.toFixed(1);
    return oneDecimal.endsWith('.0') ? oneDecimal.slice(0, -2) : oneDecimal;
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
    return `${percent(totals.cacheReadTokens / served * 100)}%`;
}
/** The RMB display view: amounts render as stored. */
const CNY_VIEW = { symbol: '¥', rate: 1 };
/**
 * The display view of one stats summary: USD when the region pick says so
 * (amounts ÷ `usdExchangeRate`, `$` prefix), else RMB as stored.
 * @param summary - the stats payload (its `currency`/`usdExchangeRate` fields).
 * @returns the view the format functions render through.
 */
export function currencyViewOf(summary) {
    return summary.currency === 'USD' ? { symbol: '$', rate: summary.usdExchangeRate } : CNY_VIEW;
}
/**
 * Cost as display text: the view's symbol plus two decimals, following the
 * analyzer's cost formatting (`¥1.25`, `$0.18`). A cost is always shown,
 * never omitted. USD divides the wire's RMB amount by the exchange rate.
 * @param cost - a non-negative cost in ¥ (as carried on the wire).
 * @param view - the display currency view.
 * @returns e.g. `¥1.25`, or `$0.18` under a rate-7 USD view.
 */
export function formatCost(cost, view = CNY_VIEW) {
    return `${view.symbol}${(cost / view.rate).toFixed(2)}`;
}
/**
 * A per-million-token rate as display text, converted through the view:
 * integral rates stay bare (`8`, `$1.14`-style conversion applied first for
 * USD), fractional ones keep up to four decimals with trailing zeros
 * stripped and a two-decimal minimum (`0.50`, `0.25`, `0.025`). The caller
 * appends the `/M` unit and the view's symbol where needed.
 * @param rate - a non-negative rate in ¥ per million tokens.
 * @param view - the display currency view.
 * @returns the display string (symbol-less, converted for USD).
 */
export function formatRate(rate, view = CNY_VIEW) {
    const converted = rate / view.rate;
    if (Number.isInteger(converted))
        return String(converted);
    let s = converted.toFixed(4);
    const dot = s.indexOf('.');
    s = s.replace(/0+$/u, '');
    if (s.endsWith('.'))
        s += '00';
    const minEnd = dot + 3;
    while (s.length < minEnd)
        s += '0';
    return s;
}
/**
 * A per-million-token rate as complete display text: the view's symbol plus
 * {@link formatRate}'s converted number — what the pricing table cells render.
 * @param rate - a non-negative rate in ¥ per million tokens.
 * @param view - the display currency view.
 * @returns e.g. `¥8`, or `$1.1429` under a rate-7 USD view.
 */
export function formatRateWithSymbol(rate, view = CNY_VIEW) {
    return `${view.symbol}${formatRate(rate, view)}`;
}
//# sourceMappingURL=format.js.map