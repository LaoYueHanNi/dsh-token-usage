import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssociationStorageError, CostState, PricingUnavailableReason } from '../wire.ts'

export function costsAvailable(state?: CostState): boolean {
  return state === undefined || state === 'ready'
}

/** Shared failure reasons; matching and prices remain entirely on the host. */
export function PricingStatus({ costState, pricingUnavailableReason, associationStorageError, t }: {
  costState?: CostState | undefined
  pricingUnavailableReason?: PricingUnavailableReason | undefined
  associationStorageError?: AssociationStorageError | undefined
  t: TranslateNS<'token-usage'>
}): ReactNode {
  const storageWarning = associationStorageError !== undefined
    ? <p role="status">{t('pricing.associationStorageUnavailable')}</p> : null
  const costWarning = !costsAvailable(costState)
    ? <p role="status">{t(costState === 'history-incomplete' ? 'pricing.historyIncomplete' : 'pricing.unavailable')}
      {costState === 'pricing-unavailable' && pricingUnavailableReason !== undefined ? ` ${t(`pricing.reason.${pricingUnavailableReason}`)}` : ''}
    </p> : null
  return <>{storageWarning}{costWarning}</>
}
