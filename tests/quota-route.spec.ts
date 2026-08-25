/**
 * Quota route tests: method / same-origin gating, the `session` query
 * parameter, and the JSON pass-through of the service payload.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createQuotaRoute, QUOTA_PATH } from '../src/quota/quota-route.ts'
import type { QuotaPayload } from '../src/wire.ts'

/** One captured response for assertion. */
interface Captured {
  status: number
  headers: Record<string, string | string[] | number | undefined>
  body: string
}

function fakeRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { method: 'GET', headers: {}, ...overrides } as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 200, headers: {}, body: '' }
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

/** The route under a spy snapshot thunk. */
function routeOf(payload: QuotaPayload): { route: WebRoute; snapshot: ReturnType<typeof vi.fn> } {
  const snapshot = vi.fn(async () => payload)
  return { route: createQuotaRoute(snapshot), snapshot }
}

describe('createQuotaRoute', () => {
  it('serves the payload JSON with no-store', async () => {
    const { route, snapshot } = routeOf({ status: 'no-provider', intervalSec: 60 })
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: '/token-usage/quota' }), res)
    expect(captured.status).toBe(200)
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual({ status: 'no-provider', intervalSec: 60 })
  })

  it('passes the session and provider parameters through', async () => {
    const { route, snapshot } = routeOf({ status: 'no-provider', intervalSec: 60 })
    const { res } = fakeResponse()
    await route.handler(fakeRequest({ url: `${QUOTA_PATH}?session=s-42&provider=minimax` }), res)
    expect(snapshot).toHaveBeenCalledWith('s-42', 'minimax')
  })

  it('treats blank parameters as absent', async () => {
    const { route, snapshot } = routeOf({ status: 'no-provider', intervalSec: 60 })
    const { res } = fakeResponse()
    await route.handler(fakeRequest({ url: `${QUOTA_PATH}?session=&provider=` }), res)
    expect(snapshot).toHaveBeenCalledWith(undefined, undefined)
  })

  it('refuses non-GET methods and cross-site fetches', async () => {
    const { route, snapshot } = routeOf({ status: 'no-provider', intervalSec: 60 })
    const method = fakeResponse()
    await route.handler(fakeRequest({ method: 'POST' }), method.res)
    expect(method.captured.status).toBe(405)
    const crossSite = fakeResponse()
    await route.handler(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), crossSite.res)
    expect(crossSite.captured.status).toBe(403)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('answers 500 when the service throws', async () => {
    const failing = createQuotaRoute(async () => {
      throw new Error('boom')
    })
    const { res, captured } = fakeResponse()
    await failing.handler(fakeRequest({ url: QUOTA_PATH }), res)
    expect(captured.status).toBe(500)
    expect(JSON.parse(captured.body)).toEqual({ error: 'boom' })
  })
})
