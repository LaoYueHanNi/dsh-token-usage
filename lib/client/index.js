/**
 * Browser half of the token-usage plugin: contributes the Token Usage page to
 * the web settings surface. The page data arrives from the host half's stats
 * route (`/token-usage/stats`); nothing else on the client shares it, so the
 * section owns a plain fetch and no store. Export discipline: the /client
 * entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */
import { TokenUsageSection } from "./TokenUsageSection.js";
import { en, NS, zh } from "./locales.js";
/** Required services: the slot registry and the locale dictionary registry. */
export const inject = ['slots', 'locale'];
/**
 * Register the dictionary pair, then the settings section once the shell's
 * `settings.section` declaration is on the ledger.
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
}
//# sourceMappingURL=index.js.map