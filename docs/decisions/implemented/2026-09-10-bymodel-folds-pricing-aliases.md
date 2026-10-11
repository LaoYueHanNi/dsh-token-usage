# DR: 按模型表按定价别名折叠到 modelId

Status: implemented

## Problem

用量记录写的是请求当时的模型名（`deepseek-v4-flash`、`deepseek-v4-flash-0731`、`deepseek-v4-flash-08xx`）。计费时 `cloudToTable` 把 feed 的 `modelId` 和 `aliases` 展成同一套价，所以这些行都显示「定价」；但 `byModel` 仍按原始名分行。设置页「按模型」表把同一价目拆成多行，费用、请求、命中率各自一块，读不出这条定价实际烧了多少。

定价总览已经按「一模型一行、别名只作搜索」处理（见 [定价表总览](2026-09-05-pricing-table-overview.md)）；用量表的口径与它对不齐。

## Decision

> [!NOTE]
> 本决策中的旧 aliases 识别阶段已于 2026-10-11 由 [DR: 模型别名统一使用 aliasPatterns 正则](2026-10-11-regex-only-model-aliases.md) 取代；当前仅识别 ID 与正则。

> [!NOTE]
> 本决策中的 别名碰撞、未定价名称分组及历史无需重建的约定 已于 2026-10-10 由 [DR: 统一模型自动识别与带定价指纹的历史重算](2026-10-10-model-pricing-resolution.md) 取代。

**rollup / 原始记录仍按原始模型名存储。** 别名随云端 feed 变，写进聚合文件会在下次定价更新后分组错位。折叠只发生在读路径的费用层（`attachCosts`），用当前 feed 的统一识别结果。定价上下文指纹变化时仍须从原始记录重新选择 RateKey；原始模型名不变。

识别按原名 ID → 有效 provider 末段 ID → 原名与末段的完整正则分阶段执行，全部忽略大小写；跨模型正则命中报歧义，不能先写者赢。未定价完整名称按忽略大小写分组，保留原始拼写，不同 provider 保持独立。命中后行的 `model` 展示为该定价条目的 **modelId**，行上不列出别名。

模型筛选下拉来自折叠后的 `byModel`，选项已是 modelId。`filterSummary`（及 recent / requestSeries）按规范名匹配：选 `deepseek-v4-flash` 含其全部别名用量；残留的别名 query 也覆盖整族；未定价名规范名等于自身，按完整名称忽略大小写匹配。会话页 `UsageView` 走同一条 `attachCosts`，按模型表一并聚合。

`rateRows` / `byHour` / `bySession` 不改键：趋势图按小时把所有模型加总，会话表按会话再折，都不依赖 byModel 行名。

## Alternatives considered

- **把规范名写进 rollup** —— 读路径零折叠、筛选天然按 modelId，但 feed 一改别名，历史分组就错，必须重建 rollup。输了：别名是定价表的属性，不是用量事实；记录层保持原始名，定价更新免费重分组。
- **纯前端折叠 byModel** —— 设置页表格改动最小，但会话页、筛选下拉、定价总览「已用」徽标会各写一份；筛选若仍精确匹配原始名，选 modelId 会丢掉别名用量。输了：费用层折叠一次，所有消费者对齐。
- **筛选仍精确匹配原始名、下拉继续列出别名** —— 表格聚合但筛选项重复，选别名只能看该别名自己的用量。输了：别名即同一价目，再提供「只看某一个别名」与聚合目标相反。

## Consequences

- 换来：按模型表一行一个定价 modelId；筛选选 modelId 覆盖整族；定价总览「已用」按 modelId 命中（此前只用了别名时徽标会漏）；识别或价格规则变化时下次读取按新上下文重选历史 RateKey 并重折；源记录不完整则保留用量、隐藏费用。
- 代价：筛选不再能只看某一个别名——这是刻意的。`byModel` 行名不再等于记录上的原始名，调试 raw rateRows 时两者会对不上（rateRows 仍是原始名，属有意保留）。canonical map 与 pricing table 必须来自同一次 feed 解析，stats 路由已用 `readPricingContext` 钉住这一点。
