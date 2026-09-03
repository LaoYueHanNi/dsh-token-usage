/**
 * Pure record vocabulary of the token-usage plugin: the JSONL row type, its
 * projections from session events (assistant messages and compaction
 * summaries), and lenient line parsing for the dedupe scan. No I/O and no
 * runtime imports, so every consumer shares one wire format. Rows stay
 * minimal: request id, model, the four base token buckets, time, session id,
 * and the optional origin kind — absent optional buckets are omitted, never
 * null.
 *
 * @module token-usage/usage-record
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Provider-reported token buckets; absent optional buckets are omitted. */
export interface UsageFields {
    /** Uncached input tokens (billed input = this + cacheRead + cacheWrite). */
    inputTokens: number;
    /** Output tokens. */
    outputTokens: number;
    /** Cache-hit input tokens; omitted when the provider reported none. */
    cacheReadTokens?: number;
    /** Cache-write input tokens; omitted when the provider reported none. */
    cacheWriteTokens?: number;
}
/**
 * Where a record came from: a plain model request (the default) or a
 * compaction summarize request (a provider-billed call of its own).
 */
export type UsageRecordKind = 'request' | 'compaction';
/** One JSONL row: one successful model request. */
export interface UsageRecord {
    /** Stable request identity: the assistant message id (dedupe key). */
    requestId: string;
    /** Session-event wall time, epoch milliseconds. */
    time: number;
    /** Owning session id. */
    sessionId: string;
    /** Provider model id that produced the message. */
    model: string;
    /** Token buckets; omitted when the provider reported no usage at all. */
    usage?: UsageFields;
    /** Record origin; absent means a plain request (legacy rows predate the
     * key, so the on-disk default is omission, never `'request'`). */
    kind?: UsageRecordKind;
}
/**
 * Project the event's optional provider usage into the four base buckets.
 * A missing record or an invalid required bucket renders the whole usage
 * absent: the row still records the request, but its numbers are not trusted.
 */
export declare function projectUsage(usage: TokenUsage | undefined): UsageFields | undefined;
/** Build the log row for one assistant/message session event. */
export declare function recordFromEvent(event: SessionEvent<'assistant/message'>, sessionId: string): UsageRecord;
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
export declare function recordFromCompaction(event: SessionEvent<'compaction/summary'>, sessionId: string): UsageRecord | null;
/** One JSONL line without the trailing newline. */
export declare function serializeRecord(record: UsageRecord): string;
/**
 * Coerce an unknown value into a record, normalizing extra fields and null
 * buckets to omission, so rows written by older field sets still dedupe
 * (their request id is absorbed) without being rewritten.
 * @returns the record, or null when the value is not a valid row.
 */
export declare function coerceRecord(value: unknown): UsageRecord | null;
/**
 * Parse one JSONL line back into a record. Extra fields are ignored and null
 * buckets are normalized to omission (see {@link coerceRecord}).
 * @returns the record, or null when the line is not a valid row.
 */
export declare function parseRecord(line: string): UsageRecord | null;
//# sourceMappingURL=usage-record.d.ts.map