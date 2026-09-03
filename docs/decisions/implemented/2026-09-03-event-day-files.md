# DR: 用量行按事件本地日写入 day 文件，不再落在同步当天

Status: implemented

部分推翻 [`2026-09-02-compaction-billing`](./2026-09-02-compaction-billing.md) 第 4 节「`appendOnce` 按当前时钟分桶、回填行落在回填当天」；统计仍按 `record.time` 聚日，磁盘布局改为与之一致。

## Problem

`UsageLog.appendOnce` 用 `this.now()` 选文件。实时请求碰巧等于当天，全量扫描 / 首次回填却把 8 月的事件写进 `usage-2026-09-03.jsonl`。用户对照数据目录能直接看到：历史行全堆在同步当天。

后果不只是「文件看起来不对」：

- 当天文件无限膨胀，永远是 hot、每次 stats 全量重读。
- 过了午夜该文件被 rollup 以「9 月 3 日」吸收，历史行的物理位置与事件日永久错位。
- 若以后按事件日补写 8 月文件，而 rollup `upto` 已越过 8 月，新行会被 `day <= upto` 跳过（除非丢掉 rollup）。

## Decision

`appendOnce` 用 `dayFileNameOf(record.time)`（本地 Y-M-D，与 `stats.dayKey` / `record.time` 同一套）。实时与回填同一规则。`UsageLog` 不再接收 `now` 测试缝——测分桶改设 `record.time`。

已经错位的行：`refileByEventDay()` 按源文件逐个把「事件日 ≠ 文件名」的行合并进目标日（按 `requestId` 去重后再写），源文件留下仍属于当天的行；畸形行留在源文件不丢。幂等：目标已有该 id 则只从源删除。走同一条 append 队列，不和实时写入交错。

调用点：启动时先 refile 再 `autoSyncIfNeeded`；手动 full-sync 结束后再 refile；目录迁移 `scan` 之后 refile。`moved > 0` 或 `added > 0` 都 `invalidateDerivedState`（清 record-cache、删 rollup）——frozen 文件现在会被回填写入，rollup 不再能假设它们只读。

## Alternatives considered

- **只改新写入、不搬已错位行** —— 用户手里的 `usage-2026-09-03.jsonl` 会永远堆着历史。否决。
- **按文件名聚日，放弃 `record.time`** —— 趋势图 / 1d 筛选会跟着错误文件名走，统计更假。否决。
- **scan 时顺手搬** —— `scan` 只建去重集，且 full-sync 在 scan 之后才 append；搬文件与 append 交错会双计。否决：独立队列任务。
- **整目录写到 staging 再换** —— 与 pricing.json 等非 day 文件抢目录，Windows 换名更脆。否决：按源文件幂等合并。

## Consequences

- **所得**：新同步的行在请求对应天的 JSONL 里；旧错位行启动或手动扫描后归位。
- **代价**：frozen day 文件可被回填改写，rollup 在 sync/refile 后必须丢弃重建（原来只为跨午夜窗口准备的失效现在是主路径）。
- **代价**：一次 refile 会重写受影响的 day 文件（量级与现有 scan 同阶，只在启动 / 手动扫描）。
- **边界**：畸形 JSONL 行不搬、留在源文件。
