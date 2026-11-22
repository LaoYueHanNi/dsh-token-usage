# DR: 插件详情页补双语用户向正文

Status: implemented

## Problem

插件页此前只有 `locale/zh.json` 一句中文描述（"记录每次请求的 token 用量、费用，按模型、会话统计"），`locale/en.json` 的 `meta` 为空——英文界面落到 `package.json` 的 `description` 兜底；详情页没有自己的正文，宿主只能回退渲染整份 README。

README 有 137 行，前两屏是安装命令、升级注意、功能清单与定价规则，面向维护者（构建、`link:` 安装、临时挂载），用户在插件详情页第一屏看不到「入口在哪、我能怎么用」。一句话 description 也装不下侧栏大屏、设置页签、会话页签、配额按钮、定价表与配置卡这些入口。

宿主 0.2.2 起，插件页在标题与描述下方渲染 `meta.detail` 声明的 Markdown 文档；任一语言在 fallback 链上声明了 detail，就不会回退 README。声明了却缺失、路径非法或超过 `pluginManager.detailMaxBytes`（默认 1 MiB）时该区块显示错误与**重试**，也不同回退——所以 doc 必须随包发布。

## Decision

在[包级 locale 词典](./2026-09-28-package-locale-meta.md)之上，`locale/en.json` 与 `locale/zh.json` 各自声明完整的 `meta.title`、`meta.description` 与 `meta.detail`：

1. `meta.description` 一句话说明能力并点出 UI 入口：侧栏「Token 用量」大屏、**设置 → Token 用量**、对话面板的「用量」页签；英文取 `Token Usage` 与 `Settings → Token Usage`。
2. `meta.detail` 指向 `docs/DETAIL.md`（英文）与 `docs/DETAIL.zh.md`（中文）。正文是用户向说明，开头一句总述，按「你能做什么 / 一些边界」（英文 `What you can do` / `Some limits`）组织：总量与筛选、五个统计维度、单会话用量与实时请求、费用与定价关联、供应商配额、配置卡（数据目录 / 定价区域 / 常驻侧边栏），以及未定价计 ¥0、辅助调用无法回补、缺失供应商行、数据目录保存时机、不支持的供应商这些边界。事实全部从 README 浓缩，不新增权威来源。
3. `package.json` 的 `files` 逐文件收录两份 DETAIL 文档；发布产物不连带 `docs/` 其余内容（截图、测试记录、决策记录都不进包）。文档分工固定为：DETAIL = 插件页正文（用户向），README = 安装与技术说明，`docs/decisions/` = 设计取舍。
4. `tests/locale-meta.spec.ts` 的旧契约随之改写：en.json 不再断言为空、英文界面不再断言逐字回落 `package.json`，改为断言两份 locale 的完整 meta 与 detail 路径形状、文档存在性与 1 MiB 上限、`files` 逐文件收录。

## Alternatives considered

- **把 README 整篇当详情正文** —— 输在长度与视角：137 行安装/开发/定价规则文档，用户第一屏撞上 `dsh plugin add` 与构建命令，入口仍要自己找。
- **只补两句 description、不设 detail** —— 输在展示空间：侧栏、设置页签、会话页签、配额按钮、定价表、配置卡六个入口与五条边界装不下，用户仍无正文可读。
- **按官方模板把详情文档做成单张功能图** —— 官方模板约定 detail 文档恰好一行图；本插件截图是整页 UI，640×300 画布放不下六类入口，无字示意图又表达不了「未定价计 ¥0」「辅助调用不可回补」这类语义。宿主渲染任意 Markdown，文字正文可搜索、可随界面语言切换，故保留文字版（与 dsh-worktree、dsh-session-tools 的实践一致）。
- **英文 locale 省略 detail、回退英文 README** —— 等于不给英文用户正文；既然补了英文 description，正文一并翻译，成本可控。英文 locale 若只留中文 detail 也不可行：宿主按语言链取声明，英文用户会读到中文文档。
- **detail 指向外部 URL 或仓库链接** —— 宿主只接受包内相对路径（`/` 分隔、以 `.md`/`.markdown` 结尾），外链不解析，且相对链接在详情页按纯文本渲染。

## Consequences

- 代价：DETAIL 与 README 两处需随功能同步维护（README 为权威，DETAIL 是浓缩投影）；新英文正文多一个翻译面；发布产物多两个文件；`tests/locale-meta.spec.ts` 里「en.json 留空 + 英文逐字回落」的旧断言必须改，否则契约测试与已落地事实互相矛盾。
- 换来：插件页中英文都有标题、一句话描述与第一屏可读的用法说明；六个入口首次写进用户视野；README 保持技术文档定位，不再被整篇塞进详情页；detail 的失败模式（缺失、超限即报错并重试，绝不回退 README）被测试钉住。
