/**
 * Browser-side display formatting of the token-usage settings page: token
 * abbreviation (K/M/B) and the cache hit rate. Pure functions only, shared
 * by the section and the trend chart.
 *
 * @module token-usage/client/format
 */
import type { UsageTotals } from '../wire.ts';
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
//# sourceMappingURL=format.d.ts.map