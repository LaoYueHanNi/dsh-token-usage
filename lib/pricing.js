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
 * time-rule container first, then context tier, then peak slot — and the
 * aggregation keeps rows per (day, model, rate identity), so re-pricing
 * under an updated table needs no rollup rebuild. The context size for tier
 * matching is approximated by the request's input-side tokens (input +
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
 * The default cloud pricing feed: the model-price-table repository the
 * analyzer also pulls from (¥ per million tokens, currency RMB). Override
 * with the `pricingUrl` config key.
 */
export const DEFAULT_PRICING_URL = 'https://gitee.com/oyw125/model-price-table/raw/master/model_pricing.json';
/** A positive (or zero) finite number; rates may be 0 but never negative. */
function isRate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
        ...(Array.isArray(node.dailySlots) ? { dailySlots: node.dailySlots.filter(isCloudSlot) } : {}),
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
function isCloudSlot(value) {
    return coerceSlot(value) !== null;
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
    return {
        windows,
        inputCostPerMillion: rates.inputCostPerMillion,
        outputCostPerMillion: rates.outputCostPerMillion,
        ...(rates.cacheReadCostPerMillion !== undefined ? { cacheReadCostPerMillion: rates.cacheReadCostPerMillion } : {}),
        ...(rates.cacheCreationCostPerMillion !== undefined ? { cacheCreationCostPerMillion: rates.cacheCreationCostPerMillion } : {}),
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
    return slots?.map(slot => ({ windows: slot.windows, rates: toPricing(slot) })) ?? [];
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
/** The first peak slot whose windows contain the timestamp's local minute; -1 when off-peak. */
function matchingSlot(slots, epochSeconds, tzOffsetHours) {
    if (slots === undefined || slots.length === 0)
        return -1;
    const minute = localMinuteOfDay(epochSeconds, tzOffsetHours);
    for (let index = 0; index < slots.length; index++) {
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
    };
}
//# sourceMappingURL=pricing.js.map