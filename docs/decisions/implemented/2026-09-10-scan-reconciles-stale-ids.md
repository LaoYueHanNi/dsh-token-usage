# DR: 扫描改为对账式（跳过 / 写入 / 删除）

Status: implemented

## Problem

宿主把会话日志迁到新格式代次时会重排事件 `seq`。插件的失败行 / 压缩行用 `failure:<sid>:<seq>` / `compaction:<sid>:<seq>` 当 requestId（见 [失败请求跟踪](./2026-09-03-failure-request-tracking.md)、[compaction 计费](./2026-09-02-compaction-billing.md)）。同一事件在新代次下得到新键，去重失效：全量同步把旧行当「已有」跳过、把新键当「新增」写入——账本出现强重复。

实测（dsh 0.1.5-rc.1、数据目录由 `token-usage.path` 指到 `E:\Documents\dsh`）：**(sessionId, time, kind, model, code) 全同、仅 requestId 不同** 的强重复 **134 组**（130 组 failure + 4 组 compaction，涉及 28 个会话）。对照例：`failure:…:11183` 与 `failure:…:139` 是同一事件。assistant 行以 `message.id` 为键，不受 seq 重排影响。

[0.1.5-rc.1 适配](./2026-09-10-migrate-to-dsh-0-1-5-rc-1.md) 已记下这一漂移并明确「本轮不改键」。扫描本身仍是单向 append + 按 id 跳过，没有删除通道，陈旧行会永远留在 day 文件里。

## Decision

手动全量扫描改为对账：对每个可读会话，读到的记录若已在账本里则跳过、若不在则写入；全部可读会话读完后，账本里该会话有、会话日志没有的行删除。进度与结果展示三种计数：跳过、写入、删除。

落地（`src/sync.ts` / `src/usage-log.ts`）：

1. 扫描前 `log.ids()` 拍一张已保存 id 快照（`eligible`）——走读途中 live 写入的行不在快照里，对账不得删。
2. 走读时收集 `reproduced`（本轮读出的全部 requestId，无论写入还是跳过）和 `readable`（读成功的会话 id）。读失败的会话不计 `readable`。
3. 走读结束后 `log.reconcile(keep, readableSessions, eligible)`：只删同时满足「在 eligible 里」「不在 keep 里」「`owners` 指向的会话属于 readable」的行。畸形 JSONL 行不是候选，留在原文件。按日文件原子重写，走 append 队列。
4. **只删已完整读取的会话的陈旧行**，不是「会话不在 `list()` 里」的行。宿主 `list()` 有一条静默跳过路径（头部格式不支持的会话不进列表；0.1.5-rc.1 上 27 个 v0 `subagent/descriptor version 2` 被迁移拒绝即此列），删孤儿行不可逆。已读失败 / 未列出的会话，其行一律保留。
5. **启动路径不对账**：`autoSyncIfNeeded` 传 `reconcile: false`。首次安装账本是空的，无陈旧行可删；对账会拖长 `syncHistory`，使 `markInitialized` 写 `state.json` 落到数据目录迁移之后，把已删的旧目录重建出来（已实测）。手动全量扫描才是清理入口。
6. `reconcile` **故意不调 `ensureDir`**：队列里还挂着对账时目录可能已被迁移删掉，`mkdir` 会把空目录造回来。缺目录 = 无文件可对账，`readdir` 报错即返回 0。
7. `removed` 进入与 `failedSessions` 相同的三处形状（`SyncResult` / `SyncProgressTick` / `FullSyncView` 的 `running` / `done`，见 [跳过无法解析的会话](./2026-09-03-sync-skips-failed-session.md)）；卡片进度与结果恒显示「删除 {removed} 条」（中英双语，与新增 / 跳过同为三种对账结果，不像失败会话那样「出现了才看见」）；旧宿主响应缺字段读 0。`added > 0 || removed > 0` 都 `invalidateDerivedState`。
8. 不改 requestId 规则，不 bump version。

## Alternatives considered

- **改 requestId 为跨代次稳定键**（failure 用 `retryId+retry` / `turn` 身份，compaction 用 `compactionId`）—— [compaction 计费](./2026-09-02-compaction-billing.md) 已否决 `compactionId`（无校验 opaque string，唯一性依赖后端 mint）；failure 的 `llm/retry` 与 `turn/end` 也没有一份宿主保证跨格式代次稳定的联合键。改键让已写入的 JSONL 全部对不上，等于强制再做一次全量身份迁移，而 seq 重排是宿主事实、以后每个格式代次都可能再来。否决：键保持 seq，用对账删陈旧行。
- **只折叠不换机制**（按 `(sessionId, time, kind, model, code)` 合并，保留一条）——能清掉这 134 组，但：(1) 不是幂等的扫描语义，下次代次迁移仍会写出新键，折叠要再跑；(2) time 碰撞（同毫秒两条真失败）会误合并；(3) 折叠发生在统计层还是磁盘层都要另做一套，和「扫描即账本权威」分叉。否决。
- **会话不在 `list()` 里就把该会话的行全删** —— `list()` 静默跳过不可读头部，那 27 个 v0 会话会被当成「已消失」而清掉不可恢复的记账。否决。已读失败同样保留。
- **启动 `autoSyncIfNeeded` 也跑对账** —— 首次安装无陈旧行；对账拖长启动扫描，`markInitialized` 与目录迁移竞态，已实测会重建被删目录。否决。清理只走手动全量同步。
- **对账也 `ensureDir`** —— 与迁移清理对撞，把空目录造回。否决。
- **保持单向 append，靠用户手工删 JSONL** —— 134 组散落在多日文件、按 requestId 不同无法肉眼识别。否决。

## Consequences

- 换来：一次手动全量同步即可清掉 seq 漂移留下的重复行（预期约 134 条删除）；进度条三种计数可观察；不可读 / 未列出会话的行仍在。
- 换来：requestId 规则不变，与既有 JSONL、失败 / 压缩决策兼容。
- 代价：对账要等全部可读会话走完才删，进度条上 `removed` 在走读期间保持 0，最后一跳才跳出。
- 代价：`removed` 进入三处形状与两组文案；旧宿主 + 新卡片读 0。升级后不会自动清理——已有 `initializedAt` 的安装跳过启动扫描，必须用户点一次「开始扫描」。
- 代价：测试侧 `pollGone` 超时 2s→10s。迁移等 append 队列，完整套件并行 + Windows 文件锁下 2s 会超时（该文件 / 该用例单独跑 2s 内通过）；放宽后 `vitest run` 653 项全绿。未再放大超时，也未改迁移去等待启动标记写入。
