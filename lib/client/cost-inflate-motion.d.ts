/**
 * Imperative cost-cell motion (Web Animations API). Avoids CSS `@keyframes`
 * + custom-property bugs in some embedded hosts; runs on the actual DOM node.
 *
 * @module token-usage/client/cost-inflate-motion
 */
import type { CostInflateVars } from './cost-inflate.ts';
/** The user's motion preference: both runners refuse to animate (returning
 * null) when the OS asks for reduced motion. Exported so the chip hook can
 * skip spawning the DOM for flies that would never animate — a static +Δ
 * flash reads as a glitch, not information. */
export declare function motionAllowed(): boolean;
/** Scale bounce on the cost figure (`costPop`). */
export declare function runCostPop(el: HTMLElement, v: CostInflateVars): Animation | null;
/** +Δ label rise (`deltaRise`). Caller must position the element (absolute). */
export declare function runDeltaFly(el: HTMLElement, v: CostInflateVars): Animation | null;
//# sourceMappingURL=cost-inflate-motion.d.ts.map