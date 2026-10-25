/**
 * The Token Usage main panel (browser half): the full-width page the
 * sidebar "More" menu row opens, registered into the `main` keyed slot
 * under key `token-usage` (declared by ui-layout). It wraps the
 * settings-section component unchanged — same stats route, same filters —
 * and adapts only the session-jump epilogue: the settings panel's `close`
 * becomes the page's return-to-conversation (selectPanel(null)), so a
 * Ctrl+click session jump lands on the target session.
 *
 * The registration waits on the shell's `main` declaration through
 * ctx.slots.inject; a shell that never declares it never runs the
 * callback, and the plugin's other surfaces are unaffected.
 *
 * @module token-usage/client/UsagePanelPage
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `main` keyed SlotMap key (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TokenUsageSection } from './TokenUsageSection.tsx'
import css from './UsagePanelPage.module.css'

export type UsagePanelPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'token-usage'>
  & {
    sessionListed?: (id: string) => boolean
    openSession?: (id: string) => { ok: boolean; reason?: string } | boolean
    /** Return the main column to the conversation (the page's "close"). */
    returnToConversation?: () => void
  }

/**
 * Render the Token Usage page for the main column: the official
 * first-level-page shell (full-height scroll pane, centered 960px column)
 * wrapping the section in its `page` variant — the settings panel keeps its
 * own layout untouched.
 * @param props - the locale seat, the injected session-jump seats, and the
 * framework's (empty) main-panel owner share.
 * @returns the shelled section content.
 */
export function UsagePanelPage({ t, sessionListed, openSession, returnToConversation }: UsagePanelPageProps): ReactNode {
  return (
    <div className={css.page}>
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          <TokenUsageSection t={t} variant="page" close={returnToConversation} sessionListed={sessionListed} openSession={openSession} />
        </div>
      </div>
    </div>
  )
}
