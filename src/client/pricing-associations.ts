import { useEffect, useRef } from 'react'
import type { ModelResolution, PricingAssociationsPayload } from '../wire.ts'

const CHANGED_EVENT = 'token-usage:pricing-associations-changed'
const TABLE_CHANGED_EVENT = 'token-usage:pricing-table-changed'

/** All mounted usage views refresh their existing query after a real commit. */
export function pricingAssociationsChanged(): void { window.dispatchEvent(new Event(CHANGED_EVENT)) }
export function pricingTableChanged(): void { window.dispatchEvent(new Event(TABLE_CHANGED_EVENT)) }

export function usePricingAssociationRefresh(refresh: () => void): void {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    const changed = (): void => { latest.current() }
    window.addEventListener(CHANGED_EVENT, changed)
    window.addEventListener(TABLE_CHANGED_EVENT, changed)
    return () => {
      window.removeEventListener(CHANGED_EVENT, changed)
      window.removeEventListener(TABLE_CHANGED_EVENT, changed)
    }
  }, [])
}

export class AssociationRequestError extends Error {
  constructor(readonly code: string, readonly current?: PricingAssociationsPayload) { super(code) }
}

/** Optional pricing references and the current feed version; no usage or credentials. */
export function pricingIssueUrl(resolution: ModelResolution, version?: number): string {
  const lines = [
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
    `   - ${version ?? 'Unknown'}`,
  ]
  const url = new URL('https://github.com/LaoYueHanNi/model-price-table/issues/new')
  url.searchParams.set('title', `Add model pricing: ${resolution.rawName}`)
  url.searchParams.set('body', lines.join('\n'))
  return url.href
}
