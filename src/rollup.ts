/**
 * The per-day rollup store of the token-usage plugin: an on-disk aggregate of
 * every frozen (pre-today) day file. Day files are immutable once their date
 * has passed — writes always append to the file of the current day — so an
 * absorbed aggregate never goes stale and needs no invalidation. The stats
 * read advances the rollup lazily: whenever unabsorbed frozen files exist,
 * they are folded in and the rollup is rewritten atomically (temp file +
 * rename, like the sync marker). A missing or malformed rollup simply reads
 * as absent and is rebuilt from the day files.
 *
 * @module token-usage/rollup
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { coerceRecord } from './usage-record.ts'
import type { UsageRecord } from './usage-record.ts'
import type { UsageDayModelRow, UsageDayRow, UsageModelRow, UsageTotals } from './wire.ts'

const ROLLUP_FILE = 'rollup.json'
const TMP_FILE = 'rollup.json.tmp'

/** The on-disk rollup: the aggregate of every day file named ≤ {@link RollupFile.upto}. */
export interface RollupFile {
  /** Inclusive upper date (`YYYY-MM-DD`) of the day files already absorbed. */
  upto: string
  /** Totals over every absorbed record. */
  total: UsageTotals
  /** Per-local-day rows of the absorbed records, ascending by day. */
  byDay: UsageDayRow[]
  /** Per-model rows of the absorbed records, descending on request count. */
  byModel: UsageModelRow[]
  /** Per-day × per-model rows of the absorbed records, day then model ascending. */
  byDayModel: UsageDayModelRow[]
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

function isModelRow(value: unknown): value is UsageModelRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.model === 'string' && isTotals(row.totals)
}

function isDayModelRow(value: unknown): value is UsageDayModelRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.day === 'string' && DAY_KEY.test(row.day)
    && typeof row.model === 'string' && isTotals(row.totals)
}

function isRollupFile(value: unknown): value is RollupFile {
  if (typeof value !== 'object' || value === null) return false
  const rollup = value as Record<string, unknown>
  return typeof rollup.upto === 'string' && DAY_KEY.test(rollup.upto)
    && isTotals(rollup.total)
    && Array.isArray(rollup.byDay) && rollup.byDay.every(isDayRow)
    && Array.isArray(rollup.byModel) && rollup.byModel.every(isModelRow)
    && Array.isArray(rollup.byDayModel) && rollup.byDayModel.every(isDayModelRow)
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
export async function readRollup(dir: string): Promise<RollupFile | null> {
  let text: string
  try {
    text = await readFile(join(dir, ROLLUP_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error('[token-usage] cannot read rollup:', error)
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
