# DR: 声明插件市场截图清单（screenshots.json）

Status: implemented

## Problem

dsh-market 详情页按仓库根 `screenshots.json` 展示 AppStore 式截图（awesome-dsh-plugin contributing.md 的约定）。本仓库此前未声明，市场回退为从 README 自动抽取图片：顺序与选取不可控——README 首图是 badge，且中英两份 README 引用的截图不同（英文版用英文界面图），抽取结果不可预期。

## Decision

仓库根新增 `screenshots.json`（数组形式，路径相对仓库根），列出 5 张 `docs/images/` 下的**中文界面**截图，顺序按卖点主次：统计页（`token-usage_zh`）→ 会话用量页签（`usage-tab_zh`）→ 模型定价弹窗（`model-price_zh`）→ 智谱 GLM 配额（`zhipu-plan-usage_zh`）→ OpenCode Go 配额（`opencode-go-plan-usage_zh`）。之后更新截图只需推送本仓库，市场下一次 nightly 构建自动生效，无需向 awesome-dsh-plugin 提 PR。

## Alternatives considered

- **英文界面截图**（README 英文版现行用图）—— 对国际展示更通用，但 dsh-market 的界面与主要用户群是中文，中文截图传达更直接；若后续面向国际再整体切换。
- **不声明，靠 README 自动抽取** —— 展示顺序与选取不可控，中英 README 用图不一致使抽取结果更不可预期。
- **图片挪进独立的 assets/ 目录** —— 图片已在 `docs/images/` 且被两份 README 引用，挪动徒增链接维护，直接复用现有路径。

## Consequences

- 代价：`screenshots.json` 与 `docs/images/` 的文件名耦合，截图改名或删除须同步维护该清单；市场展示统一为中文界面，非中文用户看到的截图是中文。
- 换来：市场详情页的截图选取与顺序完全可控（首图即核心卖点的统计页），不再依赖 README 抽取的回退行为。
