# 决策记录（Decision Records）

本目录记录本项目所有"维护者将来可能合理重审"的决策：为什么这样设计、放弃了什么。
Git 回答"怎么做"，决策记录回答"为什么不那样做"。

## 目录与状态

- `proposed/` — 未实施的提案，评审后再做
- `implemented/` — 已落地；随代码同步更新事实
- `rejected/` — 被否决；仅保留理由仍能阻止再次踩坑的
- `archived/` — 已归档并永久冻结的历史快照

文件名：`yyyy-mm-dd-slug.md`，日期为**首次提出**日。状态编码在路径里，`Status:` 行须与所在目录一致（`check.mjs` 交叉校验）。

## 何时写

非平凡变更必须在同一个提交里新增或更新至少一条。非平凡 = 改变行为、架构、跨文件契约、工具链、测试策略、磁盘或线上格式。纯机械局部编辑豁免。先搜索同主题：更新已有记录优先于新建。

## 格式

头部固定三行：

```
# DR: <标题>

Status: <状态>
```

`Status` 取值：`proposed` / `implemented` / `rejected — 一行理由`（rejected 的理由写在 Status 行，那是读者要的判决）。

### proposed 骨架

`## Problem`（动机，不看方案也能懂）→ `## Proposal`（打算做什么，可用将来时）→ `## Alternatives considered` → `## Acceptance criteria`（什么可观察状态算完成）→ `## Risks`（可能出什么问题 + 主动放弃了什么）。

### implemented 骨架

`## Problem` → `## Decision`（现在时，描述实际落地的样子）→ `## Alternatives considered` → `## Consequences`（代价与所得，两边都要写）。禁止出现 Proposal/Plan/Acceptance criteria 等规划性段落。

### rejected

提案原样冻结（保留提案期全部段落），判决只写在 Status 行。

## 规则

1. **Alternatives considered 强制**：每个真实考虑过的替代方案一段加粗开头，写清为什么输。记录而非发明——确实没有就写"无"。没有记录打败了什么的决策，就是在邀请它被重新争论一遍。
2. **推翻决策 = 新开一条 + 双向链接**；禁止把 implemented 原地改写成相反决定。旧条目被完全取代时可合并删除，但须先迁移全部独特理由并修复所有入链。
3. **implemented 随代码更新事实**：路径、名称、默认值变了，同一提交里同步更新；只改事实，不改决策。
4. **rejected 的保留条件**：理由仍能阻止一个有诱惑力的、有实质影响的错误；否则连同全文删除。堆满尸体的 rejected 库会让读者失去对整个体系的信任。
5. **归档**：决策已完成且理由 unlikely 指导未来工作时，移入 `archived/`，在 Status 行下加一行 `Archived: yyyy-mm-dd`，此后永不改动，也不作为当前权威引用。
6. **交叉引用用相对 markdown 链接**（如 `[主题](../implemented/2026-01-01-xxx.md)`），禁止裸编号引用——编号会因删除失效，路径加死链检查不会。

## 提交前自查

```sh
node docs/decisions/check.mjs
```

校验 Status 与目录一致、骨架段落齐全、归档标记存在、相对链接无死链。
