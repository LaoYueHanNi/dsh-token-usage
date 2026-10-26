# DR: PR 必须先关联 issue 才能合并

Status: implemented

## Problem

GitHub 没有原生开关强制 PR 关联 issue。不强制时，改动动机散失在聊天里，事后无法回答"这个 PR 为什么存在"，贡献者也可以跳过需求讨论直接改代码。需要先提 issue、再在 PR 中引用它的硬约束。

## Decision

- 新增 `.github/workflows/require-issue.yml`：PR 打开、编辑、重开时检查标题与描述中是否出现 `#<编号>`，没有则 `Require linked issue` 检查失败并给出补正指引。
- 该检查暂不设为必需：不启用 `main` 分支保护规则。仓库当前仅维护者一名贡献者，外部本就无法直推 `main`，约束落在维护者合并把关上；贡献者变多或需要连维护者也硬约束时，再把 `Require linked issue` 加入分支保护的必需检查。

## Alternatives considered

- **仅靠 PR 模板与口头约定** —— 模板可以不填，无强制力，输在无法保证。
- **Rulesets 必填字段** —— ruleset 同样表达不了"必须引用 issue"，仍需外部检查配合，与 branch protection + status check 等价但配置更繁琐。
- **第三方 Marketplace App** —— 引入额外权限与外部依赖；一个约 20 行的 workflow 即可覆盖，不值得。

## Consequences

- 代价：检查非必需，检查失败的 PR 仍可被合并，约束是软性的，靠维护者合并前把关执行。
- 换来：每个 PR 是否关联 issue 在检查结果里一眼可辨，动机沉淀在 issue 里可追溯；维护者自己保留直推 `main` 的自由。
