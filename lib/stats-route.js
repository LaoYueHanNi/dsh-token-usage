/**
 * The stats HTTP route of the token-usage plugin: a webServer exact route
 * serving the JSON summary at `/token-usage/stats` for the web settings page.
 * The /api prefix is owned by the browser-transport connection plugin and its
 * RPC method table is closed, so the plugin data channel is its own route.
 *
 * @module token-usage/stats-route
 */
import { readPricingTable, readUsdExchangeRate, resolveRate } from "./pricing.js";
import { attachCosts, buildSummary, filterRecordsBySessions, filterSummary, requestSeriesOf, summarizeRecords } from "./stats.js";
import { readCachedRecords } from "./record-cache.js";
import { bucketSeries, pointsOfBuckets } from "./trend-bucket.js";
import { decodeChildGroups, decodeSessionScope, DIR_GUARD_PATH, FULL_SYNC_PATH, MIGRATION_PATH, STATS_PATH, UNPRICED_KEY } from "./wire.js";
/** The stats endpoint path, exported for tests and the client half. */
export { STATS_PATH } from "./wire.js";
/** The migration-progress endpoint path, exported for the client half. */
export { MIGRATION_PATH } from "./wire.js";
/** The directory-guard endpoint path, exported for the client half. */
export { DIR_GUARD_PATH } from "./wire.js";
/** The full-sync endpoint path, exported for the client half. */
export { FULL_SYNC_PATH } from "./wire.js";
/** A day query key must be exactly `YYYY-MM-DD`. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;
/** Read the filter query parameters off the request URL. */
function readFilters(req) {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const pick = (key) => {
        const value = params.get(key);
        return value === null || value === '' ? undefined : value;
    };
    const fields = pick('fields');
    return {
        from: pick('from'),
        to: pick('to'),
        model: pick('model'),
        sessionIds: decodeSessionScope(params),
        childGroups: decodeChildGroups(params),
        fields: fields === 'chip' || fields === 'session' ? fields : 'full',
    };
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
 * Build the migration-progress route the browser card polls while a move
 * runs. Read-only by construction: it answers the shared status object and
 * nothing else.
 * @param status - reads the live migration state.
 * @returns the exact GET route answering the progress JSON.
 */
export function createMigrationRoute(status) {
    return {
        kind: 'exact',
        path: MIGRATION_PATH,
        handler: (req, res) => {
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
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(status() ?? null));
        },
    };
}
/**
 * Build the directory-guard route the browser card consults before saving a
 * staged directory edit: the settings wire never delivers a refused write's
 * reason, so the card asks here whether the save would be refused and shows
 * the verdict's count itself. Read-only by construction: it answers the
 * caller's judge verdict and writes nothing.
 * @param judge - answers the verdict for one proposed stored path
 * (`undefined` when the save would clear the override).
 * @returns the exact GET route answering the verdict JSON.
 */
export function createDirectoryGuardRoute(judge) {
    return {
        kind: 'exact',
        path: DIR_GUARD_PATH,
        handler: (req, res) => {
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
            const raw = params.get('path');
            // A blank path is the clear-back-to-default gesture, not a stored ''.
            const proposed = raw === null || raw === '' ? undefined : raw;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(judge(proposed)));
        },
    };
}
/**
 * Build the full-sync route backing the card's manual "scan again" button.
 * The handler is small by design: it only owns the request/response shape
 * (GET polls the live status, POST kicks off a run). The actual scan lives
 * on the host half and updates the shared status object, which `status()`
 * reads. The scan is fire-and-forget on POST so the request never blocks
 * behind a long walk; the card polls until the status leaves `running`.
 * @param status - reads the shared status (the same view the card renders).
 * @param trigger - kicks off a new run when the host is idle.
 * @returns the exact route serving both methods.
 */
export function createFullSyncRoute(status, trigger) {
    return {
        kind: 'exact',
        path: FULL_SYNC_PATH,
        handler: (req, res) => {
            if (!isSameOriginFetch(req)) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('forbidden');
                return;
            }
            if (req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(status()));
                return;
            }
            if (req.method === 'POST') {
                const result = trigger();
                if (!result.started) {
                    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: result.reason }));
                    return;
                }
                res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ status: 'running' }));
                return;
            }
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed');
        },
    };
}
/** Fold one child group into the slim row the usage tab's subagent table reads. */
function childBreakdown(records, filter, dataDir, resolve, pricing) {
    const rows = {};
    for (const group of filter.childGroups) {
        const scoped = filterRecordsBySessions(records, group.sessionIds);
        const summary = attachCosts(filterSummary({ dataDir, ...summarizeRecords(scoped, resolve) }, filter.from, filter.to, filter.model), pricing);
        rows[group.id] = {
            total: summary.total,
            totalCost: summary.totalCost,
            unpricedModels: summary.unpricedModels,
        };
    }
    return rows;
}
/** Session-scoped wire shape: `full` keeps the CostedSummary; `session` /
 * `chip` drop the unused pricing / rate / recent / hour layers, and
 * `session` sends a pre-bucketed request series (≤ 60 points). */
function slimSessionPayload(input) {
    const { summary, sessionIds, series, currency, usdExchangeRate, fields, children } = input;
    const requestSeries = fields === 'session' ? pointsOfBuckets(bucketSeries(series)) : [...series];
    const full = {
        ...summary,
        scope: 'session',
        sessionIds,
        requestSeries,
        currency,
        usdExchangeRate,
        ...children !== undefined ? { children } : {},
    };
    if (fields === 'full')
        return full;
    const chip = {
        scope: 'session',
        sessionIds,
        total: summary.total,
        totalCost: summary.totalCost,
        unpricedModels: summary.unpricedModels,
        currency,
        usdExchangeRate,
        ...children !== undefined ? { children } : {},
    };
    if (fields === 'chip')
        return chip;
    return {
        ...chip,
        byModel: summary.byModel,
        byDay: summary.byDay,
        requestSeries,
    };
}
/**
 * Build the stats route over a data directory the caller may relocate live.
 * @param dir - reads the directory currently in force (per request, so a
 * settings-driven move starts answering from the new location at once).
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
                const dataDir = dir();
                // The pricing table is user-maintained and may change between
                // requests; reading it per request keeps the page honest without
                // any caching (the file is small and the route is not hot).
                const pricing = await readPricingTable(dataDir);
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
                // Session-scoped reads fold filtered raw records: the rollup rows
                // carry no session dimension. Frozen day files come from the
                // process cache so chip polls and the usage tab do not re-parse
                // history; today's file re-reads when its stamp changes.
                const allRecords = filter.sessionIds.length > 0 || filter.childGroups.length > 0
                    ? await readCachedRecords(dataDir)
                    : undefined;
                const scoped = filter.sessionIds.length > 0 && allRecords !== undefined
                    ? filterRecordsBySessions(allRecords, filter.sessionIds)
                    : undefined;
                const summary = attachCosts(filterSummary(scoped !== undefined
                    ? { dataDir, ...summarizeRecords(scoped, resolve) }
                    : await buildSummary(dataDir, undefined, resolve), filter.from, filter.to, filter.model), pricing);
                // Display-currency metadata: amounts stay RMB on the wire; the
                // page converts (÷ usdExchangeRate) when the region pick says USD.
                const currency = options.currency?.() ?? 'CNY';
                const usdExchangeRate = await readUsdExchangeRate(dataDir);
                const children = allRecords !== undefined && filter.childGroups.length > 0
                    ? childBreakdown(allRecords, filter, dataDir, resolve, pricing)
                    : undefined;
                const payload = scoped !== undefined
                    ? slimSessionPayload({
                        summary,
                        sessionIds: filter.sessionIds,
                        series: requestSeriesOf(scoped, filter.from, filter.to, filter.model),
                        currency,
                        usdExchangeRate,
                        fields: filter.fields,
                        children,
                    })
                    : {
                        ...summary,
                        scope: 'whole',
                        currency,
                        usdExchangeRate,
                    };
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