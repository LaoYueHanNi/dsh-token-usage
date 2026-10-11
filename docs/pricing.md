# 模型定价与计费详解

README 的深度延伸:计费规则链、价格文件格式、fork 维护者的镜像配置、货币展示联动。日常使用(看统计、装插件、改数据目录)不需要本文,见 [README](../README.zh.md)。

## 计费规则链

**每条记录按自身时间戳精确计费**,与 cc-switch-analyzer 同款规则链:

1. 命中时间区间规则(`timeRules`)优先——用规则内的上下文档位(`contextTiers`)与峰谷价(`dailySlots`);
2. 未命中时间规则,走模型根的档位 → 峰谷 → 基础价。

细节:

- `dailySlots` 可用 `daysOfWeek` 把峰谷限制在 ISO 星期(`1`=周一 … `7`=周日;缺省=每天),按请求的本地日匹配——例如 DeepSeek V4 的周末峰时按峰谷价之外的价格计。
- 档位匹配以上下文 token 量近似:本请求 `input + cacheRead + cacheWrite`。
- 定价上下文（识别算法、名称或价格规则）变化后，下次读取从原始记录重建冻结汇总并重新选规则；旧汇总缺指纹同样重建。首次读取可能较慢，请求数和 token 不变。源记录不完整时保留可用用量、隐藏无法可靠重算的费用。

## 模型识别

自动匹配分三阶段，全部忽略大小写，只有唯一命中才获得价格：

1. 原始完整名称先匹配全表 `modelId`，再匹配历史 `aliases`。
2. 各 `/` 路径段均非空时取最后一段，再匹配 ID、alias。前导、尾随、连续 `/` 不生成候选；不修剪空白、不移除版本或 `flash` / `flashx` / `fast` / `mini` 等身份。
3. 原名与去前缀候选执行 `aliasPatterns`，模型命中去重，跨模型命中报歧义。

`aliasPatterns` 缺省为 `[]`，使用上游无 flags、以 `^` / `$` 锚定的可移植语法（字面量、转义标点、分组、或分支及 `?`）；插件加载时校验编译，固定添加 `i`，要求匹配覆盖整个输入，包括拒绝尾部换行。大小写及 provider 前缀兼容是插件扩展，上游默认识别区分大小写且不去前缀。

原名优先于去前缀，ID 优先于 alias；任何阶段歧义均停止，不取第一条、不使用 contains。非法正则和忽略大小写后的重复 ID 使整份 feed 校验失败。无命中或歧义显示未定价及候选原因，费用显示 `—`，汇总只包含已识别模型；真实零单价仍已定价。不同 provider 的未识别完整名称保持独立，同一完整名称的大小写变体合并。设置页、会话页、筛选、详情和总览「已用」采用同一识别结果；原始用量记录不改写。

自动识别、手动关联及其操作界面均已实现；未定价位置也可直接打开上游 Issue 请求草稿。

## 本地名称关联

在设置页、会话用量页或费用详情中，点击模型名称旁的橙色「未定价」标签，弹窗提供「关联现有模型」和「增加模型定价」；选择前者进入关联面板：

1. 搜索框初始为空，不预填未定价模型 ID；只在本机定价表的模型 ID 中匹配输入关键词，忽略大小写与输入首尾空格，支持部分 ID。别名、家族及其他字段不参与匹配。空输入（含空格）不展示候选，唯一结果也不自动保存。
2. 选择目标，必要时点击「查看定价」核验完整规则，确认模型身份后点击「绑定模型」。成功后自动关闭绑定弹窗。
3. 页面沿用当前日期、模型与会话范围刷新。模型名旁的小问号悬停约 100ms 后显示「此模型含手动关联：[原始模型 ID]」，键盘聚焦也可显示；使用普通鼠标指针，多条来源完整列出。查看映射和撤销集中在定价表的「模型别名关联」中。

在「定价表」弹窗标题旁点击「模型别名关联」，可查看当前数据目录的全部保存条目，不受用量或定价搜索筛选影响，空窗口也可打开。每条一行，左侧显示「来源 → 目标」，右侧只有「撤销关联」；不显示逐条状态提示或「查看／修改」入口。自动接管和目标失效不会删除原选择；撤销前会说明全部历史及后续用量的影响。更换映射可先撤销，再从未定价标签重新绑定。保存冲突会显示当前状态，需核对后明确重试；目录切换会清空旧选择并重读候选。操作失败不显示成功，保留搜索与选择。

未定价操作弹窗的「增加模型定价」在新标签页打开 [model-price-table Issue 草稿](https://github.com/LaoYueHanNi/model-price-table/issues/new)，关联绑定页不重复此入口。英文标题为 `Add model pricing: {modelId}`，正文提供可选价格参考（币种、四项 token 单价、上下文窗口）、可选官方定价 URL，并自动填充当前定价表版本。请按需补充后自行提交。链接不自动提交、不附带用量、会话内容、API key 或项目路径。

关联仅把尚无唯一自动结果的原始完整名称指向已有云端 `modelId`，不保存价格。来源忽略大小写但不去前缀；`p/internal` 不影响 `q/internal` 或 `internal`。关联目标的时间规则、上下文档位、工作日峰谷和真实零单价都正常生效；保存、修改、撤销会重算全部可恢复的历史及后续用量，原始记录不变。

关联保存在当前数据目录的 `pricing-associations.json`，与价格镜像分离：

```json
{
  "version": 1,
  "revision": 1,
  "associations": [
    { "sourceModel": "provider/internal-name", "targetModelId": "glm-5.3-flash" }
  ]
}
```

文件缺失是 revision 0 的空表；未知版本、非法字段、重复来源、不可读或损坏文件会保留原内容、禁用人工关联并拒绝写入，页面显示存储故障。自动识别继续可用。目标只接受真实 ID，不接受 alias 或另一条关联。

本机接口 `/token-usage/pricing-associations` 的 GET 返回 `directoryToken`、`revision`、存储／定价状态、可选 `feedVersion` 和全部关联，可用 `?sourceModel=…` 附带单个名称解析；POST 保存需 JSON `{sourceModel,targetModelId,revision,directoryToken}`，DELETE 撤销需 `{sourceModel,revision,directoryToken}`。先读取状态，提交当前修订号和目录标识；409 冲突返回当前状态，不能自动重试覆盖其他修改。所有响应不缓存，写请求上限 64 KiB。

每条关联状态为 `active`（生效）、`automatic-takeover`（自动接管，保留原选择及是否不同）、`target-missing`（目标失效）或 `pricing-unavailable`（无有效镜像）。自动结果优先，不能手动覆盖；自动再次失败时原有效选择会重新生效。目标改名不沿 alias 追踪，但仅改变 ID 大小写仍有效；撤销后可能由自动规则继续定价。

关联文件随数据目录迁移。迁移时暂停写入，源／目标同名内容不同则在复制其他文件前拒绝迁移，保留两边；仅逐字节一致才能清理源文件。损坏文件也按原始字节保护。并发保护限本宿主进程，不提供跨进程文件锁。

## 价格来源:云端镜像

| 文件 | 来源 | 说明 |
|---|---|---|
| `pricing.ccsa.json` | 启动自动拉取 | 云端 model-price-table(cc-switch-analyzer 同源)的本地镜像,每次重启 dsh 自动刷新,失败时沿用旧镜像 |

只有这一份来源:启动自动同步的云端镜像。无有效镜像时明确显示定价表不可用及原因（未同步、无法读取、JSON 损坏或校验失败），隐藏费用但保留用量；新同步校验失败不会覆盖旧有效镜像。保存到磁盘上的旧版 `pricing.json` 升级后会被忽略(只是不再被读取,文件不被主动删除)。默认数据目录:`~/.dsh/token-usage/`(配置了 `path` 时以该目录为准)。

### 云端 feed 格式

`currency` 须为 `RMB`;`modelId`、历史 `aliases` 和可选 `aliasPatterns` 参与下述统一识别;`timeRules` / `contextTiers` / `dailySlots` 全部参与计费:

```json
{
  "version": 4,
  "updatedAt": 0,
  "currency": "RMB",
  "usdExchangeRate": 7,
  "models": [
    { "modelId": "deepseek-chat", "inputCostPerMillion": 2, "outputCostPerMillion": 8,
      "cacheReadCostPerMillion": 0.5, "cacheCreationCostPerMillion": 1, "aliases": ["deepseek-v3"], "aliasPatterns": [] }
  ]
}
```

## 镜像与区域配置(fork 维护者)

启动同步默认拉 **Gitee**(中国大陆内速度快),`pricingRegion: overseas` 切到同一张表的 **GitHub 镜像**(Web 设置里的「定价区域」下拉等效)。不做 IP 探测,部署时手动选一次。保存地区切换后立即重新同步;**不自动回退**:选定的镜像拉取失败就沿用旧镜像,等待下次同步重试。

| 配置项 | 默认 | 含义 |
|---|---|---|
| `pricingRegion` | `domestic` | `domestic` → Gitee,`overseas` → GitHub(`pricingUrl` 未设置时生效) |
| `pricingUrl` | — | 显式指定单个 feed(仅 cordis.yml 可设),优先级最高,覆盖下面两项 |
| `pricingUrlDomestic` | Gitee feed | 国内镜像覆盖(仅 cordis.yml 可设;自维护 fork 用) |
| `pricingUrlOverseas` | GitHub 镜像 | 国外镜像覆盖(仅 cordis.yml 可设;自维护 fork 用) |

自己维护 model-price-table fork 时,用 `pricingUrlDomestic` / `pricingUrlOverseas` 指到你的地址。

## 货币展示联动

地区切换同时决定统计页的费用展示货币:

- **国内 / 默认(Gitee)**:人民币展示(`¥` + 原表数字);
- **全球(GitHub)**:美元展示(`$` + `RMB ÷ 汇率`)。

汇率取定价表最顶层的 `usdExchangeRate` 字段(人民币兑 1 美元),镜像尚未携带该字段时回退内置默认值 `7`。联动覆盖每处金额:汇总总费用、按模型费用列、未定价提示,以及「定价」弹窗里的入/出/缓/写单价(美元模式下列表下方标注换算汇率)。线协议上传输的金额始终是人民币数值,换算只在展示层进行,切换区域不用重建任何统计。

## 相关决策记录

- [峰谷 daysOfWeek 语义](./decisions/implemented/2026-08-29-daily-slots-days-of-week.md)
- [上下文压缩请求计费](./decisions/implemented/2026-09-02-compaction-billing.md)
- [废除手工 pricing.json 定价文件](./decisions/implemented/2026-09-05-abolish-manual-pricing-json.md)

- [统一自动识别与历史重算](./decisions/implemented/2026-10-10-model-pricing-resolution.md)
- [手动关联后端与迁移保护](./decisions/implemented/2026-10-10-model-pricing-associations.md)
- [局部关联界面与上游草稿](./decisions/implemented/2026-10-10-model-pricing-association-ui.md)
