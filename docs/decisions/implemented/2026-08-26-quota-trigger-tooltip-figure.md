# DR: 配额按钮 hover tooltip 展示供应商名与最细窗口的剩余数字

Status: implemented

## Problem

输入栏配额按钮的 hover tooltip 是静态文案"供应商配额"（`quota.trigger`），不携带任何数字；而环图标只能粗略示意（帽补偿后也仅是"满/未满"二分 + 粗刻度），想知道确切剩余量必须点开面板。

## Decision

tooltip 改为 **供应商名称 · 数字**：数字取最细粒度窗口（与环一致）的剩余百分比（任意方向比例或余额分数均可推导时），无比例时回退剩余金额（纯余额供应商，如 DeepSeek）；错误或无窗口 payload 回退原静态文案。计算收进 `quota-format.ts` 的纯函数 `quotaTriggerFigure`（单测覆盖三种形态），文案经新 locale key `quota.triggerSummary`（`{name} · {figure}`，中英同形）组装，按钮的 `aria-label` 保持静态不动。

## Alternatives considered

- **保持静态文案** —— 一眼无从得知余量，且环的粗刻度已把"确切数字"的诉求推给了 tooltip/面板，tooltip 是比点开面板更轻的载体。
- **tooltip 直接复用面板首列的完整文案**（含档位名与重置倒计时） —— 信息更全但一行放不下，且与面板重复；名称+一个数字是 hover 场景的合理密度。
- **同步更新 `aria-label` 为动态数字** —— 对读屏更友好，但会改动全部既有测试的选择器锚点，且可访问名随轮询变化产生抖动；读屏用户仍可经面板获得完整信息，不值得。

## Consequences

- 代价：多一个 locale key 与一个导出函数；tooltip 文案随轮询更新（45s TTL 缓存 + 打开刷新，变化频率低，可接受）。
- 换来：悬停即得"哪家供应商 + 还剩多少"的精确答案，与环的"粗看"、面板的"全量"形成三层信息密度。
