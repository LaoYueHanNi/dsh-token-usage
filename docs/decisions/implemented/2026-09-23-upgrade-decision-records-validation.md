# DR: 决策记录体系升级至新版校验与分态模板规范

Status: implemented

## Problem

旧版决策记录校验脚本（`docs/decisions/check.mjs`）与规约仅覆盖了基本的 Status 匹配与简单骨架段落存在性检查，存在若干盲区：
1. 未对文件名格式进行命名约束，无法防止命名偏离 `yyyy-mm-dd-slug.md`；
2. 未对文件头部前两行进行标准化校验（首行必须严格为 `# DR: <标题>`，次行必须为空行）；
3. 缺少反规划残留检查，已落地的 `implemented` 或归档 `archived` 记录中易残留提案/计划阶段的规划期草稿段落（如 Proposal、Plan、Acceptance criteria 等）；
4. 模板仅有一个通用的 `_template.md`，缺少针对 `proposed` 提案态的专用骨架；
5. Markdown 相对链接解析未对带 title 描述的链接语法（如带标题属性的相对链接）进行清洗，存在解析死链误判隐患。

## Decision

按照最新 decision-records 规范全面升级项目决策基础设施：
1. **升级零依赖校验脚本 `check.mjs`**：
   - 增加 `SLUG_RE` 正则校验文件名必须为 `yyyy-mm-dd-slug.md`；
   - 增加头部前两行严格校验（首行 `# DR: ` 前缀，第 2 行必须为空行）；
   - 增加 `FORBIDDEN_SECTIONS` 反规划残留门禁：`implemented` 与 `archived` 目录下的记录严禁包含规划性段落标题（包括 Proposal、Plan、Migration plan、Acceptance criteria、Risks）；
   - 完善 Markdown 相对链接死链检查：清洗链接 title 与 hash 锚点，确保相对路径解析严谨；
   - 过滤模板文件（`_template*`）不计入记录校验。
2. **升级规范说明 `README.md`**：
   - 明确定界“推翻与取代”的两种处理路径（完全取代物理删除旧记录并修链；部分取代在旧决策顶部标注 NOTE 警示块）；
   - 细化“归档与修剪”三准则（删除无长久价值的小 UI/重命名记录、冻结归档重大历史里程碑、坚决保留核心基石规则）；
   - 同步自查命令与新增校验项说明。
3. **提供分态模板**：
   - 将原单模板拆分并对齐为 `_template.implemented.md` 与 `_template.proposed.md`，使新提案与落地记录各得其所。

## Alternatives considered

- **引入外部现成 ADR npm 工具（如 adr-tools 或 markdownlint 插件）**：增加了项目依赖与构建复杂性，且跨平台（Windows / Linux）环境兼容成本高。输了：原生的单文件零依赖 Node.js 脚本执行速度极快（<10ms），跨平台一致，且能针对四态生命周期做精准业务语义校验。
- **保留单模板 `_template.md`**：让使用者自行增删提案段落。输了：容易造成段落漏填或格式污染（例如落地记录遗留 Proposal 段落），分态模板引导意图更清晰。

## Consequences

- **所得**：项目决策库获得更强的自动化防腐能力，杜绝反规划残留与格式漂移；全量 40 篇决策记录（含新增升级记录）100% 校验合规；模板结构清晰分明。
- **代价**：新增与修改决策记录时校验更加严苛，若未遵守规范 check.mjs 会立即报错阻断。