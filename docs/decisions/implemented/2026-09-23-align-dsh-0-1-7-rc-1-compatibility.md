# DR: 对齐宿主 dsh 0.1.7-rc.1 兼容性与 Bundle 准入拦截

Status: implemented

## Problem

宿主 DeepSeek Harness 自 `0.1.7-rc.1`（commit `07ad70817f` / PR #4980 / #5061）起对插件加载机制引入了严格的 Bundle 准入校验：在 `loadProfileDirectory` 加载 profile 插件清单时，调用 `evaluatePluginCompatibility(bundleManifest, exemptions)` 强校验声明了 `dsh.bundle` 的包的 `peerDependencies`。

宿主内部校验逻辑使用 `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`：
1. 插件原先在 `package.json` 中将 peerDependencies 钉死为精确版本 `"0.1.7-alpha.1"`。当宿主运行在 `0.1.7-rc.1` 时，semver 预发布匹配规则判定 `semver.satisfies("0.1.7-rc.1", "0.1.7-alpha.1", { includePrerelease: true })` 为 `false`。
2. 宿主因此将本插件判定为 `incompatible-version` 并直接跳过加载，控制台产生静默跳过或版本不兼容警告，导致插件在 0.1.7-rc.1 宿主中完全无法启动。
3. 官方 npm 源已全量正式发布 `@deepseek-ai/dsh-*` 的 `0.1.7-rc.1` 系列包，插件需要从早期 alpha.1 全面跟进至官方 rc.1 基线。
4. 依赖升级后，`@deepseek-ai/schemastery` 更新至 `3.18.4`，在开启 `"declaration": true` 的构建配置下，导出的 `Config` 对象的 volatile schema 推导类型无法在 declaration 中直接命名，触发 TS2742 类型错误。

## Decision

对齐官方 `0.1.7-rc.1` 规范，修复宿主 Bundle 准入拦截与类型导出：

1. **`peerDependencies` 采用 Caret 预发布范围 `^0.1.7-rc.1`**：
   - 将 `@deepseek-ai/dsh-credentials` 与 `@deepseek-ai/dsh-settings` 的版本范围由 `"0.1.7-alpha.1"` 调整为 `"^0.1.7-rc.1"`。
   - 在 semver 的 `{ includePrerelease: true }` 语义下，`^0.1.7-rc.1` 能够有效匹配 `0.1.7-rc.1`、后续候选版本（如 `0.1.7-rc.2`）以及最终发布的 `0.1.7` 正式版（`>=0.1.7-rc.1 <0.2.0`），避免后续发布每一个 rc 版本都需要重新修改 peer 声明。
2. **`devDependencies` 全线升级至 `0.1.7-rc.1`**：
   - 将本插件 `devDependencies` 中声明的 22 个 `@deepseek-ai/dsh-*` 依赖全部统一升级到官方发布的 `"0.1.7-rc.1"`，确保本地开发、类型检查与单元测试与宿主运行时完全一致。
3. **显式类型标注解决 TS2742**：
   - 在 `src/index.ts` 中将导出的 `Config` schema 显式标注为 `z<any>`（`export const Config: z<any> = z.object({ ... })`），消除 volatile 扩展包装器在 TypeScript declaration 生成期的 portable type 错误。
4. **版本号冻结**：
   - 严格遵循仓库规范，不修改 `package.json` 的 `version` 字段，版本号与发布节奏全权由用户决定。

## Alternatives considered

- **继续使用精确版本 `"0.1.7-rc.1"`** —— 输在扩展性。宿主只要发布后续构建版本（例如 `0.1.7-rc.2`）或正式版 `0.1.7`，精确版本匹配将再次返回 `false`，导致插件再度被宿主准入机制拦截跳过。`^0.1.7-rc.1` 可以在保证最低版本不低于 rc.1 的前提下向上平滑兼容后续候选版与正式版。
- **使用宽松通配 `*` 或 `>=0.1.7-alpha.1`** —— 输在安全隔离。本插件在 [2026-09-22-compat-dsh-0-1-7-settings-and-config-forms.md](./2026-09-22-compat-dsh-0-1-7-settings-and-config-forms.md) 中已彻底移除了旧版运行时降级分支，若允许匹配 alpha 早期版本，会在早于 rc.1 的不完备环境中因 API 缺失而异常中断。
- **在 tsconfig 中关闭 declaration 生成** —— 输在破坏插件的 npm 分发契约。插件需要导出合法的 `.d.ts` 类型声明文件供下游或宿主集成消费，显式标注 `z<any>` 是零运行时开销且最安全的方案。

## Consequences

- 代价：插件不再允许在 `0.1.7-alpha.*` 宿主上加载（被宿主准入校验拦截）；由于依赖更新包含新发布的包，pnpm 自动在 `pnpm-workspace.yaml` 中登记了相应的 `minimumReleaseAgeExclude`。
- 换来：彻底解决 DSH 0.1.7 宿主中的 Bundle 兼容性拦截问题，插件能够被正常发现与加载；
- 换来：依赖与官方已发布的 0.1.7-rc.1 生态全面对齐，消除 TS2742 类型报错，全量 39 个测试文件、681 个单元测试全部绿灯通过。