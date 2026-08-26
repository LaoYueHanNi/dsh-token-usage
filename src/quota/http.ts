/**
 * Shared transport helpers of the quota adapters (node half): one JSON GET
 * that normalizes every failure mode into {@link QuotaQueryError} with the
 * wire's error kind, plus small parsing utilities (host extraction,
 * epoch-ms normalization) every adapter repeats.
 *
 * @module token-usage/quota/http
 */

import type { QuotaQueryContext } from './types.ts'
import { QuotaQueryError } from './types.ts'

/**
 * GET one URL and parse the JSON body, normalizing failures: 401/403 →
 * `auth`, other non-2xx → `http`, transport errors (DNS, timeout, abort)
 * → `network`, a body that is not JSON → `parse`. Adapters therefore only
 * throw shape-validation errors of their own.
 * @param ctx - the query context (transport, auth header material, signal).
 * @param url - the absolute quota endpoint.
 * @param headers - extra request headers (most adapters pass Authorization).
 * @returns the parsed body.
 */
export async function fetchJson(ctx: QuotaQueryContext, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response
  try {
    response = await ctx.fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    })
  } catch (error) {
    // Abort/timeout arrives here too — the query is dead either way, and
    // the message is the only distinguishing detail worth keeping.
    throw new QuotaQueryError('network', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401 || response.status === 403) {
    throw new QuotaQueryError('auth', `HTTP ${String(response.status)}`)
  }
  if (!response.ok) {
    throw new QuotaQueryError('http', `HTTP ${String(response.status)}`)
  }
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new QuotaQueryError('parse', error instanceof Error ? error.message : String(error))
  }
}

/** Read a required object field or fail with the normalized parse error. */
export function requireObject(value: unknown, field: string): Record<string, unknown> {
  const inner = value instanceof Object ? (value as Record<string, unknown>)[field] : undefined
  if (typeof inner !== 'object' || inner === null) {
    throw new QuotaQueryError('parse', `missing "${field}" object`)
  }
  return inner as Record<string, unknown>
}

/** Read a required array field or fail with the normalized parse error. */
export function requireArray(value: unknown, field: string): unknown[] {
  const inner = value instanceof Object ? (value as Record<string, unknown>)[field] : undefined
  if (!Array.isArray(inner)) {
    throw new QuotaQueryError('parse', `missing "${field}" array`)
  }
  return inner
}

/** A finite non-negative number off a JSON value, else undefined. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  return undefined
}

/**
 * A money/credit amount off a JSON value: a finite number, or the string
 * form providers actually serialize (DeepSeek and OpenRouter ship `"110.00"`
 * strings), with EITHER sign — a pay-as-you-go account can overdraft
 * (DeepSeek answers `total_balance: "-0.01"`). Everything else, including
 * blank strings, reads undefined.
 */
export function amountOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Normalize a provider timestamp to epoch ms. Providers mix units (MiniMax
 * documents ms, some hand-rolled gateways answer seconds); an absolute
 * epoch in seconds is ≤ ~1.1e10 while the ms form is ≥ 1e12, so anything
 * below the seconds ceiling is re-scaled. Values that fit neither an
 * absolute epoch shape pass through unchanged (the caller clamps).
 */
export function toEpochMs(value: unknown): number | undefined {
  const n = numberOf(value)
  if (n === undefined || n <= 0) return undefined
  return n < 1e11 ? n * 1000 : n
}

/**
 * The lowercase hostname of a base URL, or undefined when the string is
 * blank or unparseable — adapters match hosts, never full URLs, because
 * the path spelling differs between the inference and quota endpoints.
 */
export function hostOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}
