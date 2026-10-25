/**
 * Quota orchestration tests: the payload variants (no-provider /
 * unsupported / no-credential / ok / error), the per-provider TTL cache
 * of ok results (errors do not cache), the in-flight dedupe, the model
 * scoping of gateway snapshots, and the magpie hello probe that rescues
 * an otherwise-unsupported route.
 */
import { describe, expect, it, vi } from 'vitest'
import { QuotaService } from '../src/quota/quota-service.ts'
import type { ResolvedQuotaCredentials } from '../src/quota/credentials.ts'
import type { ProviderSighting } from '../src/quota/provider-tracking.ts'

/** A stub transport answering one JSON body (or throwing). */
function fetchOf(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

/** The zhipu coding-plan body the ok-path assertions read. */
const ZHIPU_BODY = {
  data: { level: 'Lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 62.5, nextResetTime: 1_780_000_000_000 }] },
}

/** A minimal magpie quotas report (the fixture the magpie tests grow
 * from): one subscription card plus one balance card. */
const MAGPIE_BODY = {
  object: 'list',
  data: [
    {
      provider: 'zcode', name: 'ZCode', kind: 'subscription', plan: 'GLM Coding Lite', user: 'ZCode',
      windows: [
        { name: '5 hours', used: 100, remaining: 0, resetsAt: '2026-10-25T03:20:04Z', display: '2000 / 2000' },
        { name: 'Weekly', used: 66.97, remaining: 33.03, resetsAt: '2026-10-30T07:07:49Z', display: '6697 / 10000' },
      ],
      readAt: '2026-10-25T10:54:21+08:00',
    },
    {
      provider: 'deepseek', name: 'DeepSeek', kind: 'balance', windows: [], balance: '¥356.81',
      readAt: '2026-10-25T10:54:23+08:00',
    },
  ],
}

/** A sighting value or undefined, as the tracker seam answers it. */
function sightingOf(provider: string | undefined, model = ''): ProviderSighting | undefined {
  return provider === undefined ? undefined : { provider, model, at: 0 }
}

/** Service factory with the common seams pre-filled. */
function serviceOf(overrides: {
  provider?: string | undefined
  model?: string
  credentials?: ResolvedQuotaCredentials
  fetchFn?: typeof fetch
  now?: () => number
  cacheTtlMs?: number
} = {}) {
  const fetchFn = overrides.fetchFn ?? fetchOf(ZHIPU_BODY)
  const service = new QuotaService({
    resolveSighting: () => sightingOf(overrides.provider, overrides.model),
    resolveCredentials: async () => overrides.credentials ?? { apiKey: 'sk-test' },
    fetchFn,
    intervalSec: 30,
    ...(overrides.cacheTtlMs !== undefined ? { cacheTtlMs: overrides.cacheTtlMs } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  })
  return { service, fetchFn }
}

describe('QuotaService', () => {
  it('answers no-provider when nothing determinable is in use', async () => {
    const { service } = serviceOf({ provider: undefined })
    expect(await service.snapshot('s1')).toEqual({ status: 'no-provider', intervalSec: 30 })
  })

  it('lets the chip-selection hint win over the request tracker', async () => {
    const MINIMAX_BODY = {
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 30 }],
      base_resp: { status_code: 0 },
    }
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).includes('minimax') ? MINIMAX_BODY : ZHIPU_BODY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    // The tracker knows the last request went to Zhipu, but the model chip
    // now selects MiniMax — the hint is the user's live intent.
    const service = new QuotaService({
      resolveSighting: () => sightingOf('zai-coding-cn'),
      resolveCredentials: async () => ({ apiKey: 'sk-test' }),
      fetchFn,
      intervalSec: 30,
    })
    const payload = await service.snapshot('s1', 'minimax')
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'minimax',
      adapterId: 'minimax-coding-plan',
      windows: [{ tier: 'five_hour', usedPercent: 70 }],
    })
  })

  it('ignores a blank hint and falls back to the tracker', async () => {
    const { service } = serviceOf({ provider: 'zai-coding-cn' })
    const payload = await service.snapshot('s1', '')
    expect(payload).toMatchObject({ status: 'ok', provider: 'zai-coding-cn' })
  })

  it('answers unsupported for a provider no adapter handles', async () => {
    const { service } = serviceOf({
      provider: 'anthropic',
      credentials: { apiKey: 'sk', baseUrl: 'https://api.anthropic.com' },
    })
    expect(await service.snapshot()).toEqual({
      status: 'unsupported',
      provider: 'anthropic',
      intervalSec: 30,
    })
  })

  it('answers no-credential without touching the network', async () => {
    const { service, fetchFn } = serviceOf({
      provider: 'zai-coding-cn',
      credentials: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
    })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({
      status: 'error',
      provider: 'zai-coding-cn',
      adapterId: 'zhipu-coding-plan',
      error: { kind: 'no-credential', message: 'ZAI_CODING_CN_API_KEY' },
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('serves the ok payload stamped with identity and cadence', async () => {
    const { service } = serviceOf({ provider: 'zai-coding-cn' })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'zai-coding-cn',
      adapterId: 'zhipu-coding-plan',
      planTier: 'Lite',
      intervalSec: 30,
      windows: [{ tier: 'five_hour', usedPercent: 62.5 }],
    })
  })

  it('caches one provider result for the TTL window', async () => {
    const { service, fetchFn } = serviceOf({ provider: 'zai-coding-cn' })
    await service.snapshot()
    await service.snapshot()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('re-queries after the TTL expires and dedupes concurrent callers', async () => {
    let at = 1_000_000
    const { service, fetchFn } = serviceOf({
      provider: 'zai-coding-cn',
      cacheTtlMs: 100,
      now: () => at,
    })
    await service.snapshot()
    // Past the TTL, two concurrent snapshots share ONE in-flight query.
    at += 101
    await Promise.all([service.snapshot(), service.snapshot()])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    // Another expiry serves a fresh query again.
    at += 101
    await service.snapshot()
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('does not cache transport failures so a retry re-queries', async () => {
    const { service, fetchFn } = serviceOf({
      provider: 'zai-coding-cn',
      fetchFn: fetchOf({ message: 'no auth' }, 401),
    })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({ status: 'error', error: { kind: 'auth' } })
    const again = await service.snapshot()
    expect(again).toMatchObject({ status: 'error', error: { kind: 'auth' } })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('wraps a non-JSON body as a parse failure', async () => {
    const fetchFn = vi.fn(async () => new Response('not json', { status: 200 }))
    const { service } = serviceOf({ provider: 'zai-coding-cn', fetchFn })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({ status: 'error', error: { kind: 'parse' } })
  })

  it('serves separate cache slots per provider', async () => {
    const fetchFn = fetchOf(ZHIPU_BODY)
    let provider: string | undefined = 'zai-coding-cn'
    const service = new QuotaService({
      resolveSighting: () => sightingOf(provider),
      resolveCredentials: async () => ({ apiKey: 'sk' }),
      fetchFn,
      intervalSec: 60,
    })
    await service.snapshot()
    provider = 'deepseek-official'
    await service.snapshot()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('scopes one magpie route to separate cache slots per model', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(MAGPIE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    let model = 'zcode/glm-4.7'
    const service = new QuotaService({
      resolveSighting: () => sightingOf('magpie', model),
      resolveCredentials: async () => ({ baseUrl: 'http://127.0.0.1:3425/v1' }),
      fetchFn,
      intervalSec: 30,
    })
    // The model's provider prefix keeps its own cached card set; a
    // different model on the same route re-queries rather than serving
    // the other model's cards.
    await service.snapshot()
    model = 'deepseek/chat'
    await service.snapshot()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('scopes by the live chip model before a request and over a stale tracked model', async () => {
    const fetchFn = fetchOf(MAGPIE_BODY)
    const service = new QuotaService({
      resolveSighting: () => sightingOf('magpie', 'zcode/old'),
      resolveCredentials: async () => ({}),
      fetchFn,
    })
    const balance = await service.snapshot('s1', 'magpie', 'deepseek/chat')
    expect(balance).toMatchObject({ status: 'ok', windows: [{ tier: 'balance', card: 'DeepSeek' }] })
    if (balance.status !== 'ok') throw new Error('expected ok')
    expect(balance.windows).toHaveLength(1)
    const zcode = await service.snapshot('s1', 'magpie', 'zcode/glm-4.7')
    if (zcode.status !== 'ok') throw new Error('expected ok')
    expect(zcode.windows).toHaveLength(2)
    const fleet = await service.snapshot('s1', 'magpie', 'group/quick')
    if (fleet.status !== 'ok') throw new Error('expected ok')
    expect(fleet.windows).toHaveLength(3)
    expect(await service.snapshot('s1', 'magpie', 'deepseek/chat')).toEqual(balance)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    for (const call of fetchFn.mock.calls) {
      expect(String(call[0])).toContain('/v1/magpie/quotas?kept=1')
    }
    const fresh = new QuotaService({
      resolveSighting: () => undefined,
      resolveCredentials: async () => ({}),
      fetchFn,
    })
    expect(await fresh.snapshot('new', 'magpie', 'deepseek/chat')).toMatchObject({ windows: balance.windows })
    // A model with no paired provider hint must not override tracked intent.
    const unpaired = await service.snapshot('s1', undefined, 'deepseek/chat')
    if (unpaired.status !== 'ok') throw new Error('expected ok')
    expect(unpaired.windows).toHaveLength(2)
  })

  it('routes an unknown route to magpie when the base URL answers the hello', async () => {
    // A user-declared OpenAI-compatible profile named "my-gateway" at a
    // loopback port: no registry entry matches, so the service probes
    // the gateway's hello before answering unsupported.
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      const body = href.endsWith('/v1')
        ? { name: 'magpie', version: '1.0.0', models: 42 }
        : href.endsWith('/v1/magpie/quotas?kept=1')
          ? MAGPIE_BODY
          : { error: `unexpected ${href}` }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const service = new QuotaService({
      resolveSighting: () => sightingOf('my-gateway'),
      resolveCredentials: async () => ({ apiKey: 'gw-key', baseUrl: 'http://127.0.0.1:3425/v1' }),
      fetchFn,
      intervalSec: 30,
    })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'my-gateway',
      providerName: 'my-gateway · Magpie',
      adapterId: 'magpie-quotas',
    })
    // No model in the sighting: the whole fleet answers (both cards).
    if (payload.status !== 'ok') throw new Error('expected ok payload')
    expect(payload.windows.length).toBe(3)
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3425/v1')
  })

  it('keeps an unknown route unsupported when the hello is not magpie', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const service = new QuotaService({
      resolveSighting: () => sightingOf('lm-studio'),
      resolveCredentials: async () => ({ baseUrl: 'http://127.0.0.1:1234/v1' }),
      fetchFn,
      intervalSec: 30,
    })
    expect(await service.snapshot()).toEqual({
      status: 'unsupported',
      provider: 'lm-studio',
      intervalSec: 30,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('qualifies a host-matched custom route with the adapter family label', async () => {
    // A user-declared route named "OpenAI" whose base URL points at the
    // OpenCode Go endpoint: the adapter owns the QUOTA, so the alias gains
    // the family label instead of claiming the windows as OpenAI's.
    const { service } = serviceOf({
      provider: 'my-openai',
      credentials: { apiKey: 'sk-test', baseUrl: 'https://opencode.ai/zen/go/v1', displayName: 'OpenAI' },
      fetchFn: fetchOf({ usage: { rolling: { status: 'ok', percent: 12.5 }, weekly: { percent: 40 } } }),
    })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'my-openai',
      providerName: 'OpenAI · OpenCode Go',
      adapterId: 'opencode-go',
      windows: [{ tier: 'five_hour', usedPercent: 12.5 }, { tier: 'weekly', usedPercent: 40 }],
    })
  })

  it('falls back to the route key as the alias when no display name resolves', async () => {
    const { service } = serviceOf({
      provider: 'my-gw',
      credentials: { apiKey: 'sk-test', baseUrl: 'https://opencode.ai/zen/go/v1' },
      fetchFn: fetchOf({ usage: { rolling: { percent: 5 } } }),
    })
    expect(await service.snapshot()).toMatchObject({ providerName: 'my-gw · OpenCode Go' })
  })

  it('reads DeepSeek account wallets without an API key', async () => {
    const readAccountBalance = vi.fn(async () => ({
      status: 'ready' as const,
      value: [{ currency: 'CNY', balance: '42.00' }],
      bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
    }))
    const fetchFn = fetchOf(ZHIPU_BODY)
    const service = new QuotaService({
      resolveSighting: () => sightingOf('deepseek-account'),
      resolveCredentials: async () => ({ displayName: 'DeepSeek Account' }),
      fetchFn,
      readAccountBalance,
      intervalSec: 30,
    })
    const payload = await service.snapshot()
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'deepseek-account',
      providerName: 'DeepSeek Account',
      adapterId: 'deepseek-account',
      windows: [
        { tier: 'balance', remainingValue: 42, unit: 'cny', balanceKind: 'recharge' },
        { tier: 'balance', remainingValue: 5, unit: 'cny', balanceKind: 'bonus' },
      ],
    })
    expect(fetchFn).not.toHaveBeenCalled()
    await service.snapshot()
    expect(readAccountBalance).toHaveBeenCalledTimes(1)
  })

  it('keeps the plain display name for a catalog route the adapter owns', async () => {
    const { service } = serviceOf({
      provider: 'zai-coding-cn',
      credentials: { apiKey: 'sk-test', displayName: '智谱 Coding Plan' },
    })
    expect(await service.snapshot()).toMatchObject({ providerName: '智谱 Coding Plan' })
  })
})
