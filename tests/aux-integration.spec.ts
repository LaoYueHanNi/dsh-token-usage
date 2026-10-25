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
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { messageEvent } from './helpers.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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
 * inspect seam must exist or the first-run sync reports an unsupported
 * persistence and never writes its initialized marker. */
class MockPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async list(): Promise<Array<{ id: string }>> {
    return []
  }

  async inspect(id: string): Promise<{ events: unknown[] }> {
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

  it('classifies session-title requests by their purpose marker', async () => {
    const dir = await mount()
    await streamWaterfall(ctx!, {
      ...AUTO_REVIEW_REQUEST,
      sessionId: 'session-1',
      purpose: 'session-title',
    }, SUCCESS_CHUNKS)
    const rows = await pollRows(dir, 1)
    expect(rows[0]).toMatchObject({ kind: 'aux', auxKind: 'session-title', sessionId: '' })
  })

  it('does not record conversation-loop or compaction requests', async () => {
    const dir = await mount()
    // A loop request (session id) and a compaction summary are already
    // covered by their own session events; the recorder must leave both alone.
    await streamWaterfall(ctx!, { ...AUTO_REVIEW_REQUEST, sessionId: 'session-1' }, SUCCESS_CHUNKS)
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

  it('skips every bypass request when recordAux is false', async () => {
    const dir = await mount({ recordAux: false })
    await streamWaterfall(ctx!, AUTO_REVIEW_REQUEST, SUCCESS_CHUNKS)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await readAllRows(dir)).toHaveLength(0)
  })
})
