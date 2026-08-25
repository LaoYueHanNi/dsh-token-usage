/**
 * The provider quota adapter contract (node half). One adapter owns one
 * provider family's quota endpoint: how to decide the route belongs to it
 * (`matches`) and how to query + normalize the response into the wire's
 * `QuotaWindow` vocabulary (`query`). The registry routes by provider route
 * key and base-URL host; adding a provider is one new file plus one
 * registry line — the shape cc-switch's `coding_plan.rs` proved out.
 *
 * Endpoint/field knowledge here comes from the cc-switch provider-usage
 * research (PROVIDER_USAGE_RESEARCH.md), whose endpoints are lifted from
 * working implementations.
 *
 * @module token-usage/quota/types
 */

import type { QuotaErrorKind, QuotaWindow } from '../wire.ts'

/** What an adapter sees when deciding whether it handles a route. */
export interface QuotaMatchInput {
  /** Provider route key exactly as session events carry it — the pi-ai
   * settings dict key (`zai-coding-cn`, `minimax`, a user-declared name)
   * or the direct adapter's `deepseek-official`. */
  provider: string
  /** The provider's inference base URL when one is resolvable (the
   * settings profile's `baseURL` override, else the catalog default);
   * undefined when neither is known. */
  baseUrl?: string
}

/** Everything one adapter query needs; the service resolves and injects. */
export interface QuotaQueryContext {
  /** Provider route key (for diagnostics and per-provider behavior). */
  provider: string
  /** Resolved inference base URL (may influence host/station choice). */
  baseUrl?: string
  /** The provider's API key, resolved through the credentials seam. */
  apiKey: string
  /** Deadline signal; the service stamps one per query. */
  signal?: AbortSignal
  /** Transport to use — global fetch in production, a stub in tests. */
  fetchFn: typeof fetch
}

/** What one adapter query returns; the service layers identity metadata. */
export interface QuotaQueryResult {
  windows: QuotaWindow[]
  /** Plan tier label when the provider reports one (Zhipu `data.level`). */
  planTier?: string
}

/** One provider family's quota integration. */
export interface QuotaAdapter {
  /** Stable id surfaced in diagnostics (`zhipu-coding-plan`, …). */
  id: string
  /** Human-readable family label for logs and diagnostics. */
  label: string
  /**
   * Whether this adapter handles the route. The base-URL host is the
   * stronger signal: a user-declared pi-ai route can carry any name while
   * pointing at a known coding-plan endpoint, so adapters check the host
   * first and treat the route key as the secondary signal. Conversely a
   * route key must only match when it is unambiguous (the pi-ai
   * `moonshotai` routes are the standard API, not Kimi For Coding, so the
   * kimi adapter matches on host or the catalog route `kimi-coding`).
   */
  matches(input: QuotaMatchInput): boolean
  /** Query the provider's quota endpoint and normalize the windows.
   * Transport failures throw {@link QuotaQueryError} with the normalized
   * kind; anything else is treated as a parse failure by the service. */
  query(ctx: QuotaQueryContext): Promise<QuotaQueryResult>
}

/** A quota query failure with its normalized wire kind. */
export class QuotaQueryError extends Error {
  constructor(readonly kind: QuotaErrorKind, message: string) {
    super(message)
    this.name = 'QuotaQueryError'
  }
}
