# DR: 子会话计时改由服务端记录派生，并去掉挂载时的重复统计请求

Status: implemented

## Problem

[DR: 会话用量范围改由服务端按血缘展开](./2026-11-06-server-side-subtree-scope.md) 修好 HTTP 431 后，用量页第一次真正显示 193 个子会话，暴露出两个此前被错误页挡住的问题：

1. 打开用量页签时 Network 里出现两条完全相同的 `?root=…&fields=session`（都 200，31ms / 22ms）。费用胶囊发的是 `fields=chip`，与这两条对不上，不是两个不同消费者。
2. 子会话表的「平均首 token」「token 速度」整列是「—」，而请求数 / 总 token / 费用 / 命中率都有值。

根因 1：`freshnessKey` 把作用域 id 集合、`byId[].updatedAt` 与 `sessionStats` 指纹拼在一起。挂载瞬间 `useSessions` 镜像 / `useProjection` 尚未交付完整数据，freshness 先按「只有 root」算并立即发第一次请求；镜像补齐 193 个子会话后 freshness 剧变，250ms 防抖后 effect 重跑发第二条。第一条 31ms 已完成，cleanup 的 `abort()` 来不及，于是两条都是 200、URL 一模一样。现有测试用同步完整镜像（断言一次 fetch），覆盖不到这条真实挂载时序。

根因 2：子会话两列取 `byId[id].projectionValues?.sessionStats`，`aggregateProjections` 在 `contributing === 0` 时返回 `undefined` → 渲染「—」。这 193 个是已结束的子智能体，运行时 `SessionSummary` 镜像不为它们保留该投影（投影只挂在活跃会话上）；而前四列取的是服务端派生的 `children` breakdown。实测 `usage` 日文件里每条记录都带 `firstTokenLatencyMs` / `latencyMs` / `attemptTiming` + `outputTokens`，数据其实一直存在，只是用错了数据源。

## Decision

- **计时数据源改为服务端**：`wire.ts` 的 `ChildUsageSummary` 新增 `timing?`（`ChildTiming`：ttftMs / ttftSteps / decodeMs / decodeTokens）。`stats.ts` 新增 `aggregateRequestTiming`：优先用 `attemptTiming.firstTokenAt → settledAt`，缺失时退回 `latencyMs - firstTokenLatencyMs`；只纳入有首 token、正输出 token、正 decode 窗口的记录（与请求池 `settledSpeedOf` 的护栏一致，避免非流式响应算出虚高 tok/s）。`childBreakdown` 在已有的一次遍历分桶里顺手折叠，不额外扫日志；`UsageView` 子会话行改读 `row.timing`，不再读镜像投影。
- **口径显式分开**：顶部卡片的 TTFT / 速度仍用框架 `sessionStats` 投影（含安装前历史）；子会话表的这两项只覆盖插件安装后、有计时的记录。`view.note` 中英注脚同步改写，不再笼统声称两列都来自投影。
- **去重挂载时的重复请求**：`UsageView` 与 `CostPill` 各持一个 `recentRef`，记录上次成功结果及其 `scopeKey` / `idsKey` / `retryToken` / `pollTick` / `associationTick`。**仅当 id 集合发生变化（镜像晚到）**，且范围、重试、轮询、定价关联变更等意图都未变、距上次成功不足两个防抖窗、且该范围尚未复用过时，第二次 effect 直接复用上次结果，不发 HTTP；每个范围最多复用一次。真实请求完成（`sessionStats` / `updatedAt` 变化但 id 集合不变）、切换范围、点重试、轮询、关联变更一律正常发请求。不改 `useAsyncResource`：去重是两个浏览器消费者的局部策略，通用 hook 的取消 / 静默语义保持不变。

## Alternatives considered

- **延迟首次请求到镜像稳定后再发** —— 语义最干净，但要给 `useAsyncResource` 加 `enabled` 门闩，并让用量页与胶囊首屏多 250ms loading；现有测试大量依赖即时渲染。否决。
- **无条件复用「防抖窗内的重复请求」** —— 会吞掉真实请求完成触发的刷新，`cost-pill` 的 request-driven refresh 用例实测失败。否决，改为只认 id 集合变化。
- **把 freshness 从 effect deps 里彻底移除** —— 会失去「每个请求结算后刷新」的实时性。否决。
- **让宿主为已结束子会话保留 sessionStats 投影** —— 不在插件能力内，且 193 个历史会话全量保留投影成本高。否决。
- **子会话两列直接留空 / 隐藏** —— 掩盖信息缺口，而记录里实测有计时字段可用。否决。
- **把计时字段单独做一趟扫描** —— `childBreakdown` 已在一次遍历里拿到分组后的 records，再扫一遍是浪费。否决。

## Consequences

- 换来：打开用量页只发一条 stats 读（镜像晚到不再产生第二条相同 GET）；193 个已结束子会话的 TTFT / 速度有真实数据；子会话表不再依赖运行时镜像保留投影；计时计算复用已有分桶，无额外日志扫描。`pnpm typecheck` 通过，`pnpm test` 61 文件 / 1199 用例全绿，新增 `tests/request-timing.spec.ts`、端到端 `children.*.timing` 断言、两个「镜像晚到不重复请求」用例与子会话列渲染用例。
- 代价：子会话计时只覆盖插件安装后、带计时的请求，与顶部卡片投影口径不同（已在注脚写明）；`recentRef` 引入浏览器侧局部状态，需保证切换范围 / 重试 / 轮询 / 关联变更不被误吞，已由 id 集合与意图判据加测试锁定；新子会话刚加入时 id 集合变化会复用一次最近结果，其用量由随后的事件或轮询补齐。
