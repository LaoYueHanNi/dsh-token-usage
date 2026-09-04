# DR: 迁移宿主 dsh 0.1.2-rc.1（settings 服务方法化 + SessionSeq / snapshotEvents + client 类型链）

Status: implemented

## Problem

插件运行在已发布的宿主 dsh `0.1.2-rc.1`（npm；git tag `dsh-v0.1.2-rc.1` = `a66e470204`）上，而 main 的 `@deepseek-ai/*` 依赖与源码仍停在 `0.1.1-rc.2`。rc.1 与 `0.1.2-alpha.5` tag 消费面源码相同（tag 之间仅版本号 bump），对本插件会编译/运行失败的断代有四处：`dsh-settings` 删除顶层 `installSettingsSection` / `settingsNamespace`，改由 `SettingsProvider.installSection` / `get` 吃普通字符串命名空间；`Session.events` 私有化，替代面是 `snapshotEvents()`；`SessionEvent.seq` 品牌化为 `SessionSeq`；`dsh-client-runtime` 包删除，client 类型链与 `workspaces` inject 悬空。侧分支 `feature/0.1.2-alpha.5` 已验证过这些适配，但其最后一次提交把 persistence 改成了 `open/read/close` 句柄面——那是 alpha.5 tag 之后 master 上的重构（`bec6805d6a`），**不在**已发布 rc.1 里；rc.1 的 `sessionPersistence` 仍是 `inspect(id, signal)` + `list(signal) → SessionHeader[]`。main 在分叉后还领先压缩计费、失败请求、扫描按会话跳过等业务，不能 merge 该分支。

## Decision

在 main 上一次提交手工移植 rc.1 真实面上的适配，不 bump `package.json` version（仍为已发布的 `0.4.0`）：

1. **settings**：`TOKEN_USAGE_NS` 改为字符串 `'token-usage'`；section 注册走 `ctx.inject(['settings'], sctx => sctx.settings.installSection(ctx, ns, …))`；quota 的 `settings.get(ns)` 直接传字符串。
2. **Session 快照**：`countInteractingSessions` 收窄为事件数组的数组；三处调用 `ctx.sessions.list().map(session => session.snapshotEvents())`。
3. **SessionSeq**：测试构造宿主 `SessionEvent` 的 `seq` 走 `SessionSeq()`；JSONL 遗留字段 `seq: 42` 的解析用例不动。
4. **client 类型链**：`ClientContext` 来自 cordis；`SettingsScope*` 来自 `dsh-client-ui-settings/client`；`SessionListState` / `UseProjection` 来自 `dsh-api-session-controller/client`；kit 声明合并来自 `dsh-client-ui-session/client`；`ctx.slots` 来自 `dsh-client-ui-renderer/client`。inject `workspaces` → `uiWorkspace`，`pickDirectory` 走 `ctx.uiWorkspace.pickDirectory()`。`dsh.client.inject` 把 `dsh-client-runtime` 换成 `dsh-client-ui-session`。Usage 视图从未读过 kit 的 `useSession`，从 props 删除。
5. **persistence 不改**：`SyncPersistence` 继续 `list` + `inspect`，保留 main 的 `failedSessions` 跳过。
6. **依赖**：peer/dev 的 `@deepseek-ai/dsh-*` 升 `^0.1.2-rc.1`（含 main 独有的 compaction / llm-retry 镜像）；删 `dsh-client-runtime`；增 `dsh-api-session-controller`、`dsh-client-connection`、`dsh-client-store`、`dsh-client-ui-session`、`dsh-client-ui-renderer`、`dsh-client-ui-workspace`；cordis `^4.0.2`。

## Alternatives considered

- **merge / cherry-pick `feature/0.1.2-alpha.5`** —— 会覆盖 main 领先的压缩计费、失败请求、趋势图等业务，且会把句柄面带进 rc.1 宿主，全量扫描在已装 `inspect` 上崩溃。否决。
- **把 persistence 也改成 `open/read/close`（跟 master / 侧分支最后一次提交）** —— 已发布 rc.1 没有句柄面；那是 tag 之后 99 个 master 提交里的重构。否决：本次目标是 npm 的 0.1.2-rc.1。
- **双版本特性检测（installSettingsSection 与 installSection、inspect 与 open 并存）** —— 宿主已断代，长期两套路径不值；`uiWorkspace` 加入 inject 会让旧宿主上插件整体不启动。否决：main 不再兼容 0.1.1-rc.2。

## Consequences

- 代价：本线仅兼容 0.1.2-rc.1 及以上、且仍是 coordinator/`inspect` 面的宿主；0.1.1-rc.2 上 settings 注册与目录选择不可用。宿主 master 的句柄面尚未覆盖，下次 npm 发布含该重构时需再迁一次 persistence。
- 换来：typecheck / 测试 / 双构建跑在 rc.1 真实类型上；main 的业务提交完整保留；侧分支超前适配不再误导发布。
