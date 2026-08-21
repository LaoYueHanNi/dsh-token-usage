import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as plugin from '../src/index.ts'
import { DEFAULT_PRICING_URL_OVERSEAS } from '../src/pricing.ts'
import { messageEvent } from './helpers.ts'

/** Returns persisted sessions from a shared mutable list. */
function persistenceService(sessions: Array<{ id: string; events: Array<{ seq: number; type: string; time?: number; data?: unknown }> }>) {
  // Per-session revision tokens, bumped whenever a test pushes more events
  // onto a session — mirrors the backend's `listSnapshots` contract where
  // an event append changes the stored log's revision.
  const revisions = new Map<string, number>()
  for (const session of sessions) revisions.set(session.id, 1)
  return class extends Service {
    readonly readFromCalls = new Map<string, number>()

    constructor(ctx: Context) {
      super(ctx, 'sessionPersistence')
    }

    async listSnapshots(): Promise<Array<{ header: { id: string; version: number; createdAt: number }; revision: string }>> {
      return sessions.map(session => ({
        header: { id: session.id, version: 0, createdAt: 0 },
        revision: `rev-${String(revisions.get(session.id) ?? 1)}`,
      }))
    }

    async inspect(id: string): Promise<{ events: unknown[] }> {
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      return { events: session.events }
    }

    /** readFrom returns events at or past fromSeq — sync needs the suffix. */
    async readFrom(id: string, fromSeq: number): Promise<{ meta: { id: string }; events: unknown[] }> {
      this.readFromCalls.set(id, (this.readFromCalls.get(id) ?? 0) + 1)
      const session = sessions.find(candidate => candidate.id === id)
      if (session === undefined) throw new Error(`missing session ${id}`)
      const events = session.events.filter(event => event.seq >= fromSeq)
      return { meta: { id }, events }
    }
  }
}

class MockSessions extends Service {
  /** Mid-conversation sessions (an open turn) the migration precondition counts. */
  interacting = 0
  /** Idle sessions present in the store — these must NOT block a save. */
  idle = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  list(): Array<{ events: unknown[] }> {
    return [
      // Idle first is immaterial; an open turn is the only thing that counts.
      ...Array.from({ length: this.idle }, () => ({ events: [{ type: 'turn/end' }] })),
      ...Array.from({ length: this.interacting }, () => ({ events: [{ type: 'turn/start' }] })),
    ]
  }
}

/**
 * Minimal mutable settings service: stores committed sections per namespace
 * and announces each commit the way a settings-document change does, driving
 * `onChange` the way a real provider would.
 */
class FakeSettings extends Service {
  private readonly sections = new Map<string, Record<string, unknown>>()
  private readonly bases = new Map<string, Record<string, unknown>>()
  private readonly validators = new Map<string, ((value: Record<string, unknown>) => void) | undefined>()
  private readonly watchers = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  register(ns: string, _schema: unknown, options: { base?: Record<string, unknown>, validate?: (value: Record<string, unknown>) => void }) {
    const base = options.base ?? {}
    this.bases.set(ns, base)
    this.validators.set(ns, options.validate)
    return {
      get: (): Record<string, unknown> => ({ ...base, ...this.sections.get(ns) }),
      watch: (listener: () => void): (() => void) => {
        this.watchers.add(listener)
        return () => { this.watchers.delete(listener) }
      },
    }
  }

  /**
   * Store one namespace's user layer and announce the commit — after the
   * registered validator vets the resolved section, the way the real
   * provider refuses a write before anything persists.
   */
  async commit(ns: string, section: Record<string, unknown>): Promise<void> {
    const validate = this.validators.get(ns)
    if (validate !== undefined) validate({ ...this.bases.get(ns), ...section })
    this.sections.set(ns, section)
    for (const watcher of this.watchers) watcher()
  }
}

/** In-process settings provider with one fixed document (mirrors harness tests). */
class BareSettingsProvider extends SettingsProvider {
  private readonly doc: Record<string, unknown>

  constructor(ctx: Context, doc: Record<string, unknown>) {
    super(ctx)
    this.doc = doc
  }

  override get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
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

/** Wait until the per-session sync watermark lands in state.json. */
async function waitForState(dir: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((await readdir(dir).catch(() => [] as string[])).includes('state.json')) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('sync watermark never appeared')
}

/** Read every requestId out of every day file in the directory. */
async function readIds(dir: string): Promise<string[]> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter(name => name.endsWith('.jsonl'))
  const ids: string[] = []
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line === '') continue
      const row = JSON.parse(line) as { requestId: string }
      ids.push(row.requestId)
    }
  }
  return ids
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
    // No settings service: the deferred boot must fire immediately so the
    // assertions below observe the composition-entry directory without delay.
    await next.plugin(plugin, { startupDeferMs: 0 })
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

  it('runs the first-run auto sync and writes the per-session watermark', async () => {
    sessions.push({ id: 'old', events: [messageEvent({ messageId: 'm9', seq: 3 })] })
    const mounted = await mount()
    await waitForState(mounted.dir)
    const text = await pollLogFile(mounted.dir)
    const row = JSON.parse(text.trim())
    expect(row).toMatchObject({ requestId: 'm9', sessionId: 'old', model: 'deepseek-chat' })
  })

  it('re-syncs the suffix past the watermark on later startups', async () => {
    sessions.push({ id: 'old', events: [messageEvent({ messageId: 'm9', seq: 3 })] })
    const first = await mount()
    await waitForState(first.dir)
    await pollLogFile(first.dir)

    // Unload the first instance, then add history that the live hook would
    // miss in a normal re-install flow.
    ctx!.registry.delete(plugin)
    ctx = undefined
    sessions.push({ id: 'newer', events: [messageEvent({ messageId: 'm10', seq: 1 })] })

    const second = await mount()
    // A re-install must catch up on the newer session even though the
    // watermark already exists for `old`. Wait for the suffix to land.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const text = await readFile(join(second.dir, 'state.json'), 'utf8').catch(() => '')
      const progress = JSON.parse(text) as { sessions: Record<string, unknown> }
      if (progress.sessions['newer'] !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const ids = await readIds(second.dir)
    // m9 was the first mount's live-hook row; m10 is the re-install catch-up.
    // The second mount must NOT duplicate m9 (dedupe via the day-file scan).
    expect(ids.sort()).toEqual(['m10', 'm9'])
  })

  it('short-circuits readFrom when every session revision is unchanged', async () => {
    // The startup-stall fix: when no session has been touched between
    // startups, the revision short-circuit must keep `readFrom` from being
    // called at all (JSONL backends would otherwise parse every artifact
    // just to confirm an empty suffix).
    sessions.push({ id: 'a', events: [messageEvent({ messageId: 'm1', seq: 1 })] })
    sessions.push({ id: 'b', events: [messageEvent({ messageId: 'm2', seq: 1 })] })
    const first = await mount()
    await waitForState(first.dir)

    // Capture the persistence service the second mount will observe so we
    // can assert it issued zero `readFrom` calls during the second sync.
    ctx!.registry.delete(plugin)
    ctx = undefined
    let persistence: { readFromCalls: Map<string, number> } | undefined
    const next = new Context()
    await next.plugin(MockSessions)
    const PService = persistenceService(sessions)
    await next.plugin(PService)
    await next.plugin(plugin, { startupDeferMs: 0 })
    persistence = next.get('sessionPersistence') as { readFromCalls: Map<string, number> }
    ctx = next

    // Give the fire-and-forget startup sync time to settle.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const text = await readFile(join(first.dir, 'state.json'), 'utf8').catch(() => '')
      const progress = JSON.parse(text) as { sessions: Record<string, { lastSeenRevision?: string }> }
      if (progress.sessions['a']?.lastSeenRevision !== undefined
          && progress.sessions['b']?.lastSeenRevision !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(persistence!.readFromCalls.get('a') ?? 0).toBe(0)
    expect(persistence!.readFromCalls.get('b') ?? 0).toBe(0)
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
    // A stored region (the web card's "overseas") must drive the startup sync.
    await next.plugin(BareSettingsProvider, { 'token-usage': { pricingRegion: 'overseas' } })
    await next.plugin(plugin)
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

describe('live data-directory relocation', () => {
  let host: Context | undefined
  let settings: FakeSettings | undefined
  let sessionsService: MockSessions | undefined
  let home: string
  const sessions: Array<{ id: string; events: unknown[] }> = []

  /** Mount the plugin with the settings service over an initial section. */
  async function mountWith(section: { path?: string }): Promise<void> {
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(FakeSettings)
    settings = next.get('settings') as FakeSettings
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
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (!existsSync(dir)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`directory still exists: ${dir}`)
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
      settings = undefined
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('starts directly on the stored directory without a boot-time migration', async () => {
    const dirB = join(home, 'B')
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(FakeSettings)
    settings = next.get('settings') as FakeSettings
    sessionsService = next.get('sessions') as MockSessions
    // The stored override from a previous run, present BEFORE the plugin
    // loads — the way settings.yaml reads at boot.
    await settings.commit('token-usage', { path: dirB })
    await next.plugin(plugin, {})
    host = next

    // The running directory is the stored one...
    host.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirB)
    // ...and the default directory was never opened, let alone migrated
    // away: a synchronous first start would have opened it before the
    // settings attach repointed the section source.
    expect(existsSync(join(home, 'token-usage'))).toBe(false)
  })

  it('settles onto the stored directory when mounted concurrently with the settings service', async () => {
    // The dsh Loader mounts every profile entry concurrently, so the plugin
    // and the settings provider start in no guaranteed order. The deferred
    // boot must still settle on the stored directory, never the default.
    const dirB = join(home, 'B')
    const next = new Context()
    await Promise.all([
      next.plugin(MockSessions),
      next.plugin(persistenceService(sessions)),
      next.plugin(BareSettingsProvider, { 'token-usage': { path: dirB } }),
      next.plugin(plugin),
    ])
    host = next

    host.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirB)
    expect(existsSync(join(home, 'token-usage'))).toBe(false)
  })

  it('refuses the directory save itself while conversations run, then moves once they end', async () => {
    const dirA = join(home, 'A')
    const dirB = join(home, 'B')
    await mountWith({ path: dirA })

    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirA)

    // A mid-conversation session vetoes the WRITE: nothing persists, nothing copies.
    sessionsService!.interacting = 2
    await expect(settings!.commit('token-usage', { path: dirB })).rejects.toThrow(/session/)
    expect(existsSync(dirA)).toBe(true)
    expect(existsSync(join(dirB, 'usage-2026-08-17.jsonl'))).toBe(false)
    // Events keep landing in the unchanged directory.
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm2' }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await allIds(dirA)).sort()).toEqual(['m1', 'm2'])

    // The sessions idle but stay present: existence alone never blocks, and
    // the same save goes through with the data following.
    sessionsService!.interacting = 0
    sessionsService!.idle = 2
    await settings!.commit('token-usage', { path: dirB })
    await pollGone(dirA)
    expect((await allIds(dirB)).sort()).toEqual(['m1', 'm2'])
  })

  it('saves a region edit freely while conversations are active', async () => {
    const dirA = join(home, 'A')
    await mountWith({ path: dirA })
    sessionsService!.interacting = 1
    // A region-only write changes no directory: the veto must not fire.
    await expect(settings!.commit('token-usage', { path: dirA, pricingRegion: 'overseas' })).resolves.toBeUndefined()
  })

  it('moves files verbatim (per-day names kept), live writes follow, source is cleaned', async () => {
    const dirA = join(home, 'A')
    const dirB = join(home, 'B')
    await mountWith({ path: dirA })

    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirA)
    await waitForState(dirA)

    await settings!.commit('token-usage', { path: dirB })
    await pollGone(dirA)

    // The row and marker landed in B under their own names.
    expect((await allIds(dirB)).sort()).toEqual(['m1'])
    expect(existsSync(join(dirB, 'state.json'))).toBe(true)
    // Events after the move write into B.
    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm2' }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await allIds(dirB)).sort()).toEqual(['m1', 'm2'])
  })

  it('moves to an explicit directory and back to the entry default when the stored path clears', async () => {
    const dirA = join(home, 'A')
    const dirDefault = join(home, 'token-usage')
    // Entry without a path: the resolved directory is the DSH_HOME default.
    await mountWith({})

    host!.emit('session/event', { id: 's1' }, messageEvent({ messageId: 'm1' }))
    await pollLogFile(dirDefault)

    // Store an explicit path: the data moves into it.
    await settings!.commit('token-usage', { path: dirA })
    await pollGone(dirDefault)
    expect((await allIds(dirA)).sort()).toEqual(['m1'])

    // Clearing the stored layer reverts to the composition entry, whose
    // absent path resolves back to the default — the data follows.
    await settings!.commit('token-usage', {})
    await pollGone(dirA)
    expect((await allIds(dirDefault)).sort()).toEqual(['m1'])
  })
})
