/**
 * History sync: replay every persisted session log and append the request
 * rows the log does not already hold, deduped by request id. The sync runs
 * automatically ONCE (first startup, gated by the initialized marker) and
 * afterwards only through the manual command.
 *
 * @module token-usage/sync
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { isInitialized, markInitialized } from './sync-state.ts'
import { recordFromEvent } from './usage-record.ts'
import type { UsageLog } from './usage-log.ts'

/** Outcome of one sync run. */
export interface SyncResult {
  /** Rows appended to the log. */
  added: number
  /** Requests already present in the log (deduped). */
  skipped: number
}

/** The persistence surface the sync needs (duck-typed for tests). */
export interface SyncPersistence {
  /** Every materialized session, in arbitrary order. */
  list(signal?: AbortSignal): Promise<{ id: SessionId }[]>
  /** Immutable logical event log of one session. */
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
}

/** Dependencies of one sync run. */
export interface SyncDeps {
  persistence: SyncPersistence
  log: UsageLog
}

/**
 * Append every missing request row. The log's dedupe set is rebuilt from the
 * data files first, so a second run is a no-op and rows recorded live in a
 * previous process are not duplicated.
 * @param deps - persistence and the shared log.
 * @param signal - cancellation; an aborted run throws `AbortError`.
 */
export async function syncHistory(deps: SyncDeps, signal?: AbortSignal): Promise<SyncResult> {
  await deps.log.scan()
  const sessions = await deps.persistence.list(signal)
  let added = 0
  let skipped = 0
  for (const session of sessions) {
    signal?.throwIfAborted()
    const inspection = await deps.persistence.inspect(session.id, signal)
    for (const event of inspection.events) {
      signal?.throwIfAborted()
      if (event.type !== 'assistant/message') continue
      const record = recordFromEvent(event, session.id)
      if (await deps.log.record(record)) added += 1
      else skipped += 1
    }
  }
  return { added, skipped }
}

/**
 * Run the one-shot automatic sync when the initialized marker is absent, then
 * persist the marker. A crash between the sync and the marker write leaves
 * the marker absent, so the next startup re-runs the sync — a no-op thanks to
 * dedupe.
 * @param deps - persistence and the shared log.
 * @param dir - the data directory holding the marker.
 * @returns the sync outcome, or null when the marker was already present.
 */
export async function autoSyncIfNeeded(deps: SyncDeps, dir: string): Promise<SyncResult | null> {
  if (await isInitialized(dir)) return null
  const result = await syncHistory(deps)
  await markInitialized(dir)
  return result
}
