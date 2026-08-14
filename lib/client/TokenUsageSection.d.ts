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
import type { ReactNode } from 'react';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
export { totalTokens } from './day.ts';
export { formatTokens, formatHitRate } from './format.ts';
/**
 * Render the Token 用量 section content column.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel).
 * @returns the section, one of loading / error / ready.
 */
export declare function TokenUsageSection(_props: SettingsSectionOwnerProps): ReactNode;
//# sourceMappingURL=TokenUsageSection.d.ts.map