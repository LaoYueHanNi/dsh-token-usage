// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAsyncResource } from '../src/client/async-resource.ts'

afterEach(cleanup)

it('invalidates a pending request when only its scope changes', async () => {
  let resolveA!: (value: string) => void
  let signalA!: AbortSignal
  const { result, rerender } = renderHook(({ scope }) => useAsyncResource(signal => {
    if (scope === 'A') {
      signalA = signal
      return new Promise<string>(resolve => { resolveA = resolve })
    }
    return Promise.resolve('data B')
  }, [], { scopeKey: scope, silentAfterFirst: true, retryToken: 0 }), { initialProps: { scope: 'A' } })
  rerender({ scope: 'B' })
  await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', value: 'data B' }))
  expect(signalA.aborted).toBe(true)
  await act(async () => { resolveA('late data A') })
  expect(result.current[0]).toEqual({ status: 'ready', value: 'data B' })
})

it('only retains a failed refresh snapshot for the scope that produced it', async () => {
  const { result, rerender } = renderHook(({ scope, tick }) => useAsyncResource(
    () => tick === 0 ? Promise.resolve('data A') : Promise.reject(new Error('unavailable')),
    [tick], { scopeKey: scope, silentAfterFirst: true, retryToken: 0 },
  ), { initialProps: { scope: 'A', tick: 0 } })
  await waitFor(() => expect(result.current[0]).toEqual({ status: 'ready', value: 'data A' }))
  rerender({ scope: 'A', tick: 1 })
  await act(async () => {})
  expect(result.current[0]).toEqual({ status: 'ready', value: 'data A' })
  rerender({ scope: 'B', tick: 2 })
  await waitFor(() => expect(result.current[0]).toEqual({ status: 'error', message: 'unavailable' }))
})
