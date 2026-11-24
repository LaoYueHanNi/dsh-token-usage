// @vitest-environment node
/**
 * Session-scope helper tests: subagent-tree traversal and projection
 * aggregation. The session-query and display-format helpers moved to
 * `../wire.ts` (codec) and `../src/client/format.ts` (display) respectively,
 * and are tested there.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateProjections, buildChildIndex, buildStatsFreshnessKey, buildSubagentRows, directSubagentIds, resolveHeaderTiming, sessionStatsFingerprint, subagentParentOf, subagentRowText, subtreeIds, tokenUsageFingerprint,
} from '../src/client/session-stats.ts'
import type { SessionRows } from '../src/client/session-stats.ts'
import type { SubagentRoster } from '../src/wire.ts'
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

  it('never mixes TTFT from one source with throughput from a fallback source', () => {
    const ttftOnlyLive = { turns: 1, steps: 1, llmMs: 200, toolMs: 0, ttftMs: 120, ttftSteps: 1, decodeMs: 0, decodeTokens: 0 }
    expect(resolveHeaderTiming({
      isSoloActive: true,
      liveStats: ttftOnlyLive,
      mirrorAggregate: undefined,
      serverTiming: server,
    })).toEqual({ ttftMs: 120 })
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

/** The mirror rows of a root with two local children, in mirror order. */
const IDENTITY_MIRROR: SessionRows = {
  root: { displayTitle: 'Refactor billing' },
  researcher: { parentId: 'root', origin: 'subagent', displayTitle: '调研竞品定价策略' },
  writer: { parentId: 'root', origin: 'subagent', displayTitle: '撰写迁移指南', title: '撰写迁移指南' },
  legacy: { parentId: 'root', origin: 'subagent', displayTitle: 'legacy' },
}

describe('buildSubagentRows', () => {
  const roster: SubagentRoster = {
    teamMode: true,
    children: [
      { id: 'researcher', name: 'researcher', label: '调研竞品定价策略', mode: 'continuable' },
      { id: 'writer', name: 'writer', label: '撰写迁移指南初稿', mode: 'continuable', title: '撰写迁移指南' },
      // Created before named subagents: identity without a name.
      { id: 'legacy', label: '旧任务', mode: 'one-shot', title: 'Legacy child' },
      { id: 'codex-helper', name: 'codex-helper', label: '用 Codex 写迁移脚本', mode: 'external' },
    ],
  }

  it('keeps the mirror order of local rows, merges the roster identity in, and appends the external ones', () => {
    const rows = buildSubagentRows(['researcher', 'writer', 'legacy'], IDENTITY_MIRROR, roster)
    expect(rows).toEqual([
      { id: 'researcher', name: 'researcher', label: '调研竞品定价策略', mode: 'continuable', external: false },
      // The mirror's own title outranks the index's for the same session.
      { id: 'writer', name: 'writer', label: '撰写迁移指南初稿', mode: 'continuable', title: '撰写迁移指南', external: false },
      { id: 'legacy', label: '旧任务', mode: 'one-shot', title: 'Legacy child', external: false },
      { id: 'codex-helper', name: 'codex-helper', label: '用 Codex 写迁移脚本', mode: 'external', external: true },
    ])
  })

  it('appends external children after the local rows, in roster order', () => {
    const rows = buildSubagentRows(['researcher'], IDENTITY_MIRROR, roster)
    expect(rows.slice(1)).toEqual([
      { id: 'codex-helper', name: 'codex-helper', label: '用 Codex 写迁移脚本', mode: 'external', external: true },
    ])
  })

  it('lists an external child even when the mirror has no local row at all', () => {
    expect(buildSubagentRows([], {}, roster)).toEqual([
      { id: 'codex-helper', name: 'codex-helper', label: '用 Codex 写迁移脚本', mode: 'external', external: true },
    ])
  })

  it('drops a roster entry that is neither in the mirror nor external', () => {
    // A local child the mirror stopped listing (archived, deleted) was
    // never a row here; it still must not become an undrillable one.
    const rows = buildSubagentRows(['researcher'], IDENTITY_MIRROR, roster)
    expect(rows.map(row => row.id)).toEqual(['researcher', 'codex-helper'])
  })

  it('never duplicates a child the mirror lists under an external entry', () => {
    const odd: SubagentRoster = { children: [{ id: 'researcher', name: 'twice', mode: 'external' }] }
    expect(buildSubagentRows(['researcher'], IDENTITY_MIRROR, odd).map(row => row.id)).toEqual(['researcher'])
  })

  it('draws local rows from the mirror alone on an older host (no roster)', () => {
    expect(buildSubagentRows(['researcher', 'legacy'], IDENTITY_MIRROR, undefined)).toEqual([
      { id: 'researcher', external: false },
      { id: 'legacy', external: false },
    ])
    expect(buildSubagentRows(['legacy'], IDENTITY_MIRROR, { children: [] })).toEqual([{ id: 'legacy', external: false }])
  })
})

describe('subagentRowText', () => {
  const rowText = (id: string, row: Parameters<typeof subagentRowText>[0], mirror = IDENTITY_MIRROR[id]) => subagentRowText(row, mirror)

  it('prefers the delegation label even when a title is present', () => {
    expect(rowText('writer', {
      id: 'writer', name: 'writer', label: '撰写迁移指南初稿', title: '撰写迁移指南', external: false,
    })).toBe('撰写迁移指南初稿')
  })

  it('shows the delegation label when there is no title', () => {
    expect(rowText('researcher', {
      id: 'researcher', name: 'researcher', label: '调研竞品定价策略', mode: 'continuable', external: false,
    })).toBe('调研竞品定价策略')
  })

  it('falls back to the mirror displayTitle when no delegation label is recorded', () => {
    const renamed = { parentId: 'root', origin: 'subagent' as const, displayTitle: '手动重命名标题', title: '手动重命名标题' }
    expect(rowText('writer', {
      id: 'writer', name: 'writer', title: '旧索引标题', external: false,
    }, renamed)).toBe('手动重命名标题')
  })

  it('falls back to the index title when the mirror only echoes the id and no label exists', () => {
    const stale = { parentId: 'root', origin: 'subagent' as const, displayTitle: 'legacy' }
    expect(rowText('legacy', { id: 'legacy', title: 'Legacy child', external: false }, stale))
      .toBe('Legacy child')
  })

  it('falls back to the semantic name, then bare id when neither label nor title exists', () => {
    expect(subagentRowText({ id: 'sess-poet', name: 'poet', external: false }, {
      parentId: 'root', origin: 'subagent', displayTitle: 'sess-poet',
    })).toBe('poet')
    expect(rowText('legacy', { id: 'legacy', external: false })).toBe('legacy')
  })

  it('reads an external row off the roster alone: it has no mirror row', () => {
    expect(subagentRowText(
      { id: 'codex-helper', name: 'codex-helper', label: '用 Codex 写迁移脚本', mode: 'external', external: true },
      undefined,
    )).toBe('用 Codex 写迁移脚本')
    expect(subagentRowText(
      { id: 'ext-1', name: 'codex-helper', mode: 'external', external: true },
      undefined,
    )).toBe('codex-helper')
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
