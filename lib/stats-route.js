/**
 * The stats HTTP route of the token-usage plugin: a webServer exact route
 * serving the JSON summary at `/token-usage/stats` for the web settings page.
 * The /api prefix is owned by the browser-transport connection plugin and its
 * RPC method table is closed, so the plugin data channel is its own route.
 *
 * @module token-usage/stats-route
 */
import { readPricingTable, readUsdExchangeRate, resolveRate } from "./pricing.js";
import { attachCosts, buildSummary, filterSummary } from "./stats.js";
import { STATS_PATH, UNPRICED_KEY } from "./wire.js";
/** The stats endpoint path, exported for tests and the client half. */
export { STATS_PATH } from "./wire.js";
/** A day query key must be exactly `YYYY-MM-DD`. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;
/** Read the filter query parameters off the request URL. */
function readFilters(req) {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const pick = (key) => {
        const value = params.get(key);
        return value === null || value === '' ? undefined : value;
    };
    return { from: pick('from'), to: pick('to'), model: pick('model') };
}
/** Whether every present day key is well-formed and ordered. */
function isValidRange(filter) {
    if (filter.from !== undefined && !DAY_KEY.test(filter.from))
        return false;
    if (filter.to !== undefined && !DAY_KEY.test(filter.to))
        return false;
    if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to)
        return false;
    return true;
}
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
 * @param options - the currency thunk; defaults to CNY (the domestic default).
 * @returns the exact GET route serving the JSON summary.
 */
export function createStatsRoute(dir, options = {}) {
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
            const filter = readFilters(req);
            if (!isValidRange(filter)) {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('invalid filter');
                return;
            }
            try {
                // The pricing table is user-maintained and may change between
                // requests; reading it per request keeps the page honest without
                // any caching (the file is small and the route is not hot).
                const pricing = await readPricingTable(dir);
                // Per-record pricing: each record resolves through the rule chain at
                // its own timestamp (tier approximated by its input-side tokens).
                const resolve = record => {
                    const rules = pricing[record.model];
                    if (rules === undefined)
                        return UNPRICED_KEY;
                    const tokens = record.usage;
                    const context = tokens === undefined ? 0
                        : tokens.inputTokens + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0);
                    return resolveRate(rules, record.time, context).key;
                };
                const summary = attachCosts(filterSummary(await buildSummary(dir, undefined, resolve), filter.from, filter.to, filter.model), pricing);
                // Display-currency metadata: amounts stay RMB on the wire; the page
                // converts (÷ usdExchangeRate) when the region pick says USD.
                const currency = options.currency?.() ?? 'CNY';
                const payload = { ...summary, currency, usdExchangeRate: await readUsdExchangeRate(dir) };
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    // Stats change with every request; the browser must not cache them.
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
//# sourceMappingURL=stats-route.js.map