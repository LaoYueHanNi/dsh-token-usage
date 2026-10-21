# DR: Command Code 配额适配器（四端点实时额度）

Status: implemented

## Problem

Command Code（commandcode.ai 的 Go / GOAT / Pro 订阅）用户选中该供应商时，输入栏配额按钮整个不显示：pi-ai 路由 `command-code` 不在任何适配器的 `routes` 里，`resolveQuotaAdapter()` 落空 → `unsupported` → 按钮隐藏（issue #12）。该家的额度语义特殊：`/alpha` 控制面（官方 CLI 使用的私有路由，未公开文档化）把滚动窗口（5 小时 / 周）与月度 credits 拆在不同端点，且月度**已用量**不在任何单一响应里直接给出。

## Decision

按[适配器契约](./2026-08-25-quota-provider-adapter.md)的标准步骤新增 `src/quota/adapters/command-code.ts` 并注册（coding plan 段内）。匹配**只认 `*.commandcode.ai` host**：实测宿主内嵌 pi-ai 目录（41 个路由）没有 Command Code 条目，社区靠扩展以 `commandcode` 等临时名注册——路由键不构成 catalog 身份，只会在用户碰巧起同名时误命中无关端点。`routes` 置**空表**，把每个命中都标为 host 匹配的自定义路由（显示名带「· Command Code」限定，防别名冒名），也不占 `CATALOG_BASE_URLS`（没有目录路由可回退；自定义路由必填 baseURL，host 总是可得）。查询固定打 `https://api.commandcode.ai` 的四个 GET（Bearer 用推理同一把 key）：

1. `/alpha/whoami?limits=1` → `org.id`；**软失败**（auth 除外——401 说明 key 已死，必须上抛），无 org 就退回账号级端点；
2. `/alpha/billing/credits[?orgId=]` → `credits` 三余额 + `windowLimits`（顶层为准，嵌套在 `credits` 里的变体兼容）；**仅 `limited === true` 时**输出 five_hour / weekly 两窗口（`used / cap`，`resetAt` epoch ms）；
3. `/alpha/billing/subscriptions[?orgId=]` → `planId` 与周期起止；
4. `/alpha/usage/summary[?since=<periodStart>]` → `totalCost`。

月度窗口不查套餐表：`used = totalCost / (totalCost + monthly + purchased + free)`——周期已花销加全部剩余余额即池子，`resetAt` 用 `currentPeriodEnd`。`planTier` 由 `planId` → 显示名映射（`individual-goat` → `GOAT`），未知 id 原样透传。

## Alternatives considered

- **issue #12 草案：维护 planId → 月度总额表，`(总额 − monthlyCredits) / 总额` 算月度** —— 输在把官方 CLI 的套餐目录硬编码进插件：新套餐上线即失效，届时只能丢窗口或猜分母；改用 `/alpha/usage/summary` 的 `totalCost` 实时计算（cc-switch 的做法）后不需要任何套餐表。
- **subscriptions / summary 软失败降级（草案：失败只丢月度窗口）** —— 输在把传输错误吞成「少一个窗口」，用户看到看似正常的两条滚动条却不知月度查询已死；cc-switch 把这三路当硬依赖、错误如实上报，跟随。
- **whoami 硬失败（cc-switch 的处理）** —— 输在 org 限定只是账单查询的加宽参数，网络抖动不该杀死整个查询；折中为仅 auth 上抛、其余按无 org 继续。
- **路由键匹配（issue 评论建议认领 `command-code`，或社区扩展实际注册的 `commandcode`）** —— 输在 pi-ai 目录根本没有该家条目：键名不构成 catalog 身份，只会在用户碰巧起同名时误命中无关端点；真实用户全是手填 baseURL 的自定义路由，host 是唯一稳定信号（拆解宿主 app.asar 内 pi-ai 目录 41 个路由实证后移除键匹配）。

## Consequences

- 代价：一次查询最多四串行请求（whoami → credits → subscriptions → summary，后三者依赖 orgId / periodStart）；`planId` → 显示名映射会随官方新套餐陈旧——但只影响标签美化，未知 id 原样显示，额度数值不受影响。
- 换来：Command Code 用户获得配额按钮与三窗口（5 小时 / 周 / 月）加套餐名展示；月度额度永远与官方账单一致（实时 `totalCost`），无表可陈旧；`limited: false` 或缺 `windowLimits` 的账号优雅退化为仅月度窗口。
