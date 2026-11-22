/**
 * Auxiliary (bypass) model requests of the token-usage plugin: classification
 * and record projection for provider calls that are NOT part of a
 * conversation turn — the Auto review authorization gate, session-title
 * generation, timeline report synthesis, and reasoning translation. Those
 * calls are issued through `ctx.llm.stream()` by their owning host packages
 * and do not produce an `assistant/message` usage event, so the plugin
 * records them on the `llm/stream` waterfall every streaming call passes
 * through (see `LlmRuntime.stream`).
 *
 * Classification never relies on host exports that older DSH builds may not
 * ship: declared purposes (`LlmRequestPurposeMap`) take precedence
 * (`compaction` is excluded because `compaction/summary` logs it;
 * `session-title`, `auto-review`, and `timeline-report` map directly, and
 * any unrecognized `purpose` falls into `other` even when carrying a
 * `sessionId`), while older unmarked Auto review and translator calls fall
 * back to their fixed system prompt prefixes. Ordinary conversation-loop
 * requests carry a `sessionId` with `purpose === undefined`.
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
  // Widen from the imported DSH version's `purpose` union so keys declared by
  // newer/optional producer packages (LlmRequestPurposeMap) typecheck cleanly
  // without casts across host versions.
  const purpose: string | undefined = options.purpose
  // Compaction summaries are already recorded from `compaction/summary`.
  if (purpose === 'compaction') return undefined
  if (purpose === 'session-title') return 'session-title'
  if (purpose === 'auto-review') return 'auto-review'
  if (purpose === 'timeline-report') return 'timeline-report'
  // Ordinary conversation requests never set `purpose`; any unrecognized
  // purpose value belongs to a host auxiliary producer and should land in
  // `other` rather than be dropped as a conversation request.
  if (purpose !== undefined) return 'other'
  // Legacy Auto-review hosts omitted `purpose` (and sometimes `sessionId`);
  // the fixed policy prompt remains authoritative fallback.
  const system = options.system
  if (typeof system === 'string' && system.startsWith(AUTO_REVIEW_PROMPT_PREFIX)) return 'auto-review'
  // Every conversation-loop request is marked with the session it serves
  // (dsh-agent-loop freezes `sessionId` into its request) and leaves
  // `purpose` absent; the loop records the call through `assistant/message`.
  if (options.sessionId !== undefined) return undefined
  if (typeof system === 'string') {
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
  /** Owning session when the host stamped one (session-title, auto-review,
   * and session-scoped timeline-report calls; older or global bypass calls
   * stay empty). */
  sessionId?: string
  /** Provider model id the bypass call routed to. */
  model: string
  /** Provider-reported model id of the response body, when the adapter's
   * replay envelope named one (see {@link responseModelOfReplay}); the
   * routed `model` stays the billing identity either way. */
  responseModel?: string
  /** Provider-reported usage, when the stream delivered a usage chunk. */
  usage?: TokenUsage
  /** Route key of this bypass call (`options.provider`). Empty is omitted.
   * Historical auxiliary rows cannot be backfilled: they never landed in
   * the session log. */
  provider?: string
}

/**
 * Build the log row for one settled auxiliary model request. The row carries
 * `kind: 'aux'`; when the host supplies a session owner, that id is retained
 * so per-session views can include the attributable running overhead. Legacy
 * unowned bypass calls keep an empty `sessionId`.
 * @param input - kind, identity, timing, route, and usage of the call.
 * @returns the persistable record (usage omitted when unusable).
 */
export function recordFromAuxRequest(input: AuxRequestRecordInput): UsageRecord {
  const usage = projectUsage(input.usage)
  return {
    requestId: input.requestId,
    time: input.time,
    sessionId: input.sessionId ?? '',
    model: input.model,
    ...(input.responseModel !== undefined ? { responseModel: input.responseModel } : {}),
    ...(usage !== undefined ? { usage } : {}),
    kind: 'aux',
    auxKind: input.auxKind,
    ...(input.provider !== undefined && input.provider !== '' ? { provider: input.provider } : {}),
  }
}
