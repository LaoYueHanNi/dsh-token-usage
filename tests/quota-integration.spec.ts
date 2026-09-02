/**
 * Quota integration tests: the plugin mounted under a real cordis context
 * with fake host services (sessions, persistence, settings, credentials,
 * llm directory, webServer) and a stubbed outbound transport — the full
 * chain from a `request/context` session event through provider tracking,
 * credential resolution, the adapter registry, the TTL cache, and the
 * `/token-usage/quota` route.
 */
import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import type { QuotaPayload } from '../src/wire.ts'

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

  list(): Array<{ events: readonly { type: string }[] }> {
    return []
  }
}

/**
 * Settings service whose `get` answers any namespace another plugin
 * "registered" (the way llm-pi-ai registers its own section on a real
 * host), layered base-over-section like the real provider.
 */
class FakeSettings extends Service {
  private readonly bases = new Map<string, Record<string, unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /** Simulate another plugin registering a namespace (its base layer). */
  declare(ns: string, section: Record<string, unknown>): void {
    this.bases.set(ns, section)
  }

  register(ns: string, _schema: unknown, options: { base?: Record<string, unknown> }) {
    if (options.base !== undefined) this.bases.set(ns, options.base)
    return {
      get: (): Record<string, unknown> => ({ ...this.bases.get(ns) }),
      watch: (): (() => void) => () => {},
    }
  }

  get(ns: string): unknown {
    return structuredClone(this.bases.get(ns))
  }

  /** dsh 0.1.2-alpha.3 shape: register + source sink + change notification. */
  installSection(
    _owner: unknown,
    ns: string,
    _schema: unknown,
    entry: Record<string, unknown>,
    hooks: { setSource: (source: () => unknown) => void, onChange: () => void },
  ): void {
    const scope = this.register(ns, undefined, { base: entry })
    hooks.setSource(() => scope.get())
    hooks.onChange()
    scope.watch(() => hooks.onChange())
  }
}

/** Credentials seam over stored references plus the newer record store. */
class FakeCredentials extends Service {
  private readonly values = new Map<string, string>()
  private readonly records = new Map<string, { key?: string }>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  setValue(ref: string, value: string): void {
    this.values.set(ref, value)
  }

  setRecord(key: string, record: { key?: string }): void {
    this.records.set(key, record)
  }

  async resolve(ref: { toString(): string }): Promise<{ value: string; source: string } | undefined> {
    const value = this.values.get(String(ref))
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async readRecord(key: string): Promise<{ key?: string } | undefined> {
    return structuredClone(this.records.get(key))
  }
}

/** The llm provider directory: one configurable coding-plan route. */
class FakeLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  listConfigurableProviders() {
    return [{
      provider: 'zai-coding-cn',
      displayName: 'Zhipu GLM Coding Plan',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'zai-coding-cn'],
      declared: true,
    }]
  }
}

/** Captures webServer route registrations instead of serving HTTP. */
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
interface Captured {
  status: number
  body: string
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 200, body: '' }
  const res = {
    writeHead: vi.fn((status: number) => { captured.status = status }),
    end: vi.fn((body?: unknown) => {
      if (typeof body === 'string') captured.body += body
    }),
  } as unknown as ServerResponse
  return { res, captured }
}

/** A request/context event for the tracker feed. */
function contextEvent(provider: string, model: string): SessionEvent<'request/context'> {
  return {
    type: 'request/context',
    seq: SessionSeq(1),
    time: Date.now(),
    data: { provider, model },
  } as SessionEvent<'request/context'>
}

/** The Zhipu fixture the stubbed transport answers. */
const ZHIPU_BODY = JSON.stringify({
  data: {
    level: 'Max',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 62.5, nextResetTime: 1_780_000_000_000 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 40, nextResetTime: 1_780_400_000_000 },
    ],
  },
})

describe('quota integration', () => {
  let host: Context | undefined
  let webServer: MockWebServer | undefined
  let settings: FakeSettings | undefined
  let credentials: FakeCredentials | undefined
  let home: string

  /** Mount the plugin over the fake services; fetch stub answers Zhipu. */
  async function mount(config: plugin.Config = {}, options: {
    defaultProvider?: boolean
    apiKeyRef?: boolean
    apiRecord?: boolean
  } = {}): Promise<ReturnType<typeof vi.fn>> {
    const sessions: Array<{ id: string; events: unknown[] }> = []
    const next = new Context()
    await next.plugin(MockSessions)
    await next.plugin(persistenceService(sessions))
    await next.plugin(FakeSettings)
    settings = next.get('settings') as FakeSettings
    settings.declare('llm-pi-ai', { providers: { 'zai-coding-cn': { apiKeyEnv: 'ZAI_KEY' } } })
    if (options.defaultProvider) {
      settings.declare('agent-default-model', { provider: 'zai-coding-cn', model: 'glm-5.2' })
    }
    await next.plugin(FakeCredentials)
    credentials = next.get('credentials') as FakeCredentials
    if (options.apiKeyRef === true) credentials.setValue('ZAI_KEY', 'sk-live-ref')
    if (options.apiRecord === true) credentials.setRecord('llm-pi-ai/zai-coding-cn', { key: 'sk-live-record' })
    await next.plugin(FakeLlm)
    await next.plugin(MockWebServer)
    webServer = next.get('webServer') as MockWebServer
    const fetchMock = vi.fn(async () => new Response(ZHIPU_BODY, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await next.plugin(plugin, { ...config, startupDeferMs: 0 })
    host = next
    return fetchMock
  }

  /** Invoke the captured quota route handler. */
  async function callQuota(session?: string, provider?: string): Promise<Captured & { payload: QuotaPayload }> {
    expect(webServer).toBeDefined()
    const route = webServer!.routes.find(candidate => candidate.path === '/token-usage/quota')
    if (route === undefined) throw new Error('quota route not registered')
    const params = new URLSearchParams()
    if (session !== undefined) params.set('session', session)
    if (provider !== undefined) params.set('provider', provider)
    const query = params.toString()
    const { res, captured } = fakeResponse()
    await route.handler(
      { method: 'GET', headers: {}, url: `/token-usage/quota${query === '' ? '' : `?${query}`}` } as IncomingMessage,
      res,
    )
    return { ...captured, payload: JSON.parse(captured.body) as QuotaPayload }
  }

  beforeEach(async () => {
    // Isolate the plugin's data directory: the deferred start opens
    // `$DSH_HOME/token-usage`, which must never be the developer's real one.
    home = await mkdtemp(join(tmpdir(), 'token-usage-quota-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    if (host !== undefined) {
      host.registry.delete(plugin)
      host = undefined
      webServer = undefined
      settings = undefined
      credentials = undefined
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('tracks the session provider, resolves credentials, and serves the normalized windows', async () => {
    const fetchMock = await mount({}, { apiKeyRef: true })
    host!.emit('session/event', { id: 's1' }, contextEvent('zai-coding-cn', 'glm-5.2'))

    const { payload, status } = await callQuota('s1')
    expect(status).toBe(200)
    expect(payload).toMatchObject({
      status: 'ok',
      provider: 'zai-coding-cn',
      providerName: 'Zhipu GLM Coding Plan',
      adapterId: 'zhipu-coding-plan',
      planTier: 'Max',
      windows: [
        { tier: 'five_hour', usedPercent: 62.5 },
        { tier: 'weekly', usedPercent: 40 },
      ],
    })
    // The credential came through the seam and the key rode the Zhipu
    // header WITHOUT the Bearer prefix.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(call[0])).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    expect((call[1].headers as Record<string, string>).authorization).toBe('sk-live-ref')

    // The TTL cache serves the second poll from memory.
    await callQuota('s1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the record store when the reference layer holds nothing', async () => {
    const fetchMock = await mount({}, { apiRecord: true })
    host!.emit('session/event', { id: 's1' }, contextEvent('zai-coding-cn', 'glm-5.2'))
    const { payload } = await callQuota('s1')
    expect(payload.status).toBe('ok')
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>).authorization).toBe('sk-live-record')
  })

  it('falls back to the default model selection for a session with no activity', async () => {
    const fetchMock = await mount({}, { apiKeyRef: true, defaultProvider: true })
    const { payload } = await callQuota('fresh-session')
    expect(payload.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors the chip-selection provider hint without any session activity', async () => {
    const fetchMock = await mount({}, { apiKeyRef: true })
    // No session events, no default selection — the model chip's hint alone
    // resolves the provider (the button appears the moment the user picks
    // a provider, before any request is sent).
    const { payload } = await callQuota('s1', 'zai-coding-cn')
    expect(payload).toMatchObject({ status: 'ok', provider: 'zai-coding-cn' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers no-provider before any activity when no default exists', async () => {
    const fetchMock = await mount({}, { apiKeyRef: true })
    const { payload } = await callQuota('s1')
    expect(payload).toEqual({ status: 'no-provider', intervalSec: 60 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers the no-credential error when no layer holds a key', async () => {
    const fetchMock = await mount()
    host!.emit('session/event', { id: 's1' }, contextEvent('zai-coding-cn', 'glm-5.2'))
    const { payload } = await callQuota('s1')
    expect(payload).toMatchObject({
      status: 'error',
      provider: 'zai-coding-cn',
      error: { kind: 'no-credential', message: 'ZAI_KEY' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the disabled variant without querying when the config turns the feature off', async () => {
    const fetchMock = await mount({ quota: { enabled: false } }, { apiKeyRef: true })
    host!.emit('session/event', { id: 's1' }, contextEvent('zai-coding-cn', 'glm-5.2'))
    const { payload } = await callQuota('s1')
    expect(payload).toEqual({ status: 'disabled', intervalSec: 60 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stamps the configured poll cadence on enabled payloads', async () => {
    const fetchMock = await mount({ quota: { intervalSec: 15 } }, { apiKeyRef: true, defaultProvider: true })
    const { payload } = await callQuota('fresh-session')
    expect(payload).toMatchObject({ status: 'ok', intervalSec: 15 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers unsupported for a provider with no adapter', async () => {
    const fetchMock = await mount({}, { apiKeyRef: true })
    host!.emit('session/event', { id: 's1' }, contextEvent('anthropic', 'claude-sonnet-4'))
    const { payload } = await callQuota('s1')
    expect(payload).toEqual({
      status: 'unsupported',
      provider: 'anthropic',
      intervalSec: 60,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
