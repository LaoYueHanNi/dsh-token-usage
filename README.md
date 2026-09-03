# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![Token Usage stats page](docs/images/token-usage.png)

[简体中文](./README.zh.md) | English

A dsh usage plugin that displays model token usage right in the Web UI. After installation, open **Settings** (the gear icon in the sidebar) and you'll find the **Token Usage** page — summary cards (with cost), a daily total-token line chart, a per-model breakdown, and per-model pricing dialogs, all filterable by date range and model, exactly as shown in the screenshot above.

[dsh]: https://github.com/cordiverse/dsh

Repo: <https://github.com/LaoYueHanNi/dsh-token-usage>

> [!IMPORTANT]
> **GitHub direct installs have ended** — the repository no longer carries prebuilt output. Install from npm instead:
>
> ```sh
> dsh plugin --profile web add @laoyuehanni/dsh-token-usage
> ```
>
> **Upgrading from a legacy `github:` install (≤ 0.3.7, package name `dsh-token-usage`)?** An in-place `update` fails to load — remove the old name first, then add again. Usage data under `$DSH_HOME/token-usage/` carries over untouched.

## Features

- **Live recording**: every provider-billed model call is recorded as it happens — tokens, cost, model, session — context-compaction calls included.
- **Web stats page**: filters (date range + model + `1d`/`7d`/`30d` shortcuts), summary cards, daily trend chart (hover a day for its total), per-model table.
- **Session usage tab**: the conversation pane gains a **Usage** view tab (beside Chat / Trajectory) with the active session's dashboard — six stat cards (successful requests with a failure pill, cost, cache hit rate, average time-to-first-token, generation throughput, total tokens), a 4-bucket token strip, an hourly trend chart, and a per-model table. A scope switch toggles **Session / With subagents**, and the subagent table drills into each child and back. Hovering the failure pill breaks failures down per class (rate limited, server error, context exceeded, …).

![Session Usage tab](docs/images/usage-tab.png)

- **Cost figures & model pricing**: per-request cost is computed live from per-model rates (¥ per million tokens); unpriced models warn and count as ¥0. Every priced model's name carries a **rates button** opening its full price table. Rates sync from the cloud feed on every startup; `pricing.json` holds manual overrides — see [Model pricing](#model-pricing).
- **Provider quota**: an input-bar button (left of the model chip) shows the selected provider's remaining quota. See [Provider quota](#provider-quota).
- **History backfill**: the first startup syncs requests that happened before installation (idempotent); unreadable session logs are skipped and counted, never fatal to the sync.

## Model pricing

Costs are billed per record at its own timestamp, and a rates update re-prices the whole history instantly. Rates come from two files merged on read — a cloud mirror auto-synced on every startup, and a hand-edited `pricing.json` whose entries always win (per model, wholesale):

```json
{
  "deepseek-chat": { "inputPerMillion": 2, "outputPerMillion": 8, "cacheReadPerMillion": 0.5 }
}
```

Broken files degrade the affected models to unpriced without breaking the stats page. Default location: `~/.dsh/token-usage/`. Billing rule chain, cloud feed format, and self-hosted mirror URLs: [docs/pricing.md](./docs/pricing.md).

## Configuration

### Data directory

Editable on the web card (**Settings → Plugins → Token Usage**): saving an absolute path takes effect immediately — history migrates automatically, no restart, no manual move. Blank keeps the default `~/.dsh/token-usage/`. A save is refused while a conversation is in progress; wait for it to end, then save again. Or set it directly:

```yml
plugins:
  token-usage:
    path: D:/data/token-usage   # default: ~/.dsh/token-usage/
```

### Pricing region

The pricing mirror follows your region: **Gitee** by default (fast inside mainland China) or the **GitHub mirror** of the same table — pick once on the web card's **Pricing region** dropdown or via config. The pick also drives the display currency (¥ RMB vs $ USD at the table's exchange rate).

```yml
plugins:
  token-usage:
    pricingRegion: overseas   # default: domestic
```

## Provider quota

The input-bar button follows the currently selected provider and opens a panel with remaining quota (the same API key as inference):

<img src="docs/images/zhipu-plan-usage.png" width="520" alt="Zhipu GLM quota panel">

<img src="docs/images/opencode-go-plan-usage.png" width="520" alt="OpenCode Go quota panel">

| Provider | Shows |
|---|---|
| Zhipu GLM Coding Plan (CN / international) | 5-hour, weekly (some plans also monthly) |
| Kimi For Coding | 5-hour, weekly |
| MiniMax Coding Plan (CN / international) | 5-hour, weekly |
| OpenCode Go | 5-hour, weekly, monthly |
| DeepSeek (official) | ¥ account balance |
| OpenRouter | $ remaining credits |

Unsupported providers hide the button; a failed query can be retried from the panel. On by default; turn it off with `quota.enabled: false`. Not supported yet: Volcengine, ZenMux, Zhipu Team plan, Claude / Codex / Gemini / Grok official subscriptions, GitHub Copilot.

## Install

```sh
dsh plugin --profile web add @laoyuehanni/dsh-token-usage
```

> The package declares `dsh.bundle`, so `add` wires the plugin into the profile automatically — installs work out of the box, and the first startup backfills pre-install history.

## Update

```sh
dsh plugin --profile web update @laoyuehanni/dsh-token-usage
```

## Remove

```sh
dsh plugin --profile web remove @laoyuehanni/dsh-token-usage
```

Data files under `$DSH_HOME/token-usage/` are kept — delete them manually if you no longer need them.

## Development

Build once, install a symlink, iterate:

```sh
npm install
npm run build && npm run build:client
dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

Rebuild and restart `dsh web` to apply changes (`npx tsdown --watch` in the plugin directory hot-reloads the client). No `prepare` script by design — `lib/` never enters the repo; `npm publish` builds it fresh into the tarball.

Temporary host-only mount (this launch only, no profile changes): copy `cordis.example.yml` to `cordis.yml`, point `name` at the absolute `file://` URL of your `lib/index.js`, then `dsh web --patch <plugin-dir>/cordis.yml`. Data recording works in this mode; for UI work use the `link:` install above.
