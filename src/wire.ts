/**
 * Browser-safe wire vocabulary of the token-usage plugin: the stats endpoint
 * path and the JSON shapes the web settings page consumes. No runtime imports
 * and no I/O, so the host half (route handler) and the browser half (settings
 * page) share one vocabulary, and the client bundle can inline this module.
 *
 * @module token-usage/wire
 */

import type { AuxKind, UsageRecord } from './usage-record.ts'

export type { AuxKind, UsageFields, UsageRecord } from './usage-record.ts'

/** The stats endpoint path, served by the host half's webServer route. */
export const STATS_PATH = '/token-usage/stats'

/** The pricing-overview endpoint path: the full cloud-mirror model list,
 * filter-free by design — the overview is not a filtered usage view. */
export const PRICING_PATH = '/token-usage/pricing'
export const PRICING_SYNC_PATH = '/token-usage/pricing-sync'
export const ASSOCIATIONS_PATH = '/token-usage/pricing-associations'

/** Returned only after a validated pricing mirror has been saved. */
export interface PricingSyncResult {
  version: number
  updatedAt: number
  models: number
  aliasPatterns: number
  usdExchangeRate: number
}

/** How much of the stats payload a consumer asked for. `full` is the
 * settings page's whole CostedSummary; `session` is the usage tab; `chip`
 * is the header strip (totals only). */
export type StatsFields = 'chip' | 'session' | 'full'

/** Encode one repeated query key (`sessionId=a&sessionId=b`). Empty list yields ''. */
export function encodeRepeatedParam(key: string, values: readonly string[]): string {
  return values.map(value => `${key}=${encodeURIComponent(value)}`).join('&')
}

/**
 * Parse every occurrence of `key` off a URL or `URLSearchParams`, dropping
 * blanks and duplicates, preserving first-seen order.
 */
export function decodeRepeatedParam(source: URL | URLSearchParams, key: string): string[] {
  const params = source instanceof URL ? source.searchParams : source
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of params.getAll(key)) {
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * One child-row group: the row's id (first token) plus every session id
 * folded into that row. Tree scope sends `[child, ...descendants]`; session
 * scope sends `[child]` alone. Tokens are comma-joined on the wire.
 */
export interface ChildGroup {
  id: string
  sessionIds: readonly string[]
}

/** Encode child groups as repeated `childId=<id>[,member…]` parameters. */
export function encodeChildGroups(groups: readonly (readonly string[])[]): string {
  return groups
    .filter(group => group.length > 0 && group[0] !== '')
    .map(group => `childId=${encodeURIComponent(group.join(','))}`)
    .join('&')
}

/** Parse `childId=` groups; the first comma-separated token is the row id. */
export function decodeChildGroups(source: URL | URLSearchParams): ChildGroup[] {
  const params = source instanceof URL ? source.searchParams : source
  const seen = new Set<string>()
  const out: ChildGroup[] = []
  for (const value of params.getAll('childId')) {
    if (value === '') continue
    const sessionIds = value.split(',').filter(id => id !== '')
    const id = sessionIds[0]
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push({ id, sessionIds })
  }
  return out
}

/**
 * Build the stats query string (including the leading `?`, or '' when
 * unconstrained). `fields: 'full'` is omitted — that is the default the
 * settings page already hits.
 */
export function encodeStatsQuery(options: {
  sessionIds?: readonly string[]
  childGroups?: readonly (readonly string[])[]
  fields?: StatsFields
}): string {
  const parts: string[] = []
  if (options.sessionIds !== undefined && options.sessionIds.length > 0) {
    parts.push(encodeRepeatedParam('sessionId', options.sessionIds))
  }
  const children = options.childGroups !== undefined ? encodeChildGroups(options.childGroups) : ''
  if (children !== '') parts.push(children)
  if (options.fields !== undefined && options.fields !== 'full') {
    parts.push(`fields=${options.fields}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

/**
 * Encode a session-scope id list as a `sessionId=` query fragment pair:
 * every id becomes its own `sessionId=<encoded>` parameter (RFC-style
 * `?a=1&a=2`), so a parent-and-children fetch aggregates the whole subtree
 * in one request. The empty list yields '' (no query string at all).
 * @param ids - the session ids to filter by.
 */
export function encodeSessionScope(ids: readonly string[]): string {
  return encodeStatsQuery({ sessionIds: ids })
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
export function decodeSessionScope(source: URL | URLSearchParams): string[] {
  return decodeRepeatedParam(source, 'sessionId')
}

/**
 * The quota endpoint path: the input-bar quota button polls this for the
 * current provider's rate-limit / balance snapshot. Served by the host
 * half's quota route; the query carries `?session=<id>` so the host can
 * resolve the provider the ACTIVE session is using.
 */
export const QUOTA_PATH = '/token-usage/quota'

/** The migration-progress endpoint path, polled by the browser card. */
export const MIGRATION_PATH = '/token-usage/migration'

/**
 * The directory-guard endpoint path, consulted by the browser card before a
 * staged directory save commits. The settings wire swallows a refused write
 * (the bound scope recovers silently and never rejects), so this route is the
 * one channel that can tell the card WHY a save would not land.
 */
export const DIR_GUARD_PATH = '/token-usage/dir-guard'

/**
 * The full-sync endpoint path: the card's manual "scan again" affordance.
 * `POST` starts one full scan over every session log (the same scan the
 * one-shot startup sync ran on first install — list + read + dedupe), and
 * `GET` returns the live progress. The scan is fire-and-forget on the host
 * side, so the card polls while it runs.
 */
export const FULL_SYNC_PATH = '/token-usage/full-sync'

/** The guard's verdict for one would-be directory save. */
export interface DirectoryGuardView {
  /** True when the Host's section validator would refuse the save right now. */
  blocked: boolean
  /** Sessions mid-conversation (an open turn) at verdict time, for the notice's number. */
  interactingSessions: number
}

/**
 * The view of one full-sync run: what the route returns to a poll, and what
 * the card's section reads. `idle` means no run has been triggered (or the
 * last one settled and the card cleared it); `running` carries the live
 * counts the card renders as a progress bar; `done` and `failed` are the
 * terminal states the card holds on screen until the next run.
 */
export type FullSyncView =
  | { status: 'idle' }
  | { status: 'running'; processed: number; total: number; added: number; skipped: number; removed: number; failedSessions: number }
  | { status: 'done'; processed: number; total: number; added: number; skipped: number; removed: number; failedSessions: number }
  | { status: 'failed'; error: string }

/** Aggregated token counts over one group of records. */
export interface UsageTotals {
  /** Number of recorded provider-billed calls: plain requests plus
   * compaction summarize requests (records without provider usage count
   * here). Failed requests never join this count — see {@link failures}. */
  requests: number
  /** Uncached input tokens; billed input = input + cacheRead + cacheWrite. */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-hit input tokens. */
  cacheReadTokens: number
  /** Cache-write input tokens. */
  cacheWriteTokens: number
  /** Compaction summarize requests in this group; absent on legacy rollups
   * (reads as 0). Plain requests = `requests - (compactions ?? 0)`. */
  compactions?: number
  /** Failed model requests in this group (`turn/end` LLM errors plus
   * `llm/retry` scheduled after a failed attempt); absent on legacy
   * rollups and pre-failure shapes (reads as 0). Success rate =
   * requests / (requests + failures) is attempt-level, not turn-level. */
  failures?: number
  /** Failure counts by the provider-neutral `LlmFailure.code`
   * (`{ RATE_LIMIT: 16, TRANSPORT: 2, … }`); absent when the
   * group holds no failures or the shape predates the key (reads as an
   * empty map). Sums to `failures` when present. Codes are an open set:
   * unknown future codes read verbatim. */
  failuresByCode?: Record<string, number>
  /** Internal accumulators behind the model card's performance view: the
   * streaming samples' tokens-per-second and first-token-latency sums with
   * their count, plus the end-to-end latency sum and valid timing count.
   * Requests without timing never contribute to a performance mean.
   * Absent on legacy rollups and
   * pre-timing shapes (reads as no samples) — the means are derived at the
   * cost layer, never stored. Timing figures follow the records' own
   * `latencyMs` / `firstTokenLatencyMs`; a streaming sample is one whose
   * generation span (latency − first token) reached the recorder's
   * streaming threshold, so non-streaming one-shot responses never poison
   * the speed mean. */
  perfStreamTpsSum?: number
  perfStreamFirstMsSum?: number
  perfStreamCount?: number
  perfLatencyMsSum?: number
  perfLatencyCount?: number
}

/** Per-model performance means the model card's performance view renders.
 * Derived at the cost layer from the totals' timing accumulators — never
 * persisted itself, so a filter/merge re-derivation stays exact. */
export interface ModelPerf {
  /** Mean output speed over the streaming samples, tokens per second. */
  tokensPerSec: number
  /** Mean first-token latency over the same streaming samples, ms. */
  firstTokenMs: number
  /** Mean end-to-end latency over successful requests with valid timing, ms. */
  latencyMs: number
  /** Successful requests with valid latency; untimed requests are excluded. */
  timedRequests: number
  /** Streaming sample count the speed/first-token means fold from; below
   * {@link MIN_PERF_SAMPLES} the row reads 「样本不足」 instead of a full
   * figures cell. */
  samples: number
}

/** Smallest streaming sample count a performance figures cell trusts; below
 * it the row still shows its mean speed but annotated 「样本不足」. */
export const MIN_PERF_SAMPLES = 5

/** One per-day aggregation row, keyed by local date `YYYY-MM-DD`. */
export interface UsageDayRow {
  day: string
  totals: UsageTotals
}

/** One per-request token total in time order (session-scoped reads only).
 * The usage tab's `fields=session` response is already time-bucketed: `count`
 * and `end` are set, and the chart plots the points without folding again.
 * A raw (unbucketed) point has only `time` + `tokens`. */
export interface RequestPoint {
  /** Session-event wall time, or the bucket start when `count` is set. */
  time: number
  /** Total tokens across the four buckets (0 for a request without usage). */
  tokens: number
  /** Requests folded into this bucket; absent on a raw per-request point. */
  count?: number
  /** Bucket end (exclusive), epoch ms; absent on a raw per-request point. */
  end?: number
}

/** Per-child row the usage tab's subagent table reads (no chart / pricing). */
export interface ChildUsageSummary {
  costState?: CostState
  total: UsageTotals
  totalCost: number
  unpricedModels: string[]
}

/** One per-hour × per-model aggregation row, keyed by local `YYYY-MM-DDTHH`. */
export interface UsageHourRow {
  hour: string
  model: string
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
  /** ISO weekdays (1=Monday … 7=Sunday) the slot applies to, as validated at
   * coercion; absent or empty = every day. */
  daysOfWeek?: number[]
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
 * tier, then peak slot.
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
 * The pricing table: model id → full rule set, loaded from
 * `<data dir>/pricing.ccsa.json` (the cloud mirror; see pricing.ts).
 * Models absent from the table are unpriced: their cost counts as 0 and they
 * surface in {@link UsageSummary.unpricedModels}.
 */
export type PricingTable = Record<string, ModelRates>

export type CostState = 'ready' | 'pricing-unavailable' | 'history-incomplete'
export type PricingUnavailableReason = 'missing' | 'unreadable' | 'invalid-json' | 'invalid-feed'
export type AssociationStorageError = 'unreadable' | 'invalid-json' | 'invalid-file'

export interface PricingAssociation {
  sourceModel: string
  targetModelId: string
}

export interface PricingAssociationStatus extends PricingAssociation {
  state: 'active' | 'automatic-takeover' | 'target-missing' | 'pricing-unavailable'
  resolvedTargetModelId?: string
  automaticModelId?: string
  targetDiffers?: boolean
}

export interface PricingAssociationsPayload {
  feedVersion?: number
  directoryToken: string
  revision: number | null
  storageState: 'ready' | 'unavailable'
  storageError?: AssociationStorageError
  pricingAvailable: boolean
  pricingUnavailableReason?: PricingUnavailableReason
  writesPaused: boolean
  associations: PricingAssociationStatus[]
  resolution?: ModelResolution
}

export interface SavePricingAssociation extends PricingAssociation {
  revision: number
  directoryToken: string
}

export interface DeletePricingAssociation {
  sourceModel: string
  revision: number
  directoryToken: string
}

export interface ModelResolution {
  rawName: string
  status: 'matched' | 'unmatched' | 'ambiguous'
  modelId?: string
  method?: 'id' | 'normalized-id' | 'pattern' | 'manual'
  strippedPrefix: boolean
  candidates: string[]
  association?: PricingAssociationStatus
  /** Preserves the unmatched/ambiguous reason when a manual choice is active. */
  automatic?: ModelResolution
}

/**
 * One model row of the pricing overview: the shape the cloud feed carries
 * (modelId + alias patterns + upstream family) plus the full rule set.
 * The overview keeps one row per model rather than enumerating aliases.
 */
export interface PricingOverviewModel {
  modelId: string
  /** Validated full-name regexes; empty when the feed carries none. */
  aliasPatterns: readonly string[]
  /** The feed's upstream family grouping; absent rows group under `other`. */
  family?: string
  rules: ModelRates
}

/** The payload served at {@link PRICING_PATH}: every cloud-mirror model row
 * plus the display-currency stamps the settings page converts with (same
 * region source as the stats payload). */
export interface PricingOverviewPayload {
  feedVersion?: number
  pricingUnavailableReason?: PricingUnavailableReason
  costState?: CostState
  models: readonly PricingOverviewModel[]
  /** The display currency the page converts rate figures into. Amounts on
   * the wire (rules rates) remain RMB. */
  currency: DisplayCurrency
  /** Effective RMB-per-USD rate (feed value, else the built-in default);
   * the divisor when `currency` is USD. */
  usdExchangeRate: number
}

/** One per-day × per-model × per-rate aggregation row. */
export interface UsageRateRow {
  day: string
  model: string
  rate: RateKey
  totals: UsageTotals
}

/**
 * One per-(kind, day, model, rate) aggregation row of the auxiliary (bypass)
 * model requests: Auto review, session-title generation, and translation.
 * These calls are not part of any conversation turn, so they carry no session
 * dimension — but they are provider-billed requests of a concrete model, so
 * they fold into `rateRows` / `byModel` / the totals while this separate
 * dimension keeps the settings page's "runtime overhead" breakdown (and its
 * own cost) independent of the conversation filters that produce the
 * per-session table.
 */
export interface UsageAuxRow {
  /** Which bypass call produced the rows folded into this cell. */
  auxKind: AuxKind
  day: string
  model: string
  rate: RateKey
  totals: UsageTotals
}

/** One per-model row nested under an auxiliary kind: the model's share of one
 * bypass-request kind, keyed by the canonical id (a priced alias family folds
 * onto its modelId, unpriced names keep their spelling). The runtime-overhead
 * tab renders these one line each beneath their kind's aggregate row. */
export interface UsageAuxModelRow {
  model: string
  totals: UsageTotals
  /** Billed cost (¥) of this model's requests of the kind; 0 when unpriced. */
  cost: number
}

/** One per-kind aggregate of the auxiliary requests, priced at the rate
 * identities its cells resolved through. */
export interface UsageAuxKindRow {
  auxKind: AuxKind
  totals: UsageTotals
  /** Billed cost (¥) of this kind; 0 when its model is unpriced. */
  cost: number
  /** Per-model rows of this kind, request-count descending then model name. */
  byModel: UsageAuxModelRow[]
}

/**
 * The auxiliary-request layer of the stats payload: the settings page's
 * "runtime overhead" block renders the per-kind rows, and the total reconciles
 * with the share of the top-line totals those bypass calls contributed.
 */
export interface AuxSummary {
  /** Totals over every recorded auxiliary request. */
  total: UsageTotals
  /** Billed cost (¥) of the auxiliary requests under the current table. */
  cost: number
  /** Per-kind rows in the fixed display order, kinds without data omitted. */
  byKind: UsageAuxKindRow[]
}

/**
 * One per-session × per-day × per-model × per-rate aggregation row: the
 * session dimension the settings page's cross-session table folds from.
 * Every granule pulls its weight — a session usually spans days (the day
 * key keeps a date-filtered row to the window's share), the model key keeps
 * a model-filtered row honest, the rate identity keeps cost re-pricing
 * free, and `lastTime` sorts the table by recent activity. Failure rows
 * (`model === ''`) fold in like every other record: the session dimension
 * keeps the same totals semantics as rateRows, so request counts reconcile.
 */
export interface UsageSessionRow {
  sessionId: string
  day: string
  model: string
  rate: RateKey
  /** Newest record time folded into this cell (max over the fold); the
   * session table's "last active" column. */
  lastTime: number
  totals: UsageTotals
}

/**
 * One final row of the settings page's session table: the server-side fold
 * of {@link UsageSessionRow} cells over one top-level session plus its
 * whole subtree, sorted by cost and truncated top-N before it crosses the
 * wire. Subagents never surface as rows of their own — the row's
 * `childCount` badge is their only visibility here. Identity fields ride
 * in the row — the server folds, sorts, and truncates, so the client never
 * reassembles titles or directories.
 */
export interface SessionUsageRow {
  sessionId: string
  /** Log-backed latest-wins title; omitted when no `session/title` event
   * ever landed (the client falls back to a short session id + times). */
  title?: string
  /** The session header's working directory, verbatim; omitted when the
   * header carried none. The client derives the tail segment and grouping. */
  cwd?: string
  /** How many descendant sessions folded into this row (the subagent
   * badge); omitted when the subtree holds none. */
  childCount?: number
  totals: UsageTotals
  /** Billed cost (¥) over the row's cells under the current table. */
  cost: number
  /** Start of the local day of the row's earliest cell — the fallback
   * identity's "from" bound (day granularity; titles cover the rest). */
  firstTime: number
  /** Newest record time in the row (max over every folded cell). */
  lastTime: number
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
  /** Per-hour × per-model rows, ascending by hour then model; the web page
   * folds them by hour to draw the single-day trend chart. */
  byHour: UsageHourRow[]
  /** Per-model rows, descending by request count. */
  byModel: UsageModelRow[]
  /** Per-day × per-model × per-rate rows, day then model then rate ascending;
   * lets the route re-aggregate any day range × model filter without
   * rereading files, and re-price history under the current table. */
  rateRows: UsageRateRow[]
  /** Per-(kind, day, model, rate) rows of the auxiliary bypass requests
   * (Auto review / session title / translation / other). Their usage also
   * folds into the totals, byDay, byHour, byModel, rateRows, and recent
   * window; this dimension only backs the runtime-overhead breakdown.
   * A summary read without raw history carries an empty list. */
  auxRows: UsageAuxRow[]
  /** Per-session × per-day × per-model × per-rate rows, session then day
   * then model then rate ascending; the settings page's session table folds
   * from these (see {@link UsageSessionRow}). */
  bySession: UsageSessionRow[]
  /** The most recent records, descending by time. */
  recent: UsageRecord[]
}

/** A per-model row carrying its billed cost (¥); 0 when the model is unpriced. */
export type CostedModelRow = UsageModelRow & { cost: number; perf?: ModelPerf }

/** A per-session aggregation cell carrying its billed cost (¥); 0 when the
 * model is unpriced — priced from the same rate identity the per-model cost
 * folds from, so the session table's cost column reconciles with the
 * summary card for free. */
export type CostedSessionCell = UsageSessionRow & { cost: number }

/** One project fold over all root-session rows, before the session list's
 * top-N cut. Directory tails remain the display grouping key. */
export interface ProjectUsageRow {
  name: string
  cwd?: string
  sessionCount: number
  totals: UsageTotals
  cost: number
}

/** The currency the stats page renders cost figures in. The amounts on the
 * wire stay RMB — this only names the display convention. */
export type DisplayCurrency = 'CNY' | 'USD'

/**
 * The display currency a mirror region implies: `overseas` (GitHub) shows
 * USD, `domestic` (Gitee) and the unset default show CNY. Only the region
 * pick decides — an explicit `pricingUrl` never changes the display.
 * @param region - the effective `pricingRegion` (undefined when unset).
 * @returns the display currency of the stats page.
 */
export function currencyOfRegion(region: 'domestic' | 'overseas' | undefined): DisplayCurrency {
  return region === 'overseas' ? 'USD' : 'CNY'
}

/**
 * The token aggregation plus the cost layer — what {@link attachCosts}
 * produces before the route stamps the display-currency metadata.
 */
export interface CostedSummary extends TokenSummary {
  feedVersion?: number
  associationStorageError?: AssociationStorageError
  pricingUnavailableReason?: PricingUnavailableReason
  costState: CostState
  modelResolutions: ModelResolution[]
  /** Absolute data directory the summary was computed from. */
  dataDir: string
  /** Billed cost (¥); unpriced models count 0. Trust only when costState is ready. */
  totalCost: number
  /** Models with usage but no entry in the pricing table, byModel order. */
  unpricedModels: string[]
  /** The snapshot pricing dictionary, including resolved names for details. */
  pricing: PricingTable
  /** Per-model rows with their billed cost attached. */
  byModel: CostedModelRow[]
  /** Per-session cells with their billed cost attached (see
   * {@link CostedSessionCell}); the route folds these into
   * {@link SessionUsageRow}s for the session table. */
  bySession: CostedSessionCell[]
  /** The auxiliary (bypass) request layer: the settings page's runtime-overhead
   * block. Its usage is already included in the totals above; this field only
   * splits it out by kind and prices it for display. */
  aux: AuxSummary
}

/** The full stats payload served at {@link STATS_PATH}. A discriminated
 * union over the two scope modes the route serves:
 * - `'whole'`: the settings page's whole-log read. The `requestSeries`
 *   field is absent (the page plots hours/days), so its `TrendChart`
 *   falls back to the `byDay` / `byHour` rows. The session table reads
 *   `sessionRows` — the server-side folded, sorted, truncated final
 *   rows (always folded over subagent subtrees); the granular
 *   `bySession` cells stay behind the route (sending them would only
 *   duplicate the fold on the wire).
 * - `'session'`: the conversation view tab's session-scoped read. The
 *   `sessionIds` field lists every requested id (the parent + its
 *   subagent children when the scope is "tree"), and `requestSeries`
 *   is the per-request series the chart plots at request granularity.
 *
 * Both branches share every {@link CostedSummary} field except the
 * granular `bySession` (stripped from the wire) plus the
 * display-currency metadata, so a consumer can read `total` /
 * `totalCost` / `pricing` without narrowing first.
 */
type CostedSummaryWire = Omit<CostedSummary, 'bySession'>
export type StatsPayload = (CostedSummaryWire & {
  scope: 'whole'
  /** The session table's final rows: folded over subagent subtrees,
   * cost-sorted, top-N truncated, metadata attached. */
  sessionRows: readonly SessionUsageRow[]
  /** Complete project aggregates, independent of the session top-N cut. */
  projectRows: readonly ProjectUsageRow[]
  /** The display currency the page converts cost figures into. Amounts on
   * the wire (totalCost, byModel[].cost, pricing rates) remain RMB. */
  currency: DisplayCurrency
  /** Effective RMB-per-USD rate (feed value, else the built-in default);
   * the divisor when `currency` is USD. */
  usdExchangeRate: number
}) | (CostedSummaryWire & {
  scope: 'session'
  /** The session ids aggregated to produce this payload, in URL order. */
  sessionIds: readonly string[]
  /** Per-request token totals in time order; session-scoped reads always
   * include this, so the trend chart can plot request granularity. */
  requestSeries: readonly RequestPoint[]
  /** The display currency the page converts cost figures into. */
  currency: DisplayCurrency
  /** Effective RMB-per-USD rate (the divisor when `currency` is USD). */
  usdExchangeRate: number
  /** Direct-child breakdown keyed by child id, when the request named `childId`. */
  children?: Readonly<Record<string, ChildUsageSummary>>
})

/**
 * Default shape for code that doesn't need to discriminate the scope —
 * mostly test fixtures and the `chip` and `section` summary readers.
 * Adds `requestSeries?` as an optional field so legacy callers can read
 * either branch without narrowing first. Uses a base cost layer plus the
 * display metadata; for new code, narrow on `StatsPayload` instead.
 */
export interface UsageSummary extends Omit<CostedSummary, 'bySession'> {
  currency: DisplayCurrency
  usdExchangeRate: number
  /** Whole-scope payloads only: the settings page's session table rows
   * (see {@link SessionUsageRow}); absent on session-scoped reads. */
  sessionRows?: readonly SessionUsageRow[]
  /** Whole-scope complete projects; absent on older host payloads. */
  projectRows?: readonly ProjectUsageRow[]
  requestSeries?: readonly RequestPoint[]
  children?: Readonly<Record<string, ChildUsageSummary>>
  sessionIds?: readonly string[]
}

/** One normalized quota window tier, mirroring the tier vocabulary the
 * cc-switch research normalized providers onto: time-boxed windows for
 * coding-plan subscriptions, an open-ended balance tier for pay-as-you-go
 * accounts. `other` carries a window whose name fits no known period (a
 * gateway's open window vocabulary: "Credits", "Allowance") — display
 * leans on {@link QuotaWindow.name}, and only the granularity rank treats
 * it generically. Display adapts by tier (progress bar vs amount). */
export type QuotaTier = 'five_hour' | 'weekly' | 'monthly' | 'other' | 'balance'

/**
 * One provider quota window as the panel renders it. Percent fields carry
 * the two directions providers report (most coding plans report used,
 * MiniMax reports remaining); the panel derives whichever is missing.
 * Absolute amounts are balance semantics: `remainingValue` is what the
 * user cares about, `maxValue` (when known) enables a spend-progress bar.
 */
export interface QuotaWindow {
  tier: QuotaTier
  /** Used share of the window, 0–100; preferred over `remainingPercent`. */
  usedPercent?: number
  /** Remaining share of the window, 0–100. */
  remainingPercent?: number
  /** When the window resets, epoch ms; absent for balances. */
  resetAt?: number
  /** Remaining absolute amount (a balance, or a USD-metered quota). */
  remainingValue?: number
  /** Total absolute amount, when the provider reports one. */
  maxValue?: number
  /** Currency of the absolute fields. */
  unit?: 'usd' | 'cny'
  /** Which DeepSeek account purse a balance window came from. Absent on
   * API-key balances, which stay a single unlabeled amount. */
  balanceKind?: 'recharge' | 'bonus'
  /** The vendor's own name of the window ("Credits", "Allowance"), when it
   * fits no known period tier; the panel's column label prefers it over
   * the generic `other` copy. Absent on windows a tier already names. */
  name?: string
  /** The quota CARD a window belongs to when one payload aggregates
   * several (a gateway summarizing its whole upstream fleet): the card's
   * display title (vendor · plan · account), which the panel renders as a
   * section heading. Absent on single-source payloads. */
  card?: string
}

/** Why a quota query failed, normalized so the panel can pick friendly copy. */
export type QuotaErrorKind = 'auth' | 'no-credential' | 'signed-out' | 'http' | 'network' | 'parse'

/** The error face of a quota response. */
export interface QuotaError {
  kind: QuotaErrorKind
  /** Technical detail (status code, thrown message); the panel wraps it in
   * kind-specific locale copy. */
  message: string
}

/** The poll cadence the host asks the client to follow (seconds); stamped
 * on every payload variant so the button adapts to the plugin config. */
interface QuotaCadence {
  intervalSec: number
}

/** A successful quota read: the normalized windows of the current
 * provider, ready for the panel's adaptive grid. */
export interface QuotaSnapshot extends QuotaCadence {
  status: 'ok'
  /** Provider route key, exactly as session events carry it. */
  provider: string
  /** Human-readable provider name when one is resolvable. */
  providerName?: string
  /** Which adapter produced the windows (diagnostics). */
  adapterId: string
  /** When the snapshot was fetched, epoch ms. */
  fetchedAt: number
  /** Plan tier label when the provider reports one (e.g. Zhipu `data.level`). */
  planTier?: string
  windows: QuotaWindow[]
}

/** A failed quota read: the provider matched an adapter but the query
 * failed. The button stays visible (the provider IS supported) and the
 * panel shows the error with a retry. */
export interface QuotaFailure extends QuotaCadence {
  status: 'error'
  provider: string
  providerName?: string
  adapterId: string
  fetchedAt: number
  error: QuotaError
}

/** The full quota endpoint vocabulary. The hidden variants:
 * - `no-provider` — no provider in use is determinable yet (no activity,
 *   no default selection); the button hides until one appears.
 * - `unsupported` — the provider in use has no quota adapter; the button
 *   hides (switching providers brings it back).
 * - `disabled` — the quota feature is off in plugin config.
 */
export type QuotaPayload =
  | QuotaSnapshot
  | QuotaFailure
  | (QuotaCadence & { status: 'no-provider' })
  | (QuotaCadence & { status: 'unsupported'; provider: string; providerName?: string })
  | (QuotaCadence & { status: 'disabled' })

/** The windows of a payload, empty for every non-ok variant — the helper
 * the panel reuses for the trigger icon's color. */
export function quotaWindowsOf(payload: QuotaPayload): readonly QuotaWindow[] {
  return payload.status === 'ok' ? payload.windows : []
}
