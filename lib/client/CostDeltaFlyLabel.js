import { jsx as _jsx } from "react/jsx-runtime";
import { useLayoutEffect, useRef } from 'react';
import { runDeltaFly } from "./cost-inflate-motion.js";
import styles from './SessionStatsChip.module.css';
/** One +Δ fly label; animation starts on mount via WAAPI. */
export function CostDeltaFlyLabel({ text, vars }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el === null)
            return;
        const anim = runDeltaFly(el, vars);
        if (anim === null) {
            // Motion is allowed but this host has no WAAPI: without the animation
            // the label would sit statically for the whole inflate window — hide
            // it and let the number update be the only signal.
            el.style.visibility = 'hidden';
            return;
        }
        return () => { anim.cancel(); };
    }, [vars]);
    return (_jsx("span", { ref: ref, className: styles['deltaFly'], children: text }));
}
//# sourceMappingURL=CostDeltaFlyLabel.js.map