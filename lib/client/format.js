/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B) and the cache hit rate. Pure functions only, shared
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
//# sourceMappingURL=format.js.map