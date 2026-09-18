# DR: 修复开发分支瞬态遗留的非法 origin 字段会话（数据侧无损离线清洗提案）

Status: proposed

## Problem

在 2026-08-19 ~ 2026-08-21 期间，宿主 DeepSeek Harness 主干曾短暂合入包含 `"origin"` 字段的提交（`35778ec2ff`），但在 8 月 21 日正式发版前被完整 Revert（`7ce85283b5`）。在此期间本地运行开发分支创建的一批历史会话（约 18~25 个，分布在各工作区下），其第一帧事件 `permission/preset` 均写入了非标的 `{"preset":"workspace-write","origin":"default"}`。

官方会话迁移器 `@deepseek-ai/dsh-session-format-v0-to-v1` 采取“已发布格式字节不可变”与“严格白名单防御”原则，对未发布字段坚决拒绝加载（`refuses this format v0 Session: permission/preset 0 data has unexpected member "origin"`），且官方明确不会为已被回滚的开发期字段提供向下兼容。
其结果是：
1. Harness Web 界面无法打开这批历史会话；
2. `dsh-token-usage` 在执行全量历史扫描时，因底层会话拒绝读取而产生“无法读取 25 个 session 已跳过”，导致这部分会话的用量数据无法参与全局统计。

## Proposal

提供专用的离线数据无损清洗脚本（如 `scripts/repair-v0-origin-sessions.mjs`），在数据文件层面对受影响的 `session.jsonl.zstd` 执行就地规范化：
1. **自动前置备份**：修改前对目标 `.zstd` 文件创建同目录 `.bak` 备份，保证源数据不丢失；
2. **逐帧解压与精准过滤**：利用 Node.js 原生 `zstdDecompress` 解压各帧，定位并仅删除 `permission/preset` 事件对象中的 `origin` 键（还原为合法的 `{"preset":"workspace-write"}`），绝不触碰任何对话内容、工具调用与 Token 计数；
3. **压缩重写与校验**：重新进行 Zstandard 压缩写回，并使用 Harness 的 `sessionFormatCatalog.createRestore` 进行即时还原校验，确保文件 100% 符合官方 `v0` 规范；
4. **触发重新对账**：清洗后由用户或在设置面板中点击【重新扫描】，验证未读数归零，且用量平滑回填进大盘。

## Alternatives considered

- **修改本地 Harness 源码放宽校验白名单** —— 在 `packages/session/session-format-v0-to-v1/src/dispositions.ts` 的 `permission/preset` 可选字段中加上 `'origin'`。输在：这是本地侵入式修改，一旦拉取上游主干或重新安装发版依赖就会被冲掉或产生冲突，且无法解决其他人拉取该历史会话时的读取问题；数据侧修复是一次性的根本解决。
- **在插件的 `src/sync.ts` 中直接 bypass/手动解压解析绕过官方 persistence** —— 输在：打破了插件不直接碰底层文件代次的架构契约（见 [DR: 兼容宿主 dsh 0.1.5-rc.1](../implemented/2026-09-10-migrate-to-dsh-0-1-5-rc-1.md)），且即使插件绕过，Harness 自身的界面依然打不开这些会话。
- **永久忽略这批会话不作处理** —— 输在：虽不影响日常使用，但导致历史 Token 账本缺失 25 个会话的统计，且会话在 Web 列表报错打不开，影响体验。

## Acceptance criteria

1. 扫描 `~/.dsh/sessions/` 识别出所有携带 `permission/preset.data.origin` 的会话；
2. 清洗脚本执行后，通过官方 `sessionFormatCatalog` 测试上述会话无一报错，能够顺利走完 `v0 -> v1 -> v2 -> v3` 迁移；
3. `dsh-token-usage` 重新全量扫描后，“无法读取 session”数量从 25 降为 0；
4. 所有原文件均保留 `.bak` 备份文件可供回滚。

## Risks

- **并发写风险**：若清洗脚本执行时 Harness 正在对其中某个会话进行写入，可能产生文件冲突。防范：脚本要求在 Harness 离线或无进行中对话时执行，并加排他性锁/检查；
- **主动放弃**：不针对非 `origin` 造成的其他不可预知损坏会话提供自动修复，仅限定修补该已知历史缺陷。
