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
		/** Local `YYYY-MM-DDTHH` key of a date, matching the host's hour convention. */
		function hourKeyOf(date) {
			const hour = String(date.getHours()).padStart(2, "0");
			return `${dayKeyOf(date)}T${hour}`;
		}
		/**
		* The zero-filled hourly token series over a day range: every whole hour of
		* the range appears once (hours without records plot as zero), so a single
		* day yields the full 00:00–23:00 sequence and future hours of today read
		* zero. The per-(hour, model) rows fold by hour. Absent bounds fall back to
		* the first/last row hour; no rows and no range yield [].
		* @param rows - the (already filtered) per-hour × per-model rows.
		* @param from - first day key (`YYYY-MM-DD`), inclusive; the series starts
		* at that day's 00:00.
		* @param to - last day key, inclusive; the series ends at that day's 23:00.
		*/
		function hourSeries(rows, from, to) {
			const first = from !== void 0 ? `${from}T00` : rows[0]?.hour;
			const last = to !== void 0 ? `${to}T23` : rows.length > 0 ? rows[rows.length - 1].hour : void 0;
			if (first === void 0 || last === void 0 || first > last) return [];
			const tokens = /* @__PURE__ */ new Map();
			for (const row of rows) tokens.set(row.hour, (tokens.get(row.hour) ?? 0) + totalTokens(row.totals));
			const points = [];
			const cursor = /* @__PURE__ */ new Date(`${first.slice(0, 10)}T${first.slice(11)}:00:00`);
			const end = /* @__PURE__ */ new Date(`${last.slice(0, 10)}T${last.slice(11)}:00:00`);
			while (cursor <= end) {
				const hour = hourKeyOf(cursor);
				points.push({
					hour,
					tokens: tokens.get(hour) ?? 0
				});
				cursor.setHours(cursor.getHours() + 1);
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
		/** Currency symbol of the pricing layer; costs are billed in RMB. */
		const COST_SYMBOL = "¥";
		/**
		* Cost as display text: `¥` plus two decimals, following the analyzer's cost
		* formatting (`¥1.25`, `¥0.00`). A cost is always shown, never omitted.
		* @param cost - a non-negative cost in ¥.
		* @returns e.g. `¥1.25`.
		*/
		function formatCost(cost) {
			return `${COST_SYMBOL}${cost.toFixed(2)}`;
		}
		/**
		* A per-million-token rate as display text: integral rates stay bare (`8`),
		* fractional ones keep up to four decimals with trailing zeros stripped and a
		* two-decimal minimum (`0.50`, `0.25`, `0.025`). The caller appends the `/M`
		* unit where needed.
		* @param rate - a non-negative rate in ¥ per million tokens.
		* @returns the display string.
		*/
		function formatRate(rate) {
			if (Number.isInteger(rate)) return String(rate);
			let s = rate.toFixed(4);
			const dot = s.indexOf(".");
			s = s.replace(/0+$/u, "");
			if (s.endsWith(".")) s += "00";
			const minEnd = dot + 3;
			while (s.length < minEnd) s += "0";
			return s;
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\TrendChart.module.css.mjs
		const css$1 = ".DWJgoW_chart{width:100%;height:auto;display:block}.DWJgoW_axis{stroke:var(--dsw-alias-border-l2);stroke-width:1px}.DWJgoW_grid{stroke:var(--dsw-alias-border-l2);stroke-width:1px;stroke-dasharray:3 3}.DWJgoW_line{fill:none;stroke:var(--dsw-alias-label-primary);stroke-width:2px;stroke-linejoin:round;stroke-linecap:round}.DWJgoW_dot{fill:var(--dsw-alias-label-primary)}.DWJgoW_dotActive{fill:var(--dsw-alias-label-primary);stroke:var(--dsw-alias-bg-layer-2);stroke-width:2px}.DWJgoW_guide{stroke:var(--dsw-alias-label-secondary);stroke-width:1px;stroke-dasharray:3 3}.DWJgoW_hit{cursor:default}.DWJgoW_pointLabel rect{fill:var(--dsw-alias-bg-layer-3);stroke:var(--dsw-alias-border-l2)}.DWJgoW_pointLabel text{fill:var(--dsw-alias-label-primary);font-size:11px}.DWJgoW_tick{fill:var(--dsw-alias-label-secondary);font-size:11px}.DWJgoW_empty{text-align:center;color:var(--dsw-alias-label-secondary);margin:0;padding:24px 0;font-size:13px}";
		const tagId$1 = "dsh-token-usage/TrendChart.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var TrendChart_module_css_default = {
			"axis": "DWJgoW_axis",
			"chart": "DWJgoW_chart",
			"dot": "DWJgoW_dot",
			"dotActive": "DWJgoW_dotActive",
			"empty": "DWJgoW_empty",
			"grid": "DWJgoW_grid",
			"guide": "DWJgoW_guide",
			"hit": "DWJgoW_hit",
			"line": "DWJgoW_line",
			"pointLabel": "DWJgoW_pointLabel",
			"tick": "DWJgoW_tick"
		};
		//#endregion
		//#region src/client/TrendChart.tsx
		/**
		* Daily token trend chart (browser half): a dependency-free SVG line chart
		* over the already-filtered summary. Two granularities share one renderer —
		* per-day rows (x axis spans every calendar day of the active range, days
		* without records plot as zero) and per-hour rows (a single-day window plots
		* every whole hour of that day, 00:00–23:00, future hours of today reading
		* zero). The x axis labels first/middle/last points; the y axis grid uses
		* round 1/2/2.5/5 × 10ⁿ steps (K/M/B abbreviated). Hovering (or keyboard-
		* focusing) a point highlights it and floats a label with that point's
		* date/time and total tokens. An empty range renders a placeholder instead
		* of an axis.
		*
		* @module token-usage/client/TrendChart
		*/
		/** SVG canvas metrics; the element scales to the section width via viewBox. */
		const WIDTH = 800;
		const HEIGHT = 190;
		const TOP = 12;
		const LEFT = 44;
		/** X-axis label positions: first, middle, and last point for long ranges. */
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
		* Render the daily (or, for a single-day window, hourly) token line chart.
		* @param props - the filtered per-day rows plus the optional per-hour rows
		* (when present the chart plots hours instead of days), the active range
		* bounds (absent when unfiltered; the chart then spans first to last row),
		* and the `t` seat for the empty hint and the chart aria-label.
		* @returns the SVG chart, or a placeholder for an empty range.
		*/
		function TrendChart({ rows, hours, from, to, t }) {
			const points = hours !== void 0 ? hourSeries(hours, from, to).map((point) => ({
				key: point.hour,
				label: `${point.hour.slice(11)}:00`,
				full: `${point.hour.slice(0, 10)} ${point.hour.slice(11)}:00`,
				tokens: point.tokens
			})) : daySeries(rows, from, to).map((point) => ({
				key: point.day,
				label: point.day.slice(5),
				full: point.day,
				tokens: point.tokens
			}));
			if (points.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: TrendChart_module_css_default.empty,
				children: t("chart.empty")
			});
			const pointLabel = (point) => t("chart.pointLabel", {
				day: point.full,
				tokens: formatTokens(point.tokens)
			});
			const { top, ticks } = tickValues(Math.max(...points.map((point) => point.tokens)));
			const innerWidth = 740;
			const innerHeight = 140;
			const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
			const x = (index) => LEFT + (points.length > 1 ? index * step : innerWidth / 2);
			const y = (tokens) => 152 - tokens / top * innerHeight;
			const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.tokens).toFixed(1)}`).join(" ");
			const radius = points.length > 90 ? 1.5 : points.length > 30 ? 2 : 3;
			const [active, setActive] = (0, react.useState)(null);
			const activePoint = active === null ? null : points[active] ?? null;
			const hitWidth = points.length > 1 ? Math.max(step, 12) : innerWidth;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				role: "img",
				"aria-label": hours !== void 0 ? t("chart.ariaHour") : t("chart.aria"),
				viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
				className: TrendChart_module_css_default.chart,
				onMouseLeave: () => setActive(null),
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
						r: active === index ? radius + 2.5 : radius,
						className: active === index ? TrendChart_module_css_default.dotActive : TrendChart_module_css_default.dot
					}, point.key)),
					activePoint !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: x(active),
						y1: y(activePoint.tokens),
						x2: x(active),
						y2: y(0),
						className: TrendChart_module_css_default.guide
					}) : null,
					points.map((point, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: x(index) - hitWidth / 2,
						y: TOP,
						width: hitWidth,
						height: innerHeight,
						fill: "transparent",
						"aria-label": pointLabel(point),
						role: "button",
						tabIndex: 0,
						className: TrendChart_module_css_default.hit,
						onMouseEnter: () => setActive(index),
						onFocus: () => setActive(index),
						onBlur: () => setActive((current) => current === index ? null : current)
					}, point.key)),
					activePoint !== null ? (() => {
						const label = pointLabel(activePoint);
						const labelWidth = label.length * 6.2 + 12;
						const center = x(active);
						const left = Math.min(Math.max(center - labelWidth / 2, LEFT), 784 - labelWidth);
						const labelY = Math.max(y(activePoint.tokens) - 12, 20);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
							className: TrendChart_module_css_default.pointLabel,
							pointerEvents: "none",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
								x: left,
								y: labelY - 13,
								width: labelWidth,
								height: 20,
								rx: 5
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: left + labelWidth / 2,
								y: labelY,
								textAnchor: "middle",
								children: label
							})]
						});
					})() : null,
					labelIndices(points.length).map((index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: x(index),
						y: 184,
						textAnchor: index === 0 ? "start" : index === points.length - 1 ? "end" : "middle",
						className: TrendChart_module_css_default.tick,
						children: points[index].label
					}, index))
				]
			});
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\TokenUsageSection.module.css.mjs
		const css = ".RbkiSa_section{flex-direction:column;gap:16px;width:100%;display:flex}.RbkiSa_head{justify-content:space-between;align-items:center;gap:12px;display:flex}.RbkiSa_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600}.RbkiSa_muted{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}.RbkiSa_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}.RbkiSa_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;font-weight:600}.RbkiSa_tableWrap{overflow-x:auto}.RbkiSa_table{border-collapse:collapse;font-variant-numeric:tabular-nums;width:100%;min-width:500px;font-size:12px}.RbkiSa_table th,.RbkiSa_table td{text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;padding:4px 6px}.RbkiSa_table th.RbkiSa_modelHead,.RbkiSa_table td.RbkiSa_modelCol{text-align:left;width:150px;max-width:150px}.RbkiSa_table th{color:var(--dsw-alias-label-secondary);font-weight:500}.RbkiSa_table td{color:var(--dsw-alias-label-primary)}.RbkiSa_empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.RbkiSa_button{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px;line-height:20px}.RbkiSa_button:hover{background:var(--dsw-interactive-bg-hover)}.RbkiSa_filters{flex-wrap:nowrap;align-items:center;gap:8px;display:flex}.RbkiSa_control,.RbkiSa_modelControl{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 6px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:26px}.RbkiSa_control{box-sizing:border-box;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 26px 4px 8px;font-size:13px;line-height:20px}.RbkiSa_dateControl{box-sizing:border-box;width:138px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;padding:4px 6px;font-size:13px;line-height:20px}.RbkiSa_modelControl{box-sizing:border-box;text-overflow:ellipsis;min-width:0;max-width:220px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 26px 4px 8px;font-size:13px;line-height:20px;overflow:hidden}.RbkiSa_rangeSeparator{color:var(--dsw-alias-label-secondary);font-size:12px}.RbkiSa_cards{grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;display:grid}.RbkiSa_card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}.RbkiSa_cardLabel{color:var(--dsw-alias-label-secondary);font-size:12px;display:block}.RbkiSa_cardValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}.RbkiSa_cardValueCost{font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-warn-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}.RbkiSa_warning{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:6px;margin:0;padding:6px 10px;font-size:12px}.RbkiSa_modelCell{align-items:center;gap:4px;max-width:138px;display:inline-flex;position:relative}.RbkiSa_modelName{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.RbkiSa_unpricedTag{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:8px;flex:none;padding:0 6px;font-size:10px;line-height:16px}.RbkiSa_costCell{color:var(--dsw-alias-state-warn-primary);font-weight:600}.RbkiSa_pricingButton{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:8px;flex:none;padding:0 6px;font-size:10px;line-height:16px}.RbkiSa_pricingButton:hover{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);border-color:var(--dsw-alias-state-warn-primary)}.RbkiSa_dialog{width:min(600px,100vw - 48px);max-height:calc(100vh - 48px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;overflow-y:auto}.RbkiSa_dialog::backdrop{background:#0006}.RbkiSa_dialogHead{justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;display:flex}.RbkiSa_dialogTitle{text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:14px;font-weight:600;overflow:hidden}.RbkiSa_dialogClose{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;padding:2px 8px;font-size:12px;line-height:18px}.RbkiSa_dialogClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-interactive-bg-hover)}th.RbkiSa_conditionHead,td.RbkiSa_conditionCell{text-align:left;white-space:normal;min-width:200px}td.RbkiSa_conditionCell{color:var(--dsw-alias-label-secondary);padding-left:20px}.RbkiSa_groupRow>td{text-align:left;white-space:normal;color:var(--dsw-alias-label-secondary);border-bottom:none;padding-top:8px;font-size:11px;font-weight:600}.RbkiSa_groupRow:not(:first-child)>td{border-top:1px solid var(--dsw-alias-border-l1)}";
		const tagId = "dsh-token-usage/TokenUsageSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var TokenUsageSection_module_css_default = {
			"button": "RbkiSa_button",
			"card": "RbkiSa_card",
			"cardLabel": "RbkiSa_cardLabel",
			"cardValue": "RbkiSa_cardValue",
			"cardValueCost": "RbkiSa_cardValueCost",
			"cards": "RbkiSa_cards",
			"conditionCell": "RbkiSa_conditionCell",
			"conditionHead": "RbkiSa_conditionHead",
			"control": "RbkiSa_control",
			"costCell": "RbkiSa_costCell",
			"dateControl": "RbkiSa_dateControl",
			"dialog": "RbkiSa_dialog",
			"dialogClose": "RbkiSa_dialogClose",
			"dialogHead": "RbkiSa_dialogHead",
			"dialogTitle": "RbkiSa_dialogTitle",
			"empty": "RbkiSa_empty",
			"error": "RbkiSa_error",
			"filters": "RbkiSa_filters",
			"groupRow": "RbkiSa_groupRow",
			"head": "RbkiSa_head",
			"modelCell": "RbkiSa_modelCell",
			"modelCol": "RbkiSa_modelCol",
			"modelControl": "RbkiSa_modelControl",
			"modelHead": "RbkiSa_modelHead",
			"modelName": "RbkiSa_modelName",
			"muted": "RbkiSa_muted",
			"pricingButton": "RbkiSa_pricingButton",
			"rangeSeparator": "RbkiSa_rangeSeparator",
			"section": "RbkiSa_section",
			"subtitle": "RbkiSa_subtitle",
			"table": "RbkiSa_table",
			"tableWrap": "RbkiSa_tableWrap",
			"title": "RbkiSa_title",
			"unpricedTag": "RbkiSa_unpricedTag",
			"warning": "RbkiSa_warning"
		};
		//#endregion
		//#region src/client/TokenUsageSection.tsx
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
		/** One card in a metric row; `accent` renders the value in the cost color. */
		function StatCard({ label, value, accent }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["card"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: TokenUsageSection_module_css_default["cardLabel"],
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: accent === true ? TokenUsageSection_module_css_default["cardValueCost"] : TokenUsageSection_module_css_default["cardValue"],
					children: value
				})]
			});
		}
		/** The four base rates of one model as display text; a missing cache rate bills at the input rate. */
		function billedRates(rates) {
			return {
				input: formatRate(rates.inputPerMillion),
				output: formatRate(rates.outputPerMillion),
				cacheRead: formatRate(rates.cacheReadPerMillion ?? rates.inputPerMillion),
				cacheWrite: formatRate(rates.cacheWritePerMillion ?? rates.inputPerMillion)
			};
		}
		/** `HH:MM-HH:MM` of one peak window (half-open, local minutes). */
		function windowText(window) {
			const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
			return `${clock(window.startMinute)}-${clock(window.endMinute)}`;
		}
		/** The when-it-applies text of one peak slot: its label plus its windows. */
		function slotCondition(slot, t) {
			return `${slot.label ?? t("pricing.peak")} ${slot.windows.map(windowText).join(t("pricing.windowSep"))}`;
		}
		/**
		* The price rows of one rate node (a time rule's or the model root's): the
		* node's own base rates, then its peak slots, then its context tiers
		* (ascending), each tier followed by the peak slots hanging on that tier —
		* mirroring {@link resolveRate}'s node chain, where a matching tier's slots
		* replace the node's and peak rates replace the node's rates wholesale.
		*/
		function nodePriceRows(node, t) {
			const rows = [{
				condition: t("pricing.default"),
				rates: node.rates
			}];
			const tiers = [...node.tiers ?? []].sort((a, b) => a.threshold - b.threshold);
			for (const tier of tiers) {
				const tierCondition = t("pricing.tier", { threshold: formatTokens(tier.threshold) });
				rows.push({
					condition: tierCondition,
					rates: tier.rates
				});
				for (const slot of tier.dailySlots ?? []) rows.push({
					condition: `${tierCondition} · ${slotCondition(slot, t)}`,
					rates: slot.rates
				});
			}
			for (const slot of node.slots ?? []) rows.push({
				condition: slotCondition(slot, t),
				rates: slot.rates
			});
			return rows;
		}
		/**
		* One model's price table: rows are billing conditions — grouped into the
		* model root (“常规”, omitted when it is the only group) and one group per
		* time rule with its date window — so tier, peak, and time-rule pricing
		* each show when they apply and what they bill. Shared by the pricing
		* dialog; the structure mirrors {@link resolveRate}'s node chain.
		*/
		function ModelPriceTable({ rules, t }) {
			const groups = [{
				title: rules.timeRules.length > 0 ? t("pricing.regular") : null,
				rows: nodePriceRows({
					rates: rules.base,
					tiers: rules.contextTiers,
					slots: rules.dailySlots
				}, t)
			}, ...rules.timeRules.map((rule) => ({
				title: `${rule.label !== void 0 ? `${rule.label} ` : ""}${rule.startTime > 0 ? `${dayKeyOf(/* @__PURE__ */ new Date(rule.startTime * 1e3))} ~ ` : "~ "}${dayKeyOf(/* @__PURE__ */ new Date(rule.endTime * 1e3))}`,
				rows: nodePriceRows({
					rates: rule.rates,
					tiers: rule.contextTiers,
					slots: rule.dailySlots
				}, t)
			}))];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: TokenUsageSection_module_css_default["tableWrap"],
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
					className: TokenUsageSection_module_css_default["table"],
					"aria-label": t("pricing.title"),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
							className: TokenUsageSection_module_css_default["conditionHead"],
							children: t("pricing.condition")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("th", { children: [t("pricing.input"), t("pricing.perMillion")] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("th", { children: [t("pricing.output"), t("pricing.perMillion")] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("th", { children: [t("pricing.cacheRead"), t("pricing.perMillion")] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("th", { children: [t("pricing.cacheWrite"), t("pricing.perMillion")] })
					] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: groups.flatMap((group) => [...group.title !== null ? [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", {
						className: TokenUsageSection_module_css_default["groupRow"],
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
							colSpan: 5,
							children: group.title
						})
					}, group.title)] : [], ...group.rows.map((row, index) => {
						const billed = billedRates(row.rates);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: TokenUsageSection_module_css_default["conditionCell"],
								children: row.condition
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: ["¥", billed.input] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: ["¥", billed.output] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: ["¥", billed.cacheRead] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: ["¥", billed.cacheWrite] })
						] }, `${group.title ?? ""}-${index}-${row.condition}`);
					})]) })]
				})
			});
		}
		/**
		* The pricing dialog of one model: a native `<dialog>` (Esc closes, focus
		* is trapped, the backdrop dims, and the top layer renders it above the
		* table's scroll shell) opened by the “定价” affordance in a model row.
		* Mounts only while a model is selected; every close path funnels through
		* the dialog's `close` event, which clears the selection and unmounts it.
		*/
		function PricingDialog({ model, rules, onClose, t }) {
			const dialogRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const dialog = dialogRef.current;
				if (dialog !== null && !dialog.open) dialog.showModal();
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dialog", {
				ref: dialogRef,
				className: TokenUsageSection_module_css_default["dialog"],
				"aria-label": t("pricing.title"),
				onClose,
				onClick: (event) => {
					if (event.target === dialogRef.current) dialogRef.current?.close();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TokenUsageSection_module_css_default["dialogHead"],
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: TokenUsageSection_module_css_default["dialogTitle"],
						children: model
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: TokenUsageSection_module_css_default["dialogClose"],
						"aria-label": t("pricing.close"),
						onClick: () => dialogRef.current?.close(),
						children: "✕"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPriceTable, {
					rules,
					t
				})]
			});
		}
		/** The filter bar: quick range select, day range, model select — one row. */
		function FilterBar({ filters, models, onChange, t }) {
			const quickValue = QUICK_DAYS.find((days) => isQuickActive(days, filters)) ?? "custom";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["filters"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						"aria-label": t("filter.quickRange"),
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
								children: t("filter.custom")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "date",
						"aria-label": t("filter.from"),
						className: TokenUsageSection_module_css_default["dateControl"],
						value: filters.from,
						onChange: (event) => onChange({
							...filters,
							from: event.target.value
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: TokenUsageSection_module_css_default["rangeSeparator"],
						children: t("filter.separator")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "date",
						"aria-label": t("filter.to"),
						className: TokenUsageSection_module_css_default["dateControl"],
						value: filters.to,
						onChange: (event) => onChange({
							...filters,
							to: event.target.value
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						"aria-label": t("filter.model"),
						className: TokenUsageSection_module_css_default["modelControl"],
						value: filters.model,
						onChange: (event) => onChange({
							...filters,
							model: event.target.value
						}),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "",
							children: t("filter.allModels")
						}), models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: model,
							children: model
						}, model))]
					})
				]
			});
		}
		/**
		* Mirror the shell's root `color-scheme` onto this section's root element.
		* The shell sets it on `document.documentElement` only, so form controls
		* inside a plugin section render with the UA default (white) in dark mode;
		* scoping the property to the section fixes selects, inputs, and the
		* dialog without touching anything outside the section.
		*/
		function useColorSchemeMirror(rootRef) {
			(0, react.useEffect)(() => {
				const root = document.documentElement;
				const element = rootRef.current;
				if (element === null) return;
				const sync = () => {
					const scheme = root.style.colorScheme;
					if (scheme !== "") element.style.colorScheme = scheme;
					else element.style.removeProperty("color-scheme");
				};
				sync();
				const observer = new MutationObserver(sync);
				observer.observe(root, {
					attributes: true,
					attributeFilter: ["style"]
				});
				return () => observer.disconnect();
			}, [rootRef]);
		}
		/**
		* Render the Token Usage section content column. The `t` seat arrives from
		* the registration's `locale:` declaration and follows the active locale.
		* @param props - the settings shell's owner share (close is unused: the nav
		* rail owns leaving the panel) plus the framework-injected translate seat.
		* @returns the section, one of loading / error / ready.
		*/
		function TokenUsageSection({ t }) {
			const rootRef = (0, react.useRef)(null);
			useColorSchemeMirror(rootRef);
			const [state, setState] = (0, react.useState)({ status: "loading" });
			const [filters, setFilters] = (0, react.useState)(() => ({
				model: "",
				...quickRange(1)
			}));
			const [models, setModels] = (0, react.useState)([]);
			const [detailModel, setDetailModel] = (0, react.useState)(null);
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
				ref: rootRef,
				className: TokenUsageSection_module_css_default["section"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					className: TokenUsageSection_module_css_default["title"],
					children: t("nav.label")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: TokenUsageSection_module_css_default["muted"],
					children: t("loading")
				})]
			});
			if (state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: TokenUsageSection_module_css_default["section"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TokenUsageSection_module_css_default["head"],
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: TokenUsageSection_module_css_default["title"],
						children: t("nav.label")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: TokenUsageSection_module_css_default["button"],
						onClick: retry,
						children: t("retry")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: TokenUsageSection_module_css_default["error"],
					children: t("loadFailed", { message: state.message })
				})]
			});
			const { total } = state.summary;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: TokenUsageSection_module_css_default["section"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: TokenUsageSection_module_css_default["title"],
						children: t("nav.label")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: TokenUsageSection_module_css_default["muted"],
						children: t("dataDir", { path: state.summary.dataDir })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FilterBar, {
						filters,
						models,
						onChange: setFilters,
						t
					}),
					total.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: TokenUsageSection_module_css_default["empty"],
						children: t("empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TokenUsageSection_module_css_default["cards"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.requests"),
									value: total.requests.toLocaleString()
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.cost"),
									value: formatCost(state.summary.totalCost),
									accent: true
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.totalTokens"),
									value: formatTokens(totalTokens(total))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.hitRate"),
									value: formatHitRate(total)
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TokenUsageSection_module_css_default["cards"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.input"),
									value: formatTokens(total.inputTokens)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.output"),
									value: formatTokens(total.outputTokens)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.cacheRead"),
									value: formatTokens(total.cacheReadTokens)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.cacheWrite"),
									value: formatTokens(total.cacheWriteTokens)
								})
							]
						}),
						state.summary.unpricedModels.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: TokenUsageSection_module_css_default["warning"],
							role: "status",
							children: t("unpriced.warning", {
								count: String(state.summary.unpricedModels.length),
								models: state.summary.unpricedModels.join(", ")
							})
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrendChart, {
							rows: state.summary.byDay,
							t,
							...filters.from !== "" ? { from: filters.from } : {},
							...filters.to !== "" ? { to: filters.to } : {},
							...filters.from !== "" && filters.from === filters.to ? { hours: state.summary.byHour } : {}
						}),
						state.summary.byModel.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: TokenUsageSection_module_css_default["subtitle"],
							children: t("byModel.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: TokenUsageSection_module_css_default["tableWrap"],
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								className: TokenUsageSection_module_css_default["table"],
								"aria-label": t("byModel.title"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										className: TokenUsageSection_module_css_default["modelHead"],
										children: t("filter.model")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.requests") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cost") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.totalTokens") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.input") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.output") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cacheRead") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cacheWrite") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.hitRate") })
								] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: state.summary.byModel.map((row) => {
									const rules = state.summary.pricing[row.model];
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: TokenUsageSection_module_css_default["modelCol"],
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: TokenUsageSection_module_css_default["modelCell"],
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TokenUsageSection_module_css_default["modelName"],
													children: row.model
												}), rules !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: TokenUsageSection_module_css_default["pricingButton"],
													"aria-label": t("pricing.view", { model: row.model }),
													onClick: () => setDetailModel(row.model),
													children: t("pricing.viewShort")
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: TokenUsageSection_module_css_default["unpricedTag"],
													children: t("pricing.unpriced")
												})]
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.totals.requests.toLocaleString() }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: rules !== void 0 ? TokenUsageSection_module_css_default["costCell"] : void 0,
											children: rules !== void 0 ? formatCost(row.cost) : "—"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(totalTokens(row.totals)) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.inputTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.outputTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheReadTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheWriteTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatHitRate(row.totals) })
									] }, row.model);
								}) })]
							})
						})] }) : null,
						detailModel !== null && state.summary.pricing[detailModel] !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PricingDialog, {
							model: detailModel,
							rules: state.summary.pricing[detailModel],
							onClose: () => setDetailModel(null),
							t
						}) : null
					] })
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* `token-usage` locale namespace dictionaries (browser half). zh is the
		* key-set source of truth; en is checked complete against it — the typed
		* `ctx.locale.register(NS, { zh, en })` call enforces both at compile time
		* and the `t` standard seat narrows its key domain to this union plus the
		* shared common vocabulary.
		*
		* @module token-usage/client/locales
		*/
		/** Dictionary namespace owned by this plugin. */
		const NS = "token-usage";
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"nav.label": "Token 用量",
			"filter.quickRange": "快捷区间",
			"filter.custom": "自定义",
			"filter.from": "开始日期",
			"filter.to": "结束日期",
			"filter.separator": "至",
			"filter.model": "模型",
			"filter.allModels": "全部模型",
			"stat.requests": "请求数",
			"stat.totalTokens": "总 token",
			"stat.hitRate": "命中率",
			"stat.cost": "费用",
			"stat.input": "入",
			"stat.output": "出",
			"stat.cacheRead": "缓",
			"stat.cacheWrite": "写",
			"byModel.title": "按模型",
			"pricing.title": "模型定价",
			"pricing.view": "查看 {model} 定价",
			"pricing.viewShort": "定价",
			"pricing.close": "关闭",
			"pricing.condition": "计费条件",
			"pricing.default": "默认",
			"pricing.regular": "常规（规则期外）",
			"pricing.tier": "上下文 ≥{threshold}",
			"pricing.peak": "峰时",
			"pricing.input": "入",
			"pricing.output": "出",
			"pricing.cacheRead": "缓",
			"pricing.cacheWrite": "写",
			"pricing.perMillion": "/M",
			"pricing.unpriced": "未定价",
			"pricing.windowSep": "、",
			"unpriced.warning": "{count} 个模型未定价：{models}（费用按 ¥0 计）",
			"dataDir": "数据目录：{path}",
			"loadFailed": "统计加载失败：{message}",
			"empty": "暂无数据。可调整筛选条件；模型请求成功后会自动写入，安装前已发生的历史记录会在首次启动时自动补齐。",
			"chart.empty": "区间内暂无数据",
			"chart.aria": "每日总 token 曲线",
			"chart.ariaHour": "单日分时 token 曲线",
			"chart.pointLabel": "{day} 总量 {tokens}"
		};
		/** English dictionary (same key set). */
		const en = {
			"nav.label": "Token Usage",
			"filter.quickRange": "Quick range",
			"filter.custom": "Custom",
			"filter.from": "Start date",
			"filter.to": "End date",
			"filter.separator": "to",
			"filter.model": "Model",
			"filter.allModels": "All models",
			"stat.requests": "Requests",
			"stat.totalTokens": "Total",
			"stat.hitRate": "Hit %",
			"stat.cost": "Cost",
			"stat.input": "In",
			"stat.output": "Out",
			"stat.cacheRead": "Cache",
			"stat.cacheWrite": "Write",
			"byModel.title": "By model",
			"pricing.title": "Model pricing",
			"pricing.view": "View rates for {model}",
			"pricing.viewShort": "Rates",
			"pricing.close": "Close",
			"pricing.condition": "Condition",
			"pricing.default": "Default",
			"pricing.regular": "Regular (outside rule windows)",
			"pricing.tier": "context ≥{threshold}",
			"pricing.peak": "Peak",
			"pricing.input": "In",
			"pricing.output": "Out",
			"pricing.cacheRead": "Cache",
			"pricing.cacheWrite": "Write",
			"pricing.perMillion": "/M",
			"pricing.unpriced": "Unpriced",
			"pricing.windowSep": ", ",
			"unpriced.warning": "{count} models unpriced: {models} (cost counts as ¥0)",
			"dataDir": "Data directory: {path}",
			"loadFailed": "Failed to load stats: {message}",
			"empty": "No data yet. Adjust the filters; requests are written automatically after each successful model call, and pre-install history is backfilled automatically on the first startup.",
			"chart.empty": "No data in range",
			"chart.aria": "Daily total token trend",
			"chart.ariaHour": "Single-day hourly token trend",
			"chart.pointLabel": "{day} total {tokens}"
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot registry and the locale dictionary registry. */
		const inject = ["slots", "locale"];
		/**
		* Register the dictionary pair, then the settings section once the shell's
		* `settings.section` declaration is on the ledger.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "token-usage: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "token-usage",
				order: 50,
				label: () => t("nav.label"),
				locale: NS
			}, TokenUsageSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map