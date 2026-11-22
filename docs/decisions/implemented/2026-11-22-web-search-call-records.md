# DR: 采集联网搜索调用并按模型轮次计入 token

Status: implemented

## Problem

联网搜索走工具管线（`dsh-tool-web` → `ctx.web`），不经过 `ctx.llm`，因此插件的账本对它完全没有记录：没有调用次数，也没有它消耗的 token。实测本机 396 个会话日志里有 135 次 `web_search` 调用、150 次 `web_fetch` 调用、154 条 `web/deepseek-search-llm-request` 事件，而 `usage-*.jsonl` 中零命中。

搜索的计费方式随宿主选中的后端而变：`deepseek-official` 后端把一次搜索当作一个完整的 Messages 模型轮次，真实产生输入/输出 token；`deepseek-search-api` 后端按次调用专用检索接口，不产生模型 token。宿主目前把官方后端响应里的 `usage` 在 `mapAnthropicResponse()` 中丢弃（响应类型只声明了 `content`），所以本地会话日志和 `tool/result.meta` 都没有 token 数。

用户的口径是：**能拿到 token 就记 token，不按次收费；拿不到就不记费用**。不要求区分两套计费后端，也不要求插件去绕过宿主截获 HTTP 响应。

## Decision

- **采集点**复用已订阅的 `session/event`：`tool/call`（`name === 'web_search' | 'web_fetch'`）与 `tool/result` 配对，一对事件合成一行；`web/deepseek-search-llm-request` 仅归属打开中的 `web_search` 草稿，作为「这次搜索触发了一个模型轮次」的证据，只用于累计轮次数与模型名。
- **数据形状**：新增 `kind: 'web'`，`requestId` 为 `web:<sessionId>:<resultSeq>`（结算事件的持久 seq，可重复同步去重、可被全量扫描重建）。行字段：`web.tool`（`web_search` / `web_fetch`）/ `web.callId` / `web.queryCount` / `web.rounds` / `web.failed` / `web.errorCode` / `web.durationMs`；`usage` 与 `model` 仅在宿主报告时写入。查询原文不进账本，只记条数，需要时从会话日志追溯。不写 `provider`，不落 `web/deepseek-search-llm-request` 标记行。
- **宽容读取 usage**：从 `web/deepseek-search-llm-request` 事件的 `data.usage`、`tool/result` 的 `meta.usage` / `message.usage` 三处尝试读取，接受插件 `UsageFields` 与 Anthropic Messages `usage` 两种拼写；读到就累计到该调用，读不到就让该行保持无 `usage`。绝不写 0 假数据。
- **实时与历史共用实现**：`WebCallTracker` 被 `index.ts` 的实时监听和 `sync.ts` 的全量扫描共同驱动；同步只喂 `ownEvents`，Fork 继承前缀不参与，避免跨会话重复。
- **统计口径**：只有带 `usage` 的 web 行进入请求维度：token 计入总 token / 费用 / `byDay` / `byModel` / `rateRows` / `bySession`，请求数按观察到的模型轮次 `rounds` 计（至少 1）。没有 `usage` 的 web 行**不进任何请求维度**——即使观察到了模型轮次，也不增加请求数，避免「有请求、0 token、¥0」把未知成本显示成免费请求。所有 web 行都进入 `webRows`（按日、模型、工具统计 `calls` / `failures`），作为调用事实。web 行不计入全局 `failures`、不污染模型性能均值、不进 `recent` / 请求池 / 请求序列。
- **展示**：设置页「运行开销」在辅助请求分类之后新增可折叠的「联网工具」一行（默认展开，风格与辅助请求分类一致），顶行显示总调用次数，展开子项按固定顺序列出 `联网搜索`（`web_search`）与 `网页抓取`（`web_fetch`）各自的调用次数。传输层 `WebSearchSummary` 包含 `calls`、`failures` 与 `byTool`，搜索 token 的费用随普通请求一起计价，不在这里单列。没有 token 数据时不显示费用，也不额外标注「未计量」。会话请求池不展示联网工具行。
- **兼容旧日志**：`web_search` 旧版参数 `{ query }` 与新版 `{ queries: [] }` 都解析；`tool/result` 的 `toolCallId` 与旧式的 `message.source.callId` 都接受。

## Alternatives considered

- **按搜索后端 / 模型拆子项**：不采用。`tool/call`、`tool/result` 与 `WebSearchMeta` 均不记录实际命中的搜索 provider，只有 `deepseek-official` 会额外写模型名，其余后端无法区分；且多数用户只用单一后端，按工具拆（搜索 / 抓取）跨后端 100% 准确、语义清晰。
- **复用 `kind: 'aux'` + `auxKind: 'web-search'`**：拒绝。aux 行的 `requests` 恒为 1，而搜索需要按模型轮次计请求数；按次后端的搜索没有模型轮次，复用 aux 会让请求数虚高，且 aux 的定价/展示假设都带模型与费率。
- **在插件里包装全局 fetch 截获响应 usage**：拒绝。可以立即拿到 token，但依赖宿主用全局 `fetch`、依赖响应 JSON 形状、并发配对靠 query 文本，属于灰色手段，宿主换实现即失效。等宿主在事件或 `tool/result.meta` 里保留 usage 更稳。
- **要求上游先补 usage 再落地**：不采用。调用事实本身有价值（次数、查询、耗时、失败），而且历史可回填；usage 作为可选字段，等宿主补齐后自动生效。
- **估算 token**：拒绝。输入可粗略计算，输出、系统提示和搜索结果注入的 token 不可知，估出来是假账，比「未计量」更糟。
- **独立维度、不并入总账**：不采用。用户明确选择 token/费用并入总览、请求数按搜索模型轮次计。
- **无 usage 时也按轮次计入请求数**：拒绝。宿主当前不报 usage，这样做会让总览、按模型、按会话的请求数变大而 token 与费用不变，搜索模型甚至会以「有请求、¥0」的行出现在按模型页；会话行的请求数也会与会话请求池（不含搜索）对不上。轮次数仍保存在行上，等 usage 出现时一并计入。
- **账本保存查询原文**：拒绝。没有任何展示或统计使用原文，复制进账本只会扩大敏感数据面与文件体积；会话日志本身保留原文。
- **传输层携带查询数 / 轮次 / 费用 / 按模型明细**：拒绝。卡片只用调用次数，提前暴露未使用的字段会增加客户端约定面；需要时再扩展。

## Consequences

- **当前版本 web 行通常不进总账**：宿主尚未报 usage，运行开销只显示调用次数，总请求数、token 与费用都不受搜索影响。宿主一旦在这些位置附带 usage，同一个采集路径自动带上，按轮次计入请求数、token 与费用，卡片展示保持不变。
- **三个口径并存**：一次 `web_search` 工具调用可能触发多个 Messages 轮次（多查询，实测 41/135 次），所以行上分别记录调用、查询条数与轮次；有 usage 时总请求数按轮次计，与调用数不相等是预期行为。卡片只显示调用次数，避免把轮次或查询数误读成「搜索次数」。
- **Fork 与重复同步**：写入口共享 tracker 且同步只读自有事件切片，`requestId` 含结算 seq，重复扫描去重；`isReconcilableKind()` 把 web 纳入可重建来源，全量扫描可以清理错归或重复行（写入前仍走既有滚动备份）。
- **历史回填需手动全量同步**：首次同步只在未初始化的数据目录上自动运行；已有数据目录的用户升级后，需在设置页手动触发一次全量同步，才能把升级前会话里的搜索补进账本。新发生的搜索由实时监听直接记录。
- **Rollup 新增维度**：`TokenSummary.webRows` / `RollupFile.webRows` 为可选字段，按（日、模型、工具）只存 `calls` / `failures`；旧 rollup 读作空列表（缺失 `tool` 的行回落为 `web_search`），新版本写入后随冻结日文件一起合并。
- **记录内容**：`web.queryCount` 只记条数；`tool/result` 的来源列表与正文不复制进账本，只保留耗时与失败码。
- **降级兼容偏差大于 aux**：旧版插件的 `coerceRecord` 把未知 `kind` 读成普通请求，因此每条 web 行（包括没有模型轮次、没有 usage 的）都会在旧版里算作一次 `model: ''` 的请求，并进入最近请求窗口。aux 行本身是真实的模型调用，被当作请求只是分类偏差；web 行则是凭空多出的请求。降级到旧版期间请求数会虚高，升级回新版后恢复。
