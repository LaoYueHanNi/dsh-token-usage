/**
 * Integration coverage of the auxiliary (bypass) model-request recorder: the
 * plugin observes the `llm/stream` waterfall every streaming call passes
 * through, keeps the chunks flowing untouched, and appends one JSONL row per
 * successful bypass request. The provider services are the real Cordis event
 * bus here (only the host services are stubs), so this pins the wiring the
 * unit tests cannot: listener registration through `ctx.inject(['llm'])`,
 * classification of the request shape, and the recorded row on disk.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as plugin from '../src/index.ts'
import { STATS_PATH } from '../src/stats-route.ts'
import { syncHistory } from '../src/sync.ts'
import { UsageLog } from '../src/usage-log.ts'
import { messageEvent, retryEvent } from './helpers.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Minimal host service stubs: the plugin only needs their presence. */
class MockSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  list(): Array<{ snapshotEvents(): unknown[] }> {
    return []
  }
}

/** Persisted-session seam; this suite has no conversation history. The
 * handle seam must exist or the first-run sync cannot walk sessions and
 * never writes its initialized marker. */
class MockPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async list(): Promise<Array<{ header: { id: string } }>> {
    return []
  }

  async open(id: string): Promise<{ read(): Promise<{ events: unknown[] }>; close(): Promise<void> }> {
    throw new Error(`missing session ${id}`)
  }
}

/** The LLM service is only the waterfall's `this`; streams are supplied by
 * the test's provider callback, standing in for an adapter. */
class MockLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
}

/** Wait until the first-run auto sync wrote its initialized marker. */
async function waitForState(dir: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const text = await readFile(join(dir, 'state.json'), 'utf8').catch(() => undefined)
    if (text !== undefined) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('initialized marker never appeared')
}

/** Read every JSONL row of the data directory (the recorder picks the local
 * day file name, so the listing is authoritative). */
async function readAllRows(dir: string): Promise<Array<Record<string, unknown>>> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'))
  const rows: Array<Record<string, unknown>> = []
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line !== '') rows.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return rows
}

/** Poll until the log holds `count` rows (the append is fire-and-forget). */
async function pollRows(dir: string, count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const rows = await readAllRows(dir)
    if (rows.length >= count) return rows
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`no log with ${String(count)} rows appeared`)
}

/** One streaming call through the real `llm/stream` waterfall; the provider
 * callback supplies the chunks an adapter would. */
async function streamWaterfall(
  ctx: Context,
  options: Record<string, unknown>,
  chunks: readonly unknown[],
): Promise<void> {
  const llm = ctx.get('llm')
  const waterfall = ctx.waterfall.bind(ctx) as (
    thisArg: unknown,
    name: string,
    options: unknown,
    provider: () => AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>
  const stream = waterfall(llm, 'llm/stream', options, () => (async function* () {
    for (const chunk of chunks) yield chunk
  })())
  for await (const _chunk of stream) {
    // Consume like an adapter consumer would; the recorder wraps the flow.
  }
}

/** A successful bypass stream: usage then a terminal stop finish. */
const SUCCESS_CHUNKS = [
  { type: 'usage', usage: { inputTokens: 42, outputTokens: 7 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** The Auto review request shape: no session, no purpose, fixed policy. */
const AUTO_REVIEW_REQUEST = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  messages: [],
  system: 'REVIEW_POLICY\nYou are the final authorization reviewer …',
}

describe('auxiliary request recording', () => {
  let ctx: Context | undefined
  let home: string

  /** Mount the plugin with the LLM stub already available (the recorder
   * registers through `ctx.inject(['llm'])`). */
  async function mount(config: plugin.Config = {}): Promise<string> {
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(MockPersistence)
    await next.plugin(MockLlm)
    await next.plugin(plugin, config)
    ctx = next
    const dir = join(home, 'token-usage')
    await waitForState(dir)
    return dir
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'token-usage-aux-it-'))
    vi.stubEnv('DSH_HOME', home)
    // Keep the startup pricing mirror offline: the sync failure is caught and
    // does not touch the usage log this suite asserts on.
    vi.stubGlobal('fetch', async () => new Response('{}'))
  })

  afterEach(async () => {
    if (ctx !== undefined) {
      ctx.registry.delete(plugin)
      ctx = undefined
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('persists linked attempt timing through the real plugin event listener and day log', async () => {
    const dir = await mount({ recordAux: false })
    ctx!.emit('session/event', { id: 's1' }, { type: 'step/start', seq: 1, time: 1_000, data: { turn: 1, step: 2 } } as SessionEvent)
    const before = Date.now()
    await streamWaterfall(ctx!, { sessionId: 's1', provider: 'deepseek-account', model: 'deepseek-chat' }, [
      { type: 'text-delta', index: 0, text: 'hello' }, ...SUCCESS_CHUNKS,
    ])
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'timed', time: Date.now() }))
    const rows = await pollRows(dir, 1)
    const clock = rows[0]!.attemptTiming as { startedAt: number; settledAt: number; firstTokenAt: number }
    expect(clock.startedAt).toBeGreaterThanOrEqual(before)
    expect(clock.settledAt).toBeGreaterThanOrEqual(clock.startedAt)
    expect(clock.firstTokenAt).toBeGreaterThanOrEqual(clock.startedAt)
    expect(rows[0]!.startedAt).toBe(1_000)
  })

  it('records one aux row per successful bypass stream and passes chunks through', async () => {
    const dir = await mount()
    const seen: unknown[] = []
    const llm = ctx!.get('llm')
    const waterfall = ctx!.waterfall.bind(ctx!) as (
      thisArg: unknown,
      name: string,
      options: unknown,
      provider: () => AsyncIterable<unknown>,
    ) => AsyncIterable<unknown>
    for await (const chunk of waterfall(llm, 'llm/stream', AUTO_REVIEW_REQUEST, () => (async function* () {
      for (const chunk of SUCCESS_CHUNKS) yield chunk
    })())) {
      seen.push(chunk)
    }
    // The wrapper never alters the flow: same chunks, same order.
    expect(seen).toEqual(SUCCESS_CHUNKS)
    const rows = await pollRows(dir, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: '',
      model: 'deepseek-flash',
      kind: 'aux',
      auxKind: 'auto-review',
      usage: { inputTokens: 42, outputTokens: 7 },
    })
    expect(rows[0]!.requestId).toMatch(/^aux:auto-review:\d+:\d+$/u)
  })

  it('classifies session-title, auto-review, and timeline-report requests by purpose and retains session attribution', async () => {
    const dir = await mount()
    await streamWaterfall(ctx!, {
      ...AUTO_REVIEW_REQUEST,
      sessionId: 'session-1',
      purpose: 'session-title',
    }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx!, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      sessionId: 'session-1',
      purpose: 'auto-review',
    }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx!, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      sessionId: 'session-1',
      purpose: 'timeline-report',
    }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx!, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      purpose: 'timeline-report',
    }, SUCCESS_CHUNKS)
    const rows = await pollRows(dir, 4)
    expect(rows[0]).toMatchObject({ kind: 'aux', auxKind: 'session-title', sessionId: 'session-1' })
    expect(rows[1]).toMatchObject({ kind: 'aux', auxKind: 'auto-review', sessionId: 'session-1' })
    expect(rows[2]).toMatchObject({ kind: 'aux', auxKind: 'timeline-report', sessionId: 'session-1' })
    expect(rows[3]).toMatchObject({ kind: 'aux', auxKind: 'timeline-report', sessionId: '' })
  })

  it('does not record conversation-loop or compaction requests', async () => {
    const dir = await mount()
    // A loop request (session id) and a compaction summary are already
    // covered by their own session events; the recorder must leave both alone.
    await streamWaterfall(ctx!, { provider: 'deepseek-account', model: 'deepseek-flash', messages: [], sessionId: 'session-1' }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx!, {
      ...AUTO_REVIEW_REQUEST,
      sessionId: 'session-1',
      purpose: 'compaction',
    }, SUCCESS_CHUNKS)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await readAllRows(dir)).toHaveLength(0)
  })

  it('logs but does not record a failed bypass stream', async () => {
    const dir = await mount()
    await streamWaterfall(ctx!, AUTO_REVIEW_REQUEST, [
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } },
    ])
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await readAllRows(dir)).toHaveLength(0)
  })

  it('retains billed aux usage when CONTENT_REFUSED follows a usage chunk (finish error or throw)', async () => {
    const dir = await mount()
    await streamWaterfall(ctx!, {
      ...AUTO_REVIEW_REQUEST,
      sessionId: 'session-refused',
      purpose: 'session-title',
    }, [
      { type: 'usage', usage: { inputTokens: 88, outputTokens: 12, cacheReadTokens: 32 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'refused', code: 'CONTENT_REFUSED' } } },
    ])

    const llm = ctx!.get('llm')
    const waterfall = ctx!.waterfall.bind(ctx!) as (
      thisArg: unknown,
      name: string,
      options: unknown,
      provider: () => AsyncIterable<unknown>,
    ) => AsyncIterable<unknown>
    const refusedErr = Object.assign(new Error('refused'), { code: 'CONTENT_REFUSED' })
    await expect((async () => {
      for await (const _chunk of waterfall(llm, 'llm/stream', AUTO_REVIEW_REQUEST, () => (async function* () {
        yield { type: 'usage', usage: { inputTokens: 55, outputTokens: 9 } }
        throw refusedErr
      })())) { /* consume */ }
    })()).rejects.toThrow('refused')

    const rows = await pollRows(dir, 2)
    expect(rows[0]).toMatchObject({
      kind: 'aux',
      auxKind: 'session-title',
      sessionId: 'session-refused',
      usage: { inputTokens: 88, outputTokens: 12, cacheReadTokens: 32 },
    })
    expect(rows[1]).toMatchObject({
      kind: 'aux',
      auxKind: 'auto-review',
      usage: { inputTokens: 55, outputTokens: 9 },
    })
  })

  it('skips every bypass request when recordAux is false', async () => {
    const dir = await mount({ recordAux: false })
    await streamWaterfall(ctx!, AUTO_REVIEW_REQUEST, SUCCESS_CHUNKS)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await readAllRows(dir)).toHaveLength(0)
  })

  it('preserves session-attributed aux rows across full syncHistory with reconcile', async () => {
    const dir = await mount()
    // 1. Live bypass calls carrying a real owning sessionId land via llm/stream.
    await streamWaterfall(ctx!, {
      ...AUTO_REVIEW_REQUEST,
      sessionId: 'session-1',
      purpose: 'session-title',
    }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx!, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      sessionId: 'session-1',
      purpose: 'auto-review',
    }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx!, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      sessionId: 'session-1',
      purpose: 'timeline-report',
    }, SUCCESS_CHUNKS)
    await pollRows(dir, 3)

    // 2. Also emit a stale failure row that does not exist in session-1's log,
    //    so reconcile genuinely rewrites the same day file on full sync.
    ctx!.emit('session/event', { id: 'session-1' }, retryEvent({ seq: 99 }))
    await pollRows(dir, 4)

    // Unmount so the live plugin queue flushes before running syncHistory on disk.
    ctx!.registry.delete(plugin)
    ctx = undefined

    const persistence = {
      async list() { return [{ header: { id: 'session-1' as SessionId } }] },
      async open() {
        return {
          read: () => Promise.resolve({ events: [messageEvent({ messageId: 'm1', seq: 1 })] }),
          close: () => Promise.resolve(),
        }
      },
    }
    const log = new UsageLog(dir)
    const result = await syncHistory({ persistence, log })
    expect(result).toEqual({ added: 1, skipped: 0, removed: 1, failedSessions: 0 })

    const rowsAfter = await readAllRows(dir)
    const ids = rowsAfter.map(row => row.requestId)
    expect(ids).toContain('m1')
    expect(ids.filter(id => String(id).startsWith('aux:session-title:'))).toHaveLength(1)
    expect(ids.filter(id => String(id).startsWith('aux:auto-review:'))).toHaveLength(1)
    expect(ids.filter(id => String(id).startsWith('aux:timeline-report:'))).toHaveLength(1)
    expect(ids).not.toContain('failure:session-1:99')
  })

  it('links live RequestObserver attempts with persisted aux rows for auto-review and timeline-report without duplication in stats route', async () => {
    const routes: WebRoute[] = []
    class MockWebServer extends Service {
      constructor(c: Context) { super(c, 'webServer') }
      register(route: WebRoute): () => void { routes.push(route); return () => {} }
    }
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(MockPersistence)
    await next.plugin(MockLlm)
    await next.plugin(MockWebServer)
    await next.plugin(plugin, {})
    ctx = next
    const dir = join(home, 'token-usage')
    await waitForState(dir)

    const deadline = Date.now() + 2_000
    let statsRoute: WebRoute | undefined
    while (Date.now() < deadline) {
      statsRoute = routes.find(route => route.path === STATS_PATH)
      if (statsRoute !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(statsRoute).toBeDefined()

    await streamWaterfall(ctx, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      sessionId: 'session-1',
      purpose: 'auto-review',
    }, SUCCESS_CHUNKS)
    await streamWaterfall(ctx, {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      messages: [],
      sessionId: 'session-1',
      purpose: 'timeline-report',
    }, SUCCESS_CHUNKS)
    await pollRows(dir, 2)

    const req = { method: 'GET', url: `${STATS_PATH}?root=session-1&scope=self&fields=session`, headers: {} } as IncomingMessage
    let body = ''
    const res = {
      writeHead: () => {},
      end: (chunk?: unknown) => { if (typeof chunk === 'string') body += chunk },
    } as unknown as ServerResponse
    await statsRoute!.handler(req, res)
    const payload = JSON.parse(body) as {
      total: { requests: number }
      requestDetails: { items: Array<{ id: string; kind: string; auxKind?: string; cache: { band: string; reason?: string } }> }
    }
    expect(payload.total.requests).toBe(2)
    expect(payload.requestDetails.items).toHaveLength(2)
    const kinds = payload.requestDetails.items.map(item => `${item.kind}:${item.auxKind ?? ''}`).sort()
    expect(kinds).toEqual(['aux:auto-review', 'aux:timeline-report'])
    expect(payload.requestDetails.items.every(item => item.cache.band === 'excluded' && item.cache.reason === 'auxiliary')).toBe(true)
  })
})
