/**
 * Decorative occupant for the pinned Token Usage sidebar row (browser
 * half): registered into `sidebar.panellist` while the `sidebarPinned`
 * setting is on, so the shell renders the row the same way it renders its
 * official panel launchers — the shell owns the button and the accessible
 * label (resolved from the registration's `label` thunk); this component
 * supplies only the glyph.
 *
 * @module token-usage/client/PanellistPinEntry
 */

import { IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `sidebar.panellist` SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the gauge glyph at the size the sidebar asks for. The glyph sits
 * directly in the row's glyph slot, exactly as the official panel icons do —
 * an inline wrapper would lift it above the label line. Selection highlight
 * is the shell row's own class, so `active` stays unused here.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative gauge icon.
 */
export function PanellistPinEntry({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconGaugeOutlineRegular size={size} />
}
