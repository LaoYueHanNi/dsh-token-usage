/**
 * Provider-tracking tests: the sighting map's precedence (session →
 * global last) and the default-selection fallback of
 * resolveCurrentProvider.
 */
import { describe, expect, it } from 'vitest'
import { ProviderTracker, resolveCurrentProvider } from '../src/quota/provider-tracking.ts'

describe('ProviderTracker', () => {
  it('keeps the latest sighting per session', () => {
    const tracker = new ProviderTracker()
    tracker.observe('s1', 'deepseek-official', 'deepseek-chat', 1)
    tracker.observe('s1', 'zai-coding-cn', 'glm-5.2', 2)
    expect(tracker.sightingOf('s1')).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.2', at: 2 })
  })

  it('falls back to the global last sighting for unknown sessions', () => {
    const tracker = new ProviderTracker()
    tracker.observe('s1', 'zai-coding-cn', 'glm-5.2', 1)
    tracker.observe('s2', 'minimax', 'MiniMax-M2', 2)
    expect(tracker.sightingOf('s3')).toEqual({ provider: 'minimax', model: 'MiniMax-M2', at: 2 })
    expect(tracker.sightingOf(undefined)).toEqual({ provider: 'minimax', model: 'MiniMax-M2', at: 2 })
  })

  it('ignores empty session ids and providers', () => {
    const tracker = new ProviderTracker()
    tracker.observe('', 'zai-coding-cn', 'glm', 1)
    tracker.observe('s1', '', 'glm', 1)
    expect(tracker.sightingOf('s1')).toBeUndefined()
  })
})

describe('resolveCurrentProvider', () => {
  it('prefers the tracker sighting over the default selection', () => {
    const tracker = new ProviderTracker()
    tracker.observe('s1', 'zai-coding-cn', 'glm-5.2')
    expect(resolveCurrentProvider({
      tracker,
      sessionId: 's1',
      defaultProvider: () => 'deepseek-official',
    })).toBe('zai-coding-cn')
  })

  it('falls back to the default selection when no sighting exists', () => {
    const tracker = new ProviderTracker()
    expect(resolveCurrentProvider({ tracker, sessionId: 'fresh', defaultProvider: () => 'deepseek-official' }))
      .toBe('deepseek-official')
    expect(resolveCurrentProvider({ tracker, sessionId: 'fresh', defaultProvider: () => undefined }))
      .toBeUndefined()
    expect(resolveCurrentProvider({ tracker, sessionId: 'fresh' })).toBeUndefined()
  })
})
