# DR: 记录行新增 provider 实机响应模型字段（responseModel）

Status: implemented

## Problem

记录行的 `model` 一直是请求路由名——DSH 模型路由的别名形式（`auto/GLM-5.3-Flash`、`group/glm-5.3-flashx`、`zcode/GLM-5.3-Flash-Trial` 等）。它同时承担展示与计费归一两个职责：定价表别名正则把路由名解析到 feed 行的 modelId，所以费用正确；但用户无法从账本回答「这次调用实际由哪个模型服务」。路由前缀（`auto/`、`group/`、`zcode/`）是网关路由别名，provider 响应体里的 `model` 字段才是实机模型，两者可能不同（实测本机会话：`zcode/GLM-5.3-Flash-Trial` 的实机响应是 `glm-5.3-flash`，`auto/GLM-5.3-Flash` 是 `glm-5.3-flash`）。

实机模型在宿主数据里已经存在：pi-ai 系 adapter（OpenAI 兼容端点）从流式响应的 `model` 字段抓取实机名，放进 `finish` chunk 的 adapter 私有 `replayState.response.responseModel`；agent-loop 把该 envelope 原样存进 assistant message 的 `source.replayState`，随 `assistant/message` 事件持久化。插件此前在两个采集点都把它丢掉了：aux 监听器在 `finish` 分支只读错误状态，会话事件投影只读 `source.model`。

## Decision

一条记录行同时保存两个模型名——既有 `model`（请求路由名）与新增可选 `responseModel`（实机响应模型），二者并存于同一行。requestId 去重身份与两者无关；`responseModel` 不参与任何唯一性判断。

**消费语义（算费与展示）：取名统一走 `effectiveModelOf(record)` = `responseModel ?? model`，之后再进既有归一化链（ID 精确匹配 → provider 前缀剥离 → 别名正则 → 手动关联）。** 实机名通常就是 provider 规范 id，直接命中定价表 ID，路由别名的前缀剥离与正则猜测只是兜底；字段缺失（旧行、不报告实机名的 adapter）时行为与历史完全一致。所有模型维度——实时计价解析（stats-route 的 RateResolver）、聚合键（`summarizeRecords` 的 byModel / byHour / rateRows / auxRows / bySession）、读取侧过滤（`filterRecordsByRange` / `filterSummary` 的模型筛选）与展示折叠（`attachCosts` 的 canonical 折叠）——都消费同一个有效名；`recent` 窗口保留原始记录（两字段并存）。严格优先、不二次回退：实机名解析不到定价即按 unpriced 呈现（unpricedModels 会列出），让定价缺口可见，而不是静默退回路由名计费。

采集与解析：

- 新增 `usage-record.responseModelOfReplay(replayState)`：对 adapter 私有 envelope 做防御性解析，只识别已知形状（`kind: 'pi-ai' && version: 2`）的 `responseModel` 字符串字段；其余形状（含官方 `deepseek-messages` envelope——它没有实机字段）与非字符串值一律读为缺失，绝不猜测。
- 实时 aux 路径（`llm/stream` waterfall）：监听器在成功的 `finish` chunk 上解析 `replayState`（错误 finish 没有 envelope），写入行。
- 会话事件路径（实时监听与历史 sync 共用 `recordOfEvent` → `recordFromEvent`）：从 `event.data.message.source.replayState` 解析，写入行。
- 行校验与重解析：`isRecord` 放行可选 string 字段，`coerceRecord` 在两个构造分支保留它（空串归一为缺省），旧格式行无此字段读为缺失，不触发重写。

磁盘格式：`usage-*.jsonl` 行新增可选 `responseModel` 键。旧行无该字段读为缺省，无需迁移；rollup 聚合行只存一个模型名——新写的行存有效名（实机优先），已吸收行保持其写入时的名字，同一天的行不会混两种键（upto 按日期吸收，升级发生在当天文件仍为热读）；旧插件读新 rollup 时按实机名走它自己的解析链，最坏情况显示为未定价，不丢数据。

## Alternatives considered

- **用实机模型替换 `model` 字段本身。** 通道痕迹只在路由名里——`zcode/GLM-5.3-Flash-Trial` 与 `zcode/GLM-5.3-Flash` 的实机响应同为 `glm-5.3-flash`，但 Trial 通道计费身份独立；替换字段会抹掉通道痕迹且不可回退。折中落地：字段并存、消费侧取名优先实机名（见 Decision），原始路由名保留在行上。
- **另立一行记录实机模型。** 同一请求两行会破坏「一行 = 一次 provider 调用」的账本粒度，去重、聚合、费用折叠都要处理行间关联。拒绝。
- **实机模型只作为附加展示信息，聚合与计费仍按路由名。** 那样归一化链仍要为每个路由别名做前缀剥离与正则猜测，识别错误面没有缩小，字段只是「能看到、用不上」。本决策选择消费侧统一走有效名，展示分组随之自然合并。
- **实机名解析不到定价时二次回退请求名计费。** 费用看起来连续，但定价缺口被静默掩盖——provider 报出新模型名而定价表没跟上的信号会消失。选择严格优先，unpriced 呈现并进 `unpricedModels` 提醒。
- **解析 finish chunk 之外再从事件内嵌 `stream` 数组挖 finish 记录。** `source.replayState` 是同一份数据的持久化形态，直接可读；扫 stream 是多余的脆弱路径。拒绝。

## Consequences

- 代价：`responseModel` 依赖 adapter 私有格式——pi-ai 形状升级（version 变更）或宿主换用其他 adapter 时字段消失，行为退化为路由名兜底（不丢数据）；官方 deepseek adapter 当前不报告实机名；**通道级计费身份被有效名吸收**——实机名相同的通道（如 Trial）与正式通道落进同一聚合行并按实机名费率计费，若定价表将来为通道设独立行，需以记录行保留的原始 `model` 字段重新区分；实机名大小写不统一，聚合键按原样区分（`glm-5.3-flash` 与 `GLM-5.3-Flash` 是两行），canonical 折叠大小写无关，展示层看到的是折叠后 id；新旧 rollup 行的模型名口径不同（吸收边界前后），但 (day, model, rate) 键各自自洽，总额与费用不受影响；严格优先意味着实机名未定价的行费用为 0 并进 `unpricedModels`（有意的可见信号）。
- 换来：账本第一次同时保存「请求什么模型」与「实际由什么模型服务」；算费与展示统一消费有效名，归一化链从「猜测别名」退化为「直接命中 + 兜底」，路由别名识别错误面显著缩小；两条采集点（旁路实时流、会话事件含历史回填）同口径；requestId 去重身份与字段无关，旧数据行为完全兼容。
