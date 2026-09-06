/**
 * The pricing dialog of one model: a native `<dialog>` (Esc closes, focus
 * is trapped, the backdrop dims, and the top layer renders it above the
 * table's scroll shell) holding that model's full price table — billing
 * conditions (default / context tiers / peak slots / time rules) × the four
 * per-million rates, converted for a USD view. Shared by the settings
 * page's per-model “定价” affordance and the pricing-overview dialog's
 * drill-in rows; a native showModal naturally stacks a second instance
 * above the overview.
 *
 * @module token-usage/client/PricingDialog
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextTier, DailySlot, ModelPricing, ModelRates, RateWindow } from '../wire.ts'
import { dayKeyOf } from './day.ts'
import { formatRate, formatRateWithSymbol, formatTokens } from './format.ts'
import type { CurrencyView } from './format.ts'
import styles from './PricingDialog.module.css'

/** The four base rates of one model as display text (symbol included,
 * converted for a USD view); a missing cache rate bills at the input rate. */
export function billedRates(rates: ModelPricing, view: CurrencyView): { input: string; output: string; cacheRead: string; cacheWrite: string } {
  return {
    input: formatRateWithSymbol(rates.inputPerMillion, view),
    output: formatRateWithSymbol(rates.outputPerMillion, view),
    cacheRead: formatRateWithSymbol(rates.cacheReadPerMillion ?? rates.inputPerMillion, view),
    cacheWrite: formatRateWithSymbol(rates.cacheWritePerMillion ?? rates.inputPerMillion, view),
  }
}

/** `HH:MM-HH:MM` of one peak window (half-open, local minutes). */
export function windowText(window: RateWindow): string {
  const clock = (minute: number): string =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  return `${clock(window.startMinute)}-${clock(window.endMinute)}`
}

/** The when-it-applies text of one peak slot: its label plus its windows. */
function slotCondition(slot: DailySlot, t: TranslateNS<'token-usage'>): string {
  return `${slot.label ?? t('pricing.peak')} ${slot.windows.map(windowText).join(t('pricing.windowSep'))}`
}

/**
 * One price row of the pricing table: the condition that bills at these
 * rates, and the four rates themselves. The condition text is complete —
 * a peak row inside a tier carries both the threshold and the windows —
 * so the row order never carries meaning on its own.
 */
interface PriceRow {
  condition: string
  rates: ModelPricing
}

/**
 * The price rows of one rate node (a time rule's or the model root's): the
 * node's own base rates, then its peak slots, then its context tiers
 * (ascending), each tier followed by the peak slots hanging on that tier —
 * mirroring {@link resolveRate}'s node chain, where a matching tier's slots
 * replace the node's and peak rates replace the node's rates wholesale.
 */
function nodePriceRows(node: { rates: ModelPricing; tiers?: ContextTier[] | undefined; slots?: DailySlot[] | undefined }, t: TranslateNS<'token-usage'>): PriceRow[] {
  const rows: PriceRow[] = [{ condition: t('pricing.default'), rates: node.rates }]
  const tiers = [...node.tiers ?? []].sort((a, b) => a.threshold - b.threshold)
  for (const tier of tiers) {
    const tierCondition = t('pricing.tier', { threshold: formatTokens(tier.threshold) })
    rows.push({ condition: tierCondition, rates: tier.rates })
    for (const slot of tier.dailySlots ?? []) {
      rows.push({ condition: `${tierCondition} · ${slotCondition(slot, t)}`, rates: slot.rates })
    }
  }
  for (const slot of node.slots ?? []) {
    rows.push({ condition: slotCondition(slot, t), rates: slot.rates })
  }
  return rows
}

/**
 * One model's price table: rows are billing conditions — grouped into the
 * model root (“常规”, omitted when it is the only group) and one group per
 * time rule with its date window — so tier, peak, and time-rule pricing
 * each show when they apply and what they bill. The structure mirrors
 * {@link resolveRate}'s node chain.
 */
export function ModelPriceTable({ rules, view, t }: {
  rules: ModelRates
  view: CurrencyView
  t: TranslateNS<'token-usage'>
}): ReactNode {
  // Groups follow resolveRate's chain: the model root (the current era)
  // first, then each time rule as an isolated price world, newest era
  // first (descending rule end), regardless of the feed's listing order.
  const groups = [
    {
      title: rules.timeRules.length > 0 ? t('pricing.regular') : null,
      rows: nodePriceRows({ rates: rules.base, tiers: rules.contextTiers, slots: rules.dailySlots }, t),
    },
    ...[...rules.timeRules]
      .sort((a, b) => b.endTime - a.endTime)
      .map(rule => ({
      // A zero start (the “since forever” rules some feeds carry) drops
      // the bogus 1970 date and reads as “through <end>”.
      title: `${rule.label !== undefined ? `${rule.label} ` : ''}${rule.startTime > 0 ? `${dayKeyOf(new Date(rule.startTime * 1000))} ~ ` : '~ '}${dayKeyOf(new Date(rule.endTime * 1000))}`,
      rows: nodePriceRows({ rates: rule.rates, tiers: rule.contextTiers, slots: rule.dailySlots }, t),
    })),
  ]
  return (
    <div className={styles['tableWrap']}>
      <table className={styles['table']} aria-label={t('pricing.title')}>
        <thead>
          <tr>
            <th className={styles['conditionHead']}>{t('pricing.condition')}</th>
            <th>{t('pricing.input')}{t('pricing.perMillion')}</th>
            <th>{t('pricing.output')}{t('pricing.perMillion')}</th>
            <th>{t('pricing.cacheRead')}{t('pricing.perMillion')}</th>
            <th>{t('pricing.cacheWrite')}{t('pricing.perMillion')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.flatMap(group => [
            ...(group.title !== null
              ? [
                <tr key={group.title} className={styles['groupRow']}>
                  <td colSpan={5}>{group.title}</td>
                </tr>,
              ]
              : []),
            ...group.rows.map((row, index) => {
              const billed = billedRates(row.rates, view)
              return (
                <tr key={`${group.title ?? ''}-${index}-${row.condition}`}>
                  <td className={styles['conditionCell']}>{row.condition}</td>
                  <td>{billed.input}</td>
                  <td>{billed.output}</td>
                  <td>{billed.cacheRead}</td>
                  <td>{billed.cacheWrite}</td>
                </tr>
              )
            }),
          ])}
        </tbody>
      </table>
      {view.symbol === '$'
        ? <p className={styles['rateNote']}>{t('pricing.exchangeRateNote', { rate: formatRate(view.rate) })}</p>
        : null}
    </div>
  )
}

/**
 * The pricing dialog of one model. Mounts only while a model is selected;
 * every close path funnels through the dialog's `close` event, which clears
 * the selection and unmounts it.
 */
export function PricingDialog({ model, rules, view, onClose, t }: {
  model: string
  rules: ModelRates
  view: CurrencyView
  onClose: () => void
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // The backdrop-close press guard: a text-selection drag released outside
  // the dialog lands its click on the dialog element (the click fires on
  // the press/release targets' common ancestor, and outside a top-layer
  // dialog every point resolves to the dialog) — the same target a real
  // backdrop click produces. Only a press that began on the backdrop may
  // close; see the overview dialog's backdropPress for the full story.
  const backdropPress = useRef(false)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className={styles['dialog']}
      aria-label={t('pricing.title')}
      onClose={onClose}
      // A click that landed on the dialog element itself hit the backdrop
      // (the content sits in child elements), which closes like Esc does —
      // but only when the press started there too: a selection drag
      // released outside produces the same click target.
      onMouseDown={event => { backdropPress.current = event.target === dialogRef.current }}
      onClick={event => {
        if (event.target === dialogRef.current && backdropPress.current) dialogRef.current?.close()
      }}
    >
      <div className={styles['dialogHead']}>
        <span className={styles['dialogTitle']}>{model}</span>
        <button
          type="button"
          className={styles['dialogClose']}
          aria-label={t('pricing.close')}
          onClick={() => dialogRef.current?.close()}
        >
          ✕
        </button>
      </div>
      <ModelPriceTable rules={rules} view={view} t={t} />
    </dialog>
  )
}
