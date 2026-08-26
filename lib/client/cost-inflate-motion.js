/**
 * Imperative cost-cell motion (Web Animations API). Avoids CSS `@keyframes`
 * + custom-property bugs in some embedded hosts; runs on the actual DOM node.
 *
 * @module token-usage/client/cost-inflate-motion
 */
/** The user's motion preference: both runners refuse to animate (returning
 * null) when the OS asks for reduced motion. Exported so the chip hook can
 * skip spawning the DOM for flies that would never animate — a static +Δ
 * flash reads as a glitch, not information. */
export function motionAllowed() {
    return typeof window.matchMedia !== 'function'
        || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function waapiAvailable(el) {
    return typeof el.animate === 'function';
}
/** Scale bounce on the cost figure (`costPop`). */
export function runCostPop(el, v) {
    if (!motionAllowed() || !waapiAvailable(el))
        return null;
    const popScale = Number(v.popScale);
    const echo = 1 + (popScale - 1) * 0.28;
    const warnMix = v.warnMix;
    return el.animate([
        { transform: 'scale(1)', color: 'var(--dsw-alias-label-primary)' },
        {
            transform: `scale(${String(popScale)})`,
            color: `color-mix(in srgb, var(--dsw-alias-state-warn-primary) ${warnMix}, var(--dsw-alias-label-primary))`,
            offset: 0.35,
        },
        {
            transform: `scale(${String(echo)})`,
            color: `color-mix(in srgb, var(--dsw-alias-state-warn-primary) ${warnMix}, var(--dsw-alias-label-primary))`,
            offset: 0.70,
        },
        { transform: 'scale(1)', color: 'var(--dsw-alias-label-primary)' },
    ], {
        duration: v.inflateMs,
        easing: 'cubic-bezier(0.25, 0.85, 0.35, 1)',
        fill: 'both',
    });
}
/** +Δ label rise (`deltaRise`). Caller must position the element (absolute). */
export function runDeltaFly(el, v) {
    if (!motionAllowed() || !waapiAvailable(el))
        return null;
    return el.animate([
        { opacity: 0, transform: 'translate(-50%, -20%)' },
        { opacity: 1, transform: 'translate(-50%, -20%)', offset: 0.15 },
        {
            opacity: 0,
            transform: `translate(calc(-50% + ${v.flyX}), calc(-100% - ${v.flyY}))`,
        },
    ], {
        duration: v.inflateMs,
        easing: 'cubic-bezier(0.22, 0.55, 0.25, 1)',
        fill: 'both',
    });
}
//# sourceMappingURL=cost-inflate-motion.js.map