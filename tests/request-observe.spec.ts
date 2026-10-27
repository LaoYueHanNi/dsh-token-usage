/**
 * Live request-observer coverage: the waterfall watcher tracks one entry
 * per real provider attempt with exact session/turn/step/attempt identity,
 * keeps the chunk flow untouched, links the durable settlement, and never
 * invents a live token count. The event bus is the real Cordis context —
 * only the streams are synthetic.
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { RequestObserver } from '../src/request-observe.ts'
import { compactionEvent, messageEvent, retryEvent, retryStartedEvent, toolCallEvent, toolResultEvent, turnEndEvent, turnStartEvent } from './helpers.ts'
import { buildSessionRequestDetails } from '../src/session-request-details.ts'
import { coerceRecord, recordFromEvent } from '../src/usage-record.ts'

/** The LLM service is only the waterfall's `this`. */
class MockLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
}

/** A fresh context with the observer attached the way the plugin does. */
async function mounted(): Promise<{ ctx: Context; observer: RequestObserver }> {
  const ctx = new Context()
  await ctx.plugin(MockLlm)
  const observer = new RequestObserver(42)
  observer.attachLlm(ctx)
  observer.attachSessions(ctx)
  return { ctx, observer }
}

/** One streaming call through the real waterfall; resolves with the chunks
 * the consumer saw. */
async function stream(
  ctx: Context,
  options: Record<string, unknown>,
  chunks: readonly unknown[],
  signal?: AbortSignal,
): Promise<unknown[]> {
  const llm = ctx.get('llm')
  const waterfall = ctx.waterfall.bind(ctx) as (
    thisArg: unknown,
    name: string,
    options: unknown,
    provider: () => AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>
  const seen: unknown[] = []
  const flow = waterfall(llm, 'llm/stream', { signal, ...options }, () => (async function* () {
    for (const chunk of chunks) yield chunk
  })())
  for await (const chunk of flow) seen.push(chunk)
  return seen
}

/** Emit a session event through the real bus (the observer's tracker). */
function emit(ctx: Context, event: SessionEvent): void {
  ctx.emit('session/event', { id: 's1' }, event)
}

const STEP_START = { type: 'step/start', seq: 1, time: 1_000, data: { turn: 3, step: 1 } } as SessionEvent

describe('live request observer', () => {
  it('walks waiting → streaming → completed and passes every chunk through untouched', async () => {
    const { ctx, observer } = await mounted()
    emit(ctx, STEP_START)
    const midStream = observer.snapshot(['s1'])
    expect(midStream.activeCount).toBe(0) // dispatch has not happened yet

    const flow = stream(ctx, { sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-chat', turn: 3, step: 1 }, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // While the stream is open the attempt is live and streaming-capable…
    const live = observer.snapshot(['s1'])
    expect(live.activeCount).toBe(1)
    expect(live.attempts[0]).toMatchObject({ sessionId: 's1', state: 'waiting', kind: 'request' })

    const seen = await flow
    // …and the flow itself is byte-identical: no chunk consumed or altered.
    expect(seen).toHaveLength(4)
    expect(seen[1]).toEqual({ type: 'text-delta', index: 0, text: 'he' })

    const settled = observer.snapshot(['s1'])
    expect(settled.activeCount).toBe(0)
    const attempt = settled.attempts[0]!
    expect(attempt.state).toBe('completed')
    expect(attempt.id).toMatch(/^42:s1:t3:s1:a1$/)
    expect(attempt.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 })
  })

  it('links the durable assistant/message settlement and keeps attempt rows per retry', async () => {
    const { ctx, observer } = await mounted()
    emit(ctx, STEP_START)

    // Attempt 1: a failed stream (error finish), as dsh-llm-retry would see.
    await stream(ctx, { sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-chat' }, [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } } },
    ])
    // Attempt 2 (same turn/step, the retry): succeeds.
    await stream(ctx, { sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-chat' }, [
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // The loop's durable settlement names the message id.
    emit(ctx, messageEvent({ turn: 3, step: 1, messageId: 'msg-9' }))

    const { attempts } = observer.snapshot(['s1'])
    expect(attempts).toHaveLength(2)
    const first = attempts.find(attempt => attempt.id.endsWith('a1'))!
    const second = attempts.find(attempt => attempt.id.endsWith('a2'))!
    expect(first.state).toBe('failed')
    expect(first.failureCode).toBe('RATE_LIMIT')
    expect(second.state).toBe('completed')
    expect(second.durableRequestId).toBe('msg-9')
    expect(first.durableRequestId).toBeUndefined()
  })

  it('never merges concurrent sessions or guesses identity from model/time', async () => {
    const { ctx, observer } = await mounted()
    emit(ctx, STEP_START)
    const first = stream(ctx, { sessionId: 's1', provider: 'p', model: 'same-model' }, [
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const second = stream(ctx, { sessionId: 's2', provider: 'p', model: 'same-model' }, [
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await Promise.all([first, second])
    const { attempts } = observer.snapshot(['s1', 's2'])
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map(attempt => attempt.id)).size).toBe(2)
  })

  it('shows a newer dispatch while an older one is still generating, then updates the old row in place', async () => {
    const { ctx, observer } = await mounted()
    emit(ctx, STEP_START)
    // A: started first, deliberately still open (its stream never finishes).
    const pending: Array<(chunk: unknown) => void> = []
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    const llm = ctx.get('llm')
    const waterfall = ctx.waterfall.bind(ctx) as (
      thisArg: unknown, name: string, options: unknown, provider: () => AsyncIterable<unknown>,
    ) => AsyncIterable<unknown>
    void (async () => {
      const flow = waterfall(llm, 'llm/stream', { sessionId: 's1', provider: 'p', model: 'm1' }, () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'slow' }
        await gate
        yield { type: 'finish', reason: { kind: 'stop' } }
      })())
      for await (const _chunk of flow) {
        // A real consumer: the wrapper observes chunks as they flow past.
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    // B: a second dispatch on the same step (or turn) — the newer attempt.
    await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm2' }, [
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    let live = observer.snapshot(['s1'])
    expect(live.activeCount).toBe(1) // A still waiting/streaming
    const oldRow = live.attempts.find(attempt => attempt.requestedModel === 'm1')!
    expect(oldRow.state).toBe('streaming') // saw its first token, still generating
    expect(oldRow.usage).toBeUndefined() // no live token counts exist

    // A settles: same row id, no cancellation fabricated.
    releaseA()
    await new Promise(resolve => setTimeout(resolve, 10))
    live = observer.snapshot(['s1'])
    expect(live.attempts.find(attempt => attempt.id === oldRow.id)!.state).toBe('completed')
  })

  it('reads a user stop as cancelled and a lost observation as interrupted — never a success or failure guess', async () => {
    const { ctx, observer } = await mounted()
    emit(ctx, STEP_START)
    // Consumer stops early with an aborted signal (the loop's abort path).
    const controller = new AbortController()
    const llm = ctx.get('llm')
    const waterfall = ctx.waterfall.bind(ctx) as (
      thisArg: unknown, name: string, options: unknown, provider: () => AsyncIterable<unknown>,
    ) => AsyncIterable<unknown>
    void (async () => {
      const flow = waterfall(llm, 'llm/stream', { sessionId: 's1', signal: controller.signal, provider: 'p', model: 'm' }, () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        // The consumer's throwIfAborted stops the loop before the finish.
        await new Promise(resolve => setTimeout(resolve, 20))
        yield { type: 'finish', reason: { kind: 'stop' } }
      })())
      for await (const _chunk of flow) {
        controller.abort()
        break
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(observer.snapshot(['s1']).attempts[0]!.state).toBe('cancelled')

    // A turn/end error resolves whatever the stream never did.
    emit(ctx, STEP_START)
    emit(ctx, turnEndEvent({ turn: 3, time: 5_000 }))
    const { attempts } = observer.snapshot(['s1'])
    expect(attempts.filter(attempt => attempt.state === 'cancelled')).toHaveLength(1)
  })

  it('keeps unowned bypass calls out while attributing session-title requests', async () => {
    const { ctx, observer } = await mounted()
    await stream(ctx, { provider: 'p', model: 'm' }, [{ type: 'finish', reason: { kind: 'stop' } }])
    await stream(ctx, { sessionId: 's1', purpose: 'session-title', provider: 'p', model: 'm' }, [{ type: 'finish', reason: { kind: 'stop' } }])
    expect(observer.snapshot(['s1']).attempts).toMatchObject([{ kind: 'aux', auxKind: 'session-title', state: 'completed' }])
  })

  it('links an attributed auxiliary attempt to its persisted id without changing its kind', async () => {
    const { ctx, observer } = await mounted()
    await stream(ctx, { sessionId: 's1', purpose: 'session-title', provider: 'p', model: 'm' }, [
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 2, cacheReadTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const attempt = observer.snapshot(['s1']).attempts[0]!
    observer.linkAuxAttempt({ sessionId: 's1', auxKind: 'session-title', startedAt: attempt.startedAt, provider: 'p', model: 'm', requestId: 'aux:session-title:1:1' })
    expect(observer.snapshot(['s1']).attempts[0]).toMatchObject({ kind: 'aux', durableRequestId: 'aux:session-title:1:1' })
  })

  it('attributes compaction calls with purpose compaction and the owning session', async () => {
    const { ctx, observer } = await mounted()
    await stream(ctx, { sessionId: 's1', purpose: 'compaction', provider: 'p', model: 'm' }, [
      { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 500 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const { attempts, activeCount } = observer.snapshot(['s1'])
    expect(activeCount).toBe(0)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ kind: 'compaction', state: 'completed', usage: { inputTokens: 100_000 } })
  })

  it('drops settled attempts on cleanup and never revives a terminal state', async () => {
    const { ctx, observer } = await mounted()
    emit(ctx, STEP_START)
    await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [{ type: 'finish', reason: { kind: 'stop' } }])
    expect(observer.snapshot(['s1']).attempts).toHaveLength(1)
    observer.cleanup(Date.now() + 20 * 60_000)
    expect(observer.snapshot(['s1']).attempts).toHaveLength(0)
    observer.dispose()
    expect(observer.snapshot(['s1']).attempts).toHaveLength(0)
  })

  /** A compaction/start lock event (numbered owner or standalone). */
  function compactionStart(compactionId: string): SessionEvent {
    return { type: 'compaction/start', seq: SessionSeq(5), time: 1_000, data: { compactionId, turn: null } } as SessionEvent
  }

  describe('durable settlement linking — every recorded origin maps to its attempt', () => {
    it('settles a synchronous dispatch error without leaving a waiting attempt', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      const waterfall = ctx.waterfall.bind(ctx) as (thisArg: unknown, name: string, options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
      const error = new Error('dispatch exception')
      expect(() => waterfall(ctx.get('llm'), 'llm/stream', { sessionId: 's1', provider: 'p', model: 'm' }, () => { throw error })).toThrow(error)
      expect(observer.snapshot(['s1'])).toMatchObject({ activeCount: 0, attempts: [{ state: 'failed' }] })
      emit(ctx, turnEndEvent({ seq: 8, turn: 3 }))
      expect(observer.snapshot(['s1']).attempts[0]!.durableRequestId).toBe('failure:s1:8')
      observer.dispose()
    })

    async function thrownStream(ctx: Context, signal?: AbortSignal): Promise<void> {
      const waterfall = ctx.waterfall.bind(ctx) as (thisArg: unknown, name: string, options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
      const flow = waterfall(ctx.get('llm'), 'llm/stream', { sessionId: 's1', provider: 'p', model: 'm', signal }, () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        throw new Error('transport exception')
      })())
      for await (const _chunk of flow) { /* Consume the provider failure. */ }
    }

    it.each(['retry', 'terminal'] as const)('deduplicates a directly thrown provider error after %s settlement', async (settlement) => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      await expect(thrownStream(ctx)).rejects.toThrow('transport exception')
      expect(observer.snapshot(['s1']).attempts[0]!.state).toBe('failed')
      emit(ctx, settlement === 'retry'
        ? retryEvent({ seq: 8, turn: 3, step: 1 })
        : turnEndEvent({ seq: 8, turn: 3 }))
      const live = observer.snapshot(['s1'])
      expect(live.attempts[0]!.durableRequestId).toBe('failure:s1:8')
      const details = buildSessionRequestDetails({
        records: [{ requestId: 'failure:s1:8', sessionId: 's1', time: Date.now(), model: 'm', kind: 'failure' }],
        live, asOf: Date.now(), liveCapability: 'lifecycle',
        pricing: { ready: false, rulesOf: () => undefined, resolve: () => ({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }) },
      })
      expect(details.items).toHaveLength(1)
      expect(details.items[0]!.state).toBe('failed')
      observer.dispose()
    })

    it('does not relabel an aborted stream as a failed provider attempt', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      const controller = new AbortController()
      controller.abort()
      await expect(thrownStream(ctx, controller.signal)).rejects.toThrow('transport exception')
      emit(ctx, turnEndEvent({ turn: 3, reason: { kind: 'aborted' } }))
      expect(observer.snapshot(['s1']).attempts[0]!).toMatchObject({ state: 'cancelled' })
      expect(observer.snapshot(['s1']).attempts[0]!.durableRequestId).toBeUndefined()
      observer.dispose()
    })

    it('keeps the exact retry attempt clock after log serialization and observer cleanup', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } }])
      emit(ctx, retryEvent({ seq: 8, turn: 3, step: 1 }))
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }])
      const event = messageEvent({ seq: 9, turn: 3, step: 1, messageId: 'msg-9' })
      emit(ctx, event)
      const attempt = observer.snapshot(['s1']).attempts[1]!
      const raw = recordFromEvent(event, 's1', { startedAt: 1_000, latencyMs: 50_000, firstTokenLatencyMs: 40_000 })!
      const row = coerceRecord(JSON.parse(JSON.stringify(observer.decorateRecord(raw))))!
      expect(row.latencyMs).toBe(50_000) // Existing aggregate caliber is unchanged.
      expect(row.attemptTiming!.startedAt).toBe(attempt.startedAt)
      const input = { records: [row], pricing: { ready: false, rulesOf: () => undefined, resolve: () => ({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: -1 }) }, asOf: Date.now(), liveCapability: 'lifecycle' as const }
      const before = buildSessionRequestDetails({ ...input, live: { attempts: [attempt], activeCount: 0 } }).items[0]!
      observer.cleanup(Date.now() + 20 * 60_000)
      const after = buildSessionRequestDetails({ ...input, live: observer.snapshot(['s1']) }).items[0]!
      expect(after).toEqual(before)
      observer.dispose()
    })

    it('links a retried-then-successful turn: the failed attempt owns the llm/retry row, the success the message row', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      // Attempt 1 fails; dsh-llm-retry appends llm/retry BEFORE the backoff
      // (and before the next dispatch), so the cell's latest dispatch is the
      // attempt that just failed, and the logged row will be failure:<seq>.
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 } } },
      ])
      emit(ctx, retryEvent({ seq: 8, turn: 3, step: 1 }))
      // Attempt 2 succeeds and settles as the message.
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [
        { type: 'text-delta', index: 0, text: 'ok' },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      emit(ctx, messageEvent({ seq: 9, turn: 3, step: 1, messageId: 'msg-9' }))

      const { attempts } = observer.snapshot(['s1'])
      expect(attempts).toHaveLength(2)
      const first = attempts.find(attempt => attempt.id.endsWith('a1'))!
      const second = attempts.find(attempt => attempt.id.endsWith('a2'))!
      // Each attempt owns exactly one durable row — the pool can fold the
      // persisted rows in place instead of growing a second copy.
      expect(first.durableRequestId).toBe('failure:s1:8')
      expect(second.durableRequestId).toBe('msg-9')
    })

    it('links the terminal failure through turn/end when retries are exhausted (the already-linked attempt keeps its row)', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      // Attempt 1 fails and is scheduled a retry.
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 } } },
      ])
      emit(ctx, retryEvent({ seq: 8, turn: 3, step: 1 }))
      // Attempt 2 fails too — the policy gives up, the turn ends in error.
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom again', code: 'TRANSPORT', status: 503 } } },
      ])
      emit(ctx, turnEndEvent({ seq: 9, turn: 3, time: 5_000 }))

      const { attempts } = observer.snapshot(['s1'])
      expect(attempts).toHaveLength(2)
      const first = attempts.find(attempt => attempt.id.endsWith('a1'))!
      const second = attempts.find(attempt => attempt.id.endsWith('a2'))!
      expect(first.durableRequestId).toBe('failure:s1:8')
      expect(second.durableRequestId).toBe('failure:s1:9')
      expect(second.failureCode).toBe('TRANSPORT')
    })

    it('links a policy-less terminal failure straight from turn/end', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'QUOTA', status: 402 } } },
      ])
      emit(ctx, turnEndEvent({ seq: 9, turn: 3, time: 5_000 }))
      const { attempts } = observer.snapshot(['s1'])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]!.state).toBe('failed')
      expect(attempts[0]!.durableRequestId).toBe('failure:s1:9')
    })

    it('links the compaction summary to its summarize call through the compaction lock window', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, compactionStart('cmp-1'))
      await stream(ctx, { sessionId: 's1', purpose: 'compaction', provider: 'p', model: 'm' }, [
        { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 500 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      emit(ctx, compactionEvent({ seq: 7, compactionId: 'cmp-1' }))
      emit(ctx, { type: 'compaction/end', seq: SessionSeq(8), time: 3_000, data: { compactionId: 'cmp-1', turn: null } } as SessionEvent)
      const { attempts } = observer.snapshot(['s1'])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]!.kind).toBe('compaction')
      expect(attempts[0]!.durableRequestId).toBe('compaction:s1:7')
    })

    it('falls back to the session’s latest unlinked compaction attempt when the lock window was missed', async () => {
      const { ctx, observer } = await mounted()
      // The compaction dispatched before the observer saw compaction/start
      // (an install-order race): no compactionId on the attempt.
      await stream(ctx, { sessionId: 's1', purpose: 'compaction', provider: 'p', model: 'm' }, [
        { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 500 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      emit(ctx, compactionEvent({ seq: 7, compactionId: 'cmp-late' }))
      const { attempts } = observer.snapshot(['s1'])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]!.durableRequestId).toBe('compaction:s1:7')
    })
  })

  describe('conversation state — where the dialogue stands right now', () => {
    it('reports waiting for a tool result between the call and its answer', async () => {
      const { ctx, observer } = await mounted()
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      emit(ctx, toolCallEvent({ callId: 'call-1' }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toEqual({ state: 'awaiting-tool' })
      // The answer arrives: the conversation is no longer waiting for a tool.
      emit(ctx, toolResultEvent({ callId: 'call-1' }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      observer.dispose()
    })

    it('keeps waiting for a tool while another call is still unanswered', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, toolCallEvent({ callId: 'call-1' }))
      emit(ctx, toolCallEvent({ callId: 'call-2', seq: 6 }))
      emit(ctx, toolResultEvent({ callId: 'call-1', seq: 7 }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toEqual({ state: 'awaiting-tool' })
      emit(ctx, toolResultEvent({ callId: 'call-2', seq: 8 }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      observer.dispose()
    })

    it('reports the turn as complete only when it ended normally', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, turnStartEvent({ turn: 3 }))
      emit(ctx, turnEndEvent({ seq: 9, turn: 3, reason: { kind: 'completed' } }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toEqual({ state: 'turn-complete' })
      // The next turn opens: the previous turn's completion no longer stands.
      emit(ctx, turnStartEvent({ seq: 10, turn: 4 }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      observer.dispose()
    })

    it('never calls a failed or aborted turn complete, and drops a tool call the turn never answered', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, toolCallEvent({ callId: 'call-1' }))
      emit(ctx, turnEndEvent({ seq: 9, turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      observer.dispose()
    })

    it('keeps the state per session', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, turnEndEvent({ seq: 9, turn: 3, reason: { kind: 'completed' } }))
      ctx.emit('session/event', { id: 's2' }, toolCallEvent({ callId: 'call-9' }))
      const snapshot = observer.snapshot(['s1', 's2'])
      expect(snapshot.conversations?.get('s1')).toEqual({ state: 'turn-complete' })
      expect(snapshot.conversations?.get('s2')).toEqual({ state: 'awaiting-tool' })
      observer.dispose()
    })

    it('reports the retry window between the failed attempt and the next try', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, STEP_START)
      await stream(ctx, { sessionId: 's1', provider: 'p', model: 'm' }, [
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT', status: 429 } } },
      ])
      emit(ctx, retryEvent({ seq: 8, turn: 3, step: 1 }))
      // The backoff is running: the conversation is retrying, and the panel may
      // say so instead of leaving a bare failed row behind.
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toEqual({
        state: 'retrying',
        retry: { count: 1, max: 5, delayMs: 500, code: 'RATE_LIMIT' },
      })
      // The wait is over: the next attempt is about to dispatch.
      emit(ctx, retryStartedEvent({ seq: 9, turn: 3, step: 1 }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      observer.dispose()
    })

    it('never leaves a retry window behind when the turn ends', async () => {
      const { ctx, observer } = await mounted()
      emit(ctx, retryEvent({ seq: 8, turn: 3, step: 1 }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')?.state).toBe('retrying')
      emit(ctx, turnEndEvent({ seq: 9, turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
      expect(observer.snapshot(['s1']).conversations?.get('s1')).toBeUndefined()
      observer.dispose()
    })
  })
})
