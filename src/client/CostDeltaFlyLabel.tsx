import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { runDeltaFly } from './cost-inflate-motion.ts'
import type { CostInflateVars } from './cost-inflate.ts'
import styles from './SessionStatsChip.module.css'

/** One +Δ fly label; animation starts on mount via WAAPI. */
export function CostDeltaFlyLabel({ text, vars }: { text: string; vars: CostInflateVars }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const anim = runDeltaFly(el, vars)
    if (anim === null) {
      // Motion is allowed but this host has no WAAPI: without the animation
      // the label would sit statically for the whole inflate window — hide
      // it and let the number update be the only signal.
      el.style.visibility = 'hidden'
      return
    }
    return () => { anim.cancel() }
  }, [vars])

  return (
    <span ref={ref} className={styles['deltaFly']}>
      {text}
    </span>
  )
}
