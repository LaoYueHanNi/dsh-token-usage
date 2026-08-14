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

  it('rejects unknown keys', () => {
    expect(() => validateConfig({ foo: 1 } as unknown as Config)).toThrow(/unknown key "foo"/)
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
