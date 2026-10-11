import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pricingContextOf, readPricingContext, resolveRate, syncCloudPricing, type CloudPricingData, type CloudPricingModel, type PricingContext } from '../src/pricing.ts'
import { readRollup, writeRollup } from '../src/rollup.ts'
import { attachCosts, buildSummary, filterSummary, invalidateSummary, requestSeriesOf, summarizeRecords, type RateResolver } from '../src/stats.ts'
import { UNPRICED_KEY } from '../src/wire.ts'
import type { UsageRecord } from '../src/usage-record.ts'
import { PricingAssociationService } from '../src/pricing-association-service.ts'
import { ASSOCIATIONS_FILE } from '../src/pricing-associations.ts'
import { createPricingRoute, createStatsRoute } from '../src/stats-route.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const row: CloudPricingModel = { modelId: 'm', inputCostPerMillion: 1, outputCostPerMillion: 2 }
const feed = (models: CloudPricingModel[]): CloudPricingData => ({ currency: 'RMB', version: 1, updatedAt: 0, models })
const now = () => new Date(2026, 1, 1)
const at = (day = 12) => Date.UTC(2026, 0, day, 10)
const record = (model: string, time = at(), id = model): UsageRecord => ({ requestId: id, sessionId: 's', time, model, usage: { inputTokens: 1_000_000, outputTokens: 0 } })
const resolve = (context: PricingContext): RateResolver => r => {
  const rules = context.ratesForModel(r.model)
  return rules === undefined ? UNPRICED_KEY : resolveRate(rules, r.time, (r.usage?.inputTokens ?? 0) + (r.usage?.cacheReadTokens ?? 0) + (r.usage?.cacheWriteTokens ?? 0), 0).key
}
async function data(records: UsageRecord[] = [record('p/M-high')]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pricing-history-')); dirs.push(dir)
  await writeFile(join(dir, 'usage-2026-01-12.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n')
  return dir
}
async function build(dir: string, context: PricingContext, current = async () => true) {
  const summary = await buildSummary(dir, now, resolve(context), undefined, { fingerprint: context.fingerprint, isCurrent: current })
  return attachCosts(summary, context.table, context.canonical, context)
}
const rules = (): CloudPricingModel => ({ ...row, aliasPatterns: ['^m(-(low|high))?$'], timeRules: [{
  startTime: 0, endTime: Date.UTC(2026, 0, 20) / 1000, inputCostPerMillion: 3, outputCostPerMillion: 0,
  contextTiers: [{ threshold: 500_000, inputCostPerMillion: 4, outputCostPerMillion: 0,
    dailySlots: [{ windows: [{ startMinute: 540, endMinute: 720 }], daysOfWeek: [1], inputCostPerMillion: 5, outputCostPerMillion: 0 }] }],
}] })

describe('manual association historical repricing', () => {
  async function mutation(service: PricingAssociationService, target?: string) {
    const state = await service.read()
    return service.mutate(target === undefined ? 'delete' : 'save', { sourceModel: 'P/internal',
      ...(target === undefined ? {} : { targetModelId: target }), revision: state.revision, directoryToken: state.directoryToken })
  }
  it('save, rule edit, target edit and revoke rebuild frozen RateKeys and preserve raw usage', async () => {
    const records = [record('P/internal'), record('p/INTERNAL', at(17), 'second'), record('P/internal', at(22), 'third')]
    const dir = await data(records), path = join(dir, 'usage-2026-01-12.jsonl')
    const original = await readFile(path, 'utf8')
    const priced = rules(), free = { ...row, modelId: 'free', inputCostPerMillion: 0, outputCostPerMillion: 0 }
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([priced, free])))
    const service = new PricingAssociationService(() => dir)
    const before = await build(dir, await readPricingContext(dir))
    expect(before.unpricedModels).toEqual(['P/internal'])
    await mutation(service, 'm')
    const saved = await build(dir, await readPricingContext(dir))
    expect(saved.totalCost).toBe(10)
    expect(saved.byModel).toHaveLength(1)
    expect(saved.bySession.reduce((sum, cell) => sum + cell.cost, 0)).toBe(10)
    priced.timeRules![0]!.contextTiers![0]!.threshold = 2_000_000
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([priced, free])))
    expect((await build(dir, await readPricingContext(dir))).totalCost).toBe(7)
    await mutation(service, 'free')
    const changed = await build(dir, await readPricingContext(dir))
    expect(changed.totalCost).toBe(0)
    expect(changed.unpricedModels).toEqual([])
    expect(changed.byModel[0]?.model).toBe('free')
    await mutation(service)
    const revoked = await build(dir, await readPricingContext(dir))
    expect(revoked.unpricedModels).toEqual(['P/internal'])
    for (const result of [saved, changed, revoked]) expect(result.total).toEqual(before.total)
    expect(await readFile(path, 'utf8')).toBe(original)
  })
  it('association changes with missing sources retain usage and hide costs', async () => {
    const dir = await data([record('P/internal')])
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([rules()])))
    const before = await build(dir, await readPricingContext(dir))
    await unlink(join(dir, 'usage-2026-01-12.jsonl'))
    await mutation(new PricingAssociationService(() => dir), 'm')
    const changed = await build(dir, await readPricingContext(dir))
    expect(changed.costState).toBe('history-incomplete')
    expect(changed.total).toEqual(before.total)
    expect(changed.totalCost).toBe(0)
  })
  it('a corrupted association file disables manual prices but keeps automatic ones', async () => {
    const dir = await data([record('P/internal'), record('m', at(), 'automatic')])
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([row])))
    await mutation(new PricingAssociationService(() => dir), 'm')
    expect((await build(dir, await readPricingContext(dir))).totalCost).toBe(2)
    await writeFile(join(dir, ASSOCIATIONS_FILE), '{bad')
    const changed = await build(dir, await readPricingContext(dir))
    expect(changed).toMatchObject({ costState: 'ready', associationStorageError: 'invalid-json', totalCost: 1, unpricedModels: ['P/internal'] })
    expect(changed.total.requests).toBe(2)
  })
  it('revocation after automatic takeover keeps automatic pricing', async () => {
    const dir = await data([record('P/internal')])
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([row])))
    const service = new PricingAssociationService(() => dir)
    await mutation(service, 'm')
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([{ ...row, aliasPatterns: ['^internal$'], inputCostPerMillion: 8 }])))
    expect((await build(dir, await readPricingContext(dir))).totalCost).toBe(8)
    await mutation(service)
    expect((await build(dir, await readPricingContext(dir))).totalCost).toBe(8)
  })
  it('whole, filtered, session, chip, children and details share the manual identity', async () => {
    const records = [record('P/internal'), record('m', at(), 'direct'), { ...record('p/INTERNAL', at(), 'child-request'), sessionId: 'child' }, record('q/internal', at(), 'other')]
    const dir = await data(records)
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed([row])))
    await mutation(new PricingAssociationService(() => dir), 'm')
    async function get(route: WebRoute, query = '') {
      let body = '', status = 0
      const response = { writeHead: (code: number) => { status = code }, end: (value: string) => { body = value } } as unknown as ServerResponse
      await route.handler({ method: 'GET', headers: {}, url: '/token-usage/stats' + query } as IncomingMessage, response)
      expect(status).toBe(200)
      return JSON.parse(body)
    }
    const route = createStatsRoute(() => dir)
    const whole = await get(route)
    expect(whole.feedVersion).toBe(1)
    expect(whole.totalCost).toBe(3)
    expect(whole.total.requests).toBe(4)
    expect(whole.byModel.find((row: any) => row.model === 'm').totals.requests).toBe(3)
    expect(whole.modelResolutions.find((row: any) => row.rawName === 'P/internal')).toMatchObject({ method: 'manual', modelId: 'm' })
    expect(whole.pricing['P/internal']).toEqual(whole.pricing.m)
    const filtered = await get(route, '?model=P%2FINTERNAL')
    expect(filtered.totalCost).toBe(3)
    expect(filtered.total.requests).toBe(3)
    const session = await get(route, '?sessionId=s&sessionId=child&fields=session&childId=child&model=M')
    const chip = await get(route, '?sessionId=s&sessionId=child&fields=chip&model=m')
    expect(session.feedVersion).toBe(whole.feedVersion)
    expect(chip.feedVersion).toBe(whole.feedVersion)
    expect((await new PricingAssociationService(() => dir).read()).feedVersion).toBe(whole.feedVersion)
    expect(session.totalCost).toBe(3)
    expect(chip.totalCost).toBe(session.totalCost)
    expect(session.children.child.totalCost).toBe(1)
    expect(session.children.child.total.requests).toBe(1)
    expect(whole.sessionRows.reduce((sum: number, row: any) => sum + row.cost, 0)).toBe(3)
    const overview = await get(createPricingRoute(() => dir))
    expect(overview.feedVersion).toBe(whole.feedVersion)
    expect(overview.models.map((row: any) => row.modelId)).toEqual(['m'])
    expect(filtered.byModel.map((row: any) => row.model)).toEqual(['m'])
  })
})

describe('pricing history rebuild', () => {
  it('upgrades a legacy rollup from unpriced to per-request time/tier/weekday rules without changing usage', async () => {
    const records = [record('p/M-high'), record('M-LOW', at(17)), record('m', at(22))]
    const dir = await data(records)
    await writeRollup(dir, { upto: '2026-01-12', ...summarizeRecords(records) })
    const context = pricingContextOf(feed([rules()]))
    const summary = await build(dir, context)
    expect(summary.costState).toBe('ready')
    expect(summary.totalCost).toBe(5 + 4 + 1)
    expect(summary.total).toEqual(summarizeRecords(records).total)
    expect(summary.byModel).toHaveLength(1)
    expect(summary.bySession.reduce((sum, cell) => sum + cell.cost, 0)).toBe(10)
    expect((await readRollup(dir))?.pricingFingerprint).toBe(context.fingerprint)
    expect(await readFile(join(dir, 'usage-2026-01-12.jsonl'), 'utf8')).toBe(records.map(r => JSON.stringify(r)).join('\n') + '\n')
  })
  it('rebuilds previously unpriced frozen requests when a new regex lands', async () => {
    const dir = await data()
    const before = await build(dir, pricingContextOf(feed([row])))
    expect(before.unpricedModels).toEqual(['p/M-high'])
    const after = await build(dir, pricingContextOf(feed([rules()])))
    expect(after.total).toEqual(before.total)
    expect(after.totalCost).toBe(5)
    expect(after.modelResolutions[0]).toMatchObject({ modelId: 'm', method: 'pattern', strippedPrefix: true })
  })
  it('rule edits with an unchanged feed version reselect RateKeys', async () => {
    const dir = await data()
    expect((await build(dir, pricingContextOf(feed([rules()])))).totalCost).toBe(5)
    const updated = rules(); updated.timeRules![0]!.contextTiers![0]!.threshold = 2_000_000
    expect((await build(dir, pricingContextOf(feed([updated])))).totalCost).toBe(3)
  })
  it.each(['missing', 'corrupt', 'truncated'])('retains cached usage and hides all costs when historical sources are %s', async mode => {
    const dir = await data()
    const original = await build(dir, pricingContextOf(feed([rules()])))
    const path = join(dir, 'usage-2026-01-12.jsonl')
    if (mode === 'missing') await unlink(path)
    else await writeFile(path, mode === 'corrupt' ? JSON.stringify(record('p/M-high')) + '\n{bad\n' : '')
    const stored = await readFile(join(dir, 'rollup.json'), 'utf8')
    const changed = rules(); changed.inputCostPerMillion = 7
    const summary = await build(dir, pricingContextOf(feed([changed])))
    expect(summary.costState).toBe('history-incomplete')
    expect(summary.total).toEqual(original.total)
    expect(summary.totalCost).toBe(0)
    expect(summary.bySession.every(cell => cell.cost === 0)).toBe(true)
    expect(await readFile(join(dir, 'rollup.json'), 'utf8')).toBe(stored)
  })
  it('keeps available usage when the first raw log is malformed, without publishing an incomplete rollup', async () => {
    const dir = await data(); await writeFile(join(dir, 'usage-2026-01-12.jsonl'), JSON.stringify(record('m')) + '\n{bad\n')
    const summary = await build(dir, pricingContextOf(feed([row])))
    expect(summary.costState).toBe('history-incomplete')
    expect(summary.total.requests).toBe(1)
    expect(await readRollup(dir)).toBeNull()
  })
  it('retains usable totals from an older rollup without session cells when its raw history is lost', async () => {
    const dir = await data(); const legacy: Partial<ReturnType<typeof summarizeRecords>> & { upto: string } = { upto: '2026-01-12', ...summarizeRecords([record('m')]) }
    delete legacy.bySession
    await writeFile(join(dir, 'rollup.json'), JSON.stringify(legacy))
    await unlink(join(dir, 'usage-2026-01-12.jsonl'))
    const summary = await build(dir, pricingContextOf(feed([row])))
    expect(summary.costState).toBe('history-incomplete')
    expect(summary.total.requests).toBe(1)
    expect(summary.total.inputTokens).toBe(1_000_000)
    expect(summary.totalCost).toBe(0)
  })
  it('serializes rebuilds and prevents a queued old snapshot from overwriting the newer cache', async () => {
    const dir = await data()
    const old = pricingContextOf(feed([row])), latest = pricingContextOf(feed([rules()]))
    const [fresh, stale] = await Promise.all([build(dir, latest), build(dir, old, async () => false)])
    expect(fresh.totalCost).toBe(5)
    expect(stale.total.requests).toBe(1)
    expect((await readRollup(dir))?.pricingFingerprint).toBe(latest.fingerprint)
    const results = await Promise.all(Array.from({ length: 6 }, () => build(dir, latest)))
    expect(results.every(r => r.totalCost === 5 && r.total.requests === 1)).toBe(true)
  })
  it('queues history invalidation after an in-flight rebuild, then reads appended frozen records', async () => {
    const dir = await data()
    const context = pricingContextOf(feed([rules()]))
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(done => { entered = done })
    const barrier = new Promise<void>(done => { release = done })
    const first = build(dir, context, async () => { entered(); await barrier; return true })
    await waiting
    const invalidating = invalidateSummary(dir)
    release()
    await first; await invalidating
    expect(await readRollup(dir)).toBeNull()
    await writeFile(join(dir, 'usage-2026-01-12.jsonl'), [record('m'), record('p/m', at(), 'second')].map(r => JSON.stringify(r)).join('\n') + '\n')
    const next = await build(dir, context)
    expect(next.total.requests).toBe(2)
    expect(next.totalCost).toBe(10)
  })
  it('uses the same canonical result for folding, filtering, details and request series, while unknown providers stay independent', () => {
    const context = pricingContextOf(feed([rules(), { ...row, modelId: 'free', inputCostPerMillion: 0, outputCostPerMillion: 0 }]))
    const records = ['M', 'p/m', 'M-high', 'free', 'a/missing', 'A/MISSING', 'b/missing'].map(name => record(name))
    const raw = { dataDir: '/x', ...summarizeRecords(records, resolve(context)) }
    const summary = attachCosts(raw, context.table, context.canonical, context)
    expect(summary.byModel.map(r => r.model).sort()).toEqual(['a/missing', 'b/missing', 'free', 'm'])
    expect(summary.unpricedModels).toEqual(['a/missing', 'b/missing'])
    expect(summary.byModel.find(r => r.model === 'free')?.cost).toBe(0)
    const selected = attachCosts(filterSummary(raw, undefined, undefined, 'P/M-HIGH', context.canonical), context.table, context.canonical, context)
    expect(selected.total.requests).toBe(3)
    expect(selected.totalCost).toBe(15)
    expect(requestSeriesOf(records, undefined, undefined, 'M', context.canonical)).toHaveLength(3)
    expect(context.table['M-high']).toBe(context.table.m)
  })
})

describe('pricing snapshots', () => {
  it('preserves the detail dictionary and canonical index for unused legacy aliases', () => {
    const context = pricingContextOf(feed([{ ...row, aliases: ['legacy'], aliasPatterns: ['^m-high$'] }]))
    expect(context.table.legacy).toBe(context.table.m)
    expect([...context.canonical]).toContainEqual(['legacy', 'm'])
    expect(context.canonical.has('p/M-HIGH')).toBe(true)
    expect(context.canonical.get('p/M-HIGH')).toBe('m')
  })
  it('reuses compiled resolutions until source content changes and explains unavailable mirrors', async () => {
    const dir = await data(); const path = join(dir, 'pricing.ccsa.json')
    expect((await readPricingContext(dir)).unavailableReason).toBe('missing')
    await writeFile(path, '{bad')
    expect((await readPricingContext(dir)).unavailableReason).toBe('invalid-json')
    await writeFile(path, JSON.stringify(feed([{ ...row, aliasPatterns: ['^.*$'] }])))
    expect((await readPricingContext(dir)).unavailableReason).toBe('invalid-feed')
    await writeFile(path, JSON.stringify(feed([rules()])))
    const first = await readPricingContext(dir), second = await readPricingContext(dir)
    expect(first).toBe(second)
    expect(first.resolveModel('p/M-high')).toBe(second.resolveModel('p/M-high'))
    await writeFile(path, JSON.stringify(feed([row])))
    expect((await readPricingContext(dir)).resolveModel('p/M-high').status).toBe('unmatched')
  })
  it('fingerprints identification and rules, excluding metadata and exchange-only edits', () => {
    const base = feed([rules()]); const key = pricingContextOf(base).fingerprint
    expect(pricingContextOf({ ...base, version: 999, updatedAt: 999, usdExchangeRate: 8, models: [{ ...rules(), family: 'new' }] }).fingerprint).toBe(key)
    for (const model of [{ ...rules(), aliases: ['new'] }, { ...rules(), aliasPatterns: ['^new$'] }, { ...rules(), inputCostPerMillion: 9 }]) {
      expect(pricingContextOf(feed([model])).fingerprint).not.toBe(key)
    }
    expect(pricingContextOf(null).fingerprint).not.toBe(pricingContextOf(feed([])).fingerprint)
  })
  it('rejects an invalid synced regex without replacing the valid mirror', async () => {
    const dir = await data(); const path = join(dir, 'pricing.ccsa.json'); const original = JSON.stringify(feed([row]))
    await writeFile(path, original)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed([{ ...row, aliasPatterns: ['^.*$'] }])))))
    await expect(syncCloudPricing(dir, 'https://test/feed')).rejects.toThrow('valid RMB')
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
