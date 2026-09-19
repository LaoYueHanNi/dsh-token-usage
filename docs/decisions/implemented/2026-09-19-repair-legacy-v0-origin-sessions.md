# DR: 修复开发分支瞬态遗留的非法 origin 字段会话（数据侧无损离线清洗）

Status: implemented

## Problem

在 2026-08-19 ~ 2026-08-21 期间，宿主 DeepSeek Harness 主干曾短暂合入包含 `"origin"` 字段的提交（`35778ec2ff`），但在 8 月 21 日正式发版前被完整 Revert（`7ce85283b5`）。在此期间本地运行开发分支创建的历史会话，其 `permission/preset` 事件写入了非标的 `{"preset":"workspace-write","origin":"default"}`。

官方会话迁移器 `@deepseek-ai/dsh-session-format-v0-to-v1` 采取"已发布格式字节不可变"与"严格白名单防御"原则，对未发布字段坚决拒绝加载（`refuses this format v0 Session: permission/preset 0 data has unexpected member "origin"`），且官方明确不会为已被回滚的开发期字段提供向下兼容。其结果是：

1. Harness Web 界面无法打开这批历史会话；
2. `dsh-token-usage` 在执行全量历史扫描时，因底层会话拒绝读取而跳过它们（报告"无法读取 session"），这部分会话的用量数据无法参与全局统计。

## Decision

提供离线无损清洗脚本 [scripts/repair-v0-origin-sessions.mjs](../../../scripts/repair-v0-origin-sessions.mjs)（Node ≥22 的原生 zstd，零第三方依赖，不进插件构建），对受影响的 `session.jsonl.zstd` 执行就地规范化：

- **三种模式**：默认 `scan` 只读分类全库；`--repair` 执行"备份→清洗→回读校验"；`--verify` 对全部活动代次跑官方校验。会话根目录可用 `--root` 覆盖。
- **校验器即官方**：导入宿主检出的构建产物 `sessionFormatCatalog.createRestore`（`--harness-root` 或 `DSH_HARNESS_ROOT` 定位），每次校验走完整 `v0→v1→v2→v3` 迁移加当前代次验证，脚本不自造任何格式知识。
- **清洗范围最小**：只删除 `permission/preset` data 中的 `origin` 键；未受影响记录逐字节保留、zstd 帧布局保持；超范围改动（preset 非字符串、data 含其他未知键）一律拒绝。
- **参照产物对账**：写盘前先在内存中对"中和 origin 后"的记录跑一次官方迁移作为参照，写盘回读后要求两次迁移产物逐事件一致——写盘前即可发现修复必然失败的文件。
- **安全阀**：任何写入前先建同目录 `.bak` 备份（SHA-256 与原件一致）；10 分钟内被改写的文件拒修以防并发写，`--force` 显式覆盖。官方迁移链会原地变换传入的行对象（打包 chunk 行在 v1→v2 内嵌），因此每次校验对输入做 `structuredClone`，分类与校验互不污染。

实际执行结果（2026-09-19，全库 141 个会话目录）：18 个会话携带 origin 缺陷，16 个清洗成功并通过官方 `v0→v3` 校验（全库可读 130/141），每个均留 `.bak` 可回滚；2 个（`session-2f76ea07`、`session-3d71e2a5`）在预检阶段暴露出 origin 之外的第二个缺陷（`assistant/message N message content[0] name must be a non-empty string`），按既定范围未予写盘。修复后插件全量重扫，"无法读取 session"从 25 降为 9，残差构成：7 个 subagent descriptor v2、2 个即上述 origin 叠加缺陷会话——仅因 origin 而不可读的会话已归零。（脚本的 `--verify` 采用比宿主更严的 `validation: 'current'`，另报 2 个未闭合 tool call 的 v0 会话；宿主实际读取路径为 `recoverable + transformed`，可正常加载它们，不计入不可读。）

## Alternatives considered

- **修改本地 Harness 源码放宽校验白名单** —— 在 `packages/session/session-format-v0-to-v1/src/dispositions.ts` 的 `permission/preset` 可选字段中加上 `'origin'`。输在：这是本地侵入式修改，一旦拉取上游主干或重新安装发版依赖就会被冲掉或产生冲突，且无法解决其他人拉取该历史会话时的读取问题；数据侧修复是一次性的根本解决。
- **在插件的 `src/sync.ts` 中直接 bypass/手动解压解析绕过官方 persistence** —— 输在：打破了插件不直接碰底层文件代次的架构契约（见 [DR: 兼容宿主 dsh 0.1.5-rc.1](./2026-09-10-migrate-to-dsh-0-1-5-rc-1.md)），且即使插件绕过，Harness 自身的界面依然打不开这些会话。
- **永久忽略这批会话不作处理** —— 输在：虽不影响日常使用，但导致历史 Token 账本持续缺失这部分统计，且会话在 Web 列表报错打不开，影响体验。

## Consequences

- 所得：16 个会话经官方校验器判定完全恢复可读，Web 可打开、用量可在插件重扫后回填；全程零格式知识内联（一切判定来自宿主构建产物）；`.bak` 齐全可回滚；预检机制使"修一半"在物理上不可能。
- 代价：脚本依赖本机的 harness 检出路径（`D:\Code\deepseek-harness` 或环境变量），不随插件 npm 包分发；9 个会话仍不可读（7 个 descriptor v2、2 个 origin 叠加空 tool-call name），是否另行清洗需要新决策；会话目录中暂时留存 16 份 `.bak`，确认无误后需手动清理。
