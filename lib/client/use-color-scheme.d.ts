/**
 * Shared browser-half hook: mirror the shell's root `color-scheme` onto a
 * plugin-owned root element. The shell sets the property on
 * `document.documentElement` only, so form controls inside plugin surfaces
 * render with the UA default (white) in dark mode; scoping the property to
 * the surface's root fixes selects, inputs, and dialogs without touching
 * anything outside it. Used by the settings section and the conversation
 * view tab.
 *
 * @module token-usage/client/use-color-scheme
 */
import type { RefObject } from 'react';
/**
 * Mirror the shell's `color-scheme` inline style onto the given root element.
 * @param rootRef - the surface's root element ref.
 */
export declare function useColorSchemeMirror(rootRef: RefObject<HTMLElement | null>): void;
//# sourceMappingURL=use-color-scheme.d.ts.map