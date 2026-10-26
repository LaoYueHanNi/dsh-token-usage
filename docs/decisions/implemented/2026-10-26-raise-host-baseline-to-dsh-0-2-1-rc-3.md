# DR: 宿主基线提升到 dsh 0.2.1-rc.3，清理 0.1.x 时代宿主兼容双轨

Status: implemented

## Problem

插件历经 0.1.2 → 0.1.5 → 0.1.7 → 0.2.0-rc.1 → 0.2.1 多次宿主迁移，每次都「加新轨、留旧轨」：`peerDependencies` 已声明 `^0.2.0-rc.1 || ^0.2.1-rc.1`（0.1.x 宿主早已装不上），但源码里还留着六处 0.1.x 时代的运行时探测分支——persistence 的 inspect 旧 seam、设置面的 settingsScope 旧服务、timed stream 的防御分支、`Session.events`→`snapshotEvents()`、`llm/stream` 降级、以及随之膨胀的测试替身与版本叙事注释。这些分支在 0.2.1-rc.3 基线下是死代码，却持续付出类型面（可选方法联合签名）、测试面（双轨用例与双形态 mock）与读者注意力的税。

## Decision

最低兼容宿主提升到 **dsh `0.2.1-rc.3`**：`peerDependencies` 的 `dsh-credentials` / `dsh-settings` 收窄为 `^0.2.1-rc.3`（devDependencies 的 22 个 `@deepseek-ai/*` 类型包已在此前对齐 0.2.1-rc.3，不动）。六处双轨全部删除，每处保留 0.2.1-rc.3 恒成立的一轨：

1. **`src/sync.ts` persistence 双 seam**：保留 handle 轨（`open(id, 'read')` + `read()` + `close()`，`list({ signal })` 返回 `header.id` 快照，与 0.2.1-rc.3 `SessionPersistence` 官方契约一致），删除 inspect 轨（`inspect(id, signal)`、`list(signal)` 位置参数、`SyncSessionEntry` 双形态联合）与「两者皆无」的兜底报错；`readerOf` 从探测分支改为无条件 handle 归一化，`SyncPersistence.open` 由可选转必选。
2. **设置面双服务**（`src/client/card-form.ts` + `src/client/index.ts`）：保留 configForms 轨（describe 镜像 + entry-id 键），删除 `lookupCurrentTarget` 的 `settingsScope.bind` 分支与 `ctx.inject(['settingsScope'])` 动态监听；`createFallbackTarget` 保留但角色收窄为「configForms 服务挂载前的启动占位」（0.1.7 双轨语义的注释随之改写）。`CardFormTarget` / `CardFormTargetSnapshot` 的「兼容 pre-0.1.7 SettingsScope」结构叙事改为仅描述 ConfigForm。
3. **timed stream 防御分支**（`src/index.ts`、`src/sync.ts`、`src/usage-log.ts` 三处）：0.2.1-rc.3 类型里 `assistant/message` 的 `stream: AssistantStreamRecord[]` 是必选字段，`'stream' in event.data && event.data.stream` 三元防御简化为直接传给 `extractFirstTokenTimeFromStream`（其入参本就是 `unknown` 宽容、非数组返回 undefined，测试替身不受影响）。
4. **`snapshotEvents()` 历史注释**：`countInteractingSessions` 的调用点早已全部走 `session.snapshotEvents()`，仅删除「dsh 0.1.2 把 `Session.events` 收私有」的迁移期注释。
5. **`liveCapability` 动态降级**：0.2.1-rc.3 恒有 `llm` 服务，stats 路由的 `capability` 恒报 `'lifecycle'`，删除 `settled-only` 降级变量与 inject 回调里的升降级赋值；wire 枚举 `'lifecycle' | 'token-progress' | 'settled-only'` 原样保留（`'settled-only'` 仍是 stats-route 在 `live` 观察器缺席时的诚实兜底，`'token-progress'` 是协议前瞻档位），客户端按最小破坏不动。
6. **测试同步**：专测旧轨的用例连同删除（「prefers the handle seam when a twin carries both」「fails loudly when the persistence exposes neither seam」「binds correctly when host provides legacy settingsScope service」）；六个测试文件的 persistence 替身从 inspect 形态换成 handle 形态；两个 `dsh-0-1-7-*` 兼容测试文件更名（`host-compat` / `config-forms`），保留的用例改为描述现役行为。

**明确不删的边界（数据格式兼容，与宿主版本无关）**：`usage-record.ts` 的 pre-compaction 行无 `kind` 键归一化、`rollup.ts` 旧 rollup 缺 `compactions` 键合并、`sync-state.ts` 旧状态文件、[v0 origin 修复](./2026-09-19-repair-legacy-v0-origin-sessions.md)——它们保护的是用户磁盘上的历史数据，不是宿主 API 形态；辅助请求按 `purpose`/system 前缀分类、审查/翻译请求的全局兜底、设置工具栏紧凑控件等设计原则与 UI 资产同样不在本次清理范围。

## Alternatives considered

- **保留双轨，等 dsh 0.3 再清** —— 输在账只会越欠越多：每次迁移都再加一轨，「删旧轨」永远有比它更新的轨挡着；peer 收窄到 0.2.x 已满一个 minor 线，旧轨在声明面早已不可达，留着只是纯维护成本。
- **只收窄 peerDependencies，不动代码** —— 输在声明与事实继续分家：宿主准入校验挡住 0.1.x 安装是宿主侧行为，插件自身的探测分支、联合类型与双轨测试面仍要每个贡献者陪着读；且「声明兼容」与「运行时兼容」分离正是 [0.2.0 迁移](./2026-09-29-migrate-to-dsh-0-2-0-rc-1.md)否决双枚举 peer 时论证过的反模式。
- **连 wire 的 `liveCapability` 枚举一并收窄为 `'lifecycle'` 单值** —— 输在破坏面越过收益：`'settled-only'` 仍是 stats-route 在 `live` 观察器缺席（`fields` 组合变化）时的诚实输出，`'token-progress'` 是留给未来 token 级进度的档位；收窄枚举要同时动 wire 契约、session-request-details、stats-route 与一串客户端/测试断言，换来的只是少两个字符串字面量。
- **`createFallbackTarget` 一并删除，让 target 恒存在** —— 输在启动竞态：configForms 服务经 `ctx.inject` 动态挂载，`apply` 首帧时可能尚未就绪，`activeTarget` 需要一个稳定占位再经 `switchTarget` 热切；把 `CardFormTarget` 改成可空会把空检查摊到每个读取点，破坏面大于收益。

## Consequences

- 代价：`0.1.x` / `0.2.0` 宿主用户装不上本版本之后的新发布（peer `^0.2.1-rc.3` 的 semver 预发布匹配下限即 0.2.1-rc.3），需留在上一发布线——与 0.2.0 迁移时的用户面相同，无新增损失。
- 代价：`SyncPersistence` / `SyncSessionEntry` 等 duck-type 接口形态变化是 `src/sync.ts` 的导出 API 变化，任何外部依赖这些内部类型的代码需要同步（插件以 `lib/` 产物分发，这些类型本就不在公开 exports 面上）。
- 换来：`sync.ts` 双 seam 探测、设置双服务、三处 stream 防御、liveCapability 降级共约 6 处运行时分支与全部版本叙事注释消失，类型面收窄（`open` 必选、`list` 单签名、`SyncSessionEntry` 单形态）。
- 换来：测试基线随双轨收缩（专测旧轨的用例删除，mock 统一为 handle 形态），后续宿主迁移的「删旧轨」第一次有了干净起点。
