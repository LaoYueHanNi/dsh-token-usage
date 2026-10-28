# DR: 保存供应商路由键并回填旧用量行

Status: implemented

## Problem

用量行上的供应商今天只是可选的路由元数据，而且只覆盖一部分调用。统计维度（按供应商汇总、筛选）还没做，但如果不先把每条调用的路由键落稳，以后加维度时历史对不上。

现状：

- `UsageRecord.provider` 只从 `assistant/message` 的 `source.provider` 写入。压缩事件的 `data.provider`、`llm/retry` 的 `data.provider`、辅助调用的 `options.provider` 都在手边，投影时丢掉了。`turn/end` 事件本身没有路由键。
- 请求池的 `decorateRecord` 偶尔能从内存中的尝试补上压缩行和失败行。那是进程内关联，有存活时间，还依赖监听器顺序；历史重扫不走它。见 [DR: 会话用量页的实时请求池与请求级缓存三档提示](2026-10-25-session-request-pool.md)。
- 该决策当时写明「旧日志不回填不重写」。因此字段加入之前的普通请求行也没有路由键。
- `UsageLog.record()` 按 `requestId` 去重，已有行直接跳过。再跑一遍 `syncHistory` 不会改旧行。全量同步末尾的 reconcile 还会按「这次行走有没有再现该 id」删行，不能拿来改字段。
- 计时是唯一的就地补字段先例（[DR: 记录请求耗时与首 token 延迟](2026-09-17-request-latency-tracking.md) 的 `backfillTiming`）。它不是可复用机制：函数写死 `latencyMs` / `firstTokenLatencyMs`，只认 `kind` 缺省的普通请求，提取逻辑在实时监听、`syncHistory` 和回填里各写一份，完成标记是 `state.json` 里单独的 `timingSyncedAt`。会话日志读失败只打警告，标记照样盖上，那些行再也没机会。下一个字段若再抄一份，会再长出一个一次性函数和又一个时间戳。

展示名是另一件事。会话事件只带路由键（`deepseek-official`、`zai-coding-cn`、用户自建网关名），不带展示名。展示名来自当前供应商目录 `listConfigurableProviders().displayName`，同一个 id 改名之后以新名为准。配额面板用的「别名 · 适配器标签」是配额展示规则，不是用量身份。

辅助调用不在会话日志里，历史无法回补。这是既有边界（[DR: 记录并单独展示辅助模型请求](2026-10-21-auxiliary-model-requests.md)），本决策接受，不试图补。

本决策只解决「把数据收集齐」。按供应商统计、筛选和 rollup 聚合键都不在范围内。

## Decision

用量行只保存路由键。实时投影与历史行走共用 `recordOfEvent`，不依赖请求观察器：

- 普通请求读 `source.provider`。
- 压缩写入 `event.data.provider`。
- `llm/retry` 写入这次失败尝试自己的 `event.data.provider`，不用会话上一次的路由。
- `turn/end` 没有路由键。与 `lastModel` 并列维护 `lastProvider`，只由 `request/context` 和 `assistant/message` 推进，再交给这次投影。`syncHistory` 用同一套行走。推不出来就留空。压缩和 `llm/retry` 不推进这个最后已知路由。
- 辅助调用把 `options.provider` 传入 `recordFromAuxRequest`。只覆盖升级之后的新调用。

空字符串省略，不写 `""`。`provider` 不进入 `requestId`、去重和计费身份。`decorateRecord` 仍只给请求池做内存兜底。

展示名不进 JSONL 行。数据目录的 `providers.json` 把路由 id 映射到最近一次读到的 `displayName`，随数据目录迁移（`OWNED_PATTERNS` 含该文件），原子写。启动时、以及 llm 服务挂上时，把目录里每个有展示名的条目 upsert 进去。每记下一条带路由键的行，再尝试刷新目录并 upsert 这一条；旁路回调里 llm 上下文已经停用、读取会抛错时，沿用上一次成功的快照，不让记账失败。同 id 新名覆盖旧名。目录里已经没有的 id 不删除。没有名字的 id 不写入空名，展示时退回 id（`providerLabel`）。不用配额组合名，也不从模型名前缀猜测。这份名册不能从会话日志重建。

缺字段补全是登记表 `FIELD_COMPLETERS`，供应商是第一项，id 为 `provider`。计时回填保持原样，不迁进来。宿主启动时若 `state.json` 的 `completedFields` 没有这一项，就在追加队列上自动跑，不比较插件版本，也不走手动全量扫描。只填空值。普通请求用 `message.id`，压缩用 `compaction:<session>:<seq>`，`llm/retry` 用 `failure:<session>:<seq>` 对上事件自己的路由；`turn/end` 的同一个 `failure:` id 用该 seq 之前最后一次请求路由。日文件只有改了才原子重写。不经过 reconcile。任一候选会话没读成，该项不写入 `completedFields`，下次启动再试；`markInitialized`、`markMetaSynced`、`markTimingSynced` 都保留这份名单。没有 `initializedAt` 时不发明标记。补全改写了行就丢掉派生统计状态，下次读统计时从日文件重算。不抬 `ROLLUP_AGGREGATE_FORMAT`。辅助行和没有会话 id 的行不是候选。

这部分取代 [DR: 会话用量页的实时请求池与请求级缓存三档提示](2026-10-25-session-request-pool.md) 里「`provider` 旧日志不回填不重写」。`interrupted` 与 `startedAt` 仍不回填。

## Alternatives considered

- **再跑一遍全量同步，靠 `requestId` 去重把供应商写进旧行。** 放弃：`UsageLog.record()` 见到已有 id 就返回，旧行不变。用 reconcile 重写字段还有删行风险。
- **照抄 `backfillTiming`，再写一个 `backfillProvider` 和一个 `providerSyncedAt`。** 放弃：计时回填已经证明这种写法不能接下一个字段。提取逻辑会再复制一份，读失败的会话也会再被一次盖章封死。
- **把计时回填也迁进新的补全登记表。** 放弃：计时已经落地并盖章，迁移动不了新数据，只增加重写日文件的风险。登记表从供应商这个字段开始，计时留作已落地的特例。
- **把展示名和路由键一起写在用量行上。** 放弃：会话事件没有展示名，写在行上的是写入当时的名字。id 改名后旧行继续显示旧名，除非重写全部日文件。与「以最新名为准」相反。
- **用配额跟踪器里的「当前供应商」，或用模型名前缀反推。** 放弃：跟踪器是会话级、后来者赢的内存状态，中途换路由会记错。模型名在自建网关和 Magpie 上不能唯一对应路由键。
- **把 `decorateRecord` 当成账本的供应商来源。** 放弃：只存在于进程内存，历史重扫看不见，而且监听器顺序会让补写丢失。
- **本决策一并做按供应商汇总。** 放弃：先把行上的 id 和名册上的最新展示名收齐。汇总、筛选和 rollup 聚合键另立决策，避免在字段还补不齐时改统计口径。
- **回补升级前的辅助调用。** 放弃：会话日志里没有这些调用。与既有辅助请求决策一致，空着可以接受。
- **让用户手动点「重新扫描」才补字段。** 放弃：那个入口走 `syncHistory`，旧行会被去重跳过，点了也补不上。没点的人则永远缺历史路由键。计时回填已经是升级后自动跑、用标记跳过后续启动。
- **用插件版本号判断要不要重建。** 放弃：版本由发布时决定，补全是否做过只跟这份数据目录有关。换目录、恢复旧数据目录时，版本号仍是新的，但标记不在，应该再补一次。

## Consequences

- 代价：第一次启动会按候选会话重读日志，并重写有空路由键的日文件，然后丢掉 rollup。`turn/end` 的路由是推断，推不出就留空，将来不能从总量里扣掉。升级前的辅助调用永远没有路由键，做维度时必须单列，不能当成某个供应商的零。`providers.json` 丢了只能用当前目录恢复仍在的路由。没有新请求时，改名要到下次启动的目录快照才更新；请求当时若读不到目录，用的是上一次快照。永久读不到的会话会让 `provider` 这一项一直不盖章，每次启动重试。
- 换来：新的普通请求、压缩、`llm/retry` 和辅助调用在投影时带上路由键；能从会话日志证明的旧行在启动补全里补上，已有非空值不被覆盖。读失败不封死其余会话。同一个 id 的展示名以最新快照为准，删掉的路由留着最后一次的名字。下一个可从会话事件证明的可选字段只需再登记一个补全项。统计页的维度、筛选和 rollup 版本号不变。
