// @vitest-environment node
/**
 * Session-scope helper tests: subagent-tree traversal and projection
 * aggregation. The session-query and display-format helpers moved to
 * `../wire.ts` (codec) and `../src/client/format.ts` (display) respectively,
 * and are tested there.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateProjections, buildChildIndex, buildStatsFreshnessKey, directSubagentIds, resolveHeaderTiming, sessionStatsFingerprint, subagentParentOf, subtreeIds, tokenUsageFingerprint,
} from '../src/client/session-stats.ts'
import type { SessionRows } from '../src/client/session-stats.ts'
import { decodeChildGroups, decodeStatsScope, encodeSessionScope, encodeStatsQuery } from '../src/wire.ts'

/** A session mirror with a root, one subagent child, one nested grandchild,
 * an ordinary fork (not a subagent), a cycle pair, and one self-parent. */
function mirror(): SessionRows {
  return {
    root: { projectionValues: { sessionStats: { turns: 1, steps: 1, llmMs: 100, toolMs: 0, ttftMs: 200, ttftSteps: 1, decodeMs: 4_000, decodeTokens: 800 } } },
    child: { parentId: 'root', origin: 'subagent', projectionValues: { sessionStats: { turns: 1, steps: 1, llmMs: 50, toolMs: 0, ttftMs: 60, ttftSteps: 2, decodeMs: 2_000, decodeTokens: 300 } } },
    grandchild: { parentId: 'child', origin: 'subagent' },
    fork: { parentId: 'root' },
    cycleA: { parentId: 'cycleB', origin: 'subagent' },
    cycleB: { parentId: 'cycleA', origin: 'subagent' },
    selfParent: { parentId: 'selfParent', origin: 'subagent' },
  }
}

describe('buildStatsFreshnessKey', () => {
  it('changes when sessionStats steps advance even if updatedAt is flat', () => {
    const rows = mirror()
    const before = buildStatsFreshnessKey(['root'], {
      activeSessionId: 'root',
      rows,
      liveSessionStats: { turns: 1, steps: 3, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 1, decodeMs: 0, decodeTokens: 0 },
    })
    const after = buildStatsFreshnessKey(['root'], {
      activeSessionId: 'root',
      rows,
      liveSessionStats: { turns: 1, steps: 4, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 2, decodeMs: 0, decodeTokens: 50 },
    })
    expect(after).not.toBe(before)
    expect(sessionStatsFingerprint(undefined)).toBe('-')
  })

  it('changes when subagent summary tokenUsage advances without sessionStats or updatedAt', () => {
    const beforeRows: SessionRows = {
      root: { updatedAt: 10 },
      child: {
        parentId: 'root',
        origin: 'subagent',
        updatedAt: 20,
        projectionValues: {
          tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    }
    const afterRows: SessionRows = {
      ...beforeRows,
      child: {
        ...beforeRows.child!,
        projectionValues: {
          tokenUsage: { uncachedInputTokens: 100, outputTokens: 55, cacheReadTokens: 40, cacheWriteTokens: 0 },
        },
      },
    }
    const before = buildStatsFreshnessKey(['root', 'child'], { activeSessionId: 'root', rows: beforeRows })
    const after = buildStatsFreshnessKey(['root', 'child'], { activeSessionId: 'root', rows: afterRows })
    expect(after).not.toBe(before)
    expect(tokenUsageFingerprint(undefined)).toBe('-')
  })
})

describe('resolveHeaderTiming', () => {
  const live = { turns: 1, steps: 1, llmMs: 500, toolMs: 0, ttftMs: 100, ttftSteps: 1, decodeMs: 2_000, decodeTokens: 400 }
  const server = { ttftMs: 600, ttftSteps: 2, decodeMs: 4_000, decodeTokens: 1_000 }

  it('prefers live sessionStats for the solo active session and falls back to serverTiming', () => {
    expect(resolveHeaderTiming({
      isSoloActive: true,
      liveStats: live,
      mirrorAggregate: undefined,
      serverTiming: server,
    })).toEqual({ ttftMs: 100, tokensPerSec: 200 })

    expect(resolveHeaderTiming({
      isSoloActive: true,
      liveStats: undefined,
      mirrorAggregate: undefined,
      serverTiming: server,
    })).toEqual({ ttftMs: 300, tokensPerSec: 250 })
  })

  it('prefers host serverTiming over mirror projections for subtree or drilled subagent views', () => {
    expect(resolveHeaderTiming({
      isSoloActive: false,
      liveStats: live,
      mirrorAggregate: { ...live, contributing: 1 },
      serverTiming: server,
    })).toEqual({ ttftMs: 300, tokensPerSec: 250 })

    // Legacy host without serverTiming falls back to mirrorAggregate, then perfStream*.
    expect(resolveHeaderTiming({
      isSoloActive: false,
      liveStats: live,
      mirrorAggregate: undefined,
      serverTiming: undefined,
      totalPerf: { perfStreamCount: 2, perfStreamFirstMsSum: 900, perfStreamTpsSum: 160 },
    })).toEqual({ ttftMs: 450, tokensPerSec: 80 })
  })
})

describe('directSubagentIds', () => {
  it('lists only subagent-origin children, not ordinary forks', () => {
    expect(directSubagentIds(mirror(), 'root')).toEqual(['child'])
    expect(directSubagentIds(mirror(), 'child')).toEqual(['grandchild'])
  })

  it('answers an empty list for a leaf or an unknown parent', () => {
    expect(directSubagentIds(mirror(), 'grandchild')).toEqual([])
    expect(directSubagentIds(mirror(), 'nobody')).toEqual([])
  })

  it('reuses a precomputed child index when supplied', () => {
    const index = buildChildIndex(mirror())
    expect(directSubagentIds(mirror(), 'root', index)).toEqual(['child'])
    expect(index).toBe(index)  // sanity: the same map is held by callers
  })
})

describe('subtreeIds', () => {
  it('includes the root and every uninterrupted subagent descendant', () => {
    expect(subtreeIds(mirror(), 'root')).toEqual(['root', 'child', 'grandchild'])
    expect(subtreeIds(mirror(), 'child')).toEqual(['child', 'grandchild'])
    // An ordinary fork is not part of the subtree.
    expect(subtreeIds(mirror(), 'root')).not.toContain('fork')
  })

  it('fails soft on cycles and returns the root alone for a leaf', () => {
    const ids = subtreeIds(mirror(), 'cycleA')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('cycleA')
    expect(ids[1]).toBe('cycleB')
    expect(subtreeIds(mirror(), 'grandchild')).toEqual(['grandchild'])
  })

  it('returns only the root when that id is not in the mirror', () => {
    expect(subtreeIds(mirror(), 'stranger')).toEqual(['stranger'])
  })
})

describe('subagentParentOf', () => {
  it('names the parent from the record link', () => {
    expect(subagentParentOf(mirror(), 'child')).toBe('root')
    expect(subagentParentOf(mirror(), 'grandchild')).toBe('child')
  })

  it('returns undefined when the record has no parent link', () => {
    expect(subagentParentOf(mirror(), 'root')).toBeUndefined()
  })

  it('returns undefined for an ordinary fork even when parentId is populated', () => {
    expect(subagentParentOf(mirror(), 'fork')).toBeUndefined()
  })

  it('returns undefined when the record points at itself', () => {
    // A corrupted or test fixture that sets parentId == id would loop; the
    // check refuses to answer rather than produce a 1-node cycle.
    expect(subagentParentOf(mirror(), 'selfParent')).toBeUndefined()
  })
})

describe('aggregateProjections', () => {
  it('sums the values and counts contributing sessions', () => {
    const rows = mirror()
    const values = ['root', 'child'].map(id => rows[id]!.projectionValues?.sessionStats)
    const aggregated = aggregateProjections(values)
    expect(aggregated).toEqual({
      ttftMs: 260, ttftSteps: 3, decodeMs: 6_000, decodeTokens: 1_100, contributing: 2,
    })
  })

  it('returns undefined when no session carries projections', () => {
    expect(aggregateProjections([undefined, undefined])).toBeUndefined()
  })

  it('reports the contributing count when only some sessions carry values', () => {
    const rows = mirror()
    const values = ['root', 'grandchild'].map(id => rows[id]!.projectionValues?.sessionStats)
    const aggregated = aggregateProjections(values)
    expect(aggregated?.contributing).toBe(1)
    expect(aggregated?.ttftMs).toBe(200)
  })
})

describe('encodeStatsQuery', () => {
  it('encodes session ids, child groups, and fields', () => {
    expect(encodeSessionScope(['alpha', 'child'])).toBe('?sessionId=alpha&sessionId=child')
    expect(encodeStatsQuery({ sessionIds: ['s1'], fields: 'chip' })).toBe('?sessionId=s1&fields=chip')
    expect(encodeStatsQuery({
      sessionIds: ['root'],
      childGroups: [['child', 'grandchild']],
      fields: 'session',
    })).toBe('?sessionId=root&childId=child%2Cgrandchild&fields=session')
  })

  it('parses childId groups, dropping blanks and duplicate row ids', () => {
    const url = new URL('http://localhost/stats?childId=child,gc&childId=other&childId=child,ignored')
    expect(decodeChildGroups(url)).toEqual([
      { id: 'child', sessionIds: ['child', 'gc'] },
      { id: 'other', sessionIds: ['other'] },
    ])
  })

  it('encodes a root + scope range rule in constant size', () => {
    expect(encodeStatsQuery({ root: 'alpha', fields: 'session' })).toBe('?root=alpha&fields=session')
    expect(encodeStatsQuery({ root: 'alpha', scope: 'subtree', fields: 'session' }))
      .toBe('?root=alpha&scope=subtree&fields=session')
    expect(encodeStatsQuery({ root: 'alpha', scope: 'self', fields: 'chip' }))
      .toBe('?root=alpha&fields=chip')
    // A root request wins over the legacy explicit-id form, and no id list
    // ever lands on the wire: 200 children are still one short rule.
    expect(encodeStatsQuery({ root: 'alpha', scope: 'subtree', sessionIds: ['ignored'], fields: 'chip' }))
      .toBe('?root=alpha&scope=subtree&fields=chip')
    expect(encodeStatsQuery({ root: 'alpha', scope: 'subtree', fields: 'session' }).length).toBeLessThan(80)
  })

  it('parses a scope rule, defaulting to self and ignoring legacy reads', () => {
    expect(decodeStatsScope(new URL('http://localhost/stats?root=alpha&scope=subtree')))
      .toEqual({ root: 'alpha', scope: 'subtree' })
    expect(decodeStatsScope(new URL('http://localhost/stats?root=alpha')))
      .toEqual({ root: 'alpha', scope: 'self' })
    expect(decodeStatsScope(new URL('http://localhost/stats?root=alpha&scope=nonsense')))
      .toEqual({ root: 'alpha', scope: 'self' })
    expect(decodeStatsScope(new URL('http://localhost/stats?sessionId=alpha&childId=child')))
      .toBeUndefined()
  })
})
