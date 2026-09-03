/**
 * The per-day rollup store of the token-usage plugin: an on-disk aggregate of
 * every frozen (pre-today) day file. Live appends go to the event's own day
 * file, so a history sync or refile can write through a frozen file; the
 * stats read drops the rollup after those writes (see index.ts) and rebuilds
 * it. The stats read also advances the rollup lazily: whenever unabsorbed
 * frozen files exist, they are folded in and the rollup is rewritten
 * atomically (temp file + rename, like the sync marker). A missing or
 * malformed rollup simply reads as absent and is rebuilt from the day files.
 *
 * @module token-usage/rollup
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleLogger, type LoggerLike } from './log.ts'
import { coerceRecord } from './usage-record.ts'
import type { UsageRecord } from './usage-record.ts'
import type { RateKey, UsageDayRow, UsageHourRow, UsageModelRow, UsageRateRow, UsageTotals } from './wire.ts'

const ROLLUP_FILE = 'rollup.json'
const TMP_FILE = 'rollup.json.tmp'

/** The rollup file name, exported so callers (e.g. the post-sync
 * invalidation in index.ts) can drop the derived state by one authority. */
export { ROLLUP_FILE as ROLLUP_FILE_NAME }
export { TMP_FILE as ROLLUP_TMP_FILE_NAME }

/** The on-disk rollup: the aggregate of every day file named ≤ {@link RollupFile.upto}. */
export interface RollupFile {
  /** Inclusive upper date (`YYYY-MM-DD`) of the day files already absorbed. */
  upto: string
  /** Totals over every absorbed record. */
  total: UsageTotals
  /** Per-local-day rows of the absorbed records, ascending by day. */
  byDay: UsageDayRow[]
  /** Per-hour × per-model rows of the absorbed records, ascending by hour
   * then model — feeds the single-day hourly trend chart without rereading
   * the frozen day files. */
  byHour: UsageHourRow[]
  /** Per-model rows of the absorbed records, descending on request count. */
  byModel: UsageModelRow[]
  /** Per-(day, model, rate identity) rows of the absorbed records — rule
   * identities, never prices, so an updated pricing table re-prices the
   * absorbed history without a rebuild. */
  rateRows: UsageRateRow[]
  /** The newest absorbed records, descending by time (bounded window). */
  recent: UsageRecord[]
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u

function isTotals(value: unknown): value is UsageTotals {
  if (typeof value !== 'object' || value === null) return false
  const totals = value as Record<string, unknown>
  return ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .every(key => typeof totals[key] === 'number' && Number.isFinite(totals[key]))
}

function isDayRow(value: unknown): value is UsageDayRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.day === 'string' && DAY_KEY.test(row.day) && isTotals(row.totals)
}

const HOUR_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}$/u

function isHourRow(value: unknown): value is UsageHourRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.hour === 'string' && HOUR_KEY.test(row.hour)
    && typeof row.model === 'string' && isTotals(row.totals)
}

function isModelRow(value: unknown): value is UsageModelRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.model === 'string' && isTotals(row.totals)
}

function isRateKey(value: unknown): value is RateKey {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Record<string, unknown>
  return ['ruleStart', 'ruleEnd', 'tier', 'slot'].every(field => typeof key[field] === 'number' && Number.isFinite(key[field]))
}

function isRateRow(value: unknown): value is UsageRateRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.day === 'string' && DAY_KEY.test(row.day)
    && typeof row.model === 'string' && isRateKey(row.rate) && isTotals(row.totals)
}

function isRollupFile(value: unknown): value is RollupFile {
  if (typeof value !== 'object' || value === null) return false
  const rollup = value as Record<string, unknown>
  return typeof rollup.upto === 'string' && DAY_KEY.test(rollup.upto)
    && isTotals(rollup.total)
    && Array.isArray(rollup.byDay) && rollup.byDay.every(isDayRow)
    && Array.isArray(rollup.byHour) && rollup.byHour.every(isHourRow)
    && Array.isArray(rollup.byModel) && rollup.byModel.every(isModelRow)
    && Array.isArray(rollup.rateRows) && rollup.rateRows.every(isRateRow)
    && Array.isArray(rollup.recent)
}

/**
 * Load the rollup of one data directory. A missing, malformed, or
 * structurally invalid rollup reads as null — the caller then rebuilds it
 * from the day files, so corruption never blocks the stats read. Invalid
 * entries inside the recent window are dropped instead of failing the whole
 * rollup, mirroring how malformed JSONL lines are skipped.
 * @param dir - the plugin's data directory.
 */
export async function readRollup(dir: string, logger: LoggerLike = consoleLogger): Promise<RollupFile | null> {
  let text: string
  try {
    text = await readFile(join(dir, ROLLUP_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    logger.error('[token-usage] cannot read rollup:', error)
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A torn or hand-edited rollup rebuilds from the day files.
    return null
  }
  if (!isRollupFile(value)) return null
  const recent = (value.recent as unknown[])
    .map(coerceRecord)
    .filter((record): record is UsageRecord => record !== null)
  return { ...value, recent }
}

/**
 * Persist the rollup atomically (temp file + rename), so a crash mid-write
 * leaves either the old or the new rollup, never a torn one.
 * @param dir - the plugin's data directory.
 * @param rollup - the rollup to persist.
 */
export async function writeRollup(dir: string, rollup: RollupFile): Promise<void> {
  const target = join(dir, ROLLUP_FILE)
  const tmp = join(dir, TMP_FILE)
  await writeFile(tmp, JSON.stringify(rollup), 'utf8')
  await rename(tmp, target)
}
