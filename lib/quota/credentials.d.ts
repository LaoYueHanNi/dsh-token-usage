/**
 * Provider credential + base-URL resolution (node half): the chain that
 * turns a provider ROUTE KEY into the material a quota adapter needs.
 *
 * The llm service never exposes keys or base URLs by design, so the chain
 * reads them from where the adapters themselves read them:
 * 1. the provider directory (`ctx.llm.listConfigurableProviders()`) maps a
 *    route to its settings namespace + path — with a built-in fallback for
 *    the two known shapes (pi-ai routes → `llm-pi-ai` `providers.<route>`;
 *    `deepseek-official` → the whole `llm-deepseek` section);
 * 2. the settings section at that path carries the profile
 *    (`{ apiKeyEnv, baseURL, … }`) — `apiKeyEnv` is a credential
 *    REFERENCE (an environment-variable name), never a value;
 * 3. the key resolves through the credentials seam (`credentials.resolve`),
 *    then a feature-detected `llm-pi-ai/<route>` record (newer hosts store
 *    the key the settings UI captured there), then the process env. The
 *    default env name comes from the profile, else pi-ai's per-route
 *    convention (`zai-coding-cn` → `ZAI_CODING_CN_API_KEY`, generic
 *    uppercase-dash-to-underscore otherwise).
 *
 * The base URL is the profile's `baseURL` override, else the built-in
 * catalog default for the known coding-plan routes — enough for host
 * matching (station choice) even though quota endpoints stay fixed.
 *
 * @module token-usage/quota/credentials
 */
/** Where a provider's profile lives in the settings document. */
export interface ProviderDirectoryEntry {
    settingsNs: string;
    settingsPath: readonly string[];
    displayName?: string;
}
/** The resolvable material of one provider route. */
export interface ResolvedQuotaCredentials {
    /** The API key, or undefined when no configured source holds one. */
    apiKey?: string;
    /** The env-variable name the key was expected under (diagnostics). */
    apiKeyEnv?: string;
    /** Inference base URL when one is resolvable (override or catalog). */
    baseUrl?: string;
    /** Human-readable provider name when one is resolvable. */
    displayName?: string;
}
/** Directory thunk: route key → its settings location (host llm service
 * backed); undefined when the route is unknown to the directory. */
export type ProviderDirectory = (provider: string) => ProviderDirectoryEntry | undefined;
/** Settings read thunk: namespace → resolved section value (unknown shape). */
export type SettingsReader = (ns: string) => unknown;
/** Credential seam: an env-var reference → its value, if configured. */
export type CredentialResolver = (ref: string) => Promise<string | undefined>;
/** Record-store seam (feature-detected, newer hosts only): a
 * `scope/provider` record key → its api-key material, if stored. */
export type CredentialRecordReader = (key: string) => Promise<{
    key?: string;
} | undefined>;
/**
 * Resolve one provider route's quota credentials.
 * @param input - the route and the three seams (each optional; a missing
 * seam simply shortens the chain).
 * @returns the key material found and the resolvable base URL / name.
 */
export declare function resolveQuotaCredentials(input: {
    provider: string;
    directory?: ProviderDirectory;
    readSettings: SettingsReader;
    resolveCredential?: CredentialResolver;
    readRecord?: CredentialRecordReader;
}): Promise<ResolvedQuotaCredentials>;
/**
 * Layer the catalog default base URL under a resolution that found none —
 * the known coding-plan routes' catalog endpoints, so host-based adapter
 * matching works even when the profile omits `baseURL` (the common case:
 * pi-ai inherits the catalog silently).
 * @param provider - the route key.
 * @param resolved - the credential resolution (its `baseUrl` wins).
 * @returns the resolution with a catalog fallback base URL filled in.
 */
export declare function withCatalogBaseUrl(provider: string, resolved: ResolvedQuotaCredentials): ResolvedQuotaCredentials;
//# sourceMappingURL=credentials.d.ts.map