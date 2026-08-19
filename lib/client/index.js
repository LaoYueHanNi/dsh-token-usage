/**
 * Browser half of the token-usage plugin. Two registrations share one
 * dictionary pair: the Token Usage stats page on the settings surface (data
 * from the host half's stats route, `/token-usage/stats`), and the
 * pricing-source card on the Plugins configuration tab (the `token-usage`
 * settings namespace, edited through the settings scope). Export discipline:
 * the /client entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */
import { CardForm } from "./card-form.js";
import { TokenUsageCard } from "./TokenUsageCard.js";
import { TokenUsageSection } from "./TokenUsageSection.js";
import { en, NS, zh } from "./locales.js";
/**
 * Namespace of the token-usage settings section. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
const TOKEN_USAGE_NS = 'token-usage';
/** Required services: the slot registry, the locale dictionaries, and the settings scope. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];
/**
 * Register the dictionary pair, then the settings page and the plugin
 * configuration card once the shell's declarations are on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-usage: dictionaries');
    // Stable per-namespace translate reading the active locale at call time;
    // the label thunk re-evaluates it per read, so the nav row follows switches.
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'token-usage',
        order: 50,
        label: () => t('nav.label'),
        locale: NS,
    }, TokenUsageSection));
    // The Plugins configuration tab dispatches keyed cards for the namespaces
    // the Host serves; the token-usage host half registers this key, so the
    // pricing card pairs with it without any upstream change.
    const form = new CardForm(ctx.settingsScope.bind({ namespace: TOKEN_USAGE_NS }));
    const store = form.bind();
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: TOKEN_USAGE_NS,
        locale: NS,
        inject: () => ({ hooks: { tokenUsageCard: store }, ...form.actions() }),
    }, TokenUsageCard));
}
//# sourceMappingURL=index.js.map