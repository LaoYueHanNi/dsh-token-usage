/**
 * Browser half of the token-usage plugin: contributes the Token Usage page to
 * the web settings surface. The page data arrives from the host half's stats
 * route (`/token-usage/stats`); nothing else on the client shares it, so the
 * section owns a plain fetch and no store. Export discipline: the /client
 * entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-settings SlotMap merge ('settings.section') and the
// owner-share type into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale service's Context merge (ctx.locale) and the
// shared `common` vocabulary into the `t` seat's key domain.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { TokenUsageSection } from './TokenUsageSection.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the slot registry and the locale dictionary registry. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionary pair, then the settings section once the shell's
 * `settings.section` declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-usage: dictionaries')
  // Stable per-namespace translate reading the active locale at call time;
  // the label thunk re-evaluates it per read, so the nav row follows switches.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'token-usage',
    order: 50,
    label: () => t('nav.label'),
    locale: NS,
  }, TokenUsageSection))
}
