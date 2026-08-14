# dsh-token-usage

![Token 用量统计页](token-usage.png)

简体中文 | [English](./README.md)

一个 [dsh] 用量插件：在 Web 界面直接展示模型 token 用量。安装后打开**设置**（侧栏底部齿轮），即可看到「Token 用量」页 —— 汇总卡片、按日总 token 折线图、按模型明细表，支持按日期区间和模型筛选，效果见上图。

[dsh]: https://github.com/cordiverse/dsh

仓库：<https://github.com/LaoYueHanNi/dsh-token-usage>

## 功能

- **实时记录**：每次成功的模型请求追加一行到按天分片的 JSONL 文件（请求 id、模型、输入 / 输出 / 缓存读 / 缓存写 token、时间、会话 id）。
- **Web 统计页**：过滤条（日期区间 + 模型下拉 + `1d`/`7d`/`30d` 快捷区间）、汇总卡片、按日趋势图、按模型明细表。
- **历史补齐**：首次启动自动同步安装前已发生的请求；`/token-usage-sync` 命令可随时手动补写（幂等）。

## 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
```

> 包声明了 `dsh.bundle`，`add` 会自动把插件挂进 profile 的层栈，无需手动改配置。首次启动自动补齐一次历史记录，之后纯实时记录。

### 从本地目录安装（开发调试用）

```sh
dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

`link:` 安装的是符号链接：重新构建插件后重启 `dsh web` 即可生效。

## 更新

```sh
dsh plugin --profile web update dsh-token-usage
```

## 移除

```sh
dsh plugin --profile web remove dsh-token-usage
```

插件会从 profile 移除并停止加载。数据文件（`$DSH_HOME/token-usage/`）会保留，需要时手动删除。

## 开发

先构建一次插件：

```sh
npm install
npm run build && npm run build:client   # 或直接 npm run prepare
```

临时挂载 —— 仅当次启动生效，不动 profile，`cordis.yml` 指向构建产物 `lib/index.js`：

```sh
dsh web --patch <插件目录>/cordis.yml
```

此模式只挂载 host 半边（数据记录与命令照常工作）；统计页依赖按包名解析的客户端 bundle，因此开发 UI 请用上面的 `link:` 安装方式：执行 `npm run build && npm run build:client`（或在插件目录跑 `npx tsdown --watch`）并重启 `dsh web` 后，浏览器端插件会自动热重载。
