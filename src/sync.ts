/**
 * History sync: replay every persisted session log and append the request
 * rows the log does not already hold, deduped by request id. Rows come from
 * `assistant/message` events (plain requests), `compaction/summary` events
 * (the summarize provider calls, unless disabled), `turn/end` events
 * whose reason is an LLM error (terminal failed requests), and `llm/retry`
 * events (failed attempts that the retry plugin then scheduled another try
 * for). The sync runs automatically ONCE, on the first startup after
 * installation (gated by the initialized marker). A session whose stored
 * log fails to load or validate is skipped and counted, never fatal to
 * the run — one unreadable file must not keep the rest of the history
 * out of the ledger.
 *
 * @module token-usage/sync
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: ensures the merged `compaction/*` payload types are in this
// program independent of the usage-record import chain.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: pulls the merged `llm/retry` payload into this program.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { markInitialized, markMetaSynced, readSyncState } from './sync-state.ts'
import { modelOfEvent, recordOfEvent } from './usage-record.ts'
import type { UsageLog } from './usage-log.ts'

/** Outcome of one sync run. */
export interface SyncResult {
  /** Rows appended to the log. */
  added: number
  /** Requests already present in the log (deduped). */
  skipped: number
  /** Sessions whose stored log failed to load or validate. Their rows are
   * absent from this run; every such session is reported through
   * {@link SyncDeps.onSessionFailure} and counted here. */
  failedSessions: number
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
  /** Sessions skipped so far because their stored log failed to load or
   * validate; they count as processed for the progress bar. */
  failedSessions: number
}

/**
 * The header facts the metadata index captures (the duck-typed projection
 * of the host's `SessionHeader`): the working directory, the subagent
 * classification, and the parent lineage. All three are immutable per
 * session, so one upsert per session per run suffices.
 */
export interface SessionHeaderFacts {
  cwd?: string
  origin?: 'subagent'
  parentSession?: string
}

/** The metadata sink the sync folds identity facts into (duck-typed for
 * tests; the host passes a {@link SessionMetaStore}). */
export interface SyncMetaSink {
  upsert(id: string, patch: SessionHeaderFacts & { title?: string }): Promise<void>
}

/** The persistence surface the sync needs (duck-typed for tests). The
 * host's `inspect` returns a `SessionInspection` — `meta` (the immutable
 * session header) rides alongside `events`; older duck types that omit it
 * simply contribute no header facts. */
export interface SyncPersistence {
  /** Every materialized session, in arbitrary order. */
  list(signal?: AbortSignal): Promise<{ id: SessionId }[]>
  /** Immutable logical event log of one session, with its header. */
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[]; meta?: {
    cwd?: string
    origin?: 'subagent'
    parentSession?: SessionId
  } }>
}

/** Dependencies of one sync run. */
export interface SyncDeps {
  persistence: SyncPersistence
  log: UsageLog
  /** Whether the sync records `compaction/summary` events (default true,
   * mirroring the `recordCompaction` config). */
  recordCompaction?: boolean
  /** Metadata sink for the session table's identity fields: the walk folds
   * each session's latest-wins `session/title` text and its immutable
   * header facts (cwd, lineage) into it. Absent → no metadata capture
   * (the usage walk still runs). */
  meta?: SyncMetaSink
  /** Called once per session whose stored log failed to load or validate
   * (the session is then skipped). The host uses this to log which session
   * and why; aborts raised through `signal` are re-thrown, never reported. */
  onSessionFailure?: (id: SessionId, error: unknown) => void
}

/**
 * The latest-wins `session/title` text of one event, or undefined: the
 * event type is host-merged (`dsh-session-title`), so the plugin reads the
 * payload duck-typed and tolerantly — a non-string or empty title is
 * skipped, never fabricated. Exported for the live recorder, which folds
 * the same event into the same index.
 */
export function titleOfEvent(event: SessionEvent): string | undefined {
  if ((event as { type: string }).type !== 'session/title') return undefined
  const title = (event as { data?: { title?: unknown } }).data?.title
  return typeof title === 'string' && title !== '' ? title : undefined
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
  const sessions = await deps.persistence.list(signal)
  let added = 0
  let skipped = 0
  let failedSessions = 0
  const total = sessions.length
  let processed = 0
  onTick?.({ processed, total, added, skipped, failedSessions })
  for (const session of sessions) {
    signal?.throwIfAborted()
    // One unreadable session log (a format the current dsh build rejects,
    // a torn file, …) must not abort the whole walk: skip the session,
    // report it, and let the rest of the history land.
    let inspection: { events: readonly SessionEvent[]; meta?: {
      cwd?: string
      origin?: 'subagent'
      parentSession?: SessionId
    } }
    try {
      inspection = await deps.persistence.inspect(session.id, signal)
    } catch (error) {
      // A cancellation is the caller's (or the host read path's) abort —
      // always fatal to the run, never a session to skip.
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      failedSessions += 1
      processed += 1
      deps.onSessionFailure?.(session.id, error)
      onTick?.({ processed, total, added, skipped, failedSessions })
      continue
    }
    // Last-known route model of this session: failure rows need a model to
    // attribute, and turn/end names none, so the walk follows the same
    // request/context + assistant/message events the live recorder does.
    let model = ''
    // Latest-wins title: title events append in seq order, so the LAST one
    // seen is the current title — a rename, an auto-generated title, and a
    // fallback all land as the same append, one fold covers every source.
    let title: string | undefined
    for (const event of inspection.events) {
      signal?.throwIfAborted()
      const revealed = modelOfEvent(event)
      if (revealed !== undefined) model = revealed
      const revealedTitle = titleOfEvent(event)
      if (revealedTitle !== undefined) title = revealedTitle
      const record = recordOfEvent(event, session.id, model, deps.recordCompaction !== false)
      if (record === null) continue
      if (await deps.log.record(record)) added += 1
      else skipped += 1
    }
    // One metadata upsert per session: the title fold above plus the
    // immutable header facts. The upsert is a no-op when nothing changed,
    // so repeat syncs never rewrite the index.
    if (deps.meta !== undefined) {
      const header = inspection.meta
      const patch = {
        ...(title !== undefined ? { title } : {}),
        ...(header?.cwd !== undefined && header.cwd !== '' ? { cwd: header.cwd } : {}),
        ...(header?.origin !== undefined ? { origin: header.origin } : {}),
        ...(header?.parentSession !== undefined && header.parentSession !== '' ? { parentSession: header.parentSession } : {}),
      }
      if (Object.keys(patch).length > 0) await deps.meta.upsert(session.id, patch)
    }
    processed += 1
    onTick?.({ processed, total, added, skipped, failedSessions })
  }
  return { added, skipped, failedSessions }
}

/**
 * Run the gated automatic work, then persist the markers:
 * - No `initializedAt` — the first-run backfill: one full sync (which also
 *   folds the metadata), then both markers land together.
 * - `initializedAt` present, `metaSyncedAt` absent — a pre-session-table
 *   install owes exactly one metadata backfill: run the same sync once
 *   more (every usage row dedupes to a no-op write; the walk lands the
 *   titles and header facts the old build never stored), then stamp
 *   `metaSyncedAt`.
 * - Both markers present — nothing to do.
 * A crash before the marker write leaves the marker absent, so the next
 * startup re-runs — a no-op thanks to dedupe and idempotent upserts.
 * @param deps - persistence and the shared log (with the metadata sink).
 * @param dir - the data directory holding the markers.
 * @returns the sync outcome, or null when both markers were already set.
 */
export async function autoSyncIfNeeded(deps: SyncDeps, dir: string): Promise<SyncResult | null> {
  const state = await readSyncState(dir)
  if (state !== null && state.metaSyncedAt !== undefined) return null
  const result = await syncHistory(deps)
  if (state === null) await markInitialized(dir, undefined, true)
  else await markMetaSynced(dir)
  return result
}
