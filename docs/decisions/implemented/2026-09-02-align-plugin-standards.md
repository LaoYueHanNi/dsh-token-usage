# DR: 对齐官方插件规范：导出 Config schema、接入 ctx.logger、镜像 peer 依赖

Status: implemented

## Problem

对照 dsh 官方教程（docs/02-开发_Develop 与 docs/03-参考_Reference）逐项审计本插件，发现三处与官方推荐做法不一致：

1. 官方《插件配置》要求"导出一个 `Config` 类型和同名的 Schemastery schema"，并点名"不要导出普通对象作为 `Config`，因为它不满足 Cordis 要求的 Standard Schema 接口"。本插件只有 `interface Config` 配合手写 `validateConfig()`，没有同名 schema——Cordis 加载器因此无法在 `apply` 之前做标准校验，非法配置（坏枚举、越界数值、错类型）要到运行时才被手写校验拦下，错误时机与信息都更晚。
2. 官方 Context API 提供 `ctx.logger(name)` 具名日志服务，插件 21 处 `console.log/error/warn` 手写 `[token-usage]` 前缀，绕过了框架的日志管线（级别过滤、结构化输出、HMR 可见性）。
3. 官方《新增 Package》约定"每个 dsh 对等依赖都要在 devDependencies 中镜像"。本包三个 peer（`dsh-credentials`、`dsh-settings`、`schemastery`）未镜像，本地类型检查依赖宿主树偶然存在的解析。

## Decision

三处改造已落地（0.3.14 前）：

1. 导出 `export const Config: z<Config>`（Schemastery object，键全部可选、数值带 min/max、region 用 union 枚举、quota 子对象内联）。Cordis 加载器经 `runtime.Config["~standard"].validate(config)` 在启动前校验并填充默认值；`validateConfig()` 保留——Schemastery object 非 strict 模式会保留未知键，拒绝拼写错误仍是 `validateConfig` 的职责，两者各管一段。
2. 新增 `src/log.ts` 定义最小 `LoggerLike` 面（error/warn/info）与 `consoleLogger` 兜底；`src/index.ts` 在 `apply` 开头取 `const logger = ctx.logger('token-usage')`，全部 console 调用改为 `logger.*`；数据模块（usage-log、migrate、rollup、record-cache、pricing、stats、sync-state、stats-route）的公共入口接受可选 `logger` 参数（缺省 `consoleLogger`），由 index.ts 逐层注入。测试全部继续无参调用，默认兜底到 console，行为不变。
3. `package.json` 的 devDependencies 补上三个 peer 的镜像（版本范围与 peer 一致），开发机类型解析不再依赖宿主树。

## Alternatives considered

- **Config schema 里直接拒绝未知键（strict 模式）并删掉 `validateConfig`** —— Schemastery object 非 strict 保留未知键、strict 丢弃但不报错，两种模式都无法"对未知键响亮失败"；保留手写校验是唯一能维持既有错误语义的路径。
- **给数据模块传 `ctx.logger` 实例而非可选参数** —— 数据模块被测试直接调用、不持有 ctx，可选参数（缺省 console）让测试与独立使用零改动，是侵入最小的注入形状。
- **其余 console 保留不动** —— 达不到"插件日志接入框架管线"的目标；逐层注入虽多十几处签名变更，但均为可选项，兼容性无损。

## Consequences

- 代价：数据模块公共函数签名多了一个可选 `logger` 参数（8 个文件）；`Config` 导出后 Cordis 在加载期多一次 schema 校验（可忽略的开销）。
- 换来：对齐官方插件开发规范的三条硬性要求；非法配置在加载时响亮失败；日志进入框架管线（命名、分级、HMR 可见）；本地开发类型解析自足；官网教程审计中这三项不再有差异。