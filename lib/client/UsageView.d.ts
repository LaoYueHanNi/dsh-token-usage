/**
 * The conversation view tab "Usage" (browser half): one entry of the
 * `conversation.view` slot ring (beside Chat / Trajectory), rendering the
 * per-session token & cost dashboard for the ACTIVE conversation. The tab
 * shows the focused session's totals (4 token buckets, cost, hit rate,
 * TTFT average, decode throughput) with a scope switch between the session
 * alone and its whole subagent subtree, a per-hour trend chart and the
 * per-model table from the host stats route (`sessionId`-scoped), and a
 * subagent table below — each row drill-in switches the focus to that child.
 *
 * Data sources: token/cost figures come from the host route (the pricing
 * rule chain's authority); TTFT and throughput come from the framework's
 * retained `sessionStats` projection values (`useProjection` for the current
 * session, `byId[].projectionValues` for every other session), which cover
 * the whole log including history written before this plugin was installed.
 * A footnote states the two scopes so the difference is not a surprise.
 *
 * @module token-usage/client/UsageView
 */
import type { ReactNode } from 'react';
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionListState, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client';
/** The view's scope switch: the session alone, or its whole subagent subtree. */
export type UsageScope = 'session' | 'tree';
/** Props: the conversation-view runtime seat (standard kit) plus the locale seat.
 * dsh 0.1.2-alpha.3 narrowed the kit's `useSession` to the Session lifecycle
 * snapshot; the Conversation snapshot is no longer part of it — and this view
 * never read it, so the seat is simply dropped. */
export interface UsageViewProps {
    useSessions: SnapshotSelectorHook<SessionListState>;
    useProjection: UseProjection;
    sessionId: SessionId;
    t: TranslateNS<'token-usage'>;
}
/**
 * Render the Usage view tab for the active conversation.
 * @param props - the framework session kit, the session mirror, and the
 * locale seat (from the registration's `locale:` declaration).
 * @returns the dashboard: header (title, scope switch, back), stat cards
 * and the 4-token strip, the chart/model columns, and the subagent table.
 */
export declare function UsageView({ useSessions, useProjection, sessionId, t }: UsageViewProps): ReactNode;
//# sourceMappingURL=UsageView.d.ts.map