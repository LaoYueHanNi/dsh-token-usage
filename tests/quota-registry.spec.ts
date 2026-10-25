/**
 * Registry routing tests: provider route keys and base-URL hosts resolve
 * to the owning adapter (host match as the stronger signal), and unknown
 * providers resolve to undefined (the `unsupported` payload variant).
 */
import { describe, expect, it } from 'vitest'
import { QUOTA_ADAPTERS, resolveQuotaAdapter } from '../src/quota/registry.ts'

describe('resolveQuotaAdapter', () => {
  it('routes the built-in route keys', () => {
    expect(resolveQuotaAdapter({ provider: 'zai-coding-cn' })?.id).toBe('zhipu-coding-plan')
    expect(resolveQuotaAdapter({ provider: 'deepseek-official' })?.id).toBe('deepseek-balance')
    expect(resolveQuotaAdapter({ provider: 'deepseek-account' })?.id).toBe('deepseek-account')
    expect(resolveQuotaAdapter({ provider: 'openrouter' })?.id).toBe('openrouter-credits')
    expect(resolveQuotaAdapter({ provider: 'minimax' })?.id).toBe('minimax-coding-plan')
    expect(resolveQuotaAdapter({ provider: 'kimi-coding' })?.id).toBe('kimi-coding-plan')
    expect(resolveQuotaAdapter({ provider: 'opencode-go' })?.id).toBe('opencode-go')
    // The magpie route key claims its adapter outright; every other
    // gateway-shaped route waits for the service's probe.
    expect(resolveQuotaAdapter({ provider: 'magpie' })?.id).toBe('magpie-quotas')
  })

  it('does not claim gateway hosts without the probe', () => {
    // A loopback host is not evidence of magpie (other local gateways
    // live there too): only the route key or the detector's hello
    // verdict routes here — see quota-service.spec.ts.
    expect(resolveQuotaAdapter({ provider: 'my-gateway', baseUrl: 'http://127.0.0.1:3425/v1' })).toBeUndefined()
  })

  it('routes user-declared routes by base-URL host', () => {
    expect(resolveQuotaAdapter({ provider: 'my-gateway', baseUrl: 'https://api.kimi.com/coding/v1' })?.id).toBe('kimi-coding-plan')
    expect(resolveQuotaAdapter({ provider: 'my-gateway', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' })?.id).toBe('zhipu-coding-plan')
    expect(resolveQuotaAdapter({ provider: 'my-gateway', baseUrl: 'https://openrouter.ai/api/v1' })?.id).toBe('openrouter-credits')
    expect(resolveQuotaAdapter({ provider: 'my-gateway', baseUrl: 'https://opencode.ai/zen/go/v1' })?.id).toBe('opencode-go')
    expect(resolveQuotaAdapter({ provider: 'my-gateway', baseUrl: 'https://api.commandcode.ai/provider/v1' })?.id).toBe('command-code')
    expect(resolveQuotaAdapter({
      provider: 'deepseek-account',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })?.id).toBe('deepseek-account')
  })

  it('returns undefined for providers no adapter handles', () => {
    expect(resolveQuotaAdapter({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBeUndefined()
    expect(resolveQuotaAdapter({ provider: 'my-relay' })).toBeUndefined()
    // Command Code owns no catalog route: a bare name claims nothing,
    // the commandcode.ai host does.
    expect(resolveQuotaAdapter({ provider: 'command-code' })).toBeUndefined()
  })

  it('registers every adapter with a distinct id', () => {
    const ids = QUOTA_ADAPTERS.map(adapter => adapter.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
