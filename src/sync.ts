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
 * Reads go through the handle persistence seam the running host exposes:
 * `list({ signal })` then `open(id, 'read')` / `read()` / `close()` per
 * session.
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
import { CompactionAttributionWindow } from './compaction-attribution.ts'
import type { SessionMeta, SessionMetaPatch } from './session-meta.ts'
import { WebCallTracker } from './web-call.ts'
import { extractFirstTokenTimeFromStream, extractUsageFromStream, isImportedHistoryEvent, modelOfEvent, providerOfEvent, recordOfEvent, type RequestTiming, type UsageFields } from './usage-record.ts'
import type { UsageLog } from './usage-log.ts'
import { isSubagentMode } from './wire.ts'

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
  /** Rows whose `sessionId` was corrected in place during reconcile (for
   * example, a parent `assistant/message` previously misattributed to a fork
   * child). Omitted when zero. */
  reassigned?: number
  /** Session events skipped because the DeepSeek chat importer synthesized
   * them (imported replies and their excluded-reply turn errors, see
   * `isImportedHistoryEvent`). Omitted when zero. */
  ignoredImported?: number
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
  /** Importer-synthesized events skipped so far; omitted while zero. */
  ignoredImported?: number
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
  /** Merge one session's fields (latest-wins per key, or fill-only). */
  upsert(id: string, patch: SessionMeta, options?: { fillOnly?: boolean }): Promise<void>
  /** Merge many sessions' fields in one read-merge-write. Optional: a sink
   * without it receives a batch one `upsert` at a time, with each entry's
   * fill-only flag preserved. */
  upsertMany?(entries: readonly SessionMetaPatch[]): Promise<void>
}

/** Land one session's metadata batch through whatever the sink offers. */
async function writeMeta(sink: SyncMetaSink, entries: readonly SessionMetaPatch[]): Promise<void> {
  if (entries.length === 0) return
  if (sink.upsertMany !== undefined) {
    await sink.upsertMany(entries)
    return
  }
  for (const { id, patch, fillOnly } of entries) {
    await sink.upsert(id, patch, fillOnly === true ? { fillOnly: true } : undefined)
  }
}

/** One stored session as the host's `list` reports it: the id rides the
 * detached header snapshot. */
export type SyncSessionEntry = { readonly header: { readonly id: SessionId } }

/** One open read handle onto a stored session. The host's real handle also
 * carries `append`/`flush` and an `eventState` beside `read`'s events; the
 * sync needs only this much. */
export interface SyncSessionHandle {
  /** The immutable stored header, fixed when the handle was opened. */
  readonly header?: SessionHeaderFacts | undefined
  /** Exact fork-inherited prefix length when supplied by the host persistence
   * handle (0 for unseeded sessions; undefined on older hosts). */
  readonly inheritedEventCount?: number | undefined
  /** The log slice; with no arguments, the whole log from seq 0. */
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  /** Release the handle — idempotent. On a read handle this frees local
   * resources only: a read handle never takes write ownership, so it runs
   * beside the host's writer (and beside another process's). */
  close(): Promise<void>
}

/**
 * The persistence surface the sync needs (duck-typed for tests; the host
 * passes its `ctx.sessionPersistence`):
 *
 * - `list({ signal })` reports every stored session as a header snapshot
 *   (`header.id`).
 * - `open(id, 'read')` yields a handle whose `read()` returns the log while
 *   `header` carries the identity facts.
 */
export interface SyncPersistence {
  /** Every materialized session, in arbitrary order. */
  list(options?: { signal?: AbortSignal }): Promise<readonly SyncSessionEntry[]>
  /** One read handle onto a stored session. */
  open(id: SessionId, access: 'read', options?: { signal?: AbortSignal }): Promise<SyncSessionHandle>
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
   * each session's latest-wins `session/title` text, its immutable header
   * facts (cwd, lineage), and the subagent identity / team-mode selection
   * its own `subagent/catalog`, `subagent/descriptor` and `team/mode`
   * events state. Absent → no metadata capture (the usage walk still runs). */
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
 * Normalize the handle persistence seam into the generation-free read surface
 * {@link syncHistory} walks.
 *
 * The reader is built once per sync, never once per session.
 * @param persistence - the host's `ctx.sessionPersistence` (or a test twin).
 * @returns the normalized reader.
 */
export function readerOf(persistence: SyncPersistence): SessionReader {
  const idOf = (entry: SyncSessionEntry): SessionId => entry.header.id
  return {
    async list(signal) {
      return (await persistence.list(signal === undefined ? {} : { signal })).map(idOf)
    },
    async read(id, signal) {
      const handle = await persistence.open(id, 'read', signal === undefined ? {} : { signal })
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

/** A non-empty string field, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The `data` object of an event, or undefined when it carries none. */
function dataOf(event: SessionEvent): Record<string, unknown> | undefined {
  const data = (event as { data?: unknown }).data
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
}

/** The identity one parent's `subagent/catalog` entry states for a direct
 * child, already in the metadata row's own field names (so a caller merges
 * it as-is). Every field but `childId` is optional: `subagentName` exists
 * only on version-3 entries, and the label is optional on one-shot and
 * external ones. */
export type SubagentCatalogFact = Pick<SessionMeta, 'subagentName' | 'subagentLabel' | 'subagentMode'> & {
  childId: string
}

/**
 * Read a parent's `subagent/catalog` event duck-typed, or undefined when
 * the event is none or names no child. The payload `version` is
 * deliberately not checked — the plugin takes whatever recognizable fields
 * an entry carries, so a future version that keeps these field names needs
 * no change here, and an unfamiliar `mode` simply reads as "none stated".
 * Exported for the live recorder, which folds the same event into the same
 * index.
 */
export function subagentCatalogOfEvent(event: SessionEvent): SubagentCatalogFact | undefined {
  if ((event as { type: string }).type !== 'subagent/catalog') return undefined
  const data = dataOf(event)
  if (data === undefined) return undefined
  const childId = textOf(data.childId)
  if (childId === undefined) return undefined
  const fact: SubagentCatalogFact = { childId }
  const name = textOf(data.name)
  if (name !== undefined) fact.subagentName = name
  const label = textOf(data.label)
  if (label !== undefined) fact.subagentLabel = label
  if (isSubagentMode(data.mode)) fact.subagentMode = data.mode
  return fact
}

/** The identity a child's own `subagent/descriptor` states, in the metadata
 * row's field names. It never carries a name (only the parent's catalog
 * does) and never `external` (an external child has no session to write a
 * descriptor into). */
export type SubagentDescriptorFact = Pick<SessionMeta, 'subagentLabel' | 'subagentMode'>

/**
 * Read a child's `subagent/descriptor` event duck-typed, or undefined when
 * the event is none or states no field this build recognizes. Same
 * version-agnostic tolerance as {@link subagentCatalogOfEvent}.
 */
export function subagentDescriptorOfEvent(event: SessionEvent): SubagentDescriptorFact | undefined {
  if ((event as { type: string }).type !== 'subagent/descriptor') return undefined
  const data = dataOf(event)
  const fact: SubagentDescriptorFact = {}
  const label = data === undefined ? undefined : textOf(data.label)
  if (label !== undefined) fact.subagentLabel = label
  if (data !== undefined && isSubagentMode(data.mode) && data.mode !== 'external') fact.subagentMode = data.mode
  return Object.keys(fact).length === 0 ? undefined : fact
}

/**
 * The team-mode selection a runtime root's `team/mode` event states, or
 * undefined when the event is none or carries no boolean.
 */
export function teamModeOfEvent(event: SessionEvent): boolean | undefined {
  if ((event as { type: string }).type !== 'team/mode') return undefined
  const enabled = dataOf(event)?.enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}

/**
 * Whether an event is the fork-boundary marker inserted after a child's
 * inherited prefix (`session/end-seed { inherited: true }`). Ordinary resume
 * markers (`{}`) carry no `inherited: true` flag and return false.
 */
export function isInheritedSeedMarker(event: SessionEvent): boolean {
  if ((event as { type: string }).type !== 'session/end-seed') return false
  return (event as { data?: { inherited?: unknown } }).data?.inherited === true
}

/**
 * Locate the last `session/end-seed { inherited: true }` marker in a full event
 * log, or `-1` when none exists. Scanning from the tail handles nested forks
 * (`A -> B -> C`), whose copied prefix may retain an ancestor's earlier marker.
 */
export function findLastInheritedSeedIndex(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event !== undefined && isInheritedSeedMarker(event)) return i
  }
  return -1
}

/**
 * Whether a live `session/event` delivery belongs to `session` rather than
 * its fork-inherited prefix. Prefers `session.isOwnSeq(event.seq)`, falls back
 * to comparing `event.seq` against `session.inheritedEventCount`, and defaults
 * to true for older hosts or minimal test doubles without fork metadata.
 */
export function isOwnSessionEvent(session: unknown, event: SessionEvent): boolean {
  if (typeof session !== 'object' || session === null) return true
  const candidate = session as { isOwnSeq?: unknown; inheritedEventCount?: unknown }
  if (typeof candidate.isOwnSeq === 'function') {
    return Boolean((candidate.isOwnSeq as (seq: SessionEvent['seq']) => unknown)(event.seq))
  }
  if (typeof candidate.inheritedEventCount === 'number'
    && Number.isSafeInteger(candidate.inheritedEventCount)
    && candidate.inheritedEventCount >= 0) {
    return event.seq >= candidate.inheritedEventCount
  }
  return true
}

/**
 * Whether `ownEvents` contains an own failure event before its own route
 * events establish `model` and `provider`, requiring prefix folding.
 */
function needsPrefixRouteForOwnEvents(ownEvents: readonly SessionEvent[]): boolean {
  let hasModel = false
  let hasProvider = false
  for (const event of ownEvents) {
    if (modelOfEvent(event) !== undefined) hasModel = true
    if (providerOfEvent(event) !== undefined) hasProvider = true
    if (hasModel && hasProvider) return false
    if (event.type === 'llm/retry' && !hasModel) return true
    if (event.type === 'turn/end' && event.data.reason.kind === 'error' && (!hasModel || !hasProvider)) {
      return true
    }
  }
  return false
}

/**
 * Read one session's events for history sync, splitting the fork-inherited
 * prefix (folded only for title/route state) from the session's own events.
 * Uses `handle.inheritedEventCount` slice reads when exposed so SQLite can skip
 * decompressing parent segments unless a missing own title or early own failure
 * needs the prefix; falls back to the last `session/end-seed { inherited: true }`
 * marker on older hosts.
 */
async function readSessionForSync(
  persistence: SyncPersistence,
  id: SessionId,
  options: { needMeta: boolean; needPrefixForReconcile?: boolean; signal?: AbortSignal },
): Promise<{
  prefixEvents: readonly SessionEvent[]
  ownEvents: readonly SessionEvent[]
  meta?: SessionHeaderFacts | undefined
}> {
  const { signal } = options
  const handle = await persistence.open(id, 'read', signal === undefined ? {} : { signal })
  try {
    const readOpts = signal === undefined ? undefined : { signal }
    const rawInherited = handle.inheritedEventCount
    const inheritedCount = typeof rawInherited === 'number'
      && Number.isSafeInteger(rawInherited)
      && rawInherited >= 0
      ? rawInherited
      : undefined
    if (inheritedCount !== undefined && inheritedCount > 0) {
      const slice = readOpts === undefined
        ? await handle.read(inheritedCount)
        : await handle.read(inheritedCount, undefined, readOpts)
      if (slice.events.length > 0 && slice.events[0]!.seq < inheritedCount) {
        // Defensive fallback for handles that ignore `offset` and return from seq 0.
        const prefixEvents: SessionEvent[] = []
        const ownEvents: SessionEvent[] = []
        for (const event of slice.events) {
          if (event.seq < inheritedCount) prefixEvents.push(event)
          else ownEvents.push(event)
        }
        return { prefixEvents, ownEvents, meta: handle.header }
      }
      const ownEvents = slice.events
      const needsTitle = options.needMeta && !ownEvents.some(event => titleOfEvent(event) !== undefined)
      const needsRoute = needsPrefixRouteForOwnEvents(ownEvents)
      let prefixEvents: readonly SessionEvent[] = []
      if (needsTitle || needsRoute || options.needPrefixForReconcile === true) {
        const prefixSlice = readOpts === undefined
          ? await handle.read(0, inheritedCount)
          : await handle.read(0, inheritedCount, readOpts)
        prefixEvents = prefixSlice.events.filter(event => event.seq < inheritedCount)
      }
      return { prefixEvents, ownEvents, meta: handle.header }
    }
    const { events } = readOpts === undefined
      ? await handle.read()
      : await handle.read(undefined, undefined, readOpts)
    if (inheritedCount === 0) {
      return { prefixEvents: [], ownEvents: events, meta: handle.header }
    }
    const cutIndex = findLastInheritedSeedIndex(events)
    if (cutIndex >= 0) {
      return {
        prefixEvents: events.slice(0, cutIndex),
        ownEvents: events.slice(cutIndex),
        meta: handle.header,
      }
    }
    return { prefixEvents: [], ownEvents: events, meta: handle.header }
  } finally {
    await handle.close().catch(() => {})
  }
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
  let reassigned = 0
  let failedSessions = 0
  let ignoredImported = 0
  const total = sessions.length
  let processed = 0
  const progress = (): SyncProgressTick => ({
    processed, total, added, skipped, removed, failedSessions,
    ...(ignoredImported > 0 ? { ignoredImported } : {}),
  })
  /** Every id this walk reproduces; the reconcile pass keeps exactly these. */
  const reproduced = new Set<string>()
  /** Reproducing sessions observed per request id; unique owners feed
   * in-place reassignment of previously misattributed rows. */
  const reproducedOwners = new Map<string, Set<string>>()
  /** Sessions this walk read in full. Only their rows may be reconciled: a
   * row whose session is missing from the list (deleted, or hidden behind a
   * header this build cannot read) is never dropped for its absence. */
  const readable = new Set<SessionId>()
  onTick?.(progress())
  for (const id of sessions) {
    signal?.throwIfAborted()
    // One unreadable session log (a format the current dsh build rejects,
    // a torn file, …) must not abort the whole walk: skip the session,
    // report it, and let the rest of the history land.
    let inspection: {
      prefixEvents: readonly SessionEvent[]
      ownEvents: readonly SessionEvent[]
      meta?: SessionHeaderFacts | undefined
    }
    try {
      inspection = await readSessionForSync(deps.persistence, id, {
        needMeta: deps.meta !== undefined,
        needPrefixForReconcile: deps.reconcile !== false && eligible.size > 0,
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      // A cancellation is the caller's (or the host read path's) abort —
      // always fatal to the run, never a session to skip.
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      failedSessions += 1
      processed += 1
      deps.onSessionFailure?.(id, error)
      onTick?.(progress())
      continue
    }
    // The session was read in full: this walk is now the authority for what
    // the ledger must hold, so its stale coordinates become droppable.
    readable.add(id)
    // Last-known route of this session: a turn/end error names neither a
    // model nor a provider, so the walk follows the same request/header +
    // request/context + assistant/message events the live recorder does.
    // Compaction and llm/retry carry their own route on the event and do not
    // move this.
    let model = ''
    let provider = ''
    // Latest-wins title: title events append in seq order, so the LAST one
    // seen is the current title — a rename, an auto-generated title, and a
    // fallback all land as the same append, one fold covers every source.
    let title: string | undefined
    // Subagent identity, folded from this session's OWN events only. The
    // host's own projections skip a fork's inherited prefix for these
    // events (`event.seq < inheritedEventCount`), and so does this fold: a
    // fork copy does not own the children its inherited catalog lists, and
    // an inherited ancestor descriptor is not the copy's identity. Unlike
    // the title, an inherited value is never borrowed either.
    /** Catalog entries for direct children, in catalog order. The host
     * appends one entry per child, so a repeated childId is unexpected;
     * later fields win over earlier ones, field by field. */
    const catalogChildren = new Map<string, SubagentCatalogFact>()
    /** The FIRST own descriptor is authoritative (the establishing provider
     * appends exactly one; a later same-type event cannot rewrite it). */
    let descriptor: SubagentDescriptorFact | undefined
    let descriptorSeen = false
    /** Latest-wins team-mode selection (a root may toggle it any time). */
    let teamMode: boolean | undefined
    // Fold state-only context (route and title) across the fork-inherited
    // prefix without persisting rows, claiming ownership, or carrying open
    // steps and compaction windows across the fork boundary. Keep inherited
    // assistant message ids (shared across parent and fork) in `reproduced`
    // without adding `id` to `reproducedOwners`: a readable parent still
    // reclaims misattributed rows, while a deleted/unreadable parent's rows
    // are never dropped by reconcile. Session-scoped ids (`compaction:`,
    // `failure:`, `web:`) stay excluded so fork duplicates are still pruned.
    for (const event of inspection.prefixEvents) {
      signal?.throwIfAborted()
      const revealed = modelOfEvent(event)
      if (revealed !== undefined) model = revealed
      const revealedProvider = providerOfEvent(event)
      if (revealedProvider !== undefined) provider = revealedProvider
      const revealedTitle = titleOfEvent(event)
      if (revealedTitle !== undefined) title = revealedTitle
      if (event.type === 'assistant/message' && !isImportedHistoryEvent(event)) {
        const prefixRecord = recordOfEvent(event, id, model, false, undefined, provider)
        if (prefixRecord !== null) reproduced.add(prefixRecord.requestId)
      }
    }
    let openStep: { turn: number; step: number; startTime: number } | null = null
    let pendingAttemptUsage: { turn: number; step: number; usage: UsageFields } | undefined
    let importedStep = false
    // The compaction attribution window of this session — the SAME
    // implementation the live recorder drives, so a rescan attributes rows
    // exactly like a live observation would.
    const attributionWindow = new CompactionAttributionWindow()
    // The same per-session web-search pairing the live recorder drives, so a
    // backfill reproduces the rows (and their request ids) exactly.
    const webCallTracker = new WebCallTracker(id)
    for (const event of inspection.ownEvents) {
      signal?.throwIfAborted()
      if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
        importedStep = false
      }
      if (!importedStep) {
        const webRecord = webCallTracker.observe(event)
        if (webRecord !== null) {
          reproduced.add(webRecord.requestId)
          let webOwners = reproducedOwners.get(webRecord.requestId)
          if (webOwners === undefined) {
            webOwners = new Set()
            reproducedOwners.set(webRecord.requestId, webOwners)
          }
          webOwners.add(id)
          if (await deps.log.record(webRecord)) added += 1
          else skipped += 1
        }
      }
      if (event.type === 'step/start') {
        openStep = {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
        }
        pendingAttemptUsage = undefined
      } else if (event.type === 'assistant/attempt') {
        const usage = extractUsageFromStream(event.data.stream)
        pendingAttemptUsage = usage !== undefined
          ? { turn: event.data.turn, step: event.data.step, usage }
          : undefined
      }
      const revealed = modelOfEvent(event)
      if (revealed !== undefined) model = revealed
      const revealedProvider = providerOfEvent(event)
      if (revealedProvider !== undefined) provider = revealedProvider
      const revealedTitle = titleOfEvent(event)
      if (revealedTitle !== undefined) title = revealedTitle
      // Identity capture rides the same pass, ahead of every `continue`
      // below (an importer-synthesized step still owns its events' types).
      if (deps.meta !== undefined) {
        const eventType: string = event.type
        if (eventType === 'subagent/catalog') {
          const fact = subagentCatalogOfEvent(event)
          if (fact !== undefined) {
            catalogChildren.set(fact.childId, { ...catalogChildren.get(fact.childId), ...fact })
          }
        } else if (eventType === 'subagent/descriptor') {
          if (!descriptorSeen) {
            descriptorSeen = true
            descriptor = subagentDescriptorOfEvent(event)
          }
        } else if (eventType === 'team/mode') {
          const revealedTeamMode = teamModeOfEvent(event)
          if (revealedTeamMode !== undefined) teamMode = revealedTeamMode
        }
      }
      let timing: RequestTiming | undefined
      let failureUsage: UsageFields | undefined
      if (event.type === 'assistant/message') {
        pendingAttemptUsage = undefined
        if (openStep !== null
          && openStep.turn === event.data.turn
          && openStep.step === event.data.step) {
          const latencyMs = Math.max(0, event.time - openStep.startTime)
          // The timed model stream embedded in assistant/message carries the
          // first token delta's timestamp.
          const firstTokenTime = extractFirstTokenTimeFromStream(event.data.stream)
          const firstTokenLatencyMs = firstTokenTime !== undefined
            ? Math.max(0, firstTokenTime - openStep.startTime)
            : undefined
          timing = {
            startedAt: openStep.startTime,
            latencyMs,
            ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
          }
          openStep = null
        }
      } else if (event.type === 'llm/retry') {
        if (pendingAttemptUsage !== undefined
          && pendingAttemptUsage.turn === event.data.turn
          && pendingAttemptUsage.step === event.data.step) {
          failureUsage = pendingAttemptUsage.usage
        }
        pendingAttemptUsage = undefined
      } else if (event.type === 'step/end') {
        openStep = null
      } else if (event.type === 'turn/end') {
        openStep = null
        if (event.data.reason.kind === 'error'
          && pendingAttemptUsage !== undefined
          && pendingAttemptUsage.turn === event.data.turn) {
          failureUsage = pendingAttemptUsage.usage
        }
        pendingAttemptUsage = undefined
      }
      attributionWindow.observe(event)
      // Importer-synthesized history is no provider call: count it for the
      // scan summary and leave it out of `reproduced`, so the closing
      // reconcile drops rows an older build recorded for it.
      if (isImportedHistoryEvent(event)) {
        if (event.type === 'assistant/message') importedStep = true
        ignoredImported += 1
        continue
      }
      const record = recordOfEvent(event, id, model, deps.recordCompaction !== false, timing, provider, failureUsage)
      if (record === null) continue
      // Attribution attaches to plain-request rows only (same rule as the
      // live recorder): the compaction row is the rewrite's own billing row,
      // a failure row has no cache figures to explain. Rows already saved
      // dedupe below — the attribution lands on the first write, and rows
      // persisted before this field stay unattributed (never rewritten).
      if (record.kind === undefined || record.kind === 'request') {
        const attribution = attributionWindow.consumeForRequest()
        if (attribution !== undefined) record.compactionAttribution = attribution
      }
      // Keep the id whether the row was already saved or lands now: the
      // reconcile pass keeps exactly the ids this walk produced.
      reproduced.add(record.requestId)
      let owners = reproducedOwners.get(record.requestId)
      if (owners === undefined) {
        owners = new Set()
        reproducedOwners.set(record.requestId, owners)
      }
      owners.add(id)
      if (await deps.log.record(record)) added += 1
      else skipped += 1
    }
    // Drafts without a durable result (a torn log, or a call interrupted
    // without the host's synthetic result) stay out of the ledger.
    webCallTracker.clear()
    // One metadata batch per session: the title fold above, the immutable
    // header facts, this session's own subagent identity and team-mode
    // selection, plus — for a parent — one entry per catalogued child. The
    // catalog entry lands on the CHILD's row, so a parent with dozens of
    // subagents writes them all in one serialized read-merge-write instead
    // of rewriting the index once per child. Every entry is a no-op when
    // nothing changed, so repeat syncs never rewrite the index.
    if (deps.meta !== undefined) {
      const header = inspection.meta
      const patch: SessionMeta = {
        ...(title !== undefined ? { title } : {}),
        ...(header?.cwd !== undefined && header.cwd !== '' ? { cwd: header.cwd } : {}),
        ...(header?.origin === 'subagent' ? { origin: header.origin } : {}),
        ...(header?.parentSession !== undefined && header.parentSession !== '' ? { parentSession: header.parentSession } : {}),
        ...(teamMode !== undefined ? { teamMode } : {}),
      }
      const entries: SessionMetaPatch[] = []
      if (Object.keys(patch).length > 0) entries.push({ id, patch })
      // The child's own descriptor is the weaker source: it fills the
      // label / mode in only where the parent's catalog stated none.
      if (descriptor !== undefined) entries.push({ id, patch: descriptor, fillOnly: true })
      for (const { childId, ...identity } of catalogChildren.values()) {
        // An entry that states nothing but the child's id carries no fact.
        if (Object.keys(identity).length === 0) continue
        entries.push({ id: childId, patch: { parentSession: id, ...identity } })
      }
      await writeMeta(deps.meta, entries)
    }
    processed += 1
    onTick?.(progress())
  }
  // Reconcile last, once every readable session has spoken for its rows: a
  // saved row no readable session reproduces is a relic of an older stored
  // format. A session that merely failed to load protects its own rows.
  if (deps.reconcile !== false) {
    const expectedOwners = new Map<string, string>()
    for (const [requestId, owners] of reproducedOwners) {
      if (owners.size === 1) {
        const [owner] = owners
        if (owner !== undefined) expectedOwners.set(requestId, owner)
      }
    }
    removed = await deps.log.reconcile(
      reproduced,
      readable,
      eligible,
      expectedOwners,
      (count) => { reassigned = count },
    )
  }
  return {
    added,
    skipped,
    removed,
    failedSessions,
    ...(reassigned > 0 ? { reassigned } : {}),
    ...(ignoredImported > 0 ? { ignoredImported } : {}),
  }
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
