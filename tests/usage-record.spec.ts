import { describe, expect, it } from 'vitest'
import {
  parseRecord,
  projectUsage,
  recordFromCompaction,
  recordFromEvent,
  serializeRecord,
} from '../src/usage-record.ts'
import { compactionEvent, messageEvent } from './helpers.ts'

describe('projectUsage', () => {
  it('renders an absent usage record as undefined', () => {
    expect(projectUsage(undefined)).toBeUndefined()
  })

  it('omits absent optional buckets entirely', () => {
    expect(projectUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    })
  })

  it('passes reported optional buckets through', () => {
    expect(projectUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 2,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 2,
    })
  })

  it('rejects an invalid required bucket as a whole', () => {
    expect(projectUsage({ inputTokens: NaN, outputTokens: 5 })).toBeUndefined()
    expect(projectUsage({ inputTokens: -1, outputTokens: 5 })).toBeUndefined()
    expect(projectUsage({ inputTokens: 10, outputTokens: 'x' as unknown as number })).toBeUndefined()
  })

  it('omits an invalid optional bucket field-wise', () => {
    expect(projectUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: -3 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    })
  })
})

describe('recordFromEvent', () => {
  it('projects the minimal record', () => {
    const record = recordFromEvent(messageEvent(), 'session-1')
    expect(record).toEqual({
      requestId: 'msg-1',
      time: 1_700_000_000_000,
      sessionId: 'session-1',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    })
  })

  it('omits usage for a usage-less request', () => {
    const record = recordFromEvent(messageEvent({ usage: undefined }), 'session-1')
    expect('usage' in record).toBe(false)
  })
})

describe('recordFromCompaction', () => {
  it('projects the summarize call with the compaction kind', () => {
    const record = recordFromCompaction(compactionEvent(), 'session-1')
    expect(record).toEqual({
      requestId: 'compaction:session-1:7',
      time: 1_700_000_000_000,
      sessionId: 'session-1',
      model: 'deepseek-chat',
      usage: { inputTokens: 100_000, outputTokens: 500, cacheReadTokens: 3_000 },
      kind: 'compaction',
    })
  })

  it('keys the row on the event seq, not the compactionId', () => {
    const first = recordFromCompaction(compactionEvent({ seq: 7, compactionId: 'cmp-x' }), 's1')
    const second = recordFromCompaction(compactionEvent({ seq: 8, compactionId: 'cmp-x' }), 's1')
    expect(first!.requestId).toBe('compaction:s1:7')
    expect(second!.requestId).toBe('compaction:s1:8')
    // A different session at the same seq stays distinct.
    const other = recordFromCompaction(compactionEvent({ seq: 7 }), 's2')
    expect(other!.requestId).toBe('compaction:s2:7')
  })

  it('returns null when the event carries no usage', () => {
    expect(recordFromCompaction(compactionEvent({ usage: undefined }), 'session-1')).toBeNull()
  })

  it('returns null when the usage is invalid', () => {
    expect(recordFromCompaction(compactionEvent({
      usage: { inputTokens: NaN, outputTokens: 5 },
    }), 'session-1')).toBeNull()
  })
})

describe('serialize/parse round trip', () => {
  it('round-trips a full record', () => {
    const record = recordFromEvent(messageEvent(), 'session-1')
    expect(parseRecord(serializeRecord(record))).toEqual(record)
  })

  it('round-trips a usage-less record', () => {
    const record = recordFromEvent(messageEvent({ usage: undefined }), 'session-1')
    expect(parseRecord(serializeRecord(record))).toEqual(record)
  })

  it('round-trips CJK and special characters', () => {
    const record = recordFromEvent(messageEvent({
      messageId: '会话-1/\u0000',
      model: 'model "x" \n',
    }), 'sess/1')
    expect(parseRecord(serializeRecord(record))).toEqual(record)
  })

  it('round-trips a compaction record with its kind', () => {
    const record = recordFromCompaction(compactionEvent(), 'session-1')
    expect(parseRecord(serializeRecord(record!))).toEqual(record)
  })
})

describe('parseRecord', () => {
  const valid = serializeRecord(recordFromEvent(messageEvent(), 'session-1'))

  it('rejects malformed JSON', () => {
    expect(parseRecord('{not json')).toBeNull()
    expect(parseRecord('')).toBeNull()
  })

  it('rejects missing or mistyped required fields', () => {
    expect(parseRecord(valid.replace('"msg-1"', '1'))).toBeNull()
    expect(parseRecord(valid.replace('"session-1"', 'null'))).toBeNull()
    expect(parseRecord(valid.replace('"deepseek-chat"', '{}'))).toBeNull()
    expect(parseRecord(valid.replace('"time":1700000000000', '"time":"x"'))).toBeNull()
  })

  it('rejects invalid usage buckets', () => {
    const withBadUsage = valid.replace('"inputTokens":10', '"inputTokens":-10')
    expect(parseRecord(withBadUsage)).toBeNull()
  })

  it('accepts a legacy row with the old field set', () => {
    const legacy = JSON.stringify({
      requestId: 'legacy-1',
      time: 1_700_000_000_000,
      seq: 42,
      sessionId: 's1',
      turn: 3,
      step: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      origin: 'live',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: null,
        cacheWriteTokens: 2,
        reasoningTokens: null,
      },
    })
    expect(parseRecord(legacy)).toEqual({
      requestId: 'legacy-1',
      time: 1_700_000_000_000,
      sessionId: 's1',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2 },
    })
  })

  it('accepts a legacy row with null usage', () => {
    const legacy = JSON.stringify({
      requestId: 'legacy-2',
      time: 1_700_000_000_000,
      sessionId: 's1',
      model: 'deepseek-chat',
      usage: null,
    })
    expect(parseRecord(legacy)).toEqual({
      requestId: 'legacy-2',
      time: 1_700_000_000_000,
      sessionId: 's1',
      model: 'deepseek-chat',
    })
  })

  it('normalizes an absent or unknown kind to a plain request', () => {
    const legacy = JSON.stringify({
      requestId: 'legacy-3',
      time: 1_700_000_000_000,
      sessionId: 's1',
      model: 'deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    // No kind key at all (a pre-compaction row).
    expect('kind' in parseRecord(legacy)!).toBe(false)
    // An unknown kind value (a future row kind) keeps the row as a request.
    const future = JSON.parse(legacy) as Record<string, unknown>
    future.kind = 'rebalance'
    expect('kind' in parseRecord(JSON.stringify(future))!).toBe(false)
  })

  it('keeps the compaction kind through coercion', () => {
    const row = JSON.stringify({
      requestId: 'compaction:s1:7',
      time: 1_700_000_000_000,
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'compaction',
      usage: { inputTokens: 100, outputTokens: 5 },
    })
    expect(parseRecord(row)).toEqual({
      requestId: 'compaction:s1:7',
      time: 1_700_000_000_000,
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'compaction',
      usage: { inputTokens: 100, outputTokens: 5 },
    })
  })
})
