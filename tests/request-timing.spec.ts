/**
 * Host-side timing fold for the subagent table. The child rows no longer
 * read the runtime session mirror's `sessionStats` projection; they read
 * these buckets computed from persisted usage records.
 */
import { describe, expect, it } from 'vitest'
import { aggregateRequestTiming } from '../src/stats.ts'
import type { UsageRecord } from '../src/usage-record.ts'

/** A plain request with 100 output tokens and no timing by default. */
function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: 'r',
    time: 1_000,
    sessionId: 'child',
    model: 'm',
    usage: { inputTokens: 10, outputTokens: 100 },
    ...overrides,
  }
}

describe('aggregateRequestTiming', () => {
  it('prefers the exact attemptTiming decode window and sums every bucket', () => {
    const rows = [
      record({ requestId: 'a', firstTokenLatencyMs: 100, attemptTiming: { startedAt: 0, settledAt: 1_000, firstTokenAt: 100 } }),
      record({ requestId: 'b', firstTokenLatencyMs: 300, attemptTiming: { startedAt: 0, settledAt: 2_000, firstTokenAt: 300 } }),
    ]
    expect(aggregateRequestTiming(rows)).toEqual({
      ttftMs: 400, ttftSteps: 2, decodeMs: 2_600, decodeTokens: 200,
    })
  })

  it('falls back to latencyMs - firstTokenLatencyMs without attemptTiming', () => {
    expect(aggregateRequestTiming([
      record({ firstTokenLatencyMs: 250, latencyMs: 1_250 }),
    ])).toEqual({ ttftMs: 250, ttftSteps: 1, decodeMs: 1_000, decodeTokens: 100 })
  })

  it('skips records without a first token, output tokens, or a decode window', () => {
    expect(aggregateRequestTiming([
      record({ requestId: 'no-ft' }),
      record({ requestId: 'no-output', firstTokenLatencyMs: 100, latencyMs: 500, usage: { inputTokens: 5, outputTokens: 0 } }),
      record({ requestId: 'no-latency', firstTokenLatencyMs: 100 }),
      record({ requestId: 'zero-gen', firstTokenLatencyMs: 500, latencyMs: 500 }),
    ])).toBeUndefined()
  })

  it('ignores non-finite timing figures', () => {
    expect(aggregateRequestTiming([
      record({ firstTokenLatencyMs: Number.NaN, latencyMs: 500 }),
      record({ firstTokenLatencyMs: 100, latencyMs: Number.POSITIVE_INFINITY }),
    ])).toBeUndefined()
  })

  it('returns undefined for an empty group', () => {
    expect(aggregateRequestTiming([])).toBeUndefined()
  })
})
