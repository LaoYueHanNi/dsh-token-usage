# DR: 启动同步改为按 session seq 增量补齐

Status: implemented

## Problem

`autoSyncIfNeeded` 历史上只在 `state.json`（`{initializedAt}`）缺失时跑一次"首次回填"，之后任何启动都直接 `return null`。这导致 dsh 的 `session/event` cordis 事件总线与插件 `start()` 之间的窗口里产生的 `assistant/message` 事件无法被任何路径补齐——cordis 不重放事件，listener 注册前的请求只存在于持久化的 session 日志里，但首次启动写过一次 marker 之后"首次回填"就再也不跑了。"未走 `remove` 的重装 / update / dsh 重启"全部落入这个窗口。

实地复现：用户在 2026-08-21 19:51 重装插件，state.json 被首次写入，JSOL 文件里 19:51 之后 45 分钟的活动 session 一行都没多；本机数据 `usage-2026-08-21.jsonl` 仅含 8/13 - 8/18 的旧历史。

修复方向定为：每次启动都同步，靠 `usage-log` 已有的 `seen` Set 做去重；进一步为每个 session 维护 `lastSyncedSeq` 水位线，让后续启动只读 `readFrom(id, lastSyncedSeq + 1)` 的尾段。

## Decision

`src/sync-state.ts` 把 `state.json` 的 schema 从 v1（`{initializedAt}`）升级到 v2（`{version:2, sessions:{<sessionId>:{lastSyncedSeq}}, syncedAt?}`），对老 marker 一律识别为"空水位线"——首次同步仍然是一次全量，之后只走尾段。`src/sync.ts` 的 `autoSyncIfNeeded` 每次启动都跑：对 `persistence.list()` 的每个 session 调用 `readFrom(id, lastSynced + 1)`，处理尾段事件并把 `max(event.seq)` 写回 `progress.sessions[id]`；无 session 仍写 v2 文件但返回 `null` 让调用方不打印空日志。`src/usage-log.ts` 的 `appendOnce` 把 day 文件名由 `now()` 改为 `record.time`——首次同步把过去的事件写进各自当天的 day 文件，而不是全部堆在"今天"的文件里污染日滚存。

live hook 的 `session/event` 监听保持原样（仍是注册后即开始工作）。"每次同步 + dedupe"的设计不依赖 state.json 的开关语义，所以删除了 `UsageLog` 构造函数的 `now` test seam（已无调用方）；session persist 接口契约新增 `readFrom(id, fromSeq)`，integration 测试的 `persistenceService` mock 同步补上。

## Alternatives considered

- **保持"首次同步"语义不变** —— 彻底不修。每次启动都 "return null"。对不重装的用户无影响，但任何 plugin reload / dsh 重启的窗口都会丢事件。拒绝，因为这就是 bug 本体。
- **每次启动都跑 `syncHistory`（全量 inspect）但不维护水位线** —— 也能修复 bug，但每次启动 inspect 每个 session 整段 events，后端是 JSONL 时成本和首次同步等价。"重装窗口修好但每次启动变慢"，不如水位线方案。
- **基于"数据目录最近修改时间"或"session list 的 latest 事件时间戳 vs marker 时间戳"的启发式检测** —— 试图避免维护水位线，但仍需要 inspect session 才能拿到时间戳，比水位线方案还复杂。拒绝，没省任何事。
- **不修 `appendOnce` 的 day 文件命名** —— 老历史被首次同步堆进"今天"的文件，日滚存和数据完整性都被污染。代价小、收益明确，顺手修。

## Consequences

- 代价：每次启动 enumerate 所有 session header 并对每个 session 调 `readFrom(id, lastSynced + 1)`。SQLite 后端是按 seq 寻道读尾段，开销最小；JSONL 后端顺序后端仍要扫到 fromSeq（顺序后端的 `readFrom` 契约如此），但水位线是单调递增的，所以一次启动的 IO 量随启动次数累加不会增长。`state.json` 写入频率提高（每次启动），仍是 temp+rename 原子写，崩溃安全。
- 换来：plugin reload / dsh 重启 / 不走 `remove` 的重装所丢失的窗口事件被自动补齐；新增 session 也被同步接住；老 `state.json`（v1 格式）首次启动后自动迁移到 v2，老用户的体验平滑；首次同步不再把过去事件错塞进"今天"文件，日滚存和按天聚合保持正确。