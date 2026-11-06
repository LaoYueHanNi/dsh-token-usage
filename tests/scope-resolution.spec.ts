/**
 * The host-side scope-rule expansion: a `root` + `scope` read must resolve
 * to exactly the subtree the browser mirror used to enumerate, without ever
 * putting that id list back on the request URL.
 */
import { describe, expect, it } from 'vitest'
import { buildLineageIndex, resolveSessionScope } from '../src/stats.ts'

/** A metadata index shaped like sessions.json's entries. */
function metaOf(entries: Record<string, { parentSession?: string }>): Map<string, { parentSession?: string }> {
  return new Map(Object.entries(entries))
}

describe('resolveSessionScope', () => {
  it('expands a nested subtree root-first and groups direct children', () => {
    const meta = metaOf({
      root: {},
      a: { parentSession: 'root' },
      b: { parentSession: 'root' },
      a1: { parentSession: 'a' },
      a2: { parentSession: 'a' },
      unrelated: { parentSession: 'elsewhere' },
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
    const meta = metaOf({ root: {}, a: { parentSession: 'root' }, a1: { parentSession: 'a' } })
    expect(resolveSessionScope(meta, 'root', 'self', true)).toEqual({
      sessionIds: ['root'],
      childGroups: [{ id: 'a', sessionIds: ['a'] }],
    })
  })

  it('omits child groups when the caller does not render the subagent table', () => {
    const meta = metaOf({ root: {}, a: { parentSession: 'root' }, a1: { parentSession: 'a' } })
    const resolved = resolveSessionScope(meta, 'root', 'subtree', false)
    expect(resolved.sessionIds).toEqual(['root', 'a', 'a1'])
    expect(resolved.childGroups).toEqual([])
  })

  it('degrades an unknown root or empty metadata to the root alone', () => {
    expect(resolveSessionScope(metaOf({}), 'ghost', 'subtree', true))
      .toEqual({ sessionIds: ['ghost'], childGroups: [] })
    const meta = metaOf({ a: { parentSession: 'other' } })
    expect(resolveSessionScope(meta, 'root', 'subtree', true))
      .toEqual({ sessionIds: ['root'], childGroups: [] })
  })

  it('bounds a cyclic lineage instead of looping', () => {
    const meta = metaOf({
      root: { parentSession: 'c' },
      a: { parentSession: 'root' },
      b: { parentSession: 'a' },
      c: { parentSession: 'b' },
    })
    expect(resolveSessionScope(meta, 'root', 'subtree', true).sessionIds)
      .toEqual(['root', 'a', 'b', 'c'])
  })

  it('shares one lineage index with the session-table fold', () => {
    const meta = metaOf({ root: {}, a: { parentSession: 'root' }, a1: { parentSession: 'a' } })
    expect([...buildLineageIndex(meta)]).toEqual([['a', 'root'], ['a1', 'a']])
  })
})
