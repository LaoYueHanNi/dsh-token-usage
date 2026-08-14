/**
 * The stats HTTP route of the token-usage plugin: a webServer exact route
 * serving the JSON summary at `/token-usage/stats` for the web settings page.
 * The /api prefix is owned by the browser-transport connection plugin and its
 * RPC method table is closed, so the plugin data channel is its own route.
 *
 * @module token-usage/stats-route
 */
import { buildSummary } from "./stats.js";
import { STATS_PATH } from "./wire.js";
/** The stats endpoint path, exported for tests and the client half. */
export { STATS_PATH } from "./wire.js";
/**
 * Whether a request may read the stats: same-origin browser fetches only.
 * Browsers send `Sec-Fetch-Site` on cross-origin requests; a cross-site value
 * (or a cross-site GET from a page on another origin) is refused. The header
 * is absent for non-browser clients (curl, tests), which are allowed.
 * @param req - the incoming request.
 * @returns whether the request originates from the served page.
 */
export function isSameOriginFetch(req) {
    const site = req.headers['sec-fetch-site'];
    if (site === undefined)
        return true;
    return site === 'same-origin' || site === 'none';
}
/**
 * Build the stats route for one data directory.
 * @param dir - the plugin's data directory.
 * @returns the exact GET route serving the JSON summary.
 */
export function createStatsRoute(dir) {
    return {
        kind: 'exact',
        path: STATS_PATH,
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
            try {
                const summary = await buildSummary(dir);
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    // Stats change with every request; the browser must not cache them.
                    'cache-control': 'no-store',
                });
                res.end(JSON.stringify(summary));
            }
            catch (error) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
        },
    };
}
//# sourceMappingURL=stats-route.js.map