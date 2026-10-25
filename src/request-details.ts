/**
 * Pure rules of the conversation usage tab's live request pool (最新请求 /
 * 实时请求): the settled per-request speed gate, the per-request cache
 * assessment (the 50%/80% request-area policy with every exclusion reason),
 * and the route-sequence walk that marks a session's first request and
 * model-switch firsts. No I/O and no runtime imports beyond types, so the
 * stats route, its tests, and any future consumer share one implementation.
 *
 * The assessment NEVER touches the global hit-rate color scale
 * (client/format.ts bandOf) — that one keeps summarizing whole sessions and
 * models; this module judges one request at a time.
 *
 * @module token-usage/request-details
 */

import { PERF_STREAM_MIN_GEN_MS } from './stats.ts'
import type { RequestCacheExclusion, RequestDetailCache, RequestDetailState } from './wire.ts'

/**
 * DeepSeek context caching stores the prompt in 64-token blocks (provider
 * documentation). A request on these routes whose whole
 * cacheable input side is below one block cannot hit the cache, so its 0%
 * is explained by the input itself — an exclusion with evidence, not a
 * blanket minimum-token rule for every provider.
 */
const DEEPSEEK_CACHE_BLOCK_TOKENS = 64

/** Only these routes have a documented minimum; this is not an alert allowlist. */
const DEEPSEEK_BLOCK_PROVIDERS: ReadonlySet<string> = new Set(['deepseek-official', 'deepseek-account'])

/** Inputs of one request's cache assessment: the merged attempt's trusted
 * facts, plus the route-sequence exclusion the caller walked beforehand. */
export interface CacheAssessInput {
  state: RequestDetailState
  kind: 'request' | 'compaction' | 'failure' | 'aux'
  /** Provider route key, used only for the documented minimum-input rule. */
  provider?: string
  /** Uncached input count reported by the provider. */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  /** `cold-start` / `model-switch` when the route sequence walk excluded
   * this request; other exclusions derive from the fields above. */
  sequenceExclusion?: 'cold-start' | 'model-switch'
}

/**
 * Whether the token figures are individually trustworthy counts: finite and
 * non-negative. (There is no separate total-input figure to contradict —
 * uncached input + cache reads IS the served input side, so no cross-field
 * contradiction dimension exists beyond per-field validity.)
 */
function countsAreValid(input: CacheAssessInput): boolean {
  const { inputTokens, outputTokens, cacheReadTokens } = input
  if (inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens < 0) return false
  if (outputTokens !== undefined && (!Number.isFinite(outputTokens) || outputTokens < 0)) return false
  if (cacheReadTokens !== undefined && (!Number.isFinite(cacheReadTokens) || cacheReadTokens < 0)) return false
  return true
}

/**
 * Assess one request's cache hit for the request-area policy. The rules,
 * in evaluation order:
 *
 * 1. **State**: waiting/streaming rows are `in-flight`; failed / cancelled /
 *    interrupted rows are `not-success`; compaction rows are excluded by
 *    their kind. None of them ever carry the loss label.
 * 2. **Data**: a missing/invalid input side, or a denominator that is zero /
 *    non-finite, renders the rate absent — never 0%.
 * 3. **Reporting**: the cache-read field must have been explicitly reported
 *    (a 0 included); a missing field is `cache-unreported`, never 0%.
 * 4. **Sequence**: the session's first request (`cold-start`) and the first
 *    request after a model change (`model-switch`) are excluded by the
 *    caller's walk — regardless of their rate.
 * 5. **Input qualification**: on the documented DeepSeek routes only, a
 *    cacheable input side below one 64-token block is `insufficient-input`.
 * 6. **Policy bands**: all routes with valid reported data use rate < 50% → `loss` (the 「缓存过低」 label),
 *    50% ≤ rate < 80% → `low` (no label), ≥ 80% → `normal`.
 *    Numeric colours follow the shared summary-card scale independently.
 *    Boundaries use the raw value: exactly 80% is `normal`, exactly 50% is
 *    `low` (no label).
 *
 * A `loss` band is a low-hit heuristic hint, never proof of a server-side
 * cache failure — the client copy says so.
 */
export function assessRequestCache(input: CacheAssessInput): RequestDetailCache {
  const { state, kind } = input
  const assessment: RequestDetailCache = { eligibility: 'unknown', band: 'unknown' }

  // 1. State exclusions (before any rate is computed — an in-flight row has
  // no trustworthy usage yet anyway).
  if (state === 'waiting' || state === 'streaming') {
    assessment.band = 'excluded'
    assessment.reason = 'in-flight'
    return assessment
  }
  if (state !== 'completed') {
    assessment.band = 'excluded'
    assessment.reason = 'not-success'
    return assessment
  }
  if (kind === 'compaction') {
    assessment.band = 'excluded'
    assessment.reason = 'compaction'
    return assessment
  }
  if (kind === 'aux') {
    assessment.band = 'excluded'
    assessment.reason = 'auxiliary'
    return assessment
  }

  // 2. Data validity.
  if (!countsAreValid(input)) {
    assessment.band = 'unknown'
    assessment.reason = 'invalid-data'
    return assessment
  }
  const served = input.inputTokens! + (input.cacheReadTokens ?? 0)
  if (!Number.isFinite(served) || served <= 0) {
    assessment.band = 'unknown'
    assessment.reason = 'invalid-data'
    return assessment
  }

  // 3. Explicit reporting. The field's PRESENCE is the evidence: the
  // DeepSeek wire copies each field verbatim, so a reported 0 survives as
  // cacheReadTokens: 0 (an assessable 0%), and a missing field means the
  // provider did not report — never "0% hit". On the pi-ai routes a
  // reported 0 was folded away at the adapter, which lands here the same
  // way: unknown, never 0%.
  if (input.cacheReadTokens === undefined) {
    assessment.band = 'unknown'
    assessment.reason = 'cache-unreported'
    return assessment
  }
  const rate = (input.cacheReadTokens ?? 0) / served
  assessment.rate = rate
  assessment.eligibility = 'eligible'

  // 4. Route-sequence exclusions (the caller's walk).
  if (input.sequenceExclusion !== undefined) {
    assessment.band = 'excluded'
    assessment.reason = input.sequenceExclusion
    return assessment
  }

  // 5. Input qualification: below one cache block the 0% is explained by
  // the input itself, not by a cache failure.
  if (input.provider !== undefined && DEEPSEEK_BLOCK_PROVIDERS.has(input.provider)
    && rate === 0 && served < DEEPSEEK_CACHE_BLOCK_TOKENS) {
    assessment.band = 'excluded'
    assessment.reason = 'insufficient-input'
    return assessment
  }

  // 6. Policy bands on the raw value, regardless of provider identity.
  assessment.band = rate < 0.5 ? 'loss' : rate < 0.8 ? 'low' : 'normal'
  return assessment
}

/**
 * One entry of a session's request sequence, in start order: the session it
 * belongs to, the model name the route/display folds under (the effective
 * model — response model when the adapter reported one), and the provider
 * route key when the row carries one.
 */
export interface RouteSequenceEntry {
  sessionId: string
  model: string
  kind?: 'request' | 'compaction' | 'failure' | 'aux'
  /** Provider route key; absent on legacy rows (recorded before the field
   * existed) and on failure rows whose session never named a route. */
  provider?: string
}

/**
 * Walk a session's request sequence in start order and mark the exclusion
 * each entry's cache label would carry: the session's very first request is
 * a `cold-start`, and any entry whose immediate predecessor in the same
 * session named a different route is a `model-switch`. The route identity is
 * provider + model when BOTH sides carry a provider (the cache lineage is
 * per-route: switching `deepseek-official` → `deepseek-account` at the same
 * model name starts a new cache context); when either side lacks the
 * provider key (legacy rows, unattributed failures) the walk falls back to
 * the model-only comparison those rows have always had — an absent key never
 * widens the exclusion. Switching BACK to an earlier route is still a switch
 * first — conservative. Entries outside this vocabulary (unknown future
 * reasons) yield undefined. The walk always covers the FULL sequence the
 * caller filtered to scope — never just the display window — so a first
 * request that fell out of the 20-item pool is still correctly marked, and
 * the marks do not move as the window slides.
 *
 * Predecessors are by adjacent conversation request regardless of kind: a
 * compaction summarize call is a real provider request of the same session
 * and takes part in the cache lineage. Auxiliary work is a separate prompt
 * lineage and is skipped.
 */
export function routeExclusionsOf(
  entries: readonly RouteSequenceEntry[],
): ReadonlyMap<object, 'cold-start' | 'model-switch'> {
  const marks = new Map<object, 'cold-start' | 'model-switch'>()
  const lastRoute = new Map<string, Pick<RouteSequenceEntry, 'model' | 'provider'>>()
  for (const entry of entries) {
    // Auxiliary work uses a separate prompt lineage. It must not become the
    // predecessor that makes the next conversation request look like a model
    // switch (title generation commonly uses a different model).
    if (entry.kind === 'aux') continue
    // An unattributed entry (model '' — a failure row whose session never
    // named a route) takes no mark and leaves no predecessor: it would
    // otherwise forge a model switch around itself.
    if (entry.model === '') continue
    const previous = lastRoute.get(entry.sessionId)
    if (previous === undefined) {
      marks.set(entry, 'cold-start')
    } else {
      // Route identity: provider + model when both sides carry a provider;
      // model-only when either side predates the field (conservative — the
      // legacy comparison never gains exclusions it cannot evidence).
      const switched = previous.provider !== undefined && entry.provider !== undefined
        ? previous.provider !== entry.provider || previous.model !== entry.model
        : previous.model !== entry.model
      if (switched) marks.set(entry, 'model-switch')
    }
    lastRoute.set(entry.sessionId, {
      model: entry.model,
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    })
  }
  return marks
}

/**
 * The settled single-request decode speed: output tokens over the generation
 * span (latency − first token), in tokens/second. The gate mirrors the
 * global performance accumulators: the generation span must be a real
 * streaming sample (≥ {@link PERF_STREAM_MIN_GEN_MS}) and the output must be
 * positive. A whole-body (non-streaming) response has no first-token figure
 * and stays undefined — its tiny arrival interval would fabricate enormous
 * tok/s. Never returns Infinity/NaN.
 */
export function settledSpeedOf(
  outputTokens: number | undefined,
  latencyMs: number | undefined,
  firstTokenLatencyMs: number | undefined,
): number | undefined {
  if (outputTokens === undefined || latencyMs === undefined || firstTokenLatencyMs === undefined) return undefined
  if (!Number.isFinite(outputTokens) || !Number.isFinite(latencyMs) || !Number.isFinite(firstTokenLatencyMs)) return undefined
  if (outputTokens <= 0 || latencyMs < 0 || firstTokenLatencyMs < 0) return undefined
  const genMs = latencyMs - firstTokenLatencyMs
  if (genMs < PERF_STREAM_MIN_GEN_MS) return undefined
  const speed = outputTokens / (genMs / 1_000)
  return Number.isFinite(speed) ? speed : undefined
}

/** All exclusion reasons, for locale-key coverage tests. */
export const CACHE_EXCLUSION_REASONS: readonly RequestCacheExclusion[] = [
  'cold-start',
  'model-switch',
  'in-flight',
  'not-success',
  'compaction',
  'auxiliary',
  'cache-unreported',
  'insufficient-input',
  'invalid-data',
]
