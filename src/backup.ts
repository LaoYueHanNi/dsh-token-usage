/**
 * Automatic rolling backups before rewriting existing usage day files.
 *
 * Every batch maintenance pass that removes, refiles, or mutates rows in
 * existing `usage-YYYY-MM-DD.jsonl` files copies the touched source files into
 * `<dataDir>/.backups/<timestamp>-<reason>/` before touching the originals.
 * Zero-change runs create no directory, a failed copy aborts the rewrite, and
 * older snapshots beyond the newest five are pruned automatically.
 *
 * @module token-usage/backup
 */

import { access, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleLogger, type LoggerLike } from './log.ts'

/** Subdirectory under `<dataDir>` holding pre-rewrite snapshots. */
export const BACKUPS_DIR = '.backups'

/** Maximum number of rolling backup snapshots retained per data directory. */
export const MAX_BACKUP_COUNT = 5

/** Maintenance operations that back up touched day files before rewriting. */
export type BackupReason = 'reconcile' | 'refile' | 'backfill-timing' | 'complete-fields'

/** Exact snapshot directory name grammar (`YYYYMMDD-HHmmss-SSS-NN-<reason>`). */
export const BACKUP_SNAPSHOT_DIR = /^\d{8}-\d{6}-\d{3}-\d{2}-(?:reconcile|refile|backfill-timing|complete-fields)$/u

/** Whether a directory entry name matches a plugin-created backup snapshot. */
export function isBackupSnapshotName(name: string): boolean {
  return BACKUP_SNAPSHOT_DIR.test(name)
}

let lastTimestampMs = -1
let sameMsCounter = 0

/**
 * Format a Windows-safe, lexicographically monotonic snapshot directory name
 * (`YYYYMMDD-HHmmss-SSS-NN-<reason>`). Rapid calls within the same millisecond
 * increment the two-digit tiebreaker (and step the synthetic clock if > 99) so
 * snapshot names never collide and always sort oldest-to-newest.
 */
function nextSnapshotName(reason: BackupReason): string {
  const now = Date.now()
  let effectiveMs: number
  if (now > lastTimestampMs) {
    effectiveMs = now
    sameMsCounter = 0
  } else if (sameMsCounter < 99) {
    effectiveMs = lastTimestampMs
    sameMsCounter += 1
  } else {
    effectiveMs = lastTimestampMs + 1
    sameMsCounter = 0
  }
  lastTimestampMs = effectiveMs

  const date = new Date(effectiveMs)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  const millis = String(date.getMilliseconds()).padStart(3, '0')
  const seq = String(sameMsCounter).padStart(2, '0')
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}-${seq}-${reason}`
}

/**
 * Back up every existing day file in `fileNames` before an in-place rewrite.
 * @param dir - data directory containing the day files.
 * @param fileNames - day-file names that the caller is about to modify.
 * @param reason - maintenance pass label stored in the snapshot directory name.
 * @param logger - diagnostic sink for non-fatal pruning warnings.
 * @returns the created snapshot directory path, or `null` when no listed file exists.
 */
export async function backupDayFiles(
  dir: string,
  fileNames: readonly string[],
  reason: BackupReason,
  logger: LoggerLike = consoleLogger,
): Promise<string | null> {
  const unique = [...new Set(fileNames)]
  const existing: string[] = []
  for (const name of unique) {
    try {
      await access(join(dir, name))
      existing.push(name)
    } catch {
      // Newly created target files have no prior version to back up.
    }
  }
  if (existing.length === 0) return null

  const backupsRoot = join(dir, BACKUPS_DIR)
  const snapshotDir = join(backupsRoot, nextSnapshotName(reason))
  await mkdir(snapshotDir, { recursive: true })
  try {
    for (const name of existing) {
      await copyFile(join(dir, name), join(snapshotDir, name))
    }
  } catch (error: unknown) {
    // Clean up any partial snapshot so callers aborting the rewrite leave no
    // half-populated backup behind.
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  try {
    const entries = await readdir(backupsRoot, { withFileTypes: true })
    const snapshots = entries
      .filter(entry => entry.isDirectory() && isBackupSnapshotName(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    const excess = snapshots.length - MAX_BACKUP_COUNT
    if (excess > 0) {
      for (const obsolete of snapshots.slice(0, excess)) {
        await rm(join(backupsRoot, obsolete), { recursive: true, force: true })
      }
    }
  } catch (error: unknown) {
    logger.warn('[token-usage] failed to prune old backups:', error)
  }

  return snapshotDir
}
