# DR: README 范围收敛为背景/功能/安装配置，计费深度细节拆至 docs/pricing.md

Status: implemented

## Problem

README（双语各 ~190 行）约四成是技术细节与设计原理：计费规则链解析顺序、云端 feed JSON 格式、数据目录迁移的两阶段提交与 dir-guard 预检、失败请求双源采集、TTFT 投影来源、货币联动机制、prepare 脚本论证。背景 / 功能 / 安装使用被淹没，且大量内容与 `docs/decisions/` 重复——两处叙述同一事实，改一处漏一处（README 开发章节残留「lib 已入库」话术即是实例）。中文版另有配置表被硬拆成两个的排版破损。

## Decision

README 只承载：项目背景、功能介绍（只讲用户可见行为，每条 1-3 句，不讲实现来源）、模型定价概念 + `pricing.json` 手工格式、配置（数据目录 / 定价区域 / 配额开关）、安装更新移除、开发。双语对称结构；原 Install 的 `link:` 开发安装小节与 Development 合并去重；中文双表破损随重组消除。

深度内容拆至 [`docs/pricing.md`](../../pricing.md)（单中文，与 decisions 惯例一致，随 npm tarball 分发——`files` 已含，README 包内链接不断）：计费规则链、双文件合并语义、云端 feed 完整格式、`pricingUrl*` fork 维护者配置、货币展示联动机制；README 各留一句链接。

纯设计原理（迁移两阶段提交、双源采集、投影来源、prepare 论证）不再在 README 保留——`docs/decisions/` 是唯一权威，README 不复述。

## Alternatives considered

- **全部直接删、不建专题文档** —— `pricing.json` 完整格式、feed 格式、fork 镜像配置有真实的深度受众，埋进 19 条按主题散落的决策记录里无法被发现。否决。
- **README 内 `<details>` 折叠保留** —— 行数不减、维护面不减，只是视觉缩短，与「精简」目标矛盾。否决。
- **温和精简（只砍明确的设计原理段）** —— 功能条目里仍留机制从句，正文密度降不下来。否决（明确选择激进档）。
- **pricing.md 做双语** —— 深度文档受众小，双语同步成本大于收益；与 docs/decisions 全中文的既有惯例一致。否决。

## Consequences

- **所得**：README 双语 189/193 行 → ~125 行，一眼可读；深度计费配置有单一归宿，README 与 decisions 不再双写同一事实。
- **代价**：计费/镜像配置变更时需同步 README 与 pricing.md 两处（此前是 README 单处）。
- **代价**：pricing.md 单中文，英文读者多一跳翻译成本。
- **边界**：设计原理问询一律指向 `docs/decisions/`；README 中的机制性表述只保留「用户可感知」层（如货币随区域联动）。
