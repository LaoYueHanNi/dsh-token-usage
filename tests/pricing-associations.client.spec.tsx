// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelAssociationBadge, PricingAssociationDialog, PricingAssociationManagerButton, PricingAssociationProvider, UnpricedModelTag } from '../src/client/PricingAssociations.tsx'
import { pricingAssociationsChanged, pricingTableChanged, pricingIssueUrl, usePricingAssociationRefresh } from '../src/client/pricing-associations.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ModelResolution, PricingAssociationStatus, PricingAssociationsPayload, PricingOverviewPayload } from '../src/wire.ts'
import { ASSOCIATIONS_PATH, PRICING_PATH } from '../src/wire.ts'

// The host package imports CSS unavailable to Node. Keep hover/focus behavior
// in the stand-in; positioning and timing remain the host Tooltip's job.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { cloneElement, useState } = await import('react')
  return { Tooltip: ({ label, children }: { label: string; children: React.ReactElement }) => {
    const [visible, setVisible] = useState(false)
    return <>{cloneElement(children, {
      onMouseEnter: () => setVisible(true), onMouseLeave: () => setVisible(false),
      onFocus: () => setVisible(true), onBlur: () => setVisible(false),
    })}{visible && <span role="tooltip">{label}</span>}</>
  } }
})

const t = ((key: string, params?: Record<string, unknown>) => ((zh as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))) as TranslateNS<'token-usage'>
const name = 'provider/internal'
const unresolved = (rawName = name): ModelResolution => ({ rawName, status: 'unmatched', strippedPrefix: false, candidates: [] })
const active = (sourceModel = name, targetModelId = 'm'): PricingAssociationStatus => ({ sourceModel, targetModelId, resolvedTargetModelId: targetModelId, state: 'active' })
const overview: PricingOverviewPayload = { currency: 'CNY', usdExchangeRate: 7, costState: 'ready', feedVersion: 110, models: [
  { modelId: 'm', aliasPatterns: ['^internal$', '^old-m$'], family: 'alpha', rules: { base: { inputPerMillion: 1, outputPerMillion: 2 },
    contextTiers: [{ threshold: 500000, rates: { inputPerMillion: 3, outputPerMillion: 4 } }],
    timeRules: [{ startTime: 0, endTime: 100, rates: { inputPerMillion: 5, outputPerMillion: 6 } }],
    dailySlots: [{ windows: [{ startMinute: 60, endMinute: 120 }], daysOfWeek: [1], rates: { inputPerMillion: 7, outputPerMillion: 8 } }] } },
  { modelId: 'b', aliasPatterns: [], family: 'beta', rules: { base: { inputPerMillion: 0, outputPerMillion: 0 }, contextTiers: [], dailySlots: [], timeRules: [] } },
] }
const empty = (): PricingAssociationsPayload => ({ revision: 0, directoryToken: 'directory-A', storageState: 'ready', pricingAvailable: true, writesPaused: false, associations: [], feedVersion: 110 })

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mockApi(initial = empty(), pricing = overview, write?: (body: any, method: string) => Promise<Response>) {
  let current = initial
  const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === PRICING_PATH) return Response.json(pricing)
    expect(url.pathname).toBe(ASSOCIATIONS_PATH)
    if (options?.method === 'POST' || options?.method === 'DELETE') {
      const body = JSON.parse(String(options.body))
      if (write !== undefined) return write(body, options.method)
      current = { ...current, revision: current.revision! + 1, associations: options.method === 'DELETE' ? current.associations.filter(row => row.sourceModel !== body.sourceModel)
        : [active(body.sourceModel, body.targetModelId)], resolution: options.method === 'DELETE' ? unresolved(body.sourceModel)
          : { ...unresolved(body.sourceModel), status: 'matched', method: 'manual', modelId: body.targetModelId, association: active(body.sourceModel, body.targetModelId), automatic: unresolved(body.sourceModel) } }
      return Response.json(current)
    }
    const source = url.searchParams.get('sourceModel')
    return Response.json({ ...current, ...(source !== null ? { resolution: current.resolution?.rawName === source ? current.resolution : unresolved(source) } : {}) })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function ready(initial = empty(), source: string | null = name, pricing = overview, write?: (body: any, method: string) => Promise<Response>) {
  const fetch = mockApi(initial, pricing, write), close = vi.fn()
  render(<PricingAssociationDialog initialSource={source} view={{ symbol: '￥', rate: 1 }} t={t} onClose={close} />)
  if (source === null) await screen.findByText(t('association.allHint'))
  else await screen.findByRole('searchbox')
  return { fetch, close, dialog: screen.getByRole('dialog', { name: t('association.title') }) }
}
async function select(model = 'm') {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: model } })
  const candidate = screen.getAllByRole('radio').find(input => input.closest('label')?.textContent?.startsWith(model))!
  fireEvent.click(candidate)
}
const writesOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(call => ['POST', 'DELETE'].includes(call[1]?.method))

describe('local association selection', () => {
  it('opens the unpriced choices without fetching, encodes the Issue draft and restores tag focus', () => {
    const fetch = mockApi()
    const resolution = { ...unresolved('p/Missing Model'), status: 'ambiguous' as const, candidates: ['one', 'two'] }
    render(<PricingAssociationProvider view={{ symbol: '￥', rate: 1 }} t={t} feedVersion={110} resolutions={[resolution]}>
      <UnpricedModelTag model="P/missing model" t={t} />
    </PricingAssociationProvider>)
    const tag = screen.getByRole('button', { name: '未定价' })
    tag.focus(); fireEvent.click(tag)
    const dialog = screen.getByRole('dialog', { name: t('association.unpricedTitle') })
    expect(within(dialog).getByText('p/Missing Model')).toBeTruthy()
    expect(within(dialog).getByText(/one, two/)).toBeTruthy()
    const link = within(dialog).getByRole('link', { name: '增加模型定价' }) as HTMLAnchorElement
    const url = new URL(link.href)
    expect(url.pathname).toBe('/LaoYueHanNi/model-price-table/issues/new')
    expect(url.searchParams.get('body')).toContain('3. Current pricing table version\n   - 110')
    expect(url.searchParams.get('title')).toBe('Add model pricing: p/Missing Model')
    expect(link.target).toBe('_blank')
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: t('association.close') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(tag)
  })

  it('fetches only after opening, uses full local candidates, and does not save a unique search hit', async () => {
    const fetch = mockApi()
    render(<PricingAssociationProvider view={{ symbol: '￥', rate: 1 }} t={t} resolutions={[unresolved()]}>
      <UnpricedModelTag model={name} t={t} />
    </PricingAssociationProvider>)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('pricing.unpriced') }))
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: t('association.unpricedTitle') })).toBeTruthy()
    expect(screen.getByRole('link', { name: t('association.issue') }).getAttribute('href')).toContain('model-price-table/issues/new')
    fireEvent.click(screen.getByRole('button', { name: t('association.choose') }))
    const search = await screen.findByRole('searchbox')
    expect((search as HTMLInputElement).value).toBe('')
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByText(t('association.noResults'))).toBeNull()
    expect(screen.queryByRole('button', { name: '查看全部关联' })).toBeNull()
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(search, { target: { value: 'BETA' } })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    fireEvent.change(search, { target: { value: 'OLD-M' } })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    fireEvent.change(search, { target: { value: ' M ' } })
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByText('m')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio'))
    fireEvent.change(search, { target: { value: '   ' } })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByText(t('association.noResults'))).toBeNull()
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(search, { target: { value: 'no-match' } })
    expect(screen.getByText(t('association.noResults'))).toBeTruthy()
    expect(within(screen.getByRole('dialog')).queryByRole('link', { name: t('association.issue') })).toBeNull()
    expect(writesOf(fetch)).toHaveLength(0)
    expect(fetch.mock.calls.every(call => String(call[0]).startsWith('/token-usage/'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('association.close') }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('searches only model IDs, including partial IDs, without matching families or hidden aliases', async () => {
    const pricing: PricingOverviewPayload = { ...overview, models: [
      { ...overview.models[0]!, modelId: 'Claude-Fable-5.1', family: 'anthropic', aliasPatterns: ['^claude-fable-5-1-thinking-medium$', '^claude-fable-5-1-thinking-max$'] },
      { ...overview.models[1]!, modelId: 'MiniMax-M3', family: 'minimax', aliasPatterns: ['^vendor-speed$'] },
    ] }
    await ready(empty(), name, pricing)
    const search = screen.getByRole('searchbox')
    expect(search.getAttribute('placeholder')).toBe(t('association.searchHint'))
    for (const query of ['anthropic', 'vendor-speed', 'claude-fable-5-1-thinking-medium', 'no-match']) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.queryAllByRole('radio')).toHaveLength(0)
      expect(screen.getByText(t('association.noResults'))).toBeTruthy()
    }
    for (const query of ['m', 'MiniMax', 'M3']) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getAllByRole('radio')).toHaveLength(1)
      expect(screen.getByText('MiniMax-M3')).toBeTruthy()
      expect(screen.queryByText('Claude-Fable-5.1')).toBeNull()
    }
    fireEvent.change(search, { target: { value: '  minimax-m3  ' } })
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByText('MiniMax-M3')).toBeTruthy()
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(search, { target: { value: 'CLAUDE-FABLE-5.1' } })
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByText('Claude-Fable-5.1')).toBeTruthy()
  })
  it('previews full time/tier/weekday rules and USD rates in a stacked dialog', async () => {
    mockApi(empty(), { ...overview, currency: 'USD' })
    render(<PricingAssociationDialog initialSource={name} view={{ symbol: '$', rate: 7 }} t={t} onClose={() => {}} />)
    await screen.findByRole('searchbox')
    await select()
    fireEvent.click(screen.getByRole('button', { name: t('association.preview') }))
    const inner = screen.getByRole('dialog', { name: t('pricing.title') })
    expect(inner.textContent).toContain('500K')
    expect(inner.textContent).toContain('01:00-02:00')
    expect(inner.textContent).toContain('$')
    fireEvent.click(within(inner).getByRole('button', { name: t('pricing.close') }))
    expect(screen.queryByRole('dialog', { name: t('pricing.title') })).toBeNull()
    expect(screen.getByRole('dialog', { name: t('association.title') })).toBeTruthy()
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('submits only an explicit canonical target and the revision/directory token', async () => {
    const { fetch, close } = await ready()
    await select('b')
    expect(screen.getByText(t('association.impact'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('association.save') }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    const call = writesOf(fetch)[0]!
    expect(JSON.parse(call[1].body)).toEqual({ sourceModel: name, targetModelId: 'b', revision: 0, directoryToken: 'directory-A' })
    expect(call[1].headers).toEqual({ 'content-type': 'application/json' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('shows ambiguity candidates and permits explicit resolution', async () => {
    await ready({ ...empty(), resolution: { ...unresolved(), status: 'ambiguous', candidates: ['m', 'b'], method: 'alias' } })
    expect(screen.getByText(t('pricing.ambiguous', { models: 'm, b' }))).toBeTruthy()
    await select('b')
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('shows a load error and retries in place', async () => {
    const fetch = mockApi()
    fetch.mockImplementationOnce(async () => new Response('{}', { status: 500 }))
    render(<PricingAssociationDialog initialSource={name} view={{ symbol: '￥', rate: 1 }} t={t} onClose={() => {}} />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await screen.findByRole('searchbox')
    expect(writesOf(fetch)).toHaveLength(0)
  })
  it('keeps saved choices revocable if candidate loading fails', async () => {
    const fetch = mockApi({ ...empty(), associations: [active()] })
    fetch.mockImplementation(async (input: RequestInfo | URL) => String(input) === PRICING_PATH
      ? new Response('{}', { status: 500 }) : Response.json({ ...empty(), associations: [active()], resolution: unresolved() }))
    render(<PricingAssociationDialog initialSource={name} view={{ symbol: '￥', rate: 1 }} t={t} onClose={() => {}} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe(t('association.candidatesUnavailable'))
    expect((screen.getByRole('button', { name: t('association.revoke') }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('rejects malformed read and write responses instead of showing success', async () => {
    const fetch = mockApi()
    fetch.mockImplementationOnce(async () => Response.json({ unrelated: true }))
    render(<PricingAssociationDialog initialSource={name} view={{ symbol: '￥', rate: 1 }} t={t} onClose={() => {}} />)
    await screen.findByRole('alert')
    cleanup()
    await ready(empty(), name, overview, async () => Response.json({ unrelated: true }))
    await select()
    fireEvent.click(screen.getByRole('button', { name: t('association.save') }))
    await screen.findByRole('alert')
    expect(screen.queryByText(t('association.saved'))).toBeNull()
  })
  it('keeps selection and search after a failed write without publishing success', async () => {
    const { fetch } = await ready(empty(), name, overview, async () => new Response('{}', { status: 500 }))
    await select()
    fireEvent.click(screen.getByRole('button', { name: t('association.save') }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain(t('association.writeFailed'))
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('m')
    expect(screen.queryByText(t('association.saved'))).toBeNull()
    expect(writesOf(fetch)).toHaveLength(1)
  })
  it('revision conflict refreshes current state and requires another explicit submission', async () => {
    let attempts = 0
    const latest = { ...empty(), revision: 4, resolution: unresolved() }
    const { fetch, close } = await ready(empty(), name, overview, async body => {
      attempts++
      if (attempts === 1) return Response.json({ error: 'revision-conflict', current: latest }, { status: 409 })
      expect(body.revision).toBe(4)
      return Response.json({ ...latest, revision: 5, associations: [active()], resolution: {
        ...unresolved(), status: 'matched', method: 'manual', modelId: 'm', association: active(), automatic: unresolved(),
      } })
    })
    await select()
    fireEvent.click(screen.getByRole('button', { name: t('association.save') }))
    await screen.findByRole('alert')
    expect(writesOf(fetch)).toHaveLength(1)
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('association.save') }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(writesOf(fetch)).toHaveLength(2)
  })
  it('directory conflict discards the old target', async () => {
    await ready(empty(), name, overview, async () => Response.json({ error: 'directory-conflict', current: { ...empty(), directoryToken: 'directory-B' } }, { status: 409 }))
    await select()
    fireEvent.click(screen.getByRole('button', { name: t('association.save') }))
    await screen.findByRole('alert')
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('prevents duplicate commits and cancellation while writing', async () => {
    let finish!: (value: Response) => void
    const { fetch, close, dialog } = await ready(empty(), name, overview, () => new Promise(resolve => { finish = resolve }))
    await select()
    const button = screen.getByRole('button', { name: t('association.save') })
    fireEvent.click(button); fireEvent.click(button)
    expect(writesOf(fetch)).toHaveLength(1)
    expect((screen.getByRole('button', { name: t('association.close') }) as HTMLButtonElement).disabled).toBe(true)
    const cancel = new Event('cancel', { bubbles: false, cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    fireEvent.mouseDown(dialog); fireEvent.click(dialog)
    expect(close).not.toHaveBeenCalled()
    await act(async () => { finish(Response.json({ ...empty(), revision: 1, associations: [active()] })) })
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })
  it('native close restores the opener; a text-selection drag does not close', async () => {
    mockApi()
    render(<PricingAssociationProvider view={{ symbol: '￥', rate: 1 }} t={t}><PricingAssociationManagerButton t={t} /></PricingAssociationProvider>)
    const opener = screen.getByRole('button', { name: t('association.manage') })
    opener.focus(); fireEvent.click(opener)
    await screen.findByText(t('association.allHint'))
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(screen.getByText(t('association.allHint'))); fireEvent.click(dialog)
    expect(dialog).toBeTruthy()
    fireEvent.mouseDown(dialog); fireEvent.click(dialog)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
  it('uses native keyboard selection and shields an ancestor popup from Escape', async () => {
    const escape = vi.fn()
    mockApi()
    render(<div onKeyDown={escape}><PricingAssociationDialog initialSource={name} view={{ symbol: '￥', rate: 1 }} t={t} onClose={() => {}} /></div>)
    await screen.findByRole('searchbox')
    await select()
    const input = screen.getByRole('radio')
    input.focus()
    fireEvent.click(input)
    expect((input as HTMLInputElement).checked).toBe(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(escape).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('saved association management', () => {
  it('lists unused, invalid and taken-over entries independently of usage, and confirms revoke', async () => {
    const entries: PricingAssociationStatus[] = [active('unused'), { sourceModel: 'gone', targetModelId: 'removed', state: 'target-missing' },
      { sourceModel: 'auto', targetModelId: 'b', state: 'automatic-takeover', automaticModelId: 'm', targetDiffers: true }]
    const { fetch } = await ready({ ...empty(), revision: 2, associations: entries }, null)
    for (const text of ['unused → m', 'gone → removed', 'auto → b']) {
      const row = screen.getByText(text).closest('section')!
      expect(within(row).getAllByRole('button')).toHaveLength(1)
      expect(within(row).getByRole('button', { name: t('association.revoke') })).toBeTruthy()
    }
    for (const key of ['association.state.active', 'association.state.automatic-takeover', 'association.state.target-missing'] as const) {
      expect(screen.queryByText(t(key))).toBeNull()
    }
    expect(screen.queryByText(t('association.reactivate'))).toBeNull()
    expect(screen.queryByRole('button', { name: t('association.details') })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: t('association.revoke') })[1]!)
    expect(writesOf(fetch)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: t('association.cancel') }))
    expect(screen.queryByRole('button', { name: t('association.confirmRevoke') })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: t('association.revoke') })[1]!)
    fireEvent.click(screen.getByRole('button', { name: t('association.confirmRevoke') }))
    await screen.findByText(t('association.revoked'))
    expect(JSON.parse(writesOf(fetch)[0]![1].body)).toEqual({ sourceModel: 'gone', revision: 2, directoryToken: 'directory-A' })
    expect(screen.queryByText('gone → removed')).toBeNull()
  })
  it('automatic takeover shows both targets and allows revoke but no editing override', async () => {
    const choice: PricingAssociationStatus = { sourceModel: name, targetModelId: 'b', state: 'automatic-takeover', automaticModelId: 'm', targetDiffers: true }
    mockApi({ ...empty(), associations: [choice], resolution: { ...unresolved(), status: 'matched', method: 'pattern', modelId: 'm', association: choice } })
    render(<PricingAssociationDialog initialSource={name} view={{ symbol: '￥', rate: 1 }} t={t} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain(t('association.reactivate')))
    expect(screen.getByText(/与保存的目标 b 不同/)).toBeTruthy()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('button', { name: t('association.save') })).toBeNull()
    expect((screen.getByRole('button', { name: t('association.revoke') }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('invalid targets remain visible and can be changed to a real model', async () => {
    const choice: PricingAssociationStatus = { sourceModel: name, targetModelId: 'removed', state: 'target-missing' }
    await ready({ ...empty(), associations: [choice] })
    expect(screen.getByText(`${name} → removed`)).toBeTruthy()
    expect(screen.getByText(t('association.state.target-missing'))).toBeTruthy()
    await select('b')
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('revocation stays possible without valid pricing, while storage corruption blocks writes', async () => {
    await ready({ ...empty(), pricingAvailable: false, associations: [{ ...active(), state: 'pricing-unavailable' }] }, name, { ...overview, costState: 'pricing-unavailable', models: [] })
    expect((screen.getByRole('button', { name: t('association.revoke') }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    await ready({ ...empty(), storageState: 'unavailable', storageError: 'invalid-file', revision: null })
    expect(screen.getByRole('alert').textContent).toBe(t('pricing.associationStorageUnavailable'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'm' } })
    expect((screen.getByRole('radio') as HTMLInputElement).disabled).toBe(true)
  })
  it('migration disables saving and revocation', async () => {
    await ready({ ...empty(), writesPaused: true, associations: [active()] })
    await select()
    expect(screen.getByText(t('association.migrating'))).toBeTruthy()
    expect((screen.getByRole('button', { name: t('association.save') }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: t('association.revoke') }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('folded rows retain every original source, including dormant associations', () => {
    const resolutions: ModelResolution[] = [
      { ...unresolved('direct'), status: 'matched', modelId: 'm', method: 'alias' },
      ...['p/one', 'q/two'].map(rawName => ({ ...unresolved(rawName), status: 'matched' as const, modelId: 'm', method: 'manual' as const, association: active(rawName) })),
      { ...unresolved('p/auto'), status: 'matched', modelId: 'm', association: { sourceModel: 'p/auto', targetModelId: 'b', state: 'automatic-takeover', automaticModelId: 'm', targetDiffers: true } },
    ]
    render(<PricingAssociationProvider resolutions={resolutions} view={{ symbol: '￥', rate: 1 }} t={t}><ModelAssociationBadge model="M" t={t} /></PricingAssociationProvider>)
    const label = t('association.tooltip', { models: 'p/one, q/two, p/auto' })
    const icon = screen.getByRole('img', { name: label })
    expect(icon.hasAttribute('title')).toBe(false)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(icon)
    expect(screen.getByRole('tooltip').textContent).toBe(label)
    fireEvent.mouseLeave(icon)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(icon)
    expect(screen.getByRole('tooltip').textContent).toBe(label)
    fireEvent.blur(icon)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(icon.closest('details')).toBeNull()
    expect(screen.queryByText('含手动关联')).toBeNull()
    expect(screen.queryByRole('button', { name: t('association.details') })).toBeNull()
  })
  it('does not mark rows that have no manual associations', () => {
    render(<PricingAssociationProvider resolutions={[{ ...unresolved('direct'), status: 'matched', modelId: 'm' }]} view={{ symbol: '￥', rate: 1 }} t={t}>
      <ModelAssociationBadge model="m" t={t} />
    </PricingAssociationProvider>)
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('keeps management to mappings and revocation without an editor entry', async () => {
    await ready({ ...empty(), associations: [active()] }, null)
    expect(screen.getByText(`${name} → m`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('association.details') })).toBeNull()
    expect(screen.queryByText(t('association.state.active'))).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '查看全部关联' })).toBeNull()
  })
})

describe('refresh and upstream drafts', () => {
  it('refreshes every mounted consumer and removes listeners on unmount', () => {
    const first = vi.fn(), second = vi.fn()
    function Consumer({ refresh }: { refresh: () => void }) { usePricingAssociationRefresh(refresh); return null }
    const one = render(<Consumer refresh={first} />), two = render(<Consumer refresh={second} />)
    act(() => pricingAssociationsChanged())
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1)
    one.unmount(); act(() => pricingAssociationsChanged())
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2)
    act(() => pricingTableChanged())
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(3)
    two.unmount()
    act(() => pricingTableChanged())
    expect(second).toHaveBeenCalledTimes(3)
  })
  it('encodes the model ID in the title and includes only the three requested pricing sections', () => {
    const rawName = 'provider/<img src=x onerror=alert(1)>&?"#'
    const resolution: ModelResolution = { ...unresolved(rawName), status: 'matched', method: 'manual', modelId: 'm', automatic: { ...unresolved(rawName), status: 'ambiguous', candidates: ['m', 'b'] } }
    const url = new URL(pricingIssueUrl(resolution, 110))
    expect(url.origin + url.pathname).toBe('https://github.com/LaoYueHanNi/model-price-table/issues/new')
    expect(url.searchParams.get('title')).toBe('Add model pricing: ' + rawName)
    expect(url.searchParams.get('body')).toBe([
      '1. Pricing reference (optional)',
      '   - Currency:',
      '   - Input price per 1 million tokens:',
      '   - Output price per 1 million tokens:',
      '   - Cache read price per 1 million tokens:',
      '   - Cache write price per 1 million tokens:',
      '   - Context window (tokens):',
      '',
      '2. Official pricing URL (optional)',
      '   - URL:',
      '',
      '3. Current pricing table version',
      '   - 110',
    ].join('\n'))
    expect([...url.searchParams.keys()]).toEqual(['title', 'body'])
    expect(pricingIssueUrl(unresolved('/bad/'), undefined)).toContain('Unknown')
  })
  it('renders safe external draft links without submitting or injecting model names', async () => {
    const rawName = 'p/<script>alert(1)</script>&test'
    const fetch = mockApi()
    render(<PricingAssociationProvider resolutions={[unresolved(rawName)]} view={{ symbol: '￥', rate: 1 }} t={t}>
      <UnpricedModelTag model={rawName} t={t} />
    </PricingAssociationProvider>)
    fireEvent.click(screen.getByRole('button', { name: '未定价' }))
    const link = screen.getByRole('link', { name: t('association.issue') }) as HTMLAnchorElement
    expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer')
    expect(screen.getByRole('dialog').querySelector('script')).toBeNull()
    expect(screen.getByText(rawName)).toBeTruthy()
    expect(new URL(link.href).searchParams.get('title')).toBe('Add model pricing: ' + rawName)
    expect(writesOf(fetch)).toHaveLength(0)
  })
  it('supplies identical Chinese and English association keys', () => {
    for (const key of Object.keys(zh).filter(key => key.startsWith('association.'))) expect((en as Record<string, string>)[key]).toBeTruthy()
  })
})
