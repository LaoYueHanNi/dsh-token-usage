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
		const css = ".kIC_0q_section{flex-direction:column;gap:16px;width:100%;display:flex}.kIC_0q_head{justify-content:space-between;align-items:center;gap:12px;display:flex}.kIC_0q_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600}.kIC_0q_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;font-weight:600}.kIC_0q_muted{color:var(--dsw-alias-label-dimmed);margin:0;font-size:12px}.kIC_0q_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}.kIC_0q_empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.kIC_0q_button{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px;line-height:20px}.kIC_0q_button:hover{background:var(--dsw-alias-interactive-bg-hover)}.kIC_0q_cards{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}.kIC_0q_card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}.kIC_0q_cardLabel{color:var(--dsw-alias-label-secondary);font-size:12px;display:block}.kIC_0q_cardValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}.kIC_0q_table{border-collapse:collapse;font-variant-numeric:tabular-nums;width:100%;font-size:13px}.kIC_0q_table th,.kIC_0q_table td{text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 8px}.kIC_0q_table th:first-child,.kIC_0q_table td:first-child{text-align:left}.kIC_0q_table th{color:var(--dsw-alias-label-secondary);font-weight:500}.kIC_0q_table td{color:var(--dsw-alias-label-primary)}.kIC_0q_recent{flex-direction:column;margin:0;padding:0;font-size:13px;list-style:none;display:flex}.kIC_0q_recentRow{border-bottom:1px solid var(--dsw-alias-border-l1);align-items:baseline;gap:12px;padding:6px 0;display:flex}.kIC_0q_recentTime{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}.kIC_0q_recentModel{color:var(--dsw-alias-label-primary);flex:none;font-weight:500}.kIC_0q_recentUsage{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}";
		const tagId = "dsh-token-usage/TokenUsageSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var TokenUsageSection_module_css_default = {
			"empty": "kIC_0q_empty",
			"subtitle": "kIC_0q_subtitle",
			"button": "kIC_0q_button",
			"title": "kIC_0q_title",
			"cardValue": "kIC_0q_cardValue",
			"recent": "kIC_0q_recent",
			"cards": "kIC_0q_cards",
			"error": "kIC_0q_error",
			"head": "kIC_0q_head",
			"section": "kIC_0q_section",
			"recentRow": "kIC_0q_recentRow",
			"recentUsage": "kIC_0q_recentUsage",
			"card": "kIC_0q_card",
			"cardLabel": "kIC_0q_cardLabel",
			"recentTime": "kIC_0q_recentTime",
			"muted": "kIC_0q_muted",
			"table": "kIC_0q_table",
			"recentModel": "kIC_0q_recentModel"
		};
		//#endregion
		//#region src/client/TokenUsageSection.tsx
		/**
		* Token-usage settings page (browser half): fetches the stats summary from
		* the host route and renders totals, per-day and per-model tables, and the
		* recent request list. Data arrives through plain fetch into component-local
		* state — the page owns no store because nothing outside it reads the
		* summary; a manual refresh re-fetches after new requests land.
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
		/** One card in the totals strip. */
		function StatCard({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["card"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TokenUsageSection_module_css_default["cardLabel"],
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TokenUsageSection_module_css_default["cardValue"],
					children: value.toLocaleString()
				})]
			});
		}
		/** One totals row of the per-day/per-model tables. */
		function TotalsRow({ name, totals }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: name }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: totals.requests.toLocaleString() }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: totals.inputTokens.toLocaleString() }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: totals.outputTokens.toLocaleString() }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: totals.cacheReadTokens.toLocaleString() }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: totals.cacheWriteTokens.toLocaleString() })
			] });
		}
		/** Human summary of one record's token buckets. */
		function usageText(record) {
			const usage = record.usage;
			if (usage === void 0) return "无用量数据";
			const parts = [`输入 ${usage.inputTokens.toLocaleString()}`, `输出 ${usage.outputTokens.toLocaleString()}`];
			if (usage.cacheReadTokens !== void 0) parts.push(`缓存读 ${usage.cacheReadTokens.toLocaleString()}`);
			if (usage.cacheWriteTokens !== void 0) parts.push(`缓存写 ${usage.cacheWriteTokens.toLocaleString()}`);
			return parts.join(" · ");
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
			const { summary } = state;
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
						children: ["数据目录：", summary.dataDir]
					}),
					summary.total.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: TokenUsageSection_module_css_default["empty"],
						children: "暂无记录。模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TokenUsageSection_module_css_default["cards"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: "请求数",
									value: summary.total.requests
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: "输入 tokens",
									value: summary.total.inputTokens
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: "输出 tokens",
									value: summary.total.outputTokens
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: "缓存读 tokens",
									value: summary.total.cacheReadTokens
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: "缓存写 tokens",
									value: summary.total.cacheWriteTokens
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: TokenUsageSection_module_css_default["subtitle"],
							children: "按日"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: TokenUsageSection_module_css_default["table"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "日期" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "请求" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "输入" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "输出" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "缓存读" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "缓存写" })
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: summary.byDay.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TotalsRow, {
								name: row.day,
								totals: row.totals
							}, row.day)) })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: TokenUsageSection_module_css_default["subtitle"],
							children: "按模型"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: TokenUsageSection_module_css_default["table"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "模型" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "请求" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "输入" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "输出" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "缓存读" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "缓存写" })
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: summary.byModel.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TotalsRow, {
								name: row.model,
								totals: row.totals
							}, row.model)) })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: TokenUsageSection_module_css_default["subtitle"],
							children: "最近请求"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: TokenUsageSection_module_css_default["recent"],
							children: summary.recent.map((record) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: TokenUsageSection_module_css_default["recentRow"],
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TokenUsageSection_module_css_default["recentTime"],
										children: new Date(record.time).toLocaleString()
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TokenUsageSection_module_css_default["recentModel"],
										children: record.model
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `${TokenUsageSection_module_css_default["recentUsage"]} ${TokenUsageSection_module_css_default["muted"]}`,
										children: usageText(record)
									})
								]
							}, record.requestId))
						})
					] })
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