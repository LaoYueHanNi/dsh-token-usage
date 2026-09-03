import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the merged `compaction/*` payload types into the program.
import type {} from '@deepseek-ai/dsh-compaction/types'

/** Minimal but shape-true assistant/message event for unit tests. */
export function messageEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  step?: number
  messageId?: string
  provider?: string
  model?: string
  usage?: SessionEvent<'assistant/message'>['data']['usage']
} = {}): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: overrides.seq ?? 1,
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 2,
      message: {
        id: overrides.messageId ?? 'msg-1',
        role: 'assistant',
        content: [],
        source: {
          kind: 'model',
          provider: overrides.provider ?? 'deepseek',
          model: overrides.model ?? 'deepseek-chat',
        },
      },
      usage: 'usage' in overrides
        ? overrides.usage
        : { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    },
  } as SessionEvent<'assistant/message'>
}

/** Minimal but shape-true compaction/summary event for unit tests. The
 * default usage mirrors a realistic summarize call: a huge input. */
export function compactionEvent(overrides: {
  seq?: number
  time?: number
  compactionId?: string
  provider?: string
  model?: string
  usage?: SessionEvent<'compaction/summary'>['data']['usage']
} = {}): SessionEvent<'compaction/summary'> {
  return {
    type: 'compaction/summary',
    seq: overrides.seq ?? 7,
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      compactionId: overrides.compactionId ?? 'cmp-1',
      summary: [],
      shadowedRange: { start: 1, end: 5 },
      shadowedSeqs: [1, 2, 3, 4, 5],
      shadowedTokenCount: 123_456,
      provider: overrides.provider ?? 'deepseek',
      model: overrides.model ?? 'deepseek-chat',
      rawOutput: [],
      llmStreamCall: true,
      ...('usage' in overrides
        ? overrides.usage === undefined ? {} : { usage: overrides.usage }
        : { usage: { inputTokens: 100_000, outputTokens: 500, cacheReadTokens: 3_000 } }),
    },
  } as SessionEvent<'compaction/summary'>
}
