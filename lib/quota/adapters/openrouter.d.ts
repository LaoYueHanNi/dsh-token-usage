/**
 * OpenRouter credits adapter: the remaining pay-as-you-go credits of an
 * OpenRouter account.
 *
 * Endpoint: `GET https://openrouter.ai/api/v1/credits` with a Bearer key.
 * The response reports `{ total_credits, total_usage }` in USD; remaining
 * is the difference. Unlike a plain balance, the total is known, so the
 * window also carries `maxValue` and the panel draws a spend-progress bar.
 *
 * @module token-usage/quota/adapters/openrouter
 */
import type { QuotaAdapter } from '../types.ts';
/** The OpenRouter credits adapter. */
export declare const openrouterAdapter: QuotaAdapter;
//# sourceMappingURL=openrouter.d.ts.map