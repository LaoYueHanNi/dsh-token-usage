/**
 * Built client bundle smoke: loads lib/client.js the way the browser module
 * loader does (register the factory, then run it against an injected require)
 * and checks the cordis entry surface. Self-skips when the bundle has not
 * been built (`npm run build:client`).
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..')
const bundlePath = join(repoRoot, 'lib', 'client.js')
const built = existsSync(bundlePath)

describe.skipIf(!built)('client bundle', () => {
  it('registers a factory that yields the cordis entry surface', () => {
    const require = createRequire(join(repoRoot, 'smoke.cjs'))
    const captured: { id?: unknown; factory?: unknown } = {}
    ;(globalThis as Record<string, unknown>)['window'] = {
      __ModuleLoader__: { load: (payload: { id: unknown; factory: unknown }) => { captured.id = payload.id; captured.factory = payload.factory } },
    }
    require(bundlePath)
    expect(captured.id).toBe('dsh-token-usage')
    expect(typeof captured.factory).toBe('function')

    const exports = (captured.factory as (injectedRequire: (spec: string) => unknown) => unknown)(
      (spec) => require(spec),
    ) as { apply?: unknown; inject?: unknown }
    expect(typeof exports.apply).toBe('function')
    expect(exports.inject).toEqual(['slots', 'locale'])
  })
})
