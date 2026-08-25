/**
 * Session-header stats chip (browser half): a one-line compact strip rendered
 * into the `conversation.session.header.utilities` slot — three sub-chips
 * (total tokens / cache hit rate / session cost) beside the Session log
 * button. Data comes from `/token-usage/stats?fields=chip` scoped to the
 * active session and its subagent subtree (the Usage tab's "with
 * subagents" range), so a parent that spawned children shows the same
 * folded numbers the header is meant to summarise. Numbers refresh on a
 * 3 s poll (conversation-scale, not request-scale): a new request only
 * nudges one of three figures by a single call's worth, and the host
 * cache makes each poll a memory hit unless today's file grew.
 *
 * Visibility contract: a session with no recorded requests renders nothing
 * (an empty header strip is worse than no strip; the chip never blanks to
 * "—"). Hit-rate colour is the four-bucket mapping in `format.hitRateDisplay`:
 * ≥95% healthy (green), 80–95% lime, 60–80% amber, below 60% critical (red).
 * Amber/lime fill the warm→cool gap so the four stops read as one progression.
 *
 * @module token-usage/client/SessionStatsChip
 */
import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Props the chip binds for the conversation-session header utilities slot:
 * the framework's session kit (`sessionId` + the global `useSessions`
 * mirror used to walk the subagent tree) plus the locale seat from the
 * registration's `locale:` declaration. */
export type SessionStatsChipProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'token-usage'>;
/**
 * Render the session-header stats chip for the active session. Renders
 * nothing when the session has no recorded usage, when the fetch fails, or
 * while the first fetch is in flight — the spec's "data has no value, the
 * block does not render" rule.
 * @param props - framework session id, the session-list mirror, and the locale seat.
 * @returns the chip strip, or null when the data is empty/unavailable.
 */
export declare function SessionStatsChip({ sessionId, useSessions, t }: SessionStatsChipProps): ReactNode | null;
//# sourceMappingURL=SessionStatsChip.d.ts.map