# DR: 兼容宿主 dsh 0.1.3-alpha.2（sessionPersistence 句柄面适配 + 会话格式 v2 迁移）

Status: proposed

## Problem

宿主 npm 已发布 `0.1.3-alpha.2`，相对插件兼容的 `0.1.2-rc.1` 包含三个 `!` 破坏性提交：`session-persistence` 句柄化重构（`bec6805d6a`）、会话格式 v2 内嵌 assistant 流（`f99b06eaed`）、released format migration（`d1521ea783`）。`2026-09-04` 迁移记录已预告"宿主 master 的句柄面尚未覆盖，下次 npm 发布含该重构时需再迁一次 persistence"——本次即那次预告的迁移。

破坏面（已基于宿主源码逐项核对）：

1. **`ctx.sessionPersistence` 服务面重做**：`list(signal?) → SessionHeader[]` 改为 `list({signal}) → SessionPersistenceSnapshot[]`（id 移到 `snapshot.header.id`）；`inspect(id, signal?)` 被**删除**，替代为 `open(id, 'read'|'write') → SessionHandle` + `handle.read(offset?, length?) → {events, eventState}` + `handle.close()`；`load/prepare/append/borrowSession/readFrom/locate/readRaw` 一并移除。
2. **隐蔽失败模式**：插件 `src/sync.ts` 的 `SyncPersistence.inspect` 调用在新宿主上抛 TypeError，但会被 `syncHistory` 的 try/catch 当成"单会话不可读"吞掉——回填表现为 `0 added + N failedSessions`，不直接崩溃，排障成本高。
3. **会话格式 v0→v2 自动迁移**：老日志读时惰性迁移（写访问才发布 v2 文件），`assistant/chunk` 事件消失（内嵌进 `assistant/message.stream` 或转为新事件 `assistant/attempt`）；v1→v2 迁移对幸存事件做 seq 稠密重映射。
4. **B 档行为差异**：`assistant/attempt` 事件占用 seq + seq 重映射 → 插件的 `failure:<session>:<seq>` / `compaction:<session>:<seq>` requestId 在升级后漂移（低频重复行）；`assistant/message` 新增必填 `stream` 字段（体积增大）；crash 遗留 turn 由 resume 追加 `turn/end {kind:'interrupted'}`；宿主 session-stats 投影改流级 first-token 语义（TTFT 数值可能微变）。

已核对**不受影响**的面：settings / credentials / host-webserver / llm / compaction / llm-retry 服务面在区间内 src 零变更；`session/event` 触发语义、`Session.snapshotEvents()`、client 全部插槽（settings.section / conversation.view / conversation.session.header.utilities / conversation.input.right / settings.plugin.item）、`ISessions.list.getSnapshot().byId`/`open()`、locale/slots、patch 挂载机制与 `dsh.client.inject` 模块表契约、`DSH_HOME` 解析、HTTP 路由约定——全部保留。插件记账所需载荷（`TokenUsage`、`LlmFailure.code`、`AssistantMessage`、`compaction/summary` 的 usage/model、`llm/retry` 的 failure.code）逐字段无差异。

## Proposal

1. **`src/sync.ts` 内部适配（改造收敛点）**：`SyncPersistence` 接口改为新面——`list(options?: {signal?}) → [{header: {id: SessionId}}]`、`open(id, 'read', options?: {signal?}) → { header, read(): Promise<{events}>, close() }`；`syncHistory` 主流程与鸭子结构保持（遍历、跳过、计数、metadata 折叠逻辑不变）：`list({signal})` 取 `snapshot.header.id`，读单会话 `open(id, 'read', {signal})` → `handle.read()`（无参读全量）→ `finally { handle.close() }`（best-effort），`meta` 从 `handle.header` 投影 `cwd/origin/parentSession`。读句柄不持有写所有权，与宿主写句柄可并行。
2. **测试假件同步**：`tests/sync.spec.ts`（fakePersistence / persistenceWithFailures / 手写 SyncPersistence）、`tests/integration.spec.ts`、`tests/quota-integration.spec.ts`、`tests/stats-route.spec.ts` 的 `list()/inspect()` stub 按新形状重写；新增 open/read/close 泄漏断言（每会话必 close）。
3. **依赖版本**：devDependencies 与 peerDependencies 的 `@deepseek-ai/*` 统一 `^0.1.3-alpha.2`（settings/credentials 服务面零变更，抬齐是为了与宿主解析一致）。不 bump `package.json` version。
4. **B2 重复行**：不阻塞；如需严格去重，另立独立提交按 `(sessionId, event.time)` 对 failure/compaction 行做一次折叠。
5. 业务源码（`usage-record.ts` 投影、stats 路由、client 半边）零改动。

## Alternatives considered

- **双版本特性检测（inspect 与 open/read 并存的运行时分支）** —— 宿主已断代：0.1.2-rc.1 的 npm 线不会再获得新用户安装（peer 解析 `^0.1.2-rc.1` 在 alpha.2 宿主上直接解析到 alpha.2）。长期维护两条持久化读取路径不值，与 `2026-09-04` 迁移否决双版本检测同款理由。否决。
- **停留 0.1.2-rc.1 不升级** —— 新宿主上插件回填静默失败（见 Problem 2），且随版本漂移积压迁移成本。否决。
- **依附 revision/stat 做增量同步替代全量重扫** —— 插件 dedupe 语义依赖逐行 requestId 对比，revision 只适合有状态投影缓存；语义不匹配。否决（记为未来优化项）。
- **改 requestId 规则消除 B2 漂移（如改用稳定键）** —— seq 在迁移后漂移是宿主事实；改键会破坏与旧 JSONL 行的对应关系，且重复行低频（仅 failure/compaction，assistant 行以 message.id 为键不受影响）。否决。

## Acceptance criteria

1. 依赖升到 `^0.1.3-alpha.2` 后 `tsc --noEmit` 零错误；`vitest run` 全绿（新假件形状）。
2. 在 0.1.3-alpha.2 宿主上：首次启动自动回填 `added > 0`、`failedSessions = 0`（老 v0 日志自动迁移后读取正常）。
3. 手动 full sync 的 added/skipped/failedSessions 计数与升级前基线对照一致（B2 可解释的少量重复行除外）。
4. 会话表身份字段（标题 / cwd / 子代理分类 / 父会话）升级后仍正确——专门回归 `handle.header` 投影未漏。
5. UsageView 的 TTFT / 速度数值与升级前对照，差异在 B5 流级语义可解释范围内。
6. 目录迁移（relocateTo）与 quota/定价路由流程回归通过。

## Risks

- **`handle.header` 漏取**：鸭子类型下无编译期告警，会话表身份字段（cwd/子代理/父会话）会整体丢失。缓解：验收标准 4 专门覆盖；适配层显式投影字段并注释来源。
- **错误语义差异**：`open` 对不存在会话抛 `SessionPersistenceNotFoundError`（包已导出），与旧 `inspect` 的失败路径可能不同；`handle.close()` 失败不应掩蔽读结果。缓解：`finally` + best-effort close；沿用 `failedSessions` 计数。
- **迁移读取变慢**：v0→v2 惰性迁移在首次回填时执行，超大会话读取耗时上升；损坏边界会话被宿主拒读（与旧行为一致，走跳过路径）。
- **事件体积**：v2 事件内嵌完整 stream，超大会话的回填内存占用上升。
- 主动放弃：不做 inspect/open 兼容垫片（放弃 0.1.2-rc.1 及以下宿主）；不做 revision 增量同步；不做 B2 一次性折叠（独立提交可选）。