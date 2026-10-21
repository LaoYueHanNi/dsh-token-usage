/**
 * Auxiliary (bypass) model requests of the token-usage plugin: classification
 * and record projection for provider calls that are NOT part of a
 * conversation turn — the Auto review authorization gate, session-title
 * generation, and reasoning translation. Those calls are issued through
 * `ctx.llm.stream()` by their owning host packages and never produce a
 * session event, so the plugin records them on the `llm/stream` waterfall
 * every streaming call passes through (see `LlmRuntime.stream`).
 *
 * Classification never relies on host exports that older DSH builds may not
 * ship: the conversation loop always carries a `sessionId`, compaction and
 * title requests carry their `purpose`, and the two remaining bypass callers
 * (Auto review, translator) are recognized by their fixed system prompts.
 * Anything else lands in the defensive `other` bucket rather than being
 * dropped, so a future host feature still shows up in the runtime-overhead
 * totals.
 *
 * @module token-usage/aux-request
 */

import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import { projectUsage, type AuxKind, type UsageRecord } from './usage-record.ts'

/**
 * First word of the Auto review fixed policy (`dsh-experimental-auto-review`
 * sends the REVIEW_POLICY text verbatim as the request's system prompt).
 * The rest of that prompt is prose, so the marker stays the first token.
 */
export const AUTO_REVIEW_PROMPT_PREFIX = 'REVIEW_POLICY'

/**
 * First words of the translator's system prompt
 * (`dsh-experimental-translator` composes `Translate the following text …`).
 */
export const TRANSLATION_PROMPT_PREFIX = 'Translate the following text'

/**
 * Classify one streaming request as an auxiliary (bypass) model call.
 * @param options - the request observed at the `llm/stream` waterfall.
 * @returns the auxiliary kind, or undefined when the request is already
 * covered by a conversation event (agent loop) or the compaction summary
 * (which logs its own `compaction/summary` event carrying usage).
 */
export function classifyAuxRequest(options: GenerateOptions): AuxKind | undefined {
  // Compaction summaries are already recorded from `compaction/summary`.
  if (options.purpose === 'compaction') return undefined
  // Title generation is a bypass call, but its purpose marker is explicit.
  if (options.purpose === 'session-title') return 'session-title'
  // Every conversation-loop request is marked with the session it serves
  // (dsh-agent-loop freezes `sessionId` into its request); the loop records
  // the call through `assistant/message`. A hand-built request without a
  // session is the bypass shape.
  if (options.sessionId !== undefined) return undefined
  const system = options.system
  if (typeof system === 'string') {
    if (system.startsWith(AUTO_REVIEW_PROMPT_PREFIX)) return 'auto-review'
    if (system.startsWith(TRANSLATION_PROMPT_PREFIX)) return 'translation'
  }
  return 'other'
}

/** The facts one settled auxiliary stream contributes to its log row. */
export interface AuxRequestRecordInput {
  /** Which bypass call produced the row. */
  auxKind: AuxKind
  /** Unique `aux:<kind>:<startedAt>:<seq>` identity claimed by the log. */
  requestId: string
  /** Stream-start wall time, epoch milliseconds. */
  time: number
  /** Provider model id the bypass call routed to. */
  model: string
  /** Provider-reported usage, when the stream delivered a usage chunk. */
  usage?: TokenUsage
}

/**
 * Build the log row for one settled auxiliary model request. The row carries
 * `kind: 'aux'` and an empty `sessionId` — a bypass call has no conversation
 * owner, so the per-session dimension must never attribute it to one.
 * @param input - kind, identity, timing, route, and usage of the call.
 * @returns the persistable record (usage omitted when unusable).
 */
export function recordFromAuxRequest(input: AuxRequestRecordInput): UsageRecord {
  const usage = projectUsage(input.usage)
  return {
    requestId: input.requestId,
    time: input.time,
    sessionId: '',
    model: input.model,
    ...(usage !== undefined ? { usage } : {}),
    kind: 'aux',
    auxKind: input.auxKind,
  }
}
