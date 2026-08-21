/**
 * Data-directory migration of the token-usage plugin: copies every file from
 * one data directory into another, physically and verbatim — the per-day
 * JSONL shards, the pricing files, the sync marker, and the stats rollup all
 * keep their exact names and contents; no row is re-bucketed or rewritten.
 *
 * Two-phase commit, in the shape of a database switch: every file copies
 * first (a failure aborts with the source untouched); the caller then flips
 * its running configuration to the new directory; only after that switch
 * succeeds does the caller run the cleanup, which removes the source files
 * that verifiably landed (same size) and the emptied directory. At every
 * intermediate point the data exists in both places or only in the source —
 * never only in the target.
 *
 * The caller guarantees a quiesced source (no active sessions, log flushed)
 * before starting, so a file copied once cannot change underneath.
 *
 * @module token-usage/migrate
 */

import { access, copyFile, mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Files that belong to this plugin; anything else in the directory stays. */
const OWNED_PATTERNS = [
  /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/u,
  /^state\.json$/u,
  /^pricing\.json$/u,
  /^pricing\.ccsa\.json$/u,
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

/** List this plugin's files in a directory (names, not paths). */
async function ownedFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter(isOwned)
}

/**
 * Phase one: copy every owned file into the target, verbatim. A target file
 * with the same name is NOT overwritten — the caller switched writes to the
 * target first, so a same-named file there is either newer live data or a
 * user placement, and either way it wins. Any copy failure aborts with the
 * source directory fully intact (the half-copied target is left behind; it
 * is outside every configured directory until the switch names it).
 * @param oldDir - the quiesced source directory.
 * @param newDir - the target directory (created when missing).
 * @param onProgress - per-file progress callback.
 * @returns names of the files that were copied.
 */
export async function copyData(
  oldDir: string,
  newDir: string,
  onProgress?: (progress: MigrationProgress) => void,
): Promise<string[]> {
  await mkdir(newDir, { recursive: true })
  // A stale rollup in the target would aggregate the OLD day files until its
  // next lazy rebuild; drop it so the first stats read after the switch
  // rebuilds from the copied day files.
  await unlink(join(newDir, ROLLUP_FILE)).catch(() => undefined)
  const names = await ownedFiles(oldDir)
  const copied: string[] = []
  for (const name of names) {
    const destination = join(newDir, name)
    if (await exists(destination)) {
      copied.push(name)
      onProgress?.({ done: copied.length, total: names.length, phase: 'copying' })
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
    onProgress?.({ done: copied.length, total: names.length, phase: 'copying' })
  }
  return copied
}

/**
 * Phase three (after the caller's configuration switch): remove the source
 * files that verifiably landed — same name present in the target with the
 * same size — then the emptied directory. A source file whose copy cannot be
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
): Promise<MigrationResult> {
  const names = await ownedFiles(oldDir)
  const removable: string[] = []
  for (const name of names) {
    const landed = await access(join(newDir, name)).then(() => true, () => false)
      && await stat(join(oldDir, name)).then(s => s.size, () => -1)
        === await stat(join(newDir, name)).then(s => s.size, () => -2)
    if (landed) removable.push(name)
  }
  let cleaned = 0
  for (const name of removable) {
    await unlink(join(oldDir, name)).catch((error: unknown) => {
      console.error(`[token-usage] cannot remove ${name}:`, error)
    })
    cleaned += 1
    onProgress?.({ done: cleaned, total: removable.length, phase: 'cleaning' })
  }
  // The source rollup is derived state with no target-side counterpart; it
  // leaves with the directory so an emptied source can actually go away.
  await unlink(join(oldDir, ROLLUP_FILE)).catch(() => undefined)
  // The directory itself goes only when nothing owned or unknown remains.
  if ((await readdir(oldDir).catch(() => null))?.length === 0) {
    await rmdir(oldDir).catch(() => undefined)
  }
  return { copied: names.length, cleaned }
}
