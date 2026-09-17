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
 * Reads go through whichever persistence seam the running host exposes: the
 * handle generation (`dsh` 0.1.3-alpha.1 and later, `open`/`read`/`close`) or
 * the older inspect generation (`dsh` 0.1.2-rc.1 and earlier, `inspect`). One
 * probe per run picks the seam, so a single build walks history on both.
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
import { extractFirstTokenTimeFromStream, isTokenDelta, modelOfEvent, recordOfEvent, type RequestTiming } from './usage-record.ts'
import type { UsageLog } from './usage-log.ts'

/** Outcome of one sync run. */
export interface SyncResult {
  /** Rows appended to the log. */
  added: number
  /** Requests already present in the log (deduped). */
  skipped: number
  /** Rows removed because no readable session log reproduced them: relics of
   * an older stored format, whose event coordinates the host rewrote when it
   * migrated the log to the current format generation. */
  removed: number
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
  /** Rows removed by the closing reconcile pass so far. Stays zero until the
   * walk finishes: the pass needs every readable session to have spoken. */
  removed: number
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

/** One stored session as either persistence generation lists it: the handle
 * generation reports `snapshot.header.id`, the older one a bare `header`. */
export type SyncSessionEntry =
  | { readonly id: SessionId }
  | { readonly header: { readonly id: SessionId } }

/** One open read handle of the handle-based generation (`dsh` 0.1.3-alpha.1
 * and later). The host's real handle also carries `append`/`flush` and an
 * `eventState` beside `read`'s events; the sync needs only this much. */
export interface SyncSessionHandle {
  /** The immutable stored header, fixed when the handle was opened. */
  readonly header?: SessionHeaderFacts | undefined
  /** The log slice; with no arguments, the whole log from seq 0. */
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  /** Release the handle — idempotent. On a read handle this frees local
   * resources only: a read handle never takes write ownership, so it runs
   * beside the host's writer (and beside another process's). */
  close(): Promise<void>
}

/**
 * The persistence surface the sync needs (duck-typed for tests). The host
 * ships two generations of this seam and {@link readerOf} probes which one is
 * live, so one build serves both:
 *
 * - **handle seam** (`dsh` 0.1.3-alpha.1 and later): `list({ signal })` reports
 *   ids under `header.id`, and `open(id, 'read')` yields a handle whose
 *   `read()` returns the log while `header` carries the identity facts.
 * - **inspect seam** (`dsh` 0.1.2-rc.1 and earlier): `list(signal)` reports
 *   bare headers and `inspect(id, signal)` returns log and header at once.
 *
 * Exactly one of `open`/`inspect` exists per host, hence both are optional; a
 * persistence carrying neither is rejected up front (see {@link readerOf})
 * instead of being reported as one unreadable session after another.
 */
export interface SyncPersistence {
  /** Every materialized session, in arbitrary order. The handle generation
   * takes an options object here, the older one the signal positionally. */
  list(options?: { signal?: AbortSignal } | AbortSignal): Promise<readonly SyncSessionEntry[]>
  /** Handle generation: one read handle onto a stored session. */
  open?(id: SessionId, access: 'read', options?: { signal?: AbortSignal }): Promise<SyncSessionHandle>
  /** Inspect generation: the immutable logical event log of one session,
   * with the header the identity facts are projected from. */
  inspect?(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[]; meta?: SessionHeaderFacts }>
}

/**
 * The ledger surface the sync needs (duck-typed for tests): the host passes
 * the {@link UsageLog}, tests pass an in-memory twin.
 */
export type SyncLog = Pick<UsageLog, 'scan' | 'ids' | 'record' | 'reconcile'>

/** Dependencies of one sync run. */
export interface SyncDeps {
  persistence: SyncPersistence
  log: SyncLog
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
  /** Whether the closing reconcile pass runs (default true). The boot path
   * passes false: a first-run install has no stale rows to drop, and the
   * pass would delay the marker write that a concurrent data-directory
   * migration waits behind. */
  reconcile?: boolean
}

/** One generation-normalized read surface: {@link syncHistory} walks sessions
 * through this and never sees the seam split again. */
export interface SessionReader {
  /** Every materialized session id, in arbitrary order. */
  list(signal?: AbortSignal): Promise<readonly SessionId[]>
  /** Immutable logical event log of one session, with its header facts. */
  read(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[]; meta?: SessionHeaderFacts | undefined }>
}

/**
 * Probe which persistence seam the running host exposes and normalize it.
 *
 * The probe runs once per sync, never once per session: a host does not change
 * generation mid-process, and probing per session would report a wholesale
 * mismatch as N individually unreadable sessions — precisely the silent
 * failure the two seams invite.
 * @param persistence - the host's `ctx.sessionPersistence` (or a test twin).
 * @returns the normalized reader.
 * @throws {Error} when the persistence exposes neither seam (a host older or
 * newer than either generation), which must fail loudly rather than report
 * every session as unreadable.
 */
export function readerOf(persistence: SyncPersistence): SessionReader {
  const { open, inspect } = persistence
  const idOf = (entry: SyncSessionEntry): SessionId => 'header' in entry ? entry.header.id : entry.id
  if (typeof open === 'function') {
    return {
      async list(signal) {
        return (await persistence.list(signal === undefined ? {} : { signal })).map(idOf)
      },
      async read(id, signal) {
        const handle = await open.call(persistence, id, 'read', signal === undefined ? {} : { signal })
        try {
          const { events } = await handle.read()
          return { events, meta: handle.header }
        } finally {
          // Best-effort teardown: the rows are already collected, so a failing
          // close must not turn a good read into an unreadable session. It
          // still has to run on every path — the host counts a leaked read
          // handle as a resource leak.
          await handle.close().catch(() => {})
        }
      },
    }
  }
  if (typeof inspect === 'function') {
    return {
      async list(signal) {
        return (await persistence.list(signal)).map(idOf)
      },
      async read(id, signal) {
        return await inspect.call(persistence, id, signal)
      },
    }
  }
  throw new Error('token-usage: sessionPersistence exposes neither open() (dsh 0.1.3-alpha.1+) nor inspect() (dsh <= 0.1.2-rc.1)')
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
  // Snapshot before the walk: only rows already saved are reconcile
  // candidates, so a request landing live mid-walk is never deleted.
  const eligible = deps.log.ids()
  const reader = readerOf(deps.persistence)
  const sessions = await reader.list(signal)
  let added = 0
  let skipped = 0
  let removed = 0
  let failedSessions = 0
  const total = sessions.length
  let processed = 0
  /** Every id this walk reproduces; the reconcile pass keeps exactly these. */
  const reproduced = new Set<string>()
  /** Sessions this walk read in full. Only their rows may be reconciled: a
   * row whose session is missing from the list (deleted, or hidden behind a
   * header this build cannot read) is never dropped for its absence. */
  const readable = new Set<SessionId>()
  onTick?.({ processed, total, added, skipped, removed, failedSessions })
  for (const id of sessions) {
    signal?.throwIfAborted()
    // One unreadable session log (a format the current dsh build rejects,
    // a torn file, …) must not abort the whole walk: skip the session,
    // report it, and let the rest of the history land.
    let inspection: { events: readonly SessionEvent[]; meta?: SessionHeaderFacts | undefined }
    try {
      inspection = await reader.read(id, signal)
    } catch (error) {
      // A cancellation is the caller's (or the host read path's) abort —
      // always fatal to the run, never a session to skip.
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      failedSessions += 1
      processed += 1
      deps.onSessionFailure?.(id, error)
      onTick?.({ processed, total, added, skipped, removed, failedSessions })
      continue
    }
    // The session was read in full: this walk is now the authority for what
    // the ledger must hold, so its stale coordinates become droppable.
    readable.add(id)
    // Last-known route model of this session: failure rows need a model to
    // attribute, and turn/end names none, so the walk follows the same
    // request/context + assistant/message events the live recorder does.
    let model = ''
    // Latest-wins title: title events append in seq order, so the LAST one
    // seen is the current title — a rename, an auto-generated title, and a
    // fallback all land as the same append, one fold covers every source.
    let title: string | undefined
    let openStep: { turn: number; step: number; startTime: number; firstTokenTime?: number } | null = null
    for (const event of inspection.events) {
      signal?.throwIfAborted()
      if (event.type === 'step/start') {
        openStep = {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
        }
      } else if (event.type === 'assistant/chunk') {
        if (openStep !== null
          && openStep.turn === event.data.turn
          && openStep.step === event.data.step
          && openStep.firstTokenTime === undefined
          && isTokenDelta(event.data.chunk)) {
          openStep.firstTokenTime = event.time
        }
      }
      const revealed = modelOfEvent(event)
      if (revealed !== undefined) model = revealed
      const revealedTitle = titleOfEvent(event)
      if (revealedTitle !== undefined) title = revealedTitle
      let timing: RequestTiming | undefined
      if (event.type === 'assistant/message'
        && openStep !== null
        && openStep.turn === event.data.turn
        && openStep.step === event.data.step) {
        const latencyMs = Math.max(0, event.time - openStep.startTime)
        let firstTokenTime = openStep.firstTokenTime
        if (firstTokenTime === undefined && 'stream' in event.data && event.data.stream) {
          firstTokenTime = extractFirstTokenTimeFromStream(event.data.stream)
        }
        const firstTokenLatencyMs = firstTokenTime !== undefined
          ? Math.max(0, firstTokenTime - openStep.startTime)
          : undefined
        timing = {
          latencyMs,
          ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
        }
        openStep = null
      } else if (event.type === 'step/end' || event.type === 'turn/end') {
        openStep = null
      }
      const record = recordOfEvent(event, id, model, deps.recordCompaction !== false, timing)
      if (record === null) continue
      // Keep the id whether the row was already saved or lands now: the
      // reconcile pass keeps exactly the ids this walk produced.
      reproduced.add(record.requestId)
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
      if (Object.keys(patch).length > 0) await deps.meta.upsert(id, patch)
    }
    processed += 1
    onTick?.({ processed, total, added, skipped, removed, failedSessions })
  }
  // Reconcile last, once every readable session has spoken for its rows: a
  // saved row no readable session reproduces is a relic of an older stored
  // format. A session that merely failed to load protects its own rows.
  if (deps.reconcile !== false) {
    removed = await deps.log.reconcile(reproduced, readable, eligible)
  }
  return { added, skipped, removed, failedSessions }
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
  const result = await syncHistory({ ...deps, reconcile: false })
  if (state === null) await markInitialized(dir, undefined, true, true)
  else await markMetaSynced(dir)
  return result
}
