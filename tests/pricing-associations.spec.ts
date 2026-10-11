import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PricingAssociationService } from '../src/pricing-association-service.ts'
import { createPricingAssociationsRoute } from '../src/pricing-associations-route.ts'
import { ASSOCIATIONS_FILE, associationWritesPaused, coerceAssociations, readAssociations, withPricingDirectoryMigration, withPricingDirectoryWrite } from '../src/pricing-associations.ts'
import { coerceCloudPricing, pricingContextOf, readPricingContext, syncCloudPricing } from '../src/pricing.ts'

const feed = { currency: 'RMB', version: 1, models: [
  { modelId: 'a', aliasPatterns: ['^old-a$', '^shared$'], inputCostPerMillion: 1, outputCostPerMillion: 2 },
  { modelId: 'b', aliasPatterns: ['^shared$'], inputCostPerMillion: 3, outputCostPerMillion: 4 },
] }
const file = (associations = [{ sourceModel: 'P/internal', targetModelId: 'a' }], revision = 1) => ({ version: 1 as const, revision, associations })
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let dir: string
let service: PricingAssociationService
const homes: string[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pricing-associations-')); homes.push(dir)
  await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed))
  service = new PricingAssociationService(() => dir, log)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function save(sourceModel = 'P/internal', targetModelId = 'a') {
  const current = await service.read()
  return service.mutate('save', { sourceModel, targetModelId, revision: current.revision, directoryToken: current.directoryToken })
}
async function revoke(sourceModel = 'P/internal') {
  const current = await service.read()
  return service.mutate('delete', { sourceModel, revision: current.revision, directoryToken: current.directoryToken })
}

describe('association disk schema', () => {
  it.each([
    null, [], {}, { ...file(), version: 2 }, { ...file(), revision: -1 }, { ...file(), revision: 1.1 },
    { ...file(), revision: Number.MAX_SAFE_INTEGER + 1 }, { ...file(), extra: true },
    { ...file(), associations: null }, file([{ sourceModel: '', targetModelId: 'a' }]),
    file([{ sourceModel: 'p\nname', targetModelId: 'a' }]), file([{ sourceModel: 'p', targetModelId: 'a\u0000' }]),
    file([{ sourceModel: 'p\u007f', targetModelId: 'a' }]), file([{ sourceModel: 'p\u2028', targetModelId: 'a' }]),
    file([{ sourceModel: 'p', targetModelId: 'a' }, { sourceModel: 'P', targetModelId: 'b' }]),
    { ...file(), associations: [{ sourceModel: 'p', targetModelId: 'a', price: 2 }] },
  ])('refuses invalid choices without coercion: %j', value => expect(coerceAssociations(value)).toBeNull())
  it('missing is revision zero; keeps complete names and spelling', async () => {
    expect(await readAssociations(dir)).toMatchObject({ state: 'ready', file: file([], 0) })
    expect(coerceAssociations(file([{ sourceModel: ' p//Name ', targetModelId: 'A' }]))).toEqual(file([{ sourceModel: ' p//Name ', targetModelId: 'A' }]))
  })
  it.each(['{broken', JSON.stringify({ ...file(), version: 9 })])('reports and preserves malformed files %s', async text => {
    await writeFile(join(dir, ASSOCIATIONS_FILE), text)
    const current = await service.read()
    expect(current).toMatchObject({ storageState: 'unavailable', revision: null, pricingAvailable: true })
    await expect(service.mutate('save', { sourceModel: 'p', targetModelId: 'a', revision: 0, directoryToken: current.directoryToken })).rejects.toMatchObject({ code: 'association-storage-unavailable' })
    expect(await readFile(join(dir, ASSOCIATIONS_FILE), 'utf8')).toBe(text)
    expect((await readPricingContext(dir)).resolveModel('A').status).toBe('matched')
  })
  it('unreadable storage is distinct from absent', async () => {
    await mkdir(join(dir, ASSOCIATIONS_FILE))
    expect(await service.read()).toMatchObject({ storageState: 'unavailable', storageError: 'unreadable' })
  })
})

describe('association service lifecycle', () => {
  it('persists, edits, revokes case-insensitively across restart; provider scope is exact', async () => {
    expect(await save('P/Internal', 'A')).toMatchObject({ revision: 1, resolution: { method: 'manual', modelId: 'a' } })
    service = new PricingAssociationService(() => dir, log)
    const context = await readPricingContext(dir)
    expect(context.resolveModel('p/INTERNAL')).toMatchObject({ method: 'manual', modelId: 'a', strippedPrefix: false })
    for (const name of ['internal', 'q/internal', 'p/ns/internal', 'p/internal-fast']) expect(context.resolveModel(name).status).toBe('unmatched')
    expect(await save('p/internal', 'B')).toMatchObject({ revision: 2, associations: [{ sourceModel: 'P/Internal', targetModelId: 'b' }] })
    expect(await revoke('P/INTERNAL')).toMatchObject({ revision: 3, associations: [], resolution: { status: 'unmatched' } })
    expect(await revoke()).toMatchObject({ revision: 3 })
  })
  it('idempotent saves do not increment revision; stale idempotent requests still conflict', async () => {
    const initial = await service.read()
    await save()
    expect(await save('p/INTERNAL', 'A')).toMatchObject({ revision: 1 })
    await expect(service.mutate('save', { sourceModel: 'P/internal', targetModelId: 'a', revision: 0, directoryToken: initial.directoryToken })).rejects.toMatchObject({ code: 'revision-conflict' })
  })
  it('only real model IDs are targets; never aliases or association chains', async () => {
    for (const target of ['old-a', 'shared', 'missing']) await expect(save('internal', target)).rejects.toMatchObject({ code: 'target-unavailable' })
    await save()
    await expect(save('q/internal', 'P/internal')).rejects.toMatchObject({ code: 'target-unavailable' })
  })
  it.each(['A', 'OLD-A', 'P/a'])('rejects automatically priced sources %s', async source => {
    await expect(save(source)).rejects.toMatchObject({ code: 'source-automatically-priced' })
  })
  it('allows an ambiguous source and retains its automatic candidates', async () => {
    const saved = await save('SHARED', 'b')
    expect(saved.resolution).toMatchObject({ method: 'manual', modelId: 'b', automatic: { status: 'ambiguous', candidates: ['a', 'b'] } })
  })
  it.each(['a', 'b'])('automatic takeover of %s wins, retains choice and later reactivates', async target => {
    await save('P/internal', target)
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({ ...feed, models: [
      { ...feed.models[0], aliasPatterns: ['^internal$'] }, feed.models[1],
    ] }))
    expect((await service.read('p/INTERNAL')).resolution).toMatchObject({ method: 'pattern', modelId: 'a', association: { state: 'automatic-takeover', automaticModelId: 'a', targetDiffers: target !== 'a' } })
    await expect(save('P/internal', 'b')).rejects.toMatchObject({ code: 'source-automatically-priced' })
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify(feed))
    expect((await service.read('P/internal')).resolution).toMatchObject({ method: 'manual', modelId: target, association: { state: 'active' } })
  })
  it('target rename through alias stays invalid; case-only rename stays active', async () => {
    await save()
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({ ...feed, models: [{ ...feed.models[0], modelId: 'new-a', aliasPatterns: ['^a$'] }] }))
    expect((await service.read('P/internal')).resolution).toMatchObject({ status: 'unmatched', association: { state: 'target-missing' } })
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({ ...feed, models: [{ ...feed.models[0], modelId: 'A' }] }))
    expect((await service.read('P/internal')).resolution).toMatchObject({ method: 'manual', modelId: 'A' })
  })
  it('can revoke inactive or automatically taken-over associations without pricing', async () => {
    await save()
    await unlink(join(dir, 'pricing.ccsa.json'))
    expect(await service.read()).toMatchObject({ pricingAvailable: false, associations: [{ state: 'pricing-unavailable' }] })
    await expect(save()).rejects.toMatchObject({ code: 'pricing-unavailable' })
    expect(await revoke()).toMatchObject({ revision: 2, associations: [] })
  })
  it('returns saved entries even without matching usage', async () => {
    await save('unused', 'a')
    expect((await service.read()).associations).toHaveLength(1)
  })
  it('fingerprint includes semantic association content, excludes revision and case spelling', () => {
    const data = coerceCloudPricing(feed)!
    const context = (f: ReturnType<typeof file>) => pricingContextOf(data, 'missing', { state: 'ready', source: JSON.stringify(f), file: f })
    const first = context(file())
    expect(first.fingerprint).toBe(context(file([{ sourceModel: 'p/INTERNAL', targetModelId: 'A' }], 9)).fingerprint)
    expect(first.fingerprint).not.toBe(context(file([{ sourceModel: 'P/internal', targetModelId: 'b' }])).fingerprint)
    expect(first.fingerprint).not.toBe(context(file([])).fingerprint)
  })
})

describe('association concurrency and failure', () => {
  it('two parallel saves with one revision have exactly one winner', async () => {
    const current = await service.read()
    const results = await Promise.allSettled(['a', 'b'].map(targetModelId => service.mutate('save', { sourceModel: 'internal', targetModelId, revision: 0, directoryToken: current.directoryToken })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'revision-conflict' } })
    expect(await service.read()).toMatchObject({ revision: 1, associations: [{ state: 'active' }] })
  })
  it('rechecks automatic source and target against the feed at commit time', async () => {
    const current = await service.read()
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({ ...feed, models: [{ ...feed.models[0], aliasPatterns: ['^internal$'] }] }))
    await expect(service.mutate('save', { sourceModel: 'internal', targetModelId: 'a', revision: 0, directoryToken: current.directoryToken })).rejects.toMatchObject({ code: 'source-automatically-priced' })
  })
  it('failed writes preserve choices and the queue remains usable', async () => {
    await save()
    const before = await readFile(join(dir, ASSOCIATIONS_FILE), 'utf8')
    await mkdir(join(dir, `${ASSOCIATIONS_FILE}.tmp`))
    await expect(save('P/internal', 'b')).rejects.toThrow()
    expect(await readFile(join(dir, ASSOCIATIONS_FILE), 'utf8')).toBe(before)
    await rm(join(dir, `${ASSOCIATIONS_FILE}.tmp`), { recursive: true })
    expect(await save('P/internal', 'b')).toMatchObject({ revision: 2 })
  })
  it('rejects old directory forms including a round trip with unchanged revision', async () => {
    const firstDir = dir, initial = await service.read()
    dir = await mkdtemp(join(tmpdir(), 'pricing-associations-new-')); homes.push(dir)
    service.directoryChanged()
    dir = firstDir; service.directoryChanged()
    await expect(service.mutate('delete', { sourceModel: 'internal', revision: 0, directoryToken: initial.directoryToken })).rejects.toMatchObject({ code: 'directory-conflict' })
  })
  it('migration pauses writes synchronously, drains accepted writes, resumes after failure', async () => {
    const other = await mkdtemp(join(tmpdir(), 'pricing-associations-move-')); homes.push(other)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const accepted = withPricingDirectoryWrite(dir, async () => { await gate; return 'landed' })
    let entered = false
    const moving = withPricingDirectoryMigration(dir, other, async () => { entered = true; throw new Error('copy failed') })
    expect(associationWritesPaused(dir)).toBe(true)
    await expect(syncCloudPricing(dir, 'https://example.test/feed')).rejects.toMatchObject({ code: 'migration-in-progress' })
    await expect(withPricingDirectoryWrite(other, async () => 'new')).rejects.toMatchObject({ code: 'migration-in-progress' })
    expect(entered).toBe(false)
    release(); expect(await accepted).toBe('landed')
    await expect(moving).rejects.toThrow('copy failed')
    expect(associationWritesPaused(dir)).toBe(false)
    expect(await save()).toMatchObject({ revision: 1 })
  })
  it('late feed downloads cannot recreate a migrated source directory', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const syncing = syncCloudPricing(dir, 'https://example.test/feed')
    const old = await readFile(join(dir, 'pricing.ccsa.json'), 'utf8')
    await withPricingDirectoryMigration(dir, `${dir}-target`, async () => {})
    finish(new Response(JSON.stringify(feed)))
    await expect(syncing).rejects.toMatchObject({ code: 'directory-conflict' })
    expect(await readFile(join(dir, 'pricing.ccsa.json'), 'utf8')).toBe(old)
  })
})

describe('association HTTP contract', () => {
  async function request(method = 'GET', body?: unknown, headers: Record<string, string> = {}, raw?: string) {
    const chunks = body === undefined && raw === undefined ? [] : [raw ?? JSON.stringify(body)]
    const req = Object.assign(Readable.from(chunks), { method, headers: { 'content-type': 'application/json', ...headers }, url: '/token-usage/pricing-associations?sourceModel=P%2Finternal' }) as IncomingMessage
    let status = 0, replyHeaders: Record<string, string> = {}, text = ''
    const res = { writeHead: (code: number, values: Record<string, string>) => { status = code; replyHeaders = values }, end: (value: string) => { text = value } } as unknown as ServerResponse
    await createPricingAssociationsRoute(service, log).handler(req, res)
    expect(replyHeaders['cache-control']).toBe('no-store')
    return { status, body: JSON.parse(text) }
  }
  it('GET inspects, POST saves, DELETE revokes; conflict returns real current state', async () => {
    const initial = await request()
    expect(initial.body.resolution.status).toBe('unmatched')
    const input = { sourceModel: 'P/internal', targetModelId: 'a', revision: 0, directoryToken: initial.body.directoryToken }
    expect((await request('POST', input)).body).toMatchObject({ revision: 1, resolution: { method: 'manual' } })
    expect(await request('POST', input)).toMatchObject({ status: 409, body: { error: 'revision-conflict', current: { revision: 1 } } })
    expect(await request('DELETE', { sourceModel: input.sourceModel, revision: 1, directoryToken: input.directoryToken })).toMatchObject({ status: 200, body: { revision: 2, associations: [] } })
  })
  it.each(['cross-site', 'same-site'])('rejects %s requests', async site => expect(await request('POST', {}, { 'sec-fetch-site': site })).toMatchObject({ status: 403 }))
  it.each(['PUT', 'PATCH', 'HEAD'])('restricts %s', async method => expect(await request(method)).toMatchObject({ status: 405 }))
  it('requires bounded JSON and refuses path/price fields', async () => {
    expect(await request('POST', {}, { 'content-type': 'text/plain' })).toMatchObject({ status: 415 })
    expect(await request('POST', undefined, {}, '{')).toMatchObject({ status: 400, body: { error: 'invalid-json' } })
    expect(await request('POST', undefined, {}, ' '.repeat(65537))).toMatchObject({ status: 413 })
    const current = await service.read()
    for (const extra of [{ path: dir }, { inputPerMillion: 9 }]) {
      expect(await request('POST', { sourceModel: 'P/internal', targetModelId: 'a', revision: 0, directoryToken: current.directoryToken, ...extra })).toMatchObject({ status: 400 })
    }
  })
  it('storage failure is readable and mutation returns 503 with current state', async () => {
    await writeFile(join(dir, ASSOCIATIONS_FILE), '{bad')
    const initial = await request()
    expect(initial).toMatchObject({ status: 200, body: { storageState: 'unavailable', storageError: 'invalid-json' } })
    expect(await request('DELETE', { sourceModel: 'P/internal', revision: 0, directoryToken: initial.body.directoryToken })).toMatchObject({ status: 503, body: { current: { storageError: 'invalid-json' } } })
  })
})
