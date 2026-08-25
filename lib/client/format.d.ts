/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B), the cache hit rate, and the cost/rate figures of the
 * pricing layer (wire amounts are RMB; the currency view converts them to
 * the region-picked display currency, ¥ or $). Pure functions only, shared
 * by the section and the trend chart.
 *
 * @module token-usage/client/format
 */
import type { UsageSummary, UsageTotals } from '../wire.ts';
/**
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 10 亿
 * (1e9) — 1 亿 is `100M`, 2.5 亿 is `250M`, 9.5 亿 is `950M` — and `xxB`
 * only from 10 亿 up (B = 10 亿, no fractional-B tier): `1B`, `1.5B`, `3B`.
 * One decimal while the scaled value is below 10, integer otherwise —
 * `950K`, `1.5M`, `950M`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export declare function formatTokens(count: number): string;
/**
 * Cache hit rate as display text: cache reads over served input
 * (missed input + cache reads). `—` when nothing was served.
 * @param totals - the aggregated totals.
 * @returns e.g. `87.5%`, or `—` for an empty denominator.
 */
export declare function formatHitRate(totals: UsageTotals): string;
/**
 * The threshold bucket the chip color picks from. Four levels (worst →
 * best) along one warm→cool traffic-light arc:
 *   <60%  `critical` (red)
 *   60–80% `amber`   (orange-yellow — "needs attention")
 *   80–95% `lime`    (yellow-green — "almost there")
 *   ≥95%  `healthy` (green)
 *
 * Violet/teal were tried earlier to dodge the cost cell's warn accent,
 * but they sit on opposite sides of the hue wheel so the middle two
 * stops never read as a progression. Cost figures are now uncolored,
 * so the classic red→amber→lime→green scale is free again.
 *
 * The empty-denominator path lands in `amber` so a brand-new session
 * neither alarms (`critical`) nor celebrates (`healthy`).
 */
export type HitRateBand = 'critical' | 'amber' | 'lime' | 'healthy';
/** Map a 0-1 fraction to one of the four chip color buckets. */
export declare function bandOf(hitRate: number): HitRateBand;
/** Cache hit rate broken out into a display shape: the text the user sees
 * plus the color bucket the UI maps onto it. Sessions with no served input
 * read `—` in the `amber` bucket so a fresh session never paints cold. */
export interface HitRateDisplay {
    text: string;
    band: HitRateBand;
}
/**
 * Compute the cache hit rate's display shape in one pass.
 * @param totals - the aggregated totals.
 * @returns `{ text, band }` — `text` is `—` for an empty denominator,
 * `band` defaults to `amber` so an unused session reads as a mild
 * "no signal yet" (neither alarming nor celebratory).
 */
export declare function hitRateDisplay(totals: UsageTotals): HitRateDisplay;
/**
 * How cost figures render: the symbol plus, for USD, the RMB-per-USD
 * divisor every wire amount (always RMB) divides by for display.
 */
export interface CurrencyView {
    symbol: '¥' | '$';
    /** RMB per USD; 1 in the CNY view (amounts pass through untouched). */
    rate: number;
}
/**
 * The display view of one stats summary: USD when the region pick says so
 * (amounts ÷ `usdExchangeRate`, `$` prefix), else RMB as stored.
 * @param summary - the stats payload (its `currency`/`usdExchangeRate` fields).
 * @returns the view the format functions render through.
 */
export declare function currencyViewOf(summary: Pick<UsageSummary, 'currency' | 'usdExchangeRate'>): CurrencyView;
/**
 * Cost as display text: the view's symbol plus two decimals, following the
 * analyzer's cost formatting (`¥1.25`, `$0.18`). A cost is always shown,
 * never omitted. USD divides the wire's RMB amount by the exchange rate.
 * @param cost - a non-negative cost in ¥ (as carried on the wire).
 * @param view - the display currency view.
 * @returns e.g. `¥1.25`, or `$0.18` under a rate-7 USD view.
 */
export declare function formatCost(cost: number, view?: CurrencyView): string;
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
export declare function formatRate(rate: number, view?: CurrencyView): string;
/**
 * A per-million-token rate as complete display text: the view's symbol plus
 * {@link formatRate}'s converted number — what the pricing table cells render.
 * @param rate - a non-negative rate in ¥ per million tokens.
 * @param view - the display currency view.
 * @returns e.g. `¥8`, or `$1.1429` under a rate-7 USD view.
 */
export declare function formatRateWithSymbol(rate: number, view?: CurrencyView): string;
/**
 * Average first-token latency in the shell's compact duration shape:
 * one decimal under a minute (`45.2s`), `2m42s` from there on.
 * @param ms - total first-token latency.
 * @returns the display string.
 */
export declare function formatTtft(ms: number): string;
/**
 * Decode-throughput display figure in the shell's shape: whole tokens from
 * ten up, one decimal below (the `tok/s` unit lives in the locale template).
 * @param tokensPerSecond - tokens per second.
 * @returns the display number.
 */
export declare function formatSpeed(tokensPerSecond: number): string;
//# sourceMappingURL=format.d.ts.map