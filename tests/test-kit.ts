/**
 * Test kit: tiny fakes for the framework hooks this plugin consumes.
 * Centralising the fakes means every test uses the same shape and the
 * `as never` casts that masked type mismatches can go away.
 *
 * @module token-usage/test-kit
 */

import type { SessionListState, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'

/** A `useSessions` fake: holds a snapshot in closure and
 * runs each selector through it. Tests can pass an initial snapshot and
 * swap it via the returned setter to simulate framework mirror churn. */
export function makeSessionStateHook<T>(
  initial: T,
): {
  hook: SnapshotSelectorHook<T>
  setState: (next: T) => void
} {
  let current = initial
  const hook: SnapshotSelectorHook<T> = selector => selector(current)
  return { hook, setState: (next: T) => { current = next } }
}

/**
 * Build a `useSessions` hook from a `SessionListState`-shaped value. Use
 * this with the `BY_ID` / `SESSION_STATE` fixtures in usage-view tests so
 * the type flows through without an `as never` cast.
 */
export function useSessionsFromState(
  state: SessionListState,
): SnapshotSelectorHook<SessionListState> {
  return selector => selector(state)
}

/**
 * Build a `useProjection` hook reading the test's own `SessionStatsProjection`
 * (or undefined) for `'sessionStats'`, and undefined for every other key.
 * The kit never invents projections on its own — it only forwards what
 * the caller supplies, so tests stay type-checked end to end.
 */
export function makeUseProjection(
  liveStats: SessionStatsProjection | undefined,
): UseProjection {
  const hook: UseProjection = key => {
    if (key === 'sessionStats') return liveStats
    return undefined
  }
  return hook
}
