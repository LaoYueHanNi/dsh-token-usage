/**
 * One-shot initialization markers: whether the plugin ever completed a
 * history sync (`initializedAt`) and whether a sync has since folded the
 * session metadata (titles, header facts) into `sessions.json`
 * (`metaSyncedAt`). The markers exist only to gate automatic runs; every
 * later sync is the user's decision (the manual command). A missing or
 * malformed marker reads as unmet: the next startup re-runs the gated
 * work, whose dedupe and idempotent upserts make the repetition a no-op.
 *
 * @module token-usage/sync-state
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleLogger, type LoggerLike } from './log.ts'

const STATE_FILE = 'state.json'
const TMP_FILE = 'state.json.tmp'

/** Contents of the marker file. `metaSyncedAt` is optional: installs that
 * predate the session table never wrote it, and its absence is exactly the
 * "one metadata backfill still owed" condition. `timingSyncedAt` is optional:
 * installs that predate request timing backfill never wrote it. */
export interface SyncState {
  /** Epoch milliseconds when the first automatic sync completed. */
  initializedAt: number
  /** Epoch milliseconds when a sync last folded session metadata into
   * `sessions.json`; absent on pre-session-table installs. */
  metaSyncedAt?: number
  /** Epoch milliseconds when timing figures (latencyMs, firstTokenLatencyMs)
   * were backfilled into day files; absent on pre-timing installs. */
  timingSyncedAt?: number
}

function isSyncState(value: unknown): value is SyncState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return typeof state.initializedAt === 'number' && Number.isFinite(state.initializedAt)
}

/**
 * Read the marker file. A missing or malformed file reads as null — the
 * caller treats that as unmet and re-runs the gated work idempotently.
 * @param dir - the data directory holding the marker.
 */
export async function readSyncState(dir: string, logger: LoggerLike = consoleLogger): Promise<SyncState | null> {
  let text: string
  try {
    text = await readFile(join(dir, STATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    logger.error('[token-usage] cannot read state:', error)
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Malformed marker: treat as uninitialized (the sync re-runs idempotently).
    return null
  }
  return isSyncState(value) ? value : null
}

/**
 * Whether the first automatic sync already completed. A missing or
 * malformed marker reads as uninitialized: the next startup re-runs the
 * sync, whose dedupe makes the repetition a no-op.
 * @param dir - the data directory holding the marker.
 */
export async function isInitialized(dir: string, logger: LoggerLike = consoleLogger): Promise<boolean> {
  return (await readSyncState(dir, logger)) !== null
}

/**
 * Persist the marker file atomically (temp file + rename), so a crash
 * mid-write never leaves a torn marker that would misread as settled.
 * Fields absent from `state` are omitted, never null.
 * @param dir - the data directory holding the marker.
 * @param state - the marker contents to write.
 */
export async function writeSyncState(dir: string, state: SyncState): Promise<void> {
  const target = join(dir, STATE_FILE)
  const tmp = join(dir, TMP_FILE)
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, target)
}

/**
 * Persist the initialized marker (and, when the caller says the same run
 * folded the metadata or timing, their markers alongside it). An existing
 * `metaSyncedAt` or `timingSyncedAt` survives: the first-sync write must not
 * revoke a backfill an earlier upgrade already completed.
 * @param dir - the data directory holding the marker.
 * @param now - clock source (test seam).
 * @param withMeta - whether this run also folded session metadata.
 * @param withTiming - whether this run also wrote timing figures.
 */
export async function markInitialized(
  dir: string,
  now: () => Date = () => new Date(),
  withMeta = false,
  withTiming = false,
): Promise<void> {
  const existing = await readSyncState(dir)
  await writeSyncState(dir, {
    initializedAt: now().getTime(),
    ...(existing?.metaSyncedAt !== undefined
      ? { metaSyncedAt: existing.metaSyncedAt }
      : withMeta ? { metaSyncedAt: now().getTime() } : {}),
    ...(existing?.timingSyncedAt !== undefined
      ? { timingSyncedAt: existing.timingSyncedAt }
      : withTiming ? { timingSyncedAt: now().getTime() } : {}),
  })
}

/**
 * Stamp the metadata backfill as done, preserving `initializedAt` and `timingSyncedAt`.
 * @param dir - the data directory holding the marker.
 * @param now - clock source (test seam).
 */
export async function markMetaSynced(dir: string, now: () => Date = () => new Date()): Promise<void> {
  const existing = await readSyncState(dir)
  const initializedAt = existing?.initializedAt ?? now().getTime()
  await writeSyncState(dir, {
    initializedAt,
    metaSyncedAt: now().getTime(),
    ...(existing?.timingSyncedAt !== undefined ? { timingSyncedAt: existing.timingSyncedAt } : {}),
  })
}

/**
 * Stamp the timing backfill as done, preserving `initializedAt` and `metaSyncedAt`.
 * @param dir - the data directory holding the marker.
 * @param now - clock source (test seam).
 */
export async function markTimingSynced(dir: string, now: () => Date = () => new Date()): Promise<void> {
  const existing = await readSyncState(dir)
  const initializedAt = existing?.initializedAt ?? now().getTime()
  await writeSyncState(dir, {
    initializedAt,
    ...(existing?.metaSyncedAt !== undefined ? { metaSyncedAt: existing.metaSyncedAt } : {}),
    timingSyncedAt: now().getTime(),
  })
}
