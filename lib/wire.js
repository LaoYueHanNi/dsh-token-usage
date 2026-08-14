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
/** True when any rule dimension exists beyond the flat base rates. */
export function hasRateRules(rates) {
    return rates.contextTiers.length > 0 || rates.dailySlots.length > 0 || rates.timeRules.length > 0;
}
/** The neutral key of an unpriced model's rows. */
export const UNPRICED_KEY = { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 };
/** Whether a key is the neutral unpriced one. */
export function isUnpricedKey(key) {
    return key.ruleStart === 0 && key.ruleEnd === 0 && key.tier === 0 && key.slot === -1;
}
//# sourceMappingURL=wire.js.map