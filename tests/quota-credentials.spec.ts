/**
 * Credential-chain unit tests: settings profile → apiKeyEnv → the layered
 * resolution (credentials seam → pi-ai record → process env), the built-in
 * directory fallback for the two known settings shapes, and the catalog
 * base-URL layering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveQuotaCredentials, withCatalogBaseUrl,
} from '../src/quota/credentials.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A settings reader over one flat namespace map. */
function settingsOf(sections: Record<string, unknown>) {
  return (ns: string): unknown => sections[ns]
}

describe('resolveQuotaCredentials', () => {
  it('resolves the key through the credentials seam when it holds the reference', async () => {
    const resolved = await resolveQuotaCredentials({
      provider: 'zai-coding-cn',
      readSettings: settingsOf({
        'llm-pi-ai': { providers: { 'zai-coding-cn': { apiKeyEnv: 'MY_ZAI_KEY' } } },
      }),
      resolveCredential: async ref => ref === 'MY_ZAI_KEY' ? 'sk-from-seam' : undefined,
      readRecord: async () => ({ key: 'sk-from-record' }),
    })
    expect(resolved.apiKey).toBe('sk-from-seam')
    expect(resolved.apiKeyEnv).toBe('MY_ZAI_KEY')
  })

  it('falls back to the pi-ai record store, then the process environment', async () => {
    const viaRecord = await resolveQuotaCredentials({
      provider: 'zai-coding-cn',
      readSettings: settingsOf({}),
      readRecord: async key => key === 'llm-pi-ai/zai-coding-cn' ? { key: 'sk-from-record' } : undefined,
    })
    expect(viaRecord.apiKey).toBe('sk-from-record')

    vi.stubEnv('ZAI_CODING_CN_API_KEY', 'sk-from-env')
    const viaEnv = await resolveQuotaCredentials({
      provider: 'zai-coding-cn',
      readSettings: settingsOf({}),
    })
    expect(viaEnv.apiKey).toBe('sk-from-env')
    expect(viaEnv.apiKeyEnv).toBe('ZAI_CODING_CN_API_KEY')
  })

  it('uses the catalog env name for kimi-coding (not the generic mangling)', async () => {
    vi.stubEnv('KIMI_API_KEY', 'sk-kimi')
    const resolved = await resolveQuotaCredentials({
      provider: 'kimi-coding',
      readSettings: settingsOf({}),
    })
    expect(resolved.apiKey).toBe('sk-kimi')
    expect(resolved.apiKeyEnv).toBe('KIMI_API_KEY')
  })

  it('uses the catalog env name for opencode-go (not the generic mangling)', async () => {
    vi.stubEnv('OPENCODE_API_KEY', 'sk-opencode')
    const resolved = await resolveQuotaCredentials({
      provider: 'opencode-go',
      readSettings: settingsOf({}),
    })
    expect(resolved.apiKey).toBe('sk-opencode')
    expect(resolved.apiKeyEnv).toBe('OPENCODE_API_KEY')
  })

  it('walks the directory entry first and carries its display name', async () => {
    vi.stubEnv('ZAI_CODING_CN_API_KEY', 'sk-dir')
    const resolved = await resolveQuotaCredentials({
      provider: 'zai-coding-cn',
      directory: () => ({
        settingsNs: 'custom-ns',
        settingsPath: ['providers', 'zai-coding-cn'],
        displayName: '智谱 Coding Plan',
      }),
      readSettings: settingsOf({
        'custom-ns': { providers: { 'zai-coding-cn': { baseURL: 'https://bigmodel.cn/api/coding' } } },
      }),
    })
    expect(resolved.apiKey).toBe('sk-dir')
    expect(resolved.baseUrl).toBe('https://bigmodel.cn/api/coding')
    expect(resolved.displayName).toBe('智谱 Coding Plan')
  })

  it('uses the llm-deepseek section shape for the official route', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds')
    const resolved = await resolveQuotaCredentials({
      provider: 'deepseek-official',
      readSettings: settingsOf({ 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1' } }),
    })
    expect(resolved.apiKey).toBe('sk-ds')
    expect(resolved.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('leaves the key undefined when no layer holds one', async () => {
    const resolved = await resolveQuotaCredentials({
      provider: 'zai-coding-cn',
      readSettings: settingsOf({}),
    })
    expect(resolved.apiKey).toBeUndefined()
    expect(resolved.apiKeyEnv).toBe('ZAI_CODING_CN_API_KEY')
  })

  it('generic route keys derive the pi-ai env-name convention', async () => {
    vi.stubEnv('MY_GATEWAY_API_KEY', 'sk-generic')
    const resolved = await resolveQuotaCredentials({
      provider: 'my-gateway',
      readSettings: settingsOf({}),
    })
    expect(resolved.apiKey).toBe('sk-generic')
    expect(resolved.apiKeyEnv).toBe('MY_GATEWAY_API_KEY')
  })
})

describe('withCatalogBaseUrl', () => {
  it('fills the catalog endpoint for known coding-plan routes', () => {
    expect(withCatalogBaseUrl('zai-coding-cn', { apiKeyEnv: 'X' }).baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(withCatalogBaseUrl('zai', { apiKeyEnv: 'X' }).baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(withCatalogBaseUrl('kimi-coding', { apiKeyEnv: 'X' }).baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(withCatalogBaseUrl('minimax', { apiKeyEnv: 'X' }).baseUrl).toBe('https://api.minimax.io/v1')
    expect(withCatalogBaseUrl('minimax-cn', { apiKeyEnv: 'X' }).baseUrl).toBe('https://api.minimaxi.com/v1')
    expect(withCatalogBaseUrl('opencode-go', { apiKeyEnv: 'X' }).baseUrl).toBe('https://opencode.ai/zen/go/v1')
  })

  it('keeps a resolved base URL and leaves unknown routes alone', () => {
    expect(withCatalogBaseUrl('zai', { apiKeyEnv: 'X', baseUrl: 'https://relay.example' }).baseUrl).toBe('https://relay.example')
    expect(withCatalogBaseUrl('my-gateway', { apiKeyEnv: 'X' }).baseUrl).toBeUndefined()
  })
})
