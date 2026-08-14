/**
 * Token-usage settings page (browser half): fetches the stats summary from
 * the host route and renders totals, per-day and per-model tables, and the
 * recent request list. Data arrives through plain fetch into component-local
 * state — the page owns no store because nothing outside it reads the
 * summary; a manual refresh re-fetches after new requests land.
 *
 * @module token-usage/client/TokenUsageSection
 */
import type { ReactNode } from 'react';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
/**
 * Render the Token 用量 section content column.
 * @param props - the settings shell's owner share (close is unused: the nav
 * rail owns leaving the panel).
 * @returns the section, one of loading / error / ready.
 */
export declare function TokenUsageSection(_props: SettingsSectionOwnerProps): ReactNode;
//# sourceMappingURL=TokenUsageSection.d.ts.map