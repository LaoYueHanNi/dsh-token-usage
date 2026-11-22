# DR: 适配 Fork 会话继承前缀去重、旧账本修正与严格子代理血缘判定

Status: implemented

## Problem

DSH 0.2.2 完善 session fork 后，无论 JSONL 还是 SQLite 持久化后端，`handle.read()` 都返回从 `seq = 0` 起的完整逻辑日志，其中包含从父会话继承的 `assistant/message`、`compaction/summary`、`llm/retry`、`turn/end`、`session/title` 与 `compaction/prune`。既有实现存在三处严重缺陷：

1. **跨会话重复计费**：`compaction:<sessionId>:<seq>` 与 `failure:<sessionId>:<seq>` 的主键携带当前 `sessionId`。全量同步从 seq 0 遍历每个会话时，fork 子会话继承前缀里的压缩与失败行会换上子会话 id 重新落盘，导致费用与失败数翻倍（已实测复制重复压缩行）。
2. **遍历顺序引发归属错乱**：若首次同步或扫描先读到 fork 子会话，继承前缀里的 `assistant/message` 会凭 `message.id` 去重先占坑，导致父会话自己的历史消息被错归到子会话名下；且由于旧 `reconcile` 仅校验 `requestId` 集合，错归行在后续重扫中无法自愈。
3. **子代理血缘判定过宽与边界路由丢失**：`buildLineageIndex`（`src/stats.ts`）与 `subagentParentOf`（`src/client/session-stats.ts`）未校验 `origin === 'subagent'`，会把保留历史 `parentSession` 字段的普通 fork 误折叠为父会话的子代理；同时若直接跳过继承前缀，未改名的 fork 会缺失标题，且在自有路由事件之前发生失败时会丢失模型与供应商归属。

## Decision

1. **历史同步分前缀与自有事件两阶段读取（`src/sync.ts`）**：
   - 当持久化句柄提供正整数 `inheritedEventCount = N` 时，先切片读取自有事件 `handle.read(N)`（SQLite 后端据此跳过父 Segment 解压）；仅当需要写入 `meta` 且自有事件无 `session/title`，或自有事件中在路由确立前先出现 `llm/retry` / 错误 `turn/end` 时，在同一句柄上按需 `handle.read(0, N)` 获取前缀。
   - 若句柄忽略 `offset` 从 seq 0 返回（如部分测试替身或全量响应），就地按 `seq < N` / `seq >= N` 拆分前缀与自有事件；旧宿主未提供 `inheritedEventCount` 时，降级定位日志中**最后一个** `session/end-seed { inherited: true }` 作为切分边界（支持多级 fork，普通 resume 标记不触发截断）。
   - 继承前缀仅折叠状态上下文（`title`、`model`、`provider`），绝不落盘计费行、绝不加入 `reproduced`，也不跨界携带 `openStep` 计时与 `compactionAttribution` 窗口；同时 `modelOfEvent` / `providerOfEvent`（`src/usage-record.ts`）新增提取 `request/header` 的 `config.model` / `config.provider`，使多数 fork/resume 无需回读前缀即可识别自有路由；`backfillDayFilesTiming` 在 `session/end-seed` 处同步清空 `openStep`。
2. **实时监听防护（`src/index.ts`、`src/request-observe.ts`）**：
   - 共用 `isOwnSessionEvent(session, event)`（优先 `session.isOwnSeq(event.seq)`，回退 `event.seq >= session.inheritedEventCount`，无 fork 元数据时默认 `true`）识别自有事件。
   - 主监听器对非自有事件仅更新标题/头部/路由状态后立即返回，绝不记录用量或更新步计时与压缩归因；对自有事件在本地路由仍空时回退读取 `session.requestContext?.()` / `session.requestHeader?.()`。`RequestObserver` 对非自有事件直接忽略。
3. **严格子代理判定（`src/stats.ts`、`src/client/session-stats.ts`、`src/sync.ts`）**：
   - `buildLineageIndex()` 与 `subagentParentOf()` 严格要求 `origin === 'subagent'` 才认定父子从属；普通 fork（含保留历史 `parentSession` 的旧 fork）作为独立顶级会话统计与展示。
4. **旧账本自愈（`src/sync.ts`、`src/usage-log.ts`）**：
   - 一次手动全量扫描即可由对账自动清除不再产出的重复 `compaction:<forkId>:<seq>` 与 `failure:<forkId>:<seq>`；
   - `syncHistory()` 额外收集 `reproducedOwners` 中唯一归属的 `expectedOwners` 传给 `reconcile`。对满足「属于可重建白名单、`eligible` 内、新旧 `sessionId` 均在本轮 `readableSessions` 内、且归属唯一」的错归行，原地更新 `record.sessionId` 并保留 `attemptTiming` 等所有已采集字段（改写前自动走 [滚动作废备份](../implemented/2026-11-22-reconcile-whitelist-and-rewrite-backup.md) 路径），同时将 `reassigned` 纳入派生缓存失效条件。

## Alternatives considered

- **历史同步对所有 fork 会话总是全量 `handle.read(0)` 再过滤前缀** —— 放弃：在 SQLite 后端会丧失跳过父 Segment 解压的性能收益，长对话大量 fork 后的全量扫描成本随祖先深度放大。
- **读取 `handle.read(N)` 后永不按需回读前缀** —— 放弃：fork 默认不会重写 `session/title`，未改名 fork 在会话表中会退化为裸 ID，且极端情况下先于路由事件失败的请求会丢失模型与供应商维度。
- **在 `reconcile` 中删除错归 `assistant/message` 行而非原地修正 `sessionId`** —— 放弃：单次扫描仅删除而不回写需要再次触发同步才能补齐父会话记录，且会永久丢失实时采集的 `attemptTiming` 计时数据。
- **延续以 `parentSession` 存在即判定子代理，靠前端额外特判过滤** —— 放弃：违背宿主 `SessionHeader` 契约，会在服务端 `buildSessionRows` 与 `resolveSessionScope` 中持续把历史普通 fork 的费用合并到原会话名下。

## Consequences

- 代价：未重写标题或早期报错的 fork 在同步时仍需多一次范围 `read(0, N)`；旧账本错归行与重复行的清理依赖用户执行一次「全量扫描同步」（沿用启动路径不对账原则）；`SyncResult` 新增可选 `reassigned` 计数（为 0 时省略）。
- 换来：Fork 会话在 SQLite/JSONL、新旧宿主与实时/回填两条链路上均无重复计费且不误归属；历史普通 fork 不再被错误折叠进父会话；已有受损账本经一次全量同步即可自动清理重复行并保留实时计时地修复归属。
