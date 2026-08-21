/**
 * Token-usage settings-section unit tests: the namespace constant, the
 * section schema's resolution (the data directory and the pricing-region
 * pick), the validator behind the empty-path refusal, and the guard verdict
 * the card's pre-save check renders.
 */
import { describe, expect, it } from 'vitest'
import { countInteractingSessions, directoryGuard, resolveDataDir, sectionSchema, TOKEN_USAGE_NS, validateSection, validateSectionChange } from '../src/index.ts'

describe('TOKEN_USAGE_NS', () => {
  it('is the kebab-case plugin name', () => {
    expect(TOKEN_USAGE_NS).toBe('token-usage')
  })
})

describe('sectionSchema', () => {
  it('resolves an empty section to the inherited values', () => {
    expect(sectionSchema({})).toEqual({})
  })

  it('keeps the chosen region', () => {
    expect(sectionSchema({ pricingRegion: 'overseas' })).toEqual({ pricingRegion: 'overseas' })
    expect(sectionSchema({ pricingRegion: 'domestic' })).toEqual({ pricingRegion: 'domestic' })
  })

  it('rejects a region the union does not admit', () => {
    expect(() => sectionSchema({ pricingRegion: 'asia' })).toThrow()
  })

  it('keeps a stored data directory', () => {
    expect(sectionSchema({ path: '/data/usage' })).toEqual({ path: '/data/usage' })
  })

  it('carries both fields through one resolution', () => {
    expect(sectionSchema({ path: '/data/usage', pricingRegion: 'overseas' }))
      .toEqual({ path: '/data/usage', pricingRegion: 'overseas' })
  })
})

describe('validateSection', () => {
  it('accepts an absent path (the default location applies)', () => {
    expect(() => validateSection({})).not.toThrow()
    expect(() => validateSection({ pricingRegion: 'overseas' })).not.toThrow()
  })

  it('accepts a non-empty path', () => {
    expect(() => validateSection({ path: '/data/usage' })).not.toThrow()
  })

  it('rejects an empty stored path', () => {
    expect(() => validateSection({ path: '' })).toThrow('non-empty')
  })
})

describe('validateSectionChange', () => {
  const running = { runningDir: 'D:/running', interactingSessions: 0 }

  it('refuses a directory change while sessions converse', () => {
    expect(() => validateSectionChange({ path: 'D:/elsewhere' }, { ...running, interactingSessions: 2 }))
      .toThrow(/session/)
  })

  it('allows the same directory regardless of sessions', () => {
    expect(() => validateSectionChange({ path: 'D:/running' }, { ...running, interactingSessions: 2 })).not.toThrow()
    // Absent path resolves to the default; only a DIFFERENT directory vetoes.
    expect(() => validateSectionChange({}, { runningDir: undefined, interactingSessions: 2 })).not.toThrow()
  })

  it('allows region-only edits while sessions converse', () => {
    expect(() => validateSectionChange({ path: 'D:/running', pricingRegion: 'overseas' }, running)).not.toThrow()
  })

  it('allows a directory change once no session converses', () => {
    expect(() => validateSectionChange({ path: 'D:/elsewhere' }, running)).not.toThrow()
  })

  it('still rejects an empty path first', () => {
    expect(() => validateSectionChange({ path: '' }, running)).toThrow('non-empty')
  })
})

describe('countInteractingSessions', () => {
  it('counts sessions whose log ends inside an open turn, ignoring idle ones', () => {
    // Existence alone must not count: an idle session stays in the store
    // after its conversation ended, and only an open turn keeps appending.
    const openTurn = [{ type: 'user/message' }, { type: 'turn/start' }]
    const closedTurn = [{ type: 'turn/start' }, { type: 'user/message' }, { type: 'turn/end' }]
    const reopened = [...closedTurn, { type: 'turn/start' }]
    expect(countInteractingSessions([])).toBe(0)
    expect(countInteractingSessions([{ events: [] }, { events: [{ type: 'session/title' }] }])).toBe(0)
    expect(countInteractingSessions([{ events: closedTurn }, { events: [{ type: 'session/title' }] }])).toBe(0)
    expect(countInteractingSessions([{ events: openTurn }, { events: closedTurn }])).toBe(1)
    expect(countInteractingSessions([{ events: reopened }, { events: openTurn }])).toBe(2)
  })
})

describe('directoryGuard', () => {
  const running = { runningDir: 'D:/running', interactingSessions: 0 }

  it('blocks a directory change exactly while sessions converse, counting them', () => {
    expect(directoryGuard('D:/elsewhere', { ...running, interactingSessions: 2 }))
      .toEqual({ blocked: true, interactingSessions: 2 })
    expect(directoryGuard('D:/elsewhere', running)).toEqual({ blocked: false, interactingSessions: 0 })
  })

  it('never blocks the same directory, a clear running on the default, or the first adoption', () => {
    expect(directoryGuard('D:/running', { ...running, interactingSessions: 3 })).toEqual({ blocked: false, interactingSessions: 3 })
    // A clear resolves back through the default: a no-op only while the
    // default is what runs; from an explicit directory it is a move.
    expect(directoryGuard(undefined, { runningDir: resolveDataDir(undefined), interactingSessions: 3 }))
      .toEqual({ blocked: false, interactingSessions: 3 })
    expect(directoryGuard(undefined, { ...running, interactingSessions: 3 }))
      .toEqual({ blocked: true, interactingSessions: 3 })
    // No running directory yet: the first start adopts the stored path.
    expect(directoryGuard('D:/elsewhere', { runningDir: undefined, interactingSessions: 3 }))
      .toEqual({ blocked: false, interactingSessions: 3 })
  })
})
