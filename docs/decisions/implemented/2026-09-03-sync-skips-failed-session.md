# DR: 历史同步按会话粒度跳过无法解析的存储日志

Status: implemented

## Problem

`syncHistory` 对每个会话调 `persistence.inspect`。任何一个会话的存储日志加载或校验失败（宿主 `Session.fromRestore` 对事件做 schema 校验），整个扫描以 `failed` 收场——排在坏会话之后的**所有**历史都进不了账本，且每次全量同步都撞在同一块石头上。实发案例：0.1.2-alpha.5 开发版写入的 `assistant/message` 带 `sourceEventSeqs: [[16,190]]`（区间对），0.1.1-rc.2 校验器要求扁平整数列表，该会话 restore 即抛错，手动扫描显示「扫描失败：stored session … failed validation」。坏因不可枚举：宿主格式演进、torn write、未来任何校验收紧都会再造一个。

## Decision

**会话粒度跳过，计数并上报；取消永远透传。**（`src/sync.ts`）

- `inspect` 抛错且不是取消（`signal.aborted` 或 `error.name === 'AbortError'` 一律视为取消重抛——包括宿主读路径在调用方 signal 未标中止时抛出的 AbortError）→ `failedSessions += 1`，`processed += 1`（进度条总能走到 `total`），`deps.onSessionFailure?.(id, error)` 上报，`continue` 到下一个会话。
- `SyncResult` / `SyncProgressTick` / `FullSyncView` 的 `running` 与 `done` 都加 `failedSessions: number`；手动扫描与首次启动 `autoSync` 共用同一条 walk，两处宿主日志都带会话 id 与错误消息（`session <id> unreadable, skipped: …`），结果日志带计数。
- 卡片进度与结果文案在 `failedSessions > 0` 时追加「，无法读取 {count} 个 session 已跳过」；为 0 时不显示（「出现了才看见」，与失败胶囊同一信号哲学）。
- 客户端 `fetchFullSync` 对旧宿主响应里缺失的 `failedSessions` 读作 0（该字段非校验必选项，与 processed/total/added/skipped 的防御口径一致）。
- 取消仍是整批致命：中止的扫描不得显示 `done`。

## Alternatives considered

- **整批 failed（现状）** —— 一条坏会话让其余全部历史丢失，且每轮扫描重复失败。否决：实测 98 个会话里 5 个 alpha 格式，全量同步永久不可用。
- **删除 / 迁移 / 原地修复坏会话文件** —— 插件改写宿主会话数据越权；坏因在宿主校验器，修好一个修不好下一个。否决。
- **按错误类型白名单只跳过 validation 类** —— 任何 inspect 失败对该会话的效果一样（事件读不到），失败类型不可枚举，白名单只会让新类型重新炸整批。否决。
- **只计数进结果、不透出到进度条与卡片** —— 用户看不到数据缺了一块，统计偏低无从解释。否决。
- **失败会话不推进 `processed`** —— 进度条永远到不了 `total`，视觉卡死。否决。
- **取消也跳过计数** —— 吞掉调用方意图，中止的扫描会显示 `done`。否决：AbortError 与 signal 中止都重抛。

## Consequences

- **所得**：坏会话不再阻塞；账本覆盖所有可读会话；用户在进度与结果里看到缺口大小，宿主日志知道是哪个会话、为什么。
- **代价**：坏会话的请求行持续缺席（直到宿主能读它）；`done` 状态下缺口只以附注形式存在，扫一眼不读附注会以为完整。
- **代价**：`failedSessions` 进入三处形状（Result / Tick / View）与两组文案；旧宿主 + 新卡片的组合读 0（新字段宽容），新宿主 + 旧卡片丢弃该字段（无渲染，无损）。
- **边界**：live 实时监听不经过 `inspect`，不受影响；`autoSync` 写 initialized marker 的行为不变——被跳过的会话不会因 marker 而失去补录机会，手动全量扫描或下一版本宿主修复后可再补。
