/**
 * The token-usage card on the Plugins configuration tab: a collapsible row
 * whose header names the plugin over a one-line description of what its
 * settings govern, disclosing the mirror region pick (`domestic` gitee /
 * `overseas` github) when open. The card owns everything inside it — chrome,
 * controls, and copy — per the keyed-slot contract; the tab only dispatches
 * it under the `token-usage` namespace key.
 *
 * Renders nothing while the namespace is unavailable: a deployment that did
 * not compose the host half shows no trace of the card. A region change takes
 * effect live (the host re-syncs the pricing mirror), which the hint states.
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
}

/**
 * Render the token-usage settings card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function TokenUsageCard(props: TokenUsageCardProps) {
  const [open, setOpen] = useState(false)
  const { t } = props
  const state = props.useTokenUsageCard(snapshot => snapshot)
  if (!state.available) return null
  const lockInput = !state.writable
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
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{t('card.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {t('card.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={!state.dirty || state.saving}
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
