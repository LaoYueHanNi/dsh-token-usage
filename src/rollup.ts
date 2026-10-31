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
import { coerceRecord, AUX_KINDS } from './usage-record.ts'
import type { AuxKind, UsageRecord } from './usage-record.ts'
import type { RateKey, UsageAuxRow, UsageDayRow, UsageHourRow, UsageModelRow, UsageProviderRow, UsageRateRow, UsageSessionRow, UsageTotals } from './wire.ts'

const ROLLUP_FILE = 'rollup.json'
const TMP_FILE = 'rollup.json.tmp'

/**
 * The aggregate shape this build writes and expects. Bump when a totals
 * dimension gains a field the folding must carry (the timing accumulators
 * behind the performance view made shape 2, its valid latency count made
 * shape 3, and the provider route key on rate/session cells plus the
 * byProvider dimension made shape 4): a stored rollup under an older
 * value — or without the key, the pre-field shape 1 — is discarded and
 * rebuilt from the day files on the next stats read, the same path a
 * pricing-fingerprint change takes. Shape 1 carried every token dimension,
 * so a rebuild only backfills the new accumulators; usage never changes.
 */
export const ROLLUP_AGGREGATE_FORMAT = 4

/** The rollup file name, exported so callers (e.g. the post-sync
 * invalidation in index.ts) can drop the derived state by one authority. */
export { ROLLUP_FILE as ROLLUP_FILE_NAME }
export { TMP_FILE as ROLLUP_TMP_FILE_NAME }

/** The on-disk rollup: the aggregate of every day file named ≤ {@link RollupFile.upto}. */
export interface RollupFile {
  /** In-memory marker for readable legacy aggregates missing session cells. */
  requiresRebuild?: true
  /** Identification algorithm and feed rules used to select stored RateKeys. */
  pricingFingerprint?: string
  /** Aggregate-shape version the rollup was written under
   * ({@link ROLLUP_AGGREGATE_FORMAT}). Absent on rollups written before the
   * field existed (shape 1: totals without the timing accumulators) — a
   * mismatch makes the next stats read rebuild the rollup from the day
   * files, so a new aggregate dimension backfills over the absorbed
   * history without waiting for every frozen file to age past `upto`. */
  aggregateFormat?: number
  /** Files absorbed into this snapshot, used to detect unavailable history. */
  sourceFiles?: string[]
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
  /** Per-provider rows of the absorbed records (route key → totals; `''` =
   * unattributed), descending on request count with the unattributed group
   * last. A legacy rollup predating the dimension reads as an empty list
   * and rebuilds through `aggregateFormat`. */
  byProvider: UsageProviderRow[]
  /** Per-(day, model, rate identity) rows of the absorbed records — rule
   * identities, never prices; a changed pricing fingerprint rebuilds them
   * from raw records before repricing the absorbed history. */
  rateRows: UsageRateRow[]
  /** Per-(kind, day, model, rate identity) rows of the absorbed auxiliary
   * (bypass) requests — the settings page's runtime-overhead dimension. A
   * legacy rollup predating the dimension reads as an empty list: the
   * version that wrote it could not have recorded an auxiliary row, so no
   * absorbed usage is lost. */
  auxRows: UsageAuxRow[]
  /** Per-(session, day, model, rate identity) rows of the absorbed records
   * — the session dimension the settings page's session table folds from.
   * A legacy rollup missing this dimension retains usable totals but
   * requires a rebuild; unavailable source history hides unreliable costs. */
  bySession: UsageSessionRow[]
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

function isProviderRow(value: unknown): value is UsageProviderRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.provider === 'string' && isTotals(row.totals)
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
    && (row.provider === undefined || typeof row.provider === 'string')
}

function isSessionRow(value: unknown): value is UsageSessionRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.sessionId === 'string'
    && typeof row.day === 'string' && DAY_KEY.test(row.day)
    && typeof row.model === 'string' && isRateKey(row.rate)
    && (row.provider === undefined || typeof row.provider === 'string')
    && typeof row.lastTime === 'number' && Number.isFinite(row.lastTime)
    && isTotals(row.totals)
}

const AUX_KIND_SET = new Set<string>(AUX_KINDS)

function isAuxKind(value: unknown): value is AuxKind {
  return typeof value === 'string' && AUX_KIND_SET.has(value)
}

function isAuxRow(value: unknown): value is UsageAuxRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return isAuxKind(row.auxKind)
    && typeof row.day === 'string' && DAY_KEY.test(row.day)
    && typeof row.model === 'string' && isRateKey(row.rate) && isTotals(row.totals)
}

/** The stored shape: a rollup written before the auxiliary or provider
 * dimensions existed omits `auxRows` / `byProvider`. Both still read as
 * valid — the writing version could not have recorded those rows, so the
 * empty dimensions lose no usage; the provider-keyed cells inside
 * `rateRows` / `bySession` likewise read as the unattributed group. A
 * missing provider dimension asks for a rebuild (the vendor table would
 * otherwise be empty next to whole totals); `aggregateFormat` sends the
 * whole rollup through that rebuild anyway. */
type StoredRollupFile = Omit<RollupFile, 'auxRows' | 'byProvider'> & {
  auxRows?: UsageAuxRow[]
  byProvider?: UsageProviderRow[]
}

function isRollupFile(value: unknown): value is StoredRollupFile {
  if (typeof value !== 'object' || value === null) return false
  const rollup = value as Record<string, unknown>
  return typeof rollup.upto === 'string' && DAY_KEY.test(rollup.upto)
    && (rollup.pricingFingerprint === undefined || typeof rollup.pricingFingerprint === 'string')
    && (rollup.aggregateFormat === undefined || (typeof rollup.aggregateFormat === 'number' && Number.isInteger(rollup.aggregateFormat)))
    && (rollup.sourceFiles === undefined || (Array.isArray(rollup.sourceFiles)
      && rollup.sourceFiles.every(name => typeof name === 'string' && /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))))
    && isTotals(rollup.total)
    && Array.isArray(rollup.byDay) && rollup.byDay.every(isDayRow)
    && Array.isArray(rollup.byHour) && rollup.byHour.every(isHourRow)
    && Array.isArray(rollup.byModel) && rollup.byModel.every(isModelRow)
    && (rollup.byProvider === undefined || (Array.isArray(rollup.byProvider) && rollup.byProvider.every(isProviderRow)))
    && Array.isArray(rollup.rateRows) && rollup.rateRows.every(isRateRow)
    && (rollup.auxRows === undefined || (Array.isArray(rollup.auxRows) && rollup.auxRows.every(isAuxRow)))
    // A missing legacy dimension requires a rebuild, but usable totals
    // must survive when the raw history needed for that rebuild is lost.
    && (rollup.bySession === undefined || (Array.isArray(rollup.bySession) && rollup.bySession.every(isSessionRow)))
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
  return {
    ...value,
    recent,
    auxRows: value.auxRows ?? [],
    byProvider: value.byProvider ?? [],
    // A missing provider dimension needs the rebuild, like the missing
    // session dimension: the aggregate rebuilds from the day files, so the
    // dimension backfills over the absorbed history. Reading it as an empty
    // dimension instead would serve a vendor table that is empty while the
    // totals stay whole — the two would no longer reconcile.
    ...(value.byProvider === undefined ? { requiresRebuild: true as const } : {}),
    ...(value.bySession === undefined ? { bySession: [], requiresRebuild: true as const } : {}),
  }
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
