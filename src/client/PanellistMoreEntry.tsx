/**
 * The sidebar panel list's "More" menu row (browser half): one entry that
 * opens the Token Usage main panel, registered into
 * `sidebar.panellist.actions` (declared by ui-sidebar since dsh
 * 0.2.1-rc.3). The row rides the region's own Menu — the owner supplies
 * `onDismiss` (close the menu before navigating) — and the registered
 * `inject` closure supplies the panel-opening callback, so this component
 * stays declarative. The label reuses the settings nav copy so the entry
 * reads as the same feature across surfaces.
 *
 * On a shell older than 0.2.1-rc.3 the slot is never declared: the inject
 * callback never runs and the row simply never appears — the settings
 * section stays the only entry.
 *
 * @module token-usage/client/PanellistMoreEntry
 */

import type { ReactNode } from 'react'
import { IconGaugeOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `sidebar.panellist.actions` SlotMap key.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export type PanellistMoreEntryProps =
  PropsRuntime<'sidebar.panellist.actions'>
  & PropsLocale<'token-usage'>
  & { openPanel: () => void }

/**
 * Render the More-menu row that opens the Token Usage panel.
 * @param props - the owner's dismissal callback, the injected open
 * callback, and the framework translate seat.
 * @returns one MenuItemButton row.
 */
export function PanellistMoreEntry({ onDismiss, openPanel, t }: PanellistMoreEntryProps): ReactNode {
  return (
    <MenuItemButton icon={<IconGaugeOutlineRegular size={16} />}
      onSelect={() => { onDismiss(); openPanel() }}>
      {t('nav.label')}
    </MenuItemButton>
  )
}
