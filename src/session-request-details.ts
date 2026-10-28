/**
 * The session usage tab's request-pool builder (node half): merge the
 * persisted usage records with the observer's live attempts into one
 * filtered, deduped, sorted, windowed `SessionRequestDetails` snapshot.
 *
 * The merge order is fixed and load-bearing: scope filter FIRST (the caller
 * already handed over only the scoped records), then dedupe against the
 * durable rows, then the route-sequence walk over the FULL merged sequence
 * (cold-start / model-switch marks never depend on the display window),
 * then sort by the order anchor descending, promote the newest active request
 * (or a just-settled live request during its one-second handoff window) to
 * the panel seat, and only then cut to REQUEST_POOL_LIMIT.
 * The window limits DISPLAY — totals, trends, and the log never shrink.
 *
 * @module token-usage/session-request-details
 */

import { costOf, ratesForKey } from './pricing.ts'
import type { ModelRates } from './wire.ts'
import type { RateKey } from './wire.ts'
import { effectiveModelOf, type AuxKind, type UsageRecord } from './usage-record.ts'
import type { CompactionAttributionItem } from './compaction-attribution.ts'
import { assessRequestCache, routeExclusionsOf, settledSpeedOf } from './request-details.ts'
import type { LiveAttempt } from './request-observe.ts'
import { REQUEST_POOL_LIMIT, type ConversationStatus, type RequestDetailView, type SessionRequestDetails } from './wire.ts'

/** How per-record pricing reaches the builder: the route's own resolver
 * (request-time pricing, context tiers, currency stay the server's job). */
export interface RequestPricing {
  /** The rate identity one record bills at (the stats route's resolver). */
  resolve: (record: UsageRecord) => RateKey
  /** The model's rate rules under the current table; undefined = unpriced. */
  rulesOf: (model: string) => ModelRates | undefined
  /** Canonical model id after pricing aliases / regexes are resolved. */
  modelIdOf?: (model: string) => string
  /** Whether the pricing layer is ready at all (else costs read unknown). */
  ready: boolean
}

/** The sort identity every merged row carries. */
interface OrderAnchor {
  id: string
  orderAt: number
  orderBasis: 'start' | 'record'
}

/** One merged attempt before assessment: the union of a persisted row and a
 * live attempt, keyed by the durable request id when one exists. */
interface MergedAttempt extends OrderAnchor {
  durableRequestId?: string
  sessionId: string
  kind: 'request' | 'compaction' | 'failure' | 'aux'
  auxKind?: AuxKind
  /** Durable plain-request rows carry the compaction attribution the
   * recorder's window attached (display-side only; a live attempt never
   * carries one — the tooltip explains a settled row's prefix context). */
  compactionAttribution?: readonly CompactionAttributionItem[]
  state: RequestDetailView['state']
  requestedModel: string
  responseModel?: string
  provider?: string
  startedAt?: number
  settledAt?: number
  /** Present only while the observer retains the live settlement. Durable
   * history alone cannot prove that a row was just visible as active. */
  liveSettledAt?: number
  recordTime?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  latencyMs?: number
  firstTokenLatencyMs?: number
  failureCode?: string
}

/** Deterministic ascending order: anchor time, then started rows before
 * record rows, then the stable id — never array position. */
function compareAsc(left: OrderAnchor, right: OrderAnchor): number {
  return left.orderAt - right.orderAt
    || (left.orderBasis === right.orderBasis ? 0 : left.orderBasis === 'start' ? -1 : 1)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

/** Map one persisted record onto the merged shape. State comes from the
 * durable facts: a failure row failed; an interrupted completion (the host
 * finalizes a mid-stream-cancelled turn's delivered prefix with
 * `interrupted: true`) was cancelled with partial output; everything else
 * completed. The order anchor is the row's recorded START when it has one
 * (newer request rows carry `startedAt`) — the settlement `time` would let
 * a late-finishing early request jump over later ones, even after a reload.
 * Timing keeps the record's own caliber (step-level figures for cross-retry
 * turns stay as recorded — until a live attempt merges its single-attempt
 * clock back in). */
function attemptOfRecord(record: UsageRecord): MergedAttempt {
  const clock = record.attemptTiming
  const startedAt = clock?.startedAt ?? record.startedAt
  const latencyMs = clock !== undefined ? clock.settledAt - clock.startedAt : record.latencyMs
  const firstTokenLatencyMs = clock !== undefined
    ? clock.firstTokenAt !== undefined ? clock.firstTokenAt - clock.startedAt : undefined
    : record.firstTokenLatencyMs
  const state: RequestDetailView['state'] = record.kind === 'failure'
    ? 'failed'
    : record.interrupted === true ? 'cancelled'
      : 'completed'
  return {
    id: record.requestId,
    durableRequestId: record.requestId,
    sessionId: record.sessionId,
    kind: record.kind === 'failure' ? 'failure' : record.kind === 'compaction' ? 'compaction' : record.kind === 'aux' ? 'aux' : 'request',
    ...(record.auxKind !== undefined ? { auxKind: record.auxKind } : {}),
    ...(record.compactionAttribution !== undefined ? { compactionAttribution: record.compactionAttribution } : {}),
    state,
    requestedModel: record.model,
    ...(record.responseModel !== undefined ? { responseModel: record.responseModel } : {}),
    ...(record.provider !== undefined ? { provider: record.provider } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(clock !== undefined ? { settledAt: clock.settledAt } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(record.failureCode !== undefined ? { failureCode: record.failureCode } : {}),
    recordTime: record.time,
    orderAt: startedAt ?? record.time,
    orderBasis: startedAt !== undefined ? 'start' : 'record',
    ...(record.usage !== undefined ? {
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      ...(record.usage.cacheReadTokens !== undefined ? { cacheReadTokens: record.usage.cacheReadTokens } : {}),
      ...(record.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: record.usage.cacheWriteTokens } : {}),
    } : {}),
  }
}

/** Map one live attempt onto the merged shape (an unset row stays unset —
 * the assessment treats absence as unknown, never zero). Once a settlement
 * linked the attempt, its id IS the durable id: the row keeps that identity
 * before, during, and after the persisted row lands — the pool never
 * renames a request mid-flight. */
function attemptOfLive(live: LiveAttempt): MergedAttempt & { startedAt: number } {
  const latencyMs = live.settledAt !== undefined ? Math.max(0, live.settledAt - live.startedAt) : undefined
  const firstTokenLatencyMs = live.firstTokenAt !== undefined
    ? Math.max(0, live.firstTokenAt - live.startedAt)
    : undefined
  return {
    id: live.durableRequestId ?? live.id,
    ...(live.durableRequestId !== undefined ? { durableRequestId: live.durableRequestId } : {}),
    sessionId: live.sessionId,
    kind: live.kind,
    ...(live.auxKind !== undefined ? { auxKind: live.auxKind } : {}),
    state: live.state,
    requestedModel: live.requestedModel,
    ...(live.provider !== undefined ? { provider: live.provider } : {}),
    startedAt: live.startedAt,
    ...(live.settledAt !== undefined ? { settledAt: live.settledAt } : {}),
    ...(live.settledAt !== undefined && live.wasActive === true ? { liveSettledAt: live.settledAt } : {}),
    orderAt: live.startedAt,
    orderBasis: 'start',
    ...(live.usage !== undefined ? {
      inputTokens: live.usage.inputTokens,
      outputTokens: live.usage.outputTokens,
      ...(live.usage.cacheReadTokens !== undefined ? { cacheReadTokens: live.usage.cacheReadTokens } : {}),
      ...(live.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: live.usage.cacheWriteTokens } : {}),
    } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(live.failureCode !== undefined ? { failureCode: live.failureCode } : {}),
  }
}

/**
 * Price one merged attempt through the record-shaped resolver: the attempt
 * and its durable row bill identically because the resolver reads the same
 * model/time/tokens. A failure attempt carries no usage and no cost — the
 * existing billing semantics (failures never bill) pass through untouched.
 */
function priceOf(attempt: MergedAttempt, pricing: RequestPricing): { cost?: number; pricingStatus: RequestDetailView['pricingStatus'] } {
  const model = effectiveModelOf({
    model: attempt.requestedModel,
    ...(attempt.responseModel !== undefined ? { responseModel: attempt.responseModel } : {}),
  })
  const rules = model === '' ? undefined : pricing.rulesOf(model)
  if (attempt.recordTime === undefined || attempt.inputTokens === undefined || attempt.outputTokens === undefined) {
    // No durable settlement or usage → no billable figure. Not
    // an unpriced model — a pricing-status answer does not exist here.
    return { pricingStatus: 'unknown' }
  }
  if (!pricing.ready || rules === undefined) return { pricingStatus: 'unpriced' }
  const cost = costOf({
    requests: 1,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    cacheReadTokens: attempt.cacheReadTokens ?? 0,
    cacheWriteTokens: attempt.cacheWriteTokens ?? 0,
    compactions: 0,
    failures: 0,
  }, ratesForKey(rules, pricing.resolve({
    requestId: attempt.durableRequestId ?? attempt.id,
    // Billing follows the ledger's settlement timestamp, never its sort key.
    time: attempt.recordTime,
    sessionId: attempt.sessionId,
    model: attempt.requestedModel,
    ...(attempt.responseModel !== undefined ? { responseModel: attempt.responseModel } : {}),
    usage: {
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      ...(attempt.cacheReadTokens !== undefined ? { cacheReadTokens: attempt.cacheReadTokens } : {}),
      ...(attempt.cacheWriteTokens !== undefined ? { cacheWriteTokens: attempt.cacheWriteTokens } : {}),
    },
  })))
  return { cost, pricingStatus: 'priced' }
}

/** Fold one linked live attempt back into its persisted row — a FIELD merge,
 * never a whole-row replace. The persisted row wins where it is the durable
 * fact (state, models, token buckets, record kind); the live side keeps what
 * the log never stored:
 * - the START identity: the attempt's dispatch time is the row's order
 *   anchor again (the record's `time` is the settlement order — sorting by
 *   it would let a late-settling early request jump over later ones), and
 *   the row's id stays the durable id the live row already carried, so the
 *   row does not rename when the log lands;
 * - the SINGLE-ATTEMPT clock: the live latency/first-token figures time this
 *   one provider attempt, while the record's are step-level (a retried
 *   turn's include every attempt) — merging them in keeps a row's 首字/耗时
 *   and the speed derived from them on one caliber across the settlement. */
function mergeLiveInto(row: MergedAttempt, live: MergedAttempt & { startedAt: number }): void {
  row.startedAt = live.startedAt
  if (live.settledAt !== undefined) row.settledAt = live.settledAt
  if (live.liveSettledAt !== undefined) row.liveSettledAt = live.liveSettledAt
  row.orderAt = live.startedAt
  row.orderBasis = 'start'
  if (live.latencyMs !== undefined) row.latencyMs = live.latencyMs
  // Absence is evidence too: never combine a live attempt's latency with a
  // legacy step-level first-token clock from a previous retry.
  if (live.firstTokenLatencyMs !== undefined) row.firstTokenLatencyMs = live.firstTokenLatencyMs
  else delete row.firstTokenLatencyMs
  if (row.provider === undefined && live.provider !== undefined) row.provider = live.provider
  if (row.failureCode === undefined && live.failureCode !== undefined) row.failureCode = live.failureCode
}

/**
 * Build the session request pool snapshot. `records` must already be scoped
 * to the requested session ids (the full filtered set, in day-file order —
 * the sequence walk needs the complete history, not a window); `live` is
 * the observer's snapshot over the same ids.
 */
export function buildSessionRequestDetails(input: {
  records: readonly UsageRecord[]
  live: { attempts: readonly LiveAttempt[]; activeCount: number; conversations?: ReadonlyMap<string, ConversationStatus> }
  pricing: RequestPricing
  asOf: number
  liveCapability: SessionRequestDetails['liveCapability']
}): SessionRequestDetails {
  const { records, live, pricing, asOf, liveCapability } = input
  // The in-place merge, keyed by the durable request id: a live attempt
  // whose settlement already landed in the log FOLDS INTO the persisted row
  // (same request — its start anchor and single-attempt clock survive, the
  // durable facts come from the log). A linked attempt whose row has not
  // landed yet keeps its live row under the durable id; when the log lands,
  // the merge is id-stable — no second row, no double billing, no reorder.
  const byDurable = new Map<string, MergedAttempt>()
  const merged: MergedAttempt[] = []
  for (const record of records) {
    const row = attemptOfRecord(record)
    byDurable.set(record.requestId, row)
    merged.push(row)
  }
  for (const attempt of live.attempts) {
    const mapped = attemptOfLive(attempt)
    const row = mapped.durableRequestId !== undefined ? byDurable.get(mapped.durableRequestId) : undefined
    if (row !== undefined) mergeLiveInto(row, mapped)
    else merged.push(mapped)
  }

  // Sequence marks over the FULL merged scope in start order — the session's
  // first request and route switches are facts of the whole session, never
  // of the 20-item window (a first request outside the window is still a
  // first request).
  merged.sort(compareAsc)
  const sequence = merged.map(attempt => ({
    sessionId: attempt.sessionId,
    model: effectiveModelOf({
      model: attempt.requestedModel,
      ...(attempt.responseModel !== undefined ? { responseModel: attempt.responseModel } : {}),
    }),
    kind: attempt.kind,
    ...(attempt.provider !== undefined ? { provider: attempt.provider } : {}),
  }))
  const marks = routeExclusionsOf(sequence)
  // Keep this provenance private to the builder; it is not a wire field.
  // Durable rows alone cannot tell whether a request was just visible as
  // active, so only observer-retained settlements qualify for the handoff.
  const recentlySettledId = merged
    .filter(attempt => attempt.state === 'completed'
      && attempt.liveSettledAt !== undefined
      && asOf >= attempt.liveSettledAt
      && asOf - attempt.liveSettledAt < 1_000)
    .sort((left, right) => (right.liveSettledAt! - left.liveSettledAt!) || compareAsc(right, left))[0]?.id

  const items: RequestDetailView[] = merged.map((attempt, index) => {
    const entry = sequence[index]
    const sequenceExclusion = entry !== undefined ? marks.get(entry) : undefined
    const cache = assessRequestCache({
      state: attempt.state,
      kind: attempt.kind,
      ...(attempt.provider !== undefined ? { provider: attempt.provider } : {}),
      ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
      ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
      ...(attempt.cacheReadTokens !== undefined ? { cacheReadTokens: attempt.cacheReadTokens } : {}),
      ...(attempt.cacheWriteTokens !== undefined ? { cacheWriteTokens: attempt.cacheWriteTokens } : {}),
      ...(sequenceExclusion !== undefined ? { sequenceExclusion } : {}),
    })
    const { cost, pricingStatus } = priceOf(attempt, pricing)
    const effectiveModel = effectiveModelOf({
      model: attempt.requestedModel,
      ...(attempt.responseModel !== undefined ? { responseModel: attempt.responseModel } : {}),
    })
    const modelId = pricing.modelIdOf?.(effectiveModel) ?? effectiveModel
    // The settled single-request speed: one gate (the shared 500ms streaming
    // sample rule), computed server-side so the model table and the pool
    // rows can never disagree about what a trustworthy tok/s is.
    const speed = attempt.state === 'completed'
      ? settledSpeedOf(attempt.outputTokens, attempt.latencyMs, attempt.firstTokenLatencyMs)
      : undefined
    // In-flight rows carry an asOf-anchored elapsed figure so the client
    // renders 已耗时 without running its own clock across a skew.
    const elapsedMs = attempt.state === 'waiting' || attempt.state === 'streaming'
      ? Math.max(0, asOf - (attempt.startedAt ?? asOf))
      : undefined
    return {
      id: attempt.id,
      ...(attempt.durableRequestId !== undefined ? { durableRequestId: attempt.durableRequestId } : {}),
      sessionId: attempt.sessionId,
      state: attempt.state,
      kind: attempt.kind,
      ...(attempt.auxKind !== undefined ? { auxKind: attempt.auxKind } : {}),
      ...(attempt.compactionAttribution !== undefined ? { compactionAttribution: attempt.compactionAttribution } : {}),
      ...(modelId !== '' ? { modelId } : {}),
      requestedModel: attempt.requestedModel,
      ...(attempt.responseModel !== undefined ? { responseModel: attempt.responseModel } : {}),
      ...(attempt.startedAt !== undefined ? { startedAt: attempt.startedAt } : {}),
      ...(attempt.settledAt !== undefined ? { settledAt: attempt.settledAt } : {}),
      ...(attempt.recordTime !== undefined ? { recordTime: attempt.recordTime } : {}),
      orderAt: attempt.orderAt,
      orderBasis: attempt.orderBasis,
      ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
      ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
      ...(attempt.cacheReadTokens !== undefined ? { cacheReadTokens: attempt.cacheReadTokens } : {}),
      ...(attempt.cacheWriteTokens !== undefined ? { cacheWriteTokens: attempt.cacheWriteTokens } : {}),
      ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
      ...(attempt.firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs: attempt.firstTokenLatencyMs } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(speed !== undefined ? { speed } : {}),
      ...(attempt.failureCode !== undefined ? { failureCode: attempt.failureCode } : {}),
      ...(cost !== undefined ? { cost } : {}),
      pricingStatus,
      cache,
    }
  })

  // Newest START first; the deterministic tiebreak mirrors the merge order.
  items.sort((left, right) => compareAsc(right, left))
  // Reserve the panel for an active request before windowing. A long-running
  // child must not disappear behind newer completed parent requests. When no
  // request remains active, keep the live settlement that just left the panel
  // there for one second so completion is observable before it joins history.
  const activeIndex = items.findIndex(item => item.state === 'waiting' || item.state === 'streaming')
  if (activeIndex > 0) {
    const [active] = items.splice(activeIndex, 1)
    items.unshift(active!)
  } else if (activeIndex < 0) {
    const settledIndex = recentlySettledId === undefined ? -1 : items.findIndex(item => item.id === recentlySettledId)
    if (settledIndex > 0) {
      const [settled] = items.splice(settledIndex, 1)
      items.unshift(settled!)
    }
  }

  // The headline row's session carries the conversation state: the panel is
  // about that request, so the note about where the conversation stands
  // belongs to the same session. A scope without a headline has no state.
  const headline = items[0]
  const conversation = headline !== undefined ? live.conversations?.get(headline.sessionId) : undefined

  return {
    items: items.slice(0, REQUEST_POOL_LIMIT),
    limit: REQUEST_POOL_LIMIT,
    asOf,
    activeCount: live.activeCount,
    liveCapability,
    ...(conversation !== undefined ? { conversation } : {}),
  }
}
