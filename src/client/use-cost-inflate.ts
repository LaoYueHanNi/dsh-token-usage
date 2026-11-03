/**
 * Request-driven cost-figure inflate animation for the composer-dock usage
 * pill: detects new usage from summary deltas and drives the WAAPI motion on
 * the cost figure (a scale + colour pop whose amplitude follows the step's
 * token intensity).
 *
 * @module token-usage/client/use-cost-inflate
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { UsageSummary } from '../wire.ts'
import { costsAvailable } from './PricingStatus.tsx'
import { totalTokens } from './day.ts'
import { motionAllowed, runCostPop } from './cost-inflate-motion.ts'
import {
  animVars,
  computeIntensityFromDelta,
  deltaTotals,
} from './cost-inflate.ts'

interface PrevChipSnapshot {
  totals: UsageSummary['total']
  totalCost: number
}

export interface UseCostInflateResult {
  /** Call when a fresh chip summary lands (after first paint baseline). */
  onSummary: (summary: UsageSummary) => void
  /** Clear baseline and the in-flight pop (session / scope change). */
  reset: () => void
}

const MIN_WIRE_DELTA_COST = 0.000_5

function hasUsageChurn(prev: PrevChipSnapshot, summary: UsageSummary): boolean {
  const delta = deltaTotals(prev.totals, summary.total)
  if (delta.requests > 0) return true
  if (summary.totalCost - prev.totalCost > MIN_WIRE_DELTA_COST) return true
  return totalTokens(delta) > 0
}

/**
 * Hook the pill uses to play the costPop on each new request.
 * @param scopeKey - changes reset the diff baseline.
 * @param costRef - the live cost figure span (WAAPI target).
 */
export function useCostInflate(
  scopeKey: string,
  costRef: RefObject<HTMLElement | null>,
): UseCostInflateResult {
  const prevRef = useRef<PrevChipSnapshot | null>(null)
  const popAnimRef = useRef<Animation | null>(null)

  const reset = useCallback(() => {
    popAnimRef.current?.cancel()
    popAnimRef.current = null
    prevRef.current = null
  }, [])

  useEffect(() => {
    reset()
  }, [scopeKey, reset])

  useEffect(() => () => { popAnimRef.current?.cancel() }, [])

  const playCostPop = useCallback((v: ReturnType<typeof animVars>) => {
    const el = costRef.current
    if (el === null) return
    popAnimRef.current?.cancel()
    popAnimRef.current = runCostPop(el, v)
  }, [costRef])

  const onSummary = useCallback((summary: UsageSummary) => {
    if (!costsAvailable(summary.costState)) { reset(); return }
    const nextSnapshot: PrevChipSnapshot = {
      totals: summary.total,
      totalCost: summary.totalCost,
    }
    const prev = prevRef.current
    prevRef.current = nextSnapshot
    if (prev === null) return
    if (!hasUsageChurn(prev, summary)) return
    // Reduced motion: the baseline is already stored above, so the figure
    // repaints silently — no pop.
    if (!motionAllowed()) return

    const delta = deltaTotals(prev.totals, summary.total)
    const I = computeIntensityFromDelta(delta)
    const v = animVars(I)

    window.requestAnimationFrame(() => { playCostPop(v) })
  }, [playCostPop, reset])

  return { onSummary, reset }
}
