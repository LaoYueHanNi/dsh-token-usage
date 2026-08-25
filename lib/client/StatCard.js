import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import styles from './StatCard.module.css';
/**
 * Render one stat card. The value uses the standard label-primary color.
 * The label clamps to one line and ellipsizes if the column is squeezed.
 */
export function StatCard({ label, value }) {
    return (_jsxs("div", { className: styles['card'], children: [_jsx("span", { className: styles['cardLabel'], children: label }), _jsx("span", { className: styles['cardValue'], children: value })] }));
}
//# sourceMappingURL=StatCard.js.map