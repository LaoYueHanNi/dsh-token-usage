import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  AUTO_REVIEW_PROMPT_PREFIX,
  TRANSLATION_PROMPT_PREFIX,
  classifyAuxRequest,
  recordFromAuxRequest,
} from '../src/aux-request.ts'
import { parseRecord, serializeRecord } from '../src/usage-record.ts'

/** Minimal request envelope: only the fields the classifier reads matter. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    messages: [],
    ...overrides,
  } as GenerateOptions
}

describe('classifyAuxRequest', () => {
  it('skips conversation-loop requests, which carry their session id', () => {
    expect(classifyAuxRequest(request({
      sessionId: 'session-1' as GenerateOptions['sessionId'],
    }))).toBeUndefined()
  })

  it('skips compaction summaries, which log their own usage-bearing event', () => {
    expect(classifyAuxRequest(request({
      sessionId: 'session-1' as GenerateOptions['sessionId'],
      purpose: 'compaction',
    }))).toBeUndefined()
  })

  it('classifies session-title generation by its purpose marker', () => {
    expect(classifyAuxRequest(request({
      sessionId: 'session-1' as GenerateOptions['sessionId'],
      purpose: 'session-title',
    }))).toBe('session-title')
  })

  it('classifies the Auto review reviewer by its fixed policy prompt', () => {
    expect(classifyAuxRequest(request({
      system: `${AUTO_REVIEW_PROMPT_PREFIX}\nYou are the final authorization reviewer …`,
    }))).toBe('auto-review')
  })

  it('classifies reasoning translation by its system prompt', () => {
    expect(classifyAuxRequest(request({
      system: `${TRANSLATION_PROMPT_PREFIX} to Chinese. Translate the text as written …`,
    }))).toBe('translation')
  })

  it('buckets any other unmarked bypass request as other', () => {
    expect(classifyAuxRequest(request())).toBe('other')
    expect(classifyAuxRequest(request({ system: 'an unrelated host prompt' }))).toBe('other')
  })
})

describe('recordFromAuxRequest', () => {
  it('builds an unowned aux row carrying the provider usage', () => {
    const row = recordFromAuxRequest({
      auxKind: 'auto-review',
      requestId: 'aux:auto-review:1700000000000:1',
      time: 1_700_000_000_000,
      model: 'deepseek-flash',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
    })
    expect(row).toEqual({
      requestId: 'aux:auto-review:1700000000000:1',
      time: 1_700_000_000_000,
      sessionId: '',
      model: 'deepseek-flash',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
      kind: 'aux',
      auxKind: 'auto-review',
    })
  })

  it('keeps the row when the provider reported no usable usage', () => {
    const row = recordFromAuxRequest({
      auxKind: 'translation',
      requestId: 'aux:translation:1:2',
      time: 1,
      model: 'deepseek-flash',
      usage: { inputTokens: Number.NaN, outputTokens: 1 },
    })
    expect(row.usage).toBeUndefined()
    expect(row).toMatchObject({ kind: 'aux', auxKind: 'translation', sessionId: '' })
  })

  it('preserves a host-provided session owner for attributed auxiliary work', () => {
    expect(recordFromAuxRequest({
      auxKind: 'session-title', requestId: 'aux:session-title:1:6', time: 1,
      model: 'deepseek-flash', sessionId: 'session-1',
    }).sessionId).toBe('session-1')
  })

  it('carries the routed and provider-reported models side by side', () => {
    const row = recordFromAuxRequest({
      auxKind: 'session-title',
      requestId: 'aux:session-title:1:4',
      time: 1,
      model: 'auto/GLM-5.3-Flash',
      responseModel: 'glm-5.3-flash',
    })
    expect(row.model).toBe('auto/GLM-5.3-Flash')
    expect(row.responseModel).toBe('glm-5.3-flash')
    // An unknown reported model stays omitted, never null.
    expect('responseModel' in recordFromAuxRequest({
      auxKind: 'other',
      requestId: 'aux:other:1:5',
      time: 1,
      model: 'deepseek-flash',
    })).toBe(false)
  })
})

describe('aux row parsing', () => {
  const row = recordFromAuxRequest({
    auxKind: 'session-title',
    requestId: 'aux:session-title:1:3',
    time: 1,
    model: 'deepseek-flash',
    usage: { inputTokens: 5, outputTokens: 1 },
  })

  it('round-trips through the JSONL format', () => {
    expect(parseRecord(serializeRecord(row))).toEqual(row)
  })

  it('normalizes an unknown auxiliary kind to other instead of dropping the row', () => {
    const parsed = parseRecord(JSON.stringify({ ...row, auxKind: 'future-kind' }))
    expect(parsed).toMatchObject({ kind: 'aux', auxKind: 'other' })
  })

  it('normalizes a missing auxiliary kind to other', () => {
    const { auxKind: _kind, ...withoutKind } = row
    expect(parseRecord(JSON.stringify(withoutKind))).toMatchObject({ kind: 'aux', auxKind: 'other' })
  })

  it('keeps a legacy kindless row a plain request', () => {
    const parsed = parseRecord(JSON.stringify({ requestId: 'req-1', time: 1, sessionId: 's1', model: 'm' }))
    expect(parsed?.kind).toBeUndefined()
    expect(parsed?.auxKind).toBeUndefined()
  })
})
