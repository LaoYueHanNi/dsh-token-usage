# DR: 采集联网搜索调用记录并纳入运行开销维度

Status: proposed

## Problem

插件的用量账本只从模型调用侧投影：`assistant/message`、`compaction/summary`、`turn/end`、`llm/retry`，以及 `llm/stream` waterfall 上的旁路辅助调用（见 [DR: 记录并单独展示辅助模型请求](../implemented/2026-10-21-auxiliary-model-requests.md)）。联网搜索走的却是 `ctx.tools` 工具管线：`@deepseek-ai/dsh-tool-web` 把 `web_search` / `web_fetch` 注册为模型可见工具，工具内部调 `ctx.web`，**全程不经过 `ctx.llm`**。因此一次搜索在账本里完全不存在——没有次数，没有耗时，更没有它背后的成本。

实测证据（DSH 0.2.1-rc.3，本会话）：发起一次真实 `web_search` 后，宿主在会话日志写入了三条记录——`tool/call`（seq 553）、`web/deepseek-search-llm-request`（seq 554）、`tool/result`（seq 555）——而插件的 `usage-2026-10-27.jsonl` 中 `web` / `search` 零命中。

搜索比辅助请求更值得记账。当前 profile 的搜索后端是 `deepseek-official`（来自 `dsh-base` 的 `searchProvider: deepseek-official`，本 profile 未覆盖），该后端每次搜索是**一次完整的模型轮次**（`deepseek-v4-flash`，`max_tokens: 4096`），只是走 provider 私有 `fetch` 绕过 `ctx.llm`。这轮消耗真实发生且真实计费，但既不进账也不可观测。

## Proposal

分两步：第一步只落数据，第二步再定展示。第一步是本决策的当前范围，暂不开发。

### 第一步：采集到 JSONL

采集点复用插件**已经订阅**的 `session/event`（`src/index.ts` 中的会话事件监听器），不引入新的宿主能力、不新增 waterfall。宿主对所有 `session.append()` 的事件统一派发，插件今天消费的 `assistant/message` / `compaction/summary` / `llm/retry` 全是 append 出来的，`tool/call` 与 `tool/result` 走同一条路。

可采集的三类事件及其字段：

| 事件 | 追加方 | 字段 |
| --- | --- | --- |
| `tool/call` | `dsh-agent-loop` 的 `appendToolCall()` | `name`、`arguments`（`web_search` 为 `{"queries":[...]}`，`web_fetch` 为 `{"url":"..."}`）、`callId`、`turn` / `step` |
| `tool/result` | `appendToolResult()` | `meta.sources[]`（`url` / `title` / `snippet` / `publishedAt`）、`meta.truncated`、可选 `meta.answer`；`web_fetch` 的 `meta` 为 `url` / `statusCode` / `truncated`；失败时 `error.{name,code}`（如 `WEB_PROVIDER_ERROR`）；`message.source.callId` 与 `sourceEventSeqs` 用于与 call 配对 |
| `web/deepseek-search-llm-request` | `dsh-web-search-deepseek` 的 `recordRequest()` | `endpoint`、`apiVersion`、`body`（`model` / `max_tokens` / 实际 query / `tools`） |

行结构预计沿用现有 `UsageRecord` 的可选字段风格：新增记录种类承载搜索调用，`kind` 与辅助调用区分开，`auxKind` 之下再分 `web-search` / `web-fetch` 两类（配对的 `tool/call` + `tool/result` 合成一行，`tool/call` 与 `tool/result` 的事件时间差即耗时）。`web/deepseek-search-llm-request` 作为独立的“搜索模型轮次”标记行存在：它只带请求体、不带用量，用途是标出「这次搜索花掉一个 `deepseek-v4-flash` 轮次」，不是计费凭据。

与辅助请求的关键差异：这三类事件都**持久化在会话日志里**，因此历史可回填。回填走 `src/sync.ts` 已有的事件遍历（与 `assistant/message` 回填同一条路），这是辅助请求做不到的——它们不在会话事件里，历史漏记不可回补。`deepseek-search-api` 后端不产生 `web/deepseek-search-llm-request` 事件（该事件只由 `dsh-web-search-deepseek` 追加），但两条后端都产生 `tool/call` / `tool/result`。

### 第二步：展示放到运行开销维度

设置页「运行开销」页签是既有的非会话维度拆分位置，当前由 `auxRows`（kind × day × model × rate）支撑，语义是「会话之外宿主额外花掉的模型调用」。联网搜索在语义上属于同一类（宿主为会话额外花掉的东西），预计在此页签下新增分类展示，而不是新开一个页签。

需要注意的是，运行开销现有的折叠口径是 token / 成本 / 按模型路由定价（`auxRows` 的每一格都带 model 与 rate），而搜索行**没有 token、没有可计费模型**（用量被 provider 丢弃，见 Risks）。因此搜索行不能直接沿用现有 `auxRows` 格子的形状，预计要在该维度下另立一个非计费子形状（次数 / 查询数 / 来源数 / 耗时 / 失败数），并明确其 token 与成本恒为零而不是「未知」。

**会话用量页签的展示尚未决定**（见 Risks）。当前会话用量页签的「最新请求 / 实时请求」面板由 `llm/stream` 观察器驱动（见 [DR: 会话用量页的实时请求池与请求级缓存三档提示](../implemented/2026-10-25-session-request-pool.md)），行是**模型请求**。搜索是一次工具调用而非模型请求，它是否进入该面板、只进入运行开销汇总、还是完全不进会话维度，都还没有结论。本决策默认倾向：**搜索不进会话维度**——会话维度的口径是模型请求的 token / 费用 / 缓存，混入工具调用会让会话加总与模型表对不上；会话用量页签的具体展示留待后续单独决策。

## Alternatives considered

- **不采集，搜索继续不进账。** 放弃：搜索在当前后端下每次花一个完整模型轮次，是真实且可观的支出；不采集等于让账本与实际账单持续偏离，且这种偏离不像辅助请求那样有历史回填机会——不采就永远补不回来。
- **从 `ctx.web` 服务侧监听搜索。** 放弃：`@deepseek-ai/dsh-web` 的 README 明确写着没有观测面（无 provider 变更事件、无能力状态查询），可用性只能通过执行一次搜索并路由抛出的错误码来观察。服务侧没有挂载点。
- **改从 `tools/execute` waterfall 观察工具调用。** 放弃：它是 around-dispatch 瀑布，适合超时、重试或指标埋点，能拿到解析后的参数与结果，但没有持久化落点——历史无法回填，只能从升级后开始记；相比会话事件这条已经存在的数据通路没有优势。
- **从 `web/deepseek-search-llm-request` 事件回填搜索的 token 用量。** 放弃：该事件只有 `endpoint` / `apiVersion` / `body`（请求体），响应里的 usage 被 `dsh-web-search-deepseek` 的 `mapAnthropicResponse()` 直接丢弃（只取 `sources`）。这是宿主层的观测盲区，插件补不上，回填只能得到零 token 的假记录。
- **要求 DSH 上游在搜索响应里保留 usage，再按辅助请求那样计费。** 正确但不可控：跨仓库发布节奏不可控，旧宿主仍需兜底。列入 Risks 作为长期解法，不作为本决策的前提。
- **把搜索做成独立维度，不放进运行开销。** 保留意见：语义上更干净（搜索不是模型调用，辅助调用是），但会让设置页多一个维度卡片，而「宿主在会话之外额外花掉的东西」这个口径运行开销页签已经承担了；预计先用运行开销下的一个分类，待展示稳定后再评估是否独立。
- **让搜索行进入 `auxRows` 的现有格子（带 model 与 rate）。** 放弃：搜索没有可计费模型与费率，硬塞会让该维度的 token / 成本列出现恒零的行，读者会误以为「测得为零」而不是「未计量」，反而比单列非计费子形状更含混。

## Acceptance criteria

- 采集后，一次 `web_search` 在数据目录里留下可追溯的行：查询内容、来源列表条数与各来源的 URL / 标题、是否截断、耗时、失败时的错误码；一次 `web_fetch` 留下 URL、HTTP 状态码、是否截断、耗时。
- `web/deepseek-search-llm-request` 出现时，落一条标记行，含模型名与 `max_tokens`，明确标注它不携带用量、不参与计费。
- 升级前已存在的历史会话里发生过的搜索，能在一次同步后出现在账本中（这是与辅助请求的关键差异，必须可验证）。
- 数据行可被旧的插件版本读取而不报错（旧版会把新 `kind` 当普通请求处理，属已知的向下兼容偏差，与 `kind: 'aux'` 的处理方式一致）。
- 运行开销页签的展示落地后，搜索分类的 token 与成本显示为零且语义为「未计量」而非「测得为零」。
- 会话用量页签的展示另立决策记录，不在本决策内悄悄落地。

## Risks

- **会话用量页签的展示尚未决定**，是本决策最大的未决点。当前倾向是搜索不进会话维度（会话口径是模型请求的 token / 费用 / 缓存，混入工具调用会让会话加总对不上），但这意味着用户在会话页看不到自己这次会话搜了几次、搜了什么——而这恰恰是最需要就地可见的信息。是否在会话页加一行轻量摘要（例如「本会话检索 N 次」而不并入请求池）需要单独决策。
- **token 与成本恒为零 / 未知**：当前后端下每次搜索真实消耗一个模型轮次，但用量被 provider 丢弃，插件拿不到。若展示层把零渲染成「未计量」而非「测得为零」，用户会看到「运行开销里有搜索，但费用是零」，需要文案明确说明这是观测盲区而非免费——否则容易误判搜索不花钱。
- **后端依赖**：`web/deepseek-search-llm-request` 只在 `deepseek-official` 后端出现；切到 `deepseek-search-api` 后该标记行不再产生，搜索调用的计数与来源统计仍然完整，但「搜索模型轮次」这条线索消失。若后续切后端，展示层需相应降级而不是显示为零。
- **历史回填的规模**：会话日志里 `tool/call` / `tool/result` 的条数与对话请求同量级（实测单会话 107 / 106 条），第一次回填会扫到大量存量事件，需确认同步耗时可接受。
- **配对健壮性**：`tool/call` 与 `tool/result` 之间是异步的，取消、被中止或结果未落盘时会留下没有配对的 call；行结构需容忍半行（只有 call 没有 result）而不是丢弃事实。
- **上游变更**：`dsh-web-search-deepseek` 的 `recordRequest()` 追加的事件名与 `body` 形状是私有约定，宿主升级可能改变；采集需对该事件做容错读取，形状不认识时降级为「有一次搜索模型轮次」而不报错。
