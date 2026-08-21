/**
 * Browser half of the token-usage plugin. Two registrations share one
 * dictionary pair: the Token Usage stats page on the settings surface (data
 * from the host half's stats route, `/token-usage/stats`), and the plugin
 * configuration card on the Plugins tab (the `token-usage` settings
 * namespace — the data directory and the pricing region — edited through
 * the settings scope, with the relocation progress polled from
 * `/token-usage/migration`). The card's browse button rides the shell's
 * workspace service (`ctx.workspaces.pickDirectory`), the same native
 * directory picker the workspace flows use. Export discipline: the /client
 * entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-settings SlotMap merge ('settings.section') and the
// owner-share type into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ui-settings-plugins keyed-slot declaration
// ('settings.plugin.item') into this program. The value face stays
// uncompromised: cross-plugin collaboration goes through the slot system.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the locale service's Context merge (ctx.locale) and the
// shared `common` vocabulary into the `t` seat's key domain.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CardForm, type SectionValue } from './card-form.ts'
import { TokenUsageCard } from './TokenUsageCard.tsx'
import { TokenUsageSection } from './TokenUsageSection.tsx'
import { en, NS, zh } from './locales.ts'

/**
 * Namespace of the token-usage settings section. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
const TOKEN_USAGE_NS = 'token-usage'

/** Required services: the slot registry, the locale dictionaries, the
 * settings scope, and the workspace service (its native directory picker
 * backs the card's browse button). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'workspaces']

/**
 * Register the dictionary pair, then the settings page and the plugin
 * configuration card once the shell's declarations are on the ledger.
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

  // The Plugins configuration tab dispatches keyed cards for the namespaces
  // the Host serves; the token-usage host half registers this key, so the
  // pricing card pairs with it without any upstream change.
  const form = new CardForm(ctx.settingsScope.bind<SectionValue>({ namespace: TOKEN_USAGE_NS }))
  const store = form.bind()
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TOKEN_USAGE_NS,
    locale: NS,
    inject: () => ({
      hooks: { tokenUsageCard: store },
      ...form.actions(),
      // The shell's own directory picker (the workspace flows' chooser):
      // resolves the chosen absolute path, or null when the user dismisses.
      pickDirectory: () => ctx.workspaces.pickDirectory(),
    }),
  }, TokenUsageCard))
}
