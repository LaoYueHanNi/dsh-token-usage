/**
 * Browser-safe wire vocabulary of the token-usage plugin: the stats endpoint
 * path and the JSON shapes the web settings page consumes. No runtime imports
 * and no I/O, so the host half (route handler) and the browser half (settings
 * page) share one vocabulary, and the client bundle can inline this module.
 *
 * @module token-usage/wire
 */
/** The stats endpoint path, served by the host half's webServer route. */
export const STATS_PATH = '/token-usage/stats';
//# sourceMappingURL=wire.js.map