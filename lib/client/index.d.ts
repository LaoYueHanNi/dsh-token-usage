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
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services: the slot registry, the locale dictionaries, and the settings scope. */
export declare const inject: string[];
/**
 * Register the dictionary pair, then the settings page and the plugin
 * configuration card once the shell's declarations are on the ledger.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map