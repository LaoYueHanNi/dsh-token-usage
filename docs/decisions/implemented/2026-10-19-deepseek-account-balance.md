# DR: DeepSeek 账号余额走账号服务

Status: implemented

## Problem

输入栏配额按钮只认 API Key 供应商。选中模型菜单里「DeepSeek 账号」分组（路由 `deepseek-account`）时按钮消失：这条路由用登录 grant，没有 API Key，也打不了官方 `GET /user/balance`。账号默认推理地址还是 `https://api.deepseek.com/anthropic`，host 落在 `api.deepseek.com` 上，若交给 API Key 余额适配器，只会报「未解析到密钥」。用户要的是同一颗按钮展示该账号的充值余额和赠金余额，与设置页「账号与余额」同一口径。

## Decision

`deepseek-account` 由独立适配器 `deepseek-account` 认领，且 `usesApiKey: false`。查询不发 HTTP，而是调用宿主已经注入的 `deepseekAccount.getBalance()`（插件用结构化类型读取，不依赖账号包）。宿主缺该服务、或 `getBalance` 返回 `null`（未登录或查询中途 grant 变了），载荷是 `signed-out`，按钮保持可见并提示登录。`status: 'failed'` 或读取抛错记为 `network`，面板重试会再次查询。

钱包映射：每个钱包只取一个币种，有 CNY 用 CNY，否则用第一条 USD。充值钱包始终展示（含 0 与透支）。赠金钱包仅在金额大于 0 时展示，与设置页隐藏零赠金一致。窗口带 `balanceKind: 'recharge' | 'bonus'`，面板文案分别是「充值余额」「赠金余额」。两列金额用 320px 面板。API Key 路由 `deepseek-official` 仍走 `GET /user/balance`，且即使 base URL 是 deepseek.com 也不认领 `deepseek-account`。

按钮仍跟模型芯片的实时 `provider`。账号模型的 provider 就是 `deepseek-account`，选中即出现，不必先发一条消息。

## Alternatives considered

- **复用 API Key 适配器，靠 host 命中 `api.deepseek.com`。** 账号没有 API Key，命中后只能报未配置密钥；余额端点也不是 `/user/balance`，而是平台 `get_user_summary`。host 命中会把账号路由从「不支持」变成「错误的密钥错误」。
- **插件自己带 token 请求平台。** grant 的刷新、请求头和 401 失效已经在 `deepseekAccount` 里。再实现一遍会和宿主的登出、过期删除抢同一条凭据。
- **把充值与赠金加总成一个数字。** 两笔钱用途不同，设置页分两行。加总会让用户对不上设置页的数字。
- **未登录时隐藏按钮。** 选中的就是账号模型，藏起来看起来像「这个模型没有用量」。保持按钮并写明要登录，和其它已支持供应商查询失败的行为一致。

## Consequences

- 代价：配额窗口多了 `balanceKind`，错误种类多了 `signed-out`。账号服务未挂上的宿主上，选中账号模型会看到登录提示而不是隐藏按钮。每个钱包只展示一个币种（优先 CNY）。
- 换来：选中 DeepSeek 账号模型时，输入栏按钮展示充值余额，有赠金时并列展示赠金余额，数据与设置页同一条 `getBalance`。
