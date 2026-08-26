/**
 * Session-header stats chip (browser half): a one-line compact strip rendered
 * into the `conversation.session.header.utilities` slot — three sub-chips
 * (total tokens / cache hit rate / session cost) beside the Session log
 * button. Data comes from `/token-usage/stats?fields=chip` scoped to the
 * active session and its subagent subtree (the Usage tab's "with
 * subagents" range), so a parent that spawned children shows the same
 * folded numbers the header is meant to summarise. Numbers refresh at
 * REQUEST granularity (same cadence as the Usage tab): `sessionStats`
 * projection churn (plus mirror `updatedAt` when present) is debounced
 * into one fetch, so idle sessions do not poll and a finished request
 * updates the header within ~250 ms. When cost
 * rises on a new request, the cost cell plays `costPop` (scale bounce) and
 * `deltaRise` (+Δ fly); reduced-motion users get silent figure updates
 * instead. A failed FIRST fetch retries itself on a 3 s cadence — the old
 * poll's safety net — so an idle-but-used session still gets its chip.
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
/** Self-heal cadence after a failed first fetch. With the poll gone, this
 * retry is the only thing that recovers an idle session's chip: refresh
 * failures after the first land keep the prior figures (silent mode) and
 * self-heal on the next request churn, so they never reach the error state. */
export declare const FETCH_FAILURE_RETRY_MS = 3000;
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
export declare function SessionStatsChip({ sessionId, useSessions, useProjection, t }: SessionStatsChipProps): ReactNode | null;
//# sourceMappingURL=SessionStatsChip.d.ts.map