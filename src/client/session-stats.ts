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
import type { ChildTiming, SubagentMode, SubagentRoster, UsageTotals } from '../wire.ts'

/** Structural mirror of DSH `TokenUsageProjection` (retained on `session.list`
 * summary rows in DSH 0.2.2+, unlike the summary-excluded `sessionStats`). */
export interface TokenUsageProjectionLike {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The session-summary shape this module reads (a structural slice of the
 * runtime's `SessionSummary` — parent linkage, origin, and the retained
 * host-projection values). */
export interface SessionRowLike {
  parentId?: string | undefined
  origin?: 'subagent' | undefined
  updatedAt?: number | undefined
  /** The mirror's retained `title` projection, when the session has one. */
  title?: string | undefined
  /** The host's `displayTitle` fallback chain: `title ?? label ?? id`. */
  displayTitle?: string | undefined
  projectionValues?: Readonly<Partial<{
    sessionStats?: SessionStatsProjection | undefined
    tokenUsage?: TokenUsageProjectionLike | undefined
  }>> | undefined
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
 * The immediate subagent parent of one session, when the record is tagged
 * `origin === 'subagent'` and names a parent. Ordinary forks — including
 * historical forks that retained `parentId` without `origin: 'subagent'` —
 * answer `undefined`, matching {@link buildChildIndex}.
 * @param rows - the retained session-summary mirror.
 * @param id - the current focus session id.
 * @returns the parent session id, or undefined when the record is not a
 * subagent child.
 */
export function subagentParentOf(rows: SessionRows, id: string): string | undefined {
  const row = rows[id]
  if (row?.origin !== 'subagent') return undefined
  const parent = row.parentId
  return parent === undefined || parent === id ? undefined : parent
}

/** One row of the usage tab's subagent table. */
export interface SubagentRow {
  /** A local session id, or the provider-assigned id of an external child. */
  id: string
  /** The semantic name the parent's catalog gave the child — the row's
   * name badge. Absent for children created before named subagents. */
  name?: string
  /** The delegation label: the short description it was created with. */
  label?: string
  /** The child's latest `session/title` text, when the logs carried one. */
  title?: string
  /** The lifecycle mode the logs stated; read by the row's hover only. */
  mode?: SubagentMode
  /** An external child runs elsewhere: it is listed, dimmed, and never
   * drilled into, and it holds no usage. */
  external: boolean
}

/**
 * Merge the two sources the subagent table reads: the session mirror, which
 * lists the LOCAL children (and is what makes them drillable), and the
 * host's identity roster, which carries each child's name / label and is
 * the only place an external child appears at all (the mirror skips those).
 *
 * Local rows keep the mirror's order; external rows follow them, in roster
 * order. A roster entry that is neither external nor in the mirror is not a
 * row: a local child the mirror no longer lists (archived, deleted) was
 * never listed here, and a row without a mirror entry could not be drilled
 * into or navigated back from.
 */
export function buildSubagentRows(
  localIds: readonly string[],
  rows: SessionRows,
  roster: SubagentRoster | undefined,
): SubagentRow[] {
  const byId = new Map((roster?.children ?? []).map(child => [child.id, child]))
  const out: SubagentRow[] = []
  for (const id of localIds) {
    const identity = byId.get(id)
    const title = rows[id]?.title ?? identity?.title
    out.push({
      id,
      ...(identity?.name !== undefined ? { name: identity.name } : {}),
      ...(identity?.label !== undefined ? { label: identity.label } : {}),
      ...(identity?.mode !== undefined ? { mode: identity.mode } : {}),
      ...(title !== undefined ? { title } : {}),
      external: false,
    })
  }
  const local = new Set(localIds)
  for (const child of roster?.children ?? []) {
    if (child.mode !== 'external' || local.has(child.id)) continue
    out.push({
      id: child.id,
      ...(child.name !== undefined ? { name: child.name } : {}),
      ...(child.label !== undefined ? { label: child.label } : {}),
      ...(child.mode !== undefined ? { mode: child.mode } : {}),
      ...(child.title !== undefined ? { title: child.title } : {}),
      external: true,
    })
  }
  return out
}

/**
 * Resolve a subagent row's description text, delegation label first
 * (`label ?? title ?? name ?? id`). Pre-0.2.2-rc.3 subagent logs often hold
 * a fallback `session/title` truncated from the opening of the task prompt,
 * which obscures the concise delegation label written by the parent;
 * preferring the label avoids showing half a prompt when a label exists,
 * falling back to the mirror/index title, then the semantic name, and
 * finally the bare id.
 */
export function subagentRowText(row: SubagentRow, mirror: SessionRowLike | undefined): string {
  if (row.label !== undefined) return row.label
  if (mirror?.displayTitle !== undefined && mirror.displayTitle !== row.id) return mirror.displayTitle
  return mirror?.title ?? row.title ?? row.name ?? row.id
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

/**
 * Compact fingerprint of one session's retained stats projection — bumps on
 * every finished request step (same signal that drives TTFT / throughput).
 */
export function sessionStatsFingerprint(stats: SessionStatsProjection | undefined): string {
  if (stats === undefined) return '-'
  return [
    stats.steps,
    stats.ttftSteps,
    stats.decodeTokens,
    stats.turns,
  ].join('.')
}

/**
 * Compact fingerprint of one session's summary `tokenUsage` projection —
 * retained on `session.list` rows in DSH 0.2.2+ after `sessionStats` was
 * excluded from summaries, so subagent token progress still bumps freshness.
 */
export function tokenUsageFingerprint(usage: TokenUsageProjectionLike | undefined): string {
  if (usage === undefined) return '-'
  return [
    usage.uncachedInputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].join('.')
}

/**
 * Build a debounce key from mirror `updatedAt`, summary `tokenUsage` churn
 * (for subagents in DSH 0.2.2+), and `sessionStats` churn (active session and
 * legacy hosts).
 */
export function buildStatsFreshnessKey(
  ids: readonly string[],
  options: {
    activeSessionId: string
    rows: SessionRows
    liveSessionStats?: SessionStatsProjection | undefined
    liveTokenUsage?: TokenUsageProjectionLike | undefined
  },
): string {
  return ids.map(id => {
    const row = options.rows[id]
    const tokenUsage = id === options.activeSessionId
      ? options.liveTokenUsage ?? row?.projectionValues?.tokenUsage
      : row?.projectionValues?.tokenUsage
    const stats = id === options.activeSessionId
      ? options.liveSessionStats ?? row?.projectionValues?.sessionStats
      : row?.projectionValues?.sessionStats
    return `${id}:${String(row?.updatedAt ?? 0)}:${tokenUsageFingerprint(tokenUsage)}:${sessionStatsFingerprint(stats)}`
  }).join(',')
}

/** Aggregate retained `sessionStats` projections across `ids`, preferring the
 * live hook for `activeSessionId` and reading mirror rows for legacy hosts. */
export function aggregateScopedProjections(
  ids: readonly string[],
  rows: SessionRows,
  activeSessionId: string,
  liveSessionStats: SessionStatsProjection | undefined,
): StatsAggregate | undefined {
  return aggregateProjections(ids.map((id) => {
    if (id === activeSessionId) return liveSessionStats ?? rows[id]?.projectionValues?.sessionStats
    return rows[id]?.projectionValues?.sessionStats
  }))
}

/** Resolved header TTFT (ms) and decode throughput (tokens/s). */
export interface HeaderTiming {
  ttftMs?: number
  tokensPerSec?: number
}

function timingFromBuckets(bucket: Pick<ChildTiming, 'ttftMs' | 'ttftSteps' | 'decodeMs' | 'decodeTokens'> | undefined): HeaderTiming {
  if (bucket === undefined) return {}
  return {
    ...(bucket.ttftSteps > 0 ? { ttftMs: bucket.ttftMs / bucket.ttftSteps } : {}),
    ...(bucket.decodeMs > 0 ? { tokensPerSec: bucket.decodeTokens / (bucket.decodeMs / 1_000) } : {}),
  }
}

function timingFromPerfTotals(
  totals: Pick<UsageTotals, 'perfStreamCount' | 'perfStreamFirstMsSum' | 'perfStreamTpsSum'> | undefined,
): HeaderTiming {
  const samples = totals?.perfStreamCount ?? 0
  if (samples <= 0) return {}
  return {
    ...(totals?.perfStreamFirstMsSum !== undefined ? { ttftMs: totals.perfStreamFirstMsSum / samples } : {}),
    ...(totals?.perfStreamTpsSum !== undefined ? { tokensPerSec: totals.perfStreamTpsSum / samples } : {}),
  }
}

/**
 * Resolve header TTFT and decode throughput while keeping DSH's weighted
 * projection formula (`ttftMs / ttftSteps`, `decodeTokens / (decodeMs / 1_000)`):
 * - Solo active session: prefer live `sessionStats` projection (covers
 *   unlogged pre-install history and per-step retries), then host `summary.timing`.
 * - Subtree or drilled subagent: prefer host-aggregated `summary.timing` (which
 *   covers finished subagents even when `sessionStats` is excluded from
 *   summaries in DSH 0.2.2+), then legacy mirror projections, then `perfStream*`
 *   on `history-incomplete` rollup fallbacks.
 */
export function resolveHeaderTiming(input: {
  isSoloActive: boolean
  liveStats: SessionStatsProjection | undefined
  mirrorAggregate: StatsAggregate | undefined
  serverTiming: ChildTiming | undefined
  totalPerf?: Pick<UsageTotals, 'perfStreamCount' | 'perfStreamFirstMsSum' | 'perfStreamTpsSum'> | undefined
}): HeaderTiming {
  const candidates = input.isSoloActive
    ? [
        timingFromBuckets(input.liveStats),
        timingFromBuckets(input.serverTiming),
        timingFromBuckets(input.mirrorAggregate),
        timingFromPerfTotals(input.totalPerf),
      ]
    : [
        timingFromBuckets(input.serverTiming),
        timingFromBuckets(input.mirrorAggregate),
        timingFromPerfTotals(input.totalPerf),
      ]
  for (const candidate of candidates) {
    if (candidate.ttftMs !== undefined || candidate.tokensPerSec !== undefined) {
      return candidate
    }
  }
  return {}
}
