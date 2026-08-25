/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders the filter bar (inclusive day range, model
 * select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
 * total-usage strip, the daily-token trend chart, the per-model detail
 * table with the hit rate last, and — opened by each priced model row's
 * “定价” affordance — a dialog with that model's full price table — all
 * following the active filters. There is no refresh button: entering the
 * page or changing a filter refetches (the route answers no-store); only
 * the error state keeps a retry.
 *
 * @module token-usage/client/TokenUsageSection
 */
import type { ReactNode } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
/** Re-export so existing section tests and consumers keep importing
 * `StatCard` from this module (the file moved to `./StatCard.tsx`). */
export { StatCard } from './StatCard.tsx';
export { totalTokens } from './day.ts';
export { formatTokens, formatHitRate } from './format.ts';
/**
 * Render the Token Usage section content column. The `t` seat arrives from
 * the registration's `locale:` declaration and follows the active locale.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel) plus the framework-injected translate seat.
 * @returns the section, one of loading / error / ready.
 */
export declare function TokenUsageSection({ t }: SettingsSectionOwnerProps & {
    t: TranslateNS<'token-usage'>;
}): ReactNode;
//# sourceMappingURL=TokenUsageSection.d.ts.map