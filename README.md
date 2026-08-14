# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![Token Usage stats page](token-usage.png)

[简体中文](./README.zh.md) | English

A dsh usage plugin that displays model token usage right in the Web UI. After installation, open **Settings** (the gear icon in the sidebar) and you'll find the **Token Usage** page — summary cards (with cost), a daily total-token line chart, a per-model breakdown, and per-model pricing dialogs, all filterable by date range and model, exactly as shown in the screenshot above.

[dsh]: https://github.com/cordiverse/dsh

Repo: <https://github.com/LaoYueHanNi/dsh-token-usage>

## Features

- **Live hook**: every successful model request is appended to per-day JSONL files (request id, model, input / output / cache-read / cache-write tokens, time, session id).
- **Web stats page**: filters (date range + model + `1d`/`7d`/`30d` shortcuts), summary cards, daily trend chart (hover a day for its total), per-model table.
- **Cost figures & model pricing**: per-request cost is computed live from per-model rates (¥ per million tokens) — a highlighted total-cost card, a cost column in the per-model table, and a warning strip for unpriced models (their cost counts as ¥0). Every priced model's name carries a small **rates button** that opens a dialog with that model's full price table: **each row is one billing condition** (default rates, context tiers like `≥ 512K`, peak windows like `09:00-12:00`, grouped under time rules' date windows), with the in/out/cache/write rates as aligned columns — mirroring exactly what the per-record resolver bills. Rates merge from two files: `/token-usage-pricing-sync` mirrors the cloud model-price-table feed (the same source cc-switch-analyzer pulls), `pricing.json` holds manual overrides, and `/token-usage-pricing` prints the merged table.
- **History backfill**: the first startup syncs requests that happened before installation; the `/token-usage-sync` command re-runs the same idempotent backfill anytime.

## Model pricing

![Model pricing dialog](model-price.png)

**Every record is priced individually**: each one resolves through the analyzer's rule chain at its own timestamp — the covering time rule first (its context tiers, its peak slots), else the model root's tiers → peak slots → base rates. Tier matching approximates the context size by the request's input-side tokens (input + cacheRead + cacheWrite). A price update re-prices the whole history instantly, with no data rebuild. Rates come from two files merged on read — `pricing.json` entries always win (a manual entry replaces that model's cloud rules wholesale):

| File | Source | Notes |
|---|---|---|
| `pricing.ccsa.json` | startup auto-fetch + the `/token-usage-pricing-sync` command | Verbatim mirror of the cloud model-price-table feed (the analyzer's source); refreshed on every dsh restart, falling back to the previous mirror on failure |
| `pricing.json` | hand-edited | Overrides synced rates or adds missing models; manual tweaks survive re-syncs |

```sh
# Inspect / manually refresh the merged, active table (startup also auto-fetches the cloud mirror once)
/token-usage-pricing-sync
/token-usage-pricing
```

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

A broken file or invalid entries leave the affected models unpriced without breaking the stats page; save and refresh (or re-run the command) to apply changes. Default location: `~/.dsh/token-usage/` (wherever `path` points when configured).

## Install

### From GitHub (recommended)

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
```

> The package declares `dsh.bundle`, so `add` wires the plugin into the profile's layer stack automatically — no config editing needed. The built `lib/` ships in the repo (there is no `prepare` script), so git installs work out of the box without any build allowlist. The first startup runs one history backfill, afterwards it records in real time.

### From a local directory (development)

```sh
dsh plugin --profile web add link:D:/plugins/dsh-token-usage
```

`link:` installs a symlink: rebuild the plugin and restart `dsh web` to apply changes.

## Update

```sh
dsh plugin --profile web update dsh-token-usage
```

## Remove

```sh
dsh plugin --profile web remove dsh-token-usage
```

The plugin is removed from the profile and stops loading. Data files under `$DSH_HOME/token-usage/` are kept — delete them manually if you no longer need them.

## Development

Build the plugin once:

```sh
npm install
npm run build && npm run build:client
```

> **No `prepare` script — by design.** The compiled `lib/` output is committed to the repo. pnpm ≥ 10 refuses to run build scripts of git-hosted dependencies unless they are allowlisted (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), so a `prepare` script would break the zero-config `github:` install for every user. Shipping prebuilt output instead keeps `dsh plugin add github:LaoYueHanNi/dsh-token-usage` working out of the box. **After changing anything under `src/`, always rebuild and commit the updated `lib/`**, or installs will get stale output:

```sh
npm run build && npm run build:client
git add lib/
```

Temporary mount — effective for this launch only, no profile changes. `cordis.yml` points at the built `lib/index.js`:

```sh
dsh web --patch <plugin-dir>/cordis.yml
```

This mode only mounts the host half (data recording and commands work); the stats page needs the client bundle resolved by package name, so for UI development use the `link:` install above instead: run `npm run build && npm run build:client` (or `npx tsdown --watch` in the plugin directory), restart `dsh web`, and the browser plugin hot-reloads automatically.
