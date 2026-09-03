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
 * compaction summarize request (a provider-billed call of its own), or a
 * failed model request (a turn that ended in an LLM error, or a provider
 * attempt that `dsh-llm-retry` scheduled a retry for — counted in its own
 * `failures` dimension, never in `requests`).
 */
export type UsageRecordKind = 'request' | 'compaction' | 'failure'

/** One JSONL row: one provider model call (successful or failed). */
export interface UsageRecord {
  /** Stable request identity: the assistant message id (dedupe key), or a
   * synthesized `failure:<session>:<seq>` for a failed-request row. */
  requestId: string
  /** Session-event wall time, epoch milliseconds. */
  time: number
  /** Owning session id. */
  sessionId: string
  /** Provider model id that produced the message; a failure row carries the
   * session's last-known route model ('' when none was ever observed). */
  model: string
  /** Token buckets; omitted when the provider reported no usage at all. */
  usage?: UsageFields
  /** Record origin; absent means a plain request (legacy rows predate the
   * key, so the on-disk default is omission, never `'request'`). */
  kind?: UsageRecordKind
  /** Failure row only: the provider-neutral `LlmFailure.code` the attempt
   * failed with (RATE_LIMIT, TRANSPORT, QUOTA, …). Absent on every other
   * kind; a future code renders verbatim. */
  failureCode?: string
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

/** Build the log row for one assistant/message session event. */
export function recordFromEvent(
  event: SessionEvent<'assistant/message'>,
  sessionId: string,
): UsageRecord {
  const usage = projectUsage(event.data.usage)
  return {
    requestId: event.data.message.id,
    time: event.time,
    sessionId,
    model: event.data.message.source.model,
    ...(usage !== undefined ? { usage } : {}),
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
): UsageRecord {
  return {
    requestId: `failure:${sessionId}:${String(event.seq)}`,
    time: event.time,
    sessionId,
    model,
    kind: 'failure',
    // The classifier always names a code (an unclassified throw flattens to
    // 'UNKNOWN'); keep the row honest even if a future event omits it.
    ...(code !== undefined && code !== '' ? { failureCode: code } : {}),
  }
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
 * QUOTA) the failure classifier assigned.
 * @returns the record, or null when the turn ended for a non-error reason.
 */
export function recordFromTurnEnd(
  event: SessionEvent<'turn/end'>,
  sessionId: string,
  model: string,
): UsageRecord | null {
  if (event.data.reason.kind !== 'error') return null
  return failureRow(event, sessionId, model, event.data.reason.error.code)
}

/**
 * Build the log row for one `llm/retry` session event — a provider attempt
 * that failed and that `dsh-llm-retry` scheduled another try for. Every
 * such event is a real failed call (the plugin writes it before the wait,
 * so a later cancel during backoff still counts the original attempt).
 * The row carries no usage; `model` is the session's last-known route
 * (the event names the provider, not the model); `failureCode` is the
 * `LlmFailure.code` on the payload. `llm/retry-started` is the wait-
 * complete marker and is not a failure — the caller ignores it.
 */
export function recordFromRetry(
  event: SessionEvent<'llm/retry'>,
  sessionId: string,
  model: string,
): UsageRecord {
  return failureRow(event, sessionId, model, event.data.failure.code)
}

/**
 * Project one session event into a log row, or null when the event is not
 * a recorded origin. Live listening and history sync share this so a new
 * origin cannot land on only one path. `lastModel` is the session's last
 * known route (failure rows name no model of their own); compaction
 * recording follows the same `recordCompaction` switch both callers take.
 */
export function recordOfEvent(
  event: SessionEvent,
  sessionId: string,
  lastModel: string,
  recordCompaction = true,
): UsageRecord | null {
  switch (event.type) {
    case 'assistant/message':
      return recordFromEvent(event, sessionId)
    case 'compaction/summary':
      return recordCompaction ? recordFromCompaction(event, sessionId) : null
    case 'turn/end':
      return recordFromTurnEnd(event, sessionId, lastModel)
    case 'llm/retry':
      return recordFromRetry(event, sessionId, lastModel)
    default:
      return null
  }
}

/**
 * The model id an event reveals about the session's current route, when it
 * does: `request/context` announces route changes before dispatch (it logs
 * only on change), and `assistant/message` confirms the model that actually
 * produced a message. Both fold into the same last-known value, so a turn
 * that ends in an error can still attribute its failure row to a model.
 */
export function modelOfEvent(event: SessionEvent): string | undefined {
  if (event.type === 'request/context') return event.data.model
  if (event.type === 'assistant/message') return event.data.message.source.model
  return undefined
}

function normalizeCount(value: unknown): number | undefined {
  return isCount(value) ? value : undefined
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
  // Kind normalization: only a compaction or failure row keeps the key —
  // plain rows (and unknown future kinds) read as requests, so a newer row
  // set never drops.
  const isFailure = record.kind === 'failure'
  const kind = record.kind === 'compaction' ? { kind: 'compaction' as const }
    : isFailure ? { kind: 'failure' as const }
      : {}
  // Failure classification survives the round trip on failure rows only
  // (a non-string or foreign-kind code normalizes to omission).
  const failureCode = isFailure && typeof record.failureCode === 'string' && record.failureCode !== ''
    ? { failureCode: record.failureCode } : {}
  if (record.usage === undefined || record.usage === null) {
    return {
      requestId: record.requestId as string,
      time: record.time as number,
      sessionId: record.sessionId as string,
      model: record.model as string,
      ...kind,
      ...failureCode,
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
    ...failureCode,
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
