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
/** Encode one repeated query key (`sessionId=a&sessionId=b`). Empty list yields ''. */
export function encodeRepeatedParam(key, values) {
    return values.map(value => `${key}=${encodeURIComponent(value)}`).join('&');
}
/**
 * Parse every occurrence of `key` off a URL or `URLSearchParams`, dropping
 * blanks and duplicates, preserving first-seen order.
 */
export function decodeRepeatedParam(source, key) {
    const params = source instanceof URL ? source.searchParams : source;
    const seen = new Set();
    const out = [];
    for (const value of params.getAll(key)) {
        if (value === '' || seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}
/** Encode child groups as repeated `childId=<id>[,member…]` parameters. */
export function encodeChildGroups(groups) {
    return groups
        .filter(group => group.length > 0 && group[0] !== '')
        .map(group => `childId=${encodeURIComponent(group.join(','))}`)
        .join('&');
}
/** Parse `childId=` groups; the first comma-separated token is the row id. */
export function decodeChildGroups(source) {
    const params = source instanceof URL ? source.searchParams : source;
    const seen = new Set();
    const out = [];
    for (const value of params.getAll('childId')) {
        if (value === '')
            continue;
        const sessionIds = value.split(',').filter(id => id !== '');
        const id = sessionIds[0];
        if (id === undefined || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, sessionIds });
    }
    return out;
}
/**
 * Build the stats query string (including the leading `?`, or '' when
 * unconstrained). `fields: 'full'` is omitted — that is the default the
 * settings page already hits.
 */
export function encodeStatsQuery(options) {
    const parts = [];
    if (options.sessionIds !== undefined && options.sessionIds.length > 0) {
        parts.push(encodeRepeatedParam('sessionId', options.sessionIds));
    }
    const children = options.childGroups !== undefined ? encodeChildGroups(options.childGroups) : '';
    if (children !== '')
        parts.push(children);
    if (options.fields !== undefined && options.fields !== 'full') {
        parts.push(`fields=${options.fields}`);
    }
    return parts.length === 0 ? '' : `?${parts.join('&')}`;
}
/**
 * Encode a session-scope id list as a `sessionId=` query fragment pair:
 * every id becomes its own `sessionId=<encoded>` parameter (RFC-style
 * `?a=1&a=2`), so a parent-and-children fetch aggregates the whole subtree
 * in one request. The empty list yields '' (no query string at all).
 * @param ids - the session ids to filter by.
 */
export function encodeSessionScope(ids) {
    return encodeStatsQuery({ sessionIds: ids });
}
/**
 * Parse the `sessionId=` parameters off a URL or a parsed `URLSearchParams`:
 * every occurrence of the key becomes one entry, in URL order (so a parent
 * + children fetch preserves the caller-supplied order). Empty values are
 * dropped (defensive: a `?sessionId=` blank yields no entry) and duplicates
 * are deduped.
 * @param source - the URL or its parsed params.
 * @returns the deduplicated id list.
 */
export function decodeSessionScope(source) {
    return decodeRepeatedParam(source, 'sessionId');
}
/**
 * The quota endpoint path: the input-bar quota button polls this for the
 * current provider's rate-limit / balance snapshot. Served by the host
 * half's quota route; the query carries `?session=<id>` so the host can
 * resolve the provider the ACTIVE session is using.
 */
export const QUOTA_PATH = '/token-usage/quota';
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
 * one-shot startup sync ran on first install — list + open/read + dedupe), and
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
/** The windows of a payload, empty for every non-ok variant — the helper
 * the panel reuses for the trigger icon's color. */
export function quotaWindowsOf(payload) {
    return payload.status === 'ok' ? payload.windows : [];
}
//# sourceMappingURL=wire.js.map