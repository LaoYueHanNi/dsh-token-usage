# DSH 0.2.2 升级路线图：3 大类 18 项新增 / 优化项

> **基线 → 目标**：DSH `0.2.1-rc.3` → DSH `0.2.2-rc.5`
> **梳理日期**：2026-11-22
> **状态**：已落地 `#0`、`#1`（提交 `c4a943d`）、`#2`（`353c299`）、`#3–#5`（`a9ae432`）与 `#6`；剩余 `#7–#17` 待后续分批落地（P1 → P2）。各项实施时须按 [docs/decisions/README.md](decisions/README.md) 规范逐项建立决策记录。

## 背景

结合 DeepSeek Harness（DSH）从当前基线 `0.2.1-rc.3` 演进至最新 `0.2.2-rc.5` 的上游变更，以及人工复现中暴露的既有缺陷，对照本插件现有实现，梳理出 3 大类、共 18 项可新增 / 优化项，按紧迫度与价值分层如下：

| # | 项 | 类别 | 优先级 | 状态 |
|---|---|---|---|---|
| 0 | 修复全量扫描 reconcile 误删归属会话的 aux 辅助开销记录 | 兼容与准确性修复 | P0 | ✅ 已完成（`c4a943d`） |
| 1 | 适配 Fork 会话，防止跨会话重复计费与归属错乱 | 兼容与准确性修复 | P0 | ✅ 已完成（`c4a943d`） |
| 2 | 过滤 deepseek-chat-import 导入的历史消息 | 兼容与准确性修复 | P0 | ✅ 已完成 |
| 3 | 修复 sessionStats 移出摘要导致的 TTFT/吞吐退化 | 兼容与准确性修复 | P0 | ✅ 已完成 |
| 4 | 移除已下线的 @deepseek-ai/dsh-client-ui-settings-plugins | 兼容与准确性修复 | P0 | ✅ 已完成 |
| 5 | 补齐新错误码 CONTENT_REFUSED 本地化与计费处理 | 兼容与准确性修复 | P0 | ✅ 已完成 |
| 6 | 升级辅助请求分类（LlmRequestPurposeMap） | 新增功能 | P0 | ✅ 已完成 |
| 7 | 左侧栏入口尾部实时指标 | 新增功能 | P1 | ✅ 已完成（需 0.2.3+ 宿主） |
| 8 | 会话侧边面板用量速览分区 | 新增功能 | P1 | ⏳ 待办 |
| 9 | 子会话表展示子代理语义名称与队友标识 | 新增功能 | P1 | ⏳ 待办 |
| 10 | 侧栏会话行尾部费用微标 | 新增功能 | P2 | ⏳ 待办 |
| 11 | 会话标题栏「更多」菜单快捷入口 | 新增功能 | P2 | ⏳ 待办 |
| 12 | 联网搜索调用记录落地并区分两套计费后端 | 新增功能 | P2 | ⏳ 待办 |
| 13 | 标识 Schedule（定时任务）触发的后台会话 | 新增功能 | P2 | ⏳ 待办 |
| 14 | 用 SyncedConfig 精简客户端只读配置同步 | 架构与规范对齐 | P2 | ⏳ 待办 |
| 15 | 替换已 @deprecated 的 session.snapshotEvents() | 架构与规范对齐 | P2 | ⏳ 待办 |
| 16 | 客户端构建产物对齐 client-module-metadata | 架构与规范对齐 | P2 | ⏳ 待办 |
| 17 | 补全插件生态元数据：icon、engines.dsh、8 语言与搜索 | 架构与规范对齐 | P2 | ⏳ 待办 |

---

## 一、🔴 高优先级：面向 DSH 0.2.2 的数据准确性与兼容修复

这些变化已经在上游落地（或已在现网复现），若不修复会出现数据丢失、重复计费、数据污染或界面退化。

### 0. 修复全量扫描同步（reconcile）误删归属会话的 `kind: 'aux'` 辅助开销记录 ✅ 已完成（`c4a943d`）

**问题根因**（已人工复现，实测一次全量扫描永久误删 161 条历史辅助开销）：

- 自支持会话归属辅助请求（如 `session-title`）以来，`kind: 'aux'` 行会记录真实 `sessionId`，而辅助请求走 `llm/stream` 旁路采集，**不会写入宿主会话持久化日志**，因此 `syncHistory()` 的 `reproduced`（`keep`）集合永远不会包含 `aux:*` 行；
- `src/usage-log.ts` 的 `reconcileDayFiles()` 判定删除条件为 `eligible.has(id) && !keep.has(id) && readableSessions.has(owners.get(id) ?? '')`，未对 `kind: 'aux'` 豁免，导致每次点击「全量扫描同步」都会把所有归属到可读会话的辅助开销行永久清除（历史不可回填）；
- 后续 #6 还会将 `auto-review`、`timeline-report` 一并归属到 `sessionId`，不修该缺陷会进一步放大数据丢失。

**落地情况**（决策记录：[2026-11-22-reconcile-whitelist-and-rewrite-backup.md](decisions/implemented/2026-11-22-reconcile-whitelist-and-rewrite-backup.md)）：

- **保留一键全量扫描的 `reconcile` 清理能力**（无需多余确认弹窗或开关，便于自动清理旧坐标和 Fork 重复压缩/失败行）；
- **`reconcileDayFiles()` 改为可重建来源白名单**：基于原始 JSON `kind` 判断，仅允许源自会话日志的记录（普通 `request` / `compaction` / `failure`）进入删除与归属修正候选；所有 `kind: 'aux'`（无论是否带 `sessionId`）及未来未知的非日志派生 `kind` 无条件豁免，未改动行按原始行文本无损保留；
- **改写前自动滚动备份（`src/backup.ts`）**：`reconcile`、`refile`、`backfillTiming`、`completeFields` 覆盖既有 `usage-*.jsonl` 前先把实际改动原文件备份至 `<dataDir>/.backups/<timestamp>-<reason>/`（0 改动不建目录、拷贝失败中止改写、滚动保留最近 5 次），`src/migrate.ts` 同步兼容 `.backups/` 随迁与校验清理；
- 已补齐单元测试、迁移测试与 `llm/stream` + `syncHistory` 端到端集成测试，并经实机全量同步验证保留 `aux` 与生成滚动备份。

### 1. 适配 Fork 会话（session-fork-source），防止跨会话重复计费与归属错乱 ✅ 已完成（`c4a943d`）

**上游变更**：DSH 0.2.2-rc.3 完善了 session fork（guide.md）。无论 JSONL 还是 SQLite，`handle.read()` 都返回 `seq = 0` 起的完整逻辑日志（含继承自父会话的 `assistant/message`、`compaction/summary`、`llm/retry`、`turn/end`）。

**本插件隐患**：

- `sync.ts` 全量从 0 读取。`compaction:${sessionId}:${seq}` 与 `failure:${sessionId}:${seq}` 带 `sessionId`，每次 fork 都会把继承前缀里的压缩费用和失败次数重复统计一遍；
- 若历史同步遍历时先读到 fork 子会话，`assistant/message` 会因 `message.id` 去重而被错误归属到子会话名下。

**落地情况**（决策记录：[2026-11-22-fork-session-inherited-prefix-dedup.md](decisions/implemented/2026-11-22-fork-session-inherited-prefix-dedup.md)）：

- **两阶段切片冷读与按需状态折叠**：优先通过 `handle.inheritedEventCount` 切片调用 `handle.read(N)` 跳过继承前缀（SQLite 可跳过父 Segment 解压）；仅当缺自有标题（需写入 `meta`）或早期失败前缺路由时按需 `handle.read(0, N)` 纯折叠 `title` / `model` / `provider`（不落盘、不入 `reproduced`、不跨界携带 `openStep` 与 `compactionAttribution`）；同时 `modelOfEvent` / `providerOfEvent` 补充提取 `request/header`，旧宿主降级定位最后一个 `session/end-seed { inherited: true }` 截断；
- **实时监听防护**：`src/index.ts` 与 `src/request-observe.ts` 通过 `isOwnSessionEvent`（优先 `session.isOwnSeq(event.seq)`）拦截非自有继承事件不落盘、不污染实时池，自有错误缺路由时回退读取 `session.requestContext?.()` / `session.requestHeader?.()`；
- **严格子代理判定**：`buildLineageIndex`（`src/stats.ts`）与 `subagentParentOf`（`src/client/session-stats.ts`）严格要求 `origin === 'subagent'`，历史保留 `parentSession` 的普通 fork 保持独立顶级会话；
- **旧账本自愈**：全量同步 `reconcile` 自动删除重复的 `compaction:<forkId>:<seq>` / `failure:<forkId>:<seq>`，并对唯一归属的错归 `assistant/message` 原地修正 `sessionId`（保留 `attemptTiming` 等字段，触发派生缓存失效）；
- 已补齐 SQLite 切片、JSONL 防御、旧宿主 `end-seed` 降级、先子后父顺序、旧账本自愈与实时监听单测/集成测试，并经实机验证清理历史重复与新建 Fork 隔离通过。

### 2. 过滤 deepseek-chat-import 导入的历史消息，避免污染模型/供应商维度与请求数 ✅ 已完成

**上游变更**：新增 `packages/experimental/deepseek-chat-import`（conversation.ts），导入对话的 `assistant/message` 固定写入 `source = { provider: 'deepseek-chat-export', model: 'deepseek-chat-export' }` 且 `usage: undefined`。

**本插件隐患**：`usage-record.ts` 的 `recordFromEvent()` 仍会为无 usage 的该类消息落盘，导致：

- 请求数虚高；
- 模型表多出未定价的 `deepseek-chat-export` 告警；
- 供应商表多出 `deepseek-chat-export`。

**优化方案**：在 `recordFromEvent()` 中跳过 `source.provider === 'deepseek-chat-export'` 且无 usage 的消息（用户后续在导入会话上继续对话的新 turn 含真实 provider/model，正常记录）。

**落地情况**（决策记录：[2026-11-22-skip-deepseek-chat-import-history.md](decisions/implemented/2026-11-22-skip-deepseek-chat-import-history.md)）：

- `isImportedHistoryEvent()` 统一识别导入回复（`deepseek-chat-export` 且无 usage）与导入器写入的 `DEEPSEEK_EXPORT_*` 轮次错误，`recordOfEvent()` 一处过滤，覆盖实时与历史同步两条路径；
- `modelOfEvent` / `providerOfEvent` 不再从导入回复读出路由，避免后续失败行挂到假模型；
- 全量扫描结果新增 `ignoredImported`，设置卡片进度与完成提示追加「忽略 N 条 DeepSeek chat 导入记录」；旧账本中的导入行由下一次全量扫描 `reconcile` 自动清理（带滚动备份）。

### 3. 修复 sessionStats 移出 session.list 摘要导致的子树 TTFT/吞吐与子代理刷新退化 ✅ 已完成

**上游变更**：DSH 0.2.2-alpha.2（projection-snapshot-scope）把 `sessionStats` 标为 `wire.summary: false`，不再随 `session.list` 下发；但 `tokenUsage` 仍保留在摘要行中。

**本插件隐患**：`session-stats.ts` 和 `UsageView.tsx` 依赖 `byId[id].projectionValues?.sessionStats` 聚合「含子代理」模式与钻取子会话的 TTFT/吞吐并构造 freshnessKey——在 0.2.2+ 上非当前会话该字段恒为 `undefined`。

**落地情况**（决策记录：[2026-11-22-summary-excluded-session-stats-timing-and-freshness.md](decisions/implemented/2026-11-22-summary-excluded-session-stats-timing-and-freshness.md)）：

- 对照 DSH 宿主源码统一口径（`ttftMs / ttftSteps` 与 `decodeTokens / (decodeMs / 1_000)` 全局加权平均）：`wire.ts` 与 `stats-route.ts` 在 `fields=session` 响应中直接复用 `aggregateRequestTiming(scoped)` 下发同口径 `timing?: ChildTiming`（`fields=chip` 保持精简不下发）；
- `session-stats.ts` 新增 `resolveHeaderTiming` 与 `aggregateScopedProjections`：当前单会话自身保留 `liveStats` 为首选（缺失时退回 `summary.timing`），「含子代理」与钻取子会话优先使用服务端 `summary.timing`（向后回退旧宿主摘要投影与 `perfStream*`），同步更新 `view.note` 中英说明；
- `buildStatsFreshnessKey` 纳入摘要 `projectionValues?.tokenUsage` + `updatedAt` 感知子代理请求进展。

### 4. 移除已下线的 @deepseek-ai/dsh-client-ui-settings-plugins 声明与依赖 ✅ 已完成

**上游变更**：DSH 0.2.2-rc.3（settings-section-plugins-page）移除了 `@deepseek-ai/dsh-client-ui-settings-plugins` 包及 `settings.plugins.tab` 槽位。

**落地情况**：已移除 `package.json` 的 `dsh.client.inject` 与 `devDependencies`（及 `pnpm-lock.yaml`）中的 `@deepseek-ai/dsh-client-ui-settings-plugins`，并删除 `src/client/index.ts` 对应的 `import type` 残留；`plugins.bundle.config` 暂保留本地 `SlotMap` 声明合并，待后续整体升级宿主依赖基线至 `0.2.2-rc.5` 时再切换为 `@deepseek-ai/dsh-client-ui-plugin-manager/client`。

### 5. 补齐新错误码 CONTENT_REFUSED 的本地化与计费处理 ✅ 已完成

**上游变更**：DSH 0.2.2-rc.3（deepseek-refusal-code）在 `LLM_FAILURE_CODES` 新增 `CONTENT_REFUSED`（原归为 `MALFORMED_RESPONSE`），且在抛出拒绝错误之前会先 yield `{ type: 'usage' }`（拒绝前生成的 token 照常计费）。

**落地情况**（决策记录：[2026-11-22-content-refused-billing-and-failure-codes.md](decisions/implemented/2026-11-22-content-refused-billing-and-failure-codes.md)）：

- 在 `src/client/format.ts` 与 `src/client/locales.ts` 补齐 `CONTENT_REFUSED`、`ACCOUNT_QUOTA`、`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID` 等 16 个新失败码的中英文翻译；
- 打通主对话流计费（`usage-record.ts` 新增 `extractUsageFromStream` 从 `assistant/attempt.stream` 提取拒绝前用量，`index.ts` 与 `sync.ts` 在同 step 的 `llm/retry` / `turn/end` error 时附着到 `failure` 行并严格隔离 Fork 前缀；`stats.ts` 的 `addUsage` 与 `requestSeriesOf` 让带 `usage` 的 `failure` 行进入 token、费用与趋势统计而仍不计入成功 `requests`）；
- `src/index.ts` 的 `llm/stream` 辅助流在收到 `CONTENT_REFUSED` 且伴随有效 `usage` 时保留一条 `kind: 'aux'` 计费记录。

---

## 二、🚀 结合上游新扩展点的高价值新增功能

### 6. 升级辅助请求分类（LlmRequestPurposeMap），支持 timeline-report 并把 auto-review 归属到会话 ✅ 已完成

**上游变更**：DSH 0.2.2-alpha.2 引入可扩展的 `LlmRequestPurposeMap`（guide.md）。全仓现已正式声明 4 类 purpose：

- `'compaction'`
- `'session-title'`
- `'auto-review'`（已带 sessionId！）
- `'timeline-report'`（timeline/src/summary.ts，也带 sessionId）

仅 translator 仍无 purpose/sessionId。

**落地情况**（决策记录：[2026-11-22-llm-request-purpose-classification.md](decisions/implemented/2026-11-22-llm-request-purpose-classification.md)）：

- `src/usage-record.ts` 新增 `AuxKind` 成员 `'timeline-report'`（加入 `AUX_KINDS`），`src/client/locales.ts` 补齐 `aux.kind.timeline-report`（`时间线报告` / `Timeline reports`）与 `pool.kind.timeline-report`（`时间线` / `Timeline`），在「运行开销」与请求池独立展示；
- `src/aux-request.ts` 的 `classifyAuxRequest()` 展宽 `options.purpose` 优先按 `LlmRequestPurposeMap` 匹配 `session-title` / `auto-review` / `timeline-report`，未知非空 `purpose` 直接入 `'other'` 防止未来带 `sessionId` 的辅助用途被主对话分支跳过，并保留 `REVIEW_POLICY` 前缀匹配兼容旧宿主；
- `src/request-observe.ts` 的 `RequestObserver` 直接复用 `classifyAuxRequest(options)` 统一分类口径，`auto-review` 与 `timeline-report` 带 `sessionId` 时进入实时请求池并通过 `linkAuxAttempt()` 与持久行去重链接，同时在 `stats.ts` 计入对应会话总计；
- 已更新 `README.md` / `README.zh.md` / `docs/DETAIL.md` / `docs/DETAIL.zh.md` 并补齐单测、客户端组件测试与端到端集成测试。

### 7. 左侧栏入口尾部实时指标（sidebar.panellist.trailing）✅ 已完成（需 0.2.3+ 宿主）

**上游变更**：ui-sidebar 新增 `sidebar.panellist.trailing` 槽位（slots.ts），展开态平时贴合行尾显示计数/徽章，hover 时自动淡出让位给原生 unpin 按钮；折叠态显示在图标角标。

**新增功能**：在侧栏 Token Usage 入口尾部直接展示今日总费用与今日总 Token，无需切屏即可随时掌握当日消耗。

**落地情况**（决策记录：[2026-11-22-sidebar-trailing-today-badge.md](decisions/implemented/2026-11-22-sidebar-trailing-today-badge.md)）：

- 以 `id: 'token-usage'` 注册 `sidebar.panellist.trailing`（本地 SlotMap 增强补齐 0.2.1 类型基线）；展开态渲染 `费用 · Token`（如 `12.40￥ · 1.2M`），折叠态只保留费用短格式（如 `12￥`），今日无请求时不渲染；
- 今日总量复用 `/token-usage/stats` 的 `from`/`to` 过滤，并新增 whole-scope `fields=chip` 精简响应（只回 `total` / `totalCost` / `costState` / `currency` 等总量层），挂载即读 + 60s 轮询 + 页面可见时补拉，首读失败 15s 重试；
- 宿主版本门槛：`0.2.2-rc.5` 的 ui-sidebar 尚未声明该槽位，实际声明出现在 master / `0.2.3-alpha.2`+；旧宿主上 `slots.inject` 不触发，入口保持原样，不报错；
- 已补齐 whole-chip 路由测试、组件渲染/折叠/空数据/无定价/失败测试与注册降级测试。

### 8. 新增「会话侧边面板」用量速览分区（conversation.session.panel.section + indicator）

**上游变更**：DSH 0.2.2-rc.3 推出右侧可停靠/覆盖的 Session Panel（ui-session-panel），宽屏默认常驻右侧，统一承载 Environment / Subagents / Shared tasks / Background jobs，并提供 `data-session-panel-row` 与 `panel.fold` / `panel.details` 工厂组件。

**新增功能**：

- 注册 `conversation.session.panel.section`（轻量级「用量」分区），让用户在 Chat 界面边聊边看本会话实时费用、累计 Token、缓存命中率与最近一次请求状态/耗时/低缓存提示；
- 通过 `conversation.session.panel.section.actions` 提供「打开完整 Usage 页」快捷跳转；
- 可选通过 `conversation.session.panel.indicator` 在面板按钮角标点亮异常提示（如低缓存 / 未定价模型 / 请求失败）。

与已有 CostPill（极简药丸）和 UsageView（全屏分析 Tab）形成三级渐进体验。

### 9. 子会话表展示 subagent-names 语义名称与 agent-team 队友标识

**上游变更**：

- DSH 0.2.2-alpha.3 为子代理引入语义名（父会话 `subagent/catalog` v3 含 `name` 如 `researcher`、`label`、`mode: 'continuable' | 'external'`）；
- DSH 0.2.2-rc.3 的 subagent-initial-task-source 使子代理初始任务不再生成 fallback title——以后大量子代理将没有 `session/title`；
- `packages/team/agent-team` 晋升正式包（队友即命名子代理），另新增外部子代理 subagent-oar（`mode: 'external'`，无本地 DSH session）。

**新增 / 优化**：

- 在 `session-meta.ts` 增采 `subagentName` / `subagentLabel`（从 `subagent/catalog` v3 与 `subagent/descriptor` v3 折叠）；
- 子会话表优先展示 `name`（如 `researcher`）与 `label`，避免因无 fallback title 而退化显示 `sess_xxx`；
- 对 `mode: 'external'` 外部子代理注明不计入本地账本。

### 10. 侧栏会话行尾部费用微标（sidebar.session.row.trailing，可选开关）

**上游变更**：ui-workspace 新增内联尾部槽位 `sidebar.session.row.trailing`（`owner: { sessionId }`）。

**新增功能**：提供可配置开关（默认关闭或极简 muted 样式），在侧栏会话列表行尾显示单会话累计费用，便于快速识别高消耗会话。

### 11. 会话标题栏「更多」菜单快捷入口（sessionHeader Context Menu）

**上游变更**：DSH 0.2.2-alpha.2（session-header-menu）开放 `ctx.contextMenus` 的 `sessionHeader` 目标。

**新增功能**：在会话右上角菜单注入「查看用量」或「导出本会话用量明细（JSON/CSV）」操作。

### 12. 推进「联网搜索调用记录」提案并区分两套计费后端（基于 web-search-billing 现状）

**上游核实**：对应本插件已有提案 [2026-10-27-web-search-call-records.md](decisions/proposed/2026-10-27-web-search-call-records.md)，DSH 0.2.2-rc.1~rc.4 的 web-search-billing / web-search-default-provider 改为按模型路由自动分流（DeepSeek 官方模型走 `deepseek-official` 按 token 计费，其他模型走 `deepseek-search-api` 按次计费），但两者仍不经过 `ctx.llm` 且丢弃响应中的 usage。

**落地方案**：沿用提案的 `session/event` 采集路线（`tool/call` + `tool/result` + `web/deepseek-search-llm-request`），并利用 `web/deepseek-search-llm-request` 是否出现来区分两种计费模式（模型轮次计费 vs 按次搜索 API），在「运行开销」中分别统计调用次数、查询数、耗时与失败率。

### 13. 标识 Schedule（定时任务）触发的后台会话

**上游变更**：DSH 0.2.2 将 schedule 升级为 Host 级定时任务，触发新建/唤醒的普通会话会在 `user/message` 写入 `source: { kind: 'schedule' }`。

**新增功能**：在会话元数据/列表中标记「定时任务」来源徽章（支持筛选），方便排查后台无人值守时的 Token 消耗来源。

---

## 三、🔧 架构简化、性能与生态规范对齐

### 14. 用 @deepseek-ai/dsh-client-config（SyncedConfig）精简客户端只读配置同步

**上游变更**：Host 声明 `.volatile()` 的字段（如 `sidebarPinned`、`pricingRegion`、`path`）现已自动同步到浏览器 `apply(ctx, config)` 的 config（SyncedConfig 对象，自带 `.get()` / `.subscribe()`）。

**本插件优化**：`src/client/index.ts` 为监听 `sidebarPinned` 写了大量 `configForms` + describe 桥接代码；只读消费可直接读 SyncedConfig（写操作仍走 `configForms`），减少竞态与样板代码。同时顺带评估与 ui-sidebar 原生 pin/unpin 按钮的交互一致性。

### 15. 替换已 @deprecated 的 session.snapshotEvents() 同步全量读取

**上游变更**：`session.snapshotEvents()` 已标记 `@deprecated`（禁止同步全量拷贝事件数组）。

**本插件现状**：`src/index.ts` L437（`relocateTo` 目录迁移守卫）与 L1154（`createDirectoryGuardRoute`）每次校验都遍历所有活跃会话调用 `session.snapshotEvents()`。

**优化方案**：在已有的 `session/event` 监听中维护一个 `Set<SessionId>` 跟踪 `turn/start` / `turn/end`，O(1) 返回 `interactingSessions`，零事件拷贝。

### 16. 升级客户端构建产物对齐 client-module-metadata（修复热更新/卸载样式残留）

**上游变更**：DSH 0.2.2-rc.2（client-module-metadata）移除了 `<style data-plugin-css>` 机制，改由 manifest 的 `meta.stylesheets` 由 renderer 统一挂载和卸载清理。

**本插件现状**：`tsdown.config.ts` 仍手动向 `document.head` 注入 `style[data-plugin-css]` 且无卸载清理。

**优化方案**：迁移到新版 `meta.stylesheets` 输出（或在 `ctx.effect` dispose 时清理注入的 `<style>`）。

### 17. 补全插件生态元数据：icon、engines.dsh 与 8 语言国际化 & 搜索体验升级

- **图标与版本声明**：DSH 0.2.2 支持 `package.json` 顶层 `"icon": "./icon.svg"` 与 `engines.dsh`（详见 package-manifest/types.ts），配合刚补好的 `docs/DETAIL.md` / `DETAIL.zh.md`，可进一步提升插件页与市场辨识度；
- **多语言扩展**：dsh-client-locale 已扩充至 8 种内置语言（新增 ja、de、es、fr、pt、ru），可按需补充 `locale/<lang>.json` 元数据及客户端词典；
- **模糊搜索**：定价总览弹窗（`pricing-search.ts`）可参考或复用上游新库 `@deepseek-ai/dsh-util-text-search`（基于 fuzzysort 的多段词首模糊 + NFKC 规范化搜索）。

---

## 四、💡 建议的落地优先级路线

| 阶段 | 包含项 | 核心收益 |
|---|---|---|
| **P0：0.2.2 兼容与准确性基线** | ~~#0 修复 reconcile 误删 aux~~（✅）、~~#1 Fork 去重~~（✅）、~~#2 过滤 deepseek-chat-export~~（✅）、~~#3 修复 sessionStats 摘要退化~~（✅）、~~#4 移除 ui-settings-plugins~~（✅）、~~#5 补 CONTENT_REFUSED~~（✅）、~~#6 purpose 识别（auto-review / timeline-report）~~（✅） | 消除全量扫描误删辅助开销与 0.2.2 下的重复计费、脏数据、子代理统计退化，升级宿主依赖基线到 0.2.2-rc.5 |
| **P1：高感知新体验** | #7 侧栏尾部今日费用、#8 Session Panel 停靠用量分区、#9 子代理语义名展示 | 充分利用 0.2.2 最核心的新 UI 槽位与 subagent-names 特性 |
| **P2：深度可观测与规范打磨** | #12 联网搜索调用记录落地、#13 Schedule 标识、#10 会话行费用微标、#11 导出菜单、#14–#17 架构精简与生态元数据 | 补齐搜索/定时任务盲区，代码与构建体系全面对齐 0.2.2 规范 |

## 关联文档

- 已落地决策（#0）：[2026-11-22-reconcile-whitelist-and-rewrite-backup.md](decisions/implemented/2026-11-22-reconcile-whitelist-and-rewrite-backup.md)
- 已落地决策（#1）：[2026-11-22-fork-session-inherited-prefix-dedup.md](decisions/implemented/2026-11-22-fork-session-inherited-prefix-dedup.md)
- 已落地决策（#2）：[2026-11-22-skip-deepseek-chat-import-history.md](decisions/implemented/2026-11-22-skip-deepseek-chat-import-history.md)
- 已落地决策（#3）：[2026-11-22-summary-excluded-session-stats-timing-and-freshness.md](decisions/implemented/2026-11-22-summary-excluded-session-stats-timing-and-freshness.md)
- 已落地决策（#5）：[2026-11-22-content-refused-billing-and-failure-codes.md](decisions/implemented/2026-11-22-content-refused-billing-and-failure-codes.md)
- 已落地决策（#6）：[2026-11-22-llm-request-purpose-classification.md](decisions/implemented/2026-11-22-llm-request-purpose-classification.md)
- 已落地决策（#7）：[2026-11-22-sidebar-trailing-today-badge.md](decisions/implemented/2026-11-22-sidebar-trailing-today-badge.md)
- 已有提案：[docs/decisions/proposed/2026-10-27-web-search-call-records.md](decisions/proposed/2026-10-27-web-search-call-records.md)（#12 的落地基础）
- 决策记录规范：[docs/decisions/README.md](decisions/README.md)（每项实施时逐项建 ADR）
