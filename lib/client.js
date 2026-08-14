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
		//#region src/client/day.ts
		/** Total tokens across the four buckets (billed input = input + cacheRead + cacheWrite). */
		function totalTokens(totals) {
			return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
		}
		/** Local `YYYY-MM-DD` key of a date, matching the host's day-file convention. */
		function dayKeyOf(date) {
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return `${date.getFullYear()}-${month}-${day}`;
		}
		/** Local day key of today shifted by whole days (test seam on `now`). */
		function shiftedDayKey(deltaDays, now = () => /* @__PURE__ */ new Date()) {
			const date = now();
			date.setDate(date.getDate() + deltaDays);
			return dayKeyOf(date);
		}
		/**
		* The zero-filled daily token series over a day range: every calendar day of
		* the range appears once (days without records plot as zero). Absent bounds
		* fall back to the first/last row day; no rows and no range yield [].
		* @param rows - the (already filtered) per-day rows.
		* @param from - first day key, inclusive.
		* @param to - last day key, inclusive.
		*/
		function daySeries(rows, from, to) {
			const first = from ?? rows[0]?.day;
			const last = to ?? (rows.length > 0 ? rows[rows.length - 1].day : void 0);
			if (first === void 0 || last === void 0 || first > last) return [];
			const tokens = new Map(rows.map((row) => [row.day, totalTokens(row.totals)]));
			const points = [];
			const cursor = /* @__PURE__ */ new Date(`${first}T00:00:00`);
			const end = /* @__PURE__ */ new Date(`${last}T00:00:00`);
			while (cursor <= end) {
				const day = dayKeyOf(cursor);
				points.push({
					day,
					tokens: tokens.get(day) ?? 0
				});
				cursor.setDate(cursor.getDate() + 1);
			}
			return points;
		}
		//#endregion
		//#region src/client/format.ts
		/** One decimal below 10, integer otherwise, trailing `.0` stripped. */
		function scale(value) {
			if (value >= 10) return String(Math.round(value));
			const oneDecimal = value.toFixed(1);
			return oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal;
		}
		/**
		* Abbreviate a token count: raw below 1K, `xxK` below 1M, `xxM` below 10 亿
		* (1e9) — 1 亿 is `100M`, 2.5 亿 is `250M`, 9.5 亿 is `950M` — and `xxB`
		* only from 10 亿 up (B = 10 亿, no fractional-B tier): `1B`, `1.5B`, `3B`.
		* One decimal while the scaled value is below 10, integer otherwise —
		* `950K`, `1.5M`, `950M`, `3B`.
		* @param count - a non-negative token count.
		* @returns the compact display string.
		*/
		function formatTokens(count) {
			if (count < 1e3) return String(count);
			if (count < 1e6) return scale(count / 1e3) + "K";
			if (count < 1e9) return scale(count / 1e6) + "M";
			return scale(count / 1e9) + "B";
		}
		/** Always one decimal (stripped when `.0`), unlike {@link scale}: percentages keep their precision. */
		function percent(value) {
			const oneDecimal = value.toFixed(1);
			return oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal;
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
			return `${percent(totals.cacheReadTokens / served * 100)}%`;
		}
		//#endregion
		//#region \0dsh-css:E:\Documents\MyCode\oyw-dsh-plugin\dsh-token-usage\src\client\TrendChart.module.css.mjs
		const css$1 = "._0PXeGq_chart{width:100%;height:auto;display:block}._0PXeGq_axis{stroke:var(--dsw-alias-border-l2);stroke-width:1px}._0PXeGq_grid{stroke:var(--dsw-alias-border-l2);stroke-width:1px;stroke-dasharray:3 3}._0PXeGq_line{fill:none;stroke:var(--dsw-alias-label-primary);stroke-width:2px;stroke-linejoin:round;stroke-linecap:round}._0PXeGq_dot{fill:var(--dsw-alias-label-primary)}._0PXeGq_tick{fill:var(--dsw-alias-label-secondary);font-size:11px}._0PXeGq_empty{text-align:center;color:var(--dsw-alias-label-secondary);margin:0;padding:24px 0;font-size:13px}";
		const tagId$1 = "dsh-token-usage/TrendChart.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var TrendChart_module_css_default = {
			"line": "_0PXeGq_line",
			"tick": "_0PXeGq_tick",
			"empty": "_0PXeGq_empty",
			"dot": "_0PXeGq_dot",
			"chart": "_0PXeGq_chart",
			"grid": "_0PXeGq_grid",
			"axis": "_0PXeGq_axis"
		};
		//#endregion
		//#region src/client/TrendChart.tsx
		/** SVG canvas metrics; the element scales to the section width via viewBox. */
		const WIDTH = 800;
		const HEIGHT = 190;
		const LEFT = 44;
		/** X-axis label positions: first, middle, and last day for long ranges. */
		function labelIndices(length) {
			if (length <= 3) return Array.from({ length }, (_, index) => index);
			const middle = Math.floor((length - 1) / 2);
			return [.../* @__PURE__ */ new Set([
				0,
				middle,
				length - 1
			])];
		}
		/** The roundest step from 1/2/2.5/5 × 10ⁿ not below the rough target. */
		function niceStep(rough) {
			const base = 10 ** Math.floor(Math.log10(rough));
			const fraction = rough / base;
			return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * base;
		}
		/** The y-axis tick values from one step up to the chart top (inclusive). */
		function tickValues(max) {
			if (max === 0) return {
				top: 1,
				ticks: []
			};
			const step = niceStep(max / 4);
			const top = Math.ceil(max / step) * step;
			const ticks = [];
			for (let value = step; value < top; value += step) ticks.push(value);
			ticks.push(top);
			return {
				top,
				ticks
			};
		}
		/**
		* Render the daily token line chart.
		* @param props - the filtered per-day rows plus the active range bounds
		* (absent when unfiltered; the chart then spans first to last row).
		* @returns the SVG chart, or a placeholder for an empty range.
		*/
		function TrendChart({ rows, from, to }) {
			const points = daySeries(rows, from, to);
			if (points.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: TrendChart_module_css_default.empty,
				children: "区间内暂无数据"
			});
			const { top, ticks } = tickValues(Math.max(...points.map((point) => point.tokens)));
			const innerWidth = 740;
			const innerHeight = 140;
			const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
			const x = (index) => LEFT + (points.length > 1 ? index * step : innerWidth / 2);
			const y = (tokens) => 152 - tokens / top * innerHeight;
			const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.tokens).toFixed(1)}`).join(" ");
			const radius = points.length > 90 ? 1.5 : points.length > 30 ? 2 : 3;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				role: "img",
				"aria-label": "每日总 token 曲线",
				viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
				className: TrendChart_module_css_default.chart,
				children: [
					ticks.map((tick) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: LEFT,
						y1: y(tick),
						x2: 784,
						y2: y(tick),
						className: TrendChart_module_css_default.grid
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: 38,
						y: y(tick) + 3,
						textAnchor: "end",
						className: TrendChart_module_css_default.tick,
						children: formatTokens(tick)
					})] }, tick)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: LEFT,
						y1: y(0),
						x2: 784,
						y2: y(0),
						className: TrendChart_module_css_default.axis
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: path,
						className: TrendChart_module_css_default.line
					}),
					points.map((point, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: x(index),
						cy: y(point.tokens),
						r: radius,
						className: TrendChart_module_css_default.dot
					}, point.day)),
					labelIndices(points.length).map((index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: x(index),
						y: 184,
						textAnchor: index === 0 ? "start" : index === points.length - 1 ? "end" : "middle",
						className: TrendChart_module_css_default.tick,
						children: points[index].day.slice(5)
					}, index))
				]
			});
		}
		//#endregion
		//#region \0dsh-css:E:\Documents\MyCode\oyw-dsh-plugin\dsh-token-usage\src\client\TokenUsageSection.module.css.mjs
		const css = ".kIC_0q_section{flex-direction:column;gap:16px;width:100%;display:flex}.kIC_0q_head{justify-content:space-between;align-items:center;gap:12px;display:flex}.kIC_0q_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600}.kIC_0q_muted{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}.kIC_0q_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}.kIC_0q_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;font-weight:600}.kIC_0q_table{border-collapse:collapse;font-variant-numeric:tabular-nums;width:100%;font-size:13px}.kIC_0q_table th,.kIC_0q_table td{text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 8px}.kIC_0q_table th:first-child,.kIC_0q_table td:first-child{text-align:left}.kIC_0q_table th{color:var(--dsw-alias-label-secondary);font-weight:500}.kIC_0q_table td{color:var(--dsw-alias-label-primary)}.kIC_0q_empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.kIC_0q_button{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px;line-height:20px}.kIC_0q_button:hover{background:var(--dsw-interactive-bg-hover)}.kIC_0q_filters{flex-wrap:nowrap;align-items:center;gap:8px;display:flex}.kIC_0q_control{box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsh-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:13px;line-height:20px}.kIC_0q_dateControl{box-sizing:border-box;width:138px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;padding:4px 6px;font-size:13px;line-height:20px}.kIC_0q_modelControl{box-sizing:border-box;text-overflow:ellipsis;min-width:0;max-width:220px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:13px;line-height:20px;overflow:hidden}.kIC_0q_rangeSeparator{color:var(--dsw-alias-label-secondary);font-size:12px}.kIC_0q_cards{grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;display:grid}.kIC_0q_card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}.kIC_0q_cardLabel{color:var(--dsw-alias-label-secondary);font-size:12px;display:block}.kIC_0q_cardValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}";
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
			"cardLabel": "kIC_0q_cardLabel",
			"control": "kIC_0q_control",
			"head": "kIC_0q_head",
			"error": "kIC_0q_error",
			"cards": "kIC_0q_cards",
			"card": "kIC_0q_card",
			"rangeSeparator": "kIC_0q_rangeSeparator",
			"dateControl": "kIC_0q_dateControl",
			"button": "kIC_0q_button",
			"empty": "kIC_0q_empty",
			"cardValue": "kIC_0q_cardValue",
			"section": "kIC_0q_section",
			"muted": "kIC_0q_muted",
			"filters": "kIC_0q_filters",
			"table": "kIC_0q_table",
			"modelControl": "kIC_0q_modelControl",
			"subtitle": "kIC_0q_subtitle"
		};
		//#endregion
		//#region src/client/TokenUsageSection.tsx
		/**
		* Token-usage settings page (browser half): fetches the stats summary from
		* the host route and renders the filter bar (inclusive day range, model
		* select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
		* total-usage strip, the daily-token trend chart, and the per-model detail
		* table with the hit rate last — all following the active filters. There is
		* no refresh button: entering the page or changing a filter refetches (the
		* route answers no-store); only the error state keeps a retry.
		*
		* @module token-usage/client/TokenUsageSection
		*/
		/** Fetch the summary for one query string; the caller owns the failure presentation. */
		async function fetchSummary(query) {
			const response = await fetch(STATS_PATH + query);
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			const value = await response.json();
			if (typeof value !== "object" || value === null || typeof value.total !== "object") throw new Error("unexpected stats response");
			return value;
		}
		/**
		* The query string of one filter selection ('' when unconstrained), or null
		* while the range is mid-edit (`from > to`): editing the two date inputs
		* one at a time passes through inverted ranges, and fetching those would
		* only flash an HTTP 400 — the request waits until the range settles.
		*/
		function filterQuery(filters) {
			if (filters.from !== "" && filters.to !== "" && filters.from > filters.to) return null;
			const params = new URLSearchParams();
			if (filters.from !== "") params.set("from", filters.from);
			if (filters.to !== "") params.set("to", filters.to);
			if (filters.model !== "") params.set("model", filters.model);
			return Array.from(params).length > 0 ? `?${params.toString()}` : "";
		}
		/** Quick-range day span in days (1 = today only, inclusive on both ends). */
		const QUICK_DAYS = [
			1,
			7,
			30
		];
		/** The day keys of one quick range: today minus (days - 1) through today. */
		function quickRange(days) {
			return {
				from: shiftedDayKey(-(days - 1)),
				to: shiftedDayKey(0)
			};
		}
		/** Whether the filters exactly hold one quick range. */
		function isQuickActive(days, filters) {
			const range = quickRange(days);
			return filters.from === range.from && filters.to === range.to;
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
		/** The filter bar: quick range select, day range, model select — one row. */
		function FilterBar({ filters, models, onChange }) {
			const quickValue = QUICK_DAYS.find((days) => isQuickActive(days, filters)) ?? "custom";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["filters"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						"aria-label": "快捷区间",
						className: TokenUsageSection_module_css_default["control"],
						value: quickValue,
						onChange: (event) => {
							const days = Number(event.target.value);
							if (days > 0) onChange({
								...filters,
								...quickRange(days)
							});
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "1",
								children: "1d"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "7",
								children: "7d"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "30",
								children: "30d"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "custom",
								children: "自定义"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "date",
						"aria-label": "开始日期",
						className: TokenUsageSection_module_css_default["dateControl"],
						value: filters.from,
						onChange: (event) => onChange({
							...filters,
							from: event.target.value
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: TokenUsageSection_module_css_default["rangeSeparator"],
						children: "至"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "date",
						"aria-label": "结束日期",
						className: TokenUsageSection_module_css_default["dateControl"],
						value: filters.to,
						onChange: (event) => onChange({
							...filters,
							to: event.target.value
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						"aria-label": "模型",
						className: TokenUsageSection_module_css_default["modelControl"],
						value: filters.model,
						onChange: (event) => onChange({
							...filters,
							model: event.target.value
						}),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "",
							children: "全部模型"
						}), models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: model,
							children: model
						}, model))]
					})
				]
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
			const [filters, setFilters] = (0, react.useState)(() => ({
				model: "",
				...quickRange(1)
			}));
			const [models, setModels] = (0, react.useState)([]);
			const [attempt, setAttempt] = (0, react.useState)(0);
			const retry = (0, react.useCallback)(() => {
				setAttempt((previous) => previous + 1);
			}, []);
			(0, react.useEffect)(() => {
				const query = filterQuery(filters);
				if (query === null) return;
				let cancelled = false;
				setState({ status: "loading" });
				fetchSummary(query).then((summary) => {
					if (cancelled) return;
					setState({
						status: "ready",
						summary
					});
					if (filters.model === "") setModels(summary.byModel.map((row) => row.model));
				}).catch((error) => {
					if (!cancelled) setState({
						status: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				});
				return () => {
					cancelled = true;
				};
			}, [filters, attempt]);
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
						onClick: retry,
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: TokenUsageSection_module_css_default["title"],
						children: "Token 用量"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: TokenUsageSection_module_css_default["muted"],
						children: ["数据目录：", state.summary.dataDir]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FilterBar, {
						filters,
						models,
						onChange: setFilters
					}),
					total.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: TokenUsageSection_module_css_default["empty"],
						children: "暂无数据。可调整筛选条件；模型请求成功后会自动写入，历史记录可通过命令面板的 /token-usage-sync 补齐。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrendChart, {
							rows: state.summary.byDay,
							...filters.from !== "" ? { from: filters.from } : {},
							...filters.to !== "" ? { to: filters.to } : {}
						}),
						state.summary.byModel.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: TokenUsageSection_module_css_default["subtitle"],
							children: "按模型"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: TokenUsageSection_module_css_default["table"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "模型" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "请求数" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "总 token" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "输入" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "输出" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "缓存读" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "缓存写" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "命中率" })
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: state.summary.byModel.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.model }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.totals.requests.toLocaleString() }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(totalTokens(row.totals)) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.inputTokens) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.outputTokens) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheReadTokens) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheWriteTokens) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatHitRate(row.totals) })
							] }, row.model)) })]
						})] }) : null
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