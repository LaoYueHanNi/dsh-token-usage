import { mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../src/index.ts'
import { createStatsRoute, isSameOriginFetch, STATS_PATH } from '../src/stats-route.ts'
import type { UsageRecord } from '../src/usage-record.ts'
import { messageEvent } from './helpers.ts'

/** Captures registrations instead of serving HTTP. */
class MockWebServer extends Service {
  readonly routes: WebRoute[] = []

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: WebRoute): () => void {
    this.routes.push(route)
    return () => {}
  }
}

/** One captured response for assertion. */
interface CapturedResponse {
  status: number
  headers: Record<string, string | string[] | number | undefined>
  body: string
}

function fakeRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { method: 'GET', headers: {}, ...overrides } as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 200, headers: {}, body: '' }
  const res = {
    writeHead: vi.fn((status: number, headers: Record<string, string | number>) => {
      captured.status = status
      captured.headers = { ...captured.headers, ...headers }
    }),
    end: vi.fn((body?: unknown) => {
      if (typeof body === 'string') captured.body += body
    }),
  } as unknown as ServerResponse
  return { res, captured }
}

/** One full record fixture. */
function fixtureRecord(time: number): UsageRecord {
  return {
    requestId: `req-${time}`,
    time,
    sessionId: 's1',
    model: 'deepseek-chat',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
  }
}

/** One record on a local calendar day with a chosen model. */
function dayRecord(day: number, model: string): UsageRecord {
  const time = new Date(2026, 0, 10 + day, 12).getTime()
  return { ...fixtureRecord(time), requestId: `req-${model}-${day}`, model }
}

/** A data dir holding three days × two models (day N contributes N+1 requests to chat). */
async function filteredDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'token-usage-filter-'))
  const lines: string[] = []
  for (const day of [0, 1, 2]) {
    lines.push(JSON.stringify(dayRecord(day, 'deepseek-chat')))
    lines.push(JSON.stringify(dayRecord(day, 'deepseek-reasoner')))
  }
  await writeFile(join(dir, 'usage-2026-01-10.jsonl'), lines.slice(0, 2).join('\n') + '\n')
  await writeFile(join(dir, 'usage-2026-01-11.jsonl'), lines.slice(2, 4).join('\n') + '\n')
  await writeFile(join(dir, 'usage-2026-01-12.jsonl'), lines.slice(4).join('\n') + '\n')
  return dir
}

describe('createStatsRoute', () => {
  it('serves the JSON summary on GET', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(captured.body) as { total: { requests: number; inputTokens: number } }
    expect(body.total.requests).toBe(1)
    expect(body.total.inputTokens).toBe(10)
  })

  it('rejects non-GET methods with 405', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), res)
    expect(captured.status).toBe(405)
  })

  it('refuses cross-site browser fetches with 403', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), res)
    expect(captured.status).toBe(403)
  })

  it('answers an absent data directory with an empty summary', async () => {
    const dir = join(tmpdir(), `token-usage-absent-${Date.now()}`)
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toMatchObject({ total: { requests: 0 } })
  })

  it('filters by an inclusive day range', async () => {
    const route = createStatsRoute(await filteredDataDir())
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=2026-01-11&to=2026-01-12` }), res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body) as { total: { requests: number }; byDay: Array<{ day: string }> }
    expect(body.total.requests).toBe(4)
    expect(body.byDay.map(row => row.day)).toEqual(['2026-01-11', '2026-01-12'])
  })

  it('filters by model and combines it with a day range', async () => {
    const route = createStatsRoute(await filteredDataDir())
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?model=deepseek-chat&from=2026-01-10` }), res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body) as { total: { requests: number }; byModel: Array<{ model: string }> }
    expect(body.total.requests).toBe(3)
    expect(body.byModel.map(row => row.model)).toEqual(['deepseek-chat'])
  })

  it('treats blank query values as absent', async () => {
    const route = createStatsRoute(await filteredDataDir())
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=&to=&model=` }), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body).total.requests).toBe(6)
  })

  it('rejects a malformed day key with 400', async () => {
    const route = createStatsRoute(await filteredDataDir())
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=2026-1-1` }), res)
    expect(captured.status).toBe(400)
  })

  it('rejects an inverted day range with 400', async () => {
    const route = createStatsRoute(await filteredDataDir())
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=2026-01-12&to=2026-01-10` }), res)
    expect(captured.status).toBe(400)
  })

  it('serves an empty cost layer without a pricing table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    const body = JSON.parse(captured.body) as {
      totalCost: number
      unpricedModels: string[]
      pricing: Record<string, unknown>
      byModel: Array<{ model: string; cost: number }>
    }
    expect(body.totalCost).toBe(0)
    expect(body.unpricedModels).toEqual(['deepseek-chat'])
    expect(body.pricing).toEqual({})
    expect(body.byModel).toEqual([{ model: 'deepseek-chat', totals: expect.anything(), cost: 0 }])
  })

  it('computes costs from the user-maintained pricing table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({
      'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
    }))
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    const body = JSON.parse(captured.body) as {
      totalCost: number
      unpricedModels: string[]
      pricing: Record<string, unknown>
      byModel: Array<{ model: string; cost: number }>
    }
    // 10 input × ¥2 + 5 output × ¥8 + 3 cache read × ¥0.5, per million.
    expect(body.totalCost).toBe(0.0000615)
    expect(body.unpricedModels).toEqual([])
    expect(body.pricing).toEqual({
      'deepseek-chat': {
        base: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
        contextTiers: [],
        dailySlots: [],
        timeRules: [],
      },
    })
    expect(body.byModel[0]!.cost).toBe(0.0000615)
  })

  it('bills each record through the cloud rule chain at its own timestamp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    // Two records on one day, local time: 10:00 falls inside the peak window
    // (09:00–12:00 local minutes), 20:00 is off-peak.
    const peak = { ...fixtureRecord(new Date(2026, 0, 15, 10).getTime()), requestId: 'peak' }
    const off = { ...fixtureRecord(new Date(2026, 0, 15, 20).getTime()), requestId: 'off' }
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(peak)}\n${JSON.stringify(off)}\n`)
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({
      version: 57, updatedAt: 1, currency: 'RMB',
      models: [{
        modelId: 'deepseek-chat',
        inputCostPerMillion: 1, outputCostPerMillion: 2, cacheReadCostPerMillion: 0.1,
        dailySlots: [{ windows: [{ startMinute: 540, endMinute: 720 }], inputCostPerMillion: 3, outputCostPerMillion: 6, cacheReadCostPerMillion: 0.3 }],
      }],
    }))
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    const body = JSON.parse(captured.body) as {
      totalCost: number
      rateRows: Array<{ rate: { slot: number }; totals: { inputTokens: number } }>
    }
    // Peak row: 10×3 + 5×6 + 3×0.3 = 60.9 per million tokens; off-peak:
    // 10×1 + 5×2 + 3×0.1 = 20.3 — two distinct rate rows on one day.
    expect(body.totalCost).toBeCloseTo((60.9 + 20.3) / 1_000_000, 12)
    expect(body.rateRows).toHaveLength(2)
    // Sorted by rate identity (slot -1 before 0), not by record time.
    expect(body.rateRows.map(row => row.rate.slot)).toEqual([-1, 0])
  })

  it('recomputes costs after filtering, dropping other models from the totals', async () => {
    const dir = await filteredDataDir()
    // Only chat is priced; reasoner stays unpriced.
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({
      'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
    }))
    const route = createStatsRoute(dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?model=deepseek-chat&from=2026-01-10&to=2026-01-12` }), res)
    const body = JSON.parse(captured.body) as {
      totalCost: number
      unpricedModels: string[]
      byModel: Array<{ model: string; cost: number }>
    }
    expect(body.byModel.map(row => row.model)).toEqual(['deepseek-chat'])
    expect(body.unpricedModels).toEqual([])
    expect(body.totalCost).toBeGreaterThan(0)
    expect(body.byModel[0]!.cost).toBe(body.totalCost)
  })
})

describe('isSameOriginFetch', () => {
  it('allows same-origin, none, and absent Sec-Fetch-Site', () => {
    expect(isSameOriginFetch(fakeRequest({ headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(true)
    expect(isSameOriginFetch(fakeRequest({ headers: { 'sec-fetch-site': 'none' } }))).toBe(true)
    expect(isSameOriginFetch(fakeRequest({ headers: {} }))).toBe(true)
  })

  it('refuses cross-site and same-site values', () => {
    expect(isSameOriginFetch(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false)
    expect(isSameOriginFetch(fakeRequest({ headers: { 'sec-fetch-site': 'same-site' } }))).toBe(false)
  })
})

describe('plugin webServer wiring', () => {
  let ctx: Context | undefined
  let home: string
  const sessions: Array<{ id: string; events: unknown[] }> = []

  beforeEach(async () => {
    sessions.length = 0
    home = await mkdtemp(join(tmpdir(), 'token-usage-wire-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    if (ctx !== undefined) {
      ctx.registry.delete(plugin)
      ctx = undefined
    }
    vi.unstubAllEnvs()
  })

  it('registers the stats route when a webServer exists and serves live rows', async () => {
    const next = new Context()
    await next.plugin(MockWebServer)
    await next.plugin(class extends Service {
      constructor(context: Context) { super(context, 'sessions') }
    })
    await next.plugin(class extends Service {
      constructor(context: Context) { super(context, 'sessionPersistence') }
      async list(): Promise<Array<{ id: string }>> { return sessions.map(session => ({ id: session.id })) }
      async inspect(id: string): Promise<{ events: unknown[] }> {
        const session = sessions.find(candidate => candidate.id === id)
        if (session === undefined) throw new Error(`missing session ${id}`)
        return { events: session.events }
      }
    })
    await next.plugin(class extends Service {
      constructor(context: Context) { super(context, 'commands') }
      register(): () => void { return () => {} }
    })
    await next.plugin(plugin)
    ctx = next

    // ctx.inject runs the callback in a child fiber; wait for it to activate.
    const routes = (next.webServer as unknown as MockWebServer).routes
    const routeDeadline = Date.now() + 2_000
    let route: WebRoute | undefined
    while (Date.now() < routeDeadline) {
      route = routes.find(candidate => candidate.path === STATS_PATH)
      if (route !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(route).toBeDefined()
    expect(route!.kind).toBe('exact')

    // A live hook row is served by the route.
    next.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    const deadline = Date.now() + 2_000
    let body = ''
    while (Date.now() < deadline) {
      const { res, captured } = fakeResponse()
      await route!.handler(fakeRequest(), res)
      body = captured.body
      if (JSON.parse(body).total.requests > 0) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(JSON.parse(body).total.requests).toBe(1)
    expect(JSON.parse(body).recent[0]).toMatchObject({ requestId: 'm1', model: 'deepseek-chat' })
  })
})
