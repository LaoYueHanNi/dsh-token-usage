/**
 * History sync: replay every persisted session log and append the request
 * rows the log does not already hold, deduped by request id. The sync runs
 * automatically ONCE, on the first startup after installation (gated by the
 * initialized marker).
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

/**
 * One progress tick of a long sync: the host forwards these to the card so the
 * user can see how far the manual scan has gotten. The first tick is emitted
 * before the first session is read (so the bar shows `0/total` immediately),
 * and one tick follows each completed session. `total` is the session count
 * seen at the start of the run; a session that appears mid-run does not
 * change it.
 */
export interface SyncProgressTick {
  /** Sessions fully processed so far. */
  processed: number
  /** Total sessions this run intends to walk (frozen at the start). */
  total: number
  /** Rows appended to the log so far. */
  added: number
  /** Rows skipped by dedupe so far. */
  skipped: number
}

/** One open read channel onto a stored session's event log (duck-typed for tests). */
export interface SyncReadHandle {
  /** Read a slice of the valid contiguous log; the no-arg call returns it whole. */
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<readonly SessionEvent[]>
  /** Release the handle; idempotent and uncancellable. */
  close(): Promise<void>
}

/** The persistence surface the sync needs (duck-typed for tests). */
export interface SyncPersistence {
  /**
   * Every materialized session, in arbitrary order. dsh 0.1.2-alpha.5 answers
   * snapshots; the session id lives at `header.id`.
   */
  list(options?: { signal?: AbortSignal }): Promise<readonly { header: { id: SessionId } }[]>
  /**
   * Open a read-only channel onto one stored session's log. dsh 0.1.2-alpha.5
   * removed the service-level `inspect`; this is its handle-shaped successor.
   */
  open(id: SessionId, access: 'read', options?: { signal?: AbortSignal }): Promise<SyncReadHandle>
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
 * @param onTick - optional progress callback; fires once before the first
 * session (with `processed: 0` and the final `total`), then once per session
 * as it finishes. The card passes this to drive its progress bar; the
 * one-shot startup sync omits it.
 * @param signal - cancellation; an aborted run throws `AbortError`.
 */
export async function syncHistory(
  deps: SyncDeps,
  onTick?: (tick: SyncProgressTick) => void,
  signal?: AbortSignal,
): Promise<SyncResult> {
  await deps.log.scan()
  const sessions = await deps.persistence.list(signal === undefined ? undefined : { signal })
  let added = 0
  let skipped = 0
  const total = sessions.length
  let processed = 0
  onTick?.({ processed, total, added, skipped })
  for (const session of sessions) {
    signal?.throwIfAborted()
    const options = signal === undefined ? undefined : { signal }
    const handle = await deps.persistence.open(session.header.id, 'read', options)
    let events: readonly SessionEvent[]
    try {
      events = await handle.read(0, undefined, options)
    } catch (error) {
      // The read failure is the actionable cause; a close failure on the same
      // broken handle adds nothing.
      try { await handle.close() } catch { /* see above */ }
      throw error
    }
    await handle.close()
    for (const event of events) {
      signal?.throwIfAborted()
      if (event.type !== 'assistant/message') continue
      const record = recordFromEvent(event, session.header.id)
      if (await deps.log.record(record)) added += 1
      else skipped += 1
    }
    processed += 1
    onTick?.({ processed, total, added, skipped })
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
