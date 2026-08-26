# DR: host 命中的自定义路由，配额显示名为「别名 · 适配器家族名」

Status: implemented

## Problem

配额的适配器匹配规则是 base URL host 优先（自定义路由可叫任何名字但指向已知端点），但面板标题与 tooltip 取的是 `credentials.displayName`——配置链里**路由的显示名**。于是一个自定义路由名叫"OpenAI"、地址却填 OpenCode Go 端点的用户，用量查的完全是 OpenCode Go 套餐，标题却显示"OpenAI"：数据归属与显示身份冲突，且别名会冒名顶替另一个家族的配额。

## Decision

适配器契约新增可选 `routes: readonly string[]`（各适配器声明自己的目录路由 key，六个适配器均已列出）；service 解析出适配器后判定：路由 key 在 `routes` 内（对齐命中）→ 显示名维持 `displayName` 原样（智谱仍显示"智谱 Coding Plan"，本地化不丢）；不在内（host 命中的自定义路由）→ `providerName` 组合为 `「别名 · 适配器 label」`，别名缺失时用路由 key 顶替。组合在 service 侧一次完成，ok / error / no-credential 三种 payload 一致，wire 与浏览器端零改动（标题、tooltip、面板自动生效）。

## Alternatives considered

- **维持现状（只显示路由别名）** —— 别名是用户自起的，配额却属于实际命中的套餐家族；"OpenAI · 5 小时 37.5%"是事实性误导。
- **host 命中时直接替换为适配器家族名** —— 更短，但丢掉用户自己的入口标识；两个自定义路由指向同一家族（如主备两个 key）时无法区分。
- **客户端比对 `providerName` 与 `adapterLabel` 字符串判断冲突** —— 两个名字源各自维护（且智谱目录名是中文、label 是英文），字符串比较必然误判"不一致"，产生"智谱 Coding Plan · Zhipu GLM Coding Plan"式的重复标题；判定必须基于路由归属这一结构化信号。

## Consequences

- 代价：适配器契约多一个可选字段（缺席时视为全部认领，行为不变）；host 命中的自定义路由标题变长一截。
- 换来：自定义路由场景下"哪个入口 + 哪家配额"一次讲清（如「OpenAI · OpenCode Go」），目录路由场景显示完全不变；显示名组合收敛在 service 一处，全部下游表面自动一致。
