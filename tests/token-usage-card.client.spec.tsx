// @vitest-environment jsdom
/**
 * Token-usage plugin-configuration pricing card tests: the staged form over a
 * fake settings scope (seed, edit, clear, discard, save landing and failing,
 * scope-change republication) and the card component's rendering contract
 * (unavailable renders nothing, disclosure, read-only notice, unsaved badge,
 * save-button gating).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { CardState, CardStore, SectionValue } from '../src/client/card-form.ts'
import { CardForm } from '../src/client/card-form.ts'
import { TokenUsageCard, type TokenUsageCardProps } from '../src/client/TokenUsageCard.tsx'
import { zh } from '../src/client/locales.ts'

// The chevron icon is decoration; stubbing it keeps the katex css inside the
// primitives package out of the node test environment.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: (props: { className?: string }) => <span className={props.className} />,
}))

/** zh-bound translate stub over this plugin's dictionary. */
const t = ((key: string): string => (zh as Record<string, string>)[key] ?? key) as TranslateNS<'token-usage'>

/**
 * Minimal fake of the bound settings scope: a replaceable snapshot plus the
 * set/unset writes the form performs, recorded for assertions.
 */
class FakeScope {
  private listeners = new Set<() => void>()
  public readonly set = vi.fn(async (field: string, value: unknown) => {
    // The Host resolves the stored user layer into the section: mirror that
    // so the form's read-back judges acceptance the way it does over the wire.
    this.update((draft) => {
      draft.user = { ...draft.user, [field]: value }
      draft.value = { ...draft.value, [field]: value }
    })
  })
  public readonly unset = vi.fn(async (field: string) => {
    this.update((draft) => {
      if (draft.user === undefined) return
      const { [field]: _removed, ...rest } = draft.user
      draft.user = Object.keys(rest).length > 0 ? rest : undefined
      // Cleared back to the composition layer, which carries nothing here.
      const { [field]: _cleared, ...restValue } = draft.value ?? {}
      draft.value = Object.keys(restValue).length > 0 ? restValue : {}
    })
  })
  constructor(private snapshot: SettingsScopeSnapshot<SectionValue>) {}
  getSnapshot(): SettingsScopeSnapshot<SectionValue> {
    return this.snapshot
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** Test seam: replace the whole snapshot as a Host read would. */
  publish(snapshot: SettingsScopeSnapshot<SectionValue>): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  private update(mutate: (draft: SettingsScopeSnapshot<SectionValue>) => void): void {
    const next = { ...this.snapshot, user: this.snapshot.user === undefined ? undefined : { ...this.snapshot.user } }
    mutate(next)
    this.publish(next)
  }
}

/** A ready snapshot with the given resolved/user layers. */
function ready(layers: { value?: SectionValue; user?: SectionValue }): SettingsScopeSnapshot<SectionValue> {
  return {
    status: 'ready',
    writable: true,
    value: layers.value ?? {},
    base: {},
    user: layers.user,
    revision: 1,
    mode: 'host',
  }
}

/** The form plus a synchronous snapshot reader over its bound store. */
function formOf(scope: FakeScope): { form: CardForm; read(): CardState } {
  const form = new CardForm(scope as unknown as SettingsScope<SectionValue>)
  const store = form.bind()
  return { form, read: () => store.getSnapshot() }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CardForm', () => {
  it('seeds from the resolved value and reports no override without a user entry', () => {
    const { read } = formOf(new FakeScope(ready({ value: { pricingRegion: 'overseas' } })))
    expect(read()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      fields: { pricingRegion: 'overseas' },
      overridden: { pricingRegion: false },
    })
  })

  it('marks a field overridden from user-layer key presence, not value equality', () => {
    const { read } = formOf(new FakeScope(ready({ value: { pricingRegion: 'overseas' }, user: { pricingRegion: 'overseas' } })))
    expect(read().overridden.pricingRegion).toBe(true)
  })

  it('stages an edit as dirty and previews the override badge', () => {
    const { form, read } = formOf(new FakeScope(ready({})))
    form.actions().editField('pricingRegion', 'overseas')
    expect(read()).toMatchObject({ dirty: true, fields: { pricingRegion: 'overseas' } })
    expect(read().overridden.pricingRegion).toBe(true)
  })

  it('saves a non-empty draft by setting the field and clears the draft on landing', async () => {
    const scope = new FakeScope(ready({}))
    const { form, read } = formOf(scope)
    form.actions().editField('pricingRegion', 'overseas')
    form.actions().save()
    await vi.waitFor(() => {
      expect(scope.set).toHaveBeenCalledWith('pricingRegion', 'overseas')
      expect(read()).toMatchObject({
        dirty: false,
        failed: false,
        fields: { pricingRegion: 'overseas' },
        overridden: { pricingRegion: true },
      })
    })
  })

  it('saves an empty draft by unsetting the field', async () => {
    const scope = new FakeScope(ready({ value: { pricingRegion: 'overseas' }, user: { pricingRegion: 'overseas' } }))
    const { form } = formOf(scope)
    form.actions().clearField('pricingRegion')
    form.actions().save()
    await vi.waitFor(() => { expect(scope.unset).toHaveBeenCalledWith('pricingRegion') })
  })

  it('keeps the draft and flags failure when the write does not land', async () => {
    const scope = new FakeScope(ready({}))
    // The write refuses: the user layer never gains the field.
    scope.set.mockImplementation(async () => {})
    const { form, read } = formOf(scope)
    form.actions().editField('pricingRegion', 'overseas')
    form.actions().save()
    await vi.waitFor(() => {
      expect(read()).toMatchObject({ failed: true, dirty: true, fields: { pricingRegion: 'overseas' } })
    })
  })

  it('discards a staged edit back to the effective value', () => {
    const { form, read } = formOf(new FakeScope(ready({ value: { pricingRegion: 'domestic' } })))
    form.actions().editField('pricingRegion', 'overseas')
    form.actions().discard()
    expect(read()).toMatchObject({ dirty: false, fields: { pricingRegion: 'domestic' } })
  })

  it('republishes when the scope changes underneath', () => {
    const scope = new FakeScope(ready({}))
    const { read } = formOf(scope)
    scope.publish(ready({ value: { pricingRegion: 'overseas' } }))
    expect(read().fields.pricingRegion).toBe('overseas')
  })
})

describe('TokenUsageCard', () => {
  /** Props stub: locale copy plus the form face over a fake scope. */
  function propsOf(scope: FakeScope): TokenUsageCardProps {
    const form = new CardForm(scope as unknown as SettingsScope<SectionValue>)
    const store = form.bind()
    const actions = form.actions()
    // Test stub of the renderer-bound selector seat: subscribes the component
    // to the store so a form action re-renders, as useSyncExternalStore would.
    function useSnapshot(select: (state: CardState) => CardState): CardState {
      const [state, setState] = useState(store.getSnapshot())
      useEffect(() => store.subscribe(() => { setState(store.getSnapshot()) }), [])
      return select(state)
    }
    return {
      t,
      useTokenUsageCard: useSnapshot,
      editField: actions.editField,
      clearField: actions.clearField,
      save: actions.save,
      discard: actions.discard,
    } as unknown as TokenUsageCardProps
  }

  it('renders nothing while the namespace is unavailable', () => {
    const scope = new FakeScope({ status: 'unavailable', writable: false, value: undefined, base: undefined, user: undefined, revision: undefined, mode: 'host' })
    const { container } = render(<TokenUsageCard {...propsOf(scope)} />)
    expect(container.firstElementChild).toBeNull()
  })

  it('shows the title over a description line in the header', () => {
    const scope = new FakeScope(ready({}))
    render(<TokenUsageCard {...propsOf(scope)} />)
    const header = screen.getByRole('button', { name: '展开: Token 用量' })
    // The description rides under the title inside the header, like the
    // built-in plugin cards ("DeepSeek 搜索提供方" style).
    expect(within(header).getByText('Token 用量')).not.toBeNull()
    expect(within(header).getByText('设置定价数据源')).not.toBeNull()
  })

  it('discloses the region control on header click', () => {
    const scope = new FakeScope(ready({ value: { pricingRegion: 'overseas' } }))
    render(<TokenUsageCard {...propsOf(scope)} />)
    expect(screen.queryByLabelText('定价区域')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开: Token 用量' }))
    expect((screen.getByLabelText('定价区域') as HTMLSelectElement).value).toBe('overseas')
  })

  it('carries the unsaved badge on the header once edited', () => {
    const scope = new FakeScope(ready({}))
    render(<TokenUsageCard {...propsOf(scope)} />)
    fireEvent.click(screen.getByRole('button', { name: '展开: Token 用量' }))
    expect(screen.queryByText('未保存')).toBeNull()
    fireEvent.change(screen.getByLabelText('定价区域'), { target: { value: 'overseas' } })
    expect(screen.getByText('未保存')).not.toBeNull()
  })

  it('disables the control and shows the notice when the document is read-only', () => {
    const scope = new FakeScope({ ...ready({}), writable: false })
    render(<TokenUsageCard {...propsOf(scope)} />)
    fireEvent.click(screen.getByRole('button', { name: '展开: Token 用量' }))
    expect((screen.getByLabelText('定价区域') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText('设置文档当前为只读，本次无法修改。')).not.toBeNull()
  })

  it('gates the save button on dirtiness', () => {
    const scope = new FakeScope(ready({}))
    render(<TokenUsageCard {...propsOf(scope)} />)
    fireEvent.click(screen.getByRole('button', { name: '展开: Token 用量' }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('定价区域'), { target: { value: 'overseas' } })
    expect(save.disabled).toBe(false)
  })
})
