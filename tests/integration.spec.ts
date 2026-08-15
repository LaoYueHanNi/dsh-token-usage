import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { messageEvent } from './helpers.ts'

/** Returns persisted sessions from a shared mutable list. */
function persistenceService(sessions: Array<{ id: string; events: unknown[] }>) {
  return class extends Service {
    constructor(ctx: Context) {
      super(ctx, 'sessionPersistence')
    }

    async list(): Promise<Array<{ id: string }>> {
      return sessions.map(session => ({ id: session.id }))
    }

    async inspect(id: string): Promise<{ events: unknown[] }> {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return { events: session.events }
    }
  }
}

class MockSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
}

/** Wait until a day file exists and return its raw text. */
async function pollLogFile(dir: string): Promise<string> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter(name => name.endsWith('.jsonl'))
    if (names.length > 0) {
      return readFile(join(dir, names[0]!), 'utf8')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('no log file appeared')
}

/** Wait until the first-run auto sync wrote its initialized marker. */
async function waitForState(dir: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((await readdir(dir).catch(() => [] as string[])).includes('state.json')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('initialized marker never appeared')
}

describe('plugin integration', () => {
  let ctx: Context | undefined
  let home: string
  const sessions: Array<{ id: string; events: unknown[] }> = []

  /** Mount the plugin under a fresh context against the shared session list. */
  async function mount(): Promise<{ dir: string }> {
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(plugin)
    ctx = next
    return { dir: join(home, 'token-usage') }
  }

  beforeEach(async () => {
    sessions.length = 0
    home = await mkdtemp(join(tmpdir(), 'token-usage-it-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    // Unload the plugin under test; its registrations are effects.
    if (ctx !== undefined) {
      ctx.registry.delete(plugin)
      ctx = undefined
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('refreshes the cloud pricing mirror on every startup', async () => {
    const feed = JSON.stringify({
      version: 4,
      updatedAt: 1_780_000_000,
      currency: 'RMB',
      models: [
        { modelId: 'deepseek-chat', inputCostPerMillion: 2, outputCostPerMillion: 8 },
      ],
    })
    const fetch = vi.fn(async () => new Response(feed))
    vi.stubGlobal('fetch', fetch)
    const mounted = await mount()
    await waitForState(mounted.dir)
    // The startup auto-sync fetches the feed and lands the mirror.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (existsSync(join(mounted.dir, 'pricing.ccsa.json'))) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(await readFile(join(mounted.dir, 'pricing.ccsa.json'), 'utf8')).toBe(`${feed}\n`)
    // A second startup fetches again (every restart, not just the first).
    ctx!.registry.delete(plugin)
    ctx = undefined
    await mount()
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('writes one live row per assistant/message event', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    const text = await pollLogFile(mounted.dir)
    const row = JSON.parse(text.trim())
    expect(row).toMatchObject({
      requestId: 'm1',
      sessionId: 's1',
      model: 'deepseek-chat',
    })
    expect(row.usage.inputTokens).toBe(10)
  })

  it('ignores non-assistant/message events', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const names = await readdir(mounted.dir).catch(() => [] as string[])
    expect(names.filter(name => name.endsWith('.jsonl'))).toHaveLength(0)
  })

  it('runs the first-run auto sync once and marks initialized', async () => {
    sessions.push({ id: 'old', events: [messageEvent({ messageId: 'm9', seq: 3 })] })
    const mounted = await mount()
    await waitForState(mounted.dir)
    const text = await pollLogFile(mounted.dir)
    const row = JSON.parse(text.trim())
    expect(row).toMatchObject({ requestId: 'm9', sessionId: 'old', model: 'deepseek-chat' })
  })

  it('does not auto-sync on later startups', async () => {
    sessions.push({ id: 'old', events: [messageEvent({ messageId: 'm9', seq: 3 })] })
    const first = await mount()
    await waitForState(first.dir)
    await pollLogFile(first.dir)

    // Unload the first instance, then add history a later startup would miss.
    ctx!.registry.delete(plugin)
    ctx = undefined
    sessions.push({ id: 'newer', events: [messageEvent({ messageId: 'm10', seq: 1 })] })

    const second = await mount()
    // The marker exists, so no auto sync may run for the newer session.
    await new Promise(resolve => setTimeout(resolve, 100))
    const names = await readdir(second.dir).catch(() => [] as string[])
    const files = names.filter(name => name.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    const text = await readFile(join(second.dir, files[0]!), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
  })
})
