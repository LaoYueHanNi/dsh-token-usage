/**
 * Shared async-resource state machine for the conversation-view consumers.
 * Every fetch-driven component repeats the same shape — three states
 * (`loading` / `error` / `ready`), a retry counter, and cancellation on
 * dependency change. Centralising the pattern here means a regression in
 * the cancellation logic lands in one spot instead of three.
 *
 * @module token-usage/client/async-resource
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** The discriminated union a fetch-driven component exposes to its renderer. */
export type AsyncResource<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: T }

/**
 * Drive one fetcher's lifecycle: reruns on dependency change, cancels the
 * previous attempt on a new fetch, and on retry-bump refetches even with
 * the same deps. `silentAfterFirst` keeps the previous value on screen —
 * the dashboard never blanks during a refresh once data is up.
 *
 * @param fetcher - the async loader; receives an `AbortSignal` for
 * cancellation. Throwing aborts the fetch (the next effect run triggers
 * a fresh attempt).
 * @param deps - the dependency list that retriggers a fetch (passed
 * through to React's effect; the retry counter joins the list).
 * @param options.silentAfterFirst - when true, the first fetch goes to
 * `loading` and subsequent refreshes keep the prior `value` on screen
 * until the new one lands.
 * @param options.scopeKey - the data range the on-screen snapshot belongs
 * to (e.g. the scoped session ids). A snapshot is only kept WITHIN the
 * range that produced it: while a new range's fetch is in flight the old
 * figures stay on screen (no flash), but if that fetch FAILS the kept value
 * belongs to another range — the hook lands in `error` instead of showing
 * the old range's rows as if they were the current one's. Same-key refresh
 * failures keep the silent semantics.
 * @param options.retryToken - bumping this value triggers a refetch even
 * with unchanged deps (the consumer wires a "retry" button to it).
 * @returns `[state, retry]` — the current state plus a stable `retry()`
 * callback that bumps the internal counter and re-runs the effect.
 */
export function useAsyncResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>,
  options: { silentAfterFirst?: boolean; retryToken: number; scopeKey?: string },
): [AsyncResource<T>, () => void] {
  const silent = options.silentAfterFirst === true
  const [state, setState] = useState<AsyncResource<T>>({ status: 'loading' })
  // Tracking whether the first fetch has ever completed keeps silent mode
  // from blanking the UI on a transient refresh failure.
  const loadedRef = useRef(false)
  // The kept snapshot belongs to the range captured by its own request.
  const valueScopeRef = useRef(options.scopeKey)
  // Internal retry counter — kept in state so a stable callback can bump
  // it via React's setter and trigger a re-run through the effect's deps.
  const [retryTick, setRetryTick] = useState(0)
  const retry = useCallback(() => {
    setRetryTick(tick => tick + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // Capture the range for this request. A later render may switch scope
    // while the fetch is pending; its result must never be attributed to the
    // newer range through a mutable ref.
    const requestScope = options.scopeKey
    // Silent mode: keep the prior value on screen while refetching. The
    // very first attempt still flashes loading so the user sees that the
    // fetch is in flight. A range switch keeps the old figures visible
    // while the new range's fetch runs — and silently drops them if that
    // fetch fails (see the catch below).
    if (!silent || !loadedRef.current) setState({ status: 'loading' })
    fetcher(controller.signal)
      .then(value => {
        if (controller.signal.aborted) return
        loadedRef.current = true
        valueScopeRef.current = requestScope
        setState({ status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // Silent mode: don't blank the dashboard if we ever had data — but
        // only data of the range on screen. Another range's snapshot would
        // misattribute its rows (and its stale stamp) to the new range.
        if (silent && loadedRef.current && valueScopeRef.current === requestScope) return
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => { controller.abort() }
    // The fetcher itself is intentionally not in the dep list — every
    // caller passes a fresh closure each render, and the token counters
    // are the only legitimate triggers for a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, options.retryToken, retryTick, silent, options.scopeKey])

  return [state, retry]
}

/**
 * Return a value that lags behind its source by `delayMs` — a debounced
 * snapshot. The initial render already holds `value` (no null sentinel), so
 * a consumer can fetch immediately on mount without a second shot when the
 * first debounce window closes on the same value.
 *
 * @param value - the source value to debounce.
 * @param delayMs - the lag window in milliseconds.
 * @returns the debounced value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value) }, delayMs)
    return () => { clearTimeout(timer) }
  }, [value, delayMs])
  return debounced
}
