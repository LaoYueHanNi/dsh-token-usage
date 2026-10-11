import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ASSOCIATIONS_PATH, PRICING_PATH } from '../wire.ts'
import type { ModelResolution, PricingAssociationStatus, PricingAssociationsPayload, PricingOverviewModel, PricingOverviewPayload } from '../wire.ts'
import { modelKey } from '../model-resolution.ts'
import { useAsyncResource } from './async-resource.ts'
import type { CurrencyView } from './format.ts'
import { currencyViewOf } from './format.ts'
import { PricingDialog } from './PricingDialog.tsx'
import { AssociationRequestError, pricingAssociationsChanged, pricingIssueUrl } from './pricing-associations.ts'
import shared from './PricingDialog.module.css'
import styles from './PricingAssociations.module.css'

interface AssociationUi { open(source?: string): void; showUnpriced(resolution: ModelResolution): void; resolutions: readonly ModelResolution[]; feedVersion?: number }
const AssociationUiContext = createContext<AssociationUi | null>(null)

export function PricingAssociationProvider({ resolutions = [], feedVersion, view, t, children }: {
  resolutions?: readonly ModelResolution[] | undefined; feedVersion?: number | undefined
  view: CurrencyView; t: TranslateNS<'token-usage'>; children: ReactNode
}): ReactNode {
  const [source, setSource] = useState<string | null | undefined>(undefined)
  const [unpriced, setUnpriced] = useState<ModelResolution | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const rememberOpener = (): void => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }
  return <AssociationUiContext.Provider value={{ open: name => { rememberOpener(); setSource(name ?? null) },
    showUnpriced: resolution => { rememberOpener(); setUnpriced(resolution) }, resolutions,
    ...(feedVersion !== undefined ? { feedVersion } : {}) }}>
    {children}
    {unpriced !== null && <UnpricedModelDialog resolution={unpriced} version={feedVersion} t={t}
      onClose={() => setUnpriced(null)} onAssociate={() => { setUnpriced(null); setSource(unpriced.rawName) }} />}
    {source !== undefined && <PricingAssociationDialog initialSource={source} returnFocus={opener.current} view={view} t={t} onClose={() => setSource(undefined)} />}
  </AssociationUiContext.Provider>
}

/** Entry remains available even when the usage filter has no rows. */
export function PricingAssociationManagerButton({ t, onOpen }: { t: TranslateNS<'token-usage'>; onOpen?: () => void }): ReactNode {
  const ui = useContext(AssociationUiContext)
  const open = onOpen ?? (ui === null ? undefined : () => ui.open())
  return open === undefined ? null : <button type="button" data-pricing-association-manager className={styles.button} onClick={open}>{t('association.manage')}</button>
}

export function PricingIssueLink({ resolution, version, t }: { resolution: ModelResolution; version?: number | undefined; t: TranslateNS<'token-usage'> }): ReactNode {
  return <a className={styles.link} href={pricingIssueUrl(resolution, version)} target="_blank" rel="noopener noreferrer">{t('association.issue')}</a>
}

export function UnpricedModelTag({ model, t }: { model: string; t: TranslateNS<'token-usage'> }): ReactNode {
  const ui = useContext(AssociationUiContext)
  const resolution = ui?.resolutions.find(row => modelKey(row.rawName) === modelKey(model))
    ?? { rawName: model, status: 'unmatched' as const, strippedPrefix: false, candidates: [] }
  return <button type="button" className={styles.unpricedTag} aria-haspopup="dialog"
    disabled={ui === null || model === ''} onClick={() => ui?.showUnpriced(resolution)}>{t('pricing.unpriced')}</button>
}

function UnpricedModelDialog({ resolution, version, t, onClose, onAssociate }: {
  resolution: ModelResolution; version?: number | undefined; t: TranslateNS<'token-usage'>
  onClose: () => void; onAssociate: () => void
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const backdropPress = useRef(false)
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    dialogRef.current?.showModal()
    return () => { if (opener.current?.isConnected) opener.current.focus() }
  }, [])
  const automatic = resolution.automatic ?? resolution
  return <dialog ref={dialogRef} className={`${shared.dialog} ${styles.unpricedDialog}`} aria-label={t('association.unpricedTitle')}
    onClose={event => { if (event.target === dialogRef.current) onClose() }}
    onMouseDown={event => { backdropPress.current = event.target === dialogRef.current }}
    onClick={event => { if (event.target === dialogRef.current && backdropPress.current) dialogRef.current?.close() }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <div className={shared.dialogHead}>
      <h2 className={shared.dialogTitle}>{t('association.unpricedTitle')}</h2>
      <button type="button" className={shared.dialogClose} aria-label={t('association.close')} onClick={() => dialogRef.current?.close()}>✕</button>
    </div>
    <p className={styles.name}>{resolution.rawName}</p>
    {automatic.status === 'ambiguous' && <p className={styles.note}>{t('pricing.ambiguous', { models: automatic.candidates.join(', ') })}</p>}
    <div className={styles.actions}>
      <button type="button" className={styles.button} onClick={onAssociate}>{t('association.choose')}</button>
      <PricingIssueLink resolution={resolution} version={version} t={t} />
    </div>
  </dialog>
}

/** Show original associated IDs on hover without expanding the statistics row. */
export function ModelAssociationBadge({ model, t }: { model: string; t: TranslateNS<'token-usage'> }): ReactNode {
  const ui = useContext(AssociationUiContext)
  if (ui === null || model === '') return null
  const names = ui.resolutions.filter(row => modelKey(row.modelId ?? row.rawName) === modelKey(model))
  const associated = names.filter(row => row.association !== undefined)
  if (associated.length === 0) return null
  const label = t('association.tooltip', { models: associated.map(row => row.rawName).join(', ') })
  return <span className={styles.badgeWrap}><Tooltip label={label} side="top" delayMs={100}>
    <span className={styles.badge} role="img" aria-label={label} tabIndex={0}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" />
      <path d="M6.5 6a1.5 1.5 0 0 1 3 0c0 1-1.5 1-1.5 2.5" stroke="currentColor" strokeLinecap="round" />
      <circle cx="8" cy="10.5" r=".7" fill="currentColor" />
    </svg>
    </span>
  </Tooltip></span>
}

function AssociationStatus({ row, t }: { row: PricingAssociationStatus; t: TranslateNS<'token-usage'> }): ReactNode {
  return <p className={styles.note}>
    {t(`association.state.${row.state}`)}
    {row.state === 'automatic-takeover' && <>{' '}{t('association.automaticTarget', { model: row.automaticModelId ?? '' })}
      {row.targetDiffers && <>{' '}{t('association.targetDiffers', { model: row.targetModelId })}</>}
      {' '}{t('association.reactivate')}</>}
  </p>
}

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function checkAssociations(value: PricingAssociationsPayload): PricingAssociationsPayload {
  if (value === null || typeof value !== 'object' || typeof value.directoryToken !== 'string'
    || !['ready', 'unavailable'].includes(value.storageState) || !Array.isArray(value.associations)
    || typeof value.pricingAvailable !== 'boolean' || typeof value.writesPaused !== 'boolean'
    || (value.storageState === 'ready' && (!Number.isSafeInteger(value.revision) || value.revision! < 0))
    || value.associations.some(row => row === null || typeof row.sourceModel !== 'string' || typeof row.targetModelId !== 'string')) {
    throw new Error('unexpected association response')
  }
  return value
}

function checkPricing(value: PricingOverviewPayload): PricingOverviewPayload {
  if (value === null || typeof value !== 'object' || !Array.isArray(value.models)
    || value.models.some(row => row === null || typeof row.modelId !== 'string' || !Array.isArray(row.aliases) || row.rules?.base === undefined)) {
    throw new Error('unexpected pricing response')
  }
  return value
}

function requestMessage(error: unknown, t: TranslateNS<'token-usage'>): string {
  if (!(error instanceof AssociationRequestError)) return t('association.writeFailed')
  switch (error.code) {
    case 'revision-conflict': case 'directory-conflict': return t('association.conflict')
    case 'migration-in-progress': return t('association.migrating')
    case 'source-automatically-priced': return t('association.automaticOnly')
    case 'target-unavailable': return t('association.targetUnavailable')
    case 'pricing-unavailable': return t('pricing.unavailable')
    case 'association-storage-unavailable': return t('pricing.associationStorageUnavailable')
    default: return t('association.writeFailed')
  }
}

export function PricingAssociationDialog({ initialSource, view, t, onClose, returnFocus }: {
  initialSource: string | null; view: CurrencyView; t: TranslateNS<'token-usage'>; onClose: () => void
  returnFocus?: HTMLElement | null
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const searchId = useId()
  const backdropPress = useRef(false)
  const mounted = useRef(true)
  const writing = useRef(false)
  const opener = useRef<HTMLElement | null>(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const source = initialSource
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [detail, setDetail] = useState<PricingOverviewModel | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [override, setOverride] = useState<PricingAssociationsPayload | null>(null)
  const [state, retry] = useAsyncResource<{ associations: PricingAssociationsPayload; pricing: PricingOverviewPayload | null; source: string | null }>(async signal => {
    const [associations, pricing] = await Promise.all([
      readJson<PricingAssociationsPayload>(ASSOCIATIONS_PATH + (source !== null ? `?sourceModel=${encodeURIComponent(source)}` : ''), signal).then(checkAssociations),
      readJson<PricingOverviewPayload>(PRICING_PATH, signal).then(checkPricing).catch(() => null),
    ])
    return { associations, pricing, source }
  }, [source], { retryToken: 0 })

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    const parent = dialog?.parentElement
    mounted.current = true
    return () => {
      mounted.current = false
      if (opener.current?.isConnected) opener.current.focus()
      else (parent?.querySelector<HTMLButtonElement>('[data-pricing-association-manager]')
        ?? parent?.querySelector<HTMLButtonElement>('[data-pricing-overview-trigger]')
        ?? parent?.querySelector<HTMLButtonElement>('button'))?.focus()
    }
  }, [])

  const ready = state.status === 'ready' && state.value.source === source
  const snapshot = override ?? (ready ? state.value.associations : null)
  const models = ready ? state.value.pricing?.models ?? [] : []
  const candidateView = ready && state.value.pricing !== null ? currencyViewOf(state.value.pricing) : view
  const selected = models.find(model => modelKey(model.modelId) === modelKey(target ?? ''))
  const currentChoice = snapshot?.associations.find(row => modelKey(row.sourceModel) === modelKey(source ?? ''))
  const savedTarget = models.find(model => modelKey(model.modelId) === modelKey(currentChoice?.targetModelId ?? ''))
  const automatic = snapshot?.resolution?.automatic ?? snapshot?.resolution
  const writable = ready && snapshot?.storageState === 'ready' && !snapshot.writesPaused && !pending
  const canSave = writable && snapshot?.pricingAvailable && ready && state.value.pricing !== null && state.value.pricing.costState !== 'pricing-unavailable'
    && automatic !== undefined && automatic.status !== 'matched' && selected !== undefined && source !== null
  const searchModelId = modelKey(query.trim())
  const candidates = searchModelId === '' ? [] : models.filter(model => modelKey(model.modelId).includes(searchModelId))

  const reload = (): void => { setOverride(null); setError(null); retry() }

  const mutate = async (operation: 'save' | 'delete', name: string): Promise<void> => {
    if (writing.current || snapshot === null || snapshot.revision === null) return
    writing.current = true; setPending(true); setError(null); setNotice(null)
    try {
      const response = await fetch(ASSOCIATIONS_PATH, { method: operation === 'save' ? 'POST' : 'DELETE', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceModel: name,
          ...(operation === 'save' ? { targetModelId: selected?.modelId } : {}), revision: snapshot.revision, directoryToken: snapshot.directoryToken }) })
      const result = await response.json() as PricingAssociationsPayload & { error?: string; current?: PricingAssociationsPayload }
      if (!response.ok) throw new AssociationRequestError(result.error ?? 'write-failed', result.current)
      checkAssociations(result)
      pricingAssociationsChanged()
      if (!mounted.current) return
      if (operation === 'save') { dialogRef.current?.close(); return }
      setOverride(result); setConfirmRevoke(null); setNotice(t('association.revoked'))
    } catch (failure) {
      if (!mounted.current) return
      if (failure instanceof AssociationRequestError && failure.current !== undefined) {
        setOverride(failure.current)
        if (failure.code === 'directory-conflict') {
          setTarget(null); setDetail(null); setOverride(null); retry(); pricingAssociationsChanged()
        }
      }
      setError(requestMessage(failure, t))
    } finally { writing.current = false; if (mounted.current) setPending(false) }
  }

  const revokeButtons = (name: string): ReactNode => <>
    {confirmRevoke === name ? <span className={`${styles.actions} ${styles.revokeConfirmation}`}>
      <span className={styles.note}>{t('association.revokeImpact')}</span>
      <button type="button" className={styles.button} disabled={!writable} onClick={() => { void mutate('delete', name) }}>{t('association.confirmRevoke')}</button>
      <button type="button" className={styles.button} disabled={pending} onClick={() => setConfirmRevoke(null)}>{t('association.cancel')}</button>
    </span> : <button type="button" className={styles.button} disabled={!writable} onClick={() => setConfirmRevoke(name)}>{t('association.revoke')}</button>}
  </>

  return <dialog ref={dialogRef} className={`${shared.dialog} ${styles.dialog}`} aria-label={t('association.title')}
    onClose={event => { if (event.target === dialogRef.current) onClose() }}
    onCancel={event => { if (event.target === dialogRef.current && writing.current) event.preventDefault() }}
    onMouseDown={event => { backdropPress.current = event.target === dialogRef.current }}
    onClick={event => { if (event.target === dialogRef.current && backdropPress.current && !writing.current) dialogRef.current?.close() }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <div className={shared.dialogHead}><h2 className={shared.dialogTitle}>{t('association.title')}</h2>
      <button type="button" className={shared.dialogClose} aria-label={t('association.close')} disabled={pending} onClick={() => dialogRef.current?.close()}>✕</button>
    </div>
    {state.status === 'loading' && <p>{t('loading')}</p>}
    {state.status === 'error' && <><p role="alert">{t('association.loadFailed')}</p><button type="button" className={styles.button} onClick={reload}>{t('retry')}</button></>}
    {source !== null && ready && state.value.pricing === null && <><p role="alert">{t('association.candidatesUnavailable')}</p><button type="button" className={styles.button} disabled={pending} onClick={reload}>{t('retry')}</button></>}
    {error !== null && <p role="alert" className={styles.error}>{error} <button type="button" className={styles.button} disabled={pending} onClick={reload}>{t('association.refresh')}</button></p>}
    {notice !== null && <p role="status">{notice}</p>}
    {snapshot !== null && <>
      {snapshot.storageState !== 'ready' && <p role="alert">{t('pricing.associationStorageUnavailable')}</p>}
      {snapshot.writesPaused && <p role="status">{t('association.migrating')}</p>}
      {!snapshot.pricingAvailable && <p role="status">{t('pricing.unavailable')}</p>}
      {source === null ? <>
        <p className={styles.note}>{t('association.allHint')}</p>
        {snapshot.associations.length === 0 && <p className={styles.note}>{t('association.empty')}</p>}
        {snapshot.associations.map(row => <section key={modelKey(row.sourceModel)} className={`${styles.entry} ${styles.mappingRow}`}>
          <div className={styles.name}>{row.sourceModel} → {row.resolvedTargetModelId ?? row.targetModelId}</div>
          {revokeButtons(row.sourceModel)}
        </section>)}
      </> : <>
        <p className={`${styles.name} ${styles.source}`}>{source}</p>
        {automatic?.status === 'ambiguous' && <p>{t('pricing.ambiguous', { models: automatic.candidates.join(', ') })}</p>}
        {currentChoice !== undefined && <section className={styles.entry}>
          <div className={styles.name}>{source} → {currentChoice.resolvedTargetModelId ?? currentChoice.targetModelId}</div>
          <AssociationStatus row={currentChoice} t={t} />
          {savedTarget !== undefined && <button type="button" className={styles.button} onClick={() => setDetail(savedTarget)}>{t('association.preview')}</button>}
          {revokeButtons(source)}
        </section>}
        {automatic?.status === 'matched' ? <p>{t('association.automaticOnly')} {automatic.modelId}</p> : <>
          <label className={styles.label} htmlFor={searchId}>{t('association.search')}</label>
          <input id={searchId} className={styles.search} type="search" placeholder={t('association.searchHint')}
            value={query} disabled={pending} onChange={event => { setQuery(event.target.value); setTarget(null) }} />
          {candidates.length > 0 && <div className={styles.candidates} role="group" aria-label={t('association.candidates')}>
            {candidates.map(model => <label key={model.modelId} className={styles.candidate}>
              <input type="radio" name={searchId + '-target'} checked={target !== null && modelKey(target) === modelKey(model.modelId)} disabled={!writable || !snapshot.pricingAvailable}
                onChange={() => { setTarget(model.modelId); setNotice(null) }} />
              <span>{model.modelId}</span><small>{model.family}</small>
            </label>)}
          </div>}
          {query.trim() !== '' && candidates.length === 0 && <p className={styles.note}>{t('association.noResults')}</p>}
          {selected !== undefined && <div className={styles.selection}>
            <span className={styles.name}>{t('association.target', { model: selected.modelId })}</span>
            <button type="button" className={styles.button} onClick={() => setDetail(selected)}>{t('association.preview')}</button>
          </div>}
          <p className={styles.note}>{t('association.impact')}</p>
          <button type="button" className={`${styles.button} ${styles.save}`} disabled={!canSave} onClick={() => { void mutate('save', source) }}>{t(pending ? 'association.saving' : 'association.save')}</button>
        </>}
      </>}
    </>}
    {detail !== null && <PricingDialog model={detail.modelId} rules={detail.rules} view={candidateView} t={t} onClose={() => setDetail(null)} />}
  </dialog>
}
