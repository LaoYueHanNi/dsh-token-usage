# DR: 对账采用可重建来源白名单，并在改写日文件前自动滚动备份

Status: implemented

## Problem

插件已支持将带真实 `sessionId` 的辅助模型请求（例如 `session-title`，见 [将可证明归属的辅助请求纳入会话用量](../implemented/2026-10-25-session-attributed-auxiliary-requests.md)）写入日文件，并将在后续版本归属更多旁路请求。然而旁路请求经由 `llm/stream` 旁路采集，**不会写入宿主会话持久化日志**，因此 [对账扫描](../implemented/2026-09-10-scan-reconciles-stale-ids.md) 中 `syncHistory()` 的 `keep`（`reproduced`）集合永远不含 `aux:*` 行。原 `reconcileDayFiles()` 仅按 `eligible && !keep && readableSessions.has(owner)` 判断删除，一旦辅助请求带上真实 `sessionId`，点击「全量扫描同步」便会把所有归属到可读会话的历史辅助开销永久清除（已实测一次扫描删掉 161 条辅助记录）。

此外，两个同源隐患加剧了历史日文件的损坏风险：

1. `usage-record.ts` 的 `coerceRecord()` 会把未知的未来 `kind` 归一为省略（视为普通请求），若对账仅用黑名单排除 `kind === 'aux'`，降级或混合版本时仍会误删未来的非会话日志派生类型并洗掉其扩展字段；
2. `reconcile`、`refile`、`backfillTiming`、`completeFields` 均直接原子替换 `usage-*.jsonl`，没有事前快照兜底，误改或误删后无处找回原字节。

## Decision

1. **保留一键全量扫描的 `reconcile` 清理能力**：无需新增确认弹窗或开关，保留通过一次全量扫描同步自动清理旧坐标与 Fork 重复行的能力。
2. **基于原始 JSON `kind` 实行可重建来源白名单**：
   - `usage-record.ts` 导出 `isReconcilableKind(rawKind)`，仅 `undefined`、`'request'`、`'compaction'`、`'failure'` 四类由宿主会话日志派生的行可进入对账删除或归属修正候选；
   - `readDayLines()` 直接读取原始 JSON 对象的 `kind`（`rawKind`），而非经过 `coerceRecord()` 归一后的 `record.kind`；所有 `kind: 'aux'`（无论是否带 `sessionId`）以及任何未知未来 `kind` 一律无条件豁免；
   - `writeDayLines()` 对本轮未改动的保留行直接输出原始行文本 `raw`，保持未来未知 `kind`、扩展字段与畸形行字节级无损。
3. **改写前自动滚动备份（`src/backup.ts`）**：
   - 上述四处会改写既有 `usage-*.jsonl` 的批量维护路径（`reconcile`、`refile`、`backfill-timing`、`complete-fields`）先整轮计算实际发生改动的既有文件；0 改动不建备份目录；
   - 有改动时先调用 `backupDayFiles(dir, files, reason)` 将本次实际会被改写的原文件拷贝到 `<dataDir>/.backups/<YYYYMMDD-HHmmss-SSS-NN>-<reason>/`；拷贝失败则清理半成品并中止本次改写；
   - 拷贝完成后自动滚动清理旧快照，仅保留按名称升序最新的 5 次插件快照（不触碰 `.backups/` 下用户放置的无关文件）。
4. **目录迁移兼容 `.backups/`（`src/migrate.ts`）**：`copyData()` 与 `cleanSource()` 将 `.backups/<snapshot>/usage-*.jsonl` 纳入两阶段安全拷贝与大小校验后清理，确保切换数据目录时随迁历史备份且不因 `.backups/` 残留阻塞源目录清空。

## Alternatives considered

- **为「全量扫描同步」增加确认弹窗或默认关闭 `reconcile` 开关** —— 否决：增加用户操作负担且破坏自动清理旧格式坐标与重复行的体验，也不能消除误删旁路数据的根本语义缺陷。
- **在解析后的 `UsageRecord` 上做 `record.kind !== 'aux'` 黑名单判断** —— 否决：`coerceRecord()` 会把未知未来 `kind` 归一为省略，黑名单无法保护新插件版本写入的非日志派生行，且重新序列化会破坏未知扩展字段。
- **目录迁移时把 `.backups/` 视同 `rollup.json` 丢弃** —— 否决：`rollup.json` 是可无损重建的派生缓存，而 `.backups/` 保存的是刚被改写或删行前的原字节，迁移丢失会击穿安全网。
- **每次批改写全量备份所有历史日文件** —— 否决：日文件逐月累积后空间放大明显，且绝大多数历史文件并未参与本轮改写；仅备份实际改动文件即可实现精确恢复。

## Consequences

- 代价：`.backups/` 最多留存 5 次受改写日文件副本的磁盘占用；目录迁移多一次对 `.backups/` 快照子目录的扫描与校验；历史上已被旧版对账误删的 `aux` 记录仍无法从会话日志回填。
- 换来：带 `sessionId` 的辅助开销（`session-title`、后续 `auto-review` / `timeline-report`）与未来未知旁路类型在全量扫描下永不误删且保留原始字段；四条批改写链路全部具备自动滚动备份与失败中止保障，迁移行为保持原子一致。
