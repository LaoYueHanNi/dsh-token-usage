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
/** The migration-progress endpoint path, polled by the browser card. */
export const MIGRATION_PATH = '/token-usage/migration';
/**
 * The directory-guard endpoint path, consulted by the browser card before a
 * staged directory save commits. The settings wire swallows a refused write
 * (the bound scope recovers silently and never rejects), so this route is the
 * one channel that can tell the card WHY a save would not land.
 */
export const DIR_GUARD_PATH = '/token-usage/dir-guard';
/**
 * The full-sync endpoint path: the card's manual "scan again" affordance.
 * `POST` starts one full scan over every session log (the same scan the
 * one-shot startup sync ran on first install — list + inspect + dedupe), and
 * `GET` returns the live progress. The scan is fire-and-forget on the host
 * side, so the card polls while it runs.
 */
export const FULL_SYNC_PATH = '/token-usage/full-sync';
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
/**
 * The display currency a mirror region implies: `overseas` (GitHub) shows
 * USD, `domestic` (Gitee) and the unset default show CNY. Only the region
 * pick decides — an explicit `pricingUrl` never changes the display.
 * @param region - the effective `pricingRegion` (undefined when unset).
 * @returns the display currency of the stats page.
 */
export function currencyOfRegion(region) {
    return region === 'overseas' ? 'USD' : 'CNY';
}
//# sourceMappingURL=wire.js.map