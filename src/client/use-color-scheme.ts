/**
 * Shared browser-half hook: mirror the shell's root `color-scheme` onto a
 * plugin-owned root element. The shell sets the property on
 * `document.documentElement` only, so form controls inside plugin surfaces
 * render with the UA default (white) in dark mode; scoping the property to
 * the surface's root fixes selects, inputs, and dialogs without touching
 * anything outside it. Used by the settings section and the conversation
 * view tab.
 *
 * @module token-usage/client/use-color-scheme
 */

import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Mirror the shell's `color-scheme` inline style onto the given root element.
 * @param rootRef - the surface's root element ref.
 */
export function useColorSchemeMirror(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = document.documentElement
    const element = rootRef.current
    if (element === null) return
    const sync = (): void => {
      const scheme = root.style.colorScheme
      if (scheme !== '') element.style.colorScheme = scheme
      else element.style.removeProperty('color-scheme')
    }
    sync()
    // The shell rewrites the inline style on every theme switch.
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [rootRef])
}

/**
 * Hook reporting whether the current shell/page environment is in light mode.
 * Evaluates `document.documentElement.style.colorScheme` first (the DSH shell
 * rewrites this on every theme switch), falling back to `(prefers-color-scheme: light)`.
 */
export function useIsLightMode(): boolean {
  const [isLight, setIsLight] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false
    const rootScheme = document.documentElement.style.colorScheme
    if (rootScheme === 'light') return true
    if (rootScheme === 'dark') return false
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
      : false
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null

    const check = (): void => {
      const scheme = root.style.colorScheme
      if (scheme === 'light') {
        setIsLight(true)
      } else if (scheme === 'dark') {
        setIsLight(false)
      } else {
        setIsLight(media?.matches ?? false)
      }
    }

    check()
    const observer = new MutationObserver(check)
    observer.observe(root, { attributes: true, attributeFilter: ['style'] })
    if (media?.addEventListener) {
      media.addEventListener('change', check)
    }
    return () => {
      observer.disconnect()
      if (media?.removeEventListener) {
        media.removeEventListener('change', check)
      }
    }
  }, [])

  return isLight
}