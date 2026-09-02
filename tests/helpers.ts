import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'

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
    seq: SessionSeq(overrides.seq ?? 1),
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
