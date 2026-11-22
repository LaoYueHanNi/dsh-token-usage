# DR: 适配 sessionStats 移出摘要：同口径服务端 timing 与 tokenUsage 刷新感知

Status: implemented

## Problem

DSH `0.2.2-alpha.2`（`projection-snapshot-scope`）将 `sessionStats` 标记为 `SessionProjectionSummaryExcluded`（`wire.summary: false`），不再随 `session.list` 摘要行下发，仅在打开的当前会话通过 `useProjection('sessionStats')` 提供完整投影；摘要行改为保留 `tokenUsage`（`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`）。

本插件受此影响产生两处退化：

1. [UsageView.tsx](../../../src/client/UsageView.tsx) 顶部「平均首 token」与「token 速度」卡片通过 `byId[id].projectionValues?.sessionStats` 聚合作用域。在 `0.2.2+` 下，「含子代理」（`tree`）模式会漏掉全部子代理，钻取子会话（`focusId !== sessionId`）两项指标恒退化为 `—`。
2. [session-stats.ts](../../../src/client/session-stats.ts) 的 `buildStatsFreshnessKey` 依赖非活跃会话摘要里的 `projectionValues?.sessionStats` 触发防抖刷新，[CostPill.tsx](../../../src/client/CostPill.tsx) 与 `UsageView.tsx` 在 `0.2.2+` 下会失去子代理的投影推进信号。

## Decision

1. **服务端同口径下发 `timing`（不改用 `perfStream*`）**：
   核对 DSH 宿主源码（`session-stats`、`StatsPills`、`client-ui-stats`），宿主的 TTFT 与吞吐全仓统一采用加权公式 `ttftMs / ttftSteps` 与 `decodeTokens / (decodeMs / 1_000)`，不设 500ms 流式门槛，也非按请求算术平均。本插件 [stats.ts](../../../src/stats.ts) 的 `aggregateRequestTiming()` 已实现完全同公式的 `ChildTiming`。
   - [wire.ts](../../../src/wire.ts) 在 `fields=session` 的 `StatsPayload`（与 `UsageSummary`）新增可选字段 `timing?: ChildTiming`；
   - [stats-route.ts](../../../src/stats-route.ts) 在 `fields !== 'chip'` 时复用已过滤好的 `scoped` 记录计算 `aggregateRequestTiming(scoped)`（零额外磁盘扫描，与 `children[id].timing` 同源同口径）；`fields=chip` 保持精简不下发。
2. **前端分层解析与宿主统一**：
   [session-stats.ts](../../../src/client/session-stats.ts) 新增 `resolveHeaderTiming` 与 `aggregateScopedProjections`（将遗留 `projectionValues?.sessionStats` 访问收口在内部结构切片中，兼容 `0.2.2+` 从类型中移除该键）：
   - **当前单会话自身**（`scope === 'session' && focusId === sessionId`）：继续优先读 `liveStats`（`useProjection('sessionStats')`），缺失时回退服务端 `summary.timing`，完全不改变单会话既有行为。
   - **含子代理（`scope === 'tree'`）或钻取子会话（`focusId !== sessionId`）**：优先读服务端 `summary.timing`（与宿主公式及子会话表行保持一致）；仅当旧后端未下发 `summary.timing` 或 `history-incomplete` 降级时，依次回退旧宿主摘要投影与 `summary.total.perfStream*`。
   - 同步更新 [locales.ts](../../../src/client/locales.ts) 中 `view.note` 的中英文口径说明。
3. **`freshnessKey` 改用 `tokenUsage` 感知子代理更新**：
   `SessionRowLike` 补充结构化 `tokenUsage?: TokenUsageProjectionLike`，`buildStatsFreshnessKey` 改为组合 `updatedAt`、`tokenUsageFingerprint(tokenUsage)` 与（当前会话/旧宿主的）`sessionStatsFingerprint(stats)`，使 `CostPill` 与 `UsageView` 在 `0.2.2+` 下能即时感知子代理请求进展。

## Alternatives considered

- **直接复用 `summary.total.perfStreamFirstMsSum` / `perfStreamTpsSum` 作为顶部主数据源（路线图初拟方案）** —— 放弃：`perfStream*` 服务于按模型表性能列，带 `500ms` 生成时长过滤且为逐请求算术平均，与 DSH 宿主 `sessionStats`（全量加权平均）及本插件子会话表 `children[].timing` 口径不一致；仅保留作无 `summary.timing` 时的最后降级兜底。
- **在客户端拉取每个子会话的完整 `sessionStats` 投影** —— 放弃：子树规模可达数百个子代理，会产生大量 RPC 订阅，且已结束子会话仍需服务端持久化日志覆盖。

## Consequences

- 代价：`fields=session` 响应体增加一个 4 字段的 `timing` 对象；客户端对 `tokenUsage` 采用结构化类型镜像而非直接依赖 `@deepseek-ai/dsh-token-meter`（待宿主依赖基线整体升至 `0.2.2` 时再评估收敛）。
- 换来：单会话、含子代理与钻取子会话的顶部 TTFT/吞吐全部与 DSH 宿主及子会话表同公式对齐；在 `0.2.2+` 下子代理刷新与子树指标均恢复正常，同时向后兼容 `0.2.1-rc.3` 宿主。
