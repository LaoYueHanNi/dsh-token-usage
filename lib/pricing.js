/**
 * Pricing vocabulary and store of the token-usage plugin: the per-model
 * price rules (¥ per million tokens) backing the cost figures of the stats
 * page. Two sources merge on read — the cloud feed mirrored on every dsh
 * startup into `<data dir>/pricing.ccsa.json` (the same model-price-table
 * source cc-switch-analyzer pulls), and the hand-edited `<data
 * dir>/pricing.json`, whose entries always win and replace a model's cloud
 * rules wholesale. Absent files mean no pricing; a malformed file logs once
 * and reads as empty, so a broken table never blocks the stats route.
 *
 * Every record is priced individually through the analyzer's rule chain —
 * time-rule container first, then context tier, then peak slot (a slot may be
 * restricted to ISO weekdays via `daysOfWeek`, matched on the request's local
 * day) — and the aggregation keeps rows per (day, model, rate identity), so
 * re-pricing under an updated table needs no rollup rebuild. The context size
 * for tier matching is approximated by the request's input-side tokens (input +
 * cacheRead + cacheWrite): the log does not carry the raw context size.
 *
 * @module token-usage/pricing
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** The hand-maintained pricing file inside the data directory. */
export const PRICING_FILE = 'pricing.json';
/** The cloud-feed mirror written on every startup. */
export const PRICING_CCSA_FILE = 'pricing.ccsa.json';
/**
 * The default domestic (China) cloud pricing feed: the model-price-table
 * repository the analyzer also pulls from (¥ per million tokens, currency
 * RMB). Overridden through the `pricingUrlDomestic` config key.
 */
export const DEFAULT_PRICING_URL_DOMESTIC = 'https://gitee.com/oyw125/model-price-table/raw/master/model_pricing.json';
/**
 * The default overseas cloud pricing feed: the same model-price-table,
 * mirrored to GitHub because the gitee CDN is slow or unreliable outside
 * mainland China. Overridden through the `pricingUrlOverseas` config key.
 */
export const DEFAULT_PRICING_URL_OVERSEAS = 'https://raw.githubusercontent.com/LaoYueHanNi/model-price-table/master/model_pricing.json';
/** Backward-compatible alias: the domestic (gitee) default feed. */
export const DEFAULT_PRICING_URL = DEFAULT_PRICING_URL_DOMESTIC;
/**
 * The RMB-per-USD rate used for display conversion when the cloud feed's
 * envelope does not carry a usable `usdExchangeRate` (older mirrors). The
 * feed owns the number; this is only the stand-in until it lands.
 */
export const DEFAULT_USD_EXCHANGE_RATE = 7;
/**
 * Resolve the feed URL to fetch: an explicit `pricingUrl` wins outright;
 * otherwise `pricingRegion` picks the domestic (default) or overseas mirror,
 * each overridable through its own key. Deliberately no IP sniffing — the
 * deployer sets the region once in the profile config, so the choice is
 * predictable and never depends on a third-party geo lookup.
 */
export function resolvePricingUrl(input = {}) {
    if (input.pricingUrl !== undefined)
        return input.pricingUrl;
    if (input.pricingRegion === 'overseas') {
        return input.pricingUrlOverseas ?? DEFAULT_PRICING_URL_OVERSEAS;
    }
    return input.pricingUrlDomestic ?? DEFAULT_PRICING_URL_DOMESTIC;
}
/** A positive (or zero) finite number; rates may be 0 but never negative. */
function isRate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
/** A usable exchange rate: finite and strictly positive (0 would divide by zero). */
function isExchangeRate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function coerceRates(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const node = value;
    if (!isRate(node.inputCostPerMillion) || !isRate(node.outputCostPerMillion))
        return null;
    return {
        inputCostPerMillion: node.inputCostPerMillion,
        outputCostPerMillion: node.outputCostPerMillion,
        ...(isRate(node.cacheReadCostPerMillion) ? { cacheReadCostPerMillion: node.cacheReadCostPerMillion } : {}),
        ...(isRate(node.cacheCreationCostPerMillion) ? { cacheCreationCostPerMillion: node.cacheCreationCostPerMillion } : {}),
        ...(Array.isArray(node.dailySlots)
            ? { dailySlots: node.dailySlots.map(coerceSlot).filter((slot) => slot !== null) }
            : {}),
    };
}
function coerceTier(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const tier = value;
    if (!isRate(tier.threshold))
        return null;
    const rates = coerceRates(value);
    return rates === null ? null : { ...rates, threshold: tier.threshold };
}
function coerceSlot(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const slot = value;
    if (!Array.isArray(slot.windows))
        return null;
    const windows = [];
    for (const window of slot.windows) {
        if (typeof window !== 'object' || window === null)
            continue;
        const w = window;
        if (isRate(w.startMinute) && isRate(w.endMinute))
            windows.push({ startMinute: w.startMinute, endMinute: w.endMinute });
    }
    if (windows.length === 0)
        return null;
    const rates = coerceRates(value);
    if (rates === null)
        return null;
    // ISO weekdays 1..7 only; anything else degrades to "every day" (omit),
    // never to a slot that matches nothing.
    const days = Array.isArray(slot.daysOfWeek)
        ? [...new Set(slot.daysOfWeek.filter((day) => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7))]
        : [];
    return {
        windows,
        inputCostPerMillion: rates.inputCostPerMillion,
        outputCostPerMillion: rates.outputCostPerMillion,
        ...(rates.cacheReadCostPerMillion !== undefined ? { cacheReadCostPerMillion: rates.cacheReadCostPerMillion } : {}),
        ...(rates.cacheCreationCostPerMillion !== undefined ? { cacheCreationCostPerMillion: rates.cacheCreationCostPerMillion } : {}),
        ...(days.length > 0 ? { daysOfWeek: days } : {}),
        ...(typeof slot.label === 'string' ? { label: slot.label } : {}),
    };
}
function coerceTimeRule(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const rule = value;
    if (!isRate(rule.startTime) || !isRate(rule.endTime))
        return null;
    const rates = coerceRates(value);
    if (rates === null)
        return null;
    const tiers = Array.isArray(rule.contextTiers)
        ? rule.contextTiers.map(coerceTier).filter((tier) => tier !== null)
        : [];
    return {
        ...rates,
        startTime: rule.startTime,
        endTime: rule.endTime,
        ...(typeof rule.label === 'string' ? { label: rule.label } : {}),
        ...(tiers.length > 0 ? { contextTiers: tiers } : {}),
    };
}
/**
 * Coerce an unknown value into the cloud feed shape, dropping invalid model
 * rows. A wrong envelope (non-array models, non-object) reads as null, and
 * so does a non-RMB `currency` — this plugin bills in ¥ only.
 * @param value - the parsed `pricing.ccsa.json` content.
 * @returns the feed, or null when the value is not a usable RMB feed.
 */
export function coerceCloudPricing(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const feed = value;
    if (!Array.isArray(feed.models))
        return null;
    if (typeof feed.currency !== 'string' || feed.currency !== 'RMB')
        return null;
    const models = [];
    for (const raw of feed.models) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const row = raw;
        const rates = coerceRates(raw);
        if (rates === null || typeof row.modelId !== 'string' || row.modelId === '')
            continue;
        models.push({
            ...rates,
            modelId: row.modelId,
            ...(Array.isArray(row.contextTiers)
                ? {
                    contextTiers: row.contextTiers.map(coerceTier)
                        .filter((tier) => tier !== null),
                }
                : {}),
            ...(Array.isArray(row.timeRules)
                ? {
                    timeRules: row.timeRules.map(coerceTimeRule)
                        .filter((rule) => rule !== null),
                }
                : {}),
            ...(Array.isArray(row.aliases) && row.aliases.every(alias => typeof alias === 'string')
                ? { aliases: row.aliases }
                : {}),
        });
    }
    return {
        version: typeof feed.version === 'number' ? feed.version : 0,
        updatedAt: typeof feed.updatedAt === 'number' ? feed.updatedAt : 0,
        currency: feed.currency,
        ...(isExchangeRate(feed.usdExchangeRate) ? { usdExchangeRate: feed.usdExchangeRate } : {}),
        models,
    };
}
// ---------------------------------------------------------------------------
// Cloud feed → ModelRates
// ---------------------------------------------------------------------------
/** Map one raw rate node onto the wire's per-million prices. */
function toPricing(rates) {
    return {
        inputPerMillion: rates.inputCostPerMillion,
        outputPerMillion: rates.outputCostPerMillion,
        ...(rates.cacheReadCostPerMillion !== undefined ? { cacheReadPerMillion: rates.cacheReadCostPerMillion } : {}),
        ...(rates.cacheCreationCostPerMillion !== undefined ? { cacheWritePerMillion: rates.cacheCreationCostPerMillion } : {}),
    };
}
function toSlots(slots) {
    return slots?.map(slot => ({
        windows: slot.windows,
        ...(slot.daysOfWeek !== undefined ? { daysOfWeek: slot.daysOfWeek } : {}),
        rates: toPricing(slot),
        ...(slot.label !== undefined ? { label: slot.label } : {}),
    })) ?? [];
}
function toTiers(tiers) {
    return tiers?.map(tier => ({
        threshold: tier.threshold,
        rates: toPricing(tier),
        ...(tier.dailySlots !== undefined ? { dailySlots: toSlots(tier.dailySlots) } : {}),
    })) ?? [];
}
function toTimeRules(rules) {
    return rules?.map(rule => ({
        startTime: rule.startTime,
        endTime: rule.endTime,
        rates: toPricing(rule),
        ...(rule.contextTiers !== undefined ? { contextTiers: toTiers(rule.contextTiers) } : {}),
        ...(rule.dailySlots !== undefined ? { dailySlots: toSlots(rule.dailySlots) } : {}),
        ...(rule.label !== undefined ? { label: rule.label } : {}),
    })) ?? [];
}
/** The full rule set of one raw cloud model row. */
function cloudModelRates(model) {
    return {
        base: toPricing(model),
        contextTiers: toTiers(model.contextTiers),
        dailySlots: toSlots(model.dailySlots),
        timeRules: toTimeRules(model.timeRules),
    };
}
/**
 * Flatten one cloud feed into a pricing table: every `modelId` becomes a key
 * and every alias becomes a key holding the same rule set. Aliases land
 * first, ids last, so a model id always wins a collision with another
 * model's alias.
 * @param feed - the coerced cloud feed.
 * @returns the flat table keyed by model ids and aliases.
 */
export function cloudToTable(feed) {
    const table = {};
    for (const model of feed.models) {
        for (const alias of model.aliases ?? []) {
            if (alias !== '' && !(alias in table))
                table[alias] = cloudModelRates(model);
        }
    }
    for (const model of feed.models)
        table[model.modelId] = cloudModelRates(model);
    return table;
}
// ---------------------------------------------------------------------------
// Per-record rate resolution (the analyzer's rule chain)
// ---------------------------------------------------------------------------
/** The context tier matching a context size: the highest threshold it reaches. */
function resolveTier(tiers, contextSize) {
    let best = null;
    for (const tier of tiers) {
        if (tier.threshold <= contextSize && (best === null || tier.threshold > best.threshold))
            best = tier;
    }
    return best;
}
/** The local minute-of-day of a Unix-seconds timestamp under a tz offset in hours. */
function localMinuteOfDay(epochSeconds, tzOffsetHours) {
    const local = epochSeconds + tzOffsetHours * 3600;
    const secondOfDay = ((local % 86400) + 86400) % 86400;
    return Math.floor(secondOfDay / 60);
}
/** The ISO weekday (1=Monday … 7=Sunday) of a Unix-seconds timestamp under a
 * tz offset in hours: 1970-01-01 was a Thursday, so local day 0 maps to 4. */
function localWeekday(epochSeconds, tzOffsetHours) {
    const localDay = Math.floor((epochSeconds + tzOffsetHours * 3600) / 86400);
    return (((localDay + 3) % 7) + 7) % 7 + 1;
}
/** The first peak slot that applies to the timestamp — its windows contain the
 * local minute and its `daysOfWeek` (absent = every day) includes the local
 * weekday; -1 when off-peak. Slots skipped on the weekday check do not stop
 * the search, so a weekend inside a weekday-only window still bills off-peak. */
function matchingSlot(slots, epochSeconds, tzOffsetHours) {
    if (slots === undefined || slots.length === 0)
        return -1;
    const minute = localMinuteOfDay(epochSeconds, tzOffsetHours);
    const weekday = localWeekday(epochSeconds, tzOffsetHours);
    for (let index = 0; index < slots.length; index++) {
        const days = slots[index].daysOfWeek;
        if (days !== undefined && days.length > 0 && !days.includes(weekday))
            continue;
        for (const window of slots[index].windows) {
            if (window.startMinute <= minute && minute < window.endMinute)
                return index;
        }
    }
    return -1;
}
/**
 * Resolve the rate one request was billed at, mirroring the analyzer's chain:
 * the time rule covering the timestamp first (its tiers, its slots), else
 * the model root (its tiers, its slots), else the base rates.
 * @param rates - the model's full rule set.
 * @param timeMs - the request's epoch milliseconds.
 * @param contextTokens - the request's input-side tokens (tier approximation).
 * @param tzOffsetHours - local tz offset in hours for peak windows
 * (defaults to the host's).
 * @returns the billed prices plus the identity they resolved through.
 */
export function resolveRate(rates, timeMs, contextTokens, tzOffsetHours = -new Date().getTimezoneOffset() / 60) {
    const seconds = Math.floor(timeMs / 1000);
    const rule = rates.timeRules.find(r => seconds >= r.startTime && seconds <= r.endTime) ?? null;
    const tiers = rule?.contextTiers ?? rates.contextTiers;
    const tier = resolveTier(tiers, contextTokens);
    // Peak slots hang on each node itself (the rule's, the tier's, or the
    // model root's) — a rule without slots bills flat inside its window, they
    // never inherit down from the root.
    const node = tier !== null
        ? { rates: tier.rates, slots: tier.dailySlots ?? [] }
        : rule !== null
            ? { rates: rule.rates, slots: rule.dailySlots ?? [] }
            : { rates: rates.base, slots: rates.dailySlots };
    const slot = matchingSlot(node.slots, seconds, tzOffsetHours);
    return {
        prices: slot >= 0 ? node.slots[slot].rates : node.rates,
        key: {
            ruleStart: rule?.startTime ?? 0,
            ruleEnd: rule?.endTime ?? 0,
            tier: tier?.threshold ?? 0,
            slot,
        },
    };
}
/**
 * Look the prices of a rate identity back up under the current rule set —
 * the re-pricing path for aggregated rows. Structural drift (a rule window
 * or tier threshold that no longer exists) falls back toward the base rates,
 * so an edited table degrades gracefully instead of mis-billing.
 * @param rates - the model's full rule set.
 * @param key - the identity one aggregation row carries.
 * @returns the prices the key resolves to.
 */
export function ratesForKey(rates, key) {
    const rule = key.ruleStart !== 0 || key.ruleEnd !== 0
        ? rates.timeRules.find(r => r.startTime === key.ruleStart && r.endTime === key.ruleEnd) ?? null
        : null;
    const tiers = rule?.contextTiers ?? rates.contextTiers;
    const tier = key.tier > 0 ? tiers.find(t => t.threshold === key.tier) ?? null : null;
    // Same node chain as resolveRate: peak slots hang on the node itself.
    const node = tier !== null
        ? { rates: tier.rates, slots: tier.dailySlots ?? [] }
        : rule !== null
            ? { rates: rule.rates, slots: rule.dailySlots ?? [] }
            : { rates: rates.base, slots: rates.dailySlots };
    return key.slot >= 0 ? node.slots[key.slot]?.rates ?? node.rates : node.rates;
}
/**
 * Billed cost of one totals row at resolved prices: each bucket billed at
 * its own per-million rate, cache buckets billed at their rate when present
 * and at the plain input rate otherwise (providers that fold cache tokens
 * into input still bill them, just at the same rate).
 * @param totals - the aggregated token buckets.
 * @param prices - the resolved per-million prices.
 * @returns the cost in ¥.
 */
export function costOf(totals, prices) {
    const M = 1_000_000;
    const cacheRead = prices.cacheReadPerMillion ?? prices.inputPerMillion;
    const cacheWrite = prices.cacheWritePerMillion ?? prices.inputPerMillion;
    return (totals.inputTokens * prices.inputPerMillion
        + totals.outputTokens * prices.outputPerMillion
        + totals.cacheReadTokens * cacheRead
        + totals.cacheWriteTokens * cacheWrite) / M;
}
// ---------------------------------------------------------------------------
// File store: cloud mirror + manual overrides
// ---------------------------------------------------------------------------
/** Read one JSON file of a data directory, or null when absent/unreadable. */
async function readJsonFile(dir, name) {
    let text;
    try {
        text = await readFile(join(dir, name), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        console.error(`[token-usage] cannot read ${name}:`, error);
        return null;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        console.error(`[token-usage] ${name} is not valid JSON; treating as absent`);
        return null;
    }
}
function isModelPricing(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const pricing = value;
    return isRate(pricing.inputPerMillion) && isRate(pricing.outputPerMillion)
        && (pricing.cacheReadPerMillion === undefined || isRate(pricing.cacheReadPerMillion))
        && (pricing.cacheWritePerMillion === undefined || isRate(pricing.cacheWritePerMillion));
}
/**
 * Coerce a hand-edited file body into flat table entries (base rates only):
 * non-object values read as empty, invalid entries drop.
 * @param value - the parsed `pricing.json` content.
 * @returns model id → base rates.
 */
export function coercePricingTable(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return {};
    const table = {};
    for (const [model, entry] of Object.entries(value)) {
        if (model === '' || !isModelPricing(entry))
            continue;
        table[model] = entry;
    }
    return table;
}
/** The hand-maintained entries of one data directory ({} when absent/broken). */
async function readManualPricing(dir) {
    return coercePricingTable(await readJsonFile(dir, PRICING_FILE));
}
/**
 * The synced cloud table of one data directory: the coerced feed mirror
 * flattened through {@link cloudToTable} ({} when absent, broken, or non-RMB).
 */
async function readSyncedPricing(dir) {
    const feed = coerceCloudPricing(await readJsonFile(dir, PRICING_CCSA_FILE));
    return feed === null ? {} : cloudToTable(feed);
}
/**
 * Load the merged pricing table of one data directory: the synced cloud
 * mirror as the base, the hand-edited `pricing.json` layered on top — a
 * manual entry wins for its whole model (base rates, no cloud rules), so
 * manual tweaks survive re-syncs. A missing or malformed file contributes
 * nothing, keeping the stats route alive while the user fixes their table.
 * @param dir - the plugin's data directory.
 * @returns the validated, merged table (possibly empty).
 */
export async function readPricingTable(dir) {
    const merged = { ...await readSyncedPricing(dir) };
    for (const [model, base] of Object.entries(await readManualPricing(dir))) {
        merged[model] = { base, contextTiers: [], dailySlots: [], timeRules: [] };
    }
    return merged;
}
/**
 * The effective USD conversion rate (RMB per USD) of one data directory:
 * the cloud feed envelope's `usdExchangeRate` when it carries a usable one,
 * else {@link DEFAULT_USD_EXCHANGE_RATE}. Absent, malformed, or non-RMB
 * mirrors fall back the same way — display conversion never blocks on a
 * broken feed. Hand-edited `pricing.json` carries no rate and never wins.
 * @param dir - the plugin's data directory.
 * @returns the positive rate the stats page converts display costs with.
 */
export async function readUsdExchangeRate(dir) {
    const feed = coerceCloudPricing(await readJsonFile(dir, PRICING_CCSA_FILE));
    return feed?.usdExchangeRate ?? DEFAULT_USD_EXCHANGE_RATE;
}
/**
 * Fetch the cloud pricing feed and mirror it verbatim into
 * `<data dir>/pricing.ccsa.json` (atomically: temp file + rename). The raw
 * feed is stored as received; the flatten-and-merge happens on read.
 * @param dir - the plugin's data directory.
 * @param url - the feed URL (the config override or the default gitee feed).
 * @returns the sync summary.
 */
export async function syncCloudPricing(dir, url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok)
        throw new Error(`HTTP ${String(response.status)}`);
    const text = await response.text();
    // Mirror the analyzer's payload cap: refuse feeds too big to be sane.
    if (text.length > 1_048_576)
        throw new Error('feed exceeds the 1MB limit');
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new Error('feed is not valid JSON');
    }
    const feed = coerceCloudPricing(value);
    if (feed === null)
        throw new Error('feed is not a valid RMB pricing table');
    const target = join(dir, PRICING_CCSA_FILE);
    const tmp = join(dir, `${PRICING_CCSA_FILE}.tmp`);
    // A fresh install may not have recorded any usage yet, so the data dir can
    // legitimately not exist — create it (idempotent) before the mirror lands.
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    await rename(tmp, target);
    return {
        version: feed.version,
        updatedAt: feed.updatedAt,
        models: feed.models.length,
        aliases: feed.models.reduce((sum, model) => sum + (model.aliases?.length ?? 0), 0),
        usdExchangeRate: feed.usdExchangeRate ?? DEFAULT_USD_EXCHANGE_RATE,
    };
}
//# sourceMappingURL=pricing.js.map