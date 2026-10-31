/**
 * The provider display-label rule, shared by the host side and the browser
 * side. It is a pure function with no IO, so both halves can import it
 * without dragging a registry along.
 *
 * @module token-usage/provider-label
 */

/** Route key → latest display name. Absent keys are not stored as empty strings. */
export type ProviderNameIndex = Record<string, string>

/**
 * Label for a route key. The name registry wins; a missing or empty entry
 * falls back to the key itself, so a route the registry never saw still
 * displays. A route without a name is not an error — the registry is a
 * convenience, the route key is the identity.
 * @param id - the route key.
 * @param names - the name registry, when the caller has one.
 * @returns the display name, or the route key itself.
 */
export function providerLabel(id: string, names?: Readonly<ProviderNameIndex>): string {
  const name = names?.[id]
  return name !== undefined && name !== '' ? name : id
}
