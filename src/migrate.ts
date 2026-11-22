/**
 * Data-directory migration of the token-usage plugin: copies every file from
 * one data directory into another, physically and verbatim — the per-day
 * JSONL shards, the pricing files, the sync marker, the session-metadata
 * index, the provider-name registry and model associations keep their
 * exact names and contents. The
 * derived rollup rebuilds instead of migrating; no row is rewritten here.
 *
 * Two-phase commit, in the shape of a database switch: every file copies
 * first (a failure aborts with the source untouched); the caller then flips
 * its running configuration to the new directory; only after that switch
 * succeeds does the caller run the cleanup, which removes the source files
 * that verifiably landed (same size, or identical bytes for associations)
 * and the emptied directory. At every
 * intermediate point the data exists in both places or only in the source —
 * never only in the target.
 *
 * The caller guarantees a quiesced source (no active sessions, log flushed)
 * before starting, so a file copied once cannot change underneath.
 *
 * @module token-usage/migrate
 */

import { constants } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BACKUPS_DIR, isBackupSnapshotName } from './backup.ts'
import { consoleLogger, type LoggerLike } from './log.ts'
import { ASSOCIATIONS_FILE } from './pricing-associations.ts'

const BACKUP_DAY_FILE = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/u

/** Files that belong to this plugin; anything else in the directory stays. */
const OWNED_PATTERNS = [
  BACKUP_DAY_FILE,
  /^state\.json$/u,
  /^pricing\.json$/u,
  /^pricing\.ccsa\.json$/u,
  /^sessions\.json$/u,
  /^providers\.json$/u,
  /^pricing-associations\.json$/u,
] as const

/**
 * The stats rollup is derived state: it rebuilds from the day files on the
 * next stats read, so it neither migrates nor blocks the source cleanup. A
 * stale one in the target (user-copied, half-written) would serve wrong
 * aggregates until rebuilt, so the migration removes it from the target and
 * lets the rebuild produce a cache consistent with the copied day files.
 */
const ROLLUP_FILE = 'rollup.json'

/** Progress report of one migration phase. */
export interface MigrationProgress {
  /** Files finished so far, across copy and cleanup phases. */
  done: number
  /** Total files this migration will touch. */
  total: number
  /** Human-readable phase label ('copying' | 'cleaning'). */
  phase: 'copying' | 'cleaning'
}
/** What one migration did, for the startup line and the tests. */
export interface MigrationResult {
  /** Files copied into the target directory. */
  copied: number
  /** Files removed from the source after the switch. */
  cleaned: number
}

/** Whether a path exists; a stat failure of any kind reads as absent. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Whether a file name belongs to this plugin's data. */
function isOwned(name: string): boolean {
  return OWNED_PATTERNS.some(pattern => pattern.test(name))
}

/** Only ENOENT means absent: unreadable choices must stop migration. */
async function associationBytes(dir: string): Promise<Buffer | null> {
  return readFile(join(dir, ASSOCIATIONS_FILE)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
}

/** List this plugin's files in a directory (names, not paths). */
async function ownedFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter(isOwned)
}

/** List plugin-owned day files inside `.backups/<snapshot>/` as relative paths. */
async function listBackupFiles(dir: string): Promise<string[]> {
  const backupsRoot = join(dir, BACKUPS_DIR)
  const entries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => [])
  const snapshots = entries
    .filter(entry => entry.isDirectory() && isBackupSnapshotName(entry.name))
    .map(entry => entry.name)
    .sort()
  const files: string[] = []
  for (const snapshot of snapshots) {
    const items = await readdir(join(backupsRoot, snapshot), { withFileTypes: true }).catch(() => [])
    const dayFiles = items
      .filter(item => item.isFile() && BACKUP_DAY_FILE.test(item.name))
      .map(item => item.name)
      .sort()
    for (const file of dayFiles) {
      files.push(join(BACKUPS_DIR, snapshot, file))
    }
  }
  return files
}

/**
 * Whether two directory strings refer to the same physical directory.
 * Protects migration from self-deleting owned files when a path differs only
 * in casing, slash style, trailing separators, or symlinks (e.g. on Windows).
 */
export async function isSameDirectory(left: string, right: string): Promise<boolean> {
  if (left === right) return true
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (samePath(resolvedLeft, resolvedRight)) return true
  const [realLeft, realRight] = await Promise.all([
    realpath(left).catch(() => null),
    realpath(right).catch(() => null),
  ])
  if (realLeft !== null && realRight !== null && samePath(realLeft, realRight)) return true
  const [statLeft, statRight] = await Promise.all([
    stat(left).catch(() => null),
    stat(right).catch(() => null),
  ])
  return statLeft !== null
    && statRight !== null
    && statLeft.dev !== 0
    && statLeft.ino !== 0
    && statLeft.dev === statRight.dev
    && statLeft.ino === statRight.ino
}

/**
 * Phase one: copy every owned file into the target, verbatim. A target file
 * with the same name is NOT overwritten: existing normal files win, while
 * associations must be byte-identical or migration aborts before copying.
 * Any copy failure aborts with the
 * source directory fully intact (the half-copied target is left behind; it
 * is outside every configured directory until the switch names it).
 * @param oldDir - the quiesced source directory.
 * @param newDir - the target directory (created when missing).
 * @param onProgress - per-file progress callback.
 * @returns names (or backup-relative paths) of the files that were copied.
 */
export async function copyData(
  oldDir: string,
  newDir: string,
  onProgress?: (progress: MigrationProgress) => void,
): Promise<string[]> {
  if (await isSameDirectory(oldDir, newDir)) return []
  const [sourceChoices, targetChoices] = await Promise.all([associationBytes(oldDir), associationBytes(newDir)])
  if (sourceChoices !== null && targetChoices !== null && !sourceChoices.equals(targetChoices)) {
    throw new Error('pricing-associations.json migration conflict: source and target differ')
  }
  await mkdir(newDir, { recursive: true })
  // A stale rollup in the target would aggregate the OLD day files until its
  // next lazy rebuild; drop it so the first stats read after the switch
  // rebuilds from the copied day files.
  await unlink(join(newDir, ROLLUP_FILE)).catch(() => undefined)
  const names = await ownedFiles(oldDir)
  const backupRelPaths = await listBackupFiles(oldDir)
  const total = names.length + backupRelPaths.length
  const copied: string[] = []
  for (const name of names) {
    const destination = join(newDir, name)
    if (name === ASSOCIATIONS_FILE) {
      // Never overwrite a target created after preflight, even out of process.
      if (targetChoices === null) await copyFile(join(oldDir, name), destination, constants.COPYFILE_EXCL)
      const landed = await associationBytes(newDir)
      if (sourceChoices === null || landed === null || !landed.equals(sourceChoices)) {
        throw new Error('pricing-associations.json changed during migration')
      }
      copied.push(name)
      onProgress?.({ done: copied.length, total, phase: 'copying' })
      continue
    }
    if (await exists(destination)) {
      copied.push(name)
      onProgress?.({ done: copied.length, total, phase: 'copying' })
      continue
    }
    await copyFile(join(oldDir, name), destination)
    // Verify the landed bytes before counting the file: a copy that lied
    // about succeeding must not enable a later delete.
    const [source, target] = await Promise.all([stat(join(oldDir, name)), stat(destination)])
    if (source.size !== target.size) {
      throw new Error(`size mismatch after copying ${name}: ${String(source.size)} -> ${String(target.size)}`)
    }
    copied.push(name)
    onProgress?.({ done: copied.length, total, phase: 'copying' })
  }
  for (const relPath of backupRelPaths) {
    const destination = join(newDir, relPath)
    if (await exists(destination)) {
      copied.push(relPath)
      onProgress?.({ done: copied.length, total, phase: 'copying' })
      continue
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(oldDir, relPath), destination)
    const [source, target] = await Promise.all([stat(join(oldDir, relPath)), stat(destination)])
    if (source.size !== target.size) {
      throw new Error(`size mismatch after copying ${relPath}: ${String(source.size)} -> ${String(target.size)}`)
    }
    copied.push(relPath)
    onProgress?.({ done: copied.length, total, phase: 'copying' })
  }
  return copied
}

/**
 * Phase three (after the caller's configuration switch): remove the source
 * files that verifiably landed — same name present in the target with the
 * same size (associations require identical bytes) — then the emptied
 * directory. A source file whose copy cannot be
 * proven stays; unknown files keep the directory in place.
 * @param oldDir - the previous data directory.
 * @param newDir - the directory now in force.
 * @param onProgress - per-file progress callback.
 * @returns what the cleanup did.
 */
export async function cleanSource(
  oldDir: string,
  newDir: string,
  onProgress?: (progress: MigrationProgress) => void,
  logger: LoggerLike = consoleLogger,
): Promise<MigrationResult> {
  if (await isSameDirectory(oldDir, newDir)) return { copied: 0, cleaned: 0 }
  const names = await ownedFiles(oldDir)
  const backupRelPaths = await listBackupFiles(oldDir)
  const removable: string[] = []
  for (const name of names) {
    if (name === ASSOCIATIONS_FILE) {
      const [source, target] = await Promise.all([associationBytes(oldDir), associationBytes(newDir)])
      if (source !== null && target !== null && source.equals(target)) removable.push(name)
      continue
    }
    const landed = await access(join(newDir, name)).then(() => true, () => false)
      && await stat(join(oldDir, name)).then(s => s.size, () => -1)
        === await stat(join(newDir, name)).then(s => s.size, () => -2)
    if (landed) removable.push(name)
  }
  const removableBackups: string[] = []
  for (const relPath of backupRelPaths) {
    const landed = await access(join(newDir, relPath)).then(() => true, () => false)
      && await stat(join(oldDir, relPath)).then(s => s.size, () => -1)
        === await stat(join(newDir, relPath)).then(s => s.size, () => -2)
    if (landed) removableBackups.push(relPath)
  }
  const totalRemovable = removable.length + removableBackups.length
  let cleaned = 0
  for (const name of removable) {
    await unlink(join(oldDir, name)).catch((error: unknown) => {
      logger.error(`[token-usage] cannot remove ${name}:`, error)
    })
    cleaned += 1
    onProgress?.({ done: cleaned, total: totalRemovable, phase: 'cleaning' })
  }
  for (const relPath of removableBackups) {
    await unlink(join(oldDir, relPath)).catch((error: unknown) => {
      logger.error(`[token-usage] cannot remove ${relPath}:`, error)
    })
    cleaned += 1
    onProgress?.({ done: cleaned, total: totalRemovable, phase: 'cleaning' })
  }
  // The source rollup is derived state with no target-side counterpart; it
  // leaves with the directory so an emptied source can actually go away.
  await unlink(join(oldDir, ROLLUP_FILE)).catch(() => undefined)
  // A file written temp-then-rename leaves its `.tmp` sibling behind when
  // the process dies between the two, and a marker written concurrently with
  // the move can leave one too. Such a leftover is not data — the file it
  // was written for has landed in the target — but it keeps the source
  // directory non-empty, and an emptied source is what lets the directory
  // itself go away.
  for (const name of removable) {
    await unlink(join(oldDir, `${name}.tmp`)).catch(() => undefined)
  }
  await unlink(join(oldDir, `${ROLLUP_FILE}.tmp`)).catch(() => undefined)
  // Clean emptied plugin backup snapshot folders and `.backups/`, keeping any
  // unknown files or directories the user placed inside intact.
  const backupsRoot = join(oldDir, BACKUPS_DIR)
  const backupEntries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of backupEntries) {
    if (!entry.isDirectory() || !isBackupSnapshotName(entry.name)) continue
    const snapshotDir = join(backupsRoot, entry.name)
    if ((await readdir(snapshotDir).catch(() => null))?.length === 0) {
      await rmdir(snapshotDir).catch(() => undefined)
    }
  }
  if ((await readdir(backupsRoot).catch(() => null))?.length === 0) {
    await rmdir(backupsRoot).catch(() => undefined)
  }
  // The directory itself goes only when nothing owned or unknown remains.
  if ((await readdir(oldDir).catch(() => null))?.length === 0) {
    await rmdir(oldDir).catch(() => undefined)
  }
  return { copied: names.length + backupRelPaths.length, cleaned }
}
