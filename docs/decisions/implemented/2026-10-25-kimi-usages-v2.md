# DR: Kimi usages 新版响应兼容与月度额度归一化

Status: implemented

## Problem

Kimi For Coding 的 `GET /coding/v1/usages` 已返回新一代结构：旧 `limits[].detail` 的 `limit / used / remaining` 改为字符串，`resetTime` 改为 ISO-8601，同时新增 `usages.limit_5h`、`usages.limit_month_code`、`usages.limit_month_total` 的比例与重置时间。旧适配器只接受有限数值和 epoch 时间，并且只读取旧 5 小时 / 每周字段，因此把有效的实机响应误报为 `no usable limit buckets in response`，也看不到月度额度。

## Decision

在 `src/quota/adapters/kimi.ts` 内做 Kimi 专属的双代响应归一化，不改公共供应商契约：

- 旧 `limits[].detail` 与顶层 `usage` 继续可用；额度接受非负 number / 数字字符串，已用量可由 `remaining` 或 `used` 推导，重置时间接受 epoch 或 ISO-8601。多个旧 5 小时桶仍选择重置最晚者。
- 新 `usages.limit_5h.used_ratio` 是更精细的 5 小时读数，与旧桶同时存在时优先使用；旧桶作为没有新字段时的回退。
- 月度优先读取编程套餐的 `limit_month_code`，缺失时回退账号级的 `limit_month_total`。比例统一换成 `usedPercent`，`reset_time` 归一成 epoch ms。
- 输出顺序保持 5 小时、旧响应可能存在的每周、每月；任一有效窗口即可成功，全部不可解析时才保留原 parse 错误。
- `tests/quota-adapters.spec.ts` 固定新版实机形状、旧数字形状、旧字符串 + ISO 形状、月总额回退及路由匹配。实机密钥只用于验证，不进入 fixture 或仓库。

## Alternatives considered

- **把数字字符串与 ISO 解析直接塞进公共 `numberOf` / `toEpochMs`** —— 会改变所有供应商对非法字段和数字字符串的既有解释，修复一家却扩大全部适配器的兼容面。否决：在 Kimi 内组合现有 `amountOf` 与本地时间解析。
- **只让旧桶接受字符串，忽略 `usages`** —— 能消除报错，但会丢掉新版更精细的 5 小时比例与全部月度信息，未满足接口迁移的完整语义。否决。
- **同时展示 `limit_month_total` 与 `limit_month_code`** —— 两个窗口在现有面板都只能叫「每月」，既重复又无法解释两个口径；本适配器归属于 Coding 套餐，选择 code 池并以 total 兜底。
- **移除旧每周与多桶逻辑，只认新版** —— 旧配置、缓存代理或尚未升级的账号会再次失效。否决：保留窄范围回退。

## Consequences

- 代价：Kimi 适配器增加一套比例字段和字符串 / 时间兼容分支，需随上游字段继续维护；月度依赖 code 与 total 的业务命名，若上游再引入更细池子仍需重新评审。
- 换来：当前实机响应可显示 5 小时与每月额度，旧响应仍能显示 5 小时与每周；公共 `QuotaWindow`、凭据、缓存和面板无需改动。
