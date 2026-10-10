import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CostState, ModelResolution, PricingUnavailableReason } from '../wire.ts'

export function costsAvailable(state?: CostState): boolean {
  return state === undefined || state === 'ready'
}

/** Shared failure reasons; matching and prices remain entirely on the host. */
export function PricingStatus({ costState, resolutions = [], pricingUnavailableReason, t }: {
  costState?: CostState | undefined
  pricingUnavailableReason?: PricingUnavailableReason | undefined
  resolutions?: readonly ModelResolution[]
  t: TranslateNS<'token-usage'>
}): ReactNode {
  if (!costsAvailable(costState)) {
    return <p role="status">{t(costState === 'history-incomplete' ? 'pricing.historyIncomplete' : 'pricing.unavailable')}
      {costState === 'pricing-unavailable' && pricingUnavailableReason !== undefined ? ` ${t(`pricing.reason.${pricingUnavailableReason}`)}` : ''}
    </p>
  }
  const failures = resolutions.filter(row => row.status !== 'matched')
  if (failures.length === 0) return null
  return <details>
    <summary>{t('pricing.identificationDetails')}</summary>
    <ul>{failures.map(row => <li key={row.rawName}>
      {row.rawName}: {row.status === 'ambiguous'
        ? t('pricing.ambiguous', { models: row.candidates.join(', ') })
        : t('pricing.unmatched')}
    </li>)}</ul>
  </details>
}
