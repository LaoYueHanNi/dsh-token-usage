# DR: 对齐 DSH 0.2.2 运行时与客户端构建协议（SyncedConfig、零快照 Turn 追踪与 meta.stylesheets）

Status: implemented

## Problem

在将本插件对齐 DSH 0.2.2 上游规范时，有三项架构与构建改进需要核实并落地，且必须同时兼容当前插件依赖基线（`0.2.1-rc.3` ~ `0.2.2-rc.5`）与已合入上游 `master` 的新宿主：

1. **客户端只读配置同步（#14）**：上游 `master`（PR #8504）新增 `@deepseek-ai/dsh-client-config`，将 Host 端顶层 `.volatile()` 字段自动投影为客户端 `apply(ctx, config)` 的第二个参数 `SyncedConfig`（带 `.get()` / `.subscribe()`）。但 `0.2.1-rc.3` 与 `0.2.2-rc.5` 尚未包含该特性（传入 `config` 为 `undefined`），且 `src/client/index.ts` 中原有的 `configForms` + `describe` 桥接仍需服务于 `TokenUsageCard` 的写操作，不能删除。
2. **废弃的 `session.snapshotEvents()` 调用（#15）**：上游已将 `session.snapshotEvents()` 标记为 `@deprecated`（禁止同步全量拷贝事件数组），而本插件 `src/index.ts` 的目录迁移守卫 `relocateTo` 与 `createDirectoryGuardRoute` 每次校验都会遍历所有活跃会话调用 `session.snapshotEvents()`。
3. **客户端样式表生命周期（#16）**：上游 `master`（PR #8133，client-module-metadata）移除了 `<style data-plugin-css>`，改由构建产物在 `window.__ModuleLoader__.load({ id, factory, meta })` 中暴露延迟求值的 `meta().stylesheets`，由渲染器 `DocumentStyles` 统一挂载与卸载清理。但 `0.2.1-rc.3` ~ `0.2.2-rc.5` 尚未合入该变更；若直接删掉 DOM 注入，旧宿主会丢失全部样式；若保留原顶层注入，新宿主与旧宿主在卸载或热替换时均会残留 `<style>` 节点。

## Decision

1. **客户端 `apply(ctx, config?)` 优先消费 `SyncedConfig`，缺失时无缝降级 `configForms`**（[src/client/index.ts](../../../src/client/index.ts)）：
   - 以结构化鸭子类型声明可选参数 `SyncedConfigLike`（不新增 npm 依赖，也不在客户端导出 `Config` schema，避免触发新宿主的 schema 冲突校验）。
   - 控制 `sidebar.panellist`、`sidebar.panellist.actions` 与 `settings.section` 注册的 `syncEntries` 优先读取并订阅 `config.sidebarPinned` / `config.settingsSectionEnabled`；当任一字段未由 `SyncedConfig` 提供时（如 `0.2.1-rc.3` ~ `0.2.2-rc.5`），回退到现有的 `activeTarget`（`configForms`）。
   - `TokenUsageCard` 的表单读写继续复用 `configForms` + `describe` 桥接。经核实上游 `ui-sidebar` 原生 pin/unpin 仅为纯浏览器内存状态，与本插件持久化 `sidebarPinned` 定位互补，交互保持不变。

2. **以 `ctx.agents.turnBoundaryOf` 与事件增量追踪替代运行时 `session.snapshotEvents()`**（[src/index.ts](../../../src/index.ts)）：
   - 运行时目录迁移守卫 `relocateTo` 与 `createDirectoryGuardRoute` 统一改调 `countLiveInteractingSessions()`，不再调用 `session.snapshotEvents()`。
   - 若宿主已挂载 `agents` 服务且提供 `turnBoundaryOf(session)`（DSH `0.2.2+`），直接以 `O(1)` 读取投影缓存 `openTurnStartSeq !== null`，覆盖晚加载场景且零事件拷贝。
   - 若无 `agents.turnBoundaryOf`（旧宿主或精简测试上下文），维护 `openTurns: Set<string>`：在 `apply()` 顶层通过 `ctx.on('session/event', ...)` 增量跟踪自有 `turn/start` / `turn/end`（跳过 Fork 继承前缀），启动时仅对已有活跃会话做一次初始 seed，并在每次查询时对照 `ctx.sessions.list()` 清理已移除会话，防止异常关闭未发 `turn/end` 导致死 ID 永久阻塞目录迁移。

3. **客户端构建产物同时支持 `meta.stylesheets` 与带清理的旧宿主 fallback**（[tsdown.config.ts](../../../tsdown.config.ts)）：
   - `dsh-css-modules-inline` 插件不再在每个 `.module.css` 模块顶层插入 DOM 注入代码，仅导出类名映射表并将编译后的 CSS 按包内正斜杠相对路径（如 `src/client/UsageView.module.css`）登记。
   - 利用 Rolldown `outputOptions.footer(chunk)` 函数按路径字典序序列化 chunk 引用到的样式表（无额外 `renderChunk` 字符串改写，不破坏 sourcemap），并在 `window.__ModuleLoader__.load(...)` 返回标准 `{ id, meta, factory }`：
     - **新宿主**：`DocumentStyles` 调用 `meta()` 获取 `stylesheets` 并由宿主统管挂载/卸载；`meta()` 会标记已接管并清除任何此前挂载的 fallback `<style data-plugin-css>`，无论 `meta()` 与 `apply()` 谁先执行都不重复、不残留。
     - **旧宿主**：`meta()` 不被调用；包装后的 `apply(ctx, config)` 在 `ctx.effect` 内挂载 `<style data-plugin-css>` 并在 `dispose` 时 `tag.remove()`，既保留样式又顺带修复旧宿主卸载残留。

## Alternatives considered

- **直接升级依赖基线到 `master` 并删除旧宿主降级路径**：会破坏当前已发布的 `0.2.1-rc.3` 与 `0.2.2-rc.5` 宿主（旧宿主下客户端样式全部丢失、只读配置同步失效），在正式版发布前不可接受。
- **Turn 追踪仅靠 `Set<SessionId>` 监听 `turn/start` / `turn/end`**：缺少晚加载时的初始状态与异常关闭会话的死 ID 清理；结合 `ctx.agents.turnBoundaryOf` 优先路径、启动一次 seed 与活会话交集过滤，才能做到全场景准确。
- **使用 `renderChunk` 占位符替换注入 `meta.stylesheets`**：未生成对应的 sourcemap 变换会触发 Rolldown `SOURCEMAP_BROKEN` 告警；改用 `outputOptions.footer(chunk)` 原生钩子可完全消除该告警。

## Consequences

- 在支持 `SyncedConfig` 的宿主上，侧栏常驻行与设置页分区首帧即可按配置准确挂载，消除等待 `configForms.describe()` 异步返回的闪烁；旧宿主行为零退化。
- 运行时目录迁移校验与 `/token-usage/dir-guard` 彻底消除 `session.snapshotEvents()` 全量事件数组拷贝。
- `lib/client.js` 符合 `client-module-metadata` 协议，在新旧宿主上均实现卸载/热更新零样式残留且不丢失样式。
- 新增 `tests/client-bundle-meta.client.spec.ts` 覆盖新旧宿主样式协议，并在 `tests/integration.spec.ts` 与 `tests/sidebar-entry.client.spec.tsx` 补齐 `turnBoundaryOf`、事件驱动 turn 追踪与 `SyncedConfig` 测试。
