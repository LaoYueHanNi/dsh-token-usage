# 模型定价与计费详解

README 的深度延伸:计费规则链、价格文件格式、fork 维护者的镜像配置、货币展示联动。日常使用(看统计、装插件、改数据目录)不需要本文,见 [README](../README.zh.md)。

## 计费规则链

**每条记录按自身时间戳精确计费**,与 cc-switch-analyzer 同款规则链:

1. 命中时间区间规则(`timeRules`)优先——用规则内的上下文档位(`contextTiers`)与峰谷价(`dailySlots`);
2. 未命中时间规则,走模型根的档位 → 峰谷 → 基础价。

细节:

- `dailySlots` 可用 `daysOfWeek` 把峰谷限制在 ISO 星期(`1`=周一 … `7`=周日;缺省=每天),按请求的本地日匹配——例如 DeepSeek V4 的周末峰时按峰谷价之外的价格计。
- 档位匹配以上下文 token 量近似:本请求 `input + cacheRead + cacheWrite`。
- 定价表更新价格后,全部历史按新价即时重算,无需重建数据。

## 价格来源:两个文件,读取时合并

| 文件 | 来源 | 说明 |
|---|---|---|
| `pricing.ccsa.json` | 启动自动拉取 | 云端 model-price-table(cc-switch-analyzer 同源)的本地镜像,每次重启 dsh 自动刷新,失败时沿用旧镜像 |
| `pricing.json` | 手工编辑 | 覆盖同步价或补充缺失模型,手动微调不会被同步冲掉 |

`pricing.json` 的条目永远优先,**整模型覆盖**(该模型不再使用云端规则,可借此禁用其云端定价)。文件损坏或条目非法时对应模型按未定价处理,不影响统计页;保存后刷新页面即可生效。默认数据目录:`~/.dsh/token-usage/`(配置了 `path` 时以该目录为准)。

### 云端 feed 格式

`currency` 须为 `RMB`;`modelId` 与 `aliases` 都会展开为可匹配的键;`timeRules` / `contextTiers` / `dailySlots` 全部参与计费:

```json
{
  "version": 4,
  "updatedAt": 0,
  "currency": "RMB",
  "usdExchangeRate": 7,
  "models": [
    { "modelId": "deepseek-chat", "inputCostPerMillion": 2, "outputCostPerMillion": 8,
      "cacheReadCostPerMillion": 0.5, "cacheCreationCostPerMillion": 1, "aliases": ["deepseek-v3"] }
  ]
}
```

### pricing.json 扁平格式

键为模型 id、与记录中的 `model` 完全一致;`inputPerMillion`、`outputPerMillion` 必填,`cacheReadPerMillion` / `cacheWritePerMillion` 可选、缺省按输入价计费:

```json
{
  "deepseek-chat": { "inputPerMillion": 2, "outputPerMillion": 8, "cacheReadPerMillion": 0.5 }
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
