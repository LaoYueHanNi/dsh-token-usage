/**
 * Browser half of the token-usage plugin: contributes the Token 用量 page to
 * the web settings surface. The page data arrives from the host half's stats
 * route (`/token-usage/stats`); nothing else on the client shares it, so the
 * section owns a plain fetch and no store. Export discipline: the /client
 * entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */
import { TokenUsageSection } from "./TokenUsageSection.js";
/** Required services: the slot registry (declared by the client runtime). */
export const inject = ['slots'];
/**
 * Register the settings section once the shell's `settings.section`
 * declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'token-usage',
        order: 50,
        label: 'Token 用量',
    }, TokenUsageSection));
}
//# sourceMappingURL=index.js.map