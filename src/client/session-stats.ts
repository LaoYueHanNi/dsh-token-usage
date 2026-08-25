/**
 * Pure session-scope helpers of the conversation view tab (browser half):
 * subagent-tree traversal over the runtime's session-list mirror
 * (parentId + origin), the whole-subtree projection aggregation for TTFT
 * and decode throughput, and the parent lookup the back control uses.
 * No runtime imports beyond types, so the view tab and its tests share one
 * implementation.
 *
 * @module token-usage/client/session-stats
 */

import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'

/** The session-summary shape this module reads (a structural slice of the
 * runtime's `SessionSummary` — parent linkage, origin, and the retained
 * host-projection values). */
export interface SessionRowLike {
  parentId?: string | undefined
  origin?: 'subagent' | undefined
  projectionValues?: Readonly<Partial<{ sessionStats?: SessionStatsProjection }>> | undefined
}

/** The session-summary map this module reads (keyed by session id). */
export type SessionRows = Readonly<Record<string, SessionRowLike>>

/** A parent → direct-subagent-children index, one O(n) build over {@link
 * SessionRows}. An absent key means "no subagent children under that id";
 * an ordinary fork does not contribute to its parent. */
export type ChildIndex = ReadonlyMap<string, readonly string[]>

/** Build a session-parent → direct-subagent-children index in one O(n) pass:
 * every session whose `origin === 'subagent'` lands in its `parentId`'s
 * bucket, in iteration order (so the result matches {@link directSubagentIds}).
 * @param rows - the retained session-summary mirror.
 * @returns the immutable child index.
 */
export function buildChildIndex(rows: SessionRows): ChildIndex {
  const index = new Map<string, string[]>()
  for (const [id, summary] of Object.entries(rows)) {
    if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
    const bucket = index.get(summary.parentId)
    if (bucket === undefined) index.set(summary.parentId, [id])
    else bucket.push(id)
  }
  return index
}

/** Look up the direct subagent children of one session. Falls back to a
 * fresh {@link buildChildIndex} when the caller has no cached index. */
export function directSubagentIds(
  rows: SessionRows,
  parentId: string,
  index?: ChildIndex,
): readonly string[] {
  if (index !== undefined) return index.get(parentId) ?? []
  return buildChildIndex(rows).get(parentId) ?? []
}

/**
 * The whole subagent subtree of one session, including the root itself,
 * using the parent → children index for an O(n) walk regardless of depth.
 * Cycles are bounded by a `seen` set (a depth-first traversal visits each
 * id once), so a self-referential or cyclic record set returns the root
 * alone. Stacks are reversed after pushing so siblings come back out in
 * insertion order, matching the runtime's lineage index.
 * @param rows - the retained session-summary mirror (unused when the
 * caller already built an index).
 * @param rootId - the scope's root session id.
 * @param index - optional precomputed index from {@link buildChildIndex}.
 * @returns the root and its subagent descendants, depth-first.
 */
export function subtreeIds(
  rows: SessionRows,
  rootId: string,
  index: ChildIndex = buildChildIndex(rows),
): string[] {
  const out: string[] = [rootId]
  if (!index.has(rootId) && rows[rootId] === undefined) return out
  const seen = new Set<string>([rootId])
  const stack: string[] = []
  const seedChildren = index.get(rootId) ?? []
  for (let i = seedChildren.length - 1; i >= 0; i -= 1) stack.push(seedChildren[i]!)
  while (stack.length > 0) {
    const current = stack.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    out.push(current)
    const children = index.get(current) ?? []
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!)
  }
  return out
}

/**
 * The immediate subagent parent of one session, when the record names one.
 * The check is on `parentId` rather than `origin` so a mirrored summary that
 * lost its origin tag still answers its lineage — the index is built once
 * per render and shared across all three helpers via {@link ChildIndex}.
 * @param rows - the retained session-summary mirror.
 * @param id - the current focus session id.
 * @returns the parent session id, or undefined when the record has no
 * parent link (a top-level session or an ordinary fork).
 */
export function subagentParentOf(rows: SessionRows, id: string): string | undefined {
  const parent = rows[id]?.parentId
  return parent === undefined || parent === id ? undefined : parent
}

/** The session-stats fold the view renders (summed wall-time buckets). */
export interface StatsAggregate {
  /** Summed first-token latency over `ttftSteps`. */
  ttftMs: number
  /** Steps carrying a recorded first token. */
  ttftSteps: number
  /** Summed decode wall time (first token → message) over decode-timed steps. */
  decodeMs: number
  /** Summed provider output tokens over the same decode-timed steps. */
  decodeTokens: number
  /** Number of scoped sessions that contributed a `sessionStats` projection
   * value; the rest had no retained projection. Lets the view distinguish
   * "scope had no recorded projections" from "scope is empty". */
  contributing: number
}

/**
 * Sum one or more `SessionStatsProjection` values over a scope. A scope with
 * no value at all yields `undefined` — the view renders an em-dash for an
 * absent capability. The `contributing` count lets the caller tell
 * "every scope session was empty" apart from "the scope itself was empty".
 * @param values - the per-session projection values (typically drawn from
 * the mirror + the live hook).
 * @returns the summed buckets plus the contributing count, or undefined
 * when no projection was present.
 */
export function aggregateProjections(
  values: Iterable<SessionStatsProjection | undefined>,
): StatsAggregate | undefined {
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  let contributing = 0
  for (const stats of values) {
    if (stats === undefined) continue
    contributing += 1
    ttftMs += stats.ttftMs
    ttftSteps += stats.ttftSteps
    decodeMs += stats.decodeMs
    decodeTokens += stats.decodeTokens
  }
  if (contributing === 0) return undefined
  return { ttftMs, ttftSteps, decodeMs, decodeTokens, contributing }
}
