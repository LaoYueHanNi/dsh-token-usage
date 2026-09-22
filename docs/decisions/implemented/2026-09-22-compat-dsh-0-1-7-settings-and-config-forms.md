# DR: 硬切宿主 dsh 0.1.7 Settings 重构（volatile 配置范式 + settings.configure）

Status: implemented

## Problem

宿主 DeepSeek Harness 自 `0.1.7-alpha.1` 起对设置体系彻底重构：废弃全局 `$DSH_HOME/settings.yaml`（启动时重命名为 `settings.yaml.imported`），设置收敛至 Profile 的 `cordis.patch.yml`；`ctx.settings` 由旧 `Settings` 重构为 `SettingsForms`。本插件作为 0.1.2 时代插件遭受四级递进的破坏：

1. **后端契约断裂**：`SettingsForms` 删除了 `installSection` 与 `get`。旧代码无条件调用 `settingsCtx.settings.installSection(...)` 在 0.1.7 宿主抛 `TypeError` 使插件加载崩溃；注册在回调里的 `onChange` 唤醒链失效；quota 凭据链的 `settings.get(ns)` 同样不存在。
2. **前端服务断裂**：客户端 `ctx.settingsScope` 被移除，由 `ctx.configForms` 接管。顶层 `inject` 强依赖 `'settingsScope'` 时整个客户端 `apply()` 被 cordis 永久挂起——统计页、Usage 视图、统计 Chip、Quota 按钮、配置卡片全部瘫痪。
3. **`ConfigForms.get()` 探测陷阱**：0.1.7 的 `get(entryId)` 对**任意 key** 无条件创建并缓存 `ConfigFormController`，永不返回 `undefined`；以返回值判定 key 有效性必然绑定到镜像中不存在的 key（完整包名），Controller 永久 `unavailable`，卡片渲染 `null`。正确判据是 `describe()` 镜像快照中实际存在的 namespace（插件 entry id `'token-usage'`）。
4. **volatile 准入规则（最终根因）**：`SettingsForms.describe()` 对 `volatileForm(schema) === undefined` 的 entry 直接跳过——**只有被 `.volatile()` 修饰的 Config 字段才会被投射为设置表单**。本插件 schema 全为裸字段，`token-usage` 命名空间从未进入 describe 镜像，客户端 `configForms` 订阅永远等不到信号，插件详情页配置区块（`ledger.bundles` 为空 → `configured=false`）整体不渲染，且无任何报错。

## Decision

放弃早前拟定的「0.1.2~0.1.7 双版本运行时兼容」路线（其运行时探测兼容层已实施过一轮，本轮全部移除），**硬切 dsh 0.1.7+**，对齐姊妹插件 dsh-git-worktree `e064511` 的已验证迁移：

1. **依赖全线硬切**：peer/devDependencies 由 `^0.1.2-rc.1` 升至 `0.1.7-alpha.1`（npm 预发布 peer 链无法收敛，钉精确版本并以 `.npmrc` 的 `legacy-peer-deps` 固化解析）；schemastery `^3.18.3`（`.volatile()` 首现版本）、cordis `^4.0.3`、新增 `cordis-plugin-loader`（`loader/volatile-update` 事件类型）。

2. **schema volatile 化**：`Config` schema 的用户可调字段 `path`、`pricingRegion` 加 `.volatile()`（组合层专用键 `pricingUrl*`/`quota`/`recordCompaction` 不加，不出现在表单）；类型标注改为 `Volatile<T> | T` 联合，新增 `readVolatile` 鸭子解包函数；运行时读取全部改走 `ctx.fiber?.config` 取时解包（volatile 提交原地换快照、插件不重载）。

3. **设置呈现接入**：`ctx.inject(['settings'])` 内以 effect 注册 `settings.configure({ auto: false }, ctx.fiber)`（声明本插件经 `plugins.bundle.config` 自制卡片，宿主勿自动生成表单页）；删除 `installSection` 注册、`sectionSchema`、`validateSection`/`validateSectionChange` 与整套 deferred startup（`startupDeferMs`/`startupCapMs` 配置键一并删除）——loader 在 apply 前已 resolve 最终配置，apply 末直接 `startFromSource()`。

4. **写回热生效**：监听 `loader/volatile-update`（按 fiber 过滤、仅自身 entry 触发）重跑 `start(); requestSync()`：目录变更触发迁移、区域切换重拉定价镜像，替代旧 `onChange` 链；保存期防误迁移由客户端 guard 路由预检 + 写后读回兜底（服务端 validate 回调链已随 installSection 移除）。

5. **quota 链路重接**：凭据链的 `readSettings` 改经 `settings.describe()` 按 ns 查 resolved value（替代被删的 `get`）；全新会话的默认 provider 改经可选注入的 `agentDefaultModel` 服务 `currentSelection()`（替代读 `agent-default-model` 设置节）。

6. **0.1.7 事件与 API 适配**：`assistant/chunk` 流事件已被 `assistant/message` 内嵌的 `stream: AssistantStreamRecord[]`（compact 记录）取代——live 记录、历史回填、timing 回填三处删除 chunk 分支，首字延迟统一由既有 `extractFirstTokenTimeFromStream` 从 compact 记录提取；客户端 `ISessions.open` 无直接替代（导航归视图层所有），统计页 Ctrl+click 会话跳转暂时降级为不可用（提示与行为同步关闭）；图标 `IconChevronDownOutline14` 更名 `IconChevronDownOutlineMedium`；删除 legacy `settings.plugin.item` 槽注册。

7. **客户端解析保留既有修复**：`configForms` 双 key 候选（entry id 优先、包名兜底）以 `describe()` 镜像快照判定有效性，动态 effect 订阅镜像 + `ensure()` 首读，namespace 出现即重绑定。

## Alternatives considered

- **双版本运行时兼容（本轮推翻）**：前一轮已实施 installSection 探测分支 + settingsScope 降级。volatile 范式侵入 schema 声明、字段类型、运行时读取全链路（`Volatile<T>|T` + 处处解包），双轨并存的类型噪声与测试面失控；且 dsh-git-worktree 决策记录已论证 alpha 期 peer 严格隔离下双兼容不可维护。插件发布面由版本号区分宿主代际（0.4.x 为 0.1.2~0.1.6 终线）。
- **保留旧会话跳转功能**：0.1.7 `ISessions` 改为 retain/using 引用模型且导航归属视图层，无插件侧平替 API；与其接线不成熟的内部服务，不如暂时优雅降级（两谓词恒 false）待宿主稳定后专项恢复。
- **服务端保留 validateSectionChange 写入守卫**：SettingsForms 写链（mutate/update）不接受插件 validate 回调，只有 schema 校验；会话进行中拒迁移的约束由客户端 guard 路由（保存前预检）承担，服务端 relocate 自身仍有活跃会话拒绝保护，双保险保留。

## Consequences

- **所得**：`token-usage` 进入宿主 describe 镜像，插件详情页配置区块与卡片具备出现的全部前提（volatile 投射 + 客户端镜像驱动绑定齐备）；配置保存写回 profile patch 后经 volatile 原地提交热生效，无插件重载。
- **所得**：依赖图与宿主 0.1.7-alpha.1 对齐，`typecheck` 0 错误；测试套件随 API 变化同步更新（chunk→stream、configure/volatile-update 新用例、废键用例移除）。
- **代价**：不再兼容 0.1.6 及更早宿主（安装新版即需宿主 ≥0.1.7-alpha.1）；统计页会话跳转暂缺；npm 依赖解析依赖 `.npmrc` 的 `legacy-peer-deps`；integration/quota-integration 少量用例的 0.1.7 语义适配仍在分支上进行。
