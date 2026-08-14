/**
 * The stats HTTP route of the token-usage plugin: a webServer exact route
 * serving the JSON summary at `/token-usage/stats` for the web settings page.
 * The /api prefix is owned by the browser-transport connection plugin and its
 * RPC method table is closed, so the plugin data channel is its own route.
 *
 * @module token-usage/stats-route
 */
import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
/** The stats endpoint path, exported for tests and the client half. */
export { STATS_PATH } from './wire.ts';
/**
 * Whether a request may read the stats: same-origin browser fetches only.
 * Browsers send `Sec-Fetch-Site` on cross-origin requests; a cross-site value
 * (or a cross-site GET from a page on another origin) is refused. The header
 * is absent for non-browser clients (curl, tests), which are allowed.
 * @param req - the incoming request.
 * @returns whether the request originates from the served page.
 */
export declare function isSameOriginFetch(req: IncomingMessage): boolean;
/**
 * Build the stats route for one data directory.
 * @param dir - the plugin's data directory.
 * @returns the exact GET route serving the JSON summary.
 */
export declare function createStatsRoute(dir: string): WebRoute;
//# sourceMappingURL=stats-route.d.ts.map