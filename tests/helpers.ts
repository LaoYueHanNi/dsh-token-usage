import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the merged `compaction/*` payload types into the program.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: pulls the merged `llm/retry` payload types into the program.
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/** Minimal but shape-true assistant/message event for unit tests. */
export function messageEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  step?: number
  messageId?: string
  provider?: string
  model?: string
  /** Adapter-private replay envelope on the message source; omitted by default. */
  replayState?: unknown
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
          ...(overrides.replayState === undefined ? {} : { replayState: overrides.replayState }),
        },
      },
      usage: 'usage' in overrides
        ? overrides.usage
        : { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    },
  } as SessionEvent<'assistant/message'>
}

/** Minimal but shape-true compaction/prune event for unit tests: one
 * tool-result pruning that shadowed a surface range (log-only, no billing
 * row). */
export function pruneEvent(overrides: {
  seq?: number
  time?: number
  tokens?: number
} = {}): SessionEvent<'compaction/prune'> {
  return {
    type: 'compaction/prune',
    seq: SessionSeq(overrides.seq ?? 5),
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      shadowedRange: { start: 33, end: 230 },
      shadowedSeqs: [33, 230],
      shadowedTokenCount: overrides.tokens ?? 100,
    },
  } as SessionEvent<'compaction/prune'>
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
    seq: SessionSeq(overrides.seq ?? 7),
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

/** Minimal but shape-true turn/end event for unit tests. The default reason
 * is an LLM error (a failed model request); override `reason` for the
 * non-error endings (completed, aborted, max-tokens, …). */
export function turnEndEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  reason?: SessionEvent<'turn/end'>['data']['reason']
} = {}): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq: SessionSeq(overrides.seq ?? 9),
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      turn: overrides.turn ?? 1,
      reason: overrides.reason ?? {
        kind: 'error',
        error: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
      },
    },
  } as SessionEvent<'turn/end'>
}

/** Minimal but shape-true turn/start event for unit tests: a new turn opens,
 * so the previous turn's completion no longer describes the conversation. */
export function turnStartEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
} = {}): SessionEvent<'turn/start'> {
  return {
    type: 'turn/start',
    seq: SessionSeq(overrides.seq ?? 9),
    time: overrides.time ?? 1_700_000_000_000,
    data: { turn: overrides.turn ?? 1 },
  } as SessionEvent<'turn/start'>
}

/** Minimal but shape-true llm/retry-started event: the backoff is over and the
 * next attempt is about to dispatch, so the conversation is no longer waiting
 * out a retry delay. */
export function retryStartedEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  step?: number
  retry?: number
} = {}): SessionEvent<'llm/retry-started'> {
  return {
    type: 'llm/retry-started',
    seq: SessionSeq(overrides.seq ?? 9),
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      retryId: 'retry-1',
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      retry: overrides.retry ?? 1,
    },
  } as SessionEvent<'llm/retry-started'>
}

/** Minimal but shape-true tool/call event: the model asked for a tool, so the
 * conversation now waits for that tool's result. */
export function toolCallEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  step?: number
  callId?: string
  name?: string
} = {}): SessionEvent<'tool/call'> {
  const callId = overrides.callId ?? 'call-1'
  return {
    type: 'tool/call',
    seq: SessionSeq(overrides.seq ?? 5),
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      callId: callId as SessionEvent<'tool/call'>['data']['callId'],
      name: overrides.name ?? 'read_file',
      arguments: '{}',
    },
  } as SessionEvent<'tool/call'>
}

/** Minimal but shape-true tool/result event: the awaited tool answered, so
 * the conversation is no longer waiting for a tool. */
export function toolResultEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  step?: number
  callId?: string
} = {}): SessionEvent<'tool/result'> {
  const callId = overrides.callId ?? 'call-1'
  return {
    type: 'tool/result',
    seq: SessionSeq(overrides.seq ?? 6),
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      message: {
        id: 'tool-msg-1',
        role: 'tool',
        content: [],
        source: { kind: 'tool', callId: callId as SessionEvent<'tool/result'>['data']['message']['source']['callId'] },
        toolCallId: callId as SessionEvent<'tool/result'>['data']['message']['toolCallId'],
      },
    },
  } as SessionEvent<'tool/result'>
}

/** Minimal but shape-true llm/retry event for unit tests. The default
 * failure is RATE_LIMIT (the retryable class the user actually sees). */
export function retryEvent(overrides: {
  seq?: number
  time?: number
  turn?: number
  step?: number
  retry?: number
  failure?: SessionEvent<'llm/retry'>['data']['failure']
  provider?: string
} = {}): SessionEvent<'llm/retry'> {
  return {
    type: 'llm/retry',
    seq: SessionSeq(overrides.seq ?? 8),
    time: overrides.time ?? 1_700_000_000_000,
    data: {
      retryId: 'retry-1',
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      provider: overrides.provider ?? 'deepseek',
      mode: 'normal',
      policyKey: '["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]',
      retry: overrides.retry ?? 1,
      maxRetries: 5,
      delayMs: 500,
      failure: overrides.failure ?? { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
    },
  } as SessionEvent<'llm/retry'>
}
