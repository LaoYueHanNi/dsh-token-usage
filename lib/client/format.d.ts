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
//# sourceMappingURL=format.d.ts.map