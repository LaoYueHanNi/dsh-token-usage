/**
 * Browser-safe wire vocabulary of the token-usage plugin: the stats endpoint
 * path and the JSON shapes the web settings page consumes. No runtime imports
 * and no I/O, so the host half (route handler) and the browser half (settings
 * page) share one vocabulary, and the client bundle can inline this module.
 *
 * @module token-usage/wire
 */

import type { UsageRecord } from './usage-record.ts'

export type { UsageFields, UsageRecord } from './usage-record.ts'

/** The stats endpoint path, served by the host half's webServer route. */
export const STATS_PATH = '/token-usage/stats'

/** Aggregated token counts over one group of records. */
export interface UsageTotals {
  /** Number of recorded requests (records without provider usage count here). */
  requests: number
  /** Uncached input tokens; billed input = input + cacheRead + cacheWrite. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-hit input tokens. */
  cacheReadTokens: number
  /** Cache-write input tokens. */
  cacheWriteTokens: number
}

/** One per-day aggregation row, keyed by local date `YYYY-MM-DD`. */
export interface UsageDayRow {
  day: string
  totals: UsageTotals
}

/** One per-model aggregation row (token counts only; see the cost layer below). */
export interface UsageModelRow {
  model: string
  totals: UsageTotals
}

/** Per-million-token prices of one rate node, in ¥ (RMB). */
export interface ModelPricing {
  /** Uncached input price, ¥ per million tokens. */
  inputPerMillion: number
  /** Output price, ¥ per million tokens. */
  outputPerMillion: number
  /** Cache-hit input price, ¥ per million tokens. */
  cacheReadPerMillion?: number
  /** Cache-write input price, ¥ per million tokens. */
  cacheWritePerMillion?: number
}

/** One peak window of a day, half-open [startMinute, endMinute) in local minutes. */
export interface RateWindow {
  startMinute: number
  endMinute: number
}

/** A peak-pricing slot: the rates that apply inside its windows. */
export interface DailySlot {
  /** Optional display label. */
  label?: string
  windows: RateWindow[]
  rates: ModelPricing
}

/** A context tier: the rates that apply once the context reaches the threshold. */
export interface ContextTier {
  /** Context size (tokens) at and above which this tier applies. */
  threshold: number
  rates: ModelPricing
  /** Tiers may carry their own peak slots (mirrors the analyzer's node chain). */
  dailySlots?: DailySlot[]
}

/** A time rule: the container whose rates (and tiers/slots) apply inside its window. */
export interface TimeRule {
  /** Optional display label. */
  label?: string
  /** Inclusive window bounds, Unix seconds. */
  startTime: number
  endTime: number
  rates: ModelPricing
  contextTiers?: ContextTier[]
  dailySlots?: DailySlot[]
}

/**
 * The full pricing of one model: the base rates plus the rule chain the
 * analyzer resolves per request — time-rule container first, then context
 * tier, then peak slot. A hand-edited entry contributes only `base` (manual
 * overrides replace the model's cloud rules wholesale).
 */
export interface ModelRates {
  base: ModelPricing
  contextTiers: ContextTier[]
  dailySlots: DailySlot[]
  timeRules: TimeRule[]
}

/** True when any rule dimension exists beyond the flat base rates. */
export function hasRateRules(rates: ModelRates): boolean {
  return rates.contextTiers.length > 0 || rates.dailySlots.length > 0 || rates.timeRules.length > 0
}

/**
 * The identity of the rate one record was billed at: which time rule (by its
 * window), which context tier (by its threshold), and which peak slot (by
 * its index into the node's slots). Holds rule identity, never price
 * numbers, so a price update re-prices history without a rollup rebuild.
 */
export interface RateKey {
  /** Time-rule window start (Unix seconds); 0 when no rule matched. */
  ruleStart: number
  /** Time-rule window end (Unix seconds); 0 when no rule matched. */
  ruleEnd: number
  /** Context-tier threshold; 0 when no tier matched. */
  tier: number
  /** Peak-slot index into the resolved node's slots; -1 when off-peak. */
  slot: number
}

/** The neutral key of an unpriced model's rows. */
export const UNPRICED_KEY: RateKey = { ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }

/** Whether a key is the neutral unpriced one. */
export function isUnpricedKey(key: RateKey): boolean {
  return key.ruleStart === 0 && key.ruleEnd === 0 && key.tier === 0 && key.slot === -1
}

/**
 * The merged pricing table: model id → full rule set, loaded from
 * `<data dir>/pricing.ccsa.json` (cloud mirror, full rules) layered under
 * `<data dir>/pricing.json` (hand-edited flat overrides; see pricing.ts).
 * Models absent from the table are unpriced: their cost counts as 0 and they
 * surface in {@link UsageSummary.unpricedModels}.
 */
export type PricingTable = Record<string, ModelRates>

/** One per-day × per-model × per-rate aggregation row. */
export interface UsageRateRow {
  day: string
  model: string
  rate: RateKey
  totals: UsageTotals
}

/**
 * The token-only aggregation shape: what the aggregation functions produce
 * and the rollup persists. No currency — cost is an additive layer computed
 * from the pricing table when the route serves the summary (attachCosts),
 * re-priced from the rate identities on every read.
 */
export interface TokenSummary {
  /** Totals over every recorded request. */
  total: UsageTotals
  /** Per-local-day rows, ascending by day. */
  byDay: UsageDayRow[]
  /** Per-model rows, descending by request count. */
  byModel: UsageModelRow[]
  /** Per-day × per-model × per-rate rows, day then model then rate ascending;
   * lets the route re-aggregate any day range × model filter without
   * rereading files, and re-price history under the current table. */
  rateRows: UsageRateRow[]
  /** The most recent records, descending by time. */
  recent: UsageRecord[]
}

/** A per-model row carrying its billed cost (¥); 0 when the model is unpriced. */
export type CostedModelRow = UsageModelRow & { cost: number }

/** The full stats payload served at {@link STATS_PATH}: the token aggregation plus the cost layer. */
export interface UsageSummary extends TokenSummary {
  /** Absolute data directory the summary was computed from. */
  dataDir: string
  /** Billed cost over every recorded request (¥); unpriced models count 0. */
  totalCost: number
  /** Models with usage but no entry in the pricing table, byModel order. */
  unpricedModels: string[]
  /** The active pricing table (user-maintained; empty when none is configured). */
  pricing: PricingTable
  /** Per-model rows with their billed cost attached. */
  byModel: CostedModelRow[]
}
