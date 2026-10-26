# DR: npm 发布改用 Trusted Publishing（OIDC 免 token）

Status: implemented

## Problem

CI 发布若用 granular access token，就要往 GitHub Secrets 长期存一份可发布凭据：它会过期、需要人工轮换，泄露面随仓库成员与 secret 数量增长。npm 已公告收紧绕过 2FA 的 token（2026 年 8 月起限制账户变更，2027 年 1 月起限制直接发布），长期把发布可用性押在这类 token 上，等于把一条会被政策收回的通道当成主干道。

Trusted Publisher（OIDC）可以让 npm 在发布时按"仓库 + 工作流文件"换取短期令牌，仓库侧不存任何长期凭据。但它不是零成本：连接的 provider 与必填字段创建后不可修改，只能删除重建；连接建立后还有验证期限，逾期没有完成一次发布，npm 会把它视为未验证而失效。

## Decision

在 npm 包 `@laoyuehanni/dsh-token-usage` 的包设置中建立 Trusted Publisher 连接：Publisher 为 GitHub Actions，组织或用户 `LaoYueHanNi`，仓库 `dsh-token-usage`，工作流文件名 `publish.yml`，Environment name 留空（仓库未使用 GitHub Environment），允许 `npm publish`、`npm stage publish`、`npm dist-tag` 三项权限——前两项覆盖正式发布与 rc 的 `npm stage publish`，`npm dist-tag` 覆盖 rc 版的 `--tag next`。

CI 侧 `.github/workflows/publish.yml` 删除 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`，不再向发布步骤注入任何凭据，令牌由 npm CLI 用 OIDC 现场换取；因 setup-node 自带的 npm 版本偏旧，流程在发布前显式执行 `npm install -g npm@latest`（Trusted Publishing 要求 npm CLI 11.5.1 及以上）。`--provenance` 与 `permissions.id-token: write` 保留不变。

本机手动发布的退路不变，且不需要新造长期凭据：npm 官网登录态支持交互式 WebAuthn / OTP 二次认证，本机 `npm publish` 走这条路径即可，无需绕过 2FA 的 token。因此仓库 Secrets 可以保持为空。

## Alternatives considered

- **继续用 granular access token 存进 `NPM_TOKEN`** —— 要在 GitHub Secrets 长期保管一份可发布凭据，轮换与泄露风险随时间累积；npm 已公告限制绕过 2FA 的 token，2027 年 1 月后该路径可能直接失效，届时发布链路要整体重建。输在把发布可用性押在一份会被政策收回的凭据上。
- **改为本机 `npm login` 后手动发布，不要 CI 发布** —— 丢失"发布产物 ↔ 提交 ↔ tag"的一一对应，无法从 git 历史回溯某个版本从哪个 commit、哪个环境发出，也失去在干净环境强制 typecheck / test / 构建这道发布前质量门。输在可追溯性。
- **Trusted Publisher 同时配 GitHub Environment 隔离**（填 Environment name 并在 workflow 声明 `environment:`）—— 隔离更强，还能加审批与保护规则，但要多建一个 environment 并维护其规则，与单人维护的仓库复杂度不匹配；信任范围已由"仓库路径 + 工作流文件名"限定。输在收益不抵运维成本。
- **token 与 OIDC 双通道并存** —— 两条通道都要维护、还要随时判断哪条真正生效，反而模糊单一事实来源，而 token 通道终将被政策淘汰。输在重复即无人负责。

## Consequences

- 换来：CI 发布不再需要任何长期凭据，仓库 Secrets 为空也能发版；npm 收紧绕过 2FA token 的政策变化不再影响发布链路；包页面的 provenance 指向确切的仓库与工作流。
- 代价：发布能力绑定到 npm 包侧的 Trusted Publisher 连接——provider 与必填字段创建后不可改，只能删除重建；建立后有验证期限（npm 给出的窗口约 48 小时），逾期未发布则连接失效需重新配置；仓库名、workflow 文件名或 CI 平台任一变化都会让连接失效。
