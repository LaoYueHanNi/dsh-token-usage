import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cloudToTable,
  coerceCloudPricing,
  coercePricingTable,
  costOf,
  DEFAULT_PRICING_URL,
  DEFAULT_PRICING_URL_DOMESTIC,
  DEFAULT_PRICING_URL_OVERSEAS,
  ratesForKey,
  readPricingTable,
  readUsdExchangeRate,
  resolvePricingUrl,
  resolveRate,
  syncCloudPricing,
} from '../src/pricing.ts'
import type { ModelRates } from '../src/wire.ts'
import { hasRateRules } from '../src/wire.ts'
import type { UsageTotals } from '../src/wire.ts'

/** One totals row fixture. */
function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  }
}

/** A flat rule set (base rates only), the shape a manual entry produces. */
function flat(input: number, output: number, cacheRead?: number, cacheWrite?: number): ModelRates {
  return {
    base: {
      inputPerMillion: input,
      outputPerMillion: output,
      ...(cacheRead !== undefined ? { cacheReadPerMillion: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWritePerMillion: cacheWrite } : {}),
    },
    contextTiers: [],
    dailySlots: [],
    timeRules: [],
  }
}

describe('coercePricingTable', () => {
  it('accepts a flat model → rates map', () => {
    expect(coercePricingTable({
      'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
      'deepseek-reasoner': { inputPerMillion: 4, outputPerMillion: 16 },
    })).toEqual({
      'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
      'deepseek-reasoner': { inputPerMillion: 4, outputPerMillion: 16 },
    })
  })

  it('drops invalid entries and keeps valid ones', () => {
    expect(coercePricingTable({
      ok: { inputPerMillion: 1, outputPerMillion: 2 },
      'negative': { inputPerMillion: -1, outputPerMillion: 2 },
      'missing-output': { inputPerMillion: 1 },
      'string-rates': { inputPerMillion: '2', outputPerMillion: 8 },
      'null-cache': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: null },
      '': { inputPerMillion: 1, outputPerMillion: 2 },
    })).toEqual({ ok: { inputPerMillion: 1, outputPerMillion: 2 } })
  })

  it('reads non-object values as an empty table', () => {
    expect(coercePricingTable(null)).toEqual({})
    expect(coercePricingTable(undefined)).toEqual({})
    expect(coercePricingTable([{ inputPerMillion: 1, outputPerMillion: 2 }])).toEqual({})
    expect(coercePricingTable('nope')).toEqual({})
  })
})

describe('costOf', () => {
  it('bills each bucket at its own per-million rate', () => {
    const row = totals({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 250_000 })
    expect(costOf(row, { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 }))
      .toBe(2 + 4 + 0.125)
  })

  it('falls cache buckets back to the input rate when their rate is absent', () => {
    const row = totals({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })
    expect(costOf(row, { inputPerMillion: 2, outputPerMillion: 8 })).toBe(6)
  })

  it('supports zero and fractional rates', () => {
    const row = totals({ inputTokens: 2_000_000, outputTokens: 4_000_000 })
    expect(costOf(row, { inputPerMillion: 0.5, outputPerMillion: 0.25 })).toBe(1 + 1)
  })
})

describe('resolveRate (the analyzer rule chain)', () => {
  /** UTC+0 test tz: local minute == UTC minute. */
  const TZ = 0

  /** A model with every rule dimension, mirroring deepseek-v4-flash's shape. */
  const RULE_END = 1_786_710_000 // 2026-08-14 15:00 UTC
  const rules: ModelRates = {
    base: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 },
    contextTiers: [{ threshold: 512_000, rates: { inputPerMillion: 3, outputPerMillion: 9, cacheReadPerMillion: 0.1 } }],
    dailySlots: [{
      windows: [{ startMinute: 540, endMinute: 720 }],
      rates: { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.1 },
    }],
    timeRules: [{
      startTime: 0,
      endTime: RULE_END,
      rates: { inputPerMillion: 1.0, outputPerMillion: 2.0, cacheReadPerMillion: 0.02 },
      contextTiers: [{ threshold: 256_000, rates: { inputPerMillion: 2.0, outputPerMillion: 4.0, cacheReadPerMillion: 0.04 } }],
    }],
  }

  it('bills inside a time rule at the rule rates', () => {
    // 2026-08-14 12:00 UTC (past the 540..720 window), inside the rule span.
    const at = Date.UTC(2026, 7, 14, 12, 0, 0)
    const resolved = resolveRate(rules, at, 1000, TZ)
    expect(resolved.prices.inputPerMillion).toBe(1.0)
    expect(resolved.key).toEqual({ ruleStart: 0, ruleEnd: RULE_END, tier: 0, slot: -1 })
  })

  it('bills after the rule window at the base rates, peak window at peak rates', () => {
    // 2026-08-15 10:00 UTC — after the rule, inside the peak window (540..720).
    const peak = resolveRate(rules, Date.UTC(2026, 7, 15, 10, 0, 0), 1000, TZ)
    expect(peak.prices.inputPerMillion).toBe(3.0)
    expect(peak.key).toEqual({ ruleStart: 0, ruleEnd: 0, tier: 0, slot: 0 })
    // Same day off-peak (20:00 UTC) falls to the base rates.
    const off = resolveRate(rules, Date.UTC(2026, 7, 15, 20, 0, 0), 1000, TZ)
    expect(off.prices.inputPerMillion).toBe(1.5)
    expect(off.key.slot).toBe(-1)
  })

  it('matches the tier inside the time rule by input-side tokens', () => {
    // Inside the rule with enough context: rule tier rates apply (no slots on it).
    const at = Date.UTC(2026, 7, 14, 10, 0, 0)
    const big = resolveRate(rules, at, 300_000, TZ)
    expect(big.prices.inputPerMillion).toBe(2.0)
    expect(big.key).toEqual({ ruleStart: 0, ruleEnd: RULE_END, tier: 256_000, slot: -1 })
    // Below the tier: plain rule rates — the rule window bills flat even at
    // a peak minute, because slots hang on the node, not the root.
    const small = resolveRate(rules, at, 100_000, TZ)
    expect(small.prices.inputPerMillion).toBe(1.0)
    expect(small.key).toEqual({ ruleStart: 0, ruleEnd: RULE_END, tier: 0, slot: -1 })
  })

  it('matches the root tier once outside every rule', () => {
    const at = Date.UTC(2026, 7, 15, 20, 0, 0) // off-peak, past the rule
    const big = resolveRate(rules, at, 600_000, TZ)
    expect(big.prices.inputPerMillion).toBe(3)
    expect(big.key).toEqual({ ruleStart: 0, ruleEnd: 0, tier: 512_000, slot: -1 })
  })

  it('respects the local timezone for peak windows', () => {
    // 01:00 UTC is 09:00 at UTC+8 → inside the 09:00–12:00 local window;
    // 08:00 UTC is 16:00 at UTC+8 → outside it.
    const rulesUtc8 = { ...rules, timeRules: [], contextTiers: [] }
    const inside = resolveRate(rulesUtc8, Date.UTC(2026, 7, 15, 1, 0, 0), 0, 8)
    expect(inside.key.slot).toBe(0)
    const outside = resolveRate(rulesUtc8, Date.UTC(2026, 7, 15, 8, 0, 0), 0, 8)
    expect(outside.key.slot).toBe(-1)
  })

  it('ratesForKey re-prices an identity under the same table', () => {
    expect(ratesForKey(rules, { ruleStart: 0, ruleEnd: RULE_END, tier: 0, slot: -1 }).inputPerMillion).toBe(1.0)
    expect(ratesForKey(rules, { ruleStart: 0, ruleEnd: 0, tier: 0, slot: 0 }).inputPerMillion).toBe(3.0)
    expect(ratesForKey(rules, { ruleStart: 0, ruleEnd: 0, tier: 512_000, slot: -1 }).inputPerMillion).toBe(3)
  })

  it('ratesForKey falls back to the base rates on structural drift', () => {
    // The rule window no longer exists in a trimmed table.
    const trimmed: ModelRates = { ...rules, timeRules: [], contextTiers: [], dailySlots: [] }
    expect(ratesForKey(trimmed, { ruleStart: 0, ruleEnd: RULE_END, tier: 0, slot: -1 }).inputPerMillion).toBe(1.5)
  })
})

describe('readPricingTable', () => {
  it('yields an empty table when pricing.json is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-pricing-'))
    expect(await readPricingTable(dir)).toEqual({})
  })

  it('reads the user table as flat base rates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-pricing-'))
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({
      'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
      junk: { inputPerMillion: 'x', outputPerMillion: 1 },
    }))
    expect(await readPricingTable(dir)).toEqual({
      'deepseek-chat': flat(2, 8, 0.5),
    })
  })

  it('treats malformed JSON as an empty table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-pricing-'))
    await writeFile(join(dir, 'pricing.json'), '{not json')
    expect(await readPricingTable(dir)).toEqual({})
  })

  it('layers pricing.json over the synced cloud mirror, replacing rules wholesale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-pricing-'))
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({
      version: 4,
      updatedAt: 1_780_000_000,
      currency: 'RMB',
      models: [
        {
          modelId: 'deepseek-chat',
          inputCostPerMillion: 2, outputCostPerMillion: 8, cacheReadCostPerMillion: 0.5,
          dailySlots: [{ windows: [{ startMinute: 540, endMinute: 720 }], inputCostPerMillion: 4, outputCostPerMillion: 16 }],
        },
        { modelId: 'glm-5.2', inputCostPerMillion: 4, outputCostPerMillion: 16 },
      ],
    }))
    // The manual entry replaces chat's rules entirely; glm keeps its mirror entry.
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({
      'deepseek-chat': { inputPerMillion: 1, outputPerMillion: 4 },
      'kimi-k2': { inputPerMillion: 3, outputPerMillion: 12 },
    }))
    const merged = await readPricingTable(dir)
    expect(merged['deepseek-chat']).toEqual(flat(1, 4))
    expect(hasRateRules(merged['deepseek-chat']!)).toBe(false)
    expect(merged['glm-5.2']).toEqual(flat(4, 16))
    expect(merged['kimi-k2']).toEqual(flat(3, 12))
    expect(Object.keys(merged)).toHaveLength(3)
  })

  it('keeps the cloud rule chain (tiers, slots, time rules) through the merge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-pricing-'))
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({
      version: 57,
      updatedAt: 1,
      currency: 'RMB',
      models: [{
        modelId: 'deepseek-v4-flash',
        inputCostPerMillion: 1.5, outputCostPerMillion: 4.5, cacheReadCostPerMillion: 0.05,
        contextTiers: [{ threshold: 512000, inputCostPerMillion: 3, outputCostPerMillion: 9, cacheReadCostPerMillion: 0.1 }],
        dailySlots: [{ windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }], inputCostPerMillion: 3, outputCostPerMillion: 9, cacheReadCostPerMillion: 0.1 }],
        timeRules: [{ label: '原价', startTime: 0, endTime: 1786895999, inputCostPerMillion: 1, outputCostPerMillion: 2, cacheReadPerMillion: 0.02, cacheReadCostPerMillion: 0.02 }],
      }],
    }))
    const merged = await readPricingTable(dir)
    const rules = merged['deepseek-v4-flash']!
    expect(hasRateRules(rules)).toBe(true)
    expect(rules.timeRules[0]!.rates.inputPerMillion).toBe(1)
    expect(rules.contextTiers[0]!.threshold).toBe(512000)
    expect(rules.dailySlots[0]!.windows).toHaveLength(2)
  })
})

describe('coerceCloudPricing', () => {
  it('accepts an RMB feed and drops invalid model rows', () => {
    const feed = coerceCloudPricing({
      version: 4,
      updatedAt: 1_780_000_000,
      currency: 'RMB',
      models: [
        { modelId: 'deepseek-chat', inputCostPerMillion: 2, outputCostPerMillion: 8, aliases: ['deepseek-v3'] },
        { modelId: 'broken', inputCostPerMillion: -1, outputCostPerMillion: 2 },
        { inputCostPerMillion: 1, outputCostPerMillion: 2 },
      ],
    })
    expect(feed).not.toBeNull()
    expect(feed!.models).toHaveLength(1)
    expect(feed!.models[0]).toMatchObject({ modelId: 'deepseek-chat', aliases: ['deepseek-v3'] })
  })

  it('refuses non-RMB currencies and wrong envelopes', () => {
    expect(coerceCloudPricing({ version: 1, currency: 'USD', models: [] })).toBeNull()
    expect(coerceCloudPricing({ version: 1, models: [] })).toBeNull()
    expect(coerceCloudPricing({ models: 'nope' })).toBeNull()
    expect(coerceCloudPricing(null)).toBeNull()
  })

  it('parses a usable envelope exchange rate', () => {
    const feed = coerceCloudPricing({ version: 1, currency: 'RMB', usdExchangeRate: 7.25, models: [] })
    expect(feed).not.toBeNull()
    expect(feed!.usdExchangeRate).toBe(7.25)
  })

  it('drops missing, zero, negative, and non-numeric exchange rates', () => {
    const envelope = (rate: unknown) => coerceCloudPricing({ version: 1, currency: 'RMB', usdExchangeRate: rate, models: [] })
    expect(envelope(undefined)!.usdExchangeRate).toBeUndefined()
    expect(envelope(0)!.usdExchangeRate).toBeUndefined()
    expect(envelope(-1)!.usdExchangeRate).toBeUndefined()
    expect(envelope(NaN)!.usdExchangeRate).toBeUndefined()
    expect(envelope(Infinity)!.usdExchangeRate).toBeUndefined()
    expect(envelope('7')!.usdExchangeRate).toBeUndefined()
  })
})

describe('readUsdExchangeRate', () => {
  it('returns the mirror envelope rate when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-rate-'))
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({
      version: 4, updatedAt: 0, currency: 'RMB', usdExchangeRate: 7.3,
      models: [],
    }))
    expect(await readUsdExchangeRate(dir)).toBe(7.3)
  })

  it('falls back to the built-in rate without a mirror or a rate', async () => {
    const absent = await mkdtemp(join(tmpdir(), 'token-usage-rate-'))
    expect(await readUsdExchangeRate(absent)).toBe(7)
    const noprice = await mkdtemp(join(tmpdir(), 'token-usage-rate-'))
    await writeFile(join(noprice, 'pricing.ccsa.json'), JSON.stringify({
      version: 4, updatedAt: 0, currency: 'RMB', models: [],
    }))
    expect(await readUsdExchangeRate(noprice)).toBe(7)
  })

  it('falls back on a broken or non-RMB mirror', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'token-usage-rate-'))
    await writeFile(join(broken, 'pricing.ccsa.json'), 'not json')
    expect(await readUsdExchangeRate(broken)).toBe(7)
    const usd = await mkdtemp(join(tmpdir(), 'token-usage-rate-'))
    await writeFile(join(usd, 'pricing.ccsa.json'), JSON.stringify({ version: 1, currency: 'USD', models: [] }))
    expect(await readUsdExchangeRate(usd)).toBe(7)
  })
})

describe('cloudToTable', () => {
  it('maps fields, expands aliases, and keeps the rule chain', () => {
    const table = cloudToTable({
      version: 4,
      updatedAt: 0,
      currency: 'RMB',
      models: [{
        modelId: 'claude-sonnet-4-20250514',
        inputCostPerMillion: 21,
        outputCostPerMillion: 105,
        cacheReadCostPerMillion: 2.1,
        cacheCreationCostPerMillion: 26.25,
        aliases: ['claude-sonnet-4'],
        contextTiers: [{ threshold: 128000, inputCostPerMillion: 42, outputCostPerMillion: 210 }],
      }],
    })
    const expected: ModelRates = {
      base: { inputPerMillion: 21, outputPerMillion: 105, cacheReadPerMillion: 2.1, cacheWritePerMillion: 26.25 },
      contextTiers: [{ threshold: 128000, rates: { inputPerMillion: 42, outputPerMillion: 210 } }],
      dailySlots: [],
      timeRules: [],
    }
    expect(table['claude-sonnet-4']).toEqual(expected)
    expect(table['claude-sonnet-4-20250514']).toEqual(expected)
  })

  it('lets a model id win a collision with another model\'s alias', () => {
    const table = cloudToTable({
      version: 4,
      updatedAt: 0,
      currency: 'RMB',
      models: [
        { modelId: 'alias-holder', inputCostPerMillion: 1, outputCostPerMillion: 1, aliases: ['shared-name'] },
        { modelId: 'shared-name', inputCostPerMillion: 9, outputCostPerMillion: 9 },
      ],
    })
    expect(table['shared-name']!.base).toEqual({ inputPerMillion: 9, outputPerMillion: 9 })
  })
})

describe('resolvePricingUrl', () => {
  it('defaults to the domestic (gitee) mirror', () => {
    expect(resolvePricingUrl()).toBe(DEFAULT_PRICING_URL_DOMESTIC)
    expect(resolvePricingUrl({})).toBe(DEFAULT_PRICING_URL_DOMESTIC)
    expect(DEFAULT_PRICING_URL).toBe(DEFAULT_PRICING_URL_DOMESTIC)
  })

  it('picks the overseas (github) mirror for the overseas region', () => {
    expect(resolvePricingUrl({ pricingRegion: 'overseas' })).toBe(DEFAULT_PRICING_URL_OVERSEAS)
  })

  it('lets per-region overrides replace their default', () => {
    expect(resolvePricingUrl({ pricingUrlDomestic: 'https://a/feed.json' }))
      .toBe('https://a/feed.json')
    expect(resolvePricingUrl({ pricingRegion: 'overseas', pricingUrlOverseas: 'https://b/feed.json' }))
      .toBe('https://b/feed.json')
  })

  it('lets an explicit pricingUrl win over every region setting', () => {
    expect(resolvePricingUrl({
      pricingUrl: 'https://explicit/feed.json',
      pricingRegion: 'overseas',
      pricingUrlDomestic: 'https://a',
      pricingUrlOverseas: 'https://b',
    })).toBe('https://explicit/feed.json')
  })
})

describe('syncCloudPricing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A minimal RMB feed body. */
  const FEED = JSON.stringify({
    version: 4,
    updatedAt: 1_780_000_000,
    currency: 'RMB',
    models: [
      { modelId: 'deepseek-chat', inputCostPerMillion: 2, outputCostPerMillion: 8, aliases: ['deepseek-v3'] },
    ],
  })

  it('mirrors the feed verbatim and reports its shape', async () => {
    const fetch = vi.fn(async () => new Response(FEED))
    vi.stubGlobal('fetch', fetch)
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-sync-'))
    const result = await syncCloudPricing(dir, 'https://example.com/feed.json')
    expect(result).toEqual({ version: 4, updatedAt: 1_780_000_000, models: 1, aliases: 1, usdExchangeRate: 7 })
    expect(fetch).toHaveBeenCalledWith('https://example.com/feed.json', expect.anything())
    // The mirror keeps the raw feed (plus a trailing newline); the merged
    // read already reflects it.
    expect(await readFile(join(dir, 'pricing.ccsa.json'), 'utf8')).toBe(`${FEED}\n`)
    expect(await readPricingTable(dir)).toEqual({
      'deepseek-chat': flat(2, 8),
      'deepseek-v3': flat(2, 8),
    })
  })

  it('rejects a non-RMB feed without writing the mirror', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      version: 1, updatedAt: 0, currency: 'USD', models: [],
    }))))
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-sync-'))
    await expect(syncCloudPricing(dir, 'https://example.com/feed.json')).rejects.toThrow(/RMB/)
    expect(await readPricingTable(dir)).toEqual({})
  })

  it('surfaces HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-sync-'))
    await expect(syncCloudPricing(dir, 'https://example.com/feed.json')).rejects.toThrow(/503/)
  })

  it('creates a missing data directory before landing the mirror', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(FEED)))
    // A fresh install may not have a data dir yet (no usage recorded).
    const dir = join(tmpdir(), `token-usage-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const result = await syncCloudPricing(dir, 'https://example.com/feed.json')
    expect(result.models).toBe(1)
    expect(await readPricingTable(dir)).toEqual({
      'deepseek-chat': flat(2, 8),
      'deepseek-v3': flat(2, 8),
    })
  })
})
