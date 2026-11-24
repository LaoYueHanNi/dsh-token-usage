// @vitest-environment jsdom
/**
 * Verifies the built browser bundle (`lib/client.js`) against both DSH client
 * stylesheet protocols:
 *   1. New hosts (DSH 0.2.2+ client-module-metadata / DocumentStyles): consume
 *      `manifest.meta().stylesheets` without leaving any fallback `<style data-plugin-css>`.
 *   2. Legacy hosts (DSH 0.2.1-rc.3 ~ 0.2.2-rc.5): ignore `meta`, mount fallback
 *      `<style data-plugin-css>` inside `ctx.effect`, and remove them on dispose.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface LoadedManifest {
  readonly id: string
  readonly meta?: () => {
    readonly stylesheets?: Record<string, { readonly text: (ctx: { asset: (ref: string) => string }) => string }>
  }
  readonly factory: (require: (specifier: string) => unknown) => {
    readonly inject?: readonly string[]
    readonly apply?: (ctx: unknown, config?: unknown) => void
  }
}

const BUNDLE_PATH = resolve(import.meta.dirname, '..', 'lib', 'client.js')
const PLUGIN_ID = '@laoyuehanni/dsh-token-usage'

function evaluateBundle(): LoadedManifest {
  const code = readFileSync(BUNDLE_PATH, 'utf8')
  let captured: LoadedManifest | undefined
  ;(window as unknown as { __ModuleLoader__?: { load: (m: LoadedManifest) => void } }).__ModuleLoader__ = {
    load(manifest: LoadedManifest) {
      captured = manifest
    },
  }
  // Evaluate the IIFE bundle in the jsdom global scope.
  new Function(code)()
  if (captured === undefined) throw new Error('bundle did not invoke __ModuleLoader__.load')
  return captured
}

function stubPlatformRequire(specifier: string): unknown {
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  return {}
}

function createFakeClientContext(): { ctx: Record<string, unknown>; dispose: () => void } {
  const cleanups: Array<() => void> = []
  const ctx: Record<string, unknown> = {
    locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => (k: string) => k) },
    slots: { inject: vi.fn(), register: vi.fn(() => () => {}) },
    inject: vi.fn(),
    get: vi.fn(() => undefined),
    effect(fn: () => (() => void) | void) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  return {
    ctx,
    dispose() {
      while (cleanups.length > 0) cleanups.pop()?.()
    },
  }
}

describe.skipIf(!existsSync(BUNDLE_PATH))('built client bundle client-module-metadata', () => {
  afterEach(() => {
    document.head.querySelectorAll('style[data-plugin-css]').forEach(el => el.remove())
    delete (window as unknown as { __ModuleLoader__?: unknown }).__ModuleLoader__
  })

  it('exposes meta().stylesheets and skips fallback DOM injection on new hosts', () => {
    const manifest = evaluateBundle()
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(typeof manifest.meta).toBe('function')

    const meta = manifest.meta!()
    const sheets = meta.stylesheets ?? {}
    const paths = Object.keys(sheets)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths).toContain('src/client/UsageView.module.css')
    for (const path of paths) {
      const css = sheets[path]!.text({ asset: ref => ref })
      expect(css.length).toBeGreaterThan(0)
    }

    // Calling apply after meta() must not inject legacy <style data-plugin-css>.
    const exports = manifest.factory(stubPlatformRequire)
    const { ctx, dispose } = createFakeClientContext()
    exports.apply?.(ctx)
    expect(document.head.querySelectorAll('style[data-plugin-css]').length).toBe(0)
    dispose()
  })

  it('mounts fallback styles on legacy hosts and cleans them up on dispose', () => {
    const manifest = evaluateBundle()
    const exports = manifest.factory(stubPlatformRequire)
    const { ctx, dispose } = createFakeClientContext()

    // Legacy host never invokes manifest.meta().
    exports.apply?.(ctx)
    const mounted = document.head.querySelectorAll('style[data-plugin-css]')
    expect(mounted.length).toBeGreaterThan(0)
    expect(Array.from(mounted).every(el => el.getAttribute('data-plugin') === PLUGIN_ID)).toBe(true)

    // Unloading/disposing the plugin removes every fallback <style> tag.
    dispose()
    expect(document.head.querySelectorAll('style[data-plugin-css]').length).toBe(0)
  })

  it('removes already-mounted fallback styles if meta() is invoked after apply()', () => {
    const manifest = evaluateBundle()
    const exports = manifest.factory(stubPlatformRequire)
    const { ctx, dispose } = createFakeClientContext()

    exports.apply?.(ctx)
    expect(document.head.querySelectorAll('style[data-plugin-css]').length).toBeGreaterThan(0)

    // New host DocumentStyles refreshes after apply(): meta() clears fallback tags.
    const meta = manifest.meta!()
    expect(Object.keys(meta.stylesheets ?? {}).length).toBeGreaterThan(0)
    expect(document.head.querySelectorAll('style[data-plugin-css]').length).toBe(0)
    dispose()
  })
})
