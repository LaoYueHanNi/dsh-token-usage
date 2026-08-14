/**
 * Stats computation of the token-usage plugin: read the day files and fold
 * the records into totals, per-day rows, per-model rows, and a bounded recent
 * window. Frozen (pre-today) day files are served from the on-disk rollup
 * (see rollup.ts); only today's file is read on every call. Pure aggregation
 * lives apart from the file walk so the web route and tests share one
 * implementation.
 *
 * @module token-usage/stats
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRecord } from './usage-record.ts'
import type { UsageFields, UsageRecord } from './usage-record.ts'
import { readRollup, writeRollup } from './rollup.ts'
import type { RollupFile } from './rollup.ts'
import type { UsageDayModelRow, UsageDayRow, UsageModelRow, UsageSummary, UsageTotals } from './wire.ts'

const DAY_FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/u

/** Bounded recent window length: only the newest records cross the wire. */
export const RECENT_LIMIT = 20

/** The date part of a day-file name, or null for a foreign name. */
function fileDay(name: string): string | null {
  return DAY_FILE.exec(name)?.[1] ?? null
}

/** Empty rollup used as the merge base when no rollup exists on disk yet. */
function emptyRollup(): RollupFile {
  return { upto: '', total: emptyTotals(), byDay: [], byModel: [], byDayModel: [], recent: [] }
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

/** Sort crossed rows day ascending then model name. */
function dayModelRows(rows: Iterable<UsageDayModelRow>): UsageDayModelRow[] {
  return [...rows].sort((left, right) =>
    left.day < right.day ? -1 : left.day > right.day ? 1 : left.model.localeCompare(right.model))
}

/** Map key of one crossed (day, model) cell. */
function crossKey(day: string, model: string): string {
  return `${day}\n${model}`
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

/**
 * Fold records into the summary shape. The recent window keeps the last
 * {@link RECENT_LIMIT} records in input order (day files are chronological)
 * and then sorts them by time descending.
 * @param records - parsed records in day-file order.
 * @returns totals, day rows, model rows, and the recent window.
 */
export function summarizeRecords(records: readonly UsageRecord[]): Omit<UsageSummary, 'dataDir'> {
  const total = emptyTotals()
  const days = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  const crossed = new Map<string, UsageDayModelRow>()
  const recent: UsageRecord[] = []
  for (const record of records) {
    addUsage(total, record.usage)
    const day = dayKey(record.time)
    const dayTotals = days.get(day) ?? emptyTotals()
    addUsage(dayTotals, record.usage)
    days.set(day, dayTotals)
    const modelTotals = models.get(record.model) ?? emptyTotals()
    addUsage(modelTotals, record.usage)
    models.set(record.model, modelTotals)
    const cell = crossed.get(crossKey(day, record.model))
      ?? { day, model: record.model, totals: emptyTotals() }
    addUsage(cell.totals, record.usage)
    crossed.set(crossKey(day, record.model), cell)
    if (recent.length === RECENT_LIMIT) recent.shift()
    recent.push(record)
  }
  const byDay: UsageDayRow[] = dayRows(days)
  const byModel: UsageModelRow[] = modelRows(models)
  const byDayModel: UsageDayModelRow[] = dayModelRows(crossed.values())
  recent.sort((left, right) => right.time - left.time)
  return { total, byDay, byModel, byDayModel, recent }
}

/**
 * Merge two summaries into one: totals and model rows add up, day rows fold
 * by day key (a same-day record set landing in a later file must join the
 * earlier bucket, never replace it), crossed rows fold by their (day, model)
 * key, and the recent window keeps the newest {@link RECENT_LIMIT} records
 * across both sides. Order-independent and associative: merging partial
 * summaries equals summarizing the concatenated records.
 * @param left - one partial summary.
 * @param right - the other partial summary.
 * @returns the folded summary.
 */
export function mergeSummaries(
  left: Omit<UsageSummary, 'dataDir'>,
  right: Omit<UsageSummary, 'dataDir'>,
): Omit<UsageSummary, 'dataDir'> {
  const total = emptyTotals()
  addTotals(total, left.total)
  addTotals(total, right.total)
  const days = new Map<string, UsageTotals>()
  const models = new Map<string, UsageTotals>()
  const crossed = new Map<string, UsageDayModelRow>()
  for (const row of [...left.byDay, ...right.byDay]) {
    const day = days.get(row.day) ?? emptyTotals()
    addTotals(day, row.totals)
    days.set(row.day, day)
  }
  for (const row of [...left.byModel, ...right.byModel]) {
    const model = models.get(row.model) ?? emptyTotals()
    addTotals(model, row.totals)
    models.set(row.model, model)
  }
  for (const row of [...left.byDayModel, ...right.byDayModel]) {
    const cell = crossed.get(crossKey(row.day, row.model))
      ?? { day: row.day, model: row.model, totals: emptyTotals() }
    addTotals(cell.totals, row.totals)
    crossed.set(crossKey(row.day, row.model), cell)
  }
  const recent = [...left.recent, ...right.recent]
    .sort((a, b) => b.time - a.time)
    .slice(0, RECENT_LIMIT)
  return {
    total,
    byDay: dayRows(days),
    byModel: modelRows(models),
    byDayModel: dayModelRows(crossed.values()),
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
 * filter, drawing every dimension from the crossed (day × model) rows so no
 * file is reread. The recent window filters on its record timestamps
 * ([from 00:00, to 23:59:59.999] local). No filters returns the input as-is.
 * @param summary - the unfiltered summary.
 * @param from - first day key (`YYYY-MM-DD`), inclusive.
 * @param to - last day key (`YYYY-MM-DD`), inclusive.
 * @param model - exact model id.
 * @returns the filtered summary.
 */
export function filterSummary(
  summary: UsageSummary,
  from?: string,
  to?: string,
  model?: string,
): UsageSummary {
  if (from === undefined && to === undefined && model === undefined) return summary
  const rows = summary.byDayModel.filter(row =>
    (from === undefined || row.day >= from)
    && (to === undefined || row.day <= to)
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
  return { dataDir: summary.dataDir, total, byDay: dayRows(days), byModel: modelRows(models), byDayModel: rows, recent }
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
 * retries the absorption.
 * @param dir - the plugin's data directory.
 * @param now - clock source for the frozen/today boundary (test seam).
 * @returns the summary served to the web settings page.
 */
export async function buildSummary(dir: string, now: () => Date = () => new Date()): Promise<UsageSummary> {
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
      ...mergeSummaries(rollup, summarizeRecords(records)),
    }
    await writeRollup(dir, absorbed).catch((error: unknown) => {
      console.error('[token-usage] cannot write rollup:', error)
    })
  }
  const fresh: UsageRecord[] = []
  for (const name of hot) fresh.push(...await readDayFile(dir, name))
  return { dataDir: dir, ...mergeSummaries(absorbed, summarizeRecords(fresh)) }
}
