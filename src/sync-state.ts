/**
 * One-shot initialization marker: whether the plugin ever completed a history
 * sync. The marker exists only to gate the FIRST automatic sync; every later
 * sync is the user's decision (the manual command).
 *
 * @module token-usage/sync-state
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleLogger, type LoggerLike } from './log.ts'

const STATE_FILE = 'state.json'
const TMP_FILE = 'state.json.tmp'

/** Contents of the initialized marker. */
export interface SyncState {
  /** Epoch milliseconds when the first automatic sync completed. */
  initializedAt: number
}

function isSyncState(value: unknown): value is SyncState {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).initializedAt === 'number'
    && Number.isFinite((value as Record<string, unknown>).initializedAt)
}

/**
 * Whether the first automatic sync already completed. A missing or malformed
 * marker reads as uninitialized: the next startup re-runs the sync, whose
 * dedupe makes the repetition a no-op.
 * @param dir - the data directory holding the marker.
 */
export async function isInitialized(dir: string, logger: LoggerLike = consoleLogger): Promise<boolean> {
  let text: string
  try {
    text = await readFile(join(dir, STATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    logger.error('[token-usage] cannot read state:', error)
    return false
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Malformed marker: treat as uninitialized (the sync re-runs idempotently).
    return false
  }
  return isSyncState(value)
}

/**
 * Persist the initialized marker atomically (temp file + rename), so a crash
 * mid-write never leaves a torn marker that would misread as initialized.
 * @param dir - the data directory holding the marker.
 * @param now - clock source (test seam).
 */
export async function markInitialized(dir: string, now: () => Date = () => new Date()): Promise<void> {
  const target = join(dir, STATE_FILE)
  const tmp = join(dir, TMP_FILE)
  await writeFile(tmp, JSON.stringify({ initializedAt: now().getTime() }), 'utf8')
  await rename(tmp, target)
}
