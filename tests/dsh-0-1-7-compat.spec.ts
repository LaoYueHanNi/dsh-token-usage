// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { messageEvent } from './helpers.ts'

class MockSessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async list(): Promise<Array<{ id: string }>> {
    return []
  }

  async inspect(id: string): Promise<{ events: unknown[] }> {
    return { events: [] }
  }
}

class MockSessions extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  list(): Array<{ snapshotEvents(): unknown[] }> {
    return []
  }
}

/**
 * Simulates deepseek-harness 0.1.7+ SettingsForms: configure/describe (no
 * installSection, no get), recording the presentation policy registrations.
 */
class FakeSettingsForms extends Service {
  public readonly configured: Array<{ auto?: boolean; owner: unknown }> = []
  private descriptors: Array<{ ns: string; value?: unknown }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  get writable(): boolean { return true }

  configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
    this.configured.push({ auto: presentation.auto, owner })
    return () => {}
  }

  describe(): Array<{ ns: string; value?: unknown }> {
    return this.descriptors
  }

  /** Test seam: expose one namespace's live value (the credentials chain reads these). */
  serve(descriptor: { ns: string; value?: unknown }): void {
    this.descriptors = [...this.descriptors, descriptor]
  }
}

describe('dsh 0.1.7 host compatibility', () => {
  let tempHome: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    originalEnv = process.env.DSH_HOME
    tempHome = await mkdtemp(join(tmpdir(), 'token-usage-017-test-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(async () => {
    if (originalEnv !== undefined) process.env.DSH_HOME = originalEnv
    else delete process.env.DSH_HOME
    await rm(tempHome, { recursive: true, force: true }).catch(() => {})
  })

  it('boots directly on the entry config and declares its own card (auto: false)', async () => {
    const app = new Context()
    await app.plugin(MockSessionPersistence)
    await app.plugin(MockSessions)
    const settings = new FakeSettingsForms(app)

    // No deferred settings-attach wait: apply starts the data directory on
    // the resolved entry config the moment it runs.
    await app.plugin(plugin, {})
    // The data directory creation settles asynchronously behind the plugin
    // promise; under a loaded worker (parallel client suites hogging the
    // pool) it can land a beat after `apply` resolves, so poll instead of
    // asserting synchronously.
    await vi.waitFor(() => {
      expect(existsSync(join(tempHome, 'token-usage'))).toBe(true)
    }, { timeout: 2_000 })

    // A live session event is accepted (the recorder is attached).
    const session = { id: 'test-session-017', snapshotEvents: () => [] } as any
    app.emit('session/event', session, messageEvent())

    // The inject callback registers the presentation policy asynchronously.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(settings.configured.length).toBe(1)
    expect(settings.configured[0]?.auto).toBe(false)
    app.registry.delete(plugin)
  })

  it('reads quota settings through describe() without any per-namespace get', async () => {
    const app = new Context()
    await app.plugin(MockSessionPersistence)
    await app.plugin(MockSessions)
    const settings = new FakeSettingsForms(app)
    settings.serve({ ns: 'llm-pi-ai', value: { providers: { 'zai-coding-cn': { apiKeyEnv: 'ZAI_KEY' } } } })

    await app.plugin(plugin, { quota: { enabled: true } })
    expect(app.registry.has(plugin)).toBe(true)

    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(settings.configured.length).toBe(1)
    app.registry.delete(plugin)
  })

  it('re-runs the section-driven start on loader/volatile-update, idempotently', async () => {
    const app = new Context()
    await app.plugin(MockSessionPersistence)
    await app.plugin(MockSessions)
    await app.plugin(plugin, {})

    // A volatile commit notification (the browser card saved) re-runs the
    // section-driven start; the idempotent start makes repeated events no-ops.
    app.emit('loader/volatile-update', [['pricingRegion']])
    app.emit('loader/volatile-update', [['path']])

    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(app.registry.has(plugin)).toBe(true)
    expect(existsSync(join(tempHome, 'token-usage'))).toBe(true)
    app.registry.delete(plugin)
  })
})
