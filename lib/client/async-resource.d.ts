/**
 * Shared async-resource state machine for the conversation-view consumers.
 * Every fetch-driven component repeats the same shape — three states
 * (`loading` / `error` / `ready`), a retry counter, and cancellation on
 * dependency change. Centralising the pattern here means a regression in
 * the cancellation logic lands in one spot instead of three.
 *
 * @module token-usage/client/async-resource
 */
/** The discriminated union a fetch-driven component exposes to its renderer. */
export type AsyncResource<T> = {
    status: 'loading';
} | {
    status: 'error';
    message: string;
} | {
    status: 'ready';
    value: T;
};
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
 * @param options.retryToken - bumping this value triggers a refetch even
 * with unchanged deps (the consumer wires a "retry" button to it).
 * @returns `[state, retry]` — the current state plus a stable `retry()`
 * callback that bumps the internal counter and re-runs the effect.
 */
export declare function useAsyncResource<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: ReadonlyArray<unknown>, options: {
    silentAfterFirst?: boolean;
    retryToken: number;
}): [AsyncResource<T>, () => void];
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
export declare function useDebouncedValue<T>(value: T, delayMs: number): T;
//# sourceMappingURL=async-resource.d.ts.map