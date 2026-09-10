# DR: 兼容宿主 dsh 0.1.5-rc.1（sessionPersistence 双 seam 运行时探测 + 会话格式 v3 免改）

Status: implemented

## Problem

插件运行在已发布的宿主 `@deepseek-ai/dsh@0.1.5-rc.1` 上（本机实测安装版本；git tag `dsh-v0.1.5-rc.1` = `183f08e9c6`），而 `package.json` 的 `@deepseek-ai/*` 声明与本地类型仍停在 `0.1.2-rc.1`，`src/sync.ts` 也仍走 `0.1.2-rc.1` 的 persistence 面。

`0.1.2-rc.1 → 0.1.5-rc.1` 区间共 1486 个提交，其中 `!` 破坏性提交只有三个，全部落在 persistence 与会话格式上：

1. `bec6805d6a refactor(session-persistence)!: handle-based seam`（0.1.3-alpha.1 起）—— `ctx.sessionPersistence` 服务面重做：`list(signal?) → SessionHeader[]` 改为 `list({signal?}) → SessionPersistenceSnapshot[]`（id 移到 `snapshot.header.id`），`inspect(id, signal?)` **被删除**，替代为 `open(id, 'read'|'write', options?) → SessionHandle` + `handle.read(offset?, length?, options?) → {events, eventState}` + `handle.header`（即旧 `meta`）+ `handle.close()`；`load/prepare/append/borrowSession/readFrom/locate/readRaw` 一并移除。
2. `f99b06eaed feat(session)!: embed assistant streams in format v2`。
3. `d1521ea783 feat(session)!: add released format migration`。

破坏的形态是隐蔽的：`src/sync.ts` 的 `inspect` 调用在新宿主上抛 TypeError，却被 `syncHistory` 的 try/catch 当作"单会话不可读"吞掉——全量回填表现为 `0 added + N failedSessions`，不崩溃；而首次安装的自动同步由一个已写入的标记门控，平时无感，只有手动全量同步才会暴露。

另有一处**未被标记为破坏**的演进落在 `0.1.3-alpha.2 → 0.1.5-rc.1` 的 842 个提交里：`SESSION_FORMAT_VERSION` 2 → 3（`packages/core/session/src/types.ts:88`，v2→v3 迁移包自 `dsh-v0.1.5-alpha.1` 起存在）。v3 把系统提示从 `request/header.data.header.system` 提升为 `system/message` surface 事件（`EpochHeader.system` 退役），并因此整体重排 seq。

> 前一轮针对 `0.1.3-alpha.2` 的提案（升依赖到 `^0.1.3-alpha.2` 并把 `sync.ts` 单面改成 handle 面）未实施即被本记录取代；其 handle 面对照与行为差异清单已并入本记录。

## Decision

1. **`src/sync.ts` 做双 seam 运行时探测**，一份构建同时服务两代宿主：`readerOf(persistence)` 每次 sync 探测一次——有 `open` 走 handle 面（`open(id,'read') → handle.read() → finally close()`，close 为 best-effort，失败不掩盖读结果），否则回落 `inspect` 面；两者都无则抛明确错误，而不是把整机不匹配报成 N 个不可读会话。`list` 的调用形状按 seam 分派（handle 面 `list({signal})`，旧面 `list(signal)`），元素 id 以 `'header' in entry` 归一，`meta` 从 `handle.header` 投影。
2. **依赖声明不动**：peerDependencies 与 devDependencies 的 `@deepseek-ai/*` 保持 `^0.1.2-rc.1`。peer 不参与运行时解析（`cordis-plugin-loader` 的 require-builtins 把裸导入转发到宿主树，见 [官方依赖改 peer](./2026-08-27-official-deps-as-peer.md)），devDeps 只决定本地编译期类型，而双 seam 鸭子接口正是为独立于任一版本的类型面而写。
3. **会话格式 v3 不改代码**：插件读取的六类事件（`assistant/message`、`turn/end`、`llm/retry`、`compaction/summary`、`request/context`、`session/title`）在 v3 中事件名与载荷字段零变化；v0/v1/v2 旧日志由宿主读路径惰性迁移（只解码不落盘），插件看到的一律是当前代的逻辑事件流。**多代文件并存同样由宿主解析**：`resolveGenerationInDirectory` 收集一个会话目录内所有合法代次文件名（v0 = `session.jsonl[.zstd]`，vN = `session.vN.jsonl[.zstd]`，规则见 `dsh-session-format` 的 filename 模块）并取数值最高者，所以未迁移的老会话照常列出并按 v0 读取，已迁移的会话选 v3 而不产生重复；`list` 与 `open` 共用这一解析，列举与打开不会错配。插件从不直接读 jsonl 文件，对文件代次完全无感。
4. **测试**：`tests/sync.spec.ts` 新增 handle 面假件与 6 个用例（走通并断言每会话一次 close、`handle.header` 投影进 meta sink、close 失败不掩盖读结果、open 失败计入 failedSessions 且不中断、双 seam 并存时优先 handle、双无则报错）；既有 `inspect` 假件全部保留，正好继续覆盖旧 seam。
5. 不 bump `package.json` version。

## Alternatives considered

- **单面适配（只支持 handle 面，放弃旧宿主）** —— 前一轮提案的选择。输在：本次改动同样收敛在一个文件，多做一次运行时分支的成本极小，而单面适配让插件在 `0.1.2-rc.1` 及更早宿主上直接失去回填能力；且 `^0.1.2-rc.1` 声明在 semver 上本就不匹配 `0.1.5-rc.1`（见下条），"跟随宿主"并没有换来更干净的声明。否决。
- **把 peer/devDependencies 抬到 `^0.1.5-rc.1`** —— 输在两点。其一，semver 的 prerelease 规则要求候选版本与某个比较器同 `major.minor.patch` 才允许匹配：实测 `^0.1.2-rc.1` 不匹配 `0.1.5-rc.1`（也不匹配 `0.1.3-alpha.2`），而 `*`、`>=0.1.2-rc.1 <0.2.0` 同样不匹配任何 prerelease——**没有任何通配范围能覆盖预发布线**，抬版本只是把"不匹配"换成"只匹配这一代"。其二，如 [官方依赖改 peer](./2026-08-27-official-deps-as-peer.md) 所记，peer 不决定运行时解析，抬高它换不来运行时收益，却丢掉对旧宿主的兼容声明。若将来确需一条声明同时覆盖两代，唯一写法是 `^0.1.2-rc.1 || ^0.1.5-rc.1` 这类显式枚举（本次未采用：枚举会随每个宿主预发布版本增长）。
- **保持 `inspect` 不改、等宿主正式版** —— 新宿主上回填已是静默失败，且被 `failedSessions` 计数掩盖，等待只会让排障成本继续累积。否决。
- **为两代各装一份 persistence（条件导入 / 双依赖树）** —— 运行时本来就只有宿主树一份模块实例，装两份既解决不了 API 面问题，又引入双份存盘。否决。
- **改 requestId 规则以消除 v3 的 seq 漂移** —— 漂移只影响 failure/compaction 两类低频行，而 seq 在迁移后改变是宿主事实，改键会破坏与既有 JSONL 行的对应关系。否决。

## Consequences

- 代价：`sync.ts` 多一条 seam 分支与一个 `SessionReader` 归一化层；新增用例只覆盖 handle 面（旧面由既有 `inspect` 假件覆盖），两代宿主各自需要一次真机回归。
- 代价：**v3 的 seq 重排会让 `failure:<session>:<seq>` / `compaction:<session>:<seq>` 两类 requestId 漂移**（`src/usage-record.ts:125`、`:154`），宿主升级后手动全量同步可能对同一失败/压缩落两条行（低频；`assistant` 行以 `message.id` 为键，不受影响）。本轮不改键；陈旧行的清理见后续 [对账式扫描](./2026-09-10-scan-reconciles-stale-ids.md)。
- 代价：v2→v3 迁移是**严格审计**式的——宿主对未分类事件与未知内容种类直接拒绝（`dsh-session-format-v2-to-v3` 的分类白名单），该会话随即**整体不可读**，插件把它计入 `failedSessions` 跳过。升级后首次全量同步出现少量 `failedSessions` 属预期而非插件缺陷；定性要按 `onSessionFailure` 打出的会话 id 逐个看，且只列出不等于读得出。
- 代价：声明与实际宿主不一致的事实保留——`^0.1.2-rc.1` 在 semver 上不匹配 `0.1.5-rc.1`，`dsh plugin add` 的 pnpm 输出里会出现 unmet-peer 警告（与既有的 cordis 警告同类，属预期噪音）。
- 代价：devDependencies 不升，本地 `typecheck` 跑在 `0.1.2-rc.1` 的类型面上，新 seam 的编译期校验缺位——由 handle 面测试假件（形状真实、且刻意不提供 `inspect`）在运行期补上。
- 换来：一份构建同时覆盖 `0.1.2-rc.1` 与 `0.1.5-rc.1` 两代宿主，历史回填在两代上都能工作；声明的最低依赖维持不变；`tsc --noEmit` 零错误、`vitest run` 650 项全绿。
- 换来：会话格式 v0→v3 的演进零成本——迁移链由宿主负责，插件继续只读逻辑事件流。
