# DR: 依赖基线迁移至 dsh 0.2.0-rc.1（兼容 rc.2，零代码改动）

Status: implemented

## Problem

宿主 DeepSeek Harness 已进入 `0.2.0` 预发布线：`@deepseek-ai/dsh@0.2.0-rc.1` 与 `0.2.0-rc.2` 分别于 2026-09-28 / 2026-09-29 发布，官方 npm 源全量跟进，且 0.2.0 生态的 peer 基线整体抬升（`@deepseek-ai/cordis` `~4.0.4`、`@deepseek-ai/schemastery` `~3.18.4`、`@deepseek-ai/cordis-plugin-loader` `~1.0.5`）。本插件的依赖声明仍停在 `0.1.7-rc.1`。

两重后果：其一，宿主 Bundle 准入校验（`evaluatePluginCompatibility`，`semver.satisfies(runtime, requirement, { includePrerelease: true })`）对声明了 `dsh.bundle` 的包逐条校验 `@deepseek-ai/dsh*` 前缀的 peer——`^0.1.7-rc.1`（即 `>=0.1.7-rc.1 <0.2.0`）不匹配 `0.2.0-rc.x` 运行时，插件在 0.2.0 宿主中被判不兼容而拒载。其二，本地编译期类型面落后两个 minor 线，无法提前暴露 0.2.0 的 API 演进。

目标约束：最低依赖 `0.2.0-rc.1`，同时兼容已发布的 `0.2.0-rc.2`（本机 `D:\Code\deepseek-harness` 源码即 rc.2）。

## Decision

1. **peerDependencies 抬至 `^0.2.0-rc.1` 并跟进生态基线**：`@deepseek-ai/dsh-credentials` 与 `@deepseek-ai/dsh-settings` 由 `^0.1.7-rc.1` 升为 `^0.2.0-rc.1`；`@deepseek-ai/cordis` 由 `^4.0.3` 升为 `^4.0.4`、`@deepseek-ai/schemastery` 由 `^3.18.3` 升为 `^3.18.4`（后两者不参与宿主准入校验，但与官方 0.2.0 生态的 `~4.0.4` / `~3.18.4` peer 声明对齐）。caret 预发布范围在 `includePrerelease` 语义下同时匹配 `0.2.0-rc.1`、`0.2.0-rc.2` 与最终 `0.2.0` 正式版（`>=0.2.0-rc.1 <0.3.0`）。
2. **devDependencies 精确钉 `0.2.0-rc.1`**：22 个 `@deepseek-ai/dsh-*` 依赖全部升到精确版本 `0.2.0-rc.1`（`dsh-scope` 由 `^0.1.7-rc.1` 顺带统一为精确钉版），`cordis` `^4.0.4`、`cordis-plugin-loader` `^1.0.5`、`schemastery` `^3.18.4`。本地编译期类型面冻结在最低支持线上。
3. **rc.1 → rc.2 差异排查后确认无需区分**：本地 rc.2 源码 `dsh-v0.2.0-rc.1..dsh-v0.2.0-rc.2` 共 187 个提交、零个 `!` 破坏标记；插件所依赖的 compaction / credentials / session（含 session-* 全系）/ settings 包在该区间**仅 package.json 版本号变化**，唯一代码变更落在 `llm-pi-ai`（第三方 pi-ai 适配器内部 catalog/replay，不触及插件消费的 `ctx.llm` 服务面）；`dsh.client.inject` 声明的四个 client-ui 包在 rc.2 中同名存在。故一份声明同时服务两代 rc。
4. **0.1.7 → 0.2.0 零代码适配**：607 个提交未触及插件使用的服务面（settings 表单、persistence 双 seam、llm 目录、credentials、webServer 路由、client slots）。`tsc --noEmit` 零错误、`vitest run` 40 个文件 684 项全绿、`build:all` 通过，`src/` 无任何改动。
5. **`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 同步为新基线**：71 个 `0.2.0-rc.1` 包（按 lockfile 实际安装集合生成）+ `cordis-plugin-loader@1.0.5` / `cosmokit@1.8.5` / `schemastery@3.18.4`，移除全部过时的 `0.1.7-rc.1` 条目。
6. **版本号冻结**：不修改 `package.json` 的 `version` 字段，版本与发布节奏由维护者决定。

## Alternatives considered

- **peer 直接声明 `^0.2.0-rc.2`** —— 输在最低支持要求。rc.1 与 rc.2 之间插件依赖包零代码差异，抬高下限没有换来任何兼容性收益，反而把 rc.1 宿主用户挡在门外。否决。
- **devDeps 用 `^0.2.0-rc.1` caret 范围** —— 输在类型面漂移。22 个 dsh 系依赖历来精确钉版，本地编译与测试锁定在单一已知版本；caret 会随宿主每次发 rc 自动漂移，"在 rc.1 上编译、对 rc.2 做过差异排查"的受控事实变成不可复现。否决。
- **等 `0.2.0` 正式版再迁移** —— 输在发布窗口。准入校验已经把旧 peer 在 0.2.0-rc 宿主上判为不兼容，新宿主用户现在就装不上插件；正式版发布时间不可控。否决。
- **双枚举 peer（`^0.1.7-rc.1 || ^0.2.0-rc.1`）保留旧宿主** —— 枚举范围随宿主每个 minor 线增长（[迁移 dsh 0.1.5](./2026-09-10-migrate-to-dsh-0-1-5-rc-1.md) 已论证）；且 0.2.0 宿主树内已无 0.1.7 代的 persistence/settings 运行时事实可回退，声明兼容不等于实际兼容。否决。

## Consequences

- 代价：插件不再被 `0.1.7` 代宿主准入（`^0.2.0-rc.1` 在 semver 上不匹配 `0.1.7`），旧宿主用户需留在插件的上一发布线。
- 代价：rc.2 与未来 `0.2.0` 正式版上的真机行为回归依赖宿主发布节奏——本地测试全部跑在 rc.1 的类型与运行时面上，rc.2 的兼容性来自源码级差异排查而非真机验证。
- 换来：一份构建同时覆盖 `0.2.0-rc.1`、`0.2.0-rc.2` 与 `0.2.0` 正式版宿主，准入校验全绿。
- 换来：依赖与官方 0.2.0 生态全面对齐（cordis 4.0.4 / schemastery 3.18.4 / loader 1.0.5），`src/` 零改动、typecheck 零错误、684 项测试全绿、构建产物正常。
