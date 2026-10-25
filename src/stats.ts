/**
 * Stats computation of the token-usage plugin: read the day files and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window — keeping one row per (day, model, rate identity) so every record
 * is billed at the rate its own timestamp resolved through (see
 * pricing.resolveRate). Frozen (pre-today) day files are served from the
 * on-disk rollup (see rollup.ts); only today's file is read on every call.
 * Pure aggregation lives apart from the file walk so the web route and tests
 * share one implementation.
 *
 * @module token-usage/stats
 */

import { canonicalName, costOf, ratesForKey } from './pricing.ts'
import type { PricingContext } from './pricing.ts'
import { modelKey } from './model-resolution.ts'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileDay, listDayFiles, readDayFile, readDayFileChecked } from './record-cache.ts'
import { consoleLogger, type LoggerLike } from './log.ts'
import type { AuxKind, UsageRecord } from './usage-record.ts'
import { AUX_KINDS, effectiveModelOf } from './usage-record.ts'
import { readRollup, writeRollup, ROLLUP_FILE_NAME, ROLLUP_TMP_FILE_NAME, ROLLUP_AGGREGATE_FORMAT } from './rollup.ts'
import type { RollupFile } from './rollup.ts'
import type {
  AuxSummary,
  CostedModelRow,
  CostedSessionCell,
  CostedSummary,
  CostState,
  ModelPerf,
  ModelRates,
  PricingTable,
  RateKey,
  RequestPoint,
  SessionUsageRow,
  TokenSummary,
  UsageAuxRow,
  UsageDayRow,
  UsageHourRow,
  UsageModelRow,
  UsageRateRow,
  UsageSessionRow,
  UsageTotals,
} from './wire.ts'
import { UNPRICED_KEY } from './wire.ts'

/** Bounded recent window length: only the newest records cross the wire. */
export const RECENT_LIMIT = 20

/**
 * Resolves the rate identity one record was billed at. The route builds this
 * from the pricing table (pricing.resolveRate over the record's model, time,
 * and input-side tokens); the neutral default leaves every record unpriced.
 */
export type RateResolver = (record: UsageRecord) => RateKey

/** Empty rollup used as the merge base when no rollup exists on disk yet. */
function emptyRollup(): RollupFile {
  return { upto: '', total: emptyTotals(), byDay: [], byHour: [], byModel: [], rateRows: [], auxRows: [], bySession: [], recent: [] }
}

/** Zeroed totals; requests counts rows, the token buckets sum reported usage. */
export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    compactions: 0,
    failures: 0,
  }
}

/**
 * Add one totals row into another, field by field. `compactions` and
 * `failures` merge with a `?? 0` fallback so a legacy rollup (no key) folds
 * into new aggregates without NaN; `failuresByCode` merges key-wise with
 * the same absent-reads-as-empty rule; the performance accumulators follow
 * the same fallback (a legacy shape has no timing to contribute).
 */
function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.requests += source.requests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.compactions = (target.compactions ?? 0) + (source.compactions ?? 0)
  target.failures = (target.failures ?? 0) + (source.failures ?? 0)
  const codes = source.failuresByCode
  if (codes !== undefined) {
    const merged = target.failuresByCode ?? {}
    for (const [code, count] of Object.entries(codes)) {
      merged[code] = (merged[code] ?? 0) + count
    }
    target.failuresByCode = merged
  }
  // Performance accumulators merge only when a side carries timing data —
  // a timing-less totals stays without the keys, so legacy rollups and
  // timing-free windows never grow zero-valued noise.
  if (source.perfLatencyMsSum !== undefined) {
    target.perfLatencyMsSum = (target.perfLatencyMsSum ?? 0) + source.perfLatencyMsSum
  }
  if (source.perfLatencyCount !== undefined) {
    target.perfLatencyCount = (target.perfLatencyCount ?? 0) + source.perfLatencyCount
  }
  if (source.perfStreamCount !== undefined) {
    target.perfStreamCount = (target.perfStreamCount ?? 0) + source.perfStreamCount
    target.perfStreamTpsSum = (target.perfStreamTpsSum ?? 0) + (source.perfStreamTpsSum ?? 0)
    target.perfStreamFirstMsSum = (target.perfStreamFirstMsSum ?? 0) + (source.perfStreamFirstMsSum ?? 0)
  }
}

/** Sort a day row map ascending by day, matching {@link summarizeRecords}. */
function dayRows(days: Map<string, UsageTotals>): UsageDayRow[] {
  return [...days.entries()]
    .map(([day, totals]) => ({ day, totals }))
    .sort((left, right) => left.day < right.day ? -1 : 1)
}

/** Sort a model row map by requests descending then model name, matching {@link summarizeRecords}. */
function modelRows(models: Map<string, UsageTotals>): UsageModelRow[] {
  return [...models.entries()]
    .map(([model, totals]) => ({ model, totals }))
    .sort((left, right) =>
      right.totals.requests - left.totals.requests || left.model.localeCompare(right.model))
}

/** Deterministic rate-identity order: rule window, tier, slot. */
function compareKeys(left: RateKey, right: RateKey): number {
  return left.ruleStart - right.ruleStart || left.ruleEnd - right.ruleEnd
    || left.tier - right.tier || left.slot - right.slot
}

/** Sort rate rows day ascending, then model name, then rate identity. */
function rateRowsSorted(rows: Iterable<UsageRateRow>): UsageRateRow[] {
  return [...rows].sort((left, right) =>
    left.day < right.day ? -1 : left.day > right.day ? 1
      : left.model < right.model ? -1 : left.model > right.model ? 1
        : compareKeys(left.rate, right.rate))
}

/** Map key of one (day, model, rate) cell. */
function rateRowKey(day: string, model: string, rate: RateKey): string {
  return `${day}\n${model}\n${rate.ruleStart}-${rate.ruleEnd}-${rate.tier}-${rate.slot}`
}

/** Deterministic session-cell order: session id, day, model, rate identity. */
function sessionRowsSorted(rows: Iterable<UsageSessionRow>): UsageSessionRow[] {
  return [...rows].sort((left, right) =>
    left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1
      : left.day < right.day ? -1 : left.day > right.day ? 1
        : left.model < right.model ? -1 : left.model > right.model ? 1
          : compareKeys(left.rate, right.rate))
}

/** Map key of one (sessionId, day, model, rate) cell. */
function sessionRowKey(row: UsageSessionRow): string {
  return `${row.sessionId}\n${row.day}\n${row.model}\n${row.rate.ruleStart}-${row.rate.ruleEnd}-${row.rate.tier}-${row.rate.slot}`
}

/** Fixed display order of the auxiliary kinds (the recorder vocabulary). */
const AUX_ORDER = new Map<AuxKind, number>(AUX_KINDS.map((kind, index) => [kind, index]))

/** Deterministic auxiliary-cell order: kind, day, model, rate identity. */
function auxRowsSorted(rows: Iterable<UsageAuxRow>): UsageAuxRow[] {
  return [...rows].sort((left, right) =>
    (AUX_ORDER.get(left.auxKind) ?? 0) - (AUX_ORDER.get(right.auxKind) ?? 0)
      || (left.day < right.day ? -1 : left.day > right.day ? 1
        : left.model < right.model ? -1 : left.model > right.model ? 1
          : compareKeys(left.rate, right.rate)))
}

/** Map key of one (kind, day, model, rate) auxiliary cell. */
function auxRowKey(auxKind: AuxKind, day: string, model: string, rate: RateKey): string {
  return `${auxKind}\n${day}\n${model}\n${rate.ruleStart}-${rate.ruleEnd}-${rate.tier}-${rate.slot}`
}

/** The auxiliary kind of one record; a hand-built aux row may omit it. */
function auxKindOfRecord(record: UsageRecord): AuxKind {
  return record.auxKind ?? 'other'
}

/** Smallest generation span (latency − first token) a request must show to
 * count as a streaming sample for the performance accumulators: a shorter
 * span means the response landed in one shot (non-streaming), and its
 * "speed" — thousands of tokens over a few ms — is pure noise. The request
 * pool's settled-speed gate shares the gate (request-details.ts), so one
 * threshold cannot drift between the model table and the request rows. */
export const PERF_STREAM_MIN_GEN_MS = 500

/**
 * Fold one record into totals; a record without provider usage still counts a
 * request, and a compaction record additionally counts the `compactions`
 * dimension (absent kind reads as a plain request). A failure record counts
 * only the `failures` dimension — it bills no tokens and never joins
 * `requests`, so the requests figure stays "successful requests" — and its
 * `failureCode` folds into the per-code breakdown the failure pill's
 * tooltip renders.
 *
 * A successful request with timing folds its end-to-end `latencyMs` into the
 * performance accumulators and increments the valid timing count, and
 * when its generation span marks it streaming (see
 * {@link PERF_STREAM_MIN_GEN_MS}) its tokens-per-second and first-token
 * latency join the streaming means too. Defensive guards on the recorder's
 * optional figures keep a malformed row out of the means.
 */
function addUsage(totals: UsageTotals, record: UsageRecord): void {
  if (record.kind === 'failure') {
    totals.failures = (totals.failures ?? 0) + 1
    const code = record.failureCode ?? 'UNKNOWN'
    const byCode = totals.failuresByCode ?? {}
    byCode[code] = (byCode[code] ?? 0) + 1
    totals.failuresByCode = byCode
    return
  }
  totals.requests += 1
  if (record.kind === 'compaction') {
    totals.compactions = (totals.compactions ?? 0) + 1
  }
  const latency = record.latencyMs
  if (typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) {
    totals.perfLatencyMsSum = (totals.perfLatencyMsSum ?? 0) + latency
    totals.perfLatencyCount = (totals.perfLatencyCount ?? 0) + 1
    const first = record.firstTokenLatencyMs
    if (typeof first === 'number' && Number.isFinite(first) && first >= 0) {
      const genMs = latency - first
      const output = record.usage?.outputTokens ?? 0
      if (genMs >= PERF_STREAM_MIN_GEN_MS && output > 0) {
        totals.perfStreamTpsSum = (totals.perfStreamTpsSum ?? 0) + output / (genMs / 1000)
        totals.perfStreamFirstMsSum = (totals.perfStreamFirstMsSum ?? 0) + first
        totals.perfStreamCount = (totals.perfStreamCount ?? 0) + 1
      }
    }
  }
  const usage = record.usage
  if (usage === undefined) return
  totals.inputTokens += usage.inputTokens
  totals.outputTokens += usage.outputTokens
  if (usage.cacheReadTokens !== undefined) totals.cacheReadTokens += usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) totals.cacheWriteTokens += usage.cacheWriteTokens
}

/** Local date key of a record time, matching the day-file naming convention. */
function dayKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Local `YYYY-MM-DDTHH` key of a record time, the byHour row key. */
function hourKey(time: number): string {
  const date = new Date(time)
  const hour = String(date.getHours()).padStart(2, '0')
  return `${dayKey(time)}T${hour}`
}

/** Map key of one (hour, model) cell. */
function hourRowKey(hour: string, model: string): string {
  return `${hour}\n${model}`
}

/** Sort an hour row map by hour ascending then model name, matching {@link summarizeRecords}. */
function hourRows(hours: Map<string, UsageTotals>): UsageHourRow[] {
  return [...hours.entries()]
    .map(([key, totals]) => {
      const separator = key.indexOf('\n')
      return { hour: key.slice(0, separator), model: key.slice(separator + 1), totals }
    })
    .sort((left, right) =>
      left.hour < right.hour ? -1 : left.hour > right.hour ? 1
        : left.model < right.model ? -1 : left.model > right.model ? 1
          : 0)
}

/**
 * Fold records into the token summary shape, one rate row per (day, model,
 * rate identity) the resolver assigns. Every model-scoped dimension keys on
 * the record's effective model name ({@link effectiveModelOf}: the
 * provider-reported response model when present, the routed name otherwise),
 * so pricing resolution and canonical folding see the name the provider
 * itself reported. The recent window keeps the last {@link RECENT_LIMIT}
 * records in input order (day files are chronological) and then sorts them
 * by time descending.
 * @param records - parsed records in day-file order.
 * @param resolve - the rate resolver; defaults to leaving every record unpriced.
 * @returns totals, day rows, model rows, rate rows, and the recent window.
 */
export function summarizeRecords(records: readonly UsageRecord[], resolve: RateResolver = () => UNPRICED_KEY): TokenSummary {
  const total = emptyTotals()
  const days = new Map<string, UsageTotals>()
  const hours = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  const rated = new Map<string, UsageRateRow>()
  const aux = new Map<string, UsageAuxRow>()
  const sessions = new Map<string, UsageSessionRow>()
  const recent: UsageRecord[] = []
  for (const record of records) {
    const model = effectiveModelOf(record)
    addUsage(total, record)
    const day = dayKey(record.time)
    const dayTotals = days.get(day) ?? emptyTotals()
    addUsage(dayTotals, record)
    days.set(day, dayTotals)
    // An unattributed failure (`model === ''`) still folds into totals,
    // byDay, and rateRows (so a day-range filter keeps the count). It
    // stays out of byModel / byHour — a blank table row would pretend
    // we know the route. The session dimension keeps it too: request
    // counts must reconcile per session, and a failure belongs to its
    // session even when no model was ever observed.
    if (model !== '') {
      const hour = hourKey(record.time)
      const hourTotals = hours.get(hourRowKey(hour, model)) ?? emptyTotals()
      addUsage(hourTotals, record)
      hours.set(hourRowKey(hour, model), hourTotals)
      const modelTotals = models.get(model) ?? emptyTotals()
      addUsage(modelTotals, record)
      models.set(model, modelTotals)
    }
    const rate = resolve(record)
    const rowKey = rateRowKey(day, model, rate)
    const cell = rated.get(rowKey)
      ?? { day, model, rate, totals: emptyTotals() }
    addUsage(cell.totals, record)
    rated.set(rowKey, cell)
    // An auxiliary (bypass) request has no owning conversation: it folds
    // into every model-scoped dimension above (it bills a real model) but
    // never into the per-session cells or the session table. Its own
    // (kind, day, model, rate) dimension backs the runtime-overhead block.
    if (record.kind === 'aux') {
      const auxKind = auxKindOfRecord(record)
      const key = auxRowKey(auxKind, day, model, rate)
      const auxCell = aux.get(key)
        ?? { auxKind, day, model, rate, totals: emptyTotals() }
      addUsage(auxCell.totals, record)
      aux.set(key, auxCell)
    } else {
      const sessionCell: UsageSessionRow = {
        sessionId: record.sessionId,
        day,
        model,
        rate,
        lastTime: record.time,
        totals: emptyTotals(),
      }
      const sessionKey = sessionRowKey(sessionCell)
      const folded = sessions.get(sessionKey) ?? sessionCell
      addUsage(folded.totals, record)
      sessions.set(sessionKey, folded)
      if (record.time > folded.lastTime) folded.lastTime = record.time
    }
    if (recent.length === RECENT_LIMIT) recent.shift()
    recent.push(record)
  }
  const byDay: UsageDayRow[] = dayRows(days)
  const byHour: UsageHourRow[] = hourRows(hours)
  const byModel: UsageModelRow[] = modelRows(models)
  recent.sort((left, right) => right.time - left.time)
  return {
    total,
    byDay,
    byHour,
    byModel,
    rateRows: rateRowsSorted(rated.values()),
    auxRows: auxRowsSorted(aux.values()),
    bySession: sessionRowsSorted(sessions.values()),
    recent,
  }
}

/**
 * Keep only the records owned by one of the listed sessions. The rollup
 * carries no session dimension (its rows are (day, model, rate) cells), so a
 * session-scoped read cannot reuse it and must fold the filtered raw records
 * instead — cheap in practice (the JSONL day files are a few hundred KB) and
 * only triggered by per-session fetches (view switches), never the settings
 * page's whole-log read.
 * @param records - parsed records in day-file order.
 * @param sessionIds - the sessions whose requests stay; [] yields no records.
 * @returns the records owned by those sessions, in the original order.
 */
export function filterRecordsBySessions(
  records: readonly UsageRecord[],
  sessionIds: readonly string[],
): UsageRecord[] {
  const wanted = new Set(sessionIds)
  return records.filter(record => wanted.has(record.sessionId))
}

/** Inclusive day-range bounds derived from optional day keys; the window
 * covers `[from 00:00, to 23:59:59.999]` local time on the boundary days. */
export interface DayRangeFilter {
  /** Inclusive lower bound, epoch ms; undefined when unconstrained. */
  start?: number
  /** Inclusive upper bound (with the day's millisecond span folded in), epoch ms. */
  end?: number
  /** Selected model id (or a priced alias of it); undefined matches any model. */
  model?: string
  /** Alias → modelId map; when present, `model` matches the whole priced family. */
  canonical?: ReadonlyMap<string, string>
}

/**
 * Whether `name` belongs to the selected model under an optional canonical
 * map: priced aliases of the same feed row match each other and the
 * modelId; an unpriced name matches only itself.
 */
function matchesModel(
  name: string,
  selected: string | undefined,
  canonical?: ReadonlyMap<string, string>,
): boolean {
  return selected === undefined || modelKey(canonicalName(name, canonical)) === modelKey(canonicalName(selected, canonical))
}

/**
 * Derive the half-open day-range bounds from optional `YYYY-MM-DD` keys. A
 * missing key leaves that side unbounded; the upper bound inherits the day's
 * full millisecond span (the day-key convention used everywhere else).
 * @param from - first day key (`YYYY-MM-DD`), inclusive; '' ignores both ends.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - selected model id (or alias); undefined matches any model.
 * @param canonical - alias → modelId map so a priced family matches as one.
 * @returns the bounds (every field may be undefined).
 */
export function dayRangeFilter(
  from?: string,
  to?: string,
  model?: string,
  canonical?: ReadonlyMap<string, string>,
): DayRangeFilter {
  const filter: DayRangeFilter = {}
  if (from !== undefined && from !== '') filter.start = dayStart(from)
  if (to !== undefined && to !== '') filter.end = dayStart(to) + 86_399_999
  if (model !== undefined && model !== '') filter.model = model
  if (canonical !== undefined) filter.canonical = canonical
  return filter
}

/**
 * Combine a day-range filter with a session-id filter. The session ids are
 * applied first (cheap, preroll), the day-range second (per-record); the
 * model id, if any, is per-record too. Returns the records passing both.
 * @param records - parsed records in chronological order.
 * @param sessions - the session ids whose records stay; undefined skips that
 * dimension.
 * @param range - the day-range + model filter; undefined skips every dimension.
 */
export function filterRecordsByRange(
  records: readonly UsageRecord[],
  sessions: readonly string[] | undefined,
  range: DayRangeFilter = {},
): UsageRecord[] {
  const wanted = sessions !== undefined ? new Set(sessions) : undefined
  const { start, end, model, canonical } = range
  return records.filter(record =>
    (wanted === undefined || wanted.has(record.sessionId))
    && (start === undefined || record.time >= start)
    && (end === undefined || record.time <= end)
    // The model filter matches the effective name (response model first),
    // the same key every aggregated dimension groups under.
    && matchesModel(effectiveModelOf(record), model, canonical))
}

/**
 * The per-request token series of a record set, in time order — one point
 * per request, so a 55-request session plots 55 points. Failed requests are
 * excluded: they carry no token figure, and a zero-token point per failure
 * would only sawtooth the curve. The conversation view tab draws this at
 * request granularity; the settings page's hourly aggregation is unchanged
 * (this field is session-scope only).
 * @param records - the scoped records (day-file order is chronological).
 * @param from - optional inclusive day key; the series keeps those requests.
 * @param to - optional inclusive day key.
 * @param model - optional selected model id (or a priced alias of it).
 * @param canonical - alias → modelId map so a priced family matches as one.
 * @returns one point per kept request, in the original time order.
 */
export function requestSeriesOf(
  records: readonly UsageRecord[],
  from?: string,
  to?: string,
  model?: string,
  canonical?: ReadonlyMap<string, string>,
): RequestPoint[] {
  return filterRecordsByRange(records, undefined, dayRangeFilter(from, to, model, canonical))
    .filter(record => record.kind !== 'failure')
    .map(record => ({
      time: record.time,
      tokens: record.usage === undefined ? 0
        : record.usage.inputTokens + record.usage.outputTokens
          + (record.usage.cacheReadTokens ?? 0) + (record.usage.cacheWriteTokens ?? 0),
    }))
}

/**
 * Merge two summaries into one: totals and model rows add up, day rows fold
 * by day key (a same-day record set landing in a later file must join the
 * earlier bucket, never replace it), rate rows fold by their (day, model,
 * rate) key, and the recent window keeps the newest {@link RECENT_LIMIT}
 * records across both sides. Order-independent and associative: merging
 * partial summaries equals summarizing the concatenated records.
 * @param left - one partial summary.
 * @param right - the other partial summary.
 * @returns the folded summary.
 */
export function mergeSummaries(
  left: TokenSummary,
  right: TokenSummary,
): TokenSummary {
  const total = emptyTotals()
  addTotals(total, left.total)
  addTotals(total, right.total)
  const days = new Map<string, UsageTotals>()
  const hours = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  const rated = new Map<string, UsageRateRow>()
  const aux = new Map<string, UsageAuxRow>()
  const sessions = new Map<string, UsageSessionRow>()
  for (const row of [...left.byDay, ...right.byDay]) {
    const day = days.get(row.day) ?? emptyTotals()
    addTotals(day, row.totals)
    days.set(row.day, day)
  }
  for (const row of [...left.byHour, ...right.byHour]) {
    const key = hourRowKey(row.hour, row.model)
    const cell = hours.get(key) ?? emptyTotals()
    addTotals(cell, row.totals)
    hours.set(key, cell)
  }
  for (const row of [...left.byModel, ...right.byModel]) {
    const model = models.get(row.model) ?? emptyTotals()
    addTotals(model, row.totals)
    models.set(row.model, model)
  }
  for (const row of [...left.rateRows, ...right.rateRows]) {
    const key = rateRowKey(row.day, row.model, row.rate)
    const cell = rated.get(key)
      ?? { day: row.day, model: row.model, rate: row.rate, totals: emptyTotals() }
    addTotals(cell.totals, row.totals)
    rated.set(key, cell)
  }
  // `?? []`: a hand-built or legacy-shaped summary without the auxiliary
  // dimension folds as if it had none (on-disk rollups are normalized when
  // read, so only in-memory shapes need the leniency).
  for (const row of [...(left.auxRows ?? []), ...(right.auxRows ?? [])]) {
    const key = auxRowKey(row.auxKind, row.day, row.model, row.rate)
    const cell = aux.get(key)
      ?? { auxKind: row.auxKind, day: row.day, model: row.model, rate: row.rate, totals: emptyTotals() }
    addTotals(cell.totals, row.totals)
    aux.set(key, cell)
  }
  // `?? []`: a hand-built or legacy-shaped summary without the session
  // dimension folds as if it had none — on-disk rollups fail validation
  // instead (isRollupFile), so this leniency only serves in-memory shapes.
  for (const row of [...(left.bySession ?? []), ...(right.bySession ?? [])]) {
    const key = sessionRowKey(row)
    const cell = sessions.get(key)
      ?? { ...row, totals: emptyTotals() }
    addTotals(cell.totals, row.totals)
    if (row.lastTime > cell.lastTime) cell.lastTime = row.lastTime
    sessions.set(key, cell)
  }
  const recent = [...left.recent, ...right.recent]
    .sort((a, b) => b.time - a.time)
    .slice(0, RECENT_LIMIT)
  return {
    total,
    byDay: dayRows(days),
    byHour: hourRows(hours),
    byModel: modelRows(models),
    rateRows: rateRowsSorted(rated.values()),
    auxRows: auxRowsSorted(aux.values()),
    bySession: sessionRowsSorted(sessions.values()),
    recent,
  }
}

/** Local-midnight epoch of a day key, matching the day-file convention. */
function dayStart(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year!, month! - 1, date!).getTime()
}

/**
 * Re-aggregate a summary under an optional inclusive day range and model
 * filter, drawing every dimension from the rate rows so no file is reread.
 * The recent window filters on its record timestamps
 * ([from 00:00, to 23:59:59.999] local). No filters returns the input as-is.
 * With a canonical map, `model` matches the priced family (the modelId and
 * every identified name of the same feed row); unpriced full names ignore case.
 * byModel rows stay keyed by the effective name (response model when the
 * adapter reported one, the routed name otherwise) — {@link attachCosts}
 * folds them.
 * @param summary - the unfiltered summary.
 * @param from - first day key (`YYYY-MM-DD`), inclusive.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - selected model id (or a priced alias of it).
 * @param canonical - alias → modelId map so a priced family matches as one.
 * @returns the filtered summary.
 */
export function filterSummary(
  summary: TokenSummary & { dataDir: string },
  from?: string,
  to?: string,
  model?: string,
  canonical?: ReadonlyMap<string, string>,
): TokenSummary & { dataDir: string } {
  if (from === undefined && to === undefined && model === undefined) return summary
  const rows = summary.rateRows.filter(row =>
    (from === undefined || row.day >= from)
    && (to === undefined || row.day <= to)
    && matchesModel(row.model, model, canonical))
  // Hour rows filter on their day prefix (the `YYYY-MM-DD` part of the key).
  const byHour = summary.byHour.filter(row =>
    (from === undefined || row.hour.slice(0, 10) >= from)
    && (to === undefined || row.hour.slice(0, 10) <= to)
    && matchesModel(row.model, model, canonical))
  // Session cells keep the same granule the rate rows carry (day × model ×
  // rate per session), so the filtered fold stays the exact source the cost
  // layer bills from — same pattern as `rows`, one dimension wider.
  const bySession = summary.bySession.filter(row =>
    (from === undefined || row.day >= from)
    && (to === undefined || row.day <= to)
    && matchesModel(row.model, model, canonical))
  // The auxiliary cells follow the same date/model filter as the rate rows:
  // a model filter selects the bypass calls that ran on that model too, so
  // the runtime-overhead block reconciles with the filtered totals.
  const auxRows = summary.auxRows.filter(row =>
    (from === undefined || row.day >= from)
    && (to === undefined || row.day <= to)
    && matchesModel(row.model, model, canonical))
  const total = emptyTotals()
  const days = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  for (const row of rows) {
    addTotals(total, row.totals)
    const day = days.get(row.day) ?? emptyTotals()
    addTotals(day, row.totals)
    days.set(row.day, day)
    if (row.model !== '') {
      const perModel = models.get(row.model) ?? emptyTotals()
      addTotals(perModel, row.totals)
      models.set(row.model, perModel)
    }
  }
  const recent = filterRecordsByRange(summary.recent, undefined, dayRangeFilter(from, to, model, canonical))
  return { dataDir: summary.dataDir, total, byDay: dayRows(days), byHour, byModel: modelRows(models), rateRows: rateRowsSorted(rows), auxRows: auxRowsSorted(auxRows), bySession, recent }
}

/** Available cached session cells retain usage even if raw history is lost.
 * Hourly/request timestamps cannot be recovered from these cells. */
export function summaryForSessions(summary: TokenSummary, sessionIds: readonly string[]): TokenSummary {
  const wanted = new Set(sessionIds)
  const bySession = summary.bySession.filter(row => wanted.has(row.sessionId))
  const total = emptyTotals()
  const days = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  const rated = new Map<string, UsageRateRow>()
  for (const row of bySession) {
    addTotals(total, row.totals)
    const day = days.get(row.day) ?? emptyTotals()
    addTotals(day, row.totals); days.set(row.day, day)
    if (row.model !== '') {
      const model = models.get(row.model) ?? emptyTotals()
      addTotals(model, row.totals); models.set(row.model, model)
    }
    const key = rateRowKey(row.day, row.model, row.rate)
    const cell = rated.get(key) ?? { day: row.day, model: row.model, rate: row.rate, totals: emptyTotals() }
    addTotals(cell.totals, row.totals); rated.set(key, cell)
  }
  return { total, byDay: dayRows(days), byHour: [], byModel: modelRows(models), rateRows: rateRowsSorted(rated.values()), auxRows: [], bySession,
    recent: summary.recent.filter(row => wanted.has(row.sessionId)) }
}

/**
 * Derive the model card's performance means from one folded totals row:
 * speed and first token over the streaming samples, end-to-end latency over
 * successful requests with valid timing only. No streaming samples (or no
 * timed requests at all) yields `undefined` — the row renders 「无计时数据」 rather than a
 * fabricated mean.
 */
function perfOf(totals: UsageTotals): ModelPerf | undefined {
  const samples = totals.perfStreamCount ?? 0
  const latencySum = totals.perfLatencyMsSum
  const timedRequests = totals.perfLatencyCount ?? 0
  if (samples <= 0 || timedRequests <= 0 || latencySum === undefined) return undefined
  return {
    tokensPerSec: (totals.perfStreamTpsSum ?? 0) / samples,
    firstTokenMs: (totals.perfStreamFirstMsSum ?? 0) / samples,
    latencyMs: latencySum / timedRequests,
    timedRequests,
    samples,
  }
}

/**
 * Attach the cost layer to a token-only summary: each rate row is priced at
 * the prices its rate identity resolves to under the current table, folded
 * into per-model costs, the total, the unpriced model list, and the table
 * itself. Purely additive — totals, day rows, and the recent window are
 * returned untouched, so the token aggregation (and the rollup format)
 * never carries currency. Stored identities must match the current context.
 *
 * With a canonical map, byModel rows and the aux per-kind detail lines that
 * hit the same feed model (the modelId or any of its aliases) fold onto that
 * modelId; unpriced names group by their complete case-insensitive name,
 * retaining display spelling. rateRows / byHour / bySession keep the
 * effective name (response model when the adapter reported one, the routed
 * name otherwise) so a later pricing update can regroup without rebuild.
 * @param summary - the aggregated summary (build or filtered).
 * @param pricing - the active pricing table.
 * @param canonical - alias → modelId map; empty / omitted leaves raw names.
 * @returns the same summary plus the cost fields.
 */
export function attachCosts(
  summary: TokenSummary & { dataDir: string; costState?: CostState },
  pricing: PricingTable,
  canonical: ReadonlyMap<string, string> = new Map(),
  context?: PricingContext,
): CostedSummary {
  const costState = summary.costState
    ?? (context?.available === false ? 'pricing-unavailable' : 'ready')
  const rulesOf = (name: string): ModelRates | undefined => costState !== 'ready' ? undefined
    : context !== undefined ? context.ratesForModel(name) : pricing[name]
  const costs = new Map<string, number>()
  let totalCost = 0
  for (const row of summary.rateRows) {
    const rules = rulesOf(row.model)
    if (rules === undefined) continue
    const cost = costOf(row.totals, ratesForKey(rules, row.rate))
    costs.set(row.model, (costs.get(row.model) ?? 0) + cost)
    totalCost += cost
  }
  // Session cells bill from their own rate identity — the same units the
  // per-model cost folds from, so the session table's cost column and the
  // summary card reconcile without any extra plumbing. An unpriced model's
  // cells stay 0 and surface through unpricedModels as before.
  const bySession: CostedSessionCell[] = summary.bySession.map(row => {
    const rules = rulesOf(row.model)
    return {
      ...row,
      cost: rules === undefined ? 0 : costOf(row.totals, ratesForKey(rules, row.rate)),
    }
  })
  // The auxiliary layer: the same rate identity pricing as the model rows,
  // folded per kind for the settings page's runtime-overhead tab, and per
  // model inside each kind (the tab renders one detail line per model,
  // keyed by the canonical id exactly like the byModel table — a priced
  // alias family renders as one row, not one line per raw route name). Its
  // token totals are already inside the rate rows (so totalCost/cost-per-model
  // include it); this split must never be added to `totalCost` again.
  const auxTotals = emptyTotals()
  let auxTotalCost = 0
  const auxByKind = new Map<AuxKind, {
    totals: UsageTotals
    cost: number
    byModel: Map<string, { totals: UsageTotals, cost: number }>
  }>()
  for (const row of summary.auxRows ?? []) {
    addTotals(auxTotals, row.totals)
    const rules = rulesOf(row.model)
    const cost = rules === undefined ? 0 : costOf(row.totals, ratesForKey(rules, row.rate))
    auxTotalCost += cost
    const kindCell = auxByKind.get(row.auxKind)
      ?? { totals: emptyTotals(), cost: 0, byModel: new Map() }
    addTotals(kindCell.totals, row.totals)
    kindCell.cost += cost
    const name = canonicalName(row.model, canonical)
    const modelCell = kindCell.byModel.get(name) ?? { totals: emptyTotals(), cost: 0 }
    addTotals(modelCell.totals, row.totals)
    modelCell.cost += cost
    kindCell.byModel.set(name, modelCell)
    auxByKind.set(row.auxKind, kindCell)
  }
  const aux: AuxSummary = {
    total: auxTotals,
    cost: auxTotalCost,
    byKind: AUX_KINDS
      .filter(kind => auxByKind.has(kind))
      .map(kind => {
        const cell = auxByKind.get(kind)!
        const byModel = [...cell.byModel.entries()]
          .map(([model, value]) => ({ model, totals: value.totals, cost: value.cost }))
          .sort((left, right) =>
            right.totals.requests - left.totals.requests || left.model.localeCompare(right.model))
        return { auxKind: kind, totals: cell.totals, cost: cell.cost, byModel }
      }),
  }
  const folded = new Map<string, { model: string, totals: UsageTotals, cost: number }>()
  for (const row of summary.byModel) {
    const name = canonicalName(row.model, canonical)
    const key = modelKey(name)
    const existing = folded.get(key)
    if (existing === undefined) {
      const totals = emptyTotals()
      addTotals(totals, row.totals)
      folded.set(key, { model: name, totals, cost: costs.get(row.model) ?? 0 })
    } else {
      addTotals(existing.totals, row.totals)
      existing.cost += costs.get(row.model) ?? 0
    }
  }
  // The performance means derive once per folded model row, after every
  // same-family row's accumulators merged — a per-row derivation would
  // average the aliases separately and disagree with the folded tokens.
  const byModel: CostedModelRow[] = [...folded.values()].map(row => {
    const perf = perfOf(row.totals)
    return { model: row.model, totals: row.totals, cost: row.cost, ...(perf !== undefined ? { perf } : {}) }
  })
    .sort((left, right) =>
      right.totals.requests - left.totals.requests || left.model.localeCompare(right.model))
  const unpricedModels = byModel
    .filter(row => context !== undefined ? context.resolveModel(row.model).status !== 'matched' : pricing[row.model] === undefined)
    .map(row => row.model)
  return {
    dataDir: summary.dataDir,
    total: summary.total,
    totalCost,
    costState,
    ...(context?.feedVersion !== undefined ? { feedVersion: context.feedVersion } : {}),
    ...(context?.associations.state === 'unavailable' ? { associationStorageError: context.associations.error } : {}),
    ...(context?.unavailableReason !== undefined ? { pricingUnavailableReason: context.unavailableReason } : {}),
    modelResolutions: context === undefined ? [] : summary.byModel.map(row => context.resolveModel(row.model)),
    unpricedModels,
    pricing,
    byDay: summary.byDay,
    byHour: summary.byHour,
    byModel,
    bySession,
    rateRows: summary.rateRows,
    auxRows: summary.auxRows,
    aux,
    recent: summary.recent,
  }
}

/** How many session rows the route sends, counted after the fold — the
 * truncation that makes folding a server-side concern in the first place. */
export const SESSION_ROW_LIMIT = 1000

/** One entry of the session-metadata index the fold reads identities from
 * (the duck-typed projection of `session-meta.ts`'s store). */
export interface SessionMetaEntry {
  title?: string
  cwd?: string
  parentSession?: string
}

/**
 * Fold the costed per-session cells into the final rows the settings page's
 * session table renders: one row per top-level session with its whole
 * subtree merged in, priced, sorted by cost descending, and truncated to
 * `limit` — the fold changes ranking (a parent row ranks by its subtree's
 * cost), so the cut must see the folded order or it would drop the wrong
 * rows. Subagents never surface as rows of their own; the row's
 * `childCount` badge is their only visibility here (the conversation view's
 * subagent table owns the per-child drill-down).
 *
 * Fold rules all converge on "the sum never changes": a session without a
 * `parentSession` is a root, a parent missing from the cells (or from the
 * index) leaves the child a top-level row, nested subagents walk to the
 * topmost root, and a defensive cut on a parent cycle keeps every row as
 * its own root rather than dropping one. Identity fields (title, cwd) come
 * from the metadata index — the server attaches them so the wire carries
 * final rows and the client never reassembles anything.
 * @param summary - the (already filtered) costed summary.
 * @param meta - the session-metadata index (id → identity fields).
 * @param limit - maximum rows returned.
 * @returns the truncated, cost-descending session rows.
 */
export function buildSessionRows(
  summary: CostedSummary,
  meta: ReadonlyMap<string, SessionMetaEntry>,
  limit: number,
): SessionUsageRow[] {
  interface Accum {
    totals: UsageTotals
    cost: number
    firstTime: number
    lastTime: number
  }
  const cells = new Map<string, Accum>()
  for (const cell of summary.bySession) {
    const bucket = cells.get(cell.sessionId) ?? {
      totals: emptyTotals(),
      cost: 0,
      firstTime: dayStart(cell.day),
      lastTime: cell.lastTime,
    }
    addTotals(bucket.totals, cell.totals)
    bucket.cost += cell.cost
    const dayStartMs = dayStart(cell.day)
    if (dayStartMs < bucket.firstTime) bucket.firstTime = dayStartMs
    if (cell.lastTime > bucket.lastTime) bucket.lastTime = cell.lastTime
    cells.set(cell.sessionId, bucket)
  }
  // Lineage index: a parent the index never saw is the same as no parent.
  const parentOf = new Map<string, string>()
  for (const [id, entry] of meta) {
    if (entry.parentSession !== undefined && entry.parentSession !== '') parentOf.set(id, entry.parentSession)
  }
  // Walk up the lineage to the topmost ancestor that holds cells; a parent
  // outside the cells (no usage in the window, or an orphan) ends the walk,
  // and a `seen` guard turns a pathological cycle into a top-level row.
  const rootOf = (id: string): string => {
    let current = id
    const seen = new Set<string>([id])
    for (;;) {
      const parent = parentOf.get(current)
      if (parent === undefined || seen.has(parent) || !cells.has(parent)) return current
      seen.add(parent)
      current = parent
    }
  }
  // Two-pass fold: group every session's accumulation under its root
  // first, then merge each group — order-independent, so iteration order
  // cannot double-count a root or drop a child that landed first.
  const grouped = new Map<string, Accum[]>()
  for (const [id, accum] of cells) {
    const root = rootOf(id)
    const bucket = grouped.get(root) ?? []
    bucket.push(accum)
    grouped.set(root, bucket)
  }
  const rows = new Map<string, { accum: Accum; childCount: number }>()
  for (const [root, accums] of grouped) {
    const merged: Accum = { totals: emptyTotals(), cost: 0, firstTime: accums[0]!.firstTime, lastTime: accums[0]!.lastTime }
    for (const accum of accums) {
      addTotals(merged.totals, accum.totals)
      merged.cost += accum.cost
      if (accum.firstTime < merged.firstTime) merged.firstTime = accum.firstTime
      if (accum.lastTime > merged.lastTime) merged.lastTime = accum.lastTime
    }
    // The root itself is one of the group's sessions (rootOf always lands
    // on a session that holds cells); the rest are its folded descendants.
    rows.set(root, { accum: merged, childCount: accums.length - 1 })
  }
  const entryOf = (id: string): SessionMetaEntry | undefined => {
    const entry = meta.get(id)
    return entry !== undefined && (entry.title !== undefined || entry.cwd !== undefined)
      ? { ...(entry.title !== undefined ? { title: entry.title } : {}), ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}) }
      : undefined
  }
  const out: SessionUsageRow[] = [...rows.entries()].map(([sessionId, { accum, childCount }]) => {
    const entry = entryOf(sessionId)
    return {
      sessionId,
      ...(entry !== undefined ? entry : {}),
      // The folded-descendants badge: a subagent subtree's only visibility
      // in this table (count 0 omits the key entirely).
      ...(childCount > 0 ? { childCount } : {}),
      totals: accum.totals,
      cost: accum.cost,
      firstTime: accum.firstTime,
      lastTime: accum.lastTime,
    }
  })
  out.sort((left, right) =>
    right.cost - left.cost || right.lastTime - left.lastTime
      || (left.sessionId < right.sessionId ? -1 : 1))
  return out.length > limit ? out.slice(0, limit) : out
}

/**
 * Read every day file into records, in day-file order. An absent data
 * directory (nothing written yet) yields an empty list. Uncached — the
 * session-scoped route uses `readCachedRecords` so repeated chip /
 * usage-tab polls do not re-parse frozen files.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */export async function readAllRecords(dir: string, logger: LoggerLike = consoleLogger): Promise<UsageRecord[]> {
  const records: UsageRecord[] = []
  for (const name of await listDayFiles(dir)) {
    records.push(...await readDayFile(dir, name, logger))
  }
  return records
}

/**
 * Build the full stats payload for one data directory: the rollup over every
 * frozen day file (advanced lazily and rewritten atomically when unabsorbed
 * frozen files appear) merged with a fresh read of today's file. Day files
 * named at or after today but already absorbed by a later rollup `upto` are
 * skipped, so a clock stepping back cannot count an absorbed file twice.
 * A failed rollup write logs and does not block the response — the next read
 * retries the absorption. The resolver prices each record as it is absorbed,
 * so the rollup carries rate identities (never prices). Changed pricing
 * fingerprints rebuild those identities from the original records.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @param resolve - the rate resolver (see {@link RateResolver}).
 * @returns the summary served to the web settings page.
 */
interface PricingBuildOptions {
  fingerprint: string
  /** Checked immediately before publishing derived state. */
  isCurrent: () => Promise<boolean>
}

const summaryQueues = new Map<string, Promise<unknown>>()

/** History sync invalidations share the rebuild queue, including temp files. */
export async function invalidateSummary(dir: string): Promise<void> {
  const previous = summaryQueues.get(dir) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(async () => {
    for (const name of [ROLLUP_FILE_NAME, ROLLUP_TMP_FILE_NAME]) {
      await unlink(join(dir, name)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  })
  summaryQueues.set(dir, task)
  try { await task } finally { if (summaryQueues.get(dir) === task) summaryQueues.delete(dir) }
}

export async function buildSummary(
  dir: string,
  now: () => Date = () => new Date(),
  resolve: RateResolver = () => UNPRICED_KEY,
  logger: LoggerLike = consoleLogger,
  pricing?: PricingBuildOptions,
): Promise<TokenSummary & { dataDir: string; costState?: CostState }> {
  const previous = summaryQueues.get(dir) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(() => buildSummaryLocked(dir, now, resolve, logger, pricing))
  summaryQueues.set(dir, task)
  try { return await task } finally { if (summaryQueues.get(dir) === task) summaryQueues.delete(dir) }
}

async function buildSummaryLocked(
  dir: string, now: () => Date, resolve: RateResolver, logger: LoggerLike,
  pricing: PricingBuildOptions | undefined,
): Promise<TokenSummary & { dataDir: string; costState?: CostState }> {
  const today = dayKey(now().getTime())
  const stored = (await readRollup(dir, logger)) ?? emptyRollup()
  // A stale aggregate shape rebuilds exactly like a pricing-fingerprint
  // change: the day files are re-absorbed so dimensions the old shape never
  // carried (the performance accumulators) backfill over the whole history.
  // The rebuild runs once — the rewritten rollup carries the new format.
  const rebuild = stored.requiresRebuild === true
    || (pricing !== undefined && stored.pricingFingerprint !== pricing.fingerprint)
    || (stored.aggregateFormat ?? 1) !== ROLLUP_AGGREGATE_FORMAT
  const rollup = rebuild ? emptyRollup() : stored
  const names = await listDayFiles(dir)
  const cold: string[] = []
  const hot: string[] = []
  for (const name of names) {
    const day = fileDay(name)!
    if (day <= rollup.upto) continue
    if (day < today || (rebuild && day <= stored.upto)) cold.push(name)
    else hot.push(name)
  }
  let absorbed = rollup
  const incomplete = async (): Promise<TokenSummary & { dataDir: string; costState: CostState }> => {
    logger.warn('[token-usage] historical source records are incomplete; retaining usage and hiding costs')
    const newer: UsageRecord[] = []
    for (const name of names) if (fileDay(name)! > stored.upto) newer.push(...await readDayFile(dir, name, logger))
    return { dataDir: dir, ...mergeSummaries(stored, summarizeRecords(newer, resolve)), costState: 'history-incomplete' }
  }
  if (rebuild && stored.sourceFiles?.some(name => !names.includes(name))) return incomplete()
  if (cold.length > 0) {
    // names are date-ascending, so the last cold file carries the new upto
    const records: UsageRecord[] = []
    const oldRecords: UsageRecord[] = []
    for (const name of cold) {
      const parsed = await readDayFileChecked(dir, name, logger)
      if (pricing !== undefined && !parsed.complete) return incomplete()
      const rows = parsed.records
      records.push(...rows)
      if (fileDay(name)! <= stored.upto) oldRecords.push(...rows)
    }
    if (rebuild && stored.upto !== '') {
      const recovered = summarizeRecords(oldRecords).total
      const fields = ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'failures', 'compactions'] as const
      if (fields.some(field => (recovered[field] ?? 0) < (stored.total[field] ?? 0))) {
        return incomplete()
      }
    }
    absorbed = {
      upto: fileDay(cold[cold.length - 1]!)!,
      ...mergeSummaries(rollup, summarizeRecords(records, resolve)),
      aggregateFormat: ROLLUP_AGGREGATE_FORMAT,
      ...(pricing !== undefined ? { pricingFingerprint: pricing.fingerprint } : {}),
      sourceFiles: [...new Set([...rollup.sourceFiles ?? [], ...cold])].sort(),
    }
    if (pricing === undefined || await pricing.isCurrent()) {
      await writeRollup(dir, absorbed).catch((error: unknown) => {
        logger.error('[token-usage] cannot write rollup:', error)
      })
    }
  } else if (rebuild && (stored.total.requests > 0 || (stored.total.failures ?? 0) > 0)) {
    return incomplete()
  }
  const fresh: UsageRecord[] = []
  let complete = true
  for (const name of hot) {
    const parsed = await readDayFileChecked(dir, name, logger)
    fresh.push(...parsed.records)
    complete &&= parsed.complete
  }
  return { dataDir: dir, ...mergeSummaries(absorbed, summarizeRecords(fresh, resolve)),
    ...(pricing !== undefined && !complete ? { costState: 'history-incomplete' as const } : {}) }
}
