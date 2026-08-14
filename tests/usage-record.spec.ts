import { describe, expect, it } from 'vitest'
import {
  parseRecord,
  projectUsage,
  recordFromEvent,
  serializeRecord,
} from '../src/usage-record.ts'
import { messageEvent } from './helpers.ts'

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
})
