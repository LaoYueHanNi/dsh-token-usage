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
import { useEffect } from 'react';
/**
 * Mirror the shell's `color-scheme` inline style onto the given root element.
 * @param rootRef - the surface's root element ref.
 */
export function useColorSchemeMirror(rootRef) {
    useEffect(() => {
        const root = document.documentElement;
        const element = rootRef.current;
        if (element === null)
            return;
        const sync = () => {
            const scheme = root.style.colorScheme;
            if (scheme !== '')
                element.style.colorScheme = scheme;
            else
                element.style.removeProperty('color-scheme');
        };
        sync();
        // The shell rewrites the inline style on every theme switch.
        const observer = new MutationObserver(sync);
        observer.observe(root, { attributes: true, attributeFilter: ['style'] });
        return () => observer.disconnect();
    }, [rootRef]);
}
//# sourceMappingURL=use-color-scheme.js.map