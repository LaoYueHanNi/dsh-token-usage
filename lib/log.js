/**
 * Minimal logger face shared by the plugin's data modules. The host half
 * passes a named `ctx.logger('token-usage')` (the Cordis logging service) so
 * every diagnostic joins the framework's log pipeline; direct callers
 * (tests, standalone use) fall back to console. Only the three severities
 * the modules use are declared — the face stays as small as its consumers.
 *
 * @module token-usage/log
 */
/** Default sink: console, unbound (a detached call still hits globalThis). */
export const consoleLogger = {
    error: (message, ...args) => console.error(message, ...args),
    warn: (message, ...args) => console.warn(message, ...args),
    info: (message, ...args) => console.info(message, ...args),
};
//# sourceMappingURL=log.js.map