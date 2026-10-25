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
  IconGaugeOutlineRegular: () => <span data-testid="icon-gauge" />,
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
    return () => {}
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
