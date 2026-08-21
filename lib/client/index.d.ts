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
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services: the slot registry, the locale dictionaries, the
 * settings scope, and the workspace service (its native directory picker
 * backs the card's browse button). */
export declare const inject: string[];
/**
 * Register the dictionary pair, then the settings page and the plugin
 * configuration card once the shell's declarations are on the ledger.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map