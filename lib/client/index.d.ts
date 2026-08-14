/**
 * Browser half of the token-usage plugin: contributes the Token 用量 page to
 * the web settings surface. The page data arrives from the host half's stats
 * route (`/token-usage/stats`); nothing else on the client shares it, so the
 * section owns a plain fetch and no store. Export discipline: the /client
 * entry exposes only what cordis loading needs.
 *
 * @module token-usage/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services: the slot registry (declared by the client runtime). */
export declare const inject: string[];
/**
 * Register the settings section once the shell's `settings.section`
 * declaration is on the ledger.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map