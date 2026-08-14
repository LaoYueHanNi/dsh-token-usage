/**
 * Pure record vocabulary of the token-usage plugin: the JSONL row type, its
 * projection from a session event, and lenient line parsing for the dedupe
 * scan. No I/O and no runtime imports, so every consumer shares one wire
 * format. Rows stay minimal: request id, model, the four base token buckets,
 * time, and session id — absent optional buckets are omitted, never null.
 *
 * @module token-usage/usage-record
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

/** One JSONL row: one successful model request. */
export interface UsageRecord {
  /** Stable request identity: the assistant message id (dedupe key). */
  requestId: string
  /** Session-event wall time, epoch milliseconds. */
  time: number
  /** Owning session id. */
  sessionId: string
  /** Provider model id that produced the message. */
  model: string
  /** Token buckets; omitted when the provider reported no usage at all. */
  usage?: UsageFields
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

/** One JSONL line without the trailing newline. */
export function serializeRecord(record: UsageRecord): string {
  return JSON.stringify(record)
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
  if (record.usage === undefined || record.usage === null) {
    return {
      requestId: record.requestId as string,
      time: record.time as number,
      sessionId: record.sessionId as string,
      model: record.model as string,
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
