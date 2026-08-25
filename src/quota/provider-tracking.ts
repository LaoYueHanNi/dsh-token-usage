/**
 * Live provider tracking (node half): which LLM provider route the active
 * session is using, fed from the session events the host already emits.
 * `request/context` arrives when a request dispatches (provider known
 * before the first token); `assistant/message` re-confirms it from the
 * message provenance. The map is deliberately in-memory: quota is about
 * the provider in use NOW, and a restart re-seeds from the next event or
 * the default-model selection.
 *
 * @module token-usage/quota/provider-tracking
 */

/** One observed provider use of a session. */
export interface ProviderSighting {
  /** Provider route key (`zai-coding-cn`, `deepseek-official`, …). */
  provider: string
  /** Model id the request used. */
  model: string
  /** When the sighting happened, epoch ms. */
  at: number
}

/** In-memory session → latest sighting map with a global fallback. */
export class ProviderTracker {
  readonly #bySession = new Map<string, ProviderSighting>()
  #last: ProviderSighting | undefined

  /** Record that a session used a provider (later sightings win). */
  observe(sessionId: string, provider: string, model: string, at: number = Date.now()): void {
    if (sessionId === '' || provider === '') return
    const sighting: ProviderSighting = { provider, model, at }
    this.#bySession.set(sessionId, sighting)
    this.#last = sighting
  }

  /** The session's latest sighting, else the most recent sighting of any
   * session (a brand-new session inherits the last provider in use — the
   * shell's own default-then-remembered behavior). */
  sightingOf(sessionId: string | undefined): ProviderSighting | undefined {
    if (sessionId !== undefined && sessionId !== '') {
      const scoped = this.#bySession.get(sessionId)
      if (scoped !== undefined) return scoped
    }
    return this.#last
  }
}

/**
 * Resolve the provider route a quota query should target: the tracker's
 * sighting first (the active session's or the global last), else the
 * host's default model selection (the `agent-default-model` settings
 * section — what a brand-new, never-requesting session would use).
 * @param input - the tracker, the asking session, and a thunk reading the
 * default selection's `provider` (undefined when no default is stored).
 * @returns the route key, or undefined when nothing determinable exists.
 */
export function resolveCurrentProvider(input: {
  tracker: ProviderTracker
  sessionId?: string
  defaultProvider?: () => string | undefined
}): string | undefined {
  const sighting = input.tracker.sightingOf(input.sessionId)
  if (sighting !== undefined) return sighting.provider
  const fallback = input.defaultProvider?.()
  return fallback !== undefined && fallback !== '' ? fallback : undefined
}
