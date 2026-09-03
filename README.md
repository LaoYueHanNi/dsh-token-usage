# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![Token Usage stats page](docs/images/token-usage.png)

[简体中文](./README.zh.md) | English

A dsh usage plugin that displays model token usage right in the Web UI. After installation, open **Settings** (the gear icon in the sidebar) and you'll find the **Token Usage** page — summary cards (with cost), a daily total-token line chart, a per-model breakdown, and per-model pricing dialogs, all filterable by date range and model, exactly as shown in the screenshot above.

[dsh]: https://github.com/cordiverse/dsh

Repo: <https://github.com/LaoYueHanNi/dsh-token-usage>

> [!IMPORTANT]
> **Upgrading from a GitHub install of 0.3.7 or earlier?** Since 0.3.8 the plugin is distributed on npm as `@laoyuehanni/dsh-token-usage` (the unscoped name was already taken on the registry). A legacy `github:` install **cannot be upgraded with `update`** — the package was renamed, and an in-place update leaves the plugin failing to load. From 0.3.8 on, remove the old package name first, then install again:
>
> ```sh
> dsh plugin --profile web remove dsh-token-usage
> dsh plugin --profile web add @laoyuehanni/dsh-token-usage
> ```
>
> Usage data under `$DSH_HOME/token-usage/` is untouched by the migration — recorded history carries over.
>
> **GitHub direct installs have ended.** The repository no longer carries prebuilt `lib/` output: dsh installs git-hosted plugins through pnpm, which blocks build-on-install, so a fresh `github:` spec has no artifacts to load. Install from npm instead — the package name is unchanged, so re-running the `add` command above switches a legacy `github:` install over to the registry.

## Features

- **Live hook**: every provider-billed call is appended to per-day JSONL files (request id, model, input / output / cache-read / cache-write tokens, time, session id).
- **Web stats page**: filters (date range + model + `1d`/`7d`/`30d` shortcuts), summary cards, daily trend chart (hover a day for its total), per-model table.
- **Session usage view tab**: the conversation pane gains a **Usage** view tab (beside Chat / Trajectory) showing the active session's token & cost dashboard — six stat cards (successful requests with a failure-count pill, cost, cache hit rate, average time-to-first-token, generation throughput, total tokens), a 4-bucket token strip, an hourly trend chart, and a per-model table. A **Session / With subagents** scope switch aggregates the whole subagent subtree in one request, and the subagent table lists each child (requests, total tokens, cost, hit rate, TTFT, throughput) with drill-in navigation back to the parent. Token/cost figures come from the plugin's own billing chain (post-install records); TTFT and throughput come from DSH's `sessionStats` session projection (covers pre-install history). Sessions without records degrade to a placeholder, never an error. Failed requests are counted per provider attempt: a `turn/end` that ended in an LLM error (aborted / truncated turns do not count) plus each `llm/retry` scheduled after a failed attempt that the retry plugin then tried again. Failed calls bill no tokens, so the figure is a count, never an amount. Hovering the failure pill on the requests card breaks the count down per failure class (rate limited, server error, context exceeded, …).

![Session Usage tab](docs/images/usage-tab.png)

- **Cost figures & model pricing**: per-request cost is computed live from per-model rates (¥ per million tokens) — a highlighted total-cost card, a cost column in the per-model table, and a warning strip for unpriced models (their cost counts as ¥0). Every priced model's name carries a small **rates button** that opens a dialog with that model's full price table: **each row is one billing condition** (default rates, context tiers like `≥ 512K`, peak windows like `09:00-12:00`, grouped under time rules' date windows), with the in/out/cache/write rates as aligned columns — mirroring exactly what the per-record resolver bills. Rates merge from two files: every startup mirrors the cloud model-price-table feed (the same source cc-switch-analyzer pulls) automatically, and `pricing.json` holds manual overrides.
- **Provider quota**: an input-bar button (left of the model chip) shows the selected provider's remaining quota. Coding plans (Zhipu GLM / Kimi / MiniMax / OpenCode Go) get time-window progress; DeepSeek / OpenRouter get the account balance. See [Provider quota](#provider-quota).
- **History backfill**: the first startup syncs requests that happened before installation (idempotent).

## Model pricing

![Model pricing dialog](docs/images/model-price.png)

**Every record is priced individually**: each one resolves through the analyzer's rule chain at its own timestamp — the covering time rule first (its context tiers, its peak slots), else the model root's tiers → peak slots → base rates. A peak slot may restrict itself to ISO weekdays via `daysOfWeek` (`1`=Monday … `7`=Sunday; omitted = every day), matched on the request's local day — e.g. DeepSeek V4 models bill weekend peak windows at the off-peak rates. Tier matching approximates the context size by the request's input-side tokens (input + cacheRead + cacheWrite). A price update re-prices the whole history instantly, with no data rebuild. Rates come from two files merged on read — `pricing.json` entries always win (a manual entry replaces that model's cloud rules wholesale):

| File | Source | Notes |
|---|---|---|
| `pricing.ccsa.json` | startup auto-fetch | Verbatim mirror of the cloud model-price-table feed (the analyzer's source); refreshed on every dsh restart, falling back to the previous mirror on failure |
| `pricing.json` | hand-edited | Overrides synced rates or adds missing models; manual tweaks survive re-syncs |

Cloud feed shape (`currency` must be `RMB`; both `modelId` and every alias become matchable keys; `timeRules` / `contextTiers` / `dailySlots` all take part in billing):

```json
{
  "version": 4,
  "updatedAt": 0,
  "currency": "RMB",
  "models": [
    { "modelId": "deepseek-chat", "inputCostPerMillion": 2, "outputCostPerMillion": 8,
      "cacheReadCostPerMillion": 0.5, "cacheCreationCostPerMillion": 1, "aliases": ["deepseek-v3"] }
  ]
}
```

Flat `pricing.json` shape (keys are model ids matching the recorded `model` exactly; `inputPerMillion` and `outputPerMillion` required, `cacheReadPerMillion` / `cacheWritePerMillion` optional and falling back to the input rate):

```json
{
  "deepseek-chat": { "inputPerMillion": 2, "outputPerMillion": 8, "cacheReadPerMillion": 0.5 }
}
```

A broken file or invalid entries leave the affected models unpriced without breaking the stats page; save and refresh the page to apply changes. Default location: `~/.dsh/token-usage/` (wherever `path` points when configured).

### Changing the data directory

The data directory is editable from the web settings: on **Settings → Plugins**, inside the collapsed **Token Usage** card, the **Data directory** input leaves the location at its default (`~/.dsh/token-usage/`) when blank; saving an absolute path **takes effect immediately** — the historical data migrates into the new directory (verbatim file copy, then the switch and the source cleanup) with no restart and no manual data move.

The **Browse…** button next to the input opens the directory picker — the dsh framework's own directory-picking capability (the same chooser the workspace flows use, driven through `ctx.workspaces.pickDirectory()`): a native OS dialog on a local desktop, switching to an in-app browser for remote or headless clients. A picked path only stages the draft — you still press save to commit it.

The migration is a two-phase commit (copy everything → flip the running directory → clean the source): at any failure point the data exists in both places or only in the source — never only in the target. **A directory change cannot be saved while a conversation is in progress** — events only append while a turn is open, so only an actively conversing session counts and an idle open tab never blocks a save — the card pre-checks through the `/token-usage/dir-guard` route before anything writes (the verdict is whether a conversation is still interacting), refusing the save up front and naming the in-progress conversation count on the failure line; nothing persists. Wait for the conversation to end, then save again and the move proceeds. The stats cache `rollup.json` is derived state: it does not travel, and the first stats read after the switch rebuilds it. The directory can also be set directly:

```yml
# in the plugin's profile config
plugins:
  token-usage:
    path: D:/data/token-usage   # default: ~/.dsh/token-usage/
```

### Choosing the pricing mirror

The startup sync pulls from **Gitee** by default (fast inside mainland China). Installations outside mainland China can point the sync at the **GitHub mirror** of the same table — either from the web settings (the **Pricing region** dropdown in the same **Token Usage** card, editable live) or with a single config line. No IP sniffing: you just pick once.

```yml
# in the plugin's profile config
plugins:
  token-usage:
    pricingRegion: overseas   # default: domestic
```

The web card exposes the data directory and the region switch; the full key set (all optional):

| Key | Default | Meaning |
|---|---|---|
| `path` | `~/.dsh/token-usage/` | Data directory (editable on the web card; saving migrates) |
| `pricingUrl` | — | Explicit single feed (cordis.yml only); wins over every other key below |
| `pricingUrlDomestic` | gitee feed | Domestic mirror override (cordis.yml only; for self-maintained forks) |
| `pricingUrlOverseas` | github mirror | Overseas mirror override (cordis.yml only; for self-maintained forks) |
| `pricingRegion` | `domestic` | `domestic` → Gitee, `overseas` → GitHub (when `pricingUrl` is unset) |

A saved region change re-syncs the mirror immediately; there is no automatic failover — the chosen mirror fails, the previous mirror stays until a later sync succeeds.

**Region drives the display currency.** The region pick also decides how the stats page shows money: *Default / CN (Gitee)* keeps costs in RMB (`¥` + the table's own numbers); *Global (GitHub)* shows them in USD (`$` + `RMB ÷ rate`). The rate comes from the `usdExchangeRate` field at the very top of the pricing table (RMB per 1 USD; currently `7`), and falls back to a built-in `7` when the mirror does not carry it yet. Every money display follows along: the total-cost card, the per-model cost column, the unpriced warning, and the in/out/cache/write rates in the pricing dialog (whose USD view annotates the conversion rate under the table). Amounts on the wire always stay RMB — conversion happens only at render time, so switching regions never rebuilds any stats.

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

Unsupported providers hide the button. A failed query can be retried from the panel. On by default; set `quota.enabled: false` to turn it off.

Not supported yet: Volcengine, ZenMux, Zhipu Team plan, Claude / Codex / Gemini / Grok official subscriptions, GitHub Copilot.

## Install

### From npm

```sh
dsh plugin --profile web add @laoyuehanni/dsh-token-usage
```

> The package declares `dsh.bundle`, so `add` wires the plugin into the profile's layer stack automatically — no config editing needed. The compiled `lib/` ships in the npm tarball, so installs work out of the box without any build step. The first startup runs one history backfill, afterwards it records in real time.

### From a local directory (development)

```sh
dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

`link:` installs a symlink: rebuild the plugin and restart `dsh web` to apply changes.

## Update

```sh
dsh plugin --profile web update @laoyuehanni/dsh-token-usage
```

## Remove

```sh
dsh plugin --profile web remove @laoyuehanni/dsh-token-usage
```

The plugin is removed from the profile and stops loading. Data files under `$DSH_HOME/token-usage/` are kept — delete them manually if you no longer need them.

## Development

Build the plugin once:

```sh
npm install
npm run build && npm run build:client
```

> **No `prepare` script — by design.** The compiled `lib/` output is committed to the repo and ships in the npm tarball. pnpm ≥ 10 refuses to run dependency build scripts unless they are allowlisted, so a `prepare` script would surface as a skipped or failed install step for pnpm users. Shipping prebuilt output instead keeps `dsh plugin add @laoyuehanni/dsh-token-usage` working out of the box. **After changing anything under `src/`, always rebuild and commit the updated `lib/`** (and release a new version), or installs will get stale output:

```sh
npm run build && npm run build:client
git add lib/
```

Temporary mount — effective for this launch only, no profile changes. `cordis.yml` points at the built `lib/index.js`. That file is machine-local (it embeds the absolute path of YOUR checkout) and not tracked by git: copy it from the template first and edit `name` to the absolute `file://` URL of `lib/index.js` on your machine:

```sh
cp cordis.example.yml cordis.yml   # then edit the name path inside
dsh web --patch <plugin-dir>/cordis.yml
```

This mode only mounts the host half (data recording keeps working); the stats page needs the client bundle resolved by package name, so for UI development use the `link:` install above instead: run `npm run build && npm run build:client` (or `npx tsdown --watch` in the plugin directory), restart `dsh web`, and the browser plugin hot-reloads automatically.
