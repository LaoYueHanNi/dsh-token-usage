/**
 * Live request observation (node half): a passive, pass-through watcher on
 * the `llm/stream` waterfall that tracks one entry per real provider attempt
 * (per `sessionId` + turn/step + attempt ordinal) so the conversation usage
 * tab can show 请求池 rows WHILE a request waits, streams, fails, or is
 * cancelled — not only after its usage record lands.
 *
 * Registration is INDEPENDENT of the auxiliary-recording switch: the
 * listener is installed unconditionally whenever the llm service exists, so
 * `recordAux: false` cannot silently disable the pool. The listener is
 * strictly passive — every chunk is yielded unchanged, nothing is buffered,
 * awaited on disk, or pre-read; cancel, backpressure, and listener-chain
 * semantics are the caller's own (same shape as the auxiliary recorder).
 * Prompt text, reasoning, tool arguments, and credentials never leave this
 * module: only counts, timings, model ids, and failure codes cross to the
 * stats route.
 *
 * Lifecycle facts this module relies on (verified against the host source):
 * - Every provider attempt dispatches its own `llm/stream` waterfall call —
 *   dsh-llm-retry retries on the agent loop's `agent/request-error` seam,
 *   and the loop re-dispatches through `llm.stream()` within the SAME
 *   turn/step, so the Nth waterfall call of one (session, turn, step) is
 *   the Nth attempt.
 * - The streaming protocol carries `usage` exactly once, just before the
 *   terminal `finish` — there is NO in-generation token progress route, so
 *   live rows show lifecycle only (capability `lifecycle`), never a
 *   fabricated tok/s.
 * - A mid-stream abort settles as `assistant/message` (interrupted, partial
 *   usage) or `assistant/attempt` (nothing delivered, which this plugin does
 *   not record); a retried failure settles as `assistant/attempt` then
 *   `llm/retry` / `llm/retry-started`. Every settlement the plugin records a
 *   row for is LINKED here by its durable id: `assistant/message` names the
 *   turn/step's completing attempt, `llm/retry` (appended before the
 *   backoff, so the cell's latest dispatch is the attempt that just failed)
 *   and a turn-ending error map to `failure:<session>:<seq>`, and a
 *   `compaction/summary` maps to its summarize call via the compaction lock
 *   window (`compaction/start` holds the per-session lock through `end`, so
 *   the window's compaction attempt is the summarized one). `turn/end`
 *   resolves whatever the stream never did.
 * - Compaction summarize calls carry `purpose: 'compaction'` and the owning
 *   session id but no step. Title calls carry their owning session id on
 *   current hosts and enter the pool as `aux`; unowned review/translation
 *   calls stay out because the stats route cannot safely attribute them.
 *
 * @module token-usage/request-observe
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
// Type-only: pull the declaration-merged `llm/retry` and `compaction/*`
// event payloads into this program, so the settlement-linking handlers below
// can name `SessionEvent<'llm/retry'>` and the compaction types.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { AuxKind } from './usage-record.ts'
import { isTokenDelta, type UsageFields, type UsageRecord } from './usage-record.ts'
import { AUTO_REVIEW_PROMPT_PREFIX } from './aux-request.ts'
import type { RequestDetailState } from './wire.ts'

/** One live attempt observed at the waterfall: the runtime-state shape the
 * stats route merges against the persisted records. */
export interface LiveAttempt {
  /** Stable attempt identity: `<epoch>:<sessionId>:t<turn>:s<step>:a<n>`
   * (turn/step `-1` when the attempt ran outside a step, e.g. compaction).
   * Unique per process; a restarted process gets a new epoch. */
  readonly id: string
  sessionId: string
  kind: 'request' | 'compaction' | 'failure' | 'aux'
  /** Auxiliary subtype when the host stamped an owning session. */
  auxKind?: AuxKind
  state: RequestDetailState
  /** True for attempts that entered the waiting/streaming lifecycle. Used
   * to distinguish a just-finished live request from a synthetic settled
   * snapshot supplied by a caller. */
  wasActive?: boolean
  provider: string
  requestedModel: string
  /** Absolute epoch ms of the waterfall dispatch (the attempt's start). */
  startedAt: number
  /** Absolute epoch ms when the attempt settled (finish/abort/turn-end). */
  settledAt?: number
  /** Absolute epoch ms of the first non-empty token delta. */
  firstTokenAt?: number
  /** The attempt's provider usage (the single pre-finish chunk); a reported
   * 0 cache-read bucket survives the copy as 0 — presence IS the evidence. */
  usage?: UsageFields
  failureCode?: string
  /** The durable request id once a settlement named it — `assistant/message`
   * for the turn/step's completing attempt, `failure:<session>:<seq>` for a
   * retried-failed or turn-ending attempt, `compaction:<session>:<seq>` for
   * a summarize call. The merge key against the persisted rows. */
  durableRequestId?: string
  /** The compaction this summarize call belongs to (`compaction/start`'s
   * id, observed when the call dispatched inside the compaction's lock
   * window); the summary event's linking key. */
  compactionId?: string
  /** The loop turn/step the attempt dispatched inside (`-1` when outside a
   * step, e.g. compaction); the settlement-linking key. */
  turn: number
  step: number
}

/** Everything the stats route needs from the observer for one scope. */
export interface LiveSnapshot {
  /** Live attempts belonging to the scope (settled ones included — the
   * route merges/dedupes them against the persisted records). */
  attempts: readonly LiveAttempt[]
  /** Attempts still waiting/streaming in the scope. */
  activeCount: number
}

/** How long a SETTLED live attempt lingers before cleanup (the merge needs
 * it only until the persisted row exists; a generous TTL also keeps a just
 * -settled row visible on slow-disk flushes). Unsettled rows are never
 * TTL'd — they are the pool's live rows. */
const SETTLED_TTL_MS = 10 * 60_000

/** Per-session bound on retained SETTLED attempts (2× the pool limit): the
 * oldest settled rows drop first. Unsettled rows never count toward the
 * bound. */
const SETTLED_KEEP_PER_SESSION = 40

/**
 * Passive live-request observer. One instance per plugin apply; the stats
 * route reads `snapshot()` per request, and dispose clears everything.
 */
export class RequestObserver {
  private readonly attempts = new Map<string, LiveAttempt>()
  /** The loop's open step per session (`step/start` … `assistant/message` /
   * `step/end`). Attempt ordinals read it at dispatch time. */
  private readonly activeSteps = new Map<string, { turn: number; step: number }>()
  /** Next attempt ordinal per (session, turn, step) — and per session for
   * out-of-step callers (compaction). */
  private readonly counters = new Map<string, number>()
  /** The compaction currently holding a session's lock (`compaction/start`
   * … `compaction/end`): the lock window a summarize waterfall call
   * dispatches inside, keyed by its `compactionId`. */
  private readonly openCompactions = new Map<string, string>()
  private disposed = false
  private disposers: Array<() => void> = []

  constructor(private readonly epoch: number) {}

  /**
   * Register the waterfall watcher. Returns the detach function (the caller
   * wraps it in its effect); the listener is inert after {@link dispose}.
   * A host without the llm service never calls this, and the snapshot
   * stays empty (capability `settled-only`).
   */
  attachLlm(llmCtx: Context): () => void {
    const dispose = llmCtx.on('llm/stream', (options, next) => {
      if (this.disposed) return next()
      return this.observe(options as { sessionId?: string; purpose?: string; provider: string; model: string; signal?: AbortSignal }, next)
    })
    this.disposers.push(dispose)
    return dispose
  }

  /** Track the loop's step boundaries and resolve settlements the stream
   * itself could not (message ids, turn-end failure codes). */
  attachSessions(ctx: Context): void {
    const off = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (this.disposed) return
      this.observeEvent(session.id, event)
    })
    this.disposers.push(off)
  }

  /** Clear every tracked attempt and detach nothing (listeners self-inert). */
  dispose(): void {
    this.disposed = true
    this.attempts.clear()
    this.activeSteps.clear()
    this.counters.clear()
    this.openCompactions.clear()
    for (const off of this.disposers) off()
    this.disposers = []
  }

  /** The scope's live attempts plus its in-flight count. */
  snapshot(sessionIds: readonly string[]): LiveSnapshot {
    const wanted = new Set(sessionIds)
    const attempts: LiveAttempt[] = []
    let activeCount = 0
    for (const attempt of this.attempts.values()) {
      if (!wanted.has(attempt.sessionId)) continue
      if (attempt.state === 'waiting' || attempt.state === 'streaming') activeCount += 1
      attempts.push(attempt)
    }
    return { attempts, activeCount }
  }

  /** Persist the exact linked attempt clock without changing the ledger's
   * step timings or billing timestamp. This survives cleanup/restarts. */
  decorateRecord(record: UsageRecord): UsageRecord {
    for (const attempt of this.attempts.values()) {
      if (attempt.sessionId !== record.sessionId || attempt.durableRequestId !== record.requestId) continue
      if (attempt.settledAt === undefined) return record
      return {
        ...record,
        attemptTiming: {
          startedAt: attempt.startedAt,
          settledAt: attempt.settledAt,
          ...(attempt.firstTokenAt !== undefined ? { firstTokenAt: attempt.firstTokenAt } : {}),
        },
        ...(record.provider === undefined ? { provider: attempt.provider } : {}),
      }
    }
    return record
  }

  /** Link a successful, host-attributed auxiliary stream to the id used by
   * the JSONL recorder. Title requests are observed by both listeners and
   * have no session event to provide a durable id of their own. */
  linkAuxAttempt(input: {
    sessionId: string
    auxKind: AuxKind
    startedAt: number
    provider: string
    model: string
    requestId: string
  }): void {
    let found: LiveAttempt | undefined
    let distance = Number.POSITIVE_INFINITY
    for (const attempt of this.attempts.values()) {
      if (attempt.kind !== 'aux' || attempt.auxKind !== input.auxKind
        || attempt.sessionId !== input.sessionId || attempt.durableRequestId !== undefined
        || attempt.provider !== input.provider || attempt.requestedModel !== input.model) continue
      const nextDistance = Math.abs(attempt.startedAt - input.startedAt)
      if (nextDistance > 2_000 || nextDistance >= distance) continue
      found = attempt
      distance = nextDistance
    }
    if (found !== undefined) found.durableRequestId = input.requestId
  }

  /** Housekeeping the route never sees: drop settled rows past the TTL or
   * beyond the per-session bound, so idle sessions shrink back to zero. */
  cleanup(now: number = Date.now()): void {
    const settledPerSession = new Map<string, LiveAttempt[]>()
    for (const attempt of this.attempts.values()) {
      if (attempt.state === 'waiting' || attempt.state === 'streaming') continue
      const settledAt = attempt.settledAt ?? 0
      if (now - settledAt > SETTLED_TTL_MS) this.attempts.delete(attempt.id)
    }
    for (const attempt of this.attempts.values()) {
      if (attempt.state === 'waiting' || attempt.state === 'streaming') continue
      const bucket = settledPerSession.get(attempt.sessionId) ?? []
      bucket.push(attempt)
      settledPerSession.set(attempt.sessionId, bucket)
    }
    for (const bucket of settledPerSession.values()) {
      if (bucket.length <= SETTLED_KEEP_PER_SESSION) continue
      bucket.sort((left, right) => left.startedAt - right.startedAt)
      for (const attempt of bucket.slice(0, bucket.length - SETTLED_KEEP_PER_SESSION)) {
        this.attempts.delete(attempt.id)
      }
    }
  }

  private observeEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === 'step/start') {
      this.activeSteps.set(sessionId, { turn: event.data.turn, step: event.data.step })
      return
    }
    if (event.type === 'assistant/message') {
      // The durable settlement of this turn/step's LAST attempt: link it so
      // the merge can fold the persisted row into the live one in place.
      const linked = this.lastAttemptOf(sessionId, event.data.turn, event.data.step)
      if (linked !== undefined && linked.kind !== 'aux' && linked.durableRequestId === undefined) {
        linked.durableRequestId = event.data.message.id
      }
      return
    }
    if (event.type === 'llm/retry') {
      // One failed attempt that dsh-llm-retry scheduled another try for. The
      // event is appended BEFORE the backoff wait (and so before the next
      // dispatch): the (session, turn, step) cell's latest dispatch is the
      // attempt that just failed, and the recorded row will be
      // `failure:<session>:<seq>`. The state guard keeps a lost finish
      // observation from claiming the link — turn/end still resolves it.
      const linked = this.lastAttemptOf(sessionId, event.data.turn, event.data.step)
      // A provider can throw without emitting a finish chunk. The stream
      // wrapper marks that attempt interrupted, but this retry event is
      // authoritative evidence that it was a failed provider attempt.
      if (linked !== undefined && linked.kind !== 'aux' && (linked.state === 'failed' || linked.state === 'interrupted') && linked.durableRequestId === undefined) {
        linked.state = 'failed'
        linked.failureCode ??= event.data.failure.code
        linked.durableRequestId = `failure:${sessionId}:${String(event.seq)}`
      }
      return
    }
    if (event.type === 'compaction/start') {
      // The summarize call(s) until `end` dispatch inside this lock window.
      this.openCompactions.set(sessionId, event.data.compactionId)
      return
    }
    if (event.type === 'compaction/summary') {
      // The summarize call's durable row: `compaction:<session>:<seq>`. The
      // lock guarantees at most one compaction per session at a time, so the
      // window's attempt (matched by compactionId; the latest unlinked
      // compaction attempt as the fallback for a window missed before
      // install) is the one this event summarizes. A summary without usable
      // usage records no row — the unlinked live row stays, harmless.
      const linked = this.compactionAttemptOf(sessionId, event.data.compactionId)
      if (linked !== undefined) {
        linked.durableRequestId = `compaction:${sessionId}:${String(event.seq)}`
      }
      return
    }
    if (event.type === 'compaction/end') {
      this.openCompactions.delete(sessionId)
      return
    }
    if (event.type === 'turn/end') {
      // Resolve whatever the stream never did (a lost waterfall observation,
      // a turn that died outside the generator's finally). The turn's end
      // reason is a durable fact: error → failed, abort → cancelled,
      // anything else → interrupted (unknown, never guessed as a success).
      const reason = event.data.reason
      const state: RequestDetailState = reason.kind === 'error' ? 'failed'
        : reason.kind === 'aborted' ? 'cancelled'
          : 'interrupted'
      const code = reason.kind === 'error' ? reason.error.code : undefined
      // An error turn records a `failure:<session>:<seq>` row — link the
      // attempts it settles so the merge folds them into it. The failed
      // attempt usually went failed on its own finish chunk moments before,
      // so already-failed unlinked rows claim the link too (exactly one per
      // turn: earlier failures were linked by their own llm/retry events).
      // Compaction rows keep their own stream's verdict: the turn's reason
      // is not theirs.
      const durable = reason.kind === 'error' ? `failure:${sessionId}:${String(event.seq)}` : undefined
      let terminal: LiveAttempt | undefined
      if (durable !== undefined) {
        for (const attempt of this.attempts.values()) {
          if (attempt.sessionId !== sessionId || attempt.turn !== event.data.turn || attempt.kind === 'compaction' || attempt.kind === 'aux') continue
          if (attempt.durableRequestId !== undefined || attempt.state === 'cancelled' || attempt.state === 'completed') continue
          if (terminal === undefined || attempt.startedAt >= terminal.startedAt) terminal = attempt
        }
      }
      for (const attempt of this.attempts.values()) {
        if (attempt.sessionId !== sessionId) continue
        if (attempt.turn !== event.data.turn) continue
        if (attempt.kind === 'compaction' || attempt.kind === 'aux') continue
        const inFlight = attempt.state === 'waiting' || attempt.state === 'streaming'
        if (!inFlight && attempt !== terminal) continue
        if (inFlight) {
          attempt.state = state
          attempt.settledAt = event.time
          if (code !== undefined && attempt.failureCode === undefined) attempt.failureCode = code
        }
        if (durable !== undefined && attempt === terminal) {
          attempt.state = 'failed'
          if (code !== undefined && attempt.failureCode === undefined) attempt.failureCode = code
          attempt.durableRequestId = durable
        }
      }
      this.activeSteps.delete(sessionId)
      return
    }
    if (event.type === 'step/end') {
      this.activeSteps.delete(sessionId)
    }
  }

  /** The counter key of one (session, turn, step) cell. */
  private keyOf(sessionId: string, turn: number, step: number): string {
    return `${sessionId}\nt${String(turn)}\ns${String(step)}`
  }

  /** The most recent attempt of one (session, turn, step) cell — its last
   * dispatch, whether settled or not. */
  private lastAttemptOf(sessionId: string, turn: number, step: number): LiveAttempt | undefined {
    let found: LiveAttempt | undefined
    for (const attempt of this.attempts.values()) {
      if (attempt.sessionId !== sessionId || attempt.turn !== turn || attempt.step !== step || attempt.kind === 'aux') continue
      if (found === undefined || attempt.startedAt >= found.startedAt) found = attempt
    }
    return found
  }

  /** The compaction attempt a `compaction/summary` names: the lock window's
   * own attempt when the waterfall dispatch was observed inside it (matched
   * by `compactionId`), else the session's latest unlinked compaction
   * attempt — the lock admits at most one at a time, so "latest" is the
   * structural answer, not a timing guess. */
  private compactionAttemptOf(sessionId: string, compactionId: string): LiveAttempt | undefined {
    let windowed: LiveAttempt | undefined
    let fallback: LiveAttempt | undefined
    for (const attempt of this.attempts.values()) {
      if (attempt.sessionId !== sessionId || attempt.kind !== 'compaction') continue
      if (attempt.durableRequestId !== undefined) continue
      if (attempt.compactionId === compactionId) {
        if (windowed === undefined || attempt.startedAt >= windowed.startedAt) windowed = attempt
      } else if (attempt.compactionId === undefined) {
        if (fallback === undefined || attempt.startedAt >= fallback.startedAt) fallback = attempt
      }
    }
    return windowed ?? fallback
  }

  /**
   * The waterfall listener body: stamp a live attempt, pass the stream
   * through untouched, and fold the observed chunks back into the attempt's
   * lifecycle. The wrapper is a plain async generator object, so the
   * waterfall chain keeps its synchronous shape.
   */
  private observe(
    options: { sessionId?: string; purpose?: string; system?: string; provider: string; model: string; signal?: AbortSignal },
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    // No owning session → an auxiliary bypass call (review gate, translation)
    // or an unattributed host call. It cannot safely appear in a session
    // pool, so leave it to the global auxiliary recorder only.
    if (sessionId === undefined || sessionId === '') return next()
    const auxKind: AuxKind | undefined = options.purpose === 'session-title'
      ? 'session-title'
      : typeof options.system === 'string' && options.system.startsWith(AUTO_REVIEW_PROMPT_PREFIX)
        ? 'auto-review'
        : undefined
    const kind = options.purpose === 'compaction' ? 'compaction' : auxKind !== undefined ? 'aux' : 'request'
    const active = this.activeSteps.get(sessionId)
    const turn = active?.turn ?? -1
    const step = active?.step ?? -1
    const attemptNo = this.bumpCounter(sessionId, turn, step)
    const id = `${String(this.epoch)}:${sessionId}:t${String(turn)}:s${String(step)}:a${String(attemptNo)}`
    const startedAt = Date.now()
    const compactionId = kind === 'compaction' ? this.openCompactions.get(sessionId) : undefined
    const live: LiveAttempt = {
      id,
      sessionId,
      kind,
      ...(auxKind !== undefined ? { auxKind } : {}),
      state: 'waiting',
      wasActive: true,
      provider: options.provider,
      requestedModel: options.model,
      startedAt,
      turn,
      step,
      ...(compactionId !== undefined ? { compactionId } : {}),
    }
    this.track(live)
    const observer = this
    let upstream: AsyncIterable<StreamChunk>
    try {
      upstream = next()
    } catch (error) {
      live.settledAt = Date.now()
      live.state = options.signal?.aborted === true ? 'cancelled' : 'failed'
      this.cleanup()
      throw error
    }
    return (async function* () {
      try {
        for await (const chunk of upstream) {
          if (live.state === 'waiting' && isTokenDelta(chunk)) {
            live.state = 'streaming'
            live.firstTokenAt = Date.now()
          }
          if (chunk.type === 'usage') {
            // The copy keeps a reported 0 as 0 (presence IS the evidence)
            // and lands only when every required bucket is trustworthy — a
            // malformed report never renders, an absent one reads unknown.
            const copied = observer.copyUsage(chunk.usage)
            if (copied !== undefined) live.usage = copied
          }
          if (chunk.type === 'finish') {
            live.settledAt = Date.now()
            if (chunk.reason.kind === 'error') {
              live.state = 'failed'
              live.failureCode = chunk.reason.failure.code
            } else if (chunk.reason.kind === 'aborted') {
              live.state = 'cancelled'
            } else if (chunk.reason.kind === 'max-tokens') {
              // Truncated but finished: usage and message settle normally.
              live.state = 'completed'
            } else {
              // stop / tool-calls: the stream succeeded; the durable
              // `assistant/message` names the request id moments later.
              live.state = 'completed'
            }
          }
          yield chunk
        }
      } catch (error) {
        live.settledAt = Date.now()
        live.state = options.signal?.aborted === true ? 'cancelled' : 'failed'
        throw error
      } finally {
        // The generator died without a finish chunk: the consumer stopped
        // early (the loop throws on abort between chunks) or the observation
        // was lost. An aborted signal is a cancellation — a user stop, not a
        // provider failure; anything else is an unknown interruption, never
        // guessed into a success or a failure.
        if (live.state === 'waiting' || live.state === 'streaming') {
          live.settledAt = Date.now()
          live.state = options.signal?.aborted === true ? 'cancelled' : 'interrupted'
        }
        observer.cleanup()
      }
    })()
  }

  /** Defensive usage copy: keep only trustworthy, non-negative finite
   * counts; a bad bucket drops the whole usage (the record path does the
   * same via projectUsage). */
  private copyUsage(usage: TokenUsage): UsageFields | undefined {
    const isCount = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0
    if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(isCount(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(isCount(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    }
  }

  private bumpCounter(sessionId: string, turn: number, step: number): number {
    const key = this.keyOf(sessionId, turn, step)
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    // Keep the counter map bounded: one entry per live (session, turn, step)
    // cell plus the out-of-step slot; drop finished cells when a session
    // starts a new turn.
    if (this.counters.size > 512) this.pruneCounters(sessionId)
    return next
  }

  /** Drop counters of other sessions' finished cells (rarely needed; a
   * purely defensive bound on a map that only grows per step). */
  private pruneCounters(keepSession: string): void {
    for (const key of this.counters.keys()) {
      if (!key.startsWith(`${keepSession}\n`)) this.counters.delete(key)
    }
  }

  private track(attempt: LiveAttempt): void {
    this.attempts.set(attempt.id, attempt)
  }
}
