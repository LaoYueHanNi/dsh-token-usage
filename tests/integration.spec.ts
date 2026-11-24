import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { DEFAULT_PRICING_URL_OVERSEAS } from '../src/pricing.ts'
import { ASSOCIATIONS_FILE } from '../src/pricing-associations.ts'
import { compactionEvent, messageEvent, pruneEvent, retryEvent } from './helpers.ts'

/** Returns persisted sessions from a shared mutable list. */
function persistenceService(sessions: Array<{ id: string; events: unknown[] }>) {
  return class extends Service {
    constructor(ctx: Context) {
      super(ctx, 'sessionPersistence')
    }

    async list(): Promise<Array<{ header: { id: string } }>> {
      return sessions.map(session => ({ header: { id: session.id } }))
    }

    async open(id: string): Promise<{ read(): Promise<{ events: unknown[] }>; close(): Promise<void> }> {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return {
        read: () => Promise.resolve({ events: session.events }),
        close: () => Promise.resolve(),
      }
    }
  }
}

class MockSessions extends Service {
  /** Mid-conversation sessions (an open turn) present in the store. */
  interacting = 0
  /** Idle sessions present in the store — these must NOT block a save. */
  idle = 0
  /** Explicit live sessions tracked by id (for event-driven turn tracking tests). */
  liveIds: string[] = []
  /** Spy recording any runtime calls to deprecated `snapshotEvents()`. */
  snapshotCalls = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  list(): Array<{ id: string; snapshotEvents(): unknown[] }> {
    const bump = <T,>(events: T[]): () => T[] => () => {
      this.snapshotCalls++
      return events
    }
    return [
      ...this.liveIds.map(id => ({ id, snapshotEvents: bump([]) })),
      // Idle first is immaterial; an open turn is the only thing that counts.
      ...Array.from({ length: this.idle }, (_, i) => ({ id: `idle-${String(i)}`, snapshotEvents: bump([{ type: 'turn/end' }]) })),
      ...Array.from({ length: this.interacting }, (_, i) => ({ id: `interacting-${String(i)}`, snapshotEvents: bump([{ type: 'turn/start' }]) })),
    ]
  }
}

/** Simulates the host's SettingsForms. */
class FakeSettingsForms extends Service {
  public readonly configured: Array<{ auto?: boolean; owner: unknown }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  get writable(): boolean { return true }

  configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
    this.configured.push({ auto: presentation.auto, owner })
    return () => {}
  }

  describe(): Array<{ ns: string; value?: unknown }> {
    return []
  }
}

/** Simulate host loader updating volatile entry config and emitting volatile-update. */
function updateVolatileConfig(ctx: Context, update: Partial<plugin.Config>): void {
  const runtime = ctx.registry.get(plugin) as { fibers?: Iterable<{ config?: plugin.Config }> } | undefined
  const fiber = runtime?.fibers ? Array.from(runtime.fibers)[0] : undefined
  if (fiber) {
    fiber.config = { ...fiber.config, ...update }
  }
  ctx.emit('loader/volatile-update', [Object.keys(update)])
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

/** Wait until the day file holds at least `count` rows and return them all. */
async function pollRows(dir: string, count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter(name => name.endsWith('.jsonl')).sort()
    const rows: Array<Record<string, unknown>> = []
    for (const name of names) {
      const text = await readFile(join(dir, name), 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        if (line === '') continue
        rows.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
    if (rows.length >= count) return rows
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`no log file with ${String(count)} rows appeared`)
}

/** Read every JSONL row currently in the directory's day files. */
async function readAllRows(dir: string): Promise<Array<Record<string, unknown>>> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter(name => name.endsWith('.jsonl')).sort()
  const rows: Array<Record<string, unknown>> = []
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line !== '') rows.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return rows
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
    // No settings service: the settings-less cap must fire immediately so the
    // assertions below observe the composition-entry directory without delay.
    await next.plugin(plugin, {})
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
    // A second startup fetches again (every restart, not just the first). The
    // sync rides a short coalescing window, so wait for the second fetch to
    // land instead of asserting immediately.
    ctx!.registry.delete(plugin)
    ctx = undefined
    await mount()
    const second = Date.now() + 2_000
    while (Date.now() < second && fetch.mock.calls.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
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

  it('writes one live row per compaction/summary event', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, compactionEvent({ seq: 9 }))
    // The compaction row lands as its own line, keyed on the event seq.
    const rows = await pollRows(mounted.dir, 2)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      requestId: 'compaction:s1:9',
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'compaction',
    })
    expect((rows[1]!.usage as { inputTokens: number }).inputTokens).toBe(100_000)
  })

  it('writes one live failure row per llm/retry event', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, retryEvent({ seq: 4 }))
    const rows = await pollRows(mounted.dir, 2)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      requestId: 'failure:s1:4',
      sessionId: 's1',
      model: 'deepseek-chat',
      kind: 'failure',
      failureCode: 'RATE_LIMIT',
    })
  })

  it('retains pre-refusal usage from assistant/attempt on live CONTENT_REFUSED turn/end', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    const now = 1_700_000_000_000
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'request/context',
      seq: SessionSeq(1),
      time: now,
      data: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'step/start',
      seq: SessionSeq(2),
      time: now + 10,
      data: { turn: 1, step: 1 },
    })
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'assistant/attempt',
      seq: SessionSeq(3),
      time: now + 20,
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', time: now + 20, chunk: { type: 'usage', usage: { inputTokens: 120, outputTokens: 14, cacheReadTokens: 64 } } }],
      },
    })
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'step/end',
      seq: SessionSeq(4),
      time: now + 30,
      data: { turn: 1, step: 1 },
    })
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'turn/end',
      seq: SessionSeq(5),
      time: now + 40,
      data: { turn: 1, reason: { kind: 'error', error: { code: 'CONTENT_REFUSED', message: 'blocked' } } },
    })
    const rows = await pollRows(mounted.dir, 1)
    expect(rows[0]).toMatchObject({
      requestId: 'failure:s1:5',
      sessionId: 's1',
      model: 'deepseek-chat',
      provider: 'deepseek-official',
      kind: 'failure',
      failureCode: 'CONTENT_REFUSED',
      usage: { inputTokens: 120, outputTokens: 14, cacheReadTokens: 64 },
    })
  })

  it('backfills llm/retry events on the first-run sync', async () => {
    sessions.push({
      id: 's1',
      events: [
        messageEvent({ messageId: 'm1', seq: 1 }),
        retryEvent({ seq: 3 }),
        messageEvent({ messageId: 'm2', seq: 6 }),
      ],
    })
    const mounted = await mount()
    await waitForState(mounted.dir)
    const rows = await pollRows(mounted.dir, 3)
    expect(rows.map(row => row.requestId)).toEqual(['m1', 'failure:s1:3', 'm2'])
  })

  it('skips compaction/summary events when recordCompaction is false', async () => {
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(plugin, { recordCompaction: false })
    ctx = next
    const dir = join(home, 'token-usage')
    await waitForState(dir)
    ctx.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollRows(dir, 1)
    ctx.emit('session/event', { id: 's1' }, compactionEvent({ seq: 9 }))
    // The compaction never lands: only the message row stays.
    await new Promise(resolve => setTimeout(resolve, 150))
    const rows = await readAllRows(dir)
    expect(rows.map(row => row.requestId)).toEqual(['m1'])
  })

  it('backfills compaction/summary events on the first-run sync', async () => {
    sessions.push({
      id: 's1',
      events: [
        messageEvent({ messageId: 'm1', seq: 1 }),
        compactionEvent({ seq: 4 }),
        messageEvent({ messageId: 'm2', seq: 6 }),
      ],
    })
    const mounted = await mount()
    await waitForState(mounted.dir)
    // The first-run sync walks every persisted session: both messages and the
    // compaction land, in event order.
    const rows = await pollRows(mounted.dir, 3)
    expect(rows.map(row => row.requestId)).toEqual(['m1', 'compaction:s1:4', 'm2'])
  })

  it('attributes the first plain request after compaction events (live path)', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm0', seq: 1 }))
    await pollRows(mounted.dir, 1)
    // A prune + a summary with no plain request in between: the window folds
    // both, the next plain request consumes them in one attribution, and the
    // compaction's own billing row stays unattributed.
    ctx!.emit('session/event', { id: 's1' }, pruneEvent({ seq: 2, tokens: 900 }))
    ctx!.emit('session/event', { id: 's1' }, compactionEvent({ seq: 3 }))
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1', seq: 4 }))
    ctx!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm2', seq: 5 }))
    // Four rows land: m0, the summary's own billing row, then m1 and m2
    // (the prune itself never produces a row).
    const rows = await pollRows(mounted.dir, 4)
    const byId = new Map(rows.map(row => [row.requestId, row]))
    expect(byId.get('m1')!.compactionAttribution).toEqual([
      { kind: 'prune', count: 1, shadowedTokenCount: 900 },
      { kind: 'summary', count: 1, shadowedTokenCount: 123_456 },
    ])
    expect(byId.get('m2')!.compactionAttribution).toBeUndefined()
    expect(byId.get('compaction:s1:3')!.compactionAttribution).toBeUndefined()
  })

  it('attributes rows on the first-run sync with the same window rule', async () => {
    sessions.push({
      id: 's1',
      events: [
        messageEvent({ messageId: 'm0', seq: 1 }),
        pruneEvent({ seq: 2, tokens: 900 }),
        compactionEvent({ seq: 3 }),
        messageEvent({ messageId: 'm1', seq: 4 }),
      ],
    })
    const mounted = await mount()
    await waitForState(mounted.dir)
    const rows = await pollRows(mounted.dir, 3)
    const byId = new Map(rows.map(row => [row.requestId, row]))
    expect(byId.get('m1')!.compactionAttribution).toEqual([
      { kind: 'prune', count: 1, shadowedTokenCount: 900 },
      { kind: 'summary', count: 1, shadowedTokenCount: 123_456 },
    ])
    expect(byId.get('m0')!.compactionAttribution).toBeUndefined()
  })

  it('ignores non-own inherited prefix events and resolves error route from session fallback', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)

    // Case 1: If non-own events (isOwnSeq === false) arrive on session/event,
    // they never persist rows or feed compactionAttribution, only route/title state.
    const forkedReplay = {
      id: 'fork-child',
      inheritedEventCount: 5,
      isOwnSeq: (seq: number) => seq >= 5,
    }
    ctx!.emit('session/event', forkedReplay, messageEvent({
      messageId: 'parent-msg', seq: 1, provider: 'kimi', model: 'kimi-k2',
    }))
    ctx!.emit('session/event', forkedReplay, compactionEvent({ seq: 2 }))
    ctx!.emit('session/event', forkedReplay, retryEvent({ seq: 3 }))
    ctx!.emit('session/event', forkedReplay, pruneEvent({ seq: 4, tokens: 900 }))
    ctx!.emit('session/event', forkedReplay, {
      type: 'turn/end',
      seq: SessionSeq(6),
      time: 1_700_000_000_006,
      data: { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'RATE_LIMIT', status: 429 } } },
    })
    ctx!.emit('session/event', forkedReplay, messageEvent({ messageId: 'child-msg', seq: 7 }))

    // Case 2: On a real DSH fork (inherited prefix is not replayed on session/event),
    // an immediate own failure falls back to session.requestHeader().
    const forkedFresh = {
      id: 'fork-fresh',
      inheritedEventCount: 5,
      isOwnSeq: (seq: number) => seq >= 5,
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-reasoner' } }),
      requestContext: () => undefined,
    }
    ctx!.emit('session/event', forkedFresh, {
      type: 'turn/end',
      seq: SessionSeq(5),
      time: 1_700_000_000_008,
      data: { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'TIMEOUT', status: 504 } } },
    })

    const rows = await pollRows(mounted.dir, 3)
    expect(rows.map(row => row.requestId)).toEqual([
      'failure:fork-child:6',
      'child-msg',
      'failure:fork-fresh:5',
    ])
    expect(rows[0]).toMatchObject({
      sessionId: 'fork-child',
      model: 'kimi-k2',
      provider: 'kimi',
      kind: 'failure',
      failureCode: 'RATE_LIMIT',
    })
    expect(rows[1]!.compactionAttribution).toBeUndefined()
    expect(rows[2]).toMatchObject({
      sessionId: 'fork-fresh',
      model: 'deepseek-reasoner',
      provider: 'deepseek-official',
      kind: 'failure',
      failureCode: 'TIMEOUT',
    })
  })

  it('folds subagent identity and team mode from live OWN events, never from an inherited prefix', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    const stamp = (seq: number): number => 1_700_000_000_000 + seq
    const catalog = (seq: number, data: Record<string, unknown>): SessionEvent =>
      ({ type: 'subagent/catalog', seq: SessionSeq(seq), time: stamp(seq), data }) as unknown as SessionEvent
    const descriptor = (seq: number, data: Record<string, unknown>): SessionEvent =>
      ({ type: 'subagent/descriptor', seq: SessionSeq(seq), time: stamp(seq), data }) as unknown as SessionEvent
    const teamMode = (seq: number, enabled: boolean): SessionEvent =>
      ({ type: 'team/mode', seq: SessionSeq(seq), time: stamp(seq), data: { enabled } }) as unknown as SessionEvent

    // The root turns the agent team on and catalogues two children: a named
    // local one and an external one.
    ctx!.emit('session/event', { id: 'root' }, teamMode(1, true))
    ctx!.emit('session/event', { id: 'root' }, catalog(2, {
      version: 3, childId: 'researcher', childCreatedAt: 1, mode: 'continuable', label: '调研竞品定价', name: 'researcher',
    }))
    ctx!.emit('session/event', { id: 'root' }, catalog(3, {
      version: 3, childId: 'codex-helper', childCreatedAt: 2, mode: 'external', label: '用 Codex 写脚本', name: 'codex-helper',
    }))
    // The local child's own events: its header, then its descriptor (which
    // agrees with the catalog, as the host writes them from one source).
    ctx!.emit('session/event', { id: 'researcher', header: { cwd: '/work/app', origin: 'subagent', parentSession: 'root' } },
      descriptor(1, { version: 3, mode: 'continuable', provider: 'task', label: '调研竞品定价' }))
    // A fork copy replays its inherited prefix on session/event: the
    // ancestor's team mode and catalog entry are NOT the copy's own facts.
    const fork = { id: 'fork-copy', inheritedEventCount: 2, isOwnSeq: (seq: number) => seq >= 2 }
    ctx!.emit('session/event', fork, teamMode(0, true))
    ctx!.emit('session/event', fork, catalog(1, {
      version: 3, childId: 'ancestor-child', childCreatedAt: 1, mode: 'continuable', label: '祖先的委派', name: 'old',
    }))
    // Its own toggle lands.
    ctx!.emit('session/event', fork, teamMode(2, false))

    // Every write is fire-and-forget: wait until each one has landed.
    const path = join(mounted.dir, 'sessions.json')
    const deadline = Date.now() + 2_000
    for (;;) {
      const index = await readFile(path, 'utf8').then(text => JSON.parse(text) as Record<string, Record<string, unknown>>).catch(() => ({}))
      if (index.root?.teamMode === true
        && typeof index.researcher?.subagentLabel === 'string'
        && index['codex-helper']?.subagentMode === 'external'
        && index['fork-copy']?.teamMode === false) {
        expect(index).toEqual({
          root: { teamMode: true },
          researcher: {
            cwd: '/work/app', origin: 'subagent', parentSession: 'root',
            subagentName: 'researcher', subagentLabel: '调研竞品定价', subagentMode: 'continuable',
          },
          // No session, no origin: listed under the root, outside the lineage.
          'codex-helper': { parentSession: 'root', subagentName: 'codex-helper', subagentLabel: '用 Codex 写脚本', subagentMode: 'external' },
          'fork-copy': { teamMode: false },
        })
        break
      }
      if (Date.now() > deadline) throw new Error(`identity never landed: ${JSON.stringify(index)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })

  it('ignores non-assistant/message events', async () => {
    const mounted = await mount()
    await waitForState(mounted.dir)
    ctx!.emit('session/event', { id: 's1' }, {
      type: 'turn/start',
      seq: SessionSeq(0),
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

  it('syncs exactly once at startup, from the settings-resolved region', async () => {
    const feed = JSON.stringify({
      version: 7,
      updatedAt: 0,
      currency: 'RMB',
      models: [{ modelId: 'm', inputCostPerMillion: 1, outputCostPerMillion: 2 }],
    })
    const fetch = vi.fn(async () => new Response(feed))
    vi.stubGlobal('fetch', fetch)
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    // A stored region from the profile patch enters as entry config.
    await next.plugin(plugin, { pricingRegion: 'overseas' })
    ctx = next

    // Wait for the first fetch, then give transient startup events a beat to
    // see whether a second, redundant sync sneaks in.
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && fetch.mock.calls.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const urls = fetch.mock.calls.map(call => String(call[0]))
    await new Promise(resolve => setTimeout(resolve, 1_500))
    const settled = fetch.mock.calls.map(call => String(call[0]))

    expect(urls).toEqual([DEFAULT_PRICING_URL_OVERSEAS])
    expect(settled).toEqual([DEFAULT_PRICING_URL_OVERSEAS])
  })
})

/**
 * Framework timeout for the whole relocation group.
 *
 * The relocation tests below poll a directory away, so their helper must
 * never wait longer than the framework deadline — otherwise the framework
 * kills the test first and the real cause (a slow move) is hidden. Keeping
 * one constant for the group keeps the helper and the framework in sync.
 *
 * The budget is generous on purpose: a full parallel run on a loaded
 * machine can stretch a single case well past what it takes alone, and a
 * budget derived from the time already spent would shrink to nothing
 * exactly when the machine is slow.
 */
const RELOCATION_TIMEOUT_MS = 120_000

/** How long one poll waits for a directory to disappear. Two polls in one
 * case (a move and its way back) stay well inside the framework timeout. */
const POLL_GONE_BUDGET_MS = 45_000

describe('live data-directory relocation', { timeout: RELOCATION_TIMEOUT_MS }, () => {
  let host: Context | undefined
  let sessionsService: MockSessions | undefined
  let home: string
  const sessions: Array<{ id: string; events: unknown[] }> = []

  /** Mount the plugin with the settings service over an initial section. */
  async function mountWith(section: plugin.Config): Promise<void> {
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(FakeSettingsForms)
    sessionsService = next.get('sessions') as MockSessions
    await next.plugin(plugin, section)
    host = next
  }

  /** Every request id across all day files of a directory. */
  async function allIds(dir: string): Promise<string[]> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'))
    const ids: string[] = []
    for (const name of names) {
      const text = await readFile(join(dir, name), 'utf8')
      for (const line of text.split('\n')) {
        if (line !== '') ids.push(JSON.parse(line).requestId as string)
      }
    }
    return ids
  }

  /** Poll until a directory stops existing (migration settled and removed it). */
  async function pollGone(dir: string): Promise<void> {
    // The migration is asynchronous and waits on the append queue behind any
    // in-flight startup work, so a tight deadline flakes under the parallel
    // full-suite load (Windows file locks make the removal itself slower).
    //
    // The budget is fixed and comfortably below the framework timeout: the
    // helper must always give up *before* the framework does, otherwise the
    // framework timeout hides the real cause. Reporting "timed out" also
    // keeps the message honest — a slow move is not a directory that
    // refuses to go.
    const deadline = Date.now() + POLL_GONE_BUDGET_MS
    while (Date.now() < deadline) {
      if (!existsSync(dir)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(
      `timed out after ${POLL_GONE_BUDGET_MS}ms waiting for the directory to be removed: ${dir}`
      + ` (left: ${(await readdir(dir).catch(() => [])).join(', ')})`,
    )
  }

  beforeEach(async () => {
    sessions.length = 0
    home = await mkdtemp(join(tmpdir(), 'token-usage-move-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    if (host !== undefined) {
      host.registry.delete(plugin)
      host = undefined
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('starts directly on the stored directory without a boot-time migration', async () => {
    const dirB = join(home, 'B')
    await mountWith({ path: dirB })

    // The running directory is the stored one...
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirB)
    // ...and the default directory was never opened, let alone migrated away.
    expect(existsSync(join(home, 'token-usage'))).toBe(false)
  })

  it('starts the default directory when no path is specified', async () => {
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(plugin, {})
    host = next

    await waitForState(join(home, 'token-usage'))
    host.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(join(home, 'token-usage'))
  })

  it('refuses the directory save itself while conversations run, then moves once they end', async () => {
    const dirA = join(home, 'A')
    const dirB = join(home, 'B')
    await mountWith({ path: dirA })

    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirA)

    // Runtime turn tracking uses live turn/start & turn/end events, never
    // calling the deprecated session.snapshotEvents() on relocation checks.
    const callsAfterBoot = sessionsService!.snapshotCalls
    sessionsService!.liveIds = ['s-live-1', 's-live-2']
    host!.emit('session/event', { id: 's-live-1' }, { type: 'turn/start', turn: 1 })
    host!.emit('session/event', { id: 's-live-2' }, { type: 'turn/start', turn: 1 })
    updateVolatileConfig(host!, { path: dirB })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sessionsService!.snapshotCalls).toBe(callsAfterBoot)
    expect(existsSync(dirA)).toBe(true)
    expect(existsSync(join(dirB, 'usage-2026-08-17.jsonl'))).toBe(false)
    // Events keep landing in the unchanged directory.
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm2' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await allIds(dirA)).sort()).toEqual(['m1', 'm2'])

    // One session closes its turn and the other disappears from the store
    // without a closing turn/end: both stop blocking and the move goes through.
    host!.emit('session/event', { id: 's-live-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    sessionsService!.liveIds = ['s-live-1']
    sessionsService!.idle = 2
    updateVolatileConfig(host!, { path: dirB })
    await pollGone(dirA)
    expect(sessionsService!.snapshotCalls).toBe(callsAfterBoot)
    expect((await allIds(dirB)).sort()).toEqual(['m1', 'm2'])
  })

  it('prefers ctx.agents.turnBoundaryOf when available and never calls snapshotEvents', async () => {
    const dirA = join(home, 'A')
    const dirB = join(home, 'B')
    let openTurn = true
    const next = new Context()
    await next.plugin(MockSessions)
    sessionsService = next.get('sessions') as MockSessions
    sessionsService.liveIds = ['s-agent']
    await next.plugin(class extends Service {
      constructor(ctx: Context) { super(ctx, 'agents') }
      turnBoundaryOf(): { openTurnStartSeq: number | null } {
        return { openTurnStartSeq: openTurn ? 3 : null }
      }
    })
    await next.plugin(FakeSettingsForms)
    await next.plugin(persistenceService([]))
    await next.plugin(plugin, { path: dirA })
    host = next

    host.emit('session/event', { id: 's-agent' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirA)

    updateVolatileConfig(host, { path: dirB })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(dirA)).toBe(true)
    expect(sessionsService.snapshotCalls).toBe(0)

    openTurn = false
    updateVolatileConfig(host, { path: dirB })
    await pollGone(dirA)
    expect(sessionsService.snapshotCalls).toBe(0)
    expect((await allIds(dirB)).sort()).toEqual(['m1'])
  })

  it('saves a region edit freely while conversations are active', async () => {
    const dirA = join(home, 'A')
    await mountWith({ path: dirA })
    sessionsService!.liveIds = ['s-live-1']
    host!.emit('session/event', { id: 's-live-1' }, { type: 'turn/start', turn: 1 })
    // A region-only write changes no directory: the veto must not fire.
    expect(() => updateVolatileConfig(host!, { pricingRegion: 'overseas' })).not.toThrow()
  })

  it('moves files verbatim (per-day names kept), live writes follow, source is cleaned', async () => {
    const dirA = join(home, 'A')
    const dirB = join(home, 'B')
    await mountWith({ path: dirA })

    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirA)
    await waitForState(dirA)
    const choices = '{"version":1,"revision":5,"associations":[{"sourceModel":"p/internal","targetModelId":"m"}]}'
    await writeFile(join(dirA, ASSOCIATIONS_FILE), choices)

    updateVolatileConfig(host!, { path: dirB })
    await pollGone(dirA)

    // The row and marker landed in B under their own names.
    expect((await allIds(dirB)).sort()).toEqual(['m1'])
    expect(existsSync(join(dirB, 'state.json'))).toBe(true)
    expect(await readFile(join(dirB, ASSOCIATIONS_FILE), 'utf8')).toBe(choices)
    // Events after the move write into B.
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm2' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await allIds(dirB)).sort()).toEqual(['m1', 'm2'])
  })

  it('association conflicts abort host relocation and keep live writes in the source', async () => {
    const dirA = join(home, 'A'), dirB = join(home, 'B')
    await mountWith({ path: dirA })
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirA); await waitForState(dirA)
    await mkdir(dirB)
    await writeFile(join(dirA, ASSOCIATIONS_FILE), 'left')
    await writeFile(join(dirB, ASSOCIATIONS_FILE), 'rght')
    updateVolatileConfig(host!, { path: dirB })
    await new Promise(resolve => setTimeout(resolve, 100))
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm2' }))
    await vi.waitFor(async () => expect((await allIds(dirA)).sort()).toEqual(['m1', 'm2']))
    expect(await allIds(dirB)).toEqual([])
    expect(await readFile(join(dirA, ASSOCIATIONS_FILE), 'utf8')).toBe('left')
    expect(await readFile(join(dirB, ASSOCIATIONS_FILE), 'utf8')).toBe('rght')
  })

  it('refreshes pricing in the new directory when the first startup download outlives migration', async () => {
    const dirA = join(home, 'A'), dirB = join(home, 'B')
    const feed = JSON.stringify({ currency: 'RMB', models: [{ modelId: 'm', inputCostPerMillion: 1, outputCostPerMillion: 2 }] })
    let finish!: (value: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockImplementation(async () => new Response(feed))
    vi.stubGlobal('fetch', fetch)
    await mountWith({ path: dirA })
    await waitForState(dirA)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    updateVolatileConfig(host!, { path: dirB })
    await pollGone(dirA)
    await vi.waitFor(async () => expect(await readFile(join(dirB, 'pricing.ccsa.json'), 'utf8')).toBe(feed + '\n'))
    finish(new Response(feed))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(existsSync(dirA)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('moves to an explicit directory and back to the entry default when the stored path clears', async () => {
    const dirA = join(home, 'A')
    const dirDefault = join(home, 'token-usage')
    // Entry without a path: the resolved directory is the DSH_HOME default.
    await mountWith({})

    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirDefault)

    // Store an explicit path: the data moves into it.
    updateVolatileConfig(host!, { path: dirA })
    await pollGone(dirDefault)
    expect((await allIds(dirA)).sort()).toEqual(['m1'])

    // Clearing the stored layer reverts to the composition entry, whose
    // absent path resolves back to the default — the data follows.
    updateVolatileConfig(host!, { path: undefined })
    await pollGone(dirA)
    expect((await allIds(dirDefault)).sort()).toEqual(['m1'])
  })
})
