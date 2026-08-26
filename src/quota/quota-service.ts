/**
 * Quota orchestration service (node half): resolve the current provider,
 * route it through the adapter registry, resolve credentials, and serve
 * normalized {@link QuotaPayload}s with a per-provider TTL cache and
 * in-flight dedupe so N open sessions polling never hammer a provider's
 * quota endpoint.
 *
 * Cache policy: ok results cache per provider for `cacheTtlMs` (default
 * 45s — under the client's poll cadence, so a poll usually hits memory).
 * Error results do not cache, so the panel's retry / open-to-refresh
 * actually re-queries; in-flight callers still collapse into one outbound
 * request. `no-provider` / `unsupported` resolutions are pure settings
 * reads and never cache. A provider CHANGE invalidates by key (cache is
 * keyed by route), so switching providers serves fresh at once.
 *
 * @module token-usage/quota/quota-service
 */

import type { QuotaFailure, QuotaPayload, QuotaSnapshot } from '../wire.ts'
import { resolveQuotaAdapter } from './registry.ts'
import type { QuotaAdapter } from './types.ts'
import { QuotaQueryError } from './types.ts'
import { withCatalogBaseUrl, type ResolvedQuotaCredentials } from './credentials.ts'

/** Default cache lifetime of one provider's ok result. */
const DEFAULT_CACHE_TTL_MS = 45_000
/** Per-query deadline: quota endpoints are small; anything slower is dead. */
const QUERY_TIMEOUT_MS = 10_000

/** The seams the service runs over (index.ts wires the host services in). */
export interface QuotaServiceDeps {
  /** Route key of the provider the asking session uses, if determinable. */
  resolveProvider: (sessionId: string | undefined) => string | undefined
  /** Credential chain seam; see credentials.ts. */
  resolveCredentials: (provider: string) => Promise<ResolvedQuotaCredentials>
  /** Transport (global fetch in production, a stub in tests). */
  fetchFn?: typeof fetch
  /** The poll cadence stamped on every payload (seconds). */
  intervalSec?: number
  /** Ok-result cache lifetime; tests shrink it. Errors never cache. */
  cacheTtlMs?: number
  /** Clock seam; tests freeze it. */
  now?: () => number
}

/** One cached provider ok result. */
interface CacheEntry {
  at: number
  payload: QuotaSnapshot
}

/** Map any thrown adapter failure onto the wire's error vocabulary. */
function toQuotaFailure(
  provider: string,
  providerName: string | undefined,
  adapter: QuotaAdapter,
  error: unknown,
  intervalSec: number,
  now: number,
): QuotaFailure {
  const normalized = error instanceof QuotaQueryError
    ? { kind: error.kind, message: error.message }
    : { kind: 'parse' as const, message: error instanceof Error ? error.message : String(error) }
  return {
    status: 'error',
    provider,
    ...(providerName !== undefined ? { providerName } : {}),
    adapterId: adapter.id,
    fetchedAt: now,
    intervalSec,
    error: normalized,
  }
}

/**
 * The display name for a resolved adapter: the route's own name when the
 * route key is one of the adapter's catalog routes; a host-matched custom
 * route keeps its user-chosen alias but qualified by the adapter's family
 * label — the quota belongs to the family, and an alias like "OpenAI"
 * must not claim OpenCode Go windows as its own.
 */
function displayNameOf(
  provider: string,
  credentials: ResolvedQuotaCredentials,
  adapter: QuotaAdapter,
): string | undefined {
  if (adapter.routes === undefined || adapter.routes.includes(provider)) return credentials.displayName
  return `${credentials.displayName ?? provider} · ${adapter.label}`
}

/** The quota orchestration service. */
export class QuotaService {
  readonly #deps: QuotaServiceDeps
  readonly #cache = new Map<string, CacheEntry>()
  readonly #inflight = new Map<string, Promise<QuotaSnapshot | QuotaFailure>>()

  constructor(deps: QuotaServiceDeps) {
    this.#deps = deps
  }

  /** The poll cadence every payload carries. */
  get intervalSec(): number {
    return this.#deps.intervalSec ?? 60
  }

  /**
   * The payload for one asking session: hidden variants short-circuit
   * without any network; a supported provider serves its cached window
   * set or queries it (deduped per provider while in flight).
   * @param sessionId - the asking conversation session ('' / undefined
   * when the caller has no session context).
   * @param providerHint - the provider the session's model chip currently
   * selects (the host-reported NEXT selection), when the browser could read
   * one. It wins over the request tracker: the chip is the user's live
   * intent, and the next `request/context` event makes the tracker agree.
   */
  async snapshot(sessionId?: string, providerHint?: string): Promise<QuotaPayload> {
    const provider = providerHint !== undefined && providerHint !== ''
      ? providerHint
      : this.#deps.resolveProvider(sessionId)
    if (provider === undefined) {
      return { status: 'no-provider', intervalSec: this.intervalSec }
    }
    const credentials = withCatalogBaseUrl(provider, await this.#deps.resolveCredentials(provider))
    const adapter = resolveQuotaAdapter({
      provider,
      ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
    })
    if (adapter === undefined) {
      return {
        status: 'unsupported',
        provider,
        ...(credentials.displayName !== undefined ? { providerName: credentials.displayName } : {}),
        intervalSec: this.intervalSec,
      }
    }
    const providerName = displayNameOf(provider, credentials, adapter)
    if (credentials.apiKey === undefined) {
      return {
        status: 'error',
        provider,
        ...(providerName !== undefined ? { providerName } : {}),
        adapterId: adapter.id,
        fetchedAt: this.#now(),
        intervalSec: this.intervalSec,
        error: {
          kind: 'no-credential',
          message: credentials.apiKeyEnv ?? provider,
        },
      }
    }

    const cached = this.#cached(provider)
    if (cached !== undefined) return cached
    const running = this.#inflight.get(provider)
    if (running !== undefined) return running

    const query = this.#query(provider, providerName, credentials, adapter)
    this.#inflight.set(provider, query)
    try {
      return await query
    } finally {
      this.#inflight.delete(provider)
    }
  }

  /** The fresh-or-cached ok result, or a live error, of one provider query. */
  async #query(
    provider: string,
    providerName: string | undefined,
    credentials: ResolvedQuotaCredentials,
    adapter: QuotaAdapter,
  ): Promise<QuotaSnapshot | QuotaFailure> {
    try {
      const result = await adapter.query({
        provider,
        ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
        apiKey: credentials.apiKey ?? '',
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        ...(this.#deps.fetchFn !== undefined ? { fetchFn: this.#deps.fetchFn } : { fetchFn: globalThis.fetch }),
      })
      const payload: QuotaSnapshot = {
        status: 'ok',
        provider,
        ...(providerName !== undefined ? { providerName } : {}),
        adapterId: adapter.id,
        fetchedAt: this.#now(),
        intervalSec: this.intervalSec,
        ...(result.planTier !== undefined ? { planTier: result.planTier } : {}),
        windows: result.windows,
      }
      this.#cache.set(provider, { at: this.#now(), payload })
      return payload
    } catch (error) {
      // Errors do not cache: the panel's retry must actually re-query.
      this.#cache.delete(provider)
      return toQuotaFailure(
        provider, providerName, adapter, error, this.intervalSec, this.#now(),
      )
    }
  }

  /** The unexpired ok cache entry of a provider, if one exists. */
  #cached(provider: string): QuotaSnapshot | undefined {
    const entry = this.#cache.get(provider)
    if (entry === undefined) return undefined
    const ttl = this.#deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    if (this.#now() - entry.at >= ttl) {
      this.#cache.delete(provider)
      return undefined
    }
    return entry.payload
  }

  /** The service clock. */
  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}
