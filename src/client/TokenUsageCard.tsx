/**
 * The token-usage card on the Plugins configuration tab: a collapsible row
 * whose header names the plugin over a one-line description of what its
 * settings govern, disclosing the data-directory control and the mirror
 * region pick (`domestic` gitee / `overseas` github) when open. The card owns
 * everything inside it — chrome, controls, and copy — per the keyed-slot
 * contract; the tab only dispatches it under the `token-usage` namespace key.
 *
 * Renders nothing while the namespace is unavailable: a deployment that did
 * not compose the host half shows no trace of the card. A region change takes
 * effect live (the host re-syncs the pricing mirror); a directory change the
 * guard refuses while conversations run shows the wait-for-them notice on the
 * failure line, and one that lands migrates the data across under a live
 * progress bar that locks the controls until it settles.
 *
 * @module token-usage/client/TokenUsageCard
 */

import { useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardActions, CardStore } from './card-form.ts'
import css from './TokenUsageCard.module.css'

/** Props the renderer binds for the token-usage settings card. */
export type TokenUsageCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'token-usage'>
  & InjectFace<TokenUsageCardFace>

/** The registration-side face this card's slot entry injects. */
export interface TokenUsageCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useTokenUsageCard. */
    tokenUsageCard: CardStore
  }
  /**
   * The shell's native directory picker (the workspace flows' chooser):
   * resolves the chosen absolute path, or null when the user dismisses the
   * dialog.
   */
  pickDirectory: () => Promise<string | null>
}

/**
 * Render the token-usage settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function TokenUsageCard(props: TokenUsageCardProps) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const { t } = props
  const state = props.useTokenUsageCard(snapshot => snapshot)
  if (!state.available) return null
  const migrating = state.migration !== undefined
  const lockInput = !state.writable || migrating
  const lockActions = !state.dirty || state.saving || migrating

  /**
   * Open the shell's native folder dialog and stage the chosen path — the
   * same picker the workspace flows use, driven through the injected
   * workspace service. A dismissal leaves the staged draft exactly as it
   * was; the text input stays the fallback either way.
   */
  const browse = async (): Promise<void> => {
    if (picking || lockInput) return
    setPicking(true)
    try {
      const picked = await props.pickDirectory()
      if (picked !== null && picked !== '') props.editField('path', picked)
    } catch (_pickFailure) {
      // Leave the draft untouched; typing the path remains available.
    } finally {
      setPicking(false)
    }
  }

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'card.collapse' : 'card.expand')}: ${t('card.title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('card.title')}</span>
          <span className={css.description}>{t('card.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('card.unsaved')}</span> : null}
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.note} role="status">{t('card.readOnly')}</p> : null}
            <label className={css.field} htmlFor="token-usage-card-path">
              <span className={css.fieldLabel}>{t('card.pathLabel')}</span>
              <span className={css.inputRow}>
                <input
                  id="token-usage-card-path"
                  className={css.input}
                  type="text"
                  spellCheck={false}
                  value={state.fields.path}
                  disabled={lockInput}
                  onChange={event => { props.editField('path', event.target.value) }}
                />
                <button
                  type="button"
                  className={css.browse}
                  disabled={lockInput || picking}
                  onClick={() => { void browse() }}
                >
                  {t(picking ? 'card.picking' : 'card.browse')}
                </button>
              </span>
            </label>
            <p className={css.hint}>{t('card.pathHint')}</p>
            <label className={css.field} htmlFor="token-usage-card-region">
              <span className={css.fieldLabel}>{t('card.regionLabel')}</span>
              <select
                id="token-usage-card-region"
                className={css.input}
                value={state.fields.pricingRegion}
                disabled={lockInput}
                onChange={event => { props.editField('pricingRegion', event.target.value) }}
              >
                <option value="">{t('card.regionDefault')}</option>
                <option value="domestic">{t('card.region.domestic')}</option>
                <option value="overseas">{t('card.region.overseas')}</option>
              </select>
            </label>
            <p className={css.hint}>
              {t('card.hint')}
              {state.overridden.pricingRegion ? ` ${t('card.overridden')}` : ''}
            </p>
            {state.migration !== undefined
              ? (
                <div className={css.migration} role="status">
                  <span className={css.migrationLabel}>
                    {t(state.migration.phase === 'copying' ? 'card.migratingCopy' : 'card.migratingClean')
                      .replace('{done}', String(state.migration.done))
                      .replace('{total}', String(state.migration.total))}
                  </span>
                  <span className={css.migrationBar}>
                    <span
                      className={css.migrationFill}
                      style={{ width: `${String(Math.round((state.migration.done / Math.max(state.migration.total, 1)) * 100))}%` }}
                    />
                  </span>
                </div>
              )
              : null}
            <div className={css.footer}>
              {state.failed
                ? (
                  <p className={css.failed} role="status">
                    {state.refusal !== undefined
                      ? t('card.saveBlockedSessions').replace('{count}', String(state.refusal.interactingSessions))
                      : t('card.saveFailed')}
                  </p>
                )
                : null}
              <button
                type="button"
                className={css.discard}
                disabled={lockActions}
                onClick={props.discard}
              >
                {t('card.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={lockActions}
                onClick={props.save}
              >
                {t(state.saving ? 'card.saving' : 'card.save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
