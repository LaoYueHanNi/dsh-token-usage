# dsh-token-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

![Token Usage stats page](token-usage.png)

[简体中文](./README.zh.md) | English

A dsh usage plugin that displays model token usage right in the Web UI. After installation, open **Settings** (the gear icon in the sidebar) and you'll find the **Token Usage** page — summary cards, a daily total-token line chart and a per-model breakdown, all filterable by date range and model, exactly as shown in the screenshot above.

[dsh]: https://github.com/cordiverse/dsh

Repo: <https://github.com/LaoYueHanNi/dsh-token-usage>

## Features

- **Live hook**: every successful model request is appended to per-day JSONL files (request id, model, input / output / cache-read / cache-write tokens, time, session id).
- **Web stats page**: filters (date range + model + `1d`/`7d`/`30d` shortcuts), summary cards, daily trend chart, per-model table.
- **History backfill**: the first startup syncs requests that happened before installation; the `/token-usage-sync` command re-runs the same idempotent backfill anytime.

## Install

### From GitHub (recommended)

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
```

> The package declares `dsh.bundle`, so `add` wires the plugin into the profile's layer stack automatically — no config editing needed. The first startup runs one history backfill, afterwards it records in real time.

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
npm run build && npm run build:client   # or simply: npm run prepare
```

Temporary mount — effective for this launch only, no profile changes. `cordis.yml` points at the built `lib/index.js`:

```sh
dsh web --patch <plugin-dir>/cordis.yml
```

This mode only mounts the host half (data recording and commands work); the stats page needs the client bundle resolved by package name, so for UI development use the `link:` install above instead: run `npm run build && npm run build:client` (or `npx tsdown --watch` in the plugin directory), restart `dsh web`, and the browser plugin hot-reloads automatically.
