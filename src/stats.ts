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

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { costOf, ratesForKey } from './pricing.ts'
import { parseRecord } from './usage-record.ts'
import type { UsageFields, UsageRecord } from './usage-record.ts'
import { readRollup, writeRollup } from './rollup.ts'
import type { RollupFile } from './rollup.ts'
import type {
  CostedModelRow,
  CostedSummary,
  PricingTable,
  RateKey,
  TokenSummary,
  UsageDayRow,
  UsageHourRow,
  UsageModelRow,
  UsageRateRow,
  UsageTotals,
} from './wire.ts'
import { UNPRICED_KEY } from './wire.ts'

const DAY_FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/u

/** Bounded recent window length: only the newest records cross the wire. */
export const RECENT_LIMIT = 20

/**
 * Resolves the rate identity one record was billed at. The route builds this
 * from the pricing table (pricing.resolveRate over the record's model, time,
 * and input-side tokens); the neutral default leaves every record unpriced.
 */
export type RateResolver = (record: UsageRecord) => RateKey

/** The date part of a day-file name, or null for a foreign name. */
function fileDay(name: string): string | null {
  return DAY_FILE.exec(name)?.[1] ?? null
}

/** Empty rollup used as the merge base when no rollup exists on disk yet. */
function emptyRollup(): RollupFile {
  return { upto: '', total: emptyTotals(), byDay: [], byHour: [], byModel: [], rateRows: [], recent: [] }
}

/** Zeroed totals; requests counts rows, the token buckets sum reported usage. */
export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

/** Add one totals row into another, field by field. */
function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.requests += source.requests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
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

/**
 * Fold one record into totals; a record without provider usage still counts a request. */
function addUsage(totals: UsageTotals, usage: UsageFields | undefined): void {
  totals.requests += 1
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
 * rate identity) the resolver assigns. The recent window keeps the last
 * {@link RECENT_LIMIT} records in input order (day files are chronological)
 * and then sorts them by time descending.
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
  const recent: UsageRecord[] = []
  for (const record of records) {
    addUsage(total, record.usage)
    const day = dayKey(record.time)
    const dayTotals = days.get(day) ?? emptyTotals()
    addUsage(dayTotals, record.usage)
    days.set(day, dayTotals)
    const hour = hourKey(record.time)
    const hourTotals = hours.get(hourRowKey(hour, record.model)) ?? emptyTotals()
    addUsage(hourTotals, record.usage)
    hours.set(hourRowKey(hour, record.model), hourTotals)
    const modelTotals = models.get(record.model) ?? emptyTotals()
    addUsage(modelTotals, record.usage)
    models.set(record.model, modelTotals)
    const rate = resolve(record)
    const rowKey = rateRowKey(day, record.model, rate)
    const cell = rated.get(rowKey)
      ?? { day, model: record.model, rate, totals: emptyTotals() }
    addUsage(cell.totals, record.usage)
    rated.set(rowKey, cell)
    if (recent.length === RECENT_LIMIT) recent.shift()
    recent.push(record)
  }
  const byDay: UsageDayRow[] = dayRows(days)
  const byHour: UsageHourRow[] = hourRows(hours)
  const byModel: UsageModelRow[] = modelRows(models)
  recent.sort((left, right) => right.time - left.time)
  return { total, byDay, byHour, byModel, rateRows: rateRowsSorted(rated.values()), recent }
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
  const recent = [...left.recent, ...right.recent]
    .sort((a, b) => b.time - a.time)
    .slice(0, RECENT_LIMIT)
  return {
    total,
    byDay: dayRows(days),
    byHour: hourRows(hours),
    byModel: modelRows(models),
    rateRows: rateRowsSorted(rated.values()),
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
 * @param summary - the unfiltered summary.
 * @param from - first day key (`YYYY-MM-DD`), inclusive.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id.
 * @returns the filtered summary.
 */
export function filterSummary(
  summary: TokenSummary & { dataDir: string },
  from?: string,
  to?: string,
  model?: string,
): TokenSummary & { dataDir: string } {
  if (from === undefined && to === undefined && model === undefined) return summary
  const rows = summary.rateRows.filter(row =>
    (from === undefined || row.day >= from)
    && (to === undefined || row.day <= to)
    && (model === undefined || row.model === model))
  // Hour rows filter on their day prefix (the `YYYY-MM-DD` part of the key).
  const byHour = summary.byHour.filter(row =>
    (from === undefined || row.hour.slice(0, 10) >= from)
    && (to === undefined || row.hour.slice(0, 10) <= to)
    && (model === undefined || row.model === model))
  const total = emptyTotals()
  const days = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  for (const row of rows) {
    addTotals(total, row.totals)
    const day = days.get(row.day) ?? emptyTotals()
    addTotals(day, row.totals)
    days.set(row.day, day)
    const perModel = models.get(row.model) ?? emptyTotals()
    addTotals(perModel, row.totals)
    models.set(row.model, perModel)
  }
  const start = from !== undefined ? dayStart(from) : undefined
  const end = to !== undefined ? dayStart(to) + 86_399_999 : undefined
  const recent = summary.recent.filter(record =>
    (start === undefined || record.time >= start)
    && (end === undefined || record.time <= end)
    && (model === undefined || record.model === model))
  return { dataDir: summary.dataDir, total, byDay: dayRows(days), byHour, byModel: modelRows(models), rateRows: rateRowsSorted(rows), recent }
}

/**
 * Attach the cost layer to a token-only summary: each rate row is priced at
 * the prices its rate identity resolves to under the current table, folded
 * into per-model costs, the total, the unpriced model list, and the table
 * itself. Purely additive — totals, day rows, and the recent window are
 * returned untouched, so the token aggregation (and the rollup format)
 * never carries currency, and an updated table re-prices history for free.
 * @param summary - the aggregated summary (build or filtered).
 * @param pricing - the active pricing table.
 * @returns the same summary plus the cost fields.
 */
export function attachCosts(summary: TokenSummary & { dataDir: string }, pricing: PricingTable): CostedSummary {
  const costs = new Map<string, number>()
  let totalCost = 0
  for (const row of summary.rateRows) {
    const rules = pricing[row.model]
    if (rules === undefined) continue
    const cost = costOf(row.totals, ratesForKey(rules, row.rate))
    costs.set(row.model, (costs.get(row.model) ?? 0) + cost)
    totalCost += cost
  }
  const byModel: CostedModelRow[] = summary.byModel.map(row => ({
    model: row.model,
    totals: row.totals,
    cost: costs.get(row.model) ?? 0,
  }))
  const unpricedModels = summary.byModel
    .filter(row => pricing[row.model] === undefined)
    .map(row => row.model)
  return {
    dataDir: summary.dataDir,
    total: summary.total,
    totalCost,
    unpricedModels,
    pricing,
    byDay: summary.byDay,
    byHour: summary.byHour,
    byModel,
    rateRows: summary.rateRows,
    recent: summary.recent,
  }
}

/**
 * Read one day file into records. Malformed lines are skipped silently —
 * unlike the sync scan's dedupe pass, the stats read runs on every page
 * refresh and must not spam the console over one bad row. An unreadable
 * file logs once and reads as empty, so a corrupt log never blocks stats.
 * @param dir - the plugin's data directory.
 * @param name - the day-file name.
 */
async function readDayFile(dir: string, name: string): Promise<UsageRecord[]> {
  const text = await readFile(join(dir, name), 'utf8').catch((error: unknown) => {
    console.error(`[token-usage] cannot read ${name}:`, error)
    return ''
  })
  const records: UsageRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const record = parseRecord(line)
    if (record !== null) records.push(record)
  }
  return records
}

/** List the data directory's day-file names in ascending date order ([] when absent). */
async function listDayFiles(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter(name => fileDay(name) !== null).sort()
}

/**
 * Read every day file into records, in day-file order. An absent data
 * directory (nothing written yet) yields an empty list.
 * @param dir - the plugin's data directory.
 * @returns parsed records, or [] when the directory does not exist.
 */
export async function readAllRecords(dir: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = []
  for (const name of await listDayFiles(dir)) {
    records.push(...await readDayFile(dir, name))
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
 * so the rollup carries rate identities (never prices) and a table update
 * re-prices history without rebuilding anything.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @param resolve - the rate resolver (see {@link RateResolver}).
 * @returns the summary served to the web settings page.
 */
export async function buildSummary(
  dir: string,
  now: () => Date = () => new Date(),
  resolve: RateResolver = () => UNPRICED_KEY,
): Promise<TokenSummary & { dataDir: string }> {
  const today = dayKey(now().getTime())
  const rollup = (await readRollup(dir)) ?? emptyRollup()
  const cold: string[] = []
  const hot: string[] = []
  for (const name of await listDayFiles(dir)) {
    const day = fileDay(name)!
    if (day <= rollup.upto) continue
    if (day < today) cold.push(name)
    else hot.push(name)
  }
  let absorbed = rollup
  if (cold.length > 0) {
    // names are date-ascending, so the last cold file carries the new upto
    const records: UsageRecord[] = []
    for (const name of cold) records.push(...await readDayFile(dir, name))
    absorbed = {
      upto: fileDay(cold[cold.length - 1]!)!,
      ...mergeSummaries(rollup, summarizeRecords(records, resolve)),
    }
    await writeRollup(dir, absorbed).catch((error: unknown) => {
      console.error('[token-usage] cannot write rollup:', error)
    })
  }
  const fresh: UsageRecord[] = []
  for (const name of hot) fresh.push(...await readDayFile(dir, name))
  return { dataDir: dir, ...mergeSummaries(absorbed, summarizeRecords(fresh, resolve)) }
}
