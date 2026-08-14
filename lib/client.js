window.__ModuleLoader__.load({
	id: "dsh-token-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/wire.ts
		/** The stats endpoint path, served by the host half's webServer route. */
		const STATS_PATH = "/token-usage/stats";
		//#endregion
		//#region \0dsh-css:E:\Documents\MyCode\oyw-dsh-plugin\dsh-token-usage\src\client\TokenUsageSection.module.css.mjs
		const css = ".kIC_0q_section{flex-direction:column;gap:16px;width:100%;display:flex}.kIC_0q_head{justify-content:space-between;align-items:center;gap:12px;display:flex}.kIC_0q_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600}.kIC_0q_muted{color:var(--dsw-alias-label-dimmed);margin:0;font-size:12px}.kIC_0q_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}.kIC_0q_empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.kIC_0q_button{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px;line-height:20px}.kIC_0q_button:hover{background:var(--dsw-alias-interactive-bg-hover)}.kIC_0q_cards{grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;display:grid}.kIC_0q_card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}.kIC_0q_cardLabel{color:var(--dsw-alias-label-secondary);font-size:12px;display:block}.kIC_0q_cardValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}";
		const tagId = "dsh-token-usage/TokenUsageSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var TokenUsageSection_module_css_default = {
			"title": "kIC_0q_title",
			"section": "kIC_0q_section",
			"cards": "kIC_0q_cards",
			"cardValue": "kIC_0q_cardValue",
			"card": "kIC_0q_card",
			"error": "kIC_0q_error",
			"cardLabel": "kIC_0q_cardLabel",
			"button": "kIC_0q_button",
			"empty": "kIC_0q_empty",
			"head": "kIC_0q_head",
			"muted": "kIC_0q_muted"
		};
		//#endregion
		//#region src/client/TokenUsageSection.tsx
		/**
		* Token-usage settings page (browser half): fetches the stats summary from
		* the host route and renders the total-usage strip — requests / total tokens
		* / cache hit rate on one row, the four token buckets on the next. Token
		* counts are abbreviated (K below 1M, M below 亿, B at 亿+); the page owns no
		* store because nothing outside it reads the summary, and a manual refresh
		* re-fetches after new requests land.
		*
		* @module token-usage/client/TokenUsageSection
		*/
		/** Fetch the summary; the caller owns the failure presentation. */
		async function fetchSummary() {
			const response = await fetch(STATS_PATH);
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			const value = await response.json();
			if (typeof value !== "object" || value === null || typeof value.total !== "object") throw new Error("unexpected stats response");
			return value;
		}
		/**
		* Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 1 亿
		* (1e8), `xxB` from 1 亿 up with B = 10 亿 (1e9) — 1 亿 is `0.1B`, 3 亿 is
		* `0.3B`, 10 亿 is `1B`, 30 亿 is `3B`. One decimal while the scaled value is
		* below 10, integer otherwise — `950K`, `1.5M`, `50M`, `0.5B`, `3B`.
		* @param count - a non-negative token count.
		* @returns the compact display string.
		*/
		function formatTokens(count) {
			if (count < 1e3) return String(count);
			if (count < 1e6) return scale(count / 1e3) + "K";
			if (count < 1e8) return scale(count / 1e6) + "M";
			return scale(count / 1e9) + "B";
		}
		/** One decimal below 10, integer otherwise, trailing `.0` stripped. */
		function scale(value) {
			if (value >= 10) return String(Math.round(value));
			const oneDecimal = value.toFixed(1);
			return oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal;
		}
		/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
		function totalTokens(totals) {
			return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
		}
		/**
		* Cache hit rate as display text: cache reads over served input
		* (missed input + cache reads). `—` when nothing was served.
		* @param totals - the aggregated totals.
		* @returns e.g. `87.5%`, or `—` for an empty denominator.
		*/
		function formatHitRate(totals) {
			const served = totals.inputTokens + totals.cacheReadTokens;
			if (served === 0) return "—";
			return `${scale(totals.cacheReadTokens / served * 100)}%`;
		}
		/** One card in a metric row. */
		function StatCard({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["card"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TokenUsageSection_module_css_default["cardLabel"],
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TokenUsageSection_module_css_default["cardValue"],
					children: value
				})]
			});
		}
		/**
		* Render the Token 用量 section content column.
		* @param props - the settings shell's owner share (close is unused: the nav
		* rail owns leaving the panel).
		* @returns the section, one of loading / error / ready.
		*/
		function TokenUsageSection(_props) {
			const [state, setState] = (0, react.useState)({ status: "loading" });
			const [attempt, setAttempt] = (0, react.useState)(0);
			const refresh = (0, react.useCallback)(() => {
				setAttempt((previous) => previous + 1);
			}, []);
			(0, react.useEffect)(() => {
				let cancelled = false;
				setState({ status: "loading" });
				fetchSummary().then((summary) => {
					if (!cancelled) setState({
						status: "ready",
						summary
					});
				}).catch((error) => {
					if (!cancelled) setState({
						status: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				});
				return () => {
					cancelled = true;
				};
			}, [attempt]);
			if (state.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["section"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					className: TokenUsageSection_module_css_default["title"],
					children: "Token 用量"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: TokenUsageSection_module_css_default["muted"],
					children: "加载中…"
				})]
			});
			if (state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["section"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TokenUsageSection_module_css_default["head"],
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: TokenUsageSection_module_css_default["title"],
						children: "Token 用量"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: TokenUsageSection_module_css_default["button"],
						onClick: refresh,
						children: "重试"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: TokenUsageSection_module_css_default["error"],
					children: ["统计加载失败：", state.message]
				})]
			});
			const { total } = state.summary;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["section"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TokenUsageSection_module_css_default["head"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: TokenUsageSection_module_css_default["title"],
							children: "Token 用量"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: TokenUsageSection_module_css_default["button"],
							onClick: refresh,
							children: "刷新"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: TokenUsageSection_module_css_default["muted"],
						children: ["数据目录：", state.summary.dataDir]
					}),
					total.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: TokenUsageSection_module_css_default["empty"],
						children: "暂无记录。模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TokenUsageSection_module_css_default["cards"],
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "请求数",
								value: total.requests.toLocaleString()
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "总 token",
								value: formatTokens(totalTokens(total))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "缓存命中率",
								value: formatHitRate(total)
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: TokenUsageSection_module_css_default["cards"],
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "输入",
								value: formatTokens(total.inputTokens)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "输出",
								value: formatTokens(total.outputTokens)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "缓存读",
								value: formatTokens(total.cacheReadTokens)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
								label: "缓存写",
								value: formatTokens(total.cacheWriteTokens)
							})
						]
					})] })
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot registry (declared by the client runtime). */
		const inject = ["slots"];
		/**
		* Register the settings section once the shell's `settings.section`
		* declaration is on the ledger.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "token-usage",
				order: 50,
				label: "Token 用量"
			}, TokenUsageSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map