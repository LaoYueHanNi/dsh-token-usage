# DR: 全面统一采用 pnpm 工具链

Status: implemented

## Problem

项目实际一直依赖 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 进行依赖管理与锁定，但 `package.json` 中的 `scripts`（如 `prepublishOnly`）以及中英文 `README` 的开发指引中仍散落着 `npm run ...`、`npm install` 与 `npm publish` 等 npm 命令调用。这种双包管理器混杂的状态带来两处问题：一是开发者若依照 README 执行 `npm install`，会生成冗余的 `package-lock.json` 并破坏 pnpm 的软链结构；二是未在 `package.json` 中显式声明 `packageManager` 字段，缺失了 Corepack 工具链的防误用拦截。

## Decision

将开发、构建与发布工作流全面收敛并统一到 pnpm 工具链：
1. 在 `package.json` 中添加 `"packageManager": "pnpm@11.8.0"`，明确项目唯一包管理器；
2. 在 `package.json` 的 `scripts` 中补充 `build:all` 与 `watch:client`，并将内部串联执行统一为 `pnpm run`（`build:all` 与 `prepublishOnly`），消除对全局 `npm` 脚本调用的依赖；
3. 将中英文 `README` 中的开发调试指南（安装、全量构建、测试、热重载监听）全部同步为 `pnpm install`、`pnpm build:all`、`pnpm test`、`pnpm watch:client` 与 `pnpm publish`；
4. 将 `pnpm-workspace.yaml`（含 `allowBuilds: esbuild: true`）正式纳入版本管理，防止 pnpm 升级后构建脚本被安全拦截；
5. 保持对外发布到公共 npm 注册表的配置（`publishConfig`）不变，面向下游终端用户的插件使用不受任何影响。

## Alternatives considered

- **保持 package.json scripts 内部使用 npm run** —— 虽然依赖安装后 `npm run` 也能启动 `node_modules/.bin`，但与锁文件体系割裂，且在纯 pnpm 容器或无全局 npm 的严格环境下会引入不必要的环境依赖。
- **仅添加 packageManager 声明而不更新 scripts 与 README** —— 治标不治本，开发者依文档操作依然容易混淆命令认知，且文档与实际工具链存在认知摩擦。

## Consequences

- 代价：本地开发与发包环境必须安装 `pnpm`（或启用 Corepack），无法在仅有裸 `npm` 的纯净环境下直接执行完整构建链。
- 换来：消除包管理器混用的认知摩擦；Corepack 防误用拦截防止意外污染 lockfile；scripts 命名与 README 指引彻底一致，降低维护与新环境配置成本。
