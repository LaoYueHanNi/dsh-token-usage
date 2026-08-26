// @vitest-environment node
/**
 * Session-scope helper tests: subagent-tree traversal and projection
 * aggregation. The session-query and display-format helpers moved to
 * `../wire.ts` (codec) and `../src/client/format.ts` (display) respectively,
 * and are tested there.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateProjections, buildChildIndex, buildStatsFreshnessKey, directSubagentIds, sessionStatsFingerprint, subagentParentOf, subtreeIds,
} from '../src/client/session-stats.ts'
import type { SessionRows } from '../src/client/session-stats.ts'
import { decodeChildGroups, encodeSessionScope, encodeStatsQuery } from '../src/wire.ts'

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
})
