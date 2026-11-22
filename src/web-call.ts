/**
 * Pairing state machine of the web-tools dimension. One tracker observes one
 * session's own events and turns each settled `web_search` or `web_fetch`
 * tool call into one log row:
 *
 * - `tool/call` opens a draft (tool, call id, dispatch time, plus search
 *   queries for `web_search`);
 * - `web/deepseek-search-llm-request` marks one model round of an open
 *   `web_search` call and contributes the round's token figure when the host
 *   ever reports one (current hosts record only the request body, so it
 *   usually does not);
 * - `tool/result` closes the draft and yields the row.
 *
 * The live recorder and the history sync share this class, so both paths
 * produce identical rows and a backfill is reproducible. Inherited fork
 * prefixes never reach a tracker: the live path filters them out and the sync
 * path reads only the session's own event slice.
 *
 * @module token-usage/web-call
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  extractWebUsage,
  isWebTool,
  recordFromWebCall,
  WEB_SEARCH_TOOL,
  type UsageFields,
  type UsageRecord,
  type WebTool,
} from './usage-record.ts'

/** Event the DeepSeek official search provider appends before each model round. */
export const WEB_SEARCH_LLM_REQUEST_EVENT = 'web/deepseek-search-llm-request'

/** Prefix the provider puts in the recorded Messages request before the query. */
const SEARCH_PROMPT_PREFIX = 'Perform a web search for the query: '

/** One draft call, open between its `tool/call` and its `tool/result`. */
interface WebCallDraft {
  tool: WebTool
  callId: string
  time: number
  queries?: string[]
  rounds: number
  model?: string
  usage?: UsageFields
}

/** The raw event shape: the host-owned search event is not in `SessionEventMap`. */
interface RawSessionEvent {
  type: string
  seq: number
  time: number
  data?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the submitted queries from a `tool/call` argument payload. Both host
 * generations are accepted: the current `{ queries: [...] }` and the older
 * `{ query }` the pre-0.2.2 tool sent.
 */
function queriesOf(args: unknown): string[] | undefined {
  let value = args
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown } catch { return undefined }
  }
  const fields = asRecord(value)
  if (fields === undefined) return undefined
  if (Array.isArray(fields['queries'])) {
    const queries = fields['queries'].filter(
      (query): query is string => typeof query === 'string' && query.trim().length > 0,
    )
    return queries.length > 0 ? queries : undefined
  }
  const query = fields['query']
  return typeof query === 'string' && query.trim().length > 0 ? [query] : undefined
}

/** Read the query out of one recorded search model request. */
function queryOfRequestBody(body: Record<string, unknown> | undefined): string | undefined {
  const messages = body?.['messages']
  if (!Array.isArray(messages)) return undefined
  const content = asRecord(messages[0])?.['content']
  if (!Array.isArray(content)) return undefined
  const text = asRecord(content[0])?.['text']
  if (typeof text !== 'string') return undefined
  return text.startsWith(SEARCH_PROMPT_PREFIX) ? text.slice(SEARCH_PROMPT_PREFIX.length) : text
}

/** Add two optional token figures bucket by bucket. */
function mergeUsage(left: UsageFields | undefined, right: UsageFields): UsageFields {
  if (left === undefined) return right
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(left.cacheReadTokens !== undefined || right.cacheReadTokens !== undefined
      ? { cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0) } : {}),
    ...(left.cacheWriteTokens !== undefined || right.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0) } : {}),
  }
}

/** The tool-call id a `tool/result` message answers, across host generations. */
function resultCallId(message: Record<string, unknown> | undefined): string | undefined {
  const direct = message?.['toolCallId']
  if (typeof direct === 'string' && direct !== '') return direct
  const source = asRecord(message?.['source'])
  const nested = source?.['callId']
  return typeof nested === 'string' && nested !== '' ? nested : undefined
}

/**
 * Per-session web-search recorder. Feed it every own session event in order;
 * it returns a row exactly when a recorded `web_search` call settles.
 */
export class WebCallTracker {
  private readonly drafts = new Map<string, WebCallDraft>()

  /**
   * @param sessionId - the owning session, stamped onto every emitted row.
   */
  constructor(private readonly sessionId: string) {}

  /**
   * Observe one session event.
   * @param event - the next own event of this session.
   * @returns the settled call's row, or null when the event is not a
   *   settlement of a recorded search.
   */
  observe(event: SessionEvent): UsageRecord | null {
    const raw = event as unknown as RawSessionEvent
    if (raw.type === 'tool/call') {
      this.openCall(raw)
      return null
    }
    if (raw.type === WEB_SEARCH_LLM_REQUEST_EVENT) {
      this.noteModelRound(raw)
      return null
    }
    if (raw.type === 'tool/result') return this.closeCall(raw)
    // A turn boundary closes drafts no result ever reported. The host writes a
    // synthetic result for remembered calls before ending the turn, so a draft
    // surviving to here was interrupted without a durable outcome: it stays
    // out of the ledger rather than fabricating a row.
    if (raw.type === 'turn/end') this.drafts.clear()
    return null
  }

  /** Drop every open draft (used when a session ends or a sync walk aborts). */
  clear(): void {
    this.drafts.clear()
  }

  private openCall(raw: RawSessionEvent): void {
    const data = asRecord(raw.data)
    const tool = data?.['name']
    if (!isWebTool(tool)) return
    const callId = data?.['callId']
    if (typeof callId !== 'string' || callId === '') return
    const queries = tool === WEB_SEARCH_TOOL ? queriesOf(data?.['arguments']) : undefined
    this.drafts.set(callId, {
      tool,
      callId,
      time: raw.time,
      ...(queries !== undefined ? { queries } : {}),
      rounds: 0,
    })
  }

  private noteModelRound(raw: RawSessionEvent): void {
    const data = asRecord(raw.data)
    const body = asRecord(data?.['body'])
    const draft = this.matchDraft(queryOfRequestBody(body))
    if (draft === undefined) return
    draft.rounds += 1
    const model = body?.['model']
    if (draft.model === undefined && typeof model === 'string' && model !== '') draft.model = model
    // The host currently records only the request body; a future host that
    // attaches the response usage (on the event or its body) is picked up here.
    const usage = extractWebUsage(data?.['usage']) ?? extractWebUsage(body?.['usage'])
    if (usage !== undefined) draft.usage = mergeUsage(draft.usage, usage)
  }

  /**
   * Find the call a model round belongs to. A query match wins (the recorded
   * request carries the query verbatim); without a usable query, the newest
   * open draft is the only defensible guess.
   */
  private matchDraft(query: string | undefined): WebCallDraft | undefined {
    let newest: WebCallDraft | undefined
    let matched: WebCallDraft | undefined
    for (const draft of this.drafts.values()) {
      if (draft.tool !== WEB_SEARCH_TOOL) continue
      if (newest === undefined || draft.time >= newest.time) newest = draft
      if (query !== undefined && draft.queries?.includes(query) === true
        && (matched === undefined || draft.time >= matched.time)) {
        matched = draft
      }
    }
    return matched ?? newest
  }

  private closeCall(raw: RawSessionEvent): UsageRecord | null {
    const data = asRecord(raw.data)
    const message = asRecord(data?.['message'])
    const callId = resultCallId(message)
    if (callId === undefined) return null
    const draft = this.drafts.get(callId)
    if (draft === undefined) return null
    this.drafts.delete(callId)
    const error = asRecord(data?.['error'])
    const failed = message?.['isError'] === true
    const errorCode = typeof error?.['code'] === 'string' && error.code !== '' ? error.code : undefined
    // A future host may attach the round's token figure to the result itself
    // (meta is the natural place, `message` a tolerated fallback). Current
    // hosts attach neither, so the row stays unmetered.
    const usage = extractWebUsage(asRecord(data?.['meta'])?.['usage'])
      ?? extractWebUsage(message?.['usage'])
      ?? draft.usage
    return recordFromWebCall({
      sessionId: this.sessionId,
      time: raw.time,
      seq: raw.seq,
      tool: draft.tool,
      callId,
      ...(draft.queries !== undefined ? { queryCount: draft.queries.length } : {}),
      ...(draft.rounds > 0 ? { rounds: draft.rounds } : {}),
      ...(failed ? { failed: true } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(raw.time >= draft.time ? { durationMs: raw.time - draft.time } : {}),
      ...(draft.model !== undefined ? { model: draft.model } : {}),
      ...(usage !== undefined ? { usage } : {}),
    })
  }
}
