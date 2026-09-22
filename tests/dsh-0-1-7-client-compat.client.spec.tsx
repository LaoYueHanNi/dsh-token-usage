// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CardFormTarget, CardFormTargetSnapshot, SectionValue } from '../src/client/card-form.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: (props: { className?: string }) => <span className={props.className} />,
  StateDot: () => null,
  Tooltip: ({ children }: any) => children,
}))

import * as client from '../src/client/index.ts'

interface RegisteredSlot {
  name: string
  id?: string
  key?: string
  inject?: () => Record<string, unknown>
}

class MockSlots extends Service {
  public readonly registered: RegisteredSlot[] = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, callback: () => void) {
    callback()
    return () => {}
  }

  register(declaration: RegisteredSlot, _component: unknown) {
    this.registered.push(declaration)
    return () => {}
  }
}

class MockService extends Service {
  constructor(ctx: Context, name: string, methods: Record<string, unknown> = {}) {
    super(ctx, name)
    Object.assign(this, methods)
  }
}

/**
 * Describe-mirror double shaped like the 0.1.7 host's SettingsDescribeMirror:
 * no view until the first describe read settles, then the served namespaces,
 * with every snapshot replacement notifying subscribers.
 */
class MockDescribeMirror {
  private readonly listeners = new Set<() => void>()
  private view: { namespaces: ReadonlyArray<{ ns: string }> } | undefined

  getSnapshot(): { status: string; view: typeof this.view } {
    return { status: this.view === undefined ? 'idle' : 'ready', view: this.view }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async ensure(): Promise<void> {}

  /** Test seam: the first describe read settles with these namespaces. */
  serve(namespaces: readonly string[]): void {
    this.view = { namespaces: namespaces.map(ns => ({ ns })) }
    for (const listener of this.listeners) listener()
  }
}

/**
 * Service double shaped like the 0.1.7 host's ConfigForms: `get` creates and
 * caches a controller for ANY key ¡ª it never returns undefined ¡ª and each
 * controller derives from the mirror, so a key the mirror does not serve is
 * stuck at 'unavailable' forever. This is the trap the old `get() !==
 * undefined` probe fell into: it bound the package-name key while the mirror
 * serves the entry id.
 */
class MockConfigForms extends Service {
  private readonly controllers = new Map<string, CardFormTarget<SectionValue>>()

  constructor(ctx: Context, private readonly mirror: MockDescribeMirror) {
    super(ctx, 'configForms')
  }

  get(key: string): CardFormTarget<SectionValue> {
    const existing = this.controllers.get(key)
    if (existing !== undefined) return existing
    const mirror = this.mirror
    const target: CardFormTarget<SectionValue> = {
      getSnapshot: (): CardFormTargetSnapshot<SectionValue> => {
        const served = mirror.getSnapshot().view?.namespaces.some(row => row.ns === key) ?? false
        return served
          ? { status: 'ready', writable: true, value: { pricingRegion: 'overseas' } }
          : { status: 'unavailable', writable: false }
      },
      subscribe: () => () => {},
      set: vi.fn(async () => true),
      unset: vi.fn(async () => true),
    }
    this.controllers.set(key, target)
    return target
  }

  describe(): MockDescribeMirror {
    return this.mirror
  }
}

function createClientApp(): { ctx: Context; slots: MockSlots } {
  const ctx = new Context()
  const slots = new MockSlots(ctx)
  new MockService(ctx, 'locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
  })
  new MockService(ctx, 'sessions', {
    list: { getSnapshot: () => ({ byId: {} }) },
    open: (_id: string) => {},
  })
  new MockService(ctx, 'uiWorkspace', {
    pickDirectory: async () => '/test/dir',
  })
  new MockService(ctx, 'connection')
  new MockService(ctx, 'remote')
  return { ctx, slots }
}

/** The card's bound store, read out of the keyed slot registration's face. */
function cardStoreOf(slots: MockSlots, key: string): { getSnapshot: () => { available: boolean } } {
  const declaration = slots.registered.find(entry => entry.key === key)
  const face = declaration?.inject?.() as {
    hooks: { tokenUsageCard: { getSnapshot: () => { available: boolean } } }
  }
  return face.hooks.tokenUsageCard
}

describe('dsh 0.1.7 client compatibility', () => {
  it('does not require settingsScope in the top-level inject list', () => {
    expect(client.inject).not.toContain('settingsScope')
    expect(client.inject).toContain('slots')
    expect(client.inject).toContain('locale')
    expect(client.inject).toContain('sessions')
  })

  it('binds to the mirror-served entry-id namespace, not the package-name key', () => {
    const { ctx, slots } = createClientApp()
    const mirror = new MockDescribeMirror()
    mirror.serve(['token-usage', 'some-other-plugin'])
    new MockConfigForms(ctx, mirror)

    client.apply(ctx)

    const registeredKeys = slots.registered.map(r => r.key ?? r.id)
    expect(registeredKeys).toContain('@laoyuehanni/dsh-token-usage')
    // The regression this guards: `get()` never returns undefined, so only the
    // mirror-served key yields a ready controller ¡ª the card must show.
    expect(cardStoreOf(slots, '@laoyuehanni/dsh-token-usage').getSnapshot().available).toBe(true)
  })

  it('binds the target once the describe mirror loads its namespaces', async () => {
    const { ctx, slots } = createClientApp()
    const mirror = new MockDescribeMirror()
    new MockConfigForms(ctx, mirror)

    client.apply(ctx)
    // Cordis runs an inject callback for an already-present service on a
    // microtask, so the mirror subscription the dynamic effect installs only
    // stands after one flush.
    await new Promise(resolve => { setTimeout(resolve, 0) })

    // Mirror still loading: the card stays on the unavailable fallback rather
    // than binding a package-name controller that can never turn ready.
    expect(cardStoreOf(slots, '@laoyuehanni/dsh-token-usage').getSnapshot().available).toBe(false)

    mirror.serve(['token-usage'])
    expect(cardStoreOf(slots, '@laoyuehanni/dsh-token-usage').getSnapshot().available).toBe(true)
  })

  it('falls back to the package-name key when only it is served', () => {
    const { ctx, slots } = createClientApp()
    const mirror = new MockDescribeMirror()
    mirror.serve(['@laoyuehanni/dsh-token-usage'])
    new MockConfigForms(ctx, mirror)

    client.apply(ctx)

    expect(cardStoreOf(slots, '@laoyuehanni/dsh-token-usage').getSnapshot().available).toBe(true)
  })

  it('binds correctly when host provides legacy settingsScope service', () => {
    const { ctx, slots } = createClientApp()

    const mockTarget: CardFormTarget<SectionValue> = {
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        value: { pricingRegion: 'domestic' },
      }),
      subscribe: () => () => {},
      set: vi.fn(async () => true),
      unset: vi.fn(async () => true),
    }

    new MockService(ctx, 'settingsScope', {
      bind: (_spec: { namespace: string }) => mockTarget,
    })

    client.apply(ctx)

    const registeredKeys = slots.registered.map(r => r.key ?? r.id)
    expect(registeredKeys).toContain('@laoyuehanni/dsh-token-usage')
    expect(cardStoreOf(slots, '@laoyuehanni/dsh-token-usage').getSnapshot().available).toBe(true)
  })

  it('degrades safely without throwing when neither configForms nor settingsScope is present', () => {
    const { ctx, slots } = createClientApp()
    client.apply(ctx)

    const registeredKeys = slots.registered.map(r => r.key ?? r.id)
    expect(registeredKeys).toContain('@laoyuehanni/dsh-token-usage')
    expect(cardStoreOf(slots, '@laoyuehanni/dsh-token-usage').getSnapshot().available).toBe(false)
  })
})
