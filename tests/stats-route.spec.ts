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
