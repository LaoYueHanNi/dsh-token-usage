import { describe, expect, it } from 'vitest'
import { compileAliasPattern, createModelResolver, providerSuffix } from '../src/model-resolution.ts'
import { coerceCloudPricing, pricingContextOf } from '../src/pricing.ts'

describe('model resolution', () => {
  const resolve = createModelResolver([
    { modelId: 'glm-5.3-flash', aliases: ['legacy'], aliasPatterns: ['^glm-5\\.3-flash(-(low|high))?$'] },
    { modelId: 'glm-5.3-flashx', aliases: ['GLM-5.3-FLASH'] },
    { modelId: 'provider/special', aliases: ['provider/legacy'] },
    { modelId: 'special' },
  ])
  it.each([
    ['GLM-5.3-FLASH', 'glm-5.3-flash', 'id'],
    ['LEGACY', 'glm-5.3-flash', 'alias'],
    ['P/NS/GLM-5.3-FLASH', 'glm-5.3-flash', 'normalized-id'],
    ['P/NS/LEGACY', 'glm-5.3-flash', 'normalized-alias'],
    ['GLM-5.3-FLASH-HIGH', 'glm-5.3-flash', 'pattern'],
    ['P/GLM-5.3-FLASH-LOW', 'glm-5.3-flash', 'pattern'],
    ['PROVIDER/SPECIAL', 'provider/special', 'id'],
    ['PROVIDER/LEGACY', 'provider/special', 'alias'],
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
  it('stops on shared aliases before normalization or regex', () => {
    const identify = createModelResolver([
      { modelId: 'a', aliases: ['p/m', 'shared'] }, { modelId: 'b', aliases: ['P/M', 'SHARED'] },
      { modelId: 'm', aliasPatterns: ['^shared$'] },
    ])
    expect(identify('p/m')).toMatchObject({ status: 'ambiguous', method: 'alias', candidates: ['a', 'b'], strippedPrefix: false })
    expect(identify('q/shared')).toMatchObject({ status: 'ambiguous', method: 'normalized-alias', candidates: ['a', 'b'] })
  })
  it('unions cross-model regex hits across both candidates, independent of feed order', () => {
    const models = [{ modelId: 'a', aliasPatterns: ['^p/alias$'] }, { modelId: 'b', aliasPatterns: ['^alias$'] }]
    expect(createModelResolver(models)('P/ALIAS')).toEqual(createModelResolver(models.toReversed())('P/ALIAS'))
    expect(createModelResolver(models)('P/ALIAS')).toMatchObject({ status: 'ambiguous', candidates: ['a', 'b'] })
  })
  it('normalized exact ID wins before a full-name regex', () => {
    expect(createModelResolver([{ modelId: 'm' }, { modelId: 'n', aliasPatterns: ['^p/m$'] }])('p/m').modelId).toBe('m')
  })
})

describe('portable alias pattern validation', () => {
  it.each(['foo', '^foo.*$', '^foo+$', '^foo{2}$', '^(?:foo)$', '^(?i:foo)$', '^(foo)\\1$', '^\\w$', '^[ab]$', '^foo|$', '^()$', '^foo??$', '^(foo$', '^foo)$', '^foo.$'])('rejects %j', pattern => {
    expect(() => compileAliasPattern(pattern)).toThrow()
  })
  it('supports escaped punctuation and nested optional groups', () => {
    expect(compileAliasPattern('^gpt-5\\.6(-(low|high))?$').test('GPT-5.6-HIGH')).toBe(true)
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
})
