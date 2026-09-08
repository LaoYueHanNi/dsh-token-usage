# dsh 宿主升级兼容性分析：0.1.2-rc.1 → 0.1.3-alpha.2（master）

> 分析对象：`@laoyuehanni/dsh-token-usage` 0.4.2 插件（当前声明兼容宿主 `^0.1.2-rc.1`）
> 宿主区间：`dsh-v0.1.2-rc.1` → `upstream/master`（`D:\Code\deepseek-harness`，约 80 个主干提交 / 777 个全量提交）
> 发布线：npm `alpha` dist-tag = **0.1.3-alpha.2**，已包含区间内全部三个 `!` 破坏性提交；alpha.2 之后的 133 个 master 提交（sidebar/dockkit/files/fs 等）经核对无插件相关破坏
> 结论日期：2026-09（分析用宿主 master@c389f96bf3）

## 结论速览

| 档位 | 条目 | 内容 | 插件需要做的 |
|---|---|---|---|
| **A（必须改）** | A1 | `ctx.sessionPersistence` 服务面 handle 化重构 | 改 `src/sync.ts` 接口与调用 + `src/index.ts` 传入点 + 4 个测试文件的假件 |
| **B（行为差异）** | B1 | 会话格式 v0→v2 自动迁移 | 无需改，知晓读取变慢 |
| | B2 | 失败/中断尝试新增 `assistant/attempt` 事件 + 迁移 seq 稠密重映射 | `failure:`/`compaction:` requestId 可能漂移，低频重复行，知晓 |
| | B3 | `assistant/message` 新增必填 `stream` 字段 | 无需改（插件不读 stream） |
| | B4 | crash 遗留 turn 由 resume 追加 `turn/end {interrupted}` | 无需改（只认 `error` kind） |
| | B5 | 宿主 session-stats 投影改流级 first-token 语义 | 无需改，TTFT/速度数值可能微变 |
| **C（无影响）** | — | settings/credentials/webserver/llm/compaction/llm-retry 服务面、client 插槽与 ISessions、locale/slots、patch 挂载机制、模块表契约、DSH_HOME、HTTP 路由约定 | 零改动 |

---

## A1（唯一必须改）：`ctx.sessionPersistence` 从 inspect/list 改为 handle-based seam

**宿主变更点**：`bec6805d6a refactor(session-persistence)!: handle-based seam with a lifecycle-owned write path`
（配套：`c58097a826` jsonl 跨进程写所有权租约、`ec2f63dbdb` 流式迁移发布、`9b78f99dec` 读取冻结化；均已在 0.1.3-alpha.2 内）

### 新旧 API 对照（以宿主源码为准）

| 职责 | 0.1.2-rc.1（旧） | 0.1.3-alpha.2+（新） |
|---|---|---|
| 列举会话 | `list(signal?) → Promise<SessionHeader[]>`（元素直接有 `id`） | `list(options?: {signal?}) → Promise<readonly SessionPersistenceSnapshot[]>`，元素 `{ header: SessionHeader, revision, eventCount?, sizeBytes? }`——**id 在 `snapshot.header.id`** |
| 读单个会话 | `inspect(id, signal?) → Promise<SessionInspection>`（`{ meta, inheritedEventCount, events }`） | **已删除**。替代：`open(id, 'read'|'write', options?) → SessionHandle`，`handle.read(offset?, length?, options?) → Promise<{ eventState, events }>`，`handle.header`（即旧 `meta`），`handle.close()`（AsyncDisposable） |
| 其余 | `load/prepare/append/borrowSession/readFrom/locate/readRaw/ensureMaterialized` | 全部移除；服务级只剩 `create/open/flush/stat/list` |

### 插件受影响位置（均已定位）

1. `src/sync.ts:83-92` — `SyncPersistence` duck 接口声明（`list(signal?)` / `inspect(id, signal?)`）
2. `src/sync.ts:142` — `deps.persistence.list(signal)`：参数位置与返回元素形状双变
3. `src/sync.ts:160` — `deps.persistence.inspect(session.id, signal)`：方法不存在，**运行期 TypeError**；且会被 syncHistory 的 try/catch 吞成「单会话不可读」，表现为**全量回填 0 added、N failedSessions**，比直接崩溃更隐蔽
4. `src/index.ts:521`、`src/index.ts:751` — `syncHistory({ persistence: ctx.sessionPersistence, … })` / `autoSyncIfNeeded` 传入点（类型不匹配 → 编译失败，因为 d.ts 已随依赖升级）
5. 测试假件：`tests/sync.spec.ts`（fakePersistence、persistenceWithFailures、两处手写 SyncPersistence）、`tests/integration.spec.ts`、`tests/quota-integration.spec.ts`、`tests/stats-route.spec.ts` 中的 `list()/inspect()` stub

### 建议兼容改法（改造面收敛在 sync.ts 一个文件 + 测试）

保持 `SyncPersistence` 鸭子接口与 `syncHistory` 主流程不变，仅重写实现面：

```ts
export interface SyncPersistence {
  /** 新面：list({ signal })，元素取 header.id */
  list(options?: { signal?: AbortSignal }): Promise<readonly { header: { id: SessionId } }[]>
  /** 新面：open(id, 'read') → handle.read()；meta 从 handle.header 投影 */
  open(
    id: SessionId, access: 'read',
    options?: { signal?: AbortSignal },
  ): Promise<{
    header: { cwd?: string; origin?: 'subagent'; parentSession?: SessionId }
    read(): Promise<{ events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
}
```

`syncHistory` 内对应改造：

```ts
const snapshots = await deps.persistence.list({ signal })
const total = snapshots.length
for (const snapshot of snapshots) {
  const id = snapshot.header.id
  signal?.throwIfAborted()
  let inspection: { events: readonly SessionEvent[]; header?: { cwd?: string; origin?: 'subagent'; parentSession?: SessionId } }
  let handle: Awaited<ReturnType<SyncPersistence['open']>> | undefined
  try {
    handle = await deps.persistence.open(id, 'read', { signal })
    const { events } = await handle.read()
    inspection = { events, header: handle.header }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
    failedSessions += 1
    processed += 1
    deps.onSessionFailure?.(id, error)
    onTick?.({ processed, total, added, skipped, failedSessions })
    continue
  } finally {
    await handle?.close().catch(() => {})   // best-effort：close 失败不掩盖读结果
  }
  // 后续算法不变；meta 字段改从 inspection.header 取（字段名 cwd/origin/parentSession 与旧 meta 一一对应）
}
```

要点：
- `open(id, 'read')` **不持有写所有权**，与宿主写句柄可并行，适合只读回填；
- 新 `list` 的 signal 改为 `{ signal }` 选项对象，不再支持位置参数；
- 不存在会话抛 `SessionPersistenceNotFoundError`（已从包导出），沿用现有 `onSessionFailure` 失败计数路径；
- `handle.read()` 无参 = 从 seq 0 读全量，与旧 `inspect` 返回等价；
- 测试假件按新接口形状重写（`list → [{ header: { id } }]`、`open → { header, read, close }`）。

---

## B 档：不改也能跑，但行为/数据有差异

### B1. 会话格式 v0 → v2 自动迁移
- `SESSION_FORMAT_VERSION` 从 **0**（rc.1）升到 **2**（master；`feat(session)!: add released format migration` d1521ea783、`feat(session)!: embed assistant streams in format v2` f99b06eaed，官方 v0→v1、v1→v2 迁移包 + jsonl 后端流式迁移发布）。
- 老日志（`session.jsonl.zstd`）文件名与 master generation v0 命名一致，读访问时**惰性流式迁移**（只解码不落盘）；写访问才发布 `session.v2.jsonl.zstd`，源文件保留。
- 插件感知：历史回填读到的逻辑事件流统一为 v2 形状；`assistant/chunk` 事件消失（内嵌进 `assistant/message.stream`），插件从不读 chunk，无影响。读取耗时略增、个别损坏边界会话被宿主跳过（插件已有 failedSessions 容错）。
- **关键核对**：插件依赖的全部事件载荷在迁移后保留——`assistant/message`（message.id / message.source.model / usage?）、`turn/end`（reason.error.code）、`llm/retry`（failure.code）、`compaction/summary`（usage / model）、`request/context`（provider/model）；`TokenUsage`/`LlmFailure`/`AssistantMessage` 类型逐字段无差异。

### B2. requestId 漂移风险（低频重复行）
- 两个来源叠加：① v2 起失败/中断且无可见内容的尝试一律落 `assistant/attempt` 事件占用 seq；② v1→v2 迁移对幸存事件做 seq 稠密重映射。
- 插件 `failure:<session>:<seq>`（usage-record.ts:154）与 `compaction:<session>:<seq>`（:125）以 seq 构成 requestId；升级后手动 full sync 重扫同一日志会得到新 seq → 新 requestId，与旧 JSONL 行不撞 → 同一失败/压缩理论上落两条行（低频；`assistant` 行 requestId=message.id，稳定不受影响）。
- 建议：知晓即可；如需严格去重可在升级后按 `(sessionId, event.time)` 折叠一次数据文件。live 监听无此问题（同一 seq 只发一次）。

### B3. `assistant/message` 事件新增必填 `stream` 字段
- v2 事件内嵌完整 `AssistantStreamRecord[]`（紧凑 run 编码），体积/内存略增；同时该事件不再允许 `sourceEventSeqs`。插件只读 message/usage，无感。

### B4. crash 遗留 turn 由 agent-loop resume 追加 `turn/end {kind:'interrupted'}`
- 插件 `recordFromTurnEnd` 只认 `kind === 'error'`，interrupted 自然忽略。知晓即可。

### B5. 宿主 session-stats 投影 first-token 语义变化
- 宿主投影从逐 `assistant/chunk` delta 改为流级 `assistantStreamFirstTokenTime`；`SessionStatsProjection` 类型字段零变化，插件 `src/client/session-stats.ts` 无需改；UsageView 的 TTFT/速度数值在升级后可能与旧版有轻微差异，回归时对照即可。

### B6.（信息级）连接恢复循环改造
- `ConnectionConfig`→`ConnectionRecoveryConfig`、`ctx.connection.start()` 参数面改动。插件只声明 inject 'connection' 不调用其 API，零影响。

---

## C 档：已逐一核实无影响

| 面 | 证据 |
|---|---|
| `dsh-settings` / `dsh-credentials` / `dsh-host-webserver` / `dsh-llm` / `dsh-compaction` / `dsh-llm-retry` | 区间内 **src 零变更**（仅版本号），`installSection(ctx, ns, schema, entry, hooks)`、`get(ns)`、`credentialRef`、`resolve`、`readRecord`、`WebRoute`/`register`、`TokenUsage`/`LlmFailure.code`、`listConfigurableProviders()`、`compaction/summary`、`llm/retry` 全部原样 |
| `ctx.sessions` / `Session` 类 | `sessions.list()`、`session.snapshotEvents()`、`session.header`（cwd/origin/parentSession）签名不变；inject 名 `'sessions'`/`'sessionPersistence'` 保留 |
| `session/event` 触发语义 | `Session.append` 仍为深冻事件 → log.push → 同步广播 `(session, event)`，每条 append 必发（core/session/src/index.ts:704-719 与 rc.1 同构） |
| client 插槽 | `settings.section` / `conversation.view` / `conversation.session.header.utilities` / `conversation.input.right` / `settings.plugin.item` 契约全保留；新增 `conversation.session.header.corner` 空槽不冲突 |
| `ISessions` | `contract/sessions.ts` 零 diff：`list.getSnapshot().byId`、`open()`、`SessionSummary`（displayTitle/parentId/origin/updatedAt/projectionValues）不变；`PendingSubmission.images→attachments` 仅影响提交生命周期，插件不消费 |
| `locale` / `ui-slots` / `ui-renderer` / `ui-settings` / `ui-settings-plugins` / `ui-workspace` / `ui-primitives` / `ui-model-selection` | `register(ns, {zh,en})`、`bind`、`TranslateNS`、`LocaleNamespaceMap` 合并、`SettingsScope`/`bind({namespace})`、`pickDirectory()`、`Tooltip`/`IconChevronDownOutline14` 全保留；ui-slots 仅**新增**空白 `ResourceProtocolMap` 合并点 |
| 插件挂载机制 | `fix(boot): normalize absolute plugin paths in patches`（master 未发布部分）只把绝对路径 patch name 纳入 file URL 归一；插件的 `name: 'dsh-token-usage'` 裸包名原样解析；`dsh plugin add` 的 `dsh.bundle.patch` 判定逻辑两版一致；`dsh.client.inject` 解析、`exports["./client"]`、`/plugins/<id>/client.js`、`window.__ModuleLoader__.load({id, factory})` 契约未变 |
| 数据目录 / 环境变量 | `DSH_HOME` 解析（显式 > $DSH_HOME > ~/.dsh）无源码 diff；`SESSION_FORMAT_VERSION` 是构建期常量非环境变量 |
| HTTP 路由约定 | `packages/host/webserver/src` 零 diff；browser-transport `/api` 保留、RPC 表仍封闭；插件自有路由（/token-usage/*）走普通同源 fetch 不受影响 |

---

## 兼容意见（落地建议）

1. **升级依赖声明**：四个 peer/dev 直连包中与本次破坏相关的版本抬到宿主实际发布版：
   - 最小必要：`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-persistence` → `^0.1.3-alpha.2`（建议全部 `@deepseek-ai/*` devDependencies 一并抬齐，保持安装一致性；peerDependencies 的 `dsh-credentials`/`dsh-settings` 可抬可不抬——两者服务面零变更，抬是为了与宿主解析一致）。
2. **代码改造范围（收敛）**：`src/sync.ts` 一个文件（SyncPersistence 接口 + syncHistory 的 list/inspect 两处）+ 4 个测试文件的假件。`src/usage-record.ts`、`src/index.ts` 的业务逻辑（除传入点类型随接口自然更新外）**零改动**。改造方式见 A1 的适配层草案。
3. **升级后在宿主上的回归清单**：
   - 首次启动自动回填（`initializedAt` 门后手动 full sync 触发一次即可验证 A1 修复）；
   - 手动 full sync 的 added/skipped/failedSessions 计数与升级前对照；
   - UsageView 的 TTFT/速度数值（B5 流级语义）；
   - 会话表身份字段（cwd/子代理分类/父会话）——A1 改法漏取 `handle.header` 会全丢，务必回归；
   - 目录迁移（relocateTo）流程与断连恢复期间的 stats 路由刷新。
4. **B2 重复行**：不阻塞；若在意可在升级 changelog 里注明（future: 可加一次按 (sessionId, event.time) 的一次性折叠）。
5. **版本与提交**：本次仅为分析，未改 package.json、未提交；实施修复时按仓库既有约定（oyw-commit-style + docs/decisions 决策记录）处理。
6. **未来窗口**：宿主 master（0.1.3-alpha.2 之后）还有 133 个未发布提交，均为新功能/UI/文件系统增量，未见插件相关破坏；如宿主进入正式版（0.1.3 或 0.2.0），应先复查一次本报告 A1 的修复是否仍适用（持久化面已稳定，预期不变量低）。

## 附录：关键证据提交

- `bec6805d6a` refactor(session-persistence)!: handle-based seam — A1 源头（已在 0.1.3-alpha.2）
- `f99b06eaed` feat(session)!: embed assistant streams in format v2 — B1/B3/assistant/attempt（已在 0.1.3-alpha.2）
- `d1521ea783` feat(session)!: add released format migration — B1/B2（已在 0.1.3-alpha.2）
- `c58097a826` feat(session-persistence-jsonl): cross-process write-ownership lease（已在 0.1.3-alpha.2）
- `15e444e0d7` fix(boot): normalize absolute plugin paths in patches — C 档（master 未发布部分）
- npm dist-tags：`alpha: 0.1.3-alpha.2`、`next: 0.1.2-rc.1`、`latest: 0.0.1-rc.1`（旧线）