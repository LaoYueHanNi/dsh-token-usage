# DR: 迁移宿主 dsh 0.1.2-alpha.1（第一步：运行时面向新版，类型暂留 rc.2）

Status: implemented

## Problem

宿主 deepseek-harness 0.1.2-alpha.1（提交区间 1079 个）官宣破坏性变更：`@deepseek-ai/dsh-client-runtime` 整包删除（`be531688f3`），客户端 `workspaces` 服务接口重写为纯 workspace 增删改排（`pickDirectory` 等目录方法全部移除，选择器移至 `uiWorkspace` 服务）。本插件的配置卡片浏览按钮正是调用 `ctx.workspaces.pickDirectory()`——在新宿主上点击即 TypeError。但 0.1.2-alpha.1 尚未发布 npm，devDependencies 无法安装新版包（本地宿主源码未 install/未构建且包间 `workspace:^` 协议 npm 不可解），当前宿主环境仍是 0.1.1-rc.2。

## Decision

分两步迁移。第一步（本提交，分支 feat/dsh-0.1.2-alpha.1）只改运行时行为面，保证本地全绿：`ClientContext` 类型改从 cordis 导入（runtime 的该类型本就是 cordis Context 的别名，两版 cordis 同为 4.0.1）；客户端 inject 数组 `workspaces` → `uiWorkspace`，pickDirectory 调用点 cast 到 uiWorkspace 服务（沿用 QuotaButton 对 modelDirectories 的可选服务 cast 先例）；`dsh.client.inject` 清单移除已删除的 runtime，换成 kit 提供者 `dsh-client-ui-session`（两版加载器对 inject 缺失行均宽容跳过，已实测）。version / peerDependencies / devDependencies 一律不动（动了会因 registry 无新版而 ERESOLVE/404）。第二步等宿主发布 npm 后执行：依赖全量切 `^0.1.2-alpha.1`、五个文件的类型 import 按实测映射迁移（SettingsScope ← ui-settings/client、UseProjection/SessionListState ← api-session-controller/client、ConversationSnapshot ← ui-conversation/client、kit merge ← ui-session/client）、version 升 0.4.0、宿主实测后发布。Host 半边（settings/credentials/llm/webServer/sessions/sessionPersistence 服务、session/event 事件、llm-pi-ai 凭据约定）经逐项 diff 确认两版完全一致，零改动。

## Alternatives considered

- **双版本特性检测兼容（workspaces/uiWorkspace 运行时探测）** —— 宿主已官宣破坏性变更，长期维护两套探测路径成本不值；且 `uiWorkspace` 加入 inject 会因旧宿主缺该服务导致插件整体不启动，只能 cast 探测，复杂度更高。用户明确决定不兼容。
- **本地宿主源码做开发期依赖（pnpm link: / file: tarball）** —— 本地宿主 checkout 即目标 tag 但未 install、无 lib/ 构建产物，包间全部 `workspace:^` 协议 npm 不可解，须 pnpm@11.7.0 全仓 install + build 后逐包 pack，且 api-session-controller 有 26 个 `@deepseek-ai/*` peer 闭包会被 npm 自动安装逻辑打到 404；环境重且脆，宿主发布后还要回切 registry。
- **等待宿主发布后一步迁移** —— 迁移工作（映射已全部实测确认）本可先行，空等只会把发布后窗口拉长。

## Consequences

- 代价：本提交后插件仅适配 0.1.2-alpha.1 宿主，在当前 0.1.1-rc.2 环境上配置卡片的浏览按钮不可用（uiWorkspace 服务不存在）——分支隔离，不发布、不影响已发布的 0.3.10；桥接期类型环境（0.1.1-rc.2 的 runtime 包）与运行时形态不一致，仅 pickDirectory 一处分叉已用 cast 隔离，其余 kit 成员两版结构兼容已核实；宿主发布后还需第二步提交完成类型迁移与发布。
- 换来：破坏性变更的适配代码现在就落地并被 typecheck/测试/构建全量验证；第二步只剩机械的依赖切换与 import 迁移（映射表已备好），宿主发布后可立即完成 0.4.0 发布。
