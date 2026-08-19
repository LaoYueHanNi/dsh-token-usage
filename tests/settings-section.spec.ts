/**
 * Token-usage settings-section unit tests: the namespace constant and the
 * pricing-region schema's resolution.
 */
import { describe, expect, it } from 'vitest'
import { sectionSchema, TOKEN_USAGE_NS } from '../src/index.ts'

describe('TOKEN_USAGE_NS', () => {
  it('is the kebab-case plugin name', () => {
    expect(TOKEN_USAGE_NS).toBe('token-usage')
  })
})

describe('sectionSchema', () => {
  it('resolves an empty section to the inherited region', () => {
    expect(sectionSchema({})).toEqual({})
  })

  it('keeps the chosen region', () => {
    expect(sectionSchema({ pricingRegion: 'overseas' })).toEqual({ pricingRegion: 'overseas' })
    expect(sectionSchema({ pricingRegion: 'domestic' })).toEqual({ pricingRegion: 'domestic' })
  })

  it('rejects a region the union does not admit', () => {
    expect(() => sectionSchema({ pricingRegion: 'asia' })).toThrow()
  })
})
