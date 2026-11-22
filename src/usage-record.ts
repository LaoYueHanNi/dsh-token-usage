/**
 * Pure record vocabulary of the token-usage plugin: the JSONL row type, its
 * projections from session events (assistant messages, compaction
 * summaries, turn-ending LLM failures, and retried failed attempts), and
 * lenient line parsing for the dedupe scan. No I/O and no runtime imports,
 * so every consumer shares
 * one wire format. Rows stay minimal: request id, model, the four base
 * token buckets, time, session id, and the optional origin kind — absent
 * optional buckets are omitted, never null.
 *
 * @module token-usage/usage-record
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CompactionAttributionItem } from './compaction-attribution.ts'
// Type-only: pulls the declaration-merged `compaction/*` event payloads into
// this program, so `SessionEvent<'compaction/summary'>` below is nameable.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: pulls the merged `llm/retry` payload into this program, so
// `SessionEvent<'llm/retry'>` below is nameable.
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/** Provider-reported token buckets; absent optional buckets are omitted. */
export interface UsageFields {
  /** Uncached input tokens (billed input = this + cacheRead + cacheWrite). */
  inputTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Cache-hit input tokens; omitted when the provider reported none. */
  cacheReadTokens?: number
  /** Cache-write input tokens; omitted when the provider reported none. */
  cacheWriteTokens?: number
}

/**
 * Where a record came from: a plain model request (the default), a
 * compaction summarize request (a provider-billed call of its own), a
 * failed model request (a turn that ended in an LLM error, or a provider
 * attempt that `dsh-llm-retry` scheduled a retry for — counted in its own
 * `failures` dimension, never in `requests`), an auxiliary request (a
 * bypass model call that is not part of the conversation turn: the Auto
 * review authorization gate, session-title generation, timeline report
 * generation, or reasoning translation), or a web search (one `web_search`
 * tool call whose model-turn tokens are recorded when the host reports them).
 */
export type UsageRecordKind = 'request' | 'compaction' | 'failure' | 'aux' | 'web'

/**
 * The origin of one auxiliary (bypass) model request. These calls are
 * issued by host packages directly through `ctx.llm.stream()` and do not
 * produce an `assistant/message` usage event, so the recorder captures them
 * on the `llm/stream` waterfall instead:
 *
 * - `auto-review` — the per-tool-call authorization reviewer of
 *   `@deepseek-ai/dsh-experimental-auto-review` (`purpose: 'auto-review'` on
 *   current hosts; `REVIEW_POLICY` prompt prefix fallback on older hosts).
 * - `session-title` — the logged `session/title-llm-request` generation
 *   (`purpose: 'session-title'` on the request).
 * - `timeline-report` — timed progress report synthesis of
 *   `@deepseek-ai/dsh-experimental-timeline` (`purpose: 'timeline-report'`).
 * - `translation` — the reasoning/CoT translator
 *   (`@deepseek-ai/dsh-experimental-translator`).
 * - `other` — any other unmarked or unrecognized-purpose bypass request. A
 *   defensive bucket: a host upgrade adding a new purpose or changing an
 *   unmarked prompt lands here without dropping the usage data.
 */
export type AuxKind = 'auto-review' | 'session-title' | 'timeline-report' | 'translation' | 'other'

/** Every auxiliary kind, in the fixed display order the tables use. */
export const AUX_KINDS: readonly AuxKind[] = ['auto-review', 'session-title', 'timeline-report', 'translation', 'other']

/** The model-visible tools whose calls the web dimension records. */
export const WEB_SEARCH_TOOL = 'web_search'
export const WEB_FETCH_TOOL = 'web_fetch'

/** Every recorded web tool, in the fixed display order the overhead card uses. */
export const WEB_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] as const

/** One recorded web-tool name. */
export type WebTool = (typeof WEB_TOOLS)[number]

/** Whether a `tool/call` name belongs to the recorded web-tools dimension. */
export function isWebTool(name: unknown): name is WebTool {
  return name === WEB_SEARCH_TOOL || name === WEB_FETCH_TOOL
}

/**
 * Invocation facts of one recorded web search. They are deliberately kept
 * apart from the billing fields: `rounds` says how many model turns the call
 * actually spent (0 when the selected backend bills per search instead of
 * per turn), while `usage` on the record carries the token figures only when
 * the host reported them.
 */
export interface WebCallInfo {
  /** The tool that made the call (`web_search` or `web_fetch`). */
  tool: string
  /** The model's tool-call id, pairing this row with the call event. */
  callId: string
  /** Number of queries the call submitted; absent when the arguments carried
   * none. The query text stays in the session log and is not copied into the
   * ledger. */
  queryCount?: number
  /** Model rounds the call triggered; absent when none (per-search backend). */
  rounds?: number
  /** Present when the tool result reported a failure. */
  failed?: true
  /** Provider-neutral failure code from the tool result, when it named one. */
  errorCode?: string
  /** Wall time from the tool call to its result, in milliseconds. */
  durationMs?: number
}

/**
 * Whether a raw JSONL row's `kind` field belongs to session-log-derived
 * origins that `reconcile` may drop or reassign. Auxiliary rows (`'aux'`)
 * and any unknown future kind are unconditionally exempt.
 */
export function isReconcilableKind(rawKind: unknown): boolean {
  return rawKind === undefined || rawKind === 'request' || rawKind === 'compaction'
    || rawKind === 'failure' || rawKind === 'web'
}

/** One JSONL row: one provider model call (successful or failed). */
export interface UsageRecord {
  /** Stable request identity: the assistant message id (dedupe key), a
   * synthesized `failure:<session>:<seq>` for a failed-request row, or
   * `aux:<kind>:<startedAt>:<seq>` for an auxiliary row. */
  requestId: string
  /** Session-event wall time, epoch milliseconds. */
  time: number
  /** Owning session id; '' for an auxiliary row whose host call cannot be
   * attributed safely (for example translation or Auto review on older hosts). */
  sessionId: string
  /** Provider model id that produced the message; a failure row carries the
   * session's last-known route model ('' when none was ever observed). */
  model: string
  /** Provider-reported model id of the response body — the model that
   * actually served the request, which a routed alias may differ from
   * (e.g. `auto/GLM-5.3-Flash` → `glm-5.3-flash`). Parsed defensively from
   * the adapter's private replay envelope, so it is absent whenever the
   * adapter reports none or its shape is unrecognized; the routed `model`
   * stays the billing identity either way. */
  responseModel?: string
  /** Token buckets; omitted when the provider reported no usage at all. */
  usage?: UsageFields
  /** Record origin; absent means a plain request (legacy rows predate the
   * key, so the on-disk default is omission, never `'request'`). */
  kind?: UsageRecordKind
  /** Auxiliary row only: which bypass call produced it. Absent on every
   * other kind; a future unknown value normalizes to `'other'` on read. */
  auxKind?: AuxKind
  /** Failure row (or refused billed auxiliary row) only: the provider-neutral
   * `LlmFailure.code` the attempt failed with (RATE_LIMIT, CONTENT_REFUSED, …).
   * Absent on other rows; a future code renders verbatim. */
  failureCode?: string
  /** Wall time in milliseconds from request dispatch (`step/start`) to message settlement (`assistant/message`). */
  latencyMs?: number
  /** Wall time in milliseconds from request dispatch (`step/start`) to the first non-empty token delta chunk. */
  firstTokenLatencyMs?: number
  /** Provider route key the message's own provenance named
   * (`assistant/message` source.provider). Optional route metadata for
   * switch detection and documented minimum-input rules. Legacy rows may
   * omit it without disabling cache hints. Never part of the
   * dedupe or billing identity. */
  provider?: string
  /** Settled-with-partial-output cancellation: the assistant message was
   * finalized from a mid-stream abort (`assistant/message` `interrupted: true`
   * — the host marks a turn the user cancelled AFTER content was delivered,
   * an acknowledged cancellation, not an unknown interruption). The row
   * keeps its kind/usage (billing facts unchanged); this only lets the
   * request pool show 已取消 instead of 已完成. Absent on legacy rows and
   * on ordinary completions. */
  interrupted?: true
  /** Absolute epoch ms when the request was dispatched (`step/start`), on
   * rows recorded with timing. The start-order anchor for the request pool;
   * absent on legacy rows, failure and compaction rows (they order by
   * `time`). */
  startedAt?: number
  /** Exact waterfall attempt clock, when observed live. Kept separately
   * from the legacy step-level timing so aggregate statistics do not change. */
  attemptTiming?: { startedAt: number; settledAt: number; firstTokenAt?: number }
  /** Plain-request rows only: the compaction events (prune clusters and
   * summaries) that landed since the session's previous plain request —
   * the request pool's tooltip explanation that the host's own
   * rewrite may have disturbed the prefix cache (never a cache verdict).
   * Absent on legacy rows and unattributed requests (same omission
   * philosophy as `kind`); never written on compaction / failure / aux
   * rows. */
  compactionAttribution?: CompactionAttributionItem[]
  /** Web-search rows only: the invocation facts of one recorded `web_search`
   * call. Absent on every other kind; the optional `usage` on the row carries
   * the model-turn tokens when the host reported them. */
  web?: WebCallInfo
}

/** Optional timing figures for one model request. */
export interface RequestTiming {
  /** Wall time in milliseconds from request dispatch (`step/start`) to message settlement (`assistant/message`). */
  latencyMs?: number
  /** Wall time in milliseconds from request dispatch (`step/start`) to the first non-empty token delta chunk. */
  firstTokenLatencyMs?: number
  /** Absolute epoch ms of the request dispatch (`step/start`): the row's
   * start-order anchor, so the pool sorts by when requests BEGAN even after
   * a reload (the row's `time` alone would sort by settlement order). */
  startedAt: number
}

/** Whether a stream chunk carries a non-empty first-token delta. */
export function isTokenDelta(chunk: unknown): boolean {
  if (typeof chunk !== 'object' || chunk === null) return false
  const c = chunk as { type?: string; text?: string; argumentsDelta?: string; name?: string }
  switch (c.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof c.text === 'string' && c.text !== ''
    case 'tool-call-delta':
      return (typeof c.argumentsDelta === 'string' && c.argumentsDelta !== '') || c.name !== undefined
    default:
      return false
  }
}

/**
 * Extract the timestamp of the first token delta from an assistant stream run/chunks array.
 * Mirrors DSH llm assistantStreamFirstTokenTime for durable compact streams.
 */
export function extractFirstTokenTimeFromStream(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (typeof record !== 'object' || record === null) continue
    const r = record as {
      type?: string
      time?: unknown
      time0?: unknown
      dt?: unknown
      texts?: unknown
      args?: unknown
      name?: unknown
      chunk?: unknown
    }
    if (r.type === 'chunk') {
      if (typeof r.time === 'number' && isTokenDelta(r.chunk)) {
        return r.time
      }
    } else if (r.type === 'tool-call-chunks') {
      if (typeof r.time0 === 'number' && r.name !== undefined) {
        return r.time0
      }
      if (typeof r.time0 === 'number' && Array.isArray(r.args)) {
        let time = r.time0
        for (let i = 0; i < r.args.length; i++) {
          if (i > 0 && Array.isArray(r.dt) && typeof r.dt[i - 1] === 'number') {
            time += r.dt[i - 1] as number
          }
          if (typeof r.args[i] === 'string' && r.args[i] !== '') return time
        }
      }
    } else if (r.type === 'text-chunks' || r.type === 'reasoning-chunks') {
      if (typeof r.time0 === 'number' && Array.isArray(r.texts)) {
        let time = r.time0
        for (let i = 0; i < r.texts.length; i++) {
          if (i > 0 && Array.isArray(r.dt) && typeof r.dt[i - 1] === 'number') {
            time += r.dt[i - 1] as number
          }
          if (typeof r.texts[i] === 'string' && r.texts[i] !== '') return time
        }
      }
    }
  }
  return undefined
}

/**
 * Extract the last valid provider usage chunk embedded in a compact assistant
 * stream (`assistant/attempt` / `assistant/message` `stream`). Used to retain
 * billed tokens emitted before a failure settlement (such as `CONTENT_REFUSED`).
 */
export function extractUsageFromStream(stream: unknown): UsageFields | undefined {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (typeof record !== 'object' || record === null) continue
    const r = record as { type?: unknown; chunk?: unknown }
    if (r.type !== 'chunk' || typeof r.chunk !== 'object' || r.chunk === null) continue
    const chunk = r.chunk as { type?: unknown; usage?: unknown }
    if (chunk.type !== 'usage') continue
    const projected = projectUsage(chunk.usage as TokenUsage | undefined)
    if (projected !== undefined) return projected
  }
  return undefined
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Project the event's optional provider usage into the four base buckets.
 * A missing record or an invalid required bucket renders the whole usage
 * absent: the row still records the request, but its numbers are not trusted.
 */
export function projectUsage(usage: TokenUsage | undefined): UsageFields | undefined {
  if (usage === undefined) return undefined
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(isCount(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(isCount(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  }
}

/**
 * The provider-reported model of one settled response, read defensively from
 * the adapter's private replay envelope (`finish` chunk / assistant source).
 * Only the known pi-ai shape (`kind: 'pi-ai'`, `version: 2`) is interpreted:
 * its optional `responseModel` is the model id the provider's own response
 * named, which a routed alias may differ from. Every other envelope —
 * including the official deepseek-messages shape, which carries no response
 * model — reads as absent rather than guessed.
 * @param replayState - the opaque `ReplayEnvelope`, straight off the wire.
 * @returns the reported model id, or undefined when absent/unrecognized.
 */
export function responseModelOfReplay(replayState: unknown): string | undefined {
  if (typeof replayState !== 'object' || replayState === null) return undefined
  const envelope = replayState as Record<string, unknown>
  const response = envelope['response']
  if (typeof response !== 'object' || response === null) return undefined
  const body = response as Record<string, unknown>
  if (body['kind'] !== 'pi-ai' || body['version'] !== 2) return undefined
  const model = body['responseModel']
  return typeof model === 'string' && model !== '' ? model : undefined
}

/**
 * The model name every consumer side (pricing resolution, canonical folding,
 * display grouping) reads off a record: the provider-reported response model
 * when the adapter named one, the routed request name otherwise. The response
 * id usually matches the pricing feed directly, so the alias chain resolves
 * fewer guesses; rows without the field (older logs, adapters without a
 * reported model) behave exactly as before.
 * @param record - one usage record.
 * @returns the name to resolve, fold, and display under ('' stays '' — an
 * unattributed failure row keeps staying out of the model dimensions).
 */
export function effectiveModelOf(record: Pick<UsageRecord, 'model' | 'responseModel'>): string {
  return record.responseModel ?? record.model
}

/** Build the log row for one assistant/message session event. */
export function recordFromEvent(
  event: SessionEvent<'assistant/message'>,
  sessionId: string,
  timing?: RequestTiming,
): UsageRecord {
  const usage = projectUsage(event.data.usage)
  const latency = isCount(timing?.latencyMs) ? { latencyMs: timing.latencyMs } : {}
  const firstToken = isCount(timing?.firstTokenLatencyMs) ? { firstTokenLatencyMs: timing.firstTokenLatencyMs } : {}
  const responseModel = responseModelOfReplay(event.data.message.source.replayState)
  const provider = event.data.message.source.provider !== ''
    ? { provider: event.data.message.source.provider } : {}
  const interrupted = event.data.interrupted === true ? { interrupted: true as const } : {}
  const started = isCount(timing?.startedAt) ? { startedAt: timing.startedAt } : {}
  return {
    requestId: event.data.message.id,
    time: event.time,
    sessionId,
    model: event.data.message.source.model,
    ...(usage !== undefined ? { usage } : {}),
    ...(responseModel !== undefined ? { responseModel } : {}),
    ...latency,
    ...firstToken,
    ...started,
    ...provider,
    ...interrupted,
  }
}

/**
 * Build the log row for one `compaction/summary` session event — the
 * summarize provider call that reads the compacted history and writes the
 * summary. The row is billed exactly like a plain request: `model` is the
 * event's summarize model, and the usage buckets are the provider-reported
 * figures for the call. A missing or invalid usage renders the record null:
 * an unusage compaction cannot be priced, and `shadowedTokenCount` (the
 * shadow price of the replaced context) is not a billing figure, so the
 * event is skipped rather than recorded unpriced.
 *
 * The request id is `compaction:<sessionId>:<seq>` — the event's persistent
 * seq is monotonic and unique within the session (the compactionId is an
 * opaque, unvalidated string), so one row lands per compaction and repeated
 * syncs dedupe.
 * @returns the record, or null when the event carries no usable usage.
 */
export function recordFromCompaction(
  event: SessionEvent<'compaction/summary'>,
  sessionId: string,
): UsageRecord | null {
  const usage = projectUsage(event.data.usage)
  if (usage === undefined) return null
  return {
    requestId: `compaction:${sessionId}:${String(event.seq)}`,
    time: event.time,
    sessionId,
    model: event.data.model,
    usage,
    kind: 'compaction',
    // The summarize call names its own route. An empty key is omitted, same
    // as a plain request that never reported one.
    ...routeKey(event.data.provider),
  }
}

/**
 * Read the token figure a host may attach to a search event. Two shapes are
 * accepted because the host owns the web-search event contract: the plugin's
 * own `UsageFields` spelling and the Anthropic Messages `usage` spelling the
 * provider receives from DeepSeek. A value without both input and output
 * counts is not usable and reads as absent — a search whose host reported no
 * usage must stay unmetered instead of becoming a zero-cost row.
 * @param value - an opaque `usage` payload from an event or result meta.
 * @returns the normalised token buckets, or undefined when none is usable.
 */
export function extractWebUsage(value: unknown): UsageFields | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fields = value as Record<string, unknown>
  const count = (key: string): number | undefined =>
    isCount(fields[key]) ? fields[key] as number : undefined
  const input = count('inputTokens') ?? count('input_tokens')
  const output = count('outputTokens') ?? count('output_tokens')
  if (input === undefined || output === undefined) return undefined
  const cacheRead = count('cacheReadTokens') ?? count('cache_read_input_tokens')
  const cacheWrite = count('cacheWriteTokens') ?? count('cache_creation_input_tokens')
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/** Input of one web-search row emitted when a `web_search` tool call settles. */
export interface WebCallRecordInput {
  sessionId: string
  /** Settlement wall time (the `tool/result` event time). */
  time: number
  /** Settlement event seq: unique within the session, so repeated syncs dedupe. */
  seq: number
  tool: string
  callId: string
  queryCount?: number
  rounds?: number
  failed?: boolean
  errorCode?: string
  durationMs?: number
  /** Model that served the searched rounds, when the host named one. */
  model?: string
  /** Reported token figures of all rounds the call triggered, when any. */
  usage?: UsageFields
}

/**
 * Build the log row for one settled `web_search` tool call. The request id is
 * `web:<sessionId>:<seq>` — the settlement event's persistent seq, so a
 * repeated sync dedupes and history backfill is reproducible. Invocation
 * facts live under `web`; token figures stay in the ordinary `usage` field
 * only when the host reported them, so a backend that bills per search keeps
 * a truthful unmetered row instead of a fabricated one.
 * @param input - the settled call's facts.
 * @returns the row to append.
 */
export function recordFromWebCall(input: WebCallRecordInput): UsageRecord {
  const queryCount = isCount(input.queryCount) && input.queryCount > 0 ? Math.floor(input.queryCount) : undefined
  const rounds = isCount(input.rounds) && input.rounds > 0 ? Math.floor(input.rounds) : undefined
  const duration = isCount(input.durationMs) && input.durationMs >= 0
    ? { durationMs: Math.floor(input.durationMs) } : {}
  return {
    requestId: `web:${input.sessionId}:${String(input.seq)}`,
    time: input.time,
    sessionId: input.sessionId,
    model: input.model ?? '',
    kind: 'web',
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    web: {
      tool: input.tool,
      callId: input.callId,
      ...(queryCount !== undefined ? { queryCount } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
      ...(input.failed === true ? { failed: true as const } : {}),
      ...(input.errorCode !== undefined && input.errorCode !== '' ? { errorCode: input.errorCode } : {}),
      ...duration,
    },
  }
}

/** One JSONL line without the trailing newline. */
export function serializeRecord(record: UsageRecord): string {
  return JSON.stringify(record)
}

/**
 * Build the log row for one failed provider attempt. Shared by a terminal
 * `turn/end` error and an `llm/retry` (a failed attempt that the retry
 * plugin then scheduled another try for). The request id is
 * `failure:<sessionId>:<seq>` — the event's persistent seq is monotonic
 * and unique within the session, so the two sources never collide and
 * repeated syncs dedupe.
 */
function failureRow(
  event: { seq: number; time: number },
  sessionId: string,
  model: string,
  code: string | undefined,
  provider: string | undefined,
  usage?: UsageFields,
): UsageRecord {
  const projected = projectUsage(usage)
  return {
    requestId: `failure:${sessionId}:${String(event.seq)}`,
    time: event.time,
    sessionId,
    model,
    kind: 'failure',
    // The classifier always names a code (an unclassified throw flattens to
    // 'UNKNOWN'); keep the row honest even if a future event omits it.
    ...(code !== undefined && code !== '' ? { failureCode: code } : {}),
    ...routeKey(provider),
    ...(projected !== undefined ? { usage: projected } : {}),
  }
}

/** Omit an empty route key. The field is never stored as `""`. */
function routeKey(provider: string | undefined): { provider: string } | Record<string, never> {
  return provider !== undefined && provider !== '' ? { provider } : {}
}

/**
 * Build the log row for one `turn/end` session event whose reason is an LLM
 * error — the terminal failed model request of a turn. Only
 * `reason.kind === 'error'` counts: an aborted turn was cancelled by the
 * user/parent (not a provider failure), `max-tokens` truncated a request
 * that otherwise succeeded, and `blocked`/`interrupted` never reached the
 * provider. Intermediate attempts that `dsh-llm-retry` recovered are
 * recorded separately via {@link recordFromRetry}. The row carries no
 * usage (a failed call bills nothing), the `model` the caller tracked for
 * the session's route — `turn/end` itself names no model, so the recorder
 * follows `request/context` / `assistant/message` events to keep one
 * last-known model id per session — and the provider-neutral
 * `failureCode` (the `LlmFailure.code`, e.g. RATE_LIMIT / TRANSPORT /
 * QUOTA) the failure classifier assigned. `turn/end` names no route
 * either, so `provider` is the same walk's last-known route key (empty
 * when none was observed — the field is then omitted, never guessed).
 * @returns the record, or null when the turn ended for a non-error reason.
 */
export function recordFromTurnEnd(
  event: SessionEvent<'turn/end'>,
  sessionId: string,
  model: string,
  provider = '',
  usage?: UsageFields,
): UsageRecord | null {
  if (event.data.reason.kind !== 'error') return null
  return failureRow(event, sessionId, model, event.data.reason.error.code, provider, usage)
}

/**
 * Build the log row for one `llm/retry` session event — a provider attempt
 * that failed and that `dsh-llm-retry` scheduled another try for. Every
 * such event is a real failed call (the plugin writes it before the wait,
 * so a later cancel during backoff still counts the original attempt).
 * The row carries optional billed usage when the attempt emitted one before
 * failing; `model` is the session's last-known route
 * (the event names the provider, not the model); the route key is this
 * attempt's own `data.provider`, not the session's last-known route.
 * `failureCode` is the `LlmFailure.code` on the payload.
 * `llm/retry-started` is the wait-complete marker and is not a failure —
 * the caller ignores it.
 */
export function recordFromRetry(
  event: SessionEvent<'llm/retry'>,
  sessionId: string,
  model: string,
  usage?: UsageFields,
): UsageRecord {
  return failureRow(event, sessionId, model, event.data.failure.code, event.data.provider, usage)
}

/**
 * Route key the experimental `@deepseek-ai/dsh-deepseek-chat-import` plugin
 * writes as both `provider` and `model` on every imported assistant message
 * (upstream `IMPORTED_MODEL_SOURCE`). Mirrored here because the plugin is not
 * a dependency of this package.
 */
export const IMPORTED_CHAT_EXPORT_PROVIDER = 'deepseek-chat-export'

/**
 * Failure-code prefix of the `turn/end` errors the same importer writes for
 * exported replies it excludes from model history (no reply, unfinished
 * status, server template, empty reply). These turns never reached a provider.
 */
export const IMPORTED_CHAT_EXPORT_FAILURE_PREFIX = 'DEEPSEEK_EXPORT_'

/**
 * Whether one session event is conversation history the DeepSeek chat
 * importer synthesized rather than a provider call: an imported
 * `assistant/message` (the importer's route key with no usage) or a
 * `turn/end` error carrying an importer failure code. Such events never
 * become log rows and never reveal the session's route. A later turn the
 * user runs on an imported session names a real route and records normally.
 * @param event - one session event.
 * @returns true for importer-synthesized history.
 */
export function isImportedHistoryEvent(event: SessionEvent): boolean {
  if (event.type === 'assistant/message') {
    return event.data.message.source.provider === IMPORTED_CHAT_EXPORT_PROVIDER
      && projectUsage(event.data.usage) === undefined
  }
  if (event.type === 'turn/end') {
    return event.data.reason.kind === 'error'
      && event.data.reason.error.code.startsWith(IMPORTED_CHAT_EXPORT_FAILURE_PREFIX)
  }
  return false
}

/**
 * Project one session event into a log row, or null when the event is not
 * a recorded origin (including history the DeepSeek chat importer
 * synthesized, see {@link isImportedHistoryEvent}). Live listening and
 * history sync share this so a new origin cannot land on only one path.
 * `lastModel` is the session's last
 * known model and `lastProvider` its last known route key (a `turn/end`
 * error names neither; compaction and `llm/retry` carry their own route
 * on the event). Compaction recording follows the same `recordCompaction`
 * switch both callers take.
 */
export function recordOfEvent(
  event: SessionEvent,
  sessionId: string,
  lastModel: string,
  recordCompaction = true,
  timing?: RequestTiming,
  lastProvider = '',
  failureUsage?: UsageFields,
): UsageRecord | null {
  if (isImportedHistoryEvent(event)) return null
  switch (event.type) {
    case 'assistant/message':
      return recordFromEvent(event, sessionId, timing)
    case 'compaction/summary':
      return recordCompaction ? recordFromCompaction(event, sessionId) : null
    case 'turn/end':
      return recordFromTurnEnd(event, sessionId, lastModel, lastProvider, failureUsage)
    case 'llm/retry':
      return recordFromRetry(event, sessionId, lastModel, failureUsage)
    default:
      return null
  }
}

function headerConfigOf(event: SessionEvent): { model?: unknown; provider?: unknown } | undefined {
  if (event.type !== 'request/header') return undefined
  const data = event.data as { header?: { config?: { model?: unknown; provider?: unknown } } } | undefined
  return data?.header?.config
}

/**
 * The model id an event reveals about the session's current route, when it
 * does: `request/header` establishes the call config at the start of an epoch
 * or fork resume, `request/context` announces route changes before dispatch
 * (it logs only on change), and `assistant/message` confirms the model that
 * actually produced a message. All three fold into the same last-known value,
 * so a turn that ends in an error can still attribute its failure row to a model.
 * An imported DeepSeek chat message reveals nothing: its route key is not a model.
 */
export function modelOfEvent(event: SessionEvent): string | undefined {
  if (event.type === 'request/context') return event.data.model
  if (event.type === 'assistant/message') {
    return isImportedHistoryEvent(event) ? undefined : event.data.message.source.model
  }
  return nonEmpty(headerConfigOf(event)?.model)
}

/**
 * The route key an event reveals about the session's current route, when
 * it does. Same sources as {@link modelOfEvent}: `request/header`,
 * `request/context`, and `assistant/message`. An empty key reveals
 * nothing — it must not wipe a route already known. Compaction and
 * `llm/retry` name their own route on the row, but they do not move this
 * last-known value; a later `turn/end` keeps following the request route.
 * An imported DeepSeek chat message reveals nothing, same as in {@link modelOfEvent}.
 */
export function providerOfEvent(event: SessionEvent): string | undefined {
  if (event.type === 'request/context') return nonEmpty(event.data.provider)
  if (event.type === 'assistant/message') {
    return isImportedHistoryEvent(event) ? undefined : nonEmpty(event.data.message.source.provider)
  }
  return nonEmpty(headerConfigOf(event)?.provider)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function normalizeCount(value: unknown): number | undefined {
  return isCount(value) ? value : undefined
}

/** Whether a raw value names a known auxiliary kind. */
function isAuxKind(value: unknown): value is AuxKind {
  return typeof value === 'string' && (AUX_KINDS as readonly string[]).includes(value)
}

/** Read one stored auxiliary kind, falling back to the defensive bucket. */
function normalizeAuxKind(value: unknown): AuxKind {
  return isAuxKind(value) ? value : 'other'
}

/**
 * Read one stored web-call descriptor. A malformed descriptor drops only the
 * optional facts — the row itself still reads as a web row, so format drift
 * never turns a search into a billed request.
 */
function normalizeWebCall(value: unknown): { web: WebCallInfo } | Record<string, never> {
  if (typeof value !== 'object' || value === null) return {}
  const fields = value as Record<string, unknown>
  const tool = typeof fields.tool === 'string' && fields.tool !== '' ? fields.tool : undefined
  const callId = typeof fields.callId === 'string' ? fields.callId : undefined
  if (tool === undefined || callId === undefined) return {}
  const queryCount = isNonNegativeCount(fields.queryCount) && fields.queryCount > 0 ? Math.floor(fields.queryCount) : undefined
  const rounds = isNonNegativeCount(fields.rounds) && fields.rounds > 0 ? Math.floor(fields.rounds) : undefined
  const duration = isNonNegativeCount(fields.durationMs) ? { durationMs: fields.durationMs } : {}
  return {
    web: {
      tool,
      callId,
      ...(queryCount !== undefined ? { queryCount } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
      ...(fields.failed === true ? { failed: true as const } : {}),
      ...(typeof fields.errorCode === 'string' && fields.errorCode !== '' ? { errorCode: fields.errorCode } : {}),
      ...duration,
    },
  }
}

/** Whether a raw value is a trustworthy non-negative finite count. */
function isNonNegativeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Read one stored compaction attribution: display-side evidence only, so a
 * malformed entry drops individually (never the whole row) — a wrong `kind`,
 * a non-positive count, or a negative shadow figure is omitted, and an empty
 * survivor set reads as unattributed. Legacy rows without the field stay
 * unattributed without being rewritten.
 */
function normalizeAttribution(value: unknown): { compactionAttribution: CompactionAttributionItem[] } | Record<string, never> {
  if (!Array.isArray(value)) return {}
  const items: CompactionAttributionItem[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    if (item['kind'] !== 'prune' && item['kind'] !== 'summary') continue
    const count = item['count']
    const shadowedTokenCount = item['shadowedTokenCount']
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) continue
    if (!isNonNegativeCount(shadowedTokenCount)) continue
    items.push({ kind: item['kind'], count, shadowedTokenCount })
  }
  return items.length > 0 ? { compactionAttribution: items } : {}
}

function isUsageFields(value: unknown): value is UsageFields {
  if (typeof value !== 'object' || value === null) return false
  const fields = value as Record<string, unknown>
  return isCount(fields.inputTokens) && isCount(fields.outputTokens)
}

function isRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.requestId === 'string'
    && isCount(record.time)
    && typeof record.sessionId === 'string'
    && typeof record.model === 'string'
    && (record.responseModel === undefined || record.responseModel === null || typeof record.responseModel === 'string')
    && (record.usage === undefined || record.usage === null || isUsageFields(record.usage))
}

/**
 * Coerce an unknown value into a record, normalizing extra fields and null
 * buckets to omission, so rows written by older field sets still dedupe
 * (their request id is absorbed) without being rewritten.
 * @returns the record, or null when the value is not a valid row.
 */
export function coerceRecord(value: unknown): UsageRecord | null {
  if (!isRecord(value)) return null
  // The guard already validated the structure; this cast only enables field access.
  const record = value as unknown as Record<string, unknown>
  // Kind normalization: only a compaction, failure, auxiliary, or web row
  // keeps the key — plain rows (and unknown future kinds) read as requests,
  // so a newer row set never drops. A stored auxiliary row without a
  // recognized `auxKind` normalizes to `other` instead of losing the row.
  const isFailure = record.kind === 'failure'
  const isAux = !isFailure && record.kind === 'aux'
  const isWeb = record.kind === 'web'
  const kind = record.kind === 'compaction' ? { kind: 'compaction' as const }
    : isFailure ? { kind: 'failure' as const }
      : isAux ? { kind: 'aux' as const }
        : isWeb ? { kind: 'web' as const }
          : {}
  const auxKind = isAux ? { auxKind: normalizeAuxKind(record.auxKind) } : {}
  const web = isWeb ? normalizeWebCall(record.web) : {}
  // Failure classification survives the round trip on failure rows and refused
  // auxiliary rows (a non-string or foreign-kind code normalizes to omission).
  const failureCode = (isFailure || isAux) && typeof record.failureCode === 'string' && record.failureCode !== ''
    ? { failureCode: record.failureCode } : {}
  const latency = isCount(record.latencyMs) ? { latencyMs: record.latencyMs } : {}
  const firstToken = isCount(record.firstTokenLatencyMs) ? { firstTokenLatencyMs: record.firstTokenLatencyMs } : {}
  // The response model survives the round trip on any row kind: it is
  // display-side metadata only, never part of the dedupe or billing identity.
  const responseModel = typeof record.responseModel === 'string' && record.responseModel !== ''
    ? { responseModel: record.responseModel } : {}
  // The request-pool evidence fields round-trip the same way (display-side
  // only): the provider route key and the interrupted-cancellation hint.
  // The cache-read evidence needs no extra flag — the bucket's own presence
  // inside `usage` IS the report (a 0 survives projection as 0).
  const provider = typeof record.provider === 'string' && record.provider !== ''
    ? { provider: record.provider } : {}
  const interrupted = record.interrupted === true ? { interrupted: true as const } : {}
  const startedAt = isCount(record.startedAt) ? { startedAt: record.startedAt } : {}
  const clock = record.attemptTiming as Record<string, unknown> | undefined
  const attemptTiming = typeof clock === 'object' && clock !== null
    && isCount(clock.startedAt) && isCount(clock.settledAt) && clock.settledAt >= clock.startedAt
    ? { attemptTiming: {
        startedAt: clock.startedAt,
        settledAt: clock.settledAt,
        ...(isCount(clock.firstTokenAt) && clock.firstTokenAt >= clock.startedAt && clock.firstTokenAt <= clock.settledAt
          ? { firstTokenAt: clock.firstTokenAt } : {}),
      } }
    : {}
  const attribution = normalizeAttribution(record.compactionAttribution)
  if (record.usage === undefined || record.usage === null) {
    return {
      requestId: record.requestId as string,
      time: record.time as number,
      sessionId: record.sessionId as string,
      model: record.model as string,
      ...kind,
      ...auxKind,
      ...web,
      ...failureCode,
      ...latency,
      ...firstToken,
      ...startedAt,
      ...attemptTiming,
      ...attribution,
      ...responseModel,
      ...provider,
      ...interrupted,
    }
  }
  const fields = record.usage as Record<string, unknown>
  const cacheRead = normalizeCount(fields.cacheReadTokens)
  const cacheWrite = normalizeCount(fields.cacheWriteTokens)
  return {
    requestId: record.requestId as string,
    time: record.time as number,
    sessionId: record.sessionId as string,
    model: record.model as string,
    ...kind,
    ...auxKind,
    ...web,
    ...failureCode,
    ...latency,
    ...firstToken,
    ...startedAt,
    ...attemptTiming,
    ...attribution,
    ...responseModel,
    ...provider,
    ...interrupted,
    usage: {
      inputTokens: fields.inputTokens as number,
      outputTokens: fields.outputTokens as number,
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    },
  }
}

/**
 * Parse one JSONL line back into a record. Extra fields are ignored and null
 * buckets are normalized to omission (see {@link coerceRecord}).
 * @returns the record, or null when the line is not a valid row.
 */
export function parseRecord(line: string): UsageRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    // JSON.parse throws SyntaxError on malformed lines; the caller skips the line.
    return null
  }
  return coerceRecord(value)
}
