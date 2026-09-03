import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDataDir, validateConfig, type Config } from '../src/index.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('validateConfig', () => {
  it('accepts an empty config', () => {
    expect(() => validateConfig({})).not.toThrow()
  })

  it('accepts a string path', () => {
    expect(() => validateConfig({ path: 'C:/data/token-usage' })).not.toThrow()
  })

  it('accepts a string pricingUrl', () => {
    expect(() => validateConfig({ pricingUrl: 'https://example.com/pricing.json' })).not.toThrow()
  })

  it('accepts the mirror URL keys and a region', () => {
    expect(() => validateConfig({
      pricingUrlDomestic: 'https://example.com/domestic.json',
      pricingUrlOverseas: 'https://example.com/overseas.json',
      pricingRegion: 'domestic',
    })).not.toThrow()
    expect(() => validateConfig({ pricingRegion: 'overseas' })).not.toThrow()
  })

  it('rejects a blank pricingUrl', () => {
    expect(() => validateConfig({ pricingUrl: '' })).toThrow(/non-empty string/)
  })

  it('rejects a blank mirror URL', () => {
    expect(() => validateConfig({ pricingUrlDomestic: '' })).toThrow(/non-empty string/)
    expect(() => validateConfig({ pricingUrlOverseas: '' })).toThrow(/non-empty string/)
  })

  it('rejects an invalid pricingRegion', () => {
    expect(() => validateConfig({ pricingRegion: 'asia' } as unknown as Config)).toThrow(/domestic.*overseas/)
  })

  it('rejects unknown keys', () => {
    expect(() => validateConfig({ foo: 1 } as unknown as Config)).toThrow(/unknown key "foo"/)
  })

  it('accepts a non-negative startup deferral and rejects a negative one', () => {
    expect(() => validateConfig({ startupDeferMs: 0 })).not.toThrow()
    expect(() => validateConfig({ startupDeferMs: 500 })).not.toThrow()
    expect(() => validateConfig({ startupDeferMs: -1 } as unknown as Config)).toThrow(/non-negative/)
  })

  it('accepts a non-negative settings-less startup cap and rejects a negative one', () => {
    expect(() => validateConfig({ startupCapMs: 0 })).not.toThrow()
    expect(() => validateConfig({ startupCapMs: 30_000 })).not.toThrow()
    expect(() => validateConfig({ startupCapMs: -1 } as unknown as Config)).toThrow(/non-negative/)
  })

  it('accepts a recordCompaction boolean and rejects a non-boolean', () => {
    expect(() => validateConfig({ recordCompaction: true })).not.toThrow()
    expect(() => validateConfig({ recordCompaction: false })).not.toThrow()
    expect(() => validateConfig({ recordCompaction: 1 } as unknown as Config)).toThrow(/recordCompaction/)
  })

  it('rejects a blank path', () => {
    expect(() => validateConfig({ path: '' })).toThrow(/non-empty string/)
  })

  it('rejects a non-string path', () => {
    expect(() => validateConfig({ path: 42 } as unknown as Config)).toThrow(/non-empty string/)
  })
})

describe('resolveDataDir', () => {
  it('prefers an explicit path', () => {
    expect(resolveDataDir('C:/data/token-usage')).toBe('C:/data/token-usage')
  })

  it('uses $DSH_HOME when set', () => {
    vi.stubEnv('DSH_HOME', 'D:/harness-home')
    expect(resolveDataDir(undefined)).toBe(join('D:/harness-home', 'token-usage'))
  })

  it('treats a blank $DSH_HOME as unset', () => {
    vi.stubEnv('DSH_HOME', '   ')
    expect(resolveDataDir(undefined)).toBe(join(homedir(), '.dsh', 'token-usage'))
  })

  it('falls back to ~/.dsh', () => {
    vi.stubEnv('DSH_HOME', undefined)
    expect(resolveDataDir(undefined)).toBe(join(homedir(), '.dsh', 'token-usage'))
  })
})
