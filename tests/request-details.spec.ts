import { describe, expect, it } from 'vitest'
import { assessRequestCache, routeExclusionsOf, settledSpeedOf, CACHE_EXCLUSION_REASONS } from '../src/request-details.ts'
import type { CacheAssessInput } from '../src/request-details.ts'

/** A healthy completed DeepSeek-routed request: 96.8% hit, explicit report. */
function eligible(overrides: Partial<CacheAssessInput> = {}): CacheAssessInput {
  return {
    state: 'completed',
    kind: 'request',
    provider: 'deepseek-official',
    inputTokens: 1_200,
    outputTokens: 1_200,
    cacheReadTokens: 36_300,
    ...overrides,
  }
}

describe('request cache assessment — the 50/80 request-area policy', () => {
  // C01
  it('labels 0% and 49.9% as loss (amber figure + 缓存过低 tag)', () => {
    for (const rate of [0, 0.499]) {
      const read = 499
      const input = 501
      const assessment = assessRequestCache(eligible({ cacheReadTokens: rate === 0 ? 0 : read, inputTokens: rate === 0 ? 11_000 : input }))
      expect(assessment.band).toBe('loss')
      expect(assessment.reason).toBeUndefined()
      expect(assessment.rate).toBeCloseTo(rate, 5)
    }
  })

  // C02
  it('ambers 50% and 79.9% without the label', () => {
    const half = assessRequestCache(eligible({ inputTokens: 12_000, cacheReadTokens: 12_000 }))
    expect(half.band).toBe('low')
    expect(half.reason).toBeUndefined()
    const near = assessRequestCache(eligible({ inputTokens: 2_020, cacheReadTokens: 7_980 }))
    expect(near.band).toBe('low')
  })

  // C03
  it('renders 80% and 100% normal (no amber, no label)', () => {
    const at = assessRequestCache(eligible({ inputTokens: 3_000, cacheReadTokens: 12_000 }))
    expect(at.band).toBe('normal')
    const full = assessRequestCache(eligible({ inputTokens: 0, cacheReadTokens: 5_000 }))
    expect(full.band).toBe('normal')
  })

  // C04 — the raw-value-first rule: 49.96% rounds to 50.0% for display but
  // the ASSESSMENT must still see the sub-threshold raw value.
  it('judges 49.96% (displays as 50.0%) as loss on the raw value', () => {
    const assessment = assessRequestCache(eligible({ inputTokens: 5_004, cacheReadTokens: 4_996 }))
    expect(assessment.rate).toBeCloseTo(0.4996, 5)
    expect(assessment.band).toBe('loss')
    // And the mirror: exactly 80% raw is normal even though 79.96… would
    // round-trip through strings as "80.0%".
    const exact = assessRequestCache(eligible({ inputTokens: 3_000, cacheReadTokens: 12_000 }))
    expect(exact.rate).toBe(0.8)
    expect(exact.band).toBe('normal')
  })

  // C05 — explicit 0 vs unreported are different worlds: the bucket's own
  // presence is the evidence (the DeepSeek wire keeps a reported 0; the
  // pi-ai adapter folds one away, which reads unknown here too).
  it('treats an explicit cacheRead 0 as assessable 0%, a missing field as unknown', () => {
    const explicitZero = assessRequestCache(eligible({ inputTokens: 11_000, cacheReadTokens: 0 }))
    expect(explicitZero.rate).toBe(0)
    expect(explicitZero.band).toBe('loss')
    const unreported = assessRequestCache(eligible({ inputTokens: 11_000, cacheReadTokens: undefined }))
    expect(unreported.rate).toBeUndefined()
    expect(unreported.band).toBe('unknown')
    expect(unreported.reason).toBe('cache-unreported')
  })

  // C06 — every degenerate denominator stays unknown, never 0%.
  it('renders — (unknown) for zero/negative/NaN/Infinity data', () => {
    expect(assessRequestCache(eligible({ inputTokens: 0, cacheReadTokens: 0 })).reason).toBe('invalid-data')
    expect(assessRequestCache(eligible({ inputTokens: -5, cacheReadTokens: 3 })).reason).toBe('invalid-data')
    expect(assessRequestCache(eligible({ inputTokens: Number.NaN, cacheReadTokens: 3 })).reason).toBe('invalid-data')
    expect(assessRequestCache(eligible({ inputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 3 })).reason).toBe('invalid-data')
    expect(assessRequestCache(eligible({ inputTokens: undefined })).reason).toBe('invalid-data')
    expect(assessRequestCache(eligible({ inputTokens: 10, cacheReadTokens: Number.NaN })).reason).toBe('invalid-data')
  })

  // C07 — every exclusion reason suppresses the label with an explainable why.
  it('excludes cold start, model switch, in-flight and failed states', () => {
    const cases: Array<[Partial<CacheAssessInput>, string]> = [
      [{ sequenceExclusion: 'cold-start' }, 'cold-start'],
      [{ sequenceExclusion: 'model-switch' }, 'model-switch'],
      [{ state: 'waiting' }, 'in-flight'],
      [{ state: 'streaming' }, 'in-flight'],
      [{ state: 'failed' }, 'not-success'],
      [{ state: 'cancelled' }, 'not-success'],
      [{ state: 'interrupted' }, 'not-success'],
      [{ kind: 'compaction' }, 'compaction'],
    ]
    for (const [overrides, reason] of cases) {
      const assessment = assessRequestCache({ ...eligible({ cacheReadTokens: 1_000, inputTokens: 9_000 }), ...overrides })
      expect(assessment.band).toBe(overrides.state !== undefined || overrides.kind !== undefined ? 'excluded' : assessment.band)
      expect(assessment.reason).toBe(reason)
      expect(assessment.band === 'loss').toBe(false)
    }
  })

  it.each(['zai-coding-cn', 'custom-gateway', undefined])('uses reported data on route %s without an allowlist', provider => {
    for (const [read, band] of [[0, 'loss'], [1_000, 'loss'], [11_000, 'low'], [44_000, 'normal']] as const) {
      const assessment = assessRequestCache(eligible({ provider, inputTokens: 11_000, cacheReadTokens: read }))
      expect(assessment.band).toBe(band)
      expect(assessment.eligibility).toBe('eligible')
      expect(assessment.reason).toBeUndefined()
    }
    expect(assessRequestCache(eligible({ provider, cacheReadTokens: undefined })).reason).toBe('cache-unreported')
    expect(assessRequestCache(eligible({ provider, sequenceExclusion: 'cold-start' })).reason).toBe('cold-start')
    expect(assessRequestCache(eligible({ provider, sequenceExclusion: 'model-switch' })).reason).toBe('model-switch')
  })
})

describe('route-sequence exclusions', () => {
  it('marks the session first request and every model change, not window positions', () => {
    const entries = [
      { sessionId: 'a', model: 'm1' },
      { sessionId: 'a', model: 'm1' },
      { sessionId: 'a', model: 'm2' },
      { sessionId: 'b', model: 'm2' },
      { sessionId: 'a', model: 'm1' }, // switch BACK is still a switch first
      { sessionId: 'a', model: 'm1' },
    ]
    const marks = routeExclusionsOf(entries)
    expect(marks.get(entries[0]!)).toBe('cold-start')
    expect(marks.get(entries[1]!)).toBeUndefined()
    expect(marks.get(entries[2]!)).toBe('model-switch')
    expect(marks.get(entries[3]!)).toBe('cold-start') // per-session lineage
    expect(marks.get(entries[4]!)).toBe('model-switch')
    expect(marks.get(entries[5]!)).toBeUndefined()
  })

  it('does not forge switches around unattributed (empty-model) failures', () => {
    const entries = [
      { sessionId: 'a', model: 'm1' },
      { sessionId: 'a', model: '' },
      { sessionId: 'a', model: 'm1' },
    ]
    const marks = routeExclusionsOf(entries)
    expect(marks.get(entries[1]!)).toBeUndefined()
    expect(marks.get(entries[2]!)).toBeUndefined()
  })

  it('treats a same-model provider switch as a route switch — the cache lineage is per-route, not per-model', () => {
    // deepseek-official → deepseek-account, both serving `deepseek-chat`:
    // the new route's first request is a cold cache context, so its 0% must
    // NOT wear the loss label.
    const entries = [
      { sessionId: 'a', model: 'deepseek-chat', provider: 'deepseek-official' },
      { sessionId: 'a', model: 'deepseek-chat', provider: 'deepseek-account' },
      { sessionId: 'a', model: 'deepseek-chat', provider: 'deepseek-official' }, // back to the first route
    ]
    const marks = routeExclusionsOf(entries)
    expect(marks.get(entries[0]!)).toBe('cold-start')
    expect(marks.get(entries[1]!)).toBe('model-switch')
    expect(marks.get(entries[2]!)).toBe('model-switch') // the switch BACK is still a switch first
  })

  it('keeps the model-only comparison when either side lacks the provider key (legacy rows never gain exclusions)', () => {
    const entries = [
      { sessionId: 'a', model: 'm1', provider: 'deepseek-official' },
      { sessionId: 'a', model: 'm1' }, // legacy row: no provider evidence
      { sessionId: 'a', model: 'm1', provider: 'deepseek-account' },
    ]
    const marks = routeExclusionsOf(entries)
    expect(marks.get(entries[1]!)).toBeUndefined()
    expect(marks.get(entries[2]!)).toBeUndefined()
  })
})

describe('route-specific minimum input', () => {
  // C07 (insufficient-input variant) — the DeepSeek 64-token block floor,
  // derived from the route's own semantics, never a universal threshold.
  it('excludes a sub-block input on the eligible route only, and only at 0%', () => {
    const tiny = assessRequestCache(eligible({ inputTokens: 30, cacheReadTokens: 0 }))
    expect(tiny.band).toBe('excluded')
    expect(tiny.reason).toBe('insufficient-input')
    // A hit means the cache clearly applied — the 94-token input hit 64, a
    // 68% rate that ambers without a label.
    const tinyHit = assessRequestCache(eligible({ inputTokens: 30, cacheReadTokens: 64 }))
    expect(tinyHit.band).toBe('low')
    // A documented DeepSeek block minimum is not generalized to other routes.
    const unknownTiny = assessRequestCache(eligible({ provider: 'zai-coding-cn', inputTokens: 30, cacheReadTokens: 0 }))
    expect(unknownTiny.band).toBe('loss')
    // Above the block floor a 0% is a real loss.
    const big = assessRequestCache(eligible({ inputTokens: 64, cacheReadTokens: 0 }))
    expect(big.band).toBe('loss')
  })
})

describe('settled speed gate', () => {
  // P01
  it('computes 200 tok/s for latency 2000ms, first token 500ms, output 300', () => {
    expect(settledSpeedOf(300, 2_000, 500)).toBe(200)
  })

  // P02
  it('hides sub-500ms generation spans and invalid figures; 500ms exactly computes', () => {
    expect(settledSpeedOf(300, 999, 500)).toBeUndefined() // 499ms generation
    expect(settledSpeedOf(300, 1_000, 500)).toBe(600) // exactly 500ms
    expect(settledSpeedOf(300, 500, 1_000)).toBeUndefined() // negative span
    expect(settledSpeedOf(300, -1, 0)).toBeUndefined()
    expect(settledSpeedOf(Number.NaN, 2_000, 500)).toBeUndefined()
    expect(settledSpeedOf(300, Number.POSITIVE_INFINITY, 500)).toBeUndefined()
  })

  // P03 — whole-body returns and zero-output rows keep the rest visible but
  // never invent a speed.
  it('stays — for missing timing or zero output', () => {
    expect(settledSpeedOf(300, 2_000, undefined)).toBeUndefined() // whole body
    expect(settledSpeedOf(0, 2_000, 500)).toBeUndefined()
    expect(settledSpeedOf(undefined, 2_000, 500)).toBeUndefined()
    expect(settledSpeedOf(300, undefined, 500)).toBeUndefined()
  })
})

describe('exclusion vocabulary coverage', () => {
  it('names every exclusion reason the wire vocabulary declares', () => {
    expect(CACHE_EXCLUSION_REASONS).toEqual([
      'cold-start',
      'model-switch',
      'in-flight',
      'not-success',
      'compaction',
      'cache-unreported',
      'insufficient-input',
      'invalid-data',
    ])
  })
})
