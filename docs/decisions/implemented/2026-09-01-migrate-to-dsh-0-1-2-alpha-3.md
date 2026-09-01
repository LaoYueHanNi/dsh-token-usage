# DR: 迁移宿主 dsh 0.1.2-alpha.3（settings 服务方法化 + client 类型链落地）

Status: implemented

## Problem

宿主 deepseek-harness 发布 0.1.2-alpha.3（npm `alpha` dist-tag；alpha.1→alpha.3 区间 351 个提交）。三路比对（host / client / bundle-加载机制）确认对本插件唯一编译期必坏点是 `f4e49ccf8f`（move shared values behind service APIs）：`@deepseek-ai/dsh-settings` 的顶层导出 `installSettingsSection` 与 `settingsNamespace` 整体删除，替代物是 `SettingsProvider` 实例方法 `installSection(owner, ns, schema, entry, hooks)` 与泛型字面量校验的 `get(ns)`——插件 host 半边的 section 注册（`src/index.ts` 的 4 处引用）在新宿主下直接编译失败。此外 `@deepseek-ai/dsh-client-runtime`（alpha.1 已删包）仍被插件 5 处 type-only import 与 `dsh.client.inject` 清单引用，类型链悬空；宿主包 peerDependencies 收敛（`9135a13a8b`）后，插件未显式声明的间接依赖不再由宿主传递提供。其余依赖面经逐项 diff 确认兼容：bundle patch 机制、package.json `dsh` 字段解析、`dsh plugin add` 安装链零变化；session 事件负载（SessionEventMap 逐块 IDENTICAL）、`sessionPersistence.list()/inspect()`、`listConfigurableProviders`/`TokenUsage`、`WebRoute`/`register()`、`credentialRef`、settings 命名空间 schema、`llm-pi-ai/<route>` record key 全部未变或纯增量（`ignorable` 信封为 additive）；`useProjection('sessionStats')` 与 5 个 slot 声明原样；SQLite 持久化后端删除（`4553c9d957`）对只走逻辑 API 的本插件透明。

## Decision

一次提交完成 alpha.1 兼容分支（feat/dsh-0.1.2-alpha.1，其 2026-08-28 记录未合入主线，本提交一并落地该分支预留的第二步）并叠加 alpha.3 增量：

1. **host 侧 settings 迁移**：`installSettingsSection(ctx, NS, …)` → `ctx.inject(['settings'], (sctx) => sctx.settings.installSection(ctx, NS, …))`（hooks 三件套 validate/setSource/onChange 原样，时序语义与新方法一致，官方范本 `packages/llm/llm-deepseek/src/index.ts:487-499`）；`TOKEN_USAGE_NS = settingsNamespace('token-usage')` → 字符串字面量 `'token-usage'`；`ctx.settings.get(ns)` 直接传字符串。`@deepseek-ai/dsh-settings` 导入降为 type-only（保留 `ctx.settings` 声明合并）。
2. **client 侧类型链落地**（alpha.1 实测映射在 alpha.3 逐项复核有效）：`ClientContext` ← `@deepseek-ai/cordis`；`SettingsScope`/`SettingsScopeSnapshot` ← `dsh-client-ui-settings/client`；`SessionListState`/`UseProjection` ← `dsh-api-session-controller/client`；标准会话 kit 声明合并 ← `dsh-client-ui-session/client`，`ctx.slots` 声明合并 ← `dsh-client-ui-renderer/client`（后两者的 npm 产物剥掉了空 type-only 转发，须显式引入）。typecheck 另暴露一处 kit 契约收窄：`SessionStandardProps.useSession` 从 Conversation 快照改为 Session 生命周期快照——Usage 视图从未读过该 seat，直接从 props 删除而非适配。运行时行为沿用 alpha.1 第一步：inject 服务清单 `workspaces` → `uiWorkspace`，`pickDirectory` cast 调用，`dsh.client.inject` 包清单 `dsh-client-runtime` → `dsh-client-ui-session`。
3. **依赖对齐**：devDependencies 全量切 `^0.1.2-alpha.3`，删除 `dsh-client-runtime`，新增 `dsh-api-session-controller`、`dsh-client-ui-session`、`dsh-client-connection`（后者原靠 hoist 隐式解析，现显式声明直接 import 的每个 `@deepseek-ai/*`）；peerDependencies 切 `^0.1.2-alpha.3`；version 0.3.12 → `0.3.12-dsh-0.1.2-alpha.3`（prerelease 标签直接点名目标宿主版本）。

## Alternatives considered

- **双版本特性检测（installSettingsSection 运行时探测 / workspaces·uiWorkspace 双路径）** —— 宿主已断代（npm 无 0.1.2 中间态以外的兼容层），长期维护两套探测路径成本不值；且 `uiWorkspace` 加入 inject 会让旧宿主上插件整体不启动。alpha.1 时用户已明确决定不兼容旧宿主，本迁移延续该决定。
- **peerDependencies 放宽为 `>=0.1.1-rc.2 <0.2.0`（alpha.1 记录的建议）** —— 该建议的前提是插件代码还要兼容 rc.2；本分支代码已使用 alpha.3 独有 API（installSection、字符串 ns），rc.2 宿主上会运行时崩溃，宽容声明只会让包管理器对不适配的组合放行。声明收紧到 `^0.1.2-alpha.3` 与代码事实一致。
- **minor 版本 0.4.0** —— alpha.1 记录原定调第二步升 0.4.0；兼容边界（rc.2 → alpha.3）确是 minor 级断裂，但发成常规 minor 后，`^0.3.12` 范围与 npm `latest` 渠道的用户会被 semver 拉到一个 rc.2 宿主上不可用的版本。改用 prerelease `0.3.12-dsh-0.1.2-alpha.3`：semver 上低于 0.3.12 正式版（不会被动升级命中），prerelease 标签点名目标宿主，rc.2 用户停在 0.3.12；发布时须显式 `--tag dsh-alpha`（呼应宿主官方把 dsh prerelease 路由到 `alpha` dist-tag 的做法），避免 prerelease 占据 `latest`——tag 作为持续通道，后续宿主 alpha 版的兼容版继续发到同一 tag，精确版本号负责点名具体宿主。

## Consequences

- 代价：本分支仅兼容 0.1.2-alpha.3 及以上的宿主，rc.2 宿主上 settings 注册与目录选择不可用（分支隔离，已发布的 0.3.12 不受影响）；`^0.1.2-alpha.3` 的 semver prerelease 语义把可解析范围锁在 0.1.2 元组内，宿主出 0.1.3/0.2.0 时需再次迁移。
- 换来：typecheck/test/build 全量跑在 alpha.3 的真实类型上，5 处悬空类型 import 与死 inject 引用清零；跨包依赖全部显式声明，宿主 peerDeps 收敛不再影响安装；后续宿主 alpha 迭代的兼容面检查有了本次的三路 diff 基线。
