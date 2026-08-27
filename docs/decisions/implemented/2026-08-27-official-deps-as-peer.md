# DR: 官方 @deepseek-ai/* 运行时依赖改声明为 peerDependencies

Status: implemented

## Problem

awesome-dsh-plugin 收录指南明确推荐："官方 `@deepseek-ai/*` 包请用 `peerDependencies` 声明"，预构建安装可免 `allowBuilds` 构建授权步骤。本包此前把 `dsh-credentials`、`dsh-settings`、`schemastery` 放在 `dependencies`：每次 `dsh plugin add` 都要多下载 4 个包（三包 + 传递依赖 cosmokit），国内直连官方源时这几个 tarball 恰好是最慢的；profile 里还与宿主树内的同名包形成双份存盘。

## Decision

三个运行时 import 的官方包（`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`）自 0.3.10 起移入 `peerDependencies`，版本范围不变；`dependencies` 字段随之移除。运行时解析依据已实证：宿主 profile 的 node_modules 里从未安装过 `@deepseek-ai/cordis`（仅 devDeps），而插件 Node 侧 `import '@deepseek-ai/cordis'` 一直正常——cordis-plugin-loader 的 require-builtins 机制会把裸导入转发到宿主树解析；宿主树（`dsh/node_modules/@deepseek-ai/`）中确认存在上述三个包。安装期 pnpm 会新增 unmet-peer 警告，与 `cordis` 现有警告同类，属预期噪音。

## Alternatives considered

- **维持 dependencies** —— 安装可用，但违背指南推荐，持续付出多包下载与双份存盘的代价。
- **三个包全留 dependencies 仅移两个 dsh-* 包** —— 无区别于全移的额外安全性：schemastery 同样存在于宿主树，解析路径一致。
- **改成 optional peerDependencies（peerDependenciesMeta.optional）** —— 语义是"缺了也不报"，掩盖真实解析失败，排障更难。

## Consequences

- 代价：install 输出多几条 unmet-peer 警告；若未来宿主某版本从模块表移除了这三个包，插件会在运行时（而非安装时）才暴露缺失，需要回退到 dependencies 出补丁版本。
- 换来：`dsh plugin add` 少下载 4 个包（国内直连官方源时显著提速）；profile 与宿主不再双份存盘；与 awesome-dsh-plugin 收录指南及 dsh 插件生态惯例对齐。
