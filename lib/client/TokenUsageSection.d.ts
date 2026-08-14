/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the total-usage strip — requests / total tokens
 * / cache hit rate on one row, the four token buckets on the next — followed
 * by a per-model detail table (one row per model). Token counts are
 * abbreviated (K below 1M, M below 1 亿, B from 1 亿 with B = 10 亿); the page
 * owns no store because nothing outside it reads the summary, and a manual
 * refresh re-fetches after new requests land.
 *
 * @module token-usage/client/TokenUsageSection
 */
import type { ReactNode } from 'react';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { UsageTotals } from '../wire.ts';
/**
 * Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 1 亿
 * (1e8), `xxB` from 1 亿 up with B = 10 亿 (1e9) — 1 亿 is `0.1B`, 3 亿 is
 * `0.3B`, 10 亿 is `1B`, 30 亿 is `3B`. One decimal while the scaled value is
 * below 10, integer otherwise — `950K`, `1.5M`, `50M`, `0.5B`, `3B`.
 * @param count - a non-negative token count.
 * @returns the compact display string.
 */
export declare function formatTokens(count: number): string;
/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
export declare function totalTokens(totals: UsageTotals): number;
/**
 * Cache hit rate as display text: cache reads over served input
 * (missed input + cache reads). `—` when nothing was served.
 * @param totals - the aggregated totals.
 * @returns e.g. `87.5%`, or `—` for an empty denominator.
 */
export declare function formatHitRate(totals: UsageTotals): string;
/**
 * Render the Token 用量 section content column.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel).
 * @returns the section, one of loading / error / ready.
 */
export declare function TokenUsageSection(_props: SettingsSectionOwnerProps): ReactNode;
//# sourceMappingURL=TokenUsageSection.d.ts.map