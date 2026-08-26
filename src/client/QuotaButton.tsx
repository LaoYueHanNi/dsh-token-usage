/**
 * Input-bar quota button (browser half): a 28×28 round trigger registered
 * into the `conversation.input.right` slot (it renders left of the model
 * chip — the host's fixed tool-row order). The glyph is a remaining-share
 * ring (ContextMeter family) colored by the finest window. Clicking opens a
 * width-tiered popup (amount-only 200px / one progress bar 232px / two
 * bars 320px) centered on the button with the current provider's quota
 * windows: progress columns (5 小时 / 每周) for coding-plan providers, an
 * amount row for balance providers.
 *
 * The provider follows the model CHIP's live selection (the shell's
 * model-selection service reports the host's next selection before any
 * request is sent); without that service the host falls back to the last
 * request's provider, else the default selection.
 *
 * The button SELF-GATES: it renders nothing while the host cannot
 * determine a provider (`no-provider`), the provider has no quota adapter
 * (`unsupported`), or the feature is off (`disabled`) — switching
 * providers makes it appear again. A supported provider whose query fails
 * KEEPS the button and shows the error with a retry inside the panel.
 *
 * The hover tooltip reads provider name + the finest window's exact
 * remaining figure (percent, or the amount when no ratio exists).
 *
 * The interaction copies ContextMeter verbatim (click toggles, document
 * pointerdown outside closes, Escape closes); mutual exclusion with the
 * ContextMeter panel falls out of both components' outside-close
 * handlers — opening one closes the other on its next pointerdown.
 *
 * @module token-usage/client/QuotaButton
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the standard session kit into the input-right runtime
// props this component binds.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `conversation.input.right` SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QuotaError, QuotaPayload, QuotaTier, QuotaWindow } from '../wire.ts'
import { QUOTA_PATH } from '../wire.ts'
import { useAsyncResource } from './async-resource.ts'
import {
  finestQuotaWindow, formatQuotaClock, formatQuotaMoney, formatQuotaPercent, formatResetCountdown,
  quotaIconFillShare, quotaRemainingPercent, quotaSeverityOf, quotaTriggerFigure, quotaUsedPercent,
} from './quota-format.ts'
import type { QuotaSeverity } from './quota-format.ts'
import { useColorSchemeMirror } from './use-color-scheme.ts'
import styles from './QuotaButton.module.css'

/** The poll cadence fallback (seconds) while no payload has named one. */
const DEFAULT_POLL_SEC = 60

/** Panel width tiers (px), by how much the windows paint: a lone amount
 * reads at a glance, one progress bar needs breathing room, two bars (the
 * 5-hour + weekly coding plans, or a long error body) the full plate. Kept
 * in sync with the CSS max-width clamp. */
const PANEL_WIDTH_BALANCE = 200
const PANEL_WIDTH_SINGLE = 232
const PANEL_WIDTH_FULL = 320
const PANEL_VIEWPORT_MARGIN = 16

/** Tier → label key; the locale dictionaries carry both languages. */
const TIER_LABEL_KEYS: Record<QuotaTier, 'quota.tier.fiveHour' | 'quota.tier.weekly' | 'quota.tier.monthly' | 'quota.tier.balance'> = {
  five_hour: 'quota.tier.fiveHour',
  weekly: 'quota.tier.weekly',
  monthly: 'quota.tier.monthly',
  balance: 'quota.tier.balance',
}

/**
 * Structural view of the shell's model-selection service
 * (`ctx.modelDirectories`, owned by ui-model-selection) — the same shared
 * per-session directory the model chip renders from. Structural on
 * purpose: no value import across plugins, and no compile-time tie to a
 * package version the shell may or may not carry.
 */
export interface ModelSelectionSource {
  /** The session's shared directory (throws when the session resolves no scope). */
  directoryFor(sessionId: string): {
    /** The host-reported selection for the NEXT assembled step; null before the first load. */
    store: {
      getSnapshot(): { current: { provider: string } | null }
      subscribe(fn: () => void): () => void
    }
  }
}

/** Stable holder the registration injects; the service attaches late (optional inject). */
export interface ModelDirectoryHandle {
  readonly service: ModelSelectionSource | undefined
}

/** Props the quota button binds for the conversation input-right slot. */
export type QuotaButtonProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'token-usage'>
  & { modelDirectory?: ModelDirectoryHandle }

/**
 * Render the input-bar quota button for the active session's provider.
 * @param props - the framework session id, the locale seat, and the
 * optional model-directory holder (the chip's live selection).
 * @returns the trigger + panel, or null while hidden (see the module note).
 */
export function QuotaButton({ sessionId, t, modelDirectory }: QuotaButtonProps): ReactNode | null {
  const rootRef = useRef<HTMLSpanElement>(null)
  useColorSchemeMirror(rootRef)
  const [open, setOpen] = useState(false)

  // The panel centers on the button rather than corner-anchoring to it:
  // the harness's own popups sit flush right because their triggers own the
  // row's right end, but this one renders left of the model chip, where a
  // right-aligned panel would skew up-left. The slot exposes no positioned
  // ancestor to lean on, so the offset is measured from the wrapper (whose
  // position: relative hosts the panel) — panel center on button center,
  // nudged to stay inside the viewport's 16px margins (the button sits in
  // the right cluster, where a bare centering could push the panel
  // off-screen on narrow windows). Set at open time, refreshed on resize
  // and any ancestor scroll while open.
  const [panelLeft, setPanelLeft] = useState<number | undefined>(undefined)
  const measurePanelLeft = useCallback((width: number): void => {
    const wrapper = rootRef.current
    if (wrapper === null) return
    const { left: wrapperLeft, width: wrapperWidth } = wrapper.getBoundingClientRect()
    const panelWidth = Math.min(width, window.innerWidth - 2 * PANEL_VIEWPORT_MARGIN)
    const desired = (wrapperWidth - panelWidth) / 2
    const minLeft = PANEL_VIEWPORT_MARGIN - wrapperLeft
    const maxLeft = window.innerWidth - PANEL_VIEWPORT_MARGIN - panelWidth - wrapperLeft
    setPanelLeft(Math.min(Math.max(desired, minLeft), Math.max(minLeft, maxLeft)))
  }, [])

  // The provider the model chip currently selects — the host-reported NEXT
  // selection, live before any request is sent. Seeded synchronously (the
  // chip's directory has usually loaded by the time this button mounts),
  // then kept live through the store subscription; absent when the shell's
  // model-selection service is unavailable or has not loaded yet, in which
  // case the host falls back to its own resolution (last request's
  // provider, else the default model selection).
  const modelService = modelDirectory?.service
  const readChipProvider = (): string | undefined => {
    if (sessionId === '' || modelService === undefined) return undefined
    try {
      return modelService.directoryFor(sessionId).store.getSnapshot().current?.provider ?? undefined
    } catch {
      // An unresolvable session scope (e.g. a transient subagent address)
      // simply contributes no hint.
      return undefined
    }
  }
  const [chipProvider, setChipProvider] = useState<string | undefined>(readChipProvider)
  useEffect(() => {
    // Re-seed on session/service change, then subscribe for chip switches.
    setChipProvider(readChipProvider())
    if (sessionId === '' || modelService === undefined) return
    let directory: ReturnType<ModelSelectionSource['directoryFor']> | undefined
    try {
      directory = modelService.directoryFor(sessionId)
    } catch {
      return
    }
    return directory.store.subscribe(() => { setChipProvider(readChipProvider()) })
    // The synchronous reader is intentionally not a dep: it closes over the
    // two deps below and would re-run the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, modelService])

  const [resource, retry] = useAsyncResource<QuotaPayload | null>(
    signal => fetchQuotaPayload(sessionId, chipProvider, signal),
    [sessionId, chipProvider],
    { silentAfterFirst: true, retryToken: 0 },
  )
  const payload = resource.status === 'ready' ? resource.value : null
  // The width tier follows what the windows paint (amount-only / one bar /
  // two bars — see {@link panelWidthOf}); errors read the full plate.
  const panelWidth = panelWidthOf(payload)
  // The cadence follows the host's config (stamped on every payload); the
  // fallback only covers the very first polls.
  const pollMs = (payload?.intervalSec ?? DEFAULT_POLL_SEC) * 1000
  useEffect(() => {
    const timer = setInterval(retry, pollMs)
    return () => { clearInterval(timer) }
  }, [pollMs, retry])

  // Visible only for a determinable, adapter-backed provider; errors keep
  // the button (the panel carries them).
  const visible = payload !== null && (payload.status === 'ok' || payload.status === 'error')
  // A provider switch (or a turn to unsupported) mid-panel closes it.
  useEffect(() => {
    if (!visible && open) setOpen(false)
  }, [visible, open])

  // Outside click / Escape close — ContextMeter's pattern, one document
  // listener pair while open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // While open, a viewport resize or any ancestor scroll moves the button
  // — re-measure so the panel keeps following its center. Re-running on a
  // width-tier change (a provider switch mid-panel) re-centers too.
  useEffect(() => {
    if (!open) return
    const onViewportChange = (): void => { measurePanelLeft(panelWidth) }
    measurePanelLeft(panelWidth)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, panelWidth, measurePanelLeft])

  if (!visible || payload === null) return null

  const windows = payload.status === 'ok' ? payload.windows : []
  // The icon reads the FINEST-granularity window (5-hour over weekly over
  // balance), not the worst across them — the finest unit is the constraint
  // the session currently acts inside.
  const finest = finestQuotaWindow(windows)
  const severity = finest === undefined ? 'ok' : quotaSeverityOf(finest)
  const triggerClass = [styles.trigger]
  if (severity === 'warn') triggerClass.push(styles['icon-warn'])
  else if (severity === 'exhausted') triggerClass.push(styles['icon-exhausted'])
  else if (finest !== undefined && quotaRemainingPercent(finest) !== undefined) {
    // A healthy ratio window (or an amount WITH a total, ratio-colored the
    // same way) reads green, completing the traffic light; an absolute
    // amount without a total stays neutral — it colors only at ≤ 0 (red).
    triggerClass.push(styles['icon-ok'])
  }
  const triggerClassName = triggerClass.join(' ').trim()

  // The hover tooltip carries the exact figure the ring approximates:
  // provider name + the finest window's remaining share (its amount when
  // no ratio exists); errors and window-less payloads keep the plain
  // label.
  const figure = quotaTriggerFigure(finest)
  const triggerTip = figure === undefined
    ? t('quota.trigger')
    : t('quota.triggerSummary', { name: payload.providerName ?? payload.provider, figure })

  return (
    <span ref={rootRef} className={styles.root}>
        <Tooltip label={triggerTip} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={triggerClassName}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('quota.trigger')}
          // Opening refreshes (the host's TTL cache keeps it cheap) and
          // measures the centered placement before the panel's first paint;
          // closing does neither — the poll cadence covers the data.
          onClick={() => { if (!open) { retry(); measurePanelLeft(panelWidth) } setOpen(!open) }}
        >
          <QuotaGlyph share={quotaIconFillShare(finest)} />
        </button>
      </Tooltip>
      {open && (
        <div
          className={styles.panel}
          role="dialog"
          aria-label={t('quota.panel')}
          style={{
            width: `${String(panelWidth)}px`,
            ...(panelLeft === undefined ? {} : { left: `${String(panelLeft)}px` }),
          }}
        >
          <div className={styles.header}>
            <span className={styles.title}>
              {payload.providerName ?? payload.provider}
              {payload.status === 'ok' && payload.planTier !== undefined
                ? <span className={styles.plan}> · {payload.planTier}</span>
                : null}
            </span>
            <span className={styles.updated}>
              {t('quota.updatedAt', { time: formatQuotaClock(payload.fetchedAt) })}
            </span>
          </div>
          {payload.status === 'error'
            ? (
              <div className={styles.error}>
                <span className={styles.errorText}>{errorText(payload.error, t)}</span>
                <button type="button" className={styles.retry} onClick={retry}>
                  {t('quota.retry')}
                </button>
              </div>
            )
            : (
              <div
                className={styles.grid}
                style={{ '--cols': String(Math.min(payload.windows.length, 3)) } as CSSProperties}
              >
                {payload.windows.map((window, index) =>
                  <QuotaColumn key={`${window.tier}:${String(index)}`} window={window} t={t} />)}
              </div>
            )}
        </div>
      )}
    </span>
  )
}

/** Ring geometry matches ContextMeter: 14px viewBox, r 5.5, 2px stroke.
 * Circumference feeds the remaining-share dasharray, starting at 12
 * o'clock. A 0 share omits the fill stroke — a round cap at 0 would still
 * paint a dot. */
const RING_R = 5.5
const RING_C = 2 * Math.PI * RING_R
/** Round caps paint half a stroke width beyond each dash end; their
 * combined reach is what the dash compensation subtracts, so the painted
 * arc (dash + caps) equals the nominal share and the caps cannot seal the
 * 12-o'clock gap. */
const RING_CAP_REACH = 2

/** The trigger glyph: a ContextMeter-family donut whose fill arc is the
 * remaining share of the finest window. Color comes from the button's
 * severity class (`currentColor`); this only draws the arc. */
function QuotaGlyph({ share }: { share: number }): ReactNode {
  const clamped = Math.min(1, Math.max(0, share))
  // Cap compensation: round caps extend the painted arc by RING_CAP_REACH,
  // which sealed any gap under ~5.8% of the ring (a 1% gap rendered
  // pixel-identical to a full one). Shortening the dash keeps the gap open
  // at the ring's rims — any nonzero usage stays visible — while the
  // centerline gap stays linear in the remaining share. A full share keeps
  // the entire circumference (compensated caps would only touch at one
  // point, leaving a rim notch that reads as ~98%); an arc no longer than
  // the cap reach skips the compensation (a dash ≤ 0 paints nothing and
  // would drop the nub).
  const nominal = clamped * RING_C
  const dashLen = clamped >= 1 ? RING_C
    : nominal <= RING_CAP_REACH ? nominal
    : nominal - RING_CAP_REACH
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <circle cx="7" cy="7" r={RING_R} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.22" />
      {clamped > 0
        ? (
          <circle
            cx="7"
            cy="7"
            r={RING_R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap={clamped < 1 ? 'round' : 'butt'}
            strokeDasharray={`${dashLen.toFixed(3)} ${RING_C.toFixed(3)}`}
            transform="rotate(-90 7 7)"
          />
        )
        : null}
    </svg>
  )
}

/** One progress column: label / value / bar / aux. The value and the bar
 * both carry the REMAINING share (the traffic-light standard reads what is
 * left), colored by severity. */
function QuotaColumn({ window, t }: { window: QuotaWindow; t: QuotaButtonProps['t'] }): ReactNode {
  const remaining = quotaRemainingPercent(window)
  const severity: QuotaSeverity = quotaSeverityOf(window)
  const label = t(TIER_LABEL_KEYS[window.tier])

  // Balance windows lead with the amount (the figure the user manages
  // against); ratio windows with the remaining share. The `meta` suffix
  // carries the balance's total.
  let value: string
  let meta: string | undefined
  if (window.tier === 'balance' && window.remainingValue !== undefined) {
    const unit = window.unit ?? 'cny'
    value = formatQuotaMoney(window.remainingValue, unit)
    if (window.maxValue !== undefined) meta = `/ ${formatQuotaMoney(window.maxValue, unit)}`
  } else {
    value = remaining !== undefined ? formatQuotaPercent(remaining) : '—'
  }
  const aux = window.resetAt !== undefined
    ? t('quota.resetIn', { time: formatResetCountdown(window.resetAt, Date.now()) })
    : undefined

  return (
    <div className={styles.col}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>
        {value}
        {meta !== undefined ? <span className={styles.meta}> {meta}</span> : null}
      </div>
      {remaining !== undefined && (
        <div className={styles.bar}>
          <div
            className={`${styles.fill} ${styles[severity]}`}
            style={{ width: `${String(Math.round(remaining))}%` }}
          />
        </div>
      )}
      {aux !== undefined && (
        <div className={styles.aux}>
          <span className={`${styles.dot} ${styles[severity]}`} />
          {aux}
        </div>
      )}
    </div>
  )
}

/** The panel's width tier for one payload: what the windows PAINT decides —
 * a lone amount (no computable bar, the DeepSeek shape) reads at the
 * minimal plate, one bar (a weekly-only plan, or a balance with a spend
 * total like OpenRouter) the middle one, two or more bars the full plate.
 * Errors and payloads without windows read the full plate (their copy
 * runs long). */
function panelWidthOf(payload: QuotaPayload | null): number {
  if (payload === null || payload.status !== 'ok') return PANEL_WIDTH_FULL
  const bars = payload.windows.filter(window => quotaUsedPercent(window) !== undefined).length
  if (bars === 0) return payload.windows.length > 0 ? PANEL_WIDTH_BALANCE : PANEL_WIDTH_FULL
  return bars === 1 ? PANEL_WIDTH_SINGLE : PANEL_WIDTH_FULL
}

/** Friendly locale copy for one normalized query error. */
function errorText(error: QuotaError, t: QuotaButtonProps['t']): string {
  switch (error.kind) {
    case 'auth':
      return t('quota.error.auth', { message: error.message })
    case 'no-credential':
      return t('quota.error.noCredential', { ref: error.message })
    case 'http':
      return t('quota.error.http', { message: error.message })
    case 'network':
      return t('quota.error.network', { message: error.message })
    case 'parse':
      return t('quota.error.parse', { message: error.message })
  }
}

/** Defensive shape check: a misrouted response must not paint the button. */
function looksLikeQuotaPayload(value: unknown): value is QuotaPayload {
  return typeof value === 'object' && value !== null
    && typeof (value as { status?: unknown }).status === 'string'
    && typeof (value as { intervalSec?: unknown }).intervalSec === 'number'
}

/**
 * Fetch the quota payload for the active session, naming the chip-selected
 * provider when one is known. Throws on transport failure or a payload that
 * does not look like one, so the hook can keep the previous render
 * (silentAfterFirst) or stay hidden (first failure).
 */
async function fetchQuotaPayload(sessionId: string, provider: string | undefined, signal: AbortSignal): Promise<QuotaPayload | null> {
  const params = new URLSearchParams()
  if (sessionId !== '') params.set('session', sessionId)
  if (provider !== undefined && provider !== '') params.set('provider', provider)
  const encoded = params.toString()
  const query = encoded === '' ? '' : `?${encoded}`
  const response = await fetch(QUOTA_PATH + query, {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const value: unknown = await response.json()
  if (!looksLikeQuotaPayload(value)) throw new Error('unexpected quota response')
  return value
}
