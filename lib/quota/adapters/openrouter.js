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
import { amountOf, fetchJson, hostOf } from "../http.js";
import { QuotaQueryError } from "../types.js";
/** The pi-ai catalog route and the account host. */
const ROUTE_OPENROUTER = 'openrouter';
const QUOTA_URL = 'https://openrouter.ai/api/v1/credits';
/** The OpenRouter credits adapter. */
export const openrouterAdapter = {
    id: 'openrouter-credits',
    label: 'OpenRouter Credits',
    routes: [ROUTE_OPENROUTER],
    matches(input) {
        if (input.provider === ROUTE_OPENROUTER)
            return true;
        const host = hostOf(input.baseUrl);
        return host !== undefined && (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'));
    },
    async query(ctx) {
        const body = await fetchJson(ctx, QUOTA_URL, { authorization: `Bearer ${ctx.apiKey}` });
        if (typeof body !== 'object' || body === null) {
            throw new QuotaQueryError('parse', 'response is not an object');
        }
        const record = body;
        const data = typeof record.data === 'object' && record.data !== null
            ? record.data
            : record;
        // The amounts may ship as strings (the same serializer DeepSeek uses);
        // the signed parser takes either form.
        const total = amountOf(data.total_credits);
        const usage = amountOf(data.total_usage);
        if (total === undefined || usage === undefined) {
            throw new QuotaQueryError('parse', 'missing "total_credits" / "total_usage"');
        }
        return {
            windows: [{
                    tier: 'balance',
                    remainingValue: Math.max(0, total - usage),
                    maxValue: total,
                    unit: 'usd',
                }],
        };
    },
};
//# sourceMappingURL=openrouter.js.map