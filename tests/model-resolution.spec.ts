import { describe, expect, it } from 'vitest'
import { compileAliasPattern, createModelResolver, providerSuffix } from '../src/model-resolution.ts'
import { coerceCloudPricing, pricingContextOf } from '../src/pricing.ts'

describe('model resolution', () => {
  const resolve = createModelResolver([
    { modelId: 'glm-5.3-flash', aliasPatterns: ['^legacy$', '^glm-5\\.3-flash(-(low|high))?$'] },
    { modelId: 'glm-5.3-flashx', aliasPatterns: ['^GLM-5\\.3-FLASH$'] },
    { modelId: 'provider/special', aliasPatterns: ['^provider/special-old$'] },
    { modelId: 'special' },
  ])
  it.each([
    ['GLM-5.3-FLASH', 'glm-5.3-flash', 'id'],
    ['LEGACY', 'glm-5.3-flash', 'pattern'],
    ['P/NS/GLM-5.3-FLASH', 'glm-5.3-flash', 'normalized-id'],
    ['P/NS/LEGACY', 'glm-5.3-flash', 'pattern'],
    ['GLM-5.3-FLASH-HIGH', 'glm-5.3-flash', 'pattern'],
    ['P/GLM-5.3-FLASH-LOW', 'glm-5.3-flash', 'pattern'],
    ['PROVIDER/SPECIAL', 'provider/special', 'id'],
    ['PROVIDER/SPECIAL-OLD', 'provider/special', 'pattern'],
  ])('resolves %s through %s (%s)', (name, modelId, method) => {
    expect(resolve(name)).toMatchObject({ rawName: name, status: 'matched', modelId, method })
  })
  it.each(['glm-5.3-flash-fast', 'glm-5.3-flash-mini', 'glm-5.3-flash-2', 'glm-5.3-flashx-high', 'glm-5.3-flash-high\n', 'glm-5.3-flash\n', ' glm-5.3-flash', 'p/glm-5.3-flash ', '/glm-5.3-flash', 'p//glm-5.3-flash', 'p/glm-5.3-flash/'])('preserves identity and input boundaries: %j', name => {
    expect(resolve(name).status).toBe('unmatched')
  })
  it('keeps flashx separate and caches the same name', () => {
    expect(resolve('GLM-5.3-FLASHX').modelId).toBe('glm-5.3-flashx')
    expect(resolve('legacy')).toBe(resolve('legacy'))
    expect(providerSuffix('a//b')).toBeUndefined()
  })
  it('deduplicates multiple patterns and original/suffix hits for one model', () => {
    const identify = createModelResolver([{ modelId: 'm', aliasPatterns: ['^(p/)?alias$', '^alias$'] }])
    expect(identify('P/ALIAS')).toMatchObject({ status: 'matched', modelId: 'm', method: 'pattern', strippedPrefix: true })
  })
  it('reports cross-model pattern ambiguity rather than choosing the first row', () => {
    const identify = createModelResolver([
      { modelId: 'a', aliasPatterns: ['^p/m$', '^shared$'] }, { modelId: 'b', aliasPatterns: ['^P/M$', '^SHARED$'] },
      { modelId: 'm' },
    ])
    expect(identify('p/m')).toMatchObject({ status: 'matched', method: 'normalized-id', modelId: 'm' })
    expect(identify('q/shared')).toMatchObject({ status: 'ambiguous', method: 'pattern', candidates: ['a', 'b'] })
  })
  it('unions cross-model regex hits across both candidates, independent of feed order', () => {
    const models = [{ modelId: 'a', aliasPatterns: ['^p/alias$'] }, { modelId: 'b', aliasPatterns: ['^alias$'] }]
    expect(createModelResolver(models)('P/ALIAS')).toEqual(createModelResolver(models.toReversed())('P/ALIAS'))
    expect(createModelResolver(models)('P/ALIAS')).toMatchObject({ status: 'ambiguous', candidates: ['a', 'b'] })
  })
  it('reports ambiguity when a full-name pattern and a suffix pattern disagree', () => {
    const identify = createModelResolver([
      { modelId: 'a', aliasPatterns: ['^provider/legacy$'] },
      { modelId: 'b', aliasPatterns: ['^legacy$'] },
    ])
    expect(identify('PROVIDER/LEGACY')).toMatchObject({ status: 'ambiguous', method: 'pattern', candidates: ['a', 'b'] })
  })
  it('normalized exact ID wins before a full-name regex', () => {
    expect(createModelResolver([{ modelId: 'm' }, { modelId: 'n', aliasPatterns: ['^p/m$'] }])('p/m').modelId).toBe('m')
  })
  it('supports current upstream effort variants without collapsing mandatory fast identity', () => {
    const identify = createModelResolver([
      { modelId: 'Claude-Opus-5.5', aliasPatterns: ['^claude-opus-5-5(-(thinking-)?(low|medium|high|extra-high|xhigh|max))?$'] },
      { modelId: 'gemini-3.8-flash', aliasPatterns: ['^gemini-3\\.8-flash(-(low|medium|high|n))?$'] },
      { modelId: 'grok-4.7', aliasPatterns: ['^grok-4\\.7(-(low|medium|high|xhigh))?$'] },
      { modelId: 'grok-4.7-fast', aliasPatterns: ['^grok-4\\.7-fast(-(low|medium|high|xhigh))?$', '^grok-4\\.7(-(low|medium|high|xhigh))?-fast$'] },
    ])
    expect(identify('CLAUDE-OPUS-5-5-THINKING-XHIGH')).toMatchObject({ modelId: 'Claude-Opus-5.5', method: 'pattern' })
    expect(identify('provider/GEMINI-3.8-FLASH-N')).toMatchObject({ modelId: 'gemini-3.8-flash', method: 'pattern' })
    expect(identify('grok-4.7-high').modelId).toBe('grok-4.7')
    expect(identify('grok-4.7-high-fast').modelId).toBe('grok-4.7-fast')
    expect(identify('grok-4.7-fast-high').modelId).toBe('grok-4.7-fast')
    for (const name of ['claude-opus-5-5-fast', 'grok-4.7-mini', 'gemini-3.8-flash-max', 'gemini-3x8-flash-n']) {
      expect(identify(name).status).toBe('unmatched')
    }
  })
})

describe('portable alias pattern validation', () => {
  it.each(['foo', '^foo.*$', '^foo+$', '^foo{2}$', '^(?:foo)$', '^(?i:foo)$', '^(foo)\\1$', '^\\w$', '^[ab]$', '^foo|$', '^()$', '^foo??$', '^(foo$', '^foo)$', '^foo.$'])('rejects %j', pattern => {
    expect(() => compileAliasPattern(pattern)).toThrow()
  })
  it('supports escaped punctuation and nested optional groups', () => {
    expect(compileAliasPattern('^gpt-5\\.6(-(low|high))?$').test('GPT-5.6-HIGH')).toBe(true)
  })
  it('accepts literal colons in upstream model aliases while retaining full-name matching', () => {
    const name = 'nemotron-3-super-120b-a12b:free'
    const data = coerceCloudPricing(feed([{ ...row, modelId: 'nemotron-3-super', aliasPatterns: [`^${name}$`] }]))!
    expect(data).not.toBeNull()
    const context = pricingContextOf(data)
    expect(context.resolveModel(name.toUpperCase())).toMatchObject({ modelId: 'nemotron-3-super', method: 'pattern' })
    expect(context.resolveModel(`provider/${name}`)).toMatchObject({ modelId: 'nemotron-3-super', method: 'pattern', strippedPrefix: true })
    for (const bad of [name.replace(':', '-'), name.replace(':', '/'), `${name}\n`, `${name}-extra`]) {
      expect(context.resolveModel(bad).status).toBe('unmatched')
    }
  })
  const row = { modelId: 'm', inputCostPerMillion: 1, outputCostPerMillion: 2 }
  const feed = (models: unknown[]) => ({ currency: 'RMB', models })
  it.each([null, '', [''], ['^m$', '^m$'], ['^m.*$']])('invalidates the whole feed for aliasPatterns %j', aliasPatterns => {
    expect(coerceCloudPricing(feed([{ ...row, aliasPatterns }]))).toBeNull()
  })
  it('rejects case-only duplicate IDs even when a rate row would otherwise be skipped', () => {
    expect(coerceCloudPricing(feed([row, { modelId: 'M' }]))).toBeNull()
    expect(coerceCloudPricing(feed([{ modelId: 'bad', aliasPatterns: ['.*'] }]))).toBeNull()
  })
  it('keeps old feeds compatible and defaults overview patterns to []', () => {
    const data = coerceCloudPricing(feed([row]))!
    expect(pricingContextOf(data).models[0]?.aliasPatterns).toEqual([])
  })
  it('ignores deprecated aliases even when they collide with a new regex match', () => {
    const data = coerceCloudPricing(feed([
      { ...row, aliases: ['legacy', 'new-name'] },
      { ...row, modelId: 'n', aliasPatterns: ['^new-name$'] },
    ]))!
    expect(data.models[0]).not.toHaveProperty('aliases')
    const context = pricingContextOf(data)
    expect(context.resolveModel('legacy').status).toBe('unmatched')
    expect(context.resolveModel('provider/LEGACY').status).toBe('unmatched')
    expect(context.resolveModel('NEW-NAME')).toMatchObject({ modelId: 'n', method: 'pattern' })
    expect(context.models[0]).not.toHaveProperty('aliases')
  })
})
