/**
 * Minimal logger face shared by the plugin's data modules. The host half
 * passes a named `ctx.logger('token-usage')` (the Cordis logging service) so
 * every diagnostic joins the framework's log pipeline; direct callers
 * (tests, standalone use) fall back to console. Only the three severities
 * the modules use are declared — the face stays as small as its consumers.
 *
 * @module token-usage/log
 */
/** The severity methods the plugin's modules emit. */
export interface LoggerLike {
    error(message: unknown, ...args: unknown[]): void;
    warn(message: unknown, ...args: unknown[]): void;
    info(message: unknown, ...args: unknown[]): void;
}
/** Default sink: console, unbound (a detached call still hits globalThis). */
export declare const consoleLogger: LoggerLike;
//# sourceMappingURL=log.d.ts.map