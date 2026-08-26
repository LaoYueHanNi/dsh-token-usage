/**
 * Quota orchestration tests: the payload variants (no-provider /
 * unsupported / no-credential / ok / error), the per-provider TTL cache
 * of ok results (errors do not cache), and the in-flight dedupe.
 */
import { describe, expect, it, vi } from 'vitest'
import { QuotaService } from '../src/quota/quota-service.ts'
import type { ResolvedQuotaCredentials } from '../src/quota/credentials.ts'

/** A stub transport answering one JSON body (or throwing). */
function fetchOf(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

/** The zhipu coding-plan body the ok-path assertions read. */
const ZHIPU_BODY = {
  data: { level: 'Lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 62.5, nextResetTime: 1_780_000_000_000 }] },
}

/** Service factory with the common seams pre-filled. */
function serviceOf(overrides: {
  provider?: string | undefined
  credentials?: ResolvedQuotaCredentials
  fetchFn?: typeof fetch
  now?: () => number
  cacheTtlMs?: number
} = {}) {
  const fetchFn = overrides.fetchFn ?? fetchOf(ZHIPU_BODY)
  const service = new QuotaService({
    resolveProvider: () => overrides.provider,
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
      resolveProvider: () => 'zai-coding-cn',
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
      resolveProvider: () => provider,
      resolveCredentials: async () => ({ apiKey: 'sk' }),
      fetchFn,
      intervalSec: 60,
    })
    await service.snapshot()
    provider = 'deepseek-official'
    await service.snapshot()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
