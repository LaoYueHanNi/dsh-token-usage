# DR: npm 发布迁移到 GitHub Actions（tag 触发）

Status: implemented

## Problem

发布一直是纯手动本机流程：bump version → commit → `npm publish`。发布成功与否依赖发布机环境（依赖安装、构建、npm 登录态都在本机），发布动作与版本提交无关联，无法从 git 历史回答"某个版本是从哪次提交、什么环境发出去的"；npm 登录凭据长期留在本机全局配置里。需要把发布搬进 CI，但版本决策仍保留在人手上。

## Decision

> [!NOTE]
> 本决策中的 CI 发布认证方式已于 2026-10-26 由 [DR: npm 发布改用 Trusted Publishing（OIDC 免 token）](2026-10-26-npm-trusted-publishing-oidc.md) 部分取代：不再使用 granular access token，改为 OIDC 换取短期令牌。其余决策（tag 触发、版本校验、rc 挂 next、发布前质量门）继续有效。

新增 `.github/workflows/publish.yml`：推送 `v*` 或纯数字前缀的 tag 触发（兼容历史上无 `v` 前缀的 tag 习惯），流程为——校验 tag 名（剥去可选 `v` 前缀）与 `package.json` 的 `version` 一致，不一致直接失败；`pnpm install --frozen-lockfile`；`npm publish --provenance --access public`，由 `prepublishOnly` 串联 typecheck → test → 双构建。版本号含 `-`（如 `0.4.12-rc.1`）自动加 `--tag next`，沿用 [next 标签的既有语义](2026-09-28-release-beyond-rc-occupied-number.md)；正式版默认 `latest`。并发用 `concurrency` 按 ref 串行。认证原用 npm granular access token 存入仓库 Secret `NPM_TOKEN`，配合 `permissions.id-token: write` 生成 provenance，现已改为 OIDC（见上方 NOTE）。发版操作收敛为：bump version → commit → 打 tag → 推送 tag；version 何时提升仍由维护者手动决定，workflow 不改版本号。

## Alternatives considered

- **workflow_dispatch 手动点按钮发布** —— 触发与版本无绑定，按钮谁来点、点了发哪个 commit 全靠自觉，比 tag 校验弱。输。
- **workflow 里自动 bump 版本再发布** —— 版本决策被自动化吞掉，与"版本由维护者决定"的原则相悖，且 bump 提交的归属变得含混。输。
- **npm Trusted Publishing（OIDC 免 token）** —— 免维护 token，但需在 npm 网页为包预配置仓库信任关系，且只覆盖 CI 这一条路；granular token 在 CI 之外还能给本机手动应急发布复用。输在少了本地退路，日后 token 政策再变可换。

## Consequences

- 换来：发布动作与版本 tag 一一对应，每个已发布版本可回溯到确切 commit；发布前 typecheck/test/构建在干净环境强制全绿，本机环境差异不再影响发布；provenance 让 npm 包页面展示构建来源。
- 代价：发布依赖 GitHub Secrets 里正确配置 `NPM_TOKEN`，token 失效需要去 npm 更新；首次发布前的配置（npm 生成 token、GitHub 存 Secret）是一次性人工步骤；发布产物在 CI 构建，本机不再"顺手"验证打包内容，异常要回到 CI 日志排查。
