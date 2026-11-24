/**
 * The host-side scope-rule expansion: a `root` + `scope` read must resolve
 * to exactly the subtree the browser mirror used to enumerate, without ever
 * putting that id list back on the request URL.
 */
import { describe, expect, it } from 'vitest'
import { buildLineageIndex, buildSubagentRoster, lineageRootOf, resolveSessionScope } from '../src/stats.ts'
import type { SessionMetaEntry } from '../src/stats.ts'

/** A metadata index shaped like sessions.json's entries. */
function metaOf(entries: Record<string, SessionMetaEntry>): Map<string, SessionMetaEntry> {
  return new Map(Object.entries(entries))
}

describe('resolveSessionScope', () => {
  it('expands a nested subtree root-first and groups direct children', () => {
    const meta = metaOf({
      root: {},
      a: { origin: 'subagent', parentSession: 'root' },
      b: { origin: 'subagent', parentSession: 'root' },
      a1: { origin: 'subagent', parentSession: 'a' },
      a2: { origin: 'subagent', parentSession: 'a' },
      unrelated: { origin: 'subagent', parentSession: 'elsewhere' },
    })
    expect(resolveSessionScope(meta, 'root', 'subtree', true)).toEqual({
      sessionIds: ['root', 'a', 'a1', 'a2', 'b'],
      childGroups: [
        { id: 'a', sessionIds: ['a', 'a1', 'a2'] },
        { id: 'b', sessionIds: ['b'] },
      ],
    })
  })

  it('keeps self scope to the root alone but still lists direct children', () => {
    const meta = metaOf({
      root: {},
      a: { origin: 'subagent', parentSession: 'root' },
      a1: { origin: 'subagent', parentSession: 'a' },
    })
    expect(resolveSessionScope(meta, 'root', 'self', true)).toEqual({
      sessionIds: ['root'],
      childGroups: [{ id: 'a', sessionIds: ['a'] }],
    })
  })

  it('omits child groups when the caller does not render the subagent table', () => {
    const meta = metaOf({
      root: {},
      a: { origin: 'subagent', parentSession: 'root' },
      a1: { origin: 'subagent', parentSession: 'a' },
    })
    const resolved = resolveSessionScope(meta, 'root', 'subtree', false)
    expect(resolved.sessionIds).toEqual(['root', 'a', 'a1'])
    expect(resolved.childGroups).toEqual([])
  })

  it('degrades an unknown root or empty metadata to the root alone', () => {
    expect(resolveSessionScope(metaOf({}), 'ghost', 'subtree', true))
      .toEqual({ sessionIds: ['ghost'], childGroups: [] })
    const meta = metaOf({ a: { origin: 'subagent', parentSession: 'other' } })
    expect(resolveSessionScope(meta, 'root', 'subtree', true))
      .toEqual({ sessionIds: ['root'], childGroups: [] })
  })

  it('bounds a cyclic lineage instead of looping and keeps root out of child groups', () => {
    const meta = metaOf({
      root: { origin: 'subagent', parentSession: 'c' },
      a: { origin: 'subagent', parentSession: 'root' },
      b: { origin: 'subagent', parentSession: 'a' },
      c: { origin: 'subagent', parentSession: 'b' },
      sibling: { origin: 'subagent', parentSession: 'root' },
    })
    const resolved = resolveSessionScope(meta, 'root', 'subtree', true)
    expect(resolved.sessionIds).toEqual(['root', 'a', 'b', 'c', 'sibling'])
    expect(resolved.childGroups).toEqual([
      { id: 'a', sessionIds: ['a', 'b', 'c'] },
      { id: 'sibling', sessionIds: ['sibling'] },
    ])
  })

  it('excludes historical ordinary forks carrying parentSession without origin subagent', () => {
    const meta = metaOf({
      root: {},
      sub: { origin: 'subagent', parentSession: 'root' },
      legacyFork: { parentSession: 'root' },
    })
    expect([...buildLineageIndex(meta)]).toEqual([['sub', 'root']])
    expect(resolveSessionScope(meta, 'root', 'subtree', true)).toEqual({
      sessionIds: ['root', 'sub'],
      childGroups: [{ id: 'sub', sessionIds: ['sub'] }],
    })
  })

  it('shares one lineage index with the session-table fold', () => {
    const meta = metaOf({
      root: {},
      a: { origin: 'subagent', parentSession: 'root' },
      a1: { origin: 'subagent', parentSession: 'a' },
    })
    expect([...buildLineageIndex(meta)]).toEqual([['a', 'root'], ['a1', 'a']])
  })

  it('never expands the scope over an external child (no session, no usage)', () => {
    const meta = metaOf({
      root: {},
      sub: { origin: 'subagent', parentSession: 'root' },
      'ext-1': { parentSession: 'root', subagentMode: 'external', subagentName: 'codex' },
    })
    expect([...buildLineageIndex(meta)]).toEqual([['sub', 'root']])
    expect(resolveSessionScope(meta, 'root', 'subtree', true)).toEqual({
      sessionIds: ['root', 'sub'],
      childGroups: [{ id: 'sub', sessionIds: ['sub'] }],
    })
  })
})

describe('buildSubagentRoster', () => {
  it('lists every direct child in index order — local AND external — with the identity the logs stated', () => {
    const meta = metaOf({
      root: { title: 'Refactor billing', teamMode: true },
      researcher: { origin: 'subagent', parentSession: 'root', subagentName: 'researcher', subagentLabel: '调研定价', subagentMode: 'continuable' },
      'agent-1': { origin: 'subagent', parentSession: 'root', subagentName: 'agent-1', subagentLabel: '整理用例', subagentMode: 'continuable' },
      legacy: { origin: 'subagent', parentSession: 'root' },
      'codex-helper': { parentSession: 'root', subagentName: 'codex-helper', subagentLabel: '用 Codex 写脚本', subagentMode: 'external' },
      writer: { origin: 'subagent', parentSession: 'agent-1', subagentName: 'writer', title: '撰写迁移指南' },
    })
    expect(buildSubagentRoster(meta, 'root')).toEqual({
      teamMode: true,
      children: [
        { id: 'researcher', name: 'researcher', label: '调研定价', mode: 'continuable' },
        { id: 'agent-1', name: 'agent-1', label: '整理用例', mode: 'continuable' },
        // A child from before named subagents: listed, with no name to show.
        { id: 'legacy' },
        { id: 'codex-helper', name: 'codex-helper', label: '用 Codex 写脚本', mode: 'external' },
      ],
    })
  })

  it('rides the child title along and omits a mode the logs never stated', () => {
    const meta = metaOf({
      root: {},
      writer: { origin: 'subagent', parentSession: 'root', subagentName: 'writer', subagentLabel: '撰写迁移指南', title: '撰写迁移指南初稿' },
    })
    expect(buildSubagentRoster(meta, 'root').children)
      .toEqual([{ id: 'writer', name: 'writer', label: '撰写迁移指南', title: '撰写迁移指南初稿' }])
    expect(buildSubagentRoster(meta, 'root').children[0]).not.toHaveProperty('mode')
  })

  it('leaves out anything that is not a direct subagent child of the session', () => {
    const meta = metaOf({
      root: {},
      sub: { origin: 'subagent', parentSession: 'root' },
      grandchild: { origin: 'subagent', parentSession: 'sub' },
      // A historical ordinary fork merely retains parentSession.
      legacyFork: { parentSession: 'root', title: 'Forked' },
      elsewhere: { origin: 'subagent', parentSession: 'other' },
      // A catalog entry that named an unknown mode is no external child.
      'mode-unknown': { parentSession: 'root', subagentName: 'strange' },
    })
    expect(buildSubagentRoster(meta, 'root')).toEqual({ children: [{ id: 'sub' }] })
  })

  it('degrades an unknown session to an empty roster instead of erroring', () => {
    expect(buildSubagentRoster(metaOf({ root: { teamMode: true } }), 'ghost')).toEqual({ children: [] })
  })
})

describe('team mode of the lineage root', () => {
  const meta = metaOf({
    root: { teamMode: true },
    mid: { origin: 'subagent', parentSession: 'root' },
    leaf: { origin: 'subagent', parentSession: 'mid' },
  })

  it('reads the root selection for the root itself', () => {
    expect(buildSubagentRoster(meta, 'root').teamMode).toBe(true)
  })

  it('walks up to the root for a drilled subagent, however deep', () => {
    expect(buildSubagentRoster(meta, 'mid').teamMode).toBe(true)
    expect(buildSubagentRoster(meta, 'leaf').teamMode).toBe(true)
    expect(lineageRootOf(buildLineageIndex(meta), 'leaf')).toBe('root')
  })

  it('is omitted when the root log never recorded a selection', () => {
    const unrecorded = metaOf({ root: {}, sub: { origin: 'subagent', parentSession: 'root' } })
    expect(buildSubagentRoster(unrecorded, 'root')).toEqual({ children: [{ id: 'sub' }] })
    expect('teamMode' in buildSubagentRoster(unrecorded, 'sub')).toBe(false)
  })

  it('reports an explicit off selection as false', () => {
    const off = metaOf({ root: { teamMode: false }, sub: { origin: 'subagent', parentSession: 'root' } })
    expect(buildSubagentRoster(off, 'sub').teamMode).toBe(false)
  })

  it('stops at the first repeated node of a cyclic lineage instead of looping', () => {
    const cyclic = metaOf({
      a: { origin: 'subagent', parentSession: 'b', teamMode: true },
      b: { origin: 'subagent', parentSession: 'a' },
    })
    const parentOf = buildLineageIndex(cyclic)
    expect(lineageRootOf(parentOf, 'a')).toBe('b')
    expect(lineageRootOf(parentOf, 'b')).toBe('a')
    // The walk ends on a node of the cycle, never past it.
    expect(buildSubagentRoster(cyclic, 'a').teamMode).toBeUndefined()
    expect(buildSubagentRoster(cyclic, 'b').teamMode).toBe(true)
  })

  it('treats a self-referential parent as its own root', () => {
    const selfParent = metaOf({ a: { origin: 'subagent', parentSession: 'a', teamMode: false } })
    expect(lineageRootOf(buildLineageIndex(selfParent), 'a')).toBe('a')
    expect(buildSubagentRoster(selfParent, 'a').teamMode).toBe(false)
  })

  it('keeps an ordinary fork its own root: it inherits no team mode', () => {
    const forked = metaOf({
      root: { teamMode: true },
      fork: { parentSession: 'root' },
    })
    expect(lineageRootOf(buildLineageIndex(forked), 'fork')).toBe('fork')
    expect(buildSubagentRoster(forked, 'fork').teamMode).toBeUndefined()
  })

  it('ends on the last known node when the topmost ancestor is gone from the index', () => {
    const orphaned = metaOf({ leaf: { origin: 'subagent', parentSession: 'deleted-root' } })
    const parentOf = buildLineageIndex(orphaned)
    // The walk names the deleted ancestor: there is nothing above it to read.
    expect(lineageRootOf(parentOf, 'leaf')).toBe('deleted-root')
    expect(buildSubagentRoster(orphaned, 'leaf').teamMode).toBeUndefined()
  })
})
