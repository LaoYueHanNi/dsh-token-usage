/**
 * The quota HTTP route of the token-usage plugin: a webServer exact route
 * serving the current provider's quota payload at `/token-usage/quota`.
 * The browser half's input-bar button polls it (`?session=<id>`); the
 * same-origin guard mirrors the stats route's.
 *
 * @module token-usage/quota/quota-route
 */
import { QUOTA_PATH } from "../wire.js";
import { isSameOriginFetch } from "../stats-route.js";
/** The quota endpoint path, exported for tests and the client half. */
export { QUOTA_PATH } from "../wire.js";
/**
 * Build the quota route over the orchestration service.
 * @param snapshot - resolves the payload for one asking session (the
 * `session` query parameter, undefined when absent) and its model chip's
 * current selection (the `provider` query parameter, undefined when the
 * browser could not read one).
 * @returns the exact GET route answering the quota JSON.
 */
export function createQuotaRoute(snapshot) {
    return {
        kind: 'exact',
        path: QUOTA_PATH,
        handler: async (req, res) => {
            if (req.method !== 'GET') {
                res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('method not allowed');
                return;
            }
            if (!isSameOriginFetch(req)) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('forbidden');
                return;
            }
            const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const pick = (key) => {
                const value = params.get(key);
                return value === null || value === '' ? undefined : value;
            };
            try {
                const payload = await snapshot(pick('session'), pick('provider'));
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    // The payload changes with the provider's own meters; never cache.
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify(payload));
            }
            catch (error) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
        },
    };
}
//# sourceMappingURL=quota-route.js.map