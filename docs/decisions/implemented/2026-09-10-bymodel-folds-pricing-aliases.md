# DR: 按模型表按定价别名折叠到 modelId

Status: implemented

## Problem

用量记录写的是请求当时的模型名（`deepseek-v4-flash`、`deepseek-v4-flash-0731`、`deepseek-v4-flash-08xx`）。计费时 `cloudToTable` 把 feed 的 `modelId` 和 `aliases` 展成同一套价，所以这些行都显示「定价」；但 `byModel` 仍按原始名分行。设置页「按模型」表把同一价目拆成多行，费用、请求、命中率各自一块，读不出这条定价实际烧了多少。

定价总览已经按「一模型一行、别名只作搜索」处理（见 [定价表总览](2026-09-05-pricing-table-overview.md)）；用量表的口径与它对不齐。

## Decision

**rollup / 原始记录仍按原始模型名存储。** 别名随云端 feed 变，写进聚合文件会在下次定价更新后分组错位。折叠只发生在读路径的费用层（`attachCosts`），用当前 feed 的 alias → modelId 映射。

碰撞规则与 `cloudToTable` 一致：别名先写入（已占用的跳过），`modelId` 后写必赢（某名既是 A 的别名又是 B 的 modelId 时归 B）。表中没有的名字保持原样，未定价行互不合并。命中后行的 `model` 展示为该定价条目的 **modelId**，行上不列出别名。

模型筛选下拉来自折叠后的 `byModel`，选项已是 modelId。`filterSummary`（及 recent / requestSeries）按规范名匹配：选 `deepseek-v4-flash` 含其全部别名用量；残留的别名 query 也覆盖整族；未定价名规范名等于自身，仍精确匹配。会话页 `UsageView` 走同一条 `attachCosts`，按模型表一并聚合。

`rateRows` / `byHour` / `bySession` 不改键：趋势图按小时把所有模型加总，会话表按会话再折，都不依赖 byModel 行名。

## Alternatives considered

- **把规范名写进 rollup** —— 读路径零折叠、筛选天然按 modelId，但 feed 一改别名，历史分组就错，必须重建 rollup。输了：别名是定价表的属性，不是用量事实；记录层保持原始名，定价更新免费重分组。
- **纯前端折叠 byModel** —— 设置页表格改动最小，但会话页、筛选下拉、定价总览「已用」徽标会各写一份；筛选若仍精确匹配原始名，选 modelId 会丢掉别名用量。输了：费用层折叠一次，所有消费者对齐。
- **筛选仍精确匹配原始名、下拉继续列出别名** —— 表格聚合但筛选项重复，选别名只能看该别名自己的用量。输了：别名即同一价目，再提供「只看某一个别名」与聚合目标相反。

## Consequences

- 换来：按模型表一行一个定价 modelId；筛选选 modelId 覆盖整族；定价总览「已用」按 modelId 命中（此前只用了别名时徽标会漏）；定价 feed 更新后下次读取即按新别名重折，无需重建数据。
- 代价：筛选不再能只看某一个别名——这是刻意的。`byModel` 行名不再等于记录上的原始名，调试 raw rateRows 时两者会对不上（rateRows 仍是原始名，属有意保留）。canonical map 与 pricing table 必须来自同一次 feed 解析，stats 路由已用 `readPricingContext` 钉住这一点。
