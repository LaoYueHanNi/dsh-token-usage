/**
 * Whole-scope `fields=chip` reads: the sidebar badge's poll. It must answer
 * totals only (no byDay / byModel / pricing / session layers) while the
 * from/to bounds still select today.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createStatsRoute, STATS_PATH } from '../src/stats-route.ts'
import type { UsageRecord } from '../src/usage-record.ts'

function fakeRequest(url: string): IncomingMessage {
  return { method: 'GET', headers: {}, url } as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 200, body: '' }
  const res = {
    writeHead: vi.fn((status: number) => { captured.status = status }),
    end: vi.fn((body?: unknown) => { if (typeof body === 'string') captured.body += body }),
  } as unknown as ServerResponse
  return { res, captured }
}

function record(time: number, model: string, inputTokens: number, outputTokens: number): UsageRecord {
  return {
    requestId: `req-${String(time)}-${model}`,
    time,
    sessionId: 's1',
    model,
    usage: { inputTokens, outputTokens },
  }
}

/** Two requests on 01-11, one on 01-12: three days would not fit the story. */
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'token-usage-trailing-'))
  const day11 = new Date(2026, 0, 11, 12).getTime()
  const day12 = new Date(2026, 0, 12, 12).getTime()
  const lines = [
    record(day11, 'deepseek-chat', 1_000, 240),
    record(day11 + 1_000, 'deepseek-chat', 500, 100),
    record(day12, 'deepseek-reasoner', 2_000, 300),
  ]
  await writeFile(join(dir, 'usage-2026-01-11.jsonl'), lines.slice(0, 2).map(line => JSON.stringify(line)).join('\n') + '\n')
  await writeFile(join(dir, 'usage-2026-01-12.jsonl'), JSON.stringify(lines[2]) + '\n')
  return dir
}

async function query(route: WebRoute, search: string): Promise<Record<string, unknown>> {
  const { res, captured } = fakeResponse()
  await route.handler(fakeRequest(STATS_PATH + search), res)
  expect(captured.status).toBe(200)
  return JSON.parse(captured.body) as Record<string, unknown>
}

describe('whole-scope chip reads (sidebar trailing badge)', () => {
  it('bounds the fold to from/to and answers totals only', async () => {
    const dir = await dataDir()
    const route = createStatsRoute(() => dir)
    const body = await query(route, '?from=2026-01-11&to=2026-01-11&fields=chip')
    expect(body).toMatchObject({
      scope: 'whole',
      total: { requests: 2, inputTokens: 1_500, outputTokens: 340 },
      costState: 'pricing-unavailable',
    })
    // The chip face drops every heavier layer the full read carries.
    for (const key of ['byDay', 'byHour', 'byModel', 'byProvider', 'bySession', 'pricing', 'sessionRows', 'projectRows', 'rateRows', 'recent']) {
      expect(body).not.toHaveProperty(key)
    }
    expect(body).not.toHaveProperty('providerNames')
  })

  it('without a range, the same chip read covers the whole log', async () => {
    const dir = await dataDir()
    const route = createStatsRoute(() => dir)
    const body = await query(route, '?fields=chip')
    expect(body).toMatchObject({ scope: 'whole', total: { requests: 3 } })
    expect(body).not.toHaveProperty('byDay')
  })

  it('keeps the full whole-scope read unchanged when fields is full', async () => {
    const dir = await dataDir()
    const route = createStatsRoute(() => dir)
    const body = await query(route, '')
    expect(body).toMatchObject({ scope: 'whole', total: { requests: 3 } })
    expect(Array.isArray(body.byDay)).toBe(true)
    expect(body.sessionRows).toBeDefined()
  })

  it('rejects an invalid range before folding', async () => {
    const dir = await dataDir()
    const route = createStatsRoute(() => dir)
    const { res, captured } = fakeResponse()
    await route.handler(fakeRequest(`${STATS_PATH}?from=2026-1-1&to=2026-01-11&fields=chip`), res)
    expect(captured.status).toBe(400)
  })
})