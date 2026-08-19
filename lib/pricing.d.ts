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
import type { ModelPricing, ModelRates, PricingTable, RateKey, UsageTotals } from './wire.ts';
/** The hand-maintained pricing file inside the data directory. */
export declare const PRICING_FILE = "pricing.json";
/** The cloud-feed mirror written on every startup. */
export declare const PRICING_CCSA_FILE = "pricing.ccsa.json";
/**
 * The default domestic (China) cloud pricing feed: the model-price-table
 * repository the analyzer also pulls from (¥ per million tokens, currency
 * RMB). Overridden through the `pricingUrlDomestic` config key.
 */
export declare const DEFAULT_PRICING_URL_DOMESTIC = "https://gitee.com/oyw125/model-price-table/raw/master/model_pricing.json";
/**
 * The default overseas cloud pricing feed: the same model-price-table,
 * mirrored to GitHub because the gitee CDN is slow or unreliable outside
 * mainland China. Overridden through the `pricingUrlOverseas` config key.
 */
export declare const DEFAULT_PRICING_URL_OVERSEAS = "https://raw.githubusercontent.com/LaoYueHanNi/model-price-table/master/model_pricing.json";
/** Backward-compatible alias: the domestic (gitee) default feed. */
export declare const DEFAULT_PRICING_URL = "https://gitee.com/oyw125/model-price-table/raw/master/model_pricing.json";
/** Which cloud mirror the pricing sync prefers when no explicit URL is set. */
export type PricingRegion = 'domestic' | 'overseas';
/** The URL inputs of the pricing sync: an explicit single feed, or the
 * per-region mirrors plus the chosen region. */
export interface PricingSourceInput {
    /** Explicit single feed URL; wins over every region/mirror setting. */
    pricingUrl?: string;
    /** Domestic mirror override; defaults to the gitee feed. */
    pricingUrlDomestic?: string;
    /** Overseas mirror override; defaults to the github feed. */
    pricingUrlOverseas?: string;
    /** Which mirror to pull when `pricingUrl` is unset; defaults to `domestic`. */
    pricingRegion?: PricingRegion;
}
/**
 * Resolve the feed URL to fetch: an explicit `pricingUrl` wins outright;
 * otherwise `pricingRegion` picks the domestic (default) or overseas mirror,
 * each overridable through its own key. Deliberately no IP sniffing — the
 * deployer sets the region once in the profile config, so the choice is
 * predictable and never depends on a third-party geo lookup.
 */
export declare function resolvePricingUrl(input?: PricingSourceInput): string;
/** One raw rate node of the cloud feed. */
interface CloudRates {
    inputCostPerMillion: number;
    outputCostPerMillion: number;
    cacheReadCostPerMillion?: number;
    cacheCreationCostPerMillion?: number;
    dailySlots?: CloudSlot[];
}
/** One raw context tier of the cloud feed. */
interface CloudTier extends CloudRates {
    threshold: number;
}
/** One raw time rule of the cloud feed. */
interface CloudTimeRule extends CloudRates {
    label?: string;
    startTime: number;
    endTime: number;
    contextTiers?: CloudTier[];
}
/** One raw peak slot of the cloud feed. */
interface CloudSlot {
    label?: string;
    windows: Array<{
        startMinute: number;
        endMinute: number;
    }>;
    inputCostPerMillion: number;
    outputCostPerMillion: number;
    cacheReadCostPerMillion?: number;
    cacheCreationCostPerMillion?: number;
}
/** One raw model row of the cloud feed. */
export interface CloudPricingModel extends CloudRates {
    modelId: string;
    contextTiers?: CloudTier[];
    timeRules?: CloudTimeRule[];
    aliases?: string[];
}
/** The cloud feed envelope. */
export interface CloudPricingData {
    version: number;
    updatedAt: number;
    currency: string;
    models: CloudPricingModel[];
}
/**
 * Coerce an unknown value into the cloud feed shape, dropping invalid model
 * rows. A wrong envelope (non-array models, non-object) reads as null, and
 * so does a non-RMB `currency` — this plugin bills in ¥ only.
 * @param value - the parsed `pricing.ccsa.json` content.
 * @returns the feed, or null when the value is not a usable RMB feed.
 */
export declare function coerceCloudPricing(value: unknown): CloudPricingData | null;
/**
 * Flatten one cloud feed into a pricing table: every `modelId` becomes a key
 * and every alias becomes a key holding the same rule set. Aliases land
 * first, ids last, so a model id always wins a collision with another
 * model's alias.
 * @param feed - the coerced cloud feed.
 * @returns the flat table keyed by model ids and aliases.
 */
export declare function cloudToTable(feed: CloudPricingData): PricingTable;
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
export declare function resolveRate(rates: ModelRates, timeMs: number, contextTokens: number, tzOffsetHours?: number): {
    prices: ModelPricing;
    key: RateKey;
};
/**
 * Look the prices of a rate identity back up under the current rule set —
 * the re-pricing path for aggregated rows. Structural drift (a rule window
 * or tier threshold that no longer exists) falls back toward the base rates,
 * so an edited table degrades gracefully instead of mis-billing.
 * @param rates - the model's full rule set.
 * @param key - the identity one aggregation row carries.
 * @returns the prices the key resolves to.
 */
export declare function ratesForKey(rates: ModelRates, key: RateKey): ModelPricing;
/**
 * Billed cost of one totals row at resolved prices: each bucket billed at
 * its own per-million rate, cache buckets billed at their rate when present
 * and at the plain input rate otherwise (providers that fold cache tokens
 * into input still bill them, just at the same rate).
 * @param totals - the aggregated token buckets.
 * @param prices - the resolved per-million prices.
 * @returns the cost in ¥.
 */
export declare function costOf(totals: UsageTotals, prices: ModelPricing): number;
/**
 * Coerce a hand-edited file body into flat table entries (base rates only):
 * non-object values read as empty, invalid entries drop.
 * @param value - the parsed `pricing.json` content.
 * @returns model id → base rates.
 */
export declare function coercePricingTable(value: unknown): Record<string, ModelPricing>;
/**
 * Load the merged pricing table of one data directory: the synced cloud
 * mirror as the base, the hand-edited `pricing.json` layered on top — a
 * manual entry wins for its whole model (base rates, no cloud rules), so
 * manual tweaks survive re-syncs. A missing or malformed file contributes
 * nothing, keeping the stats route alive while the user fixes their table.
 * @param dir - the plugin's data directory.
 * @returns the validated, merged table (possibly empty).
 */
export declare function readPricingTable(dir: string): Promise<PricingTable>;
/** The outcome of one successful cloud sync, for the command's reply. */
export interface CloudSyncResult {
    version: number;
    updatedAt: number;
    models: number;
    aliases: number;
}
/**
 * Fetch the cloud pricing feed and mirror it verbatim into
 * `<data dir>/pricing.ccsa.json` (atomically: temp file + rename). The raw
 * feed is stored as received; the flatten-and-merge happens on read.
 * @param dir - the plugin's data directory.
 * @param url - the feed URL (the config override or the default gitee feed).
 * @returns the sync summary.
 */
export declare function syncCloudPricing(dir: string, url: string): Promise<CloudSyncResult>;
export {};
//# sourceMappingURL=pricing.d.ts.map