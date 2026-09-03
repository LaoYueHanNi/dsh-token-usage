# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![Token 用量统计页](docs/images/token-usage_zh.png)

简体中文 | [English](./README.md)

一个 [dsh] 用量插件：在 Web 界面直接展示模型 token 用量。安装后打开**设置**（侧栏底部齿轮），即可看到「Token 用量」页 —— 汇总卡片（含费用）、按日总 token 折线图、按模型明细表与定价弹窗，支持按日期区间和模型筛选，效果见上图。

[dsh]: https://github.com/cordiverse/dsh

仓库：<https://github.com/LaoYueHanNi/dsh-token-usage>

> [!IMPORTANT]
> **GitHub 直装已终止**——仓库不再携带构建产物，请改从 npm 安装：
>
> ```sh
> dsh plugin --profile web add @laoyuehanni/dsh-token-usage
> ```
>
> **从旧 `github:` 安装（≤ 0.3.7，包名 `dsh-token-usage`）升级？** 原地 `update` 会导致加载失败——先移除旧包名再重新安装。`$DSH_HOME/token-usage/` 下的历史数据完整保留。

## 功能

- **实时记录**：每一次 provider 计费调用发生即记录——token、费用、模型、会话，上下文压缩调用同样计入。
- **Web 统计页**：过滤条（日期区间 + 模型下拉 + `1d`/`7d`/`30d` 快捷区间）、汇总卡片、按日趋势图（悬停查看当日总量）、按模型明细表。
- **会话用量页签**：对话面板新增「用量」视图页签（与聊天 / 轨迹并列），展示当前会话的 dashboard —— 六张数值卡（成功请求数带失败胶囊、费用、缓存命中率、首 token 平均延迟、出字速度、总 token）+ 四项 token 明细条 + 按小时趋势图 + 按模型表。「本会话 / 含子会话」一键切换范围，子会话表逐行钻取并可逐级返回。悬停失败胶囊可看按失败类别的明细（限流 / 网络异常 / 上下文超限 等逐一计数）。

![会话用量页签](docs/images/usage-tab_zh.png)

- **费用统计与模型定价**：按模型单价（¥/百万 token）逐条实时计费，未定价模型高亮提示（费用按 ¥0 计）。定价模型的名字旁有**「定价」小按钮**，点击弹窗展示该模型的完整价格表。价格每次启动自动从云端同步，`pricing.json` 手工覆盖——详见「[模型定价](#模型定价)」。
- **供应商配额**：输入栏模型选择器左侧的配额按钮，跟随当前选中的供应商展示套餐余量。详见「[供应商配额](#供应商配额)」。
- **历史补齐**：首次启动自动同步安装前已发生的请求（幂等）；无法解析的会话日志跳过并计数，绝不中断同步。

## 模型定价

每条记录按自身时间戳精确计费，价格更新后全部历史即时重算。定价来自两个文件，读取时合并——启动自动同步的云端镜像，加上手工编辑的 `pricing.json`（条目永远优先，整模型覆盖）：

```json
{
  "deepseek-chat": { "inputPerMillion": 2, "outputPerMillion": 8, "cacheReadPerMillion": 0.5 }
}
```

文件损坏只影响对应模型（按未定价处理），不影响统计页。默认目录：`~/.dsh/token-usage/`。计费规则链、云端 feed 格式与自建镜像地址：[docs/pricing.md](./docs/pricing.md)。

## 配置

### 数据目录

在 Web 卡片（**设置 → 插件 → Token 用量**）里修改：保存绝对路径**立即生效**——历史数据自动迁移，无需重启、无需手动搬数据。留空保持默认 `~/.dsh/token-usage/`。对话进行中时保存会被拒绝，等对话结束再保存即可。也可用配置直接指定：

```yml
plugins:
  token-usage:
    path: D:/data/token-usage   # 缺省：~/.dsh/token-usage/
```

### 定价区域

定价镜像跟随区域：默认 **Gitee**（中国大陆内速度快），可切到同一张表的 **GitHub 镜像**——在 Web 卡片的「定价区域」下拉选一次，或用配置。该选择同时决定费用展示货币（¥ 人民币 / $ 美元，按定价表汇率换算）。

```yml
plugins:
  token-usage:
    pricingRegion: overseas   # 默认：domestic
```

## 供应商配额

输入栏按钮跟随当前选中的供应商，点开即可查看套餐余量（与推理共用同一把 API Key）：

<img src="docs/images/zhipu-plan-usage_zh.png" width="520" alt="智谱 GLM 配额面板">

<img src="docs/images/opencode-go-plan-usage_zh.png" width="520" alt="OpenCode Go 配额面板">

| 供应商 | 展示 |
|---|---|
| 智谱 GLM Coding Plan（国内 / 国际） | 5 小时、每周（部分套餐另有每月） |
| Kimi For Coding | 5 小时、每周 |
| MiniMax Coding Plan（国内 / 国际） | 5 小时、每周 |
| OpenCode Go | 5 小时、每周、每月 |
| DeepSeek（官方） | ¥ 账户余额 |
| OpenRouter | $ 剩余额度 |

不支持的供应商不显示该按钮；查询失败可在面板内重试。默认开启，可用 `quota.enabled: false` 关闭。暂不支持：火山方舟、ZenMux、智谱团队版、Claude / Codex / Gemini / Grok 官方订阅、GitHub Copilot。

## 安装

```sh
dsh plugin --profile web add @laoyuehanni/dsh-token-usage
```

> 包声明了 `dsh.bundle`，`add` 自动把插件挂进 profile，开箱即用；首次启动自动补齐安装前的历史记录。

## 更新

```sh
dsh plugin --profile web update @laoyuehanni/dsh-token-usage
```

## 移除

```sh
dsh plugin --profile web remove @laoyuehanni/dsh-token-usage
```

数据文件（`$DSH_HOME/token-usage/`）会保留，需要时手动删除。

## 开发

构建一次、装符号链接、迭代：

```sh
npm install
npm run build && npm run build:client
dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

重新构建并重启 `dsh web` 即生效（插件目录跑 `npx tsdown --watch` 可热重载客户端）。刻意不设 `prepare` 脚本——`lib/` 从不进仓库，`npm publish` 现场构建打进 tarball。

临时挂载（仅当次启动生效，不动 profile）：复制 `cordis.example.yml` 为 `cordis.yml`，把 `name` 改成你机器上 `lib/index.js` 的绝对 `file://` URL，然后 `dsh web --patch <插件目录>/cordis.yml`。此模式数据记录照常，开发 UI 请用上面的 `link:` 安装。
