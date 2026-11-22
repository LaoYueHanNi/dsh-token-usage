import { describe, expect, it } from 'vitest'
import { WebCallTracker } from '../src/web-call.ts'
import { searchLlmRequestEvent, toolCallEvent, toolResultEvent, turnEndEvent } from './helpers.ts'

const SESSION = 'sess-1'
const TIME = 1_700_000_000_000

describe('WebCallTracker', () => {
  it('pairs a call, its model round and its result into one unmetered row', () => {
    const tracker = new WebCallTracker(SESSION)

    expect(tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 'c1', name: 'web_search', arguments: '{"query":"alpha"}',
    }))).toBeNull()
    expect(tracker.observe(searchLlmRequestEvent({ seq: 2, time: TIME + 100, query: 'alpha' }))).toBeNull()
    const record = tracker.observe(toolResultEvent({ seq: 3, time: TIME + 900, callId: 'c1' }))

    expect(record).not.toBeNull()
    expect(record).toMatchObject({
      requestId: `web:${SESSION}:3`,
      time: TIME + 900,
      sessionId: SESSION,
      model: 'deepseek-v4-flash',
      kind: 'web',
      web: {
        tool: 'web_search',
        callId: 'c1',
        queryCount: 1,
        rounds: 1,
        durationMs: 900,
      },
    })
    expect(record?.usage).toBeUndefined()
  })

  it('accepts the current queries array, sums rounds and merges reported usage', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 'c1', name: 'web_search', arguments: '{"queries":["alpha","beta"]}',
    }))
    tracker.observe(searchLlmRequestEvent({
      seq: 2, time: TIME + 100, query: 'alpha',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 7 },
    }))
    tracker.observe(searchLlmRequestEvent({
      seq: 3, time: TIME + 200, query: 'beta',
      usage: { input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 5 },
    }))
    const record = tracker.observe(toolResultEvent({ seq: 4, time: TIME + 500, callId: 'c1' }))

    expect(record).toMatchObject({
      model: 'deepseek-v4-flash',
      usage: {
        inputTokens: 300,
        outputTokens: 50,
        cacheReadTokens: 7,
        cacheWriteTokens: 5,
      },
      web: { queryCount: 2, rounds: 2 },
    })
  })

  it('keeps a per-search call with no model round as invocation-only', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 'c1', name: 'web_search', arguments: '{"query":"alpha"}',
    }))
    const record = tracker.observe(toolResultEvent({ seq: 2, time: TIME + 50, callId: 'c1' }))

    expect(record).toMatchObject({
      requestId: `web:${SESSION}:2`,
      model: '',
      web: { tool: 'web_search', callId: 'c1', queryCount: 1 },
    })
    expect(record?.web?.rounds).toBeUndefined()
    expect(record?.usage).toBeUndefined()
  })

  it('prefers usage attached to the tool result meta over accumulated round usage', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 'c1', name: 'web_search', arguments: '{"query":"alpha"}',
    }))
    tracker.observe(searchLlmRequestEvent({
      seq: 2, time: TIME + 100, query: 'alpha', usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const record = tracker.observe(toolResultEvent({
      seq: 3, time: TIME + 200, callId: 'c1',
      meta: { usage: { inputTokens: 42, outputTokens: 8 } },
    }))

    expect(record?.usage).toEqual({ inputTokens: 42, outputTokens: 8 })
    expect(record?.web?.rounds).toBe(1)
  })

  it('records a failed result with its error code', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 'c1', name: 'web_search', arguments: '{"query":"alpha"}',
    }))
    const record = tracker.observe(toolResultEvent({
      seq: 2, time: TIME + 20, callId: 'c1', isError: true,
      error: { name: 'WebError', code: 'WEB_PROVIDER_ERROR', reason: 'provider failed' },
    }))

    expect(record?.web).toMatchObject({ failed: true, errorCode: 'WEB_PROVIDER_ERROR' })
  })

  it('falls back to the older result source.callId shape', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 'c1', name: 'web_search', arguments: '{"query":"alpha"}',
    }))
    const record = tracker.observe(toolResultEvent({
      seq: 2, time: TIME + 20, callId: 'c1', legacyCallIdOnly: true,
    }))

    expect(record?.requestId).toBe(`web:${SESSION}:2`)
    expect(record?.web?.callId).toBe('c1')
  })

  it('ignores other tools and calls that never settle', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({ seq: 1, time: TIME, callId: 'c1', name: 'read', arguments: '{}' }))
    expect(tracker.observe(toolResultEvent({ seq: 2, time: TIME + 10, callId: 'c1' }))).toBeNull()

    tracker.observe(toolCallEvent({
      seq: 3, time: TIME, callId: 'c2', name: 'web_search', arguments: '{"query":"alpha"}',
    }))
    tracker.observe(turnEndEvent({ seq: 4, time: TIME + 10 }))
    expect(tracker.observe(toolResultEvent({ seq: 5, time: TIME + 20, callId: 'c2' }))).toBeNull()
  })

  it('records web_fetch calls and never attaches search model rounds to them', () => {
    const tracker = new WebCallTracker(SESSION)
    tracker.observe(toolCallEvent({
      seq: 1, time: TIME, callId: 's1', name: 'web_search', arguments: '{"queries":["alpha"]}',
    }))
    tracker.observe(toolCallEvent({
      seq: 2, time: TIME + 5, callId: 'f1', name: 'web_fetch', arguments: '{"url":"https://example.com"}',
    }))
    tracker.observe(searchLlmRequestEvent({ seq: 3, time: TIME + 10, query: 'alpha' }))
    const fetchRow = tracker.observe(toolResultEvent({ seq: 4, time: TIME + 55, callId: 'f1' }))
    const searchRow = tracker.observe(toolResultEvent({ seq: 5, time: TIME + 80, callId: 's1' }))

    expect(fetchRow).toEqual({
      requestId: `web:${SESSION}:4`,
      time: TIME + 55,
      sessionId: SESSION,
      model: '',
      kind: 'web',
      web: { tool: 'web_fetch', callId: 'f1', durationMs: 50 },
    })
    expect(searchRow?.web?.rounds).toBe(1)
  })
})
