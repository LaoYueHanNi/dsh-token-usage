/**
 * One-shot initialization markers: whether the plugin ever completed a
 * history sync (`initializedAt`) and whether a sync has since folded the
 * session metadata (titles, header facts) into `sessions.json`
 * (`metaSyncedAt`). The markers exist only to gate automatic runs; every
 * later sync is the user's decision (the manual command). A missing or
 * malformed marker reads as unmet: the next startup re-runs the gated
 * work, whose dedupe and idempotent upserts make the repetition a no-op.
 * `completedFields` is the field-completion registry's done-set: each id
 * is stamped once every candidate session was readable, or once the
 * completer exhausted its `fieldCompletionAttempts` retry budget for
 * sessions that stay unreadable.
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
  /** Field-completer ids whose candidate sessions were all readable on a
   * finished pass, or whose retry budget for unreadable sessions ran out.
   * Absent means none of them have completed. */
  completedFields?: readonly string[]
  /** Consecutive field-completion passes that ended with unreadable
   * candidate sessions, per completer id. Reset by a clean pass; a
   * completer that reaches {@link FIELD_COMPLETION_MAX_ATTEMPTS} is
   * stamped done instead of retried. Absent when nothing is pending. */
  fieldCompletionAttempts?: Readonly<Record<string, number>>
}

/**
 * Retry budget for one field completer: startup passes that each end with
 * unreadable candidate sessions. The pass after the last retry stamps the
 * completer done — a session log that stayed unreadable for this many
 * startups is treated as permanently gone.
 */
export const FIELD_COMPLETION_MAX_ATTEMPTS = 3

function isSyncState(value: unknown): value is SyncState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return typeof state.initializedAt === 'number' && Number.isFinite(state.initializedAt)
}

/** Completer ids already stamped, ignoring a malformed `completedFields`. */
export function completedFieldIds(state: Pick<SyncState, 'completedFields'> | null): readonly string[] {
  const raw = state?.completedFields
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string' && id !== '')
}

/** The done-set as a writable field, omitted when empty so older markers stay unchanged. */
function completedFieldsOf(state: Pick<SyncState, 'completedFields'> | null): { completedFields: string[] } | Record<string, never> {
  const ids = completedFieldIds(state)
  return ids.length > 0 ? { completedFields: [...ids] } : {}
}

/** Consecutive-failure counters as a plain record, ignoring a malformed map
 * and clamping out-of-range values to a fresh count. */
function fieldAttemptsOf(state: SyncState | null): Record<string, number> {
  const raw = state?.fieldCompletionAttempts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [id, count] of Object.entries(raw)) {
    if (id === '' || typeof count !== 'number' || !Number.isFinite(count) || count < 1) continue
    out[id] = Math.floor(count)
  }
  return out
}

/** The attempt map as a writable field, omitted when empty. */
function fieldAttemptsField(attempts: Record<string, number>): { fieldCompletionAttempts: Record<string, number> } | Record<string, never> {
  const kept: Record<string, number> = {}
  for (const [id, count] of Object.entries(attempts)) {
    if (count > 0) kept[id] = count
  }
  return Object.keys(kept).length > 0 ? { fieldCompletionAttempts: kept } : {}
}

/** Completer ids that still owe a pass. */
export function pendingCompleterIds(state: SyncState | null, ids: readonly string[]): string[] {
  const done = new Set(completedFieldIds(state))
  return ids.filter(id => !done.has(id))
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
    ...completedFieldsOf(existing),
    ...fieldAttemptsField(fieldAttemptsOf(existing)),
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
    ...completedFieldsOf(existing),
    ...fieldAttemptsField(fieldAttemptsOf(existing)),
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
    ...completedFieldsOf(existing),
    ...fieldAttemptsField(fieldAttemptsOf(existing)),
  })
}

/**
 * Fold one field-completion pass into the marker: clean completers are
 * stamped done and their retry counter cleared; completers that still had
 * unreadable candidate sessions advance theirs, and a counter that reaches
 * {@link FIELD_COMPLETION_MAX_ATTEMPTS} stamps the completer done instead —
 * the dead sessions are abandoned, not retried forever. Other markers are
 * preserved. A missing marker is left missing: inventing `initializedAt`
 * would make the first-run sync look finished. The startup pass only calls
 * this after that sync has already stamped the file.
 * @param dir - the data directory holding the marker.
 * @param outcome - what the pass proved, per completer id.
 * @returns the completer ids this call newly stamped done (including
 * retry-budget exhaustions); empty when the marker was missing or nothing
 * settled.
 */
export async function markFieldCompletionOutcome(
  dir: string,
  outcome: { cleanIds: readonly string[]; retriedIds: readonly string[] },
): Promise<readonly string[]> {
  const existing = await readSyncState(dir)
  if (existing === null) return []
  const stamped = new Set(completedFieldIds(existing))
  const attempts = fieldAttemptsOf(existing)
  const newlyStamped: string[] = []
  for (const id of outcome.cleanIds) {
    if (id === '') continue
    if (!stamped.has(id)) newlyStamped.push(id)
    stamped.add(id)
    delete attempts[id]
  }
  for (const id of outcome.retriedIds) {
    if (id === '' || stamped.has(id)) continue
    attempts[id] = (attempts[id] ?? 0) + 1
    if (attempts[id] >= FIELD_COMPLETION_MAX_ATTEMPTS) {
      stamped.add(id)
      newlyStamped.push(id)
      delete attempts[id]
    }
  }
  await writeSyncState(dir, {
    initializedAt: existing.initializedAt,
    ...(existing.metaSyncedAt !== undefined ? { metaSyncedAt: existing.metaSyncedAt } : {}),
    ...(existing.timingSyncedAt !== undefined ? { timingSyncedAt: existing.timingSyncedAt } : {}),
    ...completedFieldsOf({ completedFields: [...stamped] }),
    ...fieldAttemptsField(attempts),
  })
  return newlyStamped
}
