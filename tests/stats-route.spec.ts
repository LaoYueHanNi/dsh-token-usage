import { mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../src/index.ts'
import { createDirectoryGuardRoute, createFullSyncRoute, createMigrationRoute, createStatsRoute, DIR_GUARD_PATH, FULL_SYNC_PATH, isSameOriginFetch, MIGRATION_PATH, STATS_PATH } from '../src/stats-route.ts'
import { currencyOfRegion } from '../src/wire.ts'
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

/**
 * A data dir with two sessions: `alpha` owns a chat row (01-11) and a
 * reasoner row (01-12); `child` owns a chat row (01-12) — the shape of a
 * parent session plus one subagent.
 */
async function sessionDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'token-usage-session-'))
  const line = (record: UsageRecord): string => `${JSON.stringify(record)}\n`
  await writeFile(join(dir, 'usage-2026-01-11.jsonl'), line({
    ...dayRecord(1, 'deepseek-chat'), sessionId: 'alpha', requestId: 'alpha-chat',
  }))
  await writeFile(join(dir, 'usage-2026-01-12.jsonl'),
    line({ ...dayRecord(2, 'deepseek-reasoner'), sessionId: 'alpha', requestId: 'alpha-reasoner' })
    + line({ ...dayRecord(2, 'deepseek-chat'), sessionId: 'child', requestId: 'child-chat' }))
  return dir
}

describe('createStatsRoute', () => {
  it('serves the JSON summary on GET', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    const route = createStatsRoute(() => dir)
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
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), res)
    expect(captured.status).toBe(405)
  })

  it('refuses cross-site browser fetches with 403', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), res)
    expect(captured.status).toBe(403)
  })

  it('answers an absent data directory with an empty summary', async () => {
    const dir = join(tmpdir(), `token-usage-absent-${Date.now()}`)
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toMatchObject({ total: { requests: 0 } })
  })

  it('filters by an inclusive day range', async () => {
    const dir = await filteredDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=2026-01-11&to=2026-01-12` }), res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body) as { total: { requests: number }; byDay: Array<{ day: string }> }
    expect(body.total.requests).toBe(4)
    expect(body.byDay.map(row => row.day)).toEqual(['2026-01-11', '2026-01-12'])
  })

  it('filters by model and combines it with a day range', async () => {
    const dir = await filteredDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?model=deepseek-chat&from=2026-01-10` }), res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body) as { total: { requests: number }; byModel: Array<{ model: string }> }
    expect(body.total.requests).toBe(3)
    expect(body.byModel.map(row => row.model)).toEqual(['deepseek-chat'])
  })

  it('treats blank query values as absent', async () => {
    const dir = await filteredDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=&to=&model=` }), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body).total.requests).toBe(6)
  })

  it('rejects a malformed day key with 400', async () => {
    const dir = await filteredDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=2026-1-1` }), res)
    expect(captured.status).toBe(400)
  })

  it('rejects an inverted day range with 400', async () => {
    const dir = await filteredDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?from=2026-01-12&to=2026-01-10` }), res)
    expect(captured.status).toBe(400)
  })

  it('serves an empty cost layer without a pricing table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    const route = createStatsRoute(() => dir)
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

  it('defaults to CNY display with the built-in rate when no mirror exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    expect(JSON.parse(captured.body)).toMatchObject({ currency: 'CNY', usdExchangeRate: 7 })
  })

  it('stamps the currency thunk answer and the mirror rate as USD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    await writeFile(join(dir, 'pricing.ccsa.json'), JSON.stringify({
      version: 57, updatedAt: 1, currency: 'RMB', usdExchangeRate: 7.25,
      models: [{ modelId: 'deepseek-chat', inputCostPerMillion: 2, outputCostPerMillion: 8 }],
    }))
    const route = createStatsRoute(() => dir, { currency: () => 'USD' })
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    const body = JSON.parse(captured.body) as { currency: string; usdExchangeRate: number; totalCost: number }
    expect(body.currency).toBe('USD')
    // The feed envelope's rate, not the built-in 7.
    expect(body.usdExchangeRate).toBe(7.25)
    // Wire amounts stay RMB — conversion is the client's job. The feed gives
    // no cache price, so cache reads bill at the plain input rate (2):
    // 10×2 + 5×8 + 3×2 = 66 per million tokens.
    expect(body.totalCost).toBeCloseTo(0.000066, 12)
  })

  it('computes costs from the user-maintained pricing table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'token-usage-route-'))
    await writeFile(join(dir, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({
      'deepseek-chat': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
    }))
    const route = createStatsRoute(() => dir)
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
    const route = createStatsRoute(() => dir)
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
    const route = createStatsRoute(() => dir)
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

  it('scopes the summary to one session via repeated sessionId params', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?sessionId=alpha` }), res)
    const body = JSON.parse(captured.body) as {
      total: { requests: number; inputTokens: number; outputTokens: number }
      byModel: Array<{ model: string }>
      recent: Array<{ sessionId: string }>
    }
    // alpha owns two records (chat one, reasoner one); beta's rows are excluded.
    expect(body.total.requests).toBe(2)
    expect(body.total.inputTokens).toBe(2 * 10)
    expect(body.total.outputTokens).toBe(2 * 5)
    expect(body.byModel.map(row => row.model)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(body.recent.every(record => record.sessionId === 'alpha')).toBe(true)
  })

  it('aggregates a parent session with its subagent subtree in one request', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?sessionId=alpha&sessionId=child` }), res)
    const body = JSON.parse(captured.body) as { total: { requests: number }; byModel: Array<{ model: string; totals: { requests: number } }> }
    expect(body.total.requests).toBe(3)
    const matches = body.byModel.find(row => row.model === 'deepseek-chat')
    expect(matches?.totals.requests).toBe(2)
  })

  it('carries the per-request series on session-scoped reads', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?sessionId=alpha` }), res)
    const body = JSON.parse(captured.body) as {
      scope: 'session' | 'whole'
      sessionIds: string[]
      requestSeries: Array<{ time: number; tokens: number }>
    }
    // One point per request, in time order: alpha's chat row (01-11) first,
    // its reasoner row (01-12) second. 10 in + 5 out + 3 cache read = 18.
    expect(body.scope).toBe('session')
    expect(body.sessionIds).toEqual(['alpha'])
    expect(body.requestSeries).toEqual([
      { time: new Date(2026, 0, 11, 12).getTime(), tokens: 18 },
      { time: new Date(2026, 0, 12, 12).getTime(), tokens: 18 },
    ])
  })

  it('omits the request series from the whole-log settings read', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    const body = JSON.parse(captured.body) as {
      scope: 'session' | 'whole'
      requestSeries?: unknown
    }
    expect(body.scope).toBe('whole')
    expect('requestSeries' in body).toBe(false)
  })

  it('combines a session scope with the day-range and model filters', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({
      url: `${STATS_PATH}?sessionId=alpha&model=deepseek-reasoner&to=2026-01-11`,
    }), res)
    const body = JSON.parse(captured.body) as {
      total: { requests: number }
      byModel: Array<{ model: string }>
      recent: Array<{ sessionId: string }>
    }
    // alpha's reasoner row sits on the 12th, past `to=2026-01-11`, so the
    // scoped window holds no records at all.
    expect(body.total.requests).toBe(0)
    expect(body.byModel).toEqual([])
    expect(body.recent).toEqual([])
  })

  it('answers an empty summary for a session with no records', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?sessionId=nobody` }), res)
    expect(captured.status).toBe(200)
    const body = JSON.parse(captured.body) as { total: { requests: number }; unpricedModels: string[] }
    expect(body.total.requests).toBe(0)
    expect(body.unpricedModels).toEqual([])
  })

  it('omits pricing and the request series on fields=chip', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?sessionId=alpha&fields=chip` }), res)
    const body = JSON.parse(captured.body) as Record<string, unknown>
    expect(body.scope).toBe('session')
    expect(body.sessionIds).toEqual(['alpha'])
    expect(body.total).toMatchObject({ requests: 2 })
    expect('pricing' in body).toBe(false)
    expect('requestSeries' in body).toBe(false)
    expect('byModel' in body).toBe(false)
    expect('byDay' in body).toBe(false)
    expect('rateRows' in body).toBe(false)
    expect('recent' in body).toBe(false)
  })

  it('sends a pre-bucketed request series and model/day rows on fields=session', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${STATS_PATH}?sessionId=alpha&fields=session` }), res)
    const body = JSON.parse(captured.body) as {
      byModel: unknown[]
      byDay: unknown[]
      requestSeries: Array<{ time: number; tokens: number; count: number; end: number }>
      pricing?: unknown
      byHour?: unknown
      rateRows?: unknown
    }
    expect(body.byModel).toHaveLength(2)
    expect(body.byDay.length).toBeGreaterThan(0)
    expect(body.requestSeries.length).toBeGreaterThan(0)
    expect(body.requestSeries.length).toBeLessThanOrEqual(60)
    expect(body.requestSeries.every(point => point.count >= 1 && point.end > point.time)).toBe(true)
    expect(body.pricing).toBeUndefined()
    expect(body.byHour).toBeUndefined()
    expect(body.rateRows).toBeUndefined()
  })

  it('returns per-child totals for childId groups (session vs tree)', async () => {
    const dir = await sessionDataDir()
    const route = createStatsRoute(() => dir)
    const sessionScope = fakeResponse()
    await route.handler(fakeRequest({
      url: `${STATS_PATH}?sessionId=alpha&childId=child&fields=session`,
    }), sessionScope.res)
    const sessionBody = JSON.parse(sessionScope.captured.body) as {
      total: { requests: number }
      children: Record<string, { total: { requests: number } }>
    }
    expect(sessionBody.total.requests).toBe(2)
    expect(sessionBody.children.child.total.requests).toBe(1)

    const treeScope = fakeResponse()
    await route.handler(fakeRequest({
      url: `${STATS_PATH}?sessionId=alpha&sessionId=child&childId=child&fields=session`,
    }), treeScope.res)
    const treeBody = JSON.parse(treeScope.captured.body) as {
      total: { requests: number }
      children: Record<string, { total: { requests: number } }>
    }
    expect(treeBody.total.requests).toBe(3)
    expect(treeBody.children.child.total.requests).toBe(1)
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

describe('createMigrationRoute', () => {
  it('answers the live progress as JSON on GET', async () => {
    let status: { phase: 'copying' | 'cleaning'; done: number; total: number } | undefined
      = { phase: 'copying', done: 2, total: 5 }
    const route = createMigrationRoute(() => status)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual({ phase: 'copying', done: 2, total: 5 })
    // The next poll reads the moved fact: same route, new answer, no rebuild.
    status = { phase: 'cleaning', done: 4, total: 5 }
    const second = fakeResponse()
    await route.handler(fakeRequest(), second.res)
    expect(JSON.parse(second.captured.body)).toEqual({ phase: 'cleaning', done: 4, total: 5 })
  })

  it('answers null when no migration runs', async () => {
    const route = createMigrationRoute(() => undefined)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(), res)
    expect(captured.status).toBe(200)
    expect(captured.body).toBe('null')
  })

  it('rejects non-GET methods with 405', async () => {
    const route = createMigrationRoute(() => undefined)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), res)
    expect(captured.status).toBe(405)
  })

  it('refuses cross-site browser fetches with 403', async () => {
    const route = createMigrationRoute(() => undefined)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), res)
    expect(captured.status).toBe(403)
  })
})

describe('createDirectoryGuardRoute', () => {
  it('answers the judge verdict for the proposed path on GET', async () => {
    const judge = vi.fn((proposed: string | undefined) =>
      ({ blocked: proposed !== 'D:/running', interactingSessions: 2 }))
    const route = createDirectoryGuardRoute(judge)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${DIR_GUARD_PATH}?path=${encodeURIComponent('D:/elsewhere')}` }), res)
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual({ blocked: true, interactingSessions: 2 })
    expect(judge).toHaveBeenCalledWith('D:/elsewhere')
  })

  it('treats an absent or blank path as the clear-to-default gesture', async () => {
    const judge = vi.fn((proposed: string | undefined) => ({ blocked: proposed !== undefined, interactingSessions: 0 }))
    const route = createDirectoryGuardRoute(judge)
    for (const url of [DIR_GUARD_PATH, `${DIR_GUARD_PATH}?path=`]) {
      const { res, captured } = fakeResponse()
      await route.handler(fakeRequest({ url }), res)
      expect(JSON.parse(captured.body)).toEqual({ blocked: false, interactingSessions: 0 })
    }
    // Both the missing and the empty parameter mean "no stored path".
    expect(judge).toHaveBeenCalledTimes(2)
    expect(judge).toHaveBeenNthCalledWith(1, undefined)
    expect(judge).toHaveBeenNthCalledWith(2, undefined)
  })

  it('rejects non-GET methods with 405', async () => {
    const route = createDirectoryGuardRoute(() => ({ blocked: false, interactingSessions: 0 }))
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), res)
    expect(captured.status).toBe(405)
  })

  it('refuses cross-site browser fetches with 403', async () => {
    const route = createDirectoryGuardRoute(() => ({ blocked: false, interactingSessions: 0 }))
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), res)
    expect(captured.status).toBe(403)
  })
})

describe('createFullSyncRoute', () => {
  it('serves the live status as JSON on GET', async () => {
    let view = { status: 'running' as const, processed: 3, total: 10, added: 7, skipped: 0 }
    const route = createFullSyncRoute(() => view, () => ({ started: true }))
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'GET' }), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual(view)
  })

  it('returns 202 on POST when the trigger accepts', async () => {
    const route = createFullSyncRoute(
      () => ({ status: 'idle' as const }),
      () => ({ started: true }),
    )
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), res)
    expect(captured.status).toBe(202)
    expect(JSON.parse(captured.body)).toEqual({ status: 'running' })
  })

  it('returns 409 on POST when the trigger refuses (already running)', async () => {
    const route = createFullSyncRoute(
      () => ({ status: 'running' as const, processed: 1, total: 5, added: 0, skipped: 0 }),
      () => ({ started: false, reason: 'already-running' as const }),
    )
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), res)
    expect(captured.status).toBe(409)
    expect(JSON.parse(captured.body)).toEqual({ error: 'already-running' })
  })

  it('rejects non-GET/POST methods with 405', async () => {
    const route = createFullSyncRoute(
      () => ({ status: 'idle' as const }),
      () => ({ started: true }),
    )
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ method: 'PUT' }), res)
    expect(captured.status).toBe(405)
  })

  it('refuses cross-site browser fetches with 403 on both methods', async () => {
    const route = createFullSyncRoute(
      () => ({ status: 'idle' as const }),
      () => ({ started: true }),
    )
    const get = fakeResponse()
    await route.handler(fakeRequest({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }), get.res)
    expect(get.captured.status).toBe(403)
    const post = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }), post.res)
    expect(post.captured.status).toBe(403)
  })
})

describe('createStatsRoute relocation', () => {
  it('serves from whatever the directory thunk answers, without rebuilding', async () => {
    const first = await mkdtemp(join(tmpdir(), 'token-usage-reloc-a-'))
    const second = await mkdtemp(join(tmpdir(), 'token-usage-reloc-b-'))
    await writeFile(join(first, 'usage-2026-01-15.jsonl'), `${JSON.stringify(fixtureRecord(100))}\n`)
    await writeFile(join(second, 'usage-2026-01-16.jsonl'), `${JSON.stringify(fixtureRecord(200))}\n${JSON.stringify(fixtureRecord(300))}\n`)
    // The running directory flips mid-life, the way a settled relocation does.
    let dir = first
    const route = createStatsRoute(() => dir)
    const before = fakeResponse()
    await route.handler(fakeRequest(), before.res)
    expect(JSON.parse(before.captured.body).total.requests).toBe(1)
    dir = second
    const after = fakeResponse()
    await route.handler(fakeRequest(), after.res)
    expect(JSON.parse(after.captured.body).total.requests).toBe(2)
  })
})

describe('currencyOfRegion', () => {
  it('maps overseas to USD and everything else to CNY', () => {
    expect(currencyOfRegion('overseas')).toBe('USD')
    expect(currencyOfRegion('domestic')).toBe('CNY')
    expect(currencyOfRegion(undefined)).toBe('CNY')
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
      list(): Array<{ id: string; events: unknown[] }> { return sessions.map(session => ({ id: session.id, events: session.events })) }
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
    await next.plugin(plugin, { startupDeferMs: 0, startupCapMs: 0 })
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
    // The relocation progress route registers alongside the stats route.
    expect(routes.some(candidate => candidate.path === MIGRATION_PATH && candidate.kind === 'exact')).toBe(true)

    // The directory-guard route registers too and answers the live verdict:
    // no session is mid-conversation here, so a proposed move is not blocked.
    const guardRoute = routes.find(candidate => candidate.path === DIR_GUARD_PATH)
    expect(guardRoute).toBeDefined()
    const guardAnswer = fakeResponse()
    await guardRoute!.handler(fakeRequest({ url: `${DIR_GUARD_PATH}?path=${encodeURIComponent('D:/elsewhere')}` }), guardAnswer.res)
    expect(guardAnswer.captured.status).toBe(200)
    expect(JSON.parse(guardAnswer.captured.body)).toEqual({ blocked: false, interactingSessions: 0 })

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
