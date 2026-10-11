# 定价表历史别名正则覆盖审计

审计日期：2026-10-11。来源：`D:/Code/model-price-table/model_pricing.json`，版本 114，updatedAt 1791692700。本报告不修改定价表或消费者源码。

> [!NOTE]
> 本报告保留 v114 的历史审计快照，下面的遗漏清单不代表最新定价表状态。2026-10-11 后续核对 v115（113 条正则），在本项目修复字面量冒号校验后，全部 255 个历史别名及其大写变体均唯一映射到原目标；完整名称匹配和本项目 provider 兼容解析均通过。真实 Gitee 下载、校验和临时目录写盘也已验证成功。

本项目 dsh-token-usage 当前只用 modelId 与 aliasPatterns；仍忽略大小写并支持有效 provider 路径末段匹配。本报告使用已构建的实际解析器检查全部历史 aliases，并另行检查上游不去前缀时的完整名称匹配。

| 检查项 | 数量 |
| --- | ---: |
| 模型总数 | 212 |
| 当前正则规则 | 43 |
| 历史别名条目 / 忽略大小写后的唯一名称 | 255 / 255 |
| 当前项目仍正确识别的历史别名 | 197 |
| 当前项目失去自动识别的历史别名 | 58 |
| 涉及模型 | 48 |
| 当前项目新增歧义 / 错配 | 0 / 0 |
| 上游不去前缀时，缺少完整 ID / 正则覆盖的历史别名 | 70 |

## 当前项目受影响清单

所有以下历史名称原本都有唯一映射，现在均为 unmatched。只有名称本身成为真实 modelId，或补齐 aliasPatterns，或保存本地关联后才会恢复。

| 目标 modelId | 遗漏历史名称 | 现有正则条数 |
| --- | --- | ---: |
| `cursor-auto` | `auto`、`default` | 0 |
| `agent_review` | `no-price-use-composer` | 0 |
| `MiniMax-M2.7` | `minimin-m2.7` | 0 |
| `MiniMax-M3` | `minimax-m3-free` | 0 |
| `Claude-3.5-Haiku` | `claude-3-5-haiku-20241022` | 0 |
| `Claude-3.5-Sonnet` | `claude-3-5-sonnet-20241022` | 0 |
| `Claude-Haiku-4.5` | `claude-haiku-4-5-20251001`、`claude-haiku-4-5` | 0 |
| `Claude-Opus-4.1` | `claude-opus-4-1-20250805` | 0 |
| `Claude-Opus-4` | `claude-opus-4-20250514` | 0 |
| `Claude-Opus-4.5` | `claude-opus-4-5-20251101` | 0 |
| `Claude-Opus-4.6` | `claude-opus-4-6-20260206` | 1 |
| `Claude-Opus-4.7` | `claude-opus-4-7` | 0 |
| `Claude-Opus-4.8` | `claude-opus-4-8` | 1 |
| `Claude-Opus-5.5-Fast` | `claude-opus-5-5-fast` | 0 |
| `Claude-Sonnet-4` | `claude-sonnet-4-20250514` | 0 |
| `Claude-Sonnet-4.5` | `claude-sonnet-4-5-20250929` | 0 |
| `Claude-Sonnet-4.6` | `claude-sonnet-4-6`、`claude-sonnet-4-6-20260217` | 0 |
| `Claude-Fable-5.1` | `claude-fable-5-1` | 1 |
| `Claude-Mythos-5.1` | `claude-mythos-5-1` | 1 |
| `deepseek-v4-flash` | `deepseek-v4-flash-free`、`deepseek-v4-flash-ga-260731` | 1 |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-expires-on-0910` | 1 |
| `deepseek-v4-pro` | `deepseek-v4-pro-0813` | 0 |
| `doubao-seed-2-0-pro` | `doubao-seed-2-0-pro-260215` | 0 |
| `gemini-3.8-flash` | `gemini-3.8-flash-tiered` | 1 |
| `glm-5.3` | `glm-latest` | 0 |
| `glm-5.3-flash` | `glm-flash-latest` | 0 |
| `gpt-5.6-sol` | `gpt-daybreak-blue-latest` | 1 |
| `gpt-5.6-cyber` | `gpt-daybreak-red-latest` | 1 |
| `grok-4.5` | `grok-4.5-build-free` | 0 |
| `hy3` | `hy3-free` | 0 |
| `hy4` | `hy4-preview` | 0 |
| `kimi-k2.6` | `k2d6-agent` | 0 |
| `kimi-k3` | `k3-256k`、`k3-agent`、`kimi-code/k3-256k` | 0 |
| `kimi-k2.8` | `k2.8-preview`、`k2d8-preview`、`k28-agent-preview` | 0 |
| `kimi-for-coding-highspeed` | `kimi-k2.7-code-highspeed` | 0 |
| `mimo-v2.5` | `mimo-v2.5-free` | 0 |
| `nemotron-3-super` | `nemotron-3-super-120b-a12b:free`、`nemotron-3-super-free` | 0 |
| `muse-spark-1.3` | `muse-spark-1.3-0902` | 0 |
| `qwen3.6-plus` | `qwen3.6-plus-free` | 0 |
| `qwen3.8-max` | `qwen3.8-max-0902`、`qwen3.8-2.4t-a95b` | 0 |
| `qwen3.8-flash` | `qwen3.8-flash-next` | 0 |
| `qwen3.8-27b` | `Qwen3.8-27B-Q4` | 0 |
| `pareto` | `union-alpha` | 0 |
| `inception-mercury-2.5-preview` | `inception/mercury-2.5-preview` | 0 |
| `solar-pro-4` | `upstage/solar-pro4` | 0 |
| `poolside-laguna-s-2.1` | `poolside/laguna-s-2.1` | 0 |
| `poolside-laguna-xs-2.1` | `poolside/laguna-xs-2.1` | 0 |
| `bonsai2-27b` | `prism-ml/ternary-bonsai-2-27b` | 0 |

## 按家族统计

| 家族 | 受影响模型 | 遗漏别名 |
| --- | ---: | ---: |
| spacex-ai | 3 | 4 |
| minimax | 2 | 2 |
| claude | 15 | 17 |
| deepseek | 3 | 4 |
| doubao | 1 | 1 |
| google | 1 | 1 |
| glm | 2 | 2 |
| gpt | 2 | 2 |
| tencent | 2 | 2 |
| kimi | 4 | 8 |
| mimo | 1 | 1 |
| other | 6 | 7 |
| meta | 1 | 1 |
| qwen | 4 | 5 |
| pareto | 1 | 1 |

## 当前项目已通过前缀归一化覆盖的额外名称

这些名称在当前项目没有回退，但上游规范不去前缀；如果要让新正则完全承接旧 aliases，仍应补齐其完整名称。

| 历史名称 | 目标 modelId |
| --- | --- |
| `kimi-code/kimi-for-coding` | `kimi-for-coding` |
| `stealth/ox-alpha` | `ox-alpha` |
| `meta/muse-glimmer-30b` | `muse-glimmer-30b` |
| `meta/muse-spark-1.1` | `muse-spark-1.1` |
| `qwen/qwen3.7-flash` | `qwen3.7-flash` |
| `nvidia/nemotron-3.5-lightning` | `nemotron-3.5-lightning` |
| `sakana/sakana-namazu` | `sakana-namazu` |
| `thinkingmachines/inkling` | `inkling` |
| `thinkingmachines/inkling-small` | `inkling-small` |
| `inclusionai/ling-3.0-flash` | `ling-3.0-flash` |
| `inclusionai/ling-3.0-flash-fin` | `ling-3.0-flash-fin` |
| `kwaipilot/kat-coder-pro-v2.5` | `kat-coder-pro-v2.5` |

## 给定价表维护者的建议

- 为下方全部遗漏完整名称追加锚定字面量正则；等价名称可以合并成分组与可选段。保留已有规则和冻结的 aliases。
- 已确认日期名称可合并，例如 deepseek-v4-flash 使用 `^deepseek-v4-flash(-0731)?$`；其 `-free` 和 `-ga-260731` 也有既存映射，应一起覆盖。不要默认接受所有日期或任意后缀。
- Claude 的点号 modelId 与连字符 API 名不相同；仅添加带 thinking/努力等级的规则仍可能漏掉基础 API 名。普通模型与 Fast 模型分别维护，不把 fast 设为可选。
- free、preview、latest、tiered、大小规格及提供商更名都只迁移已有映射，不以名称相似推断新的同价关系。
- 按上游 AGENTS.md 执行价格表元数据更新、Schema 校验、全表 ID/别名跨模型冲突检查和模型身份隔离测试。
- 本次上游新增正则支持本身并非违反兼容契约：上游明确要求消费者继续支持旧 aliases；当前项目主动停读旧字段，才使未迁移名称失去匹配。补正则可满足当前项目的正则专用契约。

## 可供迁移的保守字面量正则

以下候选按既有 aliases 映射生成，未直接写入定价表。已验证每条能以 i 标志完整匹配原名及大写变体，且将全部候选追加到内存快照后，本项目解析器无新增错配或歧义。仍需上游完整数据校验。

```json
[
  {
    "modelId": "cursor-auto",
    "alias": "auto",
    "addAliasPattern": "^auto$"
  },
  {
    "modelId": "cursor-auto",
    "alias": "default",
    "addAliasPattern": "^default$"
  },
  {
    "modelId": "agent_review",
    "alias": "no-price-use-composer",
    "addAliasPattern": "^no-price-use-composer$"
  },
  {
    "modelId": "MiniMax-M2.7",
    "alias": "minimin-m2.7",
    "addAliasPattern": "^minimin-m2\\.7$"
  },
  {
    "modelId": "MiniMax-M3",
    "alias": "minimax-m3-free",
    "addAliasPattern": "^minimax-m3-free$"
  },
  {
    "modelId": "Claude-3.5-Haiku",
    "alias": "claude-3-5-haiku-20241022",
    "addAliasPattern": "^claude-3-5-haiku-20241022$"
  },
  {
    "modelId": "Claude-3.5-Sonnet",
    "alias": "claude-3-5-sonnet-20241022",
    "addAliasPattern": "^claude-3-5-sonnet-20241022$"
  },
  {
    "modelId": "Claude-Haiku-4.5",
    "alias": "claude-haiku-4-5-20251001",
    "addAliasPattern": "^claude-haiku-4-5-20251001$"
  },
  {
    "modelId": "Claude-Haiku-4.5",
    "alias": "claude-haiku-4-5",
    "addAliasPattern": "^claude-haiku-4-5$"
  },
  {
    "modelId": "Claude-Opus-4.1",
    "alias": "claude-opus-4-1-20250805",
    "addAliasPattern": "^claude-opus-4-1-20250805$"
  },
  {
    "modelId": "Claude-Opus-4",
    "alias": "claude-opus-4-20250514",
    "addAliasPattern": "^claude-opus-4-20250514$"
  },
  {
    "modelId": "Claude-Opus-4.5",
    "alias": "claude-opus-4-5-20251101",
    "addAliasPattern": "^claude-opus-4-5-20251101$"
  },
  {
    "modelId": "Claude-Opus-4.6",
    "alias": "claude-opus-4-6-20260206",
    "addAliasPattern": "^claude-opus-4-6-20260206$"
  },
  {
    "modelId": "Claude-Opus-4.7",
    "alias": "claude-opus-4-7",
    "addAliasPattern": "^claude-opus-4-7$"
  },
  {
    "modelId": "Claude-Opus-4.8",
    "alias": "claude-opus-4-8",
    "addAliasPattern": "^claude-opus-4-8$"
  },
  {
    "modelId": "Claude-Opus-5.5-Fast",
    "alias": "claude-opus-5-5-fast",
    "addAliasPattern": "^claude-opus-5-5-fast$"
  },
  {
    "modelId": "Claude-Sonnet-4",
    "alias": "claude-sonnet-4-20250514",
    "addAliasPattern": "^claude-sonnet-4-20250514$"
  },
  {
    "modelId": "Claude-Sonnet-4.5",
    "alias": "claude-sonnet-4-5-20250929",
    "addAliasPattern": "^claude-sonnet-4-5-20250929$"
  },
  {
    "modelId": "Claude-Sonnet-4.6",
    "alias": "claude-sonnet-4-6",
    "addAliasPattern": "^claude-sonnet-4-6$"
  },
  {
    "modelId": "Claude-Sonnet-4.6",
    "alias": "claude-sonnet-4-6-20260217",
    "addAliasPattern": "^claude-sonnet-4-6-20260217$"
  },
  {
    "modelId": "Claude-Fable-5.1",
    "alias": "claude-fable-5-1",
    "addAliasPattern": "^claude-fable-5-1$"
  },
  {
    "modelId": "Claude-Mythos-5.1",
    "alias": "claude-mythos-5-1",
    "addAliasPattern": "^claude-mythos-5-1$"
  },
  {
    "modelId": "deepseek-v4-flash",
    "alias": "deepseek-v4-flash-free",
    "addAliasPattern": "^deepseek-v4-flash-free$"
  },
  {
    "modelId": "deepseek-v4-flash",
    "alias": "deepseek-v4-flash-ga-260731",
    "addAliasPattern": "^deepseek-v4-flash-ga-260731$"
  },
  {
    "modelId": "deepseek-v4.1-flash",
    "alias": "deepseek-v4.1-flash-expires-on-0910",
    "addAliasPattern": "^deepseek-v4\\.1-flash-expires-on-0910$"
  },
  {
    "modelId": "deepseek-v4-pro",
    "alias": "deepseek-v4-pro-0813",
    "addAliasPattern": "^deepseek-v4-pro-0813$"
  },
  {
    "modelId": "doubao-seed-2-0-pro",
    "alias": "doubao-seed-2-0-pro-260215",
    "addAliasPattern": "^doubao-seed-2-0-pro-260215$"
  },
  {
    "modelId": "gemini-3.8-flash",
    "alias": "gemini-3.8-flash-tiered",
    "addAliasPattern": "^gemini-3\\.8-flash-tiered$"
  },
  {
    "modelId": "glm-5.3",
    "alias": "glm-latest",
    "addAliasPattern": "^glm-latest$"
  },
  {
    "modelId": "glm-5.3-flash",
    "alias": "glm-flash-latest",
    "addAliasPattern": "^glm-flash-latest$"
  },
  {
    "modelId": "gpt-5.6-sol",
    "alias": "gpt-daybreak-blue-latest",
    "addAliasPattern": "^gpt-daybreak-blue-latest$"
  },
  {
    "modelId": "gpt-5.6-cyber",
    "alias": "gpt-daybreak-red-latest",
    "addAliasPattern": "^gpt-daybreak-red-latest$"
  },
  {
    "modelId": "grok-4.5",
    "alias": "grok-4.5-build-free",
    "addAliasPattern": "^grok-4\\.5-build-free$"
  },
  {
    "modelId": "hy3",
    "alias": "hy3-free",
    "addAliasPattern": "^hy3-free$"
  },
  {
    "modelId": "hy4",
    "alias": "hy4-preview",
    "addAliasPattern": "^hy4-preview$"
  },
  {
    "modelId": "kimi-k2.6",
    "alias": "k2d6-agent",
    "addAliasPattern": "^k2d6-agent$"
  },
  {
    "modelId": "kimi-k3",
    "alias": "k3-256k",
    "addAliasPattern": "^k3-256k$"
  },
  {
    "modelId": "kimi-k3",
    "alias": "k3-agent",
    "addAliasPattern": "^k3-agent$"
  },
  {
    "modelId": "kimi-k3",
    "alias": "kimi-code/k3-256k",
    "addAliasPattern": "^kimi-code/k3-256k$"
  },
  {
    "modelId": "kimi-k2.8",
    "alias": "k2.8-preview",
    "addAliasPattern": "^k2\\.8-preview$"
  },
  {
    "modelId": "kimi-k2.8",
    "alias": "k2d8-preview",
    "addAliasPattern": "^k2d8-preview$"
  },
  {
    "modelId": "kimi-k2.8",
    "alias": "k28-agent-preview",
    "addAliasPattern": "^k28-agent-preview$"
  },
  {
    "modelId": "kimi-for-coding",
    "alias": "kimi-code/kimi-for-coding",
    "addAliasPattern": "^kimi-code/kimi-for-coding$"
  },
  {
    "modelId": "kimi-for-coding-highspeed",
    "alias": "kimi-k2.7-code-highspeed",
    "addAliasPattern": "^kimi-k2\\.7-code-highspeed$"
  },
  {
    "modelId": "mimo-v2.5",
    "alias": "mimo-v2.5-free",
    "addAliasPattern": "^mimo-v2\\.5-free$"
  },
  {
    "modelId": "nemotron-3-super",
    "alias": "nemotron-3-super-120b-a12b:free",
    "addAliasPattern": "^nemotron-3-super-120b-a12b\\:free$"
  },
  {
    "modelId": "nemotron-3-super",
    "alias": "nemotron-3-super-free",
    "addAliasPattern": "^nemotron-3-super-free$"
  },
  {
    "modelId": "muse-spark-1.3",
    "alias": "muse-spark-1.3-0902",
    "addAliasPattern": "^muse-spark-1\\.3-0902$"
  },
  {
    "modelId": "ox-alpha",
    "alias": "stealth/ox-alpha",
    "addAliasPattern": "^stealth/ox-alpha$"
  },
  {
    "modelId": "qwen3.6-plus",
    "alias": "qwen3.6-plus-free",
    "addAliasPattern": "^qwen3\\.6-plus-free$"
  },
  {
    "modelId": "qwen3.8-max",
    "alias": "qwen3.8-max-0902",
    "addAliasPattern": "^qwen3\\.8-max-0902$"
  },
  {
    "modelId": "qwen3.8-max",
    "alias": "qwen3.8-2.4t-a95b",
    "addAliasPattern": "^qwen3\\.8-2\\.4t-a95b$"
  },
  {
    "modelId": "qwen3.8-flash",
    "alias": "qwen3.8-flash-next",
    "addAliasPattern": "^qwen3\\.8-flash-next$"
  },
  {
    "modelId": "qwen3.8-27b",
    "alias": "Qwen3.8-27B-Q4",
    "addAliasPattern": "^Qwen3\\.8-27B-Q4$"
  },
  {
    "modelId": "pareto",
    "alias": "union-alpha",
    "addAliasPattern": "^union-alpha$"
  },
  {
    "modelId": "muse-glimmer-30b",
    "alias": "meta/muse-glimmer-30b",
    "addAliasPattern": "^meta/muse-glimmer-30b$"
  },
  {
    "modelId": "muse-spark-1.1",
    "alias": "meta/muse-spark-1.1",
    "addAliasPattern": "^meta/muse-spark-1\\.1$"
  },
  {
    "modelId": "qwen3.7-flash",
    "alias": "qwen/qwen3.7-flash",
    "addAliasPattern": "^qwen/qwen3\\.7-flash$"
  },
  {
    "modelId": "nemotron-3.5-lightning",
    "alias": "nvidia/nemotron-3.5-lightning",
    "addAliasPattern": "^nvidia/nemotron-3\\.5-lightning$"
  },
  {
    "modelId": "inception-mercury-2.5-preview",
    "alias": "inception/mercury-2.5-preview",
    "addAliasPattern": "^inception/mercury-2\\.5-preview$"
  },
  {
    "modelId": "solar-pro-4",
    "alias": "upstage/solar-pro4",
    "addAliasPattern": "^upstage/solar-pro4$"
  },
  {
    "modelId": "sakana-namazu",
    "alias": "sakana/sakana-namazu",
    "addAliasPattern": "^sakana/sakana-namazu$"
  },
  {
    "modelId": "poolside-laguna-s-2.1",
    "alias": "poolside/laguna-s-2.1",
    "addAliasPattern": "^poolside/laguna-s-2\\.1$"
  },
  {
    "modelId": "poolside-laguna-xs-2.1",
    "alias": "poolside/laguna-xs-2.1",
    "addAliasPattern": "^poolside/laguna-xs-2\\.1$"
  },
  {
    "modelId": "inkling",
    "alias": "thinkingmachines/inkling",
    "addAliasPattern": "^thinkingmachines/inkling$"
  },
  {
    "modelId": "inkling-small",
    "alias": "thinkingmachines/inkling-small",
    "addAliasPattern": "^thinkingmachines/inkling-small$"
  },
  {
    "modelId": "ling-3.0-flash",
    "alias": "inclusionai/ling-3.0-flash",
    "addAliasPattern": "^inclusionai/ling-3\\.0-flash$"
  },
  {
    "modelId": "ling-3.0-flash-fin",
    "alias": "inclusionai/ling-3.0-flash-fin",
    "addAliasPattern": "^inclusionai/ling-3\\.0-flash-fin$"
  },
  {
    "modelId": "kat-coder-pro-v2.5",
    "alias": "kwaipilot/kat-coder-pro-v2.5",
    "addAliasPattern": "^kwaipilot/kat-coder-pro-v2\\.5$"
  },
  {
    "modelId": "bonsai2-27b",
    "alias": "prism-ml/ternary-bonsai-2-27b",
    "addAliasPattern": "^prism-ml/ternary-bonsai-2-27b$"
  }
]
```
