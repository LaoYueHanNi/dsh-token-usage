// @vitest-environment jsdom
/**
 * Sidebar "More" menu row + main panel tests: the registrations land on a
 * current shell (dsh 0.2.1-rc.3's navigation-entry slots), degrade silently
 * on a shell that never declares them (the inject callbacks never run, and
 * a rejecting register cannot fail activation), and the click wiring
 * (dismiss-then-open, return-to-conversation) resolves the layout seat at
 * call time without a top-level inject dependency.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: (props: { className?: string }) => <span className={props.className} />,
  IconGaugeOutlineRegular: (props: { size?: number }) => <span data-testid="icon-gauge" data-size={props.size} />,
  IconWarningOutlineRegular: () => <span data-testid="icon-warning" />,
  MenuItemButton: ({ children, onSelect, icon }: {
    children: React.ReactNode
    onSelect?: () => void
    icon?: React.ReactNode
  }) => (
    <button type="button" onClick={onSelect}>{icon}{children}</button>
  ),
  StateDot: () => null,
  Toast: ({ text, onDone }: { text: string; onDone?: () => void }) => (
    <div role="alert" onClick={onDone}>{text}</div>
  ),
  Tooltip: ({ children }: any) => children,
}))

import { PanellistMoreEntry } from '../src/client/PanellistMoreEntry.tsx'
import { PanellistPinEntry } from '../src/client/PanellistPinEntry.tsx'
import { TokenUsageSection } from '../src/client/TokenUsageSection.tsx'
import { UsagePanelPage } from '../src/client/UsagePanelPage.tsx'
import { zh } from '../src/client/locales.ts'
import * as client from '../src/client/index.ts'

interface RegisteredSlot {
  name: string
  id?: string
  key?: string
  order?: number
  inject?: () => Record<string, unknown>
}

/**
 * Slot double honoring the declaration ledger: inject waits on the
 * declaration (an undeclared slot never runs its callback) and register
 * fails loud on an undeclared target — the two halves of the shell
 * contract the degrade-on-old-shell story leans on.
 */
class MockSlots extends Service {
  public readonly registered: RegisteredSlot[] = []
  public readonly disposals: RegisteredSlot[] = []

  constructor(ctx: Context, private readonly declared: readonly string[]) {
    super(ctx, 'slots')
  }

  inject(name: string, callback: () => void) {
    if (this.declared.includes(name)) callback()
    return () => {}
  }

  register(declaration: RegisteredSlot, _component: unknown) {
    if (!this.declared.includes(declaration.name)) {
      throw new Error(`slot "${declaration.name}" is not declared`)
    }
    this.registered.push(declaration)
    return () => { this.disposals.push(declaration) }
  }
}

class MockService extends Service {
  constructor(ctx: Context, name: string, methods: Record<string, unknown> = {}) {
    super(ctx, name)
    Object.assign(this, methods)
  }
}

/** The plugin's own slot targets plus the shell declarations its earlier
 * registrations ride (settings / conversation / plugins surfaces). */
const SHELL_DECLARATIONS = [
  'settings.section',
  'conversation.view',
  'conversation.composer.dock',
  'conversation.input.right',
  'plugins.bundle.config',
] as const

function createClientApp(declared: readonly string[], withLayout = true): {
  ctx: Context
  slots: MockSlots
  selectPanel: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  const selectPanel = vi.fn()
  const slots = new MockSlots(ctx, declared)
  new MockService(ctx, 'locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
  })
  new MockService(ctx, 'sessions', { list: { getSnapshot: () => ({ byId: {} }) } })
  new MockService(ctx, 'uiWorkspace', { pickDirectory: async () => '/test/dir' })
  if (withLayout) new MockService(ctx, 'layout', { selectPanel })
  new MockService(ctx, 'connection')
  new MockService(ctx, 'remote')
  return { ctx, slots, selectPanel }
}

/** zh-bound translate stub: the dictionaries' own copy, raw key otherwise. */
const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as never

afterEach(cleanup)

describe('sidebar More-menu entry', () => {
  it('registers the main panel and the More-menu row on a current shell', () => {
    const { ctx, slots } = createClientApp([...SHELL_DECLARATIONS, 'main', 'sidebar.panellist.actions'])
    client.apply(ctx)
    const main = slots.registered.find(row => row.name === 'main')
    const row = slots.registered.find(entry => entry.name === 'sidebar.panellist.actions')
    expect(main?.key).toBe('token-usage')
    expect(row?.id).toBe('token-usage-more')
    expect(main?.inject?.()).toHaveProperty('returnToConversation')
    expect(row?.inject?.()).toHaveProperty('openPanel')
  })

  it('degrades silently on a shell that never declares the entry slots', () => {
    const { ctx, slots } = createClientApp([...SHELL_DECLARATIONS])
    expect(() => client.apply(ctx)).not.toThrow()
    expect(slots.registered.some(row => row.name === 'sidebar.panellist.actions')).toBe(false)
    expect(slots.registered.some(row => row.name === 'main' && row.key === 'token-usage')).toBe(false)
    // The surfaces older shells do declare still register.
    expect(slots.registered.some(row => row.name === 'settings.section' && row.id === 'token-usage')).toBe(true)
  })

  it('a rejecting registration inside the declared callback cannot fail activation', () => {
    const { ctx, slots } = createClientApp([...SHELL_DECLARATIONS, 'main', 'sidebar.panellist.actions'])
    // The row's cell is taken (a same-priority occupant): register throws
    // for that slot only, and the panel registration must survive it.
    const original = slots.register.bind(slots)
    slots.register = (declaration: RegisteredSlot, component: unknown) => {
      if (declaration.name === 'sidebar.panellist.actions') throw new Error('cell occupied')
      return original(declaration, component)
    }
    expect(() => client.apply(ctx)).not.toThrow()
    expect(slots.registered.some(row => row.name === 'main' && row.key === 'token-usage')).toBe(true)
  })

  it('click wiring: the row dismisses the menu, then opens the panel through ctx.layout', () => {
    const { ctx, slots, selectPanel } = createClientApp([...SHELL_DECLARATIONS, 'main', 'sidebar.panellist.actions'])
    client.apply(ctx)
    const row = slots.registered.find(entry => entry.name === 'sidebar.panellist.actions')!
    const openPanel = (row.inject!() as { openPanel: () => void }).openPanel

    const order: string[] = []
    const onDismiss = (): void => { order.push('dismiss') }
    render(<PanellistMoreEntry {...({
      entries: [], onOpen: vi.fn(), onPinnedChange: vi.fn(), onDismiss,
      openPanel: () => { order.push('open'); openPanel() },
      t,
    } as never)} />)
    fireEvent.click(screen.getByRole('button'))
    expect(order).toEqual(['dismiss', 'open'])
    expect(selectPanel).toHaveBeenCalledWith('token-usage')
  })

  it('page wiring: returnToConversation selects null on the layout service', () => {
    const { ctx, slots, selectPanel } = createClientApp([...SHELL_DECLARATIONS, 'main', 'sidebar.panellist.actions'])
    client.apply(ctx)
    const main = slots.registered.find(row => row.name === 'main')!
    const face = main.inject!() as { returnToConversation: () => void }
    face.returnToConversation()
    expect(selectPanel).toHaveBeenCalledWith(null)
  })

  it('click wiring survives a context without the layout service', () => {
    const { ctx, slots } = createClientApp([...SHELL_DECLARATIONS, 'main', 'sidebar.panellist.actions'], false)
    client.apply(ctx)
    const main = slots.registered.find(row => row.name === 'main')!
    const row = slots.registered.find(entry => entry.name === 'sidebar.panellist.actions')!
    expect(() => {
      ;(main.inject!() as { returnToConversation: () => void }).returnToConversation()
      ;(row.inject!() as { openPanel: () => void }).openPanel()
    }).not.toThrow()
  })

  it('the page shells the section and hands returnToConversation as close', () => {
    const returnToConversation = vi.fn()
    const element = UsagePanelPage({ t, sessionListed: undefined, openSession: undefined, returnToConversation } as never)
    // The official first-level-page shell wraps the section; walk the single
    // child chain down to the section element itself.
    let node = element as { type: unknown; props: { children?: unknown } }
    while (node !== null && typeof node === 'object' && node.type !== TokenUsageSection) {
      node = node.props.children as typeof node
    }
    expect(node.type).toBe(TokenUsageSection)
    expect((node.props as { close?: unknown }).close).toBe(returnToConversation)
    expect((node.props as { variant?: unknown }).variant).toBe('page')
  })
})

describe('sidebar pin row (sidebarPinned setting)', () => {
  /** The slots the pin row rides, beside the surfaces every apply touches. */
  const PIN_DECLARATIONS = [...SHELL_DECLARATIONS, 'main', 'sidebar.panellist', 'sidebar.panellist.actions'] as const

  interface ConfigApp {
    ctx: Context
    slots: MockSlots
    target: {
      getSnapshot(): { status: 'ready' | 'loading'; writable: boolean; value?: { sidebarPinned?: boolean }; user: Record<string, unknown> }
      subscribe(listener: () => void): () => void
      set: ReturnType<typeof vi.fn>
      unset: ReturnType<typeof vi.fn>
    }
    setSnapshot(next: { status: 'ready' | 'loading'; writable: boolean; value?: { sidebarPinned?: boolean } }): void
  }

  /**
   * An app whose `configForms` serves the token-usage namespace through one
   * controllable snapshot: the pin sync reads the value at apply time and on
   * every committed change the test publishes via setSnapshot; a save lands
   * in the user layer (kept across setSnapshot) so the form's read-back sees
   * what it wrote.
   */
  function createAppWithConfig(initial: { status: 'ready' | 'loading'; writable?: boolean; value?: { sidebarPinned?: boolean } }): ConfigApp {
    const app = createClientApp(PIN_DECLARATIONS)
    const listeners = new Set<() => void>()
    let snapshot: { status: 'ready' | 'loading'; writable: boolean; value?: { sidebarPinned?: boolean }; user: Record<string, unknown> }
      = { status: initial.status, writable: initial.writable ?? true, value: initial.value, user: {} }
    const commit = (): void => { for (const listener of [...listeners]) listener() }
    const target = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: vi.fn(async (field: string, value: unknown) => {
        snapshot = { ...snapshot, user: { ...snapshot.user, [field]: value } }
        commit()
        return true
      }),
      unset: vi.fn(async (field: string) => {
        const user = { ...snapshot.user }
        delete user[field]
        snapshot = { ...snapshot, user }
        commit()
        return true
      }),
    }
    new MockService(app.ctx, 'configForms', {
      get: () => target,
      describe: () => ({
        getSnapshot: () => ({ view: { namespaces: [{ ns: 'token-usage' }] } }),
        subscribe: () => () => {},
        ensure: async () => {},
      }),
    })
    return {
      ...app,
      target,
      setSnapshot: (next) => { snapshot = { ...next, user: snapshot.user }; commit() },
    }
  }

  it('keeps the entry in the More menu while the setting reads false or unset', () => {
    for (const value of [undefined, { sidebarPinned: false }] as const) {
      const { ctx, slots } = createAppWithConfig({ status: 'ready', value: value as { sidebarPinned?: boolean } | undefined })
      client.apply(ctx)
      expect(slots.registered.some(row => row.name === 'sidebar.panellist')).toBe(false)
      expect(slots.registered.some(row => row.name === 'sidebar.panellist.actions' && row.id === 'token-usage-more')).toBe(true)
    }
  })

  it('registers the resident row instead of the More-menu row when the setting reads true', () => {
    const { ctx, slots } = createAppWithConfig({ status: 'ready', value: { sidebarPinned: true } })
    client.apply(ctx)
    const row = slots.registered.find(row => row.name === 'sidebar.panellist')
    expect(row?.id).toBe('token-usage')
    expect(row?.order).toBe(50)
    expect(row?.label?.()).toBe('nav.label')
    // Mutually exclusive: the More-menu row never registers.
    expect(slots.registered.some(row => row.name === 'sidebar.panellist.actions')).toBe(false)
  })

  it('follows the setting live: the two entries swap, never coexist', () => {
    const { ctx, slots, setSnapshot } = createAppWithConfig({ status: 'ready', value: { sidebarPinned: false } })
    client.apply(ctx)
    expect(slots.registered.some(row => row.name === 'sidebar.panellist.actions' && row.id === 'token-usage-more')).toBe(true)
    expect(slots.registered.some(row => row.name === 'sidebar.panellist')).toBe(false)
    // Pinning disposes the More-menu row and registers the resident row.
    setSnapshot({ status: 'ready', writable: true, value: { sidebarPinned: true } })
    expect(slots.disposals.some(row => row.id === 'token-usage-more')).toBe(true)
    expect(slots.registered.filter(row => row.name === 'sidebar.panellist')).toHaveLength(1)
    // Unpinning restores the More-menu row and disposes the resident row.
    setSnapshot({ status: 'ready', writable: true, value: { sidebarPinned: false } })
    expect(slots.disposals.filter(row => row.name === 'sidebar.panellist')).toHaveLength(1)
    expect(slots.registered.filter(row => row.name === 'sidebar.panellist.actions' && row.id === 'token-usage-more')).toHaveLength(2)
  })

  it('waits for the configuration target to become ready before reading the setting', () => {
    const { ctx, slots, setSnapshot } = createAppWithConfig({ status: 'loading' })
    client.apply(ctx)
    // The setting is unreadable, so the default More-menu entry is up.
    expect(slots.registered.some(row => row.name === 'sidebar.panellist')).toBe(false)
    expect(slots.registered.some(row => row.name === 'sidebar.panellist.actions')).toBe(true)
    setSnapshot({ status: 'ready', writable: true, value: { sidebarPinned: true } })
    expect(slots.registered.filter(row => row.name === 'sidebar.panellist')).toHaveLength(1)
    expect(slots.disposals.some(row => row.id === 'token-usage-more')).toBe(true)
  })

  it('a rejecting panellist register cannot fail activation', () => {
    const { ctx, slots } = createAppWithConfig({ status: 'ready', value: { sidebarPinned: true } })
    const original = slots.register.bind(slots)
    slots.register = (declaration: RegisteredSlot, component: unknown) => {
      if (declaration.name === 'sidebar.panellist') throw new Error('cell occupied')
      return original(declaration, component)
    }
    expect(() => client.apply(ctx)).not.toThrow()
    expect(slots.registered.some(row => row.name === 'main' && row.key === 'token-usage')).toBe(true)
  })

  it('the pin entry renders the gauge glyph at the requested size', () => {
    const { container } = render(<PanellistPinEntry {...({ size: 16, active: false } as never)} />)
    const glyph = container.querySelector('[data-testid="icon-gauge"]')
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute('data-size')).toBe('16')
  })

  it('stages the pin toggle and commits it only on save', async () => {
    const { ctx, slots, target } = createAppWithConfig({ status: 'ready', value: { sidebarPinned: false } })
    client.apply(ctx)
    const card = slots.registered.find(row => row.name === 'plugins.bundle.config')!
    const face = card.inject!() as {
      editPinned: (value: boolean) => void
      save: () => void
      hooks: { tokenUsageCard: { getSnapshot(): { sidebarPinned: boolean; pinnedDraft: boolean | undefined; dirty: boolean } } }
    }
    const store = face.hooks.tokenUsageCard
    // Staging flips the checkbox and raises the unsaved badge, but writes nothing.
    face.editPinned(true)
    expect(store.getSnapshot().pinnedDraft).toBe(true)
    expect(store.getSnapshot().dirty).toBe(true)
    expect(target.set).not.toHaveBeenCalled()
    // Save commits through the config target and clears the stage.
    face.save()
    await vi.waitFor(() => { expect(store.getSnapshot().pinnedDraft).toBeUndefined() })
    expect(target.set).toHaveBeenCalledWith('sidebarPinned', true)
    expect(store.getSnapshot().dirty).toBe(false)
  })
})
