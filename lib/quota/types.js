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
/** A quota query failure with its normalized wire kind. */
export class QuotaQueryError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'QuotaQueryError';
    }
}
//# sourceMappingURL=types.js.map