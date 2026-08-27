window.__ModuleLoader__.load({
	id: "@laoyuehanni/dsh-token-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/wire.ts
		/** The stats endpoint path, served by the host half's webServer route. */
		const STATS_PATH = "/token-usage/stats";
		/** Encode one repeated query key (`sessionId=a&sessionId=b`). Empty list yields ''. */
		function encodeRepeatedParam(key, values) {
			return values.map((value) => `${key}=${encodeURIComponent(value)}`).join("&");
		}
		/** Encode child groups as repeated `childId=<id>[,member…]` parameters. */
		function encodeChildGroups(groups) {
			return groups.filter((group) => group.length > 0 && group[0] !== "").map((group) => `childId=${encodeURIComponent(group.join(","))}`).join("&");
		}
		/**
		* Build the stats query string (including the leading `?`, or '' when
		* unconstrained). `fields: 'full'` is omitted — that is the default the
		* settings page already hits.
		*/
		function encodeStatsQuery(options) {
			const parts = [];
			if (options.sessionIds !== void 0 && options.sessionIds.length > 0) parts.push(encodeRepeatedParam("sessionId", options.sessionIds));
			const children = options.childGroups !== void 0 ? encodeChildGroups(options.childGroups) : "";
			if (children !== "") parts.push(children);
			if (options.fields !== void 0 && options.fields !== "full") parts.push(`fields=${options.fields}`);
			return parts.length === 0 ? "" : `?${parts.join("&")}`;
		}
		/**
		* The quota endpoint path: the input-bar quota button polls this for the
		* current provider's rate-limit / balance snapshot. Served by the host
		* half's quota route; the query carries `?session=<id>` so the host can
		* resolve the provider the ACTIVE session is using.
		*/
		const QUOTA_PATH = "/token-usage/quota";
		/** The migration-progress endpoint path, polled by the browser card. */
		const MIGRATION_PATH = "/token-usage/migration";
		/**
		* The directory-guard endpoint path, consulted by the browser card before a
		* staged directory save commits. The settings wire swallows a refused write
		* (the bound scope recovers silently and never rejects), so this route is the
		* one channel that can tell the card WHY a save would not land.
		*/
		const DIR_GUARD_PATH = "/token-usage/dir-guard";
		/**
		* The full-sync endpoint path: the card's manual "scan again" affordance.
		* `POST` starts one full scan over every session log (the same scan the
		* one-shot startup sync ran on first install — list + inspect + dedupe), and
		* `GET` returns the live progress. The scan is fire-and-forget on the host
		* side, so the card polls while it runs.
		*/
		const FULL_SYNC_PATH = "/token-usage/full-sync";
		//#endregion
		//#region src/client/card-form.ts
		/** The fields this card edits. */
		const CARD_FIELDS = ["path", "pricingRegion"];
		/**
		* Stages the settings edits over the `token-usage` scope.
		*
		* The form publishes through a snapshot store because the slot component
		* reads through a snapshot selector while both the scope and the local drafts
		* change underneath; every projection is rebuilt from the two together. Only
		* fields the user touched are staged, so a save writes a sparse patch and
		* never restates fields it did not see.
		*/
		var CardForm = class {
			scope;
			snapshotValue;
			listeners = /* @__PURE__ */ new Set();
			drafts = {};
			saving = false;
			failed = false;
			refusal;
			migrationView;
			pollTimer;
			/**
			* @param scope - the bound settings scope for the `token-usage` namespace.
			*/
			constructor(scope) {
				this.scope = scope;
				this.snapshotValue = this.project();
				scope.subscribe(() => {
					this.publish();
				});
				this.pollMigration();
			}
			/** @returns the store the card's component reads through its bound selector. */
			bind() {
				return {
					getSnapshot: () => this.snapshotValue,
					subscribe: (listener) => {
						this.listeners.add(listener);
						return () => {
							this.listeners.delete(listener);
						};
					},
					set: (next) => {
						this.store(next);
					}
				};
			}
			/** @returns the edit, clear, save, and discard actions bound to this form. */
			actions() {
				return {
					editField: (field, text) => {
						this.drafts[field] = text;
						this.failed = false;
						this.refusal = void 0;
						this.publish();
					},
					clearField: (field) => {
						this.drafts[field] = "";
						this.failed = false;
						this.refusal = void 0;
						this.publish();
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (Object.keys(this.drafts).length === 0 && !this.failed) return;
						this.drafts = {};
						this.failed = false;
						this.refusal = void 0;
						this.publish();
					}
				};
			}
			/**
			* Write the staged edits, then re-seed from what the Host accepted.
			*
			* The Host is the only authority on acceptance — an empty draft clears the
			* field, anything else stores the trimmed text (so blanking a control and
			* saving is the same gesture as clearing it). A save that did not land keeps
			* its drafts so the user can correct it instead of retyping. A landed save
			* that moved the data directory starts the migration poll: the Host
			* relocates as a two-phase commit and the card shows the file progress
			* until it settles.
			*
			* A staged directory edit is vetted through the plugin's guard route
			* before anything writes, and re-checked when the write did not land: the
			* settings wire swallows a refused write (the bound scope recovers
			* silently), so the guard is the only channel that can name the refusal —
			* otherwise the card could only say "did not land".
			*/
			async save() {
				const edited = CARD_FIELDS.filter((field) => this.drafts[field] !== void 0);
				if (edited.length === 0 || this.saving) return;
				const intended = edited.map((field) => [field, this.drafts[field].trim()]);
				this.saving = true;
				this.failed = false;
				this.refusal = void 0;
				this.publish();
				const pathEdit = intended.find(([field]) => field === "path");
				if (pathEdit !== void 0) {
					const blocked = await this.guard(pathEdit[1]);
					if (blocked !== void 0) {
						this.saving = false;
						this.failed = true;
						this.refusal = blocked;
						this.publish();
						return;
					}
				}
				let landed = true;
				try {
					for (const [field, text] of intended) if (text === "") await this.scope.unset(field);
					else await this.scope.set(field, text);
					for (const [field, text] of intended) if (text === "" ? this.stored(field) : this.storedValue(field) !== text) {
						landed = false;
						break;
					}
				} catch (_settingsWriteFailure) {
					landed = false;
				}
				if (!landed && pathEdit !== void 0) {
					const blocked = await this.guard(pathEdit[1]);
					if (blocked !== void 0) this.refusal = blocked;
				}
				if (landed) for (const [field, _text] of intended) delete this.drafts[field];
				this.saving = false;
				this.failed = !landed;
				if (landed && intended.some(([field]) => field === "path")) this.pollMigration();
				this.publish();
			}
			/**
			* Ask the Host's guard route whether saving this directory would be refused
			* right now; a transport failure stays advisory (the write path's own
			* read-back still governs acceptance).
			* @param path - the staged path text ('' for the clear-to-default gesture).
			* @returns the refusal to show, or undefined when the save may proceed.
			*/
			async guard(path) {
				try {
					const response = await fetch(`${DIR_GUARD_PATH}?path=${encodeURIComponent(path)}`);
					if (!response.ok) return void 0;
					const body = await response.json();
					if (body.blocked === true && typeof body.interactingSessions === "number" && body.interactingSessions > 0) return {
						kind: "sessions-interacting",
						interactingSessions: body.interactingSessions
					};
				} catch (_guardFailure) {}
			}
			/**
			* Poll the Host's migration endpoint until it answers null (no migration
			* running), publishing each progress step.
			*/
			async pollMigration() {
				if (this.pollTimer !== void 0) return;
				const tick = async () => {
					let view;
					try {
						const response = await fetch(MIGRATION_PATH);
						if (response.ok) {
							const body = await response.json();
							if (body !== null && (body.phase === "copying" || body.phase === "cleaning") && typeof body.done === "number" && typeof body.total === "number") view = body;
						}
					} catch (_migrationPollFailure) {}
					if (view === void 0 && this.migrationView === void 0) {
						this.stopPolling();
						return;
					}
					if (view === void 0) this.stopPolling();
					this.migrationView = view;
					this.publish();
				};
				await tick();
				if (this.pollTimer === void 0 && this.migrationView !== void 0) this.pollTimer = setInterval(() => {
					tick();
				}, 300);
			}
			/** Stop the poll timer; the progress line leaves with the next publish. */
			stopPolling() {
				if (this.pollTimer !== void 0) {
					clearInterval(this.pollTimer);
					this.pollTimer = void 0;
				}
			}
			snapshot() {
				return this.scope.getSnapshot();
			}
			/** The raw user layer narrowed to a record; the wire answer is `unknown`. */
			userLayer() {
				const user = this.snapshot().user;
				return typeof user === "object" && user !== null ? user : void 0;
			}
			storedValue(field) {
				return this.userLayer()?.[field];
			}
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			/** The resolved (draft-free) text of one field; '' means inherited. */
			effectiveOf(field) {
				const value = this.snapshot().value?.[field];
				return typeof value === "string" ? value : "";
			}
			/** The effective (draft-or-resolved) text of one field; '' means inherited. */
			textOf(field) {
				return this.drafts[field] ?? this.effectiveOf(field);
			}
			project() {
				const snapshot = this.snapshot();
				const fields = {};
				const overridden = {};
				let dirty = false;
				for (const field of CARD_FIELDS) {
					fields[field] = this.textOf(field);
					overridden[field] = this.drafts[field] !== void 0 ? this.drafts[field].trim() !== "" : this.stored(field);
					if (this.drafts[field] !== void 0 && this.drafts[field] !== this.effectiveOf(field)) dirty = true;
				}
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					fields,
					overridden,
					dirty,
					saving: this.saving,
					failed: this.failed,
					refusal: this.refusal,
					migration: this.migrationView
				};
			}
			/** Replace the snapshot reference and notify, only when the fact moved. */
			store(next) {
				if (next === this.snapshotValue) return;
				this.snapshotValue = next;
				for (const listener of this.listeners) listener();
			}
			publish() {
				this.store(this.project());
			}
		};
		//#endregion
		//#region src/client/async-resource.ts
		/**
		* Shared async-resource state machine for the conversation-view consumers.
		* Every fetch-driven component repeats the same shape — three states
		* (`loading` / `error` / `ready`), a retry counter, and cancellation on
		* dependency change. Centralising the pattern here means a regression in
		* the cancellation logic lands in one spot instead of three.
		*
		* @module token-usage/client/async-resource
		*/
		/**
		* Drive one fetcher's lifecycle: reruns on dependency change, cancels the
		* previous attempt on a new fetch, and on retry-bump refetches even with
		* the same deps. `silentAfterFirst` keeps the previous value on screen —
		* the dashboard never blanks during a refresh once data is up.
		*
		* @param fetcher - the async loader; receives an `AbortSignal` for
		* cancellation. Throwing aborts the fetch (the next effect run triggers
		* a fresh attempt).
		* @param deps - the dependency list that retriggers a fetch (passed
		* through to React's effect; the retry counter joins the list).
		* @param options.silentAfterFirst - when true, the first fetch goes to
		* `loading` and subsequent refreshes keep the prior `value` on screen
		* until the new one lands.
		* @param options.retryToken - bumping this value triggers a refetch even
		* with unchanged deps (the consumer wires a "retry" button to it).
		* @returns `[state, retry]` — the current state plus a stable `retry()`
		* callback that bumps the internal counter and re-runs the effect.
		*/
		function useAsyncResource(fetcher, deps, options) {
			const silent = options.silentAfterFirst === true;
			const [state, setState] = (0, react.useState)({ status: "loading" });
			const loadedRef = (0, react.useRef)(false);
			const [retryTick, setRetryTick] = (0, react.useState)(0);
			const retry = (0, react.useCallback)(() => {
				setRetryTick((tick) => tick + 1);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				if (!silent || !loadedRef.current) setState({ status: "loading" });
				fetcher(controller.signal).then((value) => {
					if (controller.signal.aborted) return;
					loadedRef.current = true;
					setState({
						status: "ready",
						value
					});
				}).catch((error) => {
					if (controller.signal.aborted) return;
					if (silent && loadedRef.current) return;
					setState({
						status: "error",
						message: error instanceof Error ? error.message : String(error)
					});
				});
				return () => {
					controller.abort();
				};
			}, [
				...deps,
				options.retryToken,
				retryTick,
				silent
			]);
			return [state, retry];
		}
		/**
		* Return a value that lags behind its source by `delayMs` — a debounced
		* snapshot. The initial render already holds `value` (no null sentinel), so
		* a consumer can fetch immediately on mount without a second shot when the
		* first debounce window closes on the same value.
		*
		* @param value - the source value to debounce.
		* @param delayMs - the lag window in milliseconds.
		* @returns the debounced value.
		*/
		function useDebouncedValue(value, delayMs) {
			const [debounced, setDebounced] = (0, react.useState)(value);
			(0, react.useEffect)(() => {
				const timer = setTimeout(() => {
					setDebounced(value);
				}, delayMs);
				return () => {
					clearTimeout(timer);
				};
			}, [value, delayMs]);
			return debounced;
		}
		//#endregion
		//#region src/client/quota-format.ts
		/** Severity thresholds on the REMAINING share (percent) — the traffic-light
		* standard: above 60 reads green (plenty left), 20–60 yellow (watch it),
		* below 20 red (effectively gone). */
		const REMAIN_YELLOW = 60;
		const REMAIN_RED = 20;
		/** Whole-number percent, one decimal kept when it exists (`62%`, `87.5%`). */
		function formatQuotaPercent(value) {
			const rounded = Math.round(value * 10) / 10;
			return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`;
		}
		/** A money figure with its symbol: `$6.80` / `¥110.00`. */
		function formatQuotaMoney(value, unit) {
			return `${unit === "usd" ? "$" : "¥"}${value.toFixed(2)}`;
		}
		/**
		* The used share of one window, 0–100, whichever direction the provider
		* reported: the explicit `usedPercent`, else `remainingPercent` inverted,
		* else the balance fraction (`1 - remaining/max`). Undefined when the
		* window carries no computable ratio (a balance without a total).
		*/
		function quotaUsedPercent(window) {
			if (window.usedPercent !== void 0) return clampPercent(window.usedPercent);
			if (window.remainingPercent !== void 0) return clampPercent(100 - window.remainingPercent);
			if (window.remainingValue !== void 0 && window.maxValue !== void 0 && window.maxValue > 0) return clampPercent((1 - window.remainingValue / window.maxValue) * 100);
		}
		/**
		* The remaining share of one window, 0–100 — the severity input (severity
		* reads what is LEFT, not what is spent). Mirrors {@link quotaUsedPercent}'s
		* fallback chain in the opposite direction.
		*/
		function quotaRemainingPercent(window) {
			if (window.remainingPercent !== void 0) return clampPercent(window.remainingPercent);
			if (window.usedPercent !== void 0) return clampPercent(100 - window.usedPercent);
			if (window.remainingValue !== void 0 && window.maxValue !== void 0 && window.maxValue > 0) return clampPercent(window.remainingValue / window.maxValue * 100);
		}
		/** Map a remaining share (percent) to the traffic-light band: green above
		* 60, yellow 20–60, red below 20. A window with no computable ratio reads
		* by its absolute amount: an overdrawn/empty balance (≤ 0) is red,
		* anything else uncolored — a plain balance never paints alarm just for
		* lacking a total. */
		function quotaSeverityOf(window) {
			const remaining = quotaRemainingPercent(window);
			if (remaining === void 0) return window.remainingValue !== void 0 && window.remainingValue <= 0 ? "exhausted" : "ok";
			if (remaining < REMAIN_RED) return "exhausted";
			if (remaining <= REMAIN_YELLOW) return "warn";
			return "ok";
		}
		/**
		* The FINEST-granularity window of a payload — 5-hour over weekly over
		* monthly over balance. The trigger icon reads this one, not the worst
		* across windows: the finest unit is the constraint the session is
		* currently acting inside (a calm 5-hour window carries the icon even when
		* the weekly pool runs low). Undefined when there is no window at all.
		*/
		function finestQuotaWindow(windows) {
			const rank = {
				five_hour: 0,
				weekly: 1,
				monthly: 2,
				balance: 3
			};
			let pick;
			for (const window of windows) if (pick === void 0 || rank[window.tier] < rank[pick.tier]) pick = window;
			return pick;
		}
		/**
		* Fill share of the trigger ring, 0–1. Ratio windows map the remaining
		* percent; a funded balance without a total paints a full ring (the color
		* stays neutral — amounts tint only at ≤ 0); empty / overdrawn / missing
		* windows leave the track only.
		*/
		function quotaIconFillShare(window) {
			if (window === void 0) return 0;
			const remaining = quotaRemainingPercent(window);
			if (remaining !== void 0) return remaining / 100;
			if (window.remainingValue !== void 0 && window.remainingValue > 0) return 1;
			return 0;
		}
		/**
		* The trigger tooltip's figure for one window: the remaining share as a
		* percent when a ratio exists (any direction, or the balance fraction),
		* else the remaining amount (a ratio-less balance, the DeepSeek shape);
		* undefined when the window carries neither (nothing to show beyond the
		* plain label).
		*/
		function quotaTriggerFigure(window) {
			if (window === void 0) return void 0;
			const remaining = quotaRemainingPercent(window);
			if (remaining !== void 0) return formatQuotaPercent(remaining);
			if (window.remainingValue !== void 0) return formatQuotaMoney(window.remainingValue, window.unit ?? "cny");
		}
		/**
		* The reset countdown in the shell's compact shape: `2h 14m` under a day,
		* `48m` under an hour, `1d 3h` above; a non-positive remainder reads `0m`
		* (the next poll refreshes the stale window).
		* @param resetAt - epoch ms of the window's reset.
		* @param now - epoch ms the countdown is taken at.
		*/
		function formatResetCountdown(resetAt, now) {
			const minutes = Math.max(0, Math.floor((resetAt - now) / 6e4));
			if (minutes < 60) return `${String(minutes)}m`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
			return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
		}
		/** A wall-clock `HH:MM` stamp of an epoch-ms time (the "updated at" figure). */
		function formatQuotaClock(ms) {
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
		/** Clamp into 0–100. */
		function clampPercent(value) {
			return Math.min(100, Math.max(0, value));
		}
		//#endregion
		//#region src/client/use-color-scheme.ts
		/**
		* Shared browser-half hook: mirror the shell's root `color-scheme` onto a
		* plugin-owned root element. The shell sets the property on
		* `document.documentElement` only, so form controls inside plugin surfaces
		* render with the UA default (white) in dark mode; scoping the property to
		* the surface's root fixes selects, inputs, and dialogs without touching
		* anything outside it. Used by the settings section and the conversation
		* view tab.
		*
		* @module token-usage/client/use-color-scheme
		*/
		/**
		* Mirror the shell's `color-scheme` inline style onto the given root element.
		* @param rootRef - the surface's root element ref.
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
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\QuotaButton.module.css.mjs
		const css$7 = ".jYASuG_root{flex:none;display:inline-flex;position:relative}.jYASuG_trigger{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}.jYASuG_trigger svg{display:block}.jYASuG_trigger:hover,.jYASuG_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.jYASuG_trigger.jYASuG_icon-ok:hover,.jYASuG_trigger.jYASuG_icon-ok[aria-expanded=true]{color:var(--dsw-alias-state-success-primary)}.jYASuG_trigger.jYASuG_icon-warn:hover,.jYASuG_trigger.jYASuG_icon-warn[aria-expanded=true]{color:var(--dsw-alias-state-warn-primary)}.jYASuG_trigger.jYASuG_icon-exhausted:hover,.jYASuG_trigger.jYASuG_icon-exhausted[aria-expanded=true]{color:var(--dsw-alias-state-error-primary)}.jYASuG_icon-ok{color:var(--dsw-alias-state-success-primary)}.jYASuG_icon-warn{color:var(--dsw-alias-state-warn-primary)}.jYASuG_icon-exhausted{color:var(--dsw-alias-state-error-primary)}.jYASuG_panel{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:320px;max-width:calc(100vw - 32px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);text-align:left;cursor:default;border-radius:12px;padding:12px;font-size:12px;line-height:20px;position:absolute;bottom:calc(100% + 8px)}.jYASuG_header{justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px;display:flex}.jYASuG_title{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500;overflow:hidden}.jYASuG_plan{color:var(--dsw-alias-label-tertiary);font-weight:400}.jYASuG_updated{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;font-size:11px}.jYASuG_grid{grid-template-columns:repeat(var(--cols,3), 1fr);gap:14px;display:grid}.jYASuG_col{min-width:0}.jYASuG_label{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin-bottom:2px;font-size:11px;line-height:16px;overflow:hidden}.jYASuG_value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;margin-bottom:6px;font-size:13px;font-weight:600;line-height:18px}.jYASuG_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}.jYASuG_bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;overflow:hidden}.jYASuG_fill{border-radius:999px;height:100%;transition:width .3s}.jYASuG_ok{background:var(--dsw-alias-state-success-primary)}.jYASuG_warn{background:var(--dsw-alias-state-warn-primary)}.jYASuG_exhausted{background:var(--dsw-alias-state-error-primary)}.jYASuG_aux{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;margin-top:4px;font-size:11px;line-height:14px}.jYASuG_dot{vertical-align:middle;border-radius:50%;width:5px;height:5px;margin-right:3px;display:inline-block}.jYASuG_error{flex-direction:column;gap:8px;display:flex}.jYASuG_errorText{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-size:12px;line-height:18px}.jYASuG_retry{color:var(--dsw-alias-label-primary);cursor:pointer;text-underline-offset:2px;background:0 0;border:none;align-self:flex-start;padding:0;font-size:12px;text-decoration:underline}.jYASuG_retry:hover{color:var(--dsw-alias-brand-primary)}";
		const tagId$7 = "@laoyuehanni/dsh-token-usage/QuotaButton.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$7) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$7;
			tag.textContent = css$7;
			document.head.appendChild(tag);
		}
		var QuotaButton_module_css_default = {
			"aux": "jYASuG_aux",
			"bar": "jYASuG_bar",
			"col": "jYASuG_col",
			"dot": "jYASuG_dot",
			"error": "jYASuG_error",
			"errorText": "jYASuG_errorText",
			"exhausted": "jYASuG_exhausted",
			"fill": "jYASuG_fill",
			"grid": "jYASuG_grid",
			"header": "jYASuG_header",
			"icon-exhausted": "jYASuG_icon-exhausted",
			"icon-ok": "jYASuG_icon-ok",
			"icon-warn": "jYASuG_icon-warn",
			"label": "jYASuG_label",
			"meta": "jYASuG_meta",
			"ok": "jYASuG_ok",
			"panel": "jYASuG_panel",
			"plan": "jYASuG_plan",
			"retry": "jYASuG_retry",
			"root": "jYASuG_root",
			"title": "jYASuG_title",
			"trigger": "jYASuG_trigger",
			"updated": "jYASuG_updated",
			"value": "jYASuG_value",
			"warn": "jYASuG_warn"
		};
		//#endregion
		//#region src/client/QuotaButton.tsx
		/**
		* Input-bar quota button (browser half): a 28×28 round trigger registered
		* into the `conversation.input.right` slot (it renders left of the model
		* chip — the host's fixed tool-row order). The glyph is a remaining-share
		* ring (ContextMeter family) colored by the finest window. Clicking opens a
		* width-tiered popup (amount-only 200px / one progress bar 232px / two
		* bars 320px) centered on the button with the current provider's quota
		* windows: progress columns (5 小时 / 每周) for coding-plan providers, an
		* amount row for balance providers.
		*
		* The provider follows the model CHIP's live selection (the shell's
		* model-selection service reports the host's next selection before any
		* request is sent); without that service the host falls back to the last
		* request's provider, else the default selection.
		*
		* The button SELF-GATES: it renders nothing while the host cannot
		* determine a provider (`no-provider`), the provider has no quota adapter
		* (`unsupported`), or the feature is off (`disabled`) — switching
		* providers makes it appear again. A supported provider whose query fails
		* KEEPS the button and shows the error with a retry inside the panel.
		*
		* The hover tooltip reads provider name + the finest window's exact
		* remaining figure (percent, or the amount when no ratio exists).
		*
		* The interaction copies ContextMeter verbatim (click toggles, document
		* pointerdown outside closes, Escape closes); mutual exclusion with the
		* ContextMeter panel falls out of both components' outside-close
		* handlers — opening one closes the other on its next pointerdown.
		*
		* @module token-usage/client/QuotaButton
		*/
		/** The poll cadence fallback (seconds) while no payload has named one. */
		const DEFAULT_POLL_SEC = 60;
		/** Panel width tiers (px), by how much the windows paint: a lone amount
		* reads at a glance, one progress bar needs breathing room, two bars (the
		* 5-hour + weekly coding plans, or a long error body) the full plate. Kept
		* in sync with the CSS max-width clamp. */
		const PANEL_WIDTH_BALANCE = 200;
		const PANEL_WIDTH_SINGLE = 232;
		const PANEL_WIDTH_FULL = 320;
		const PANEL_VIEWPORT_MARGIN = 16;
		/** Tier → label key; the locale dictionaries carry both languages. */
		const TIER_LABEL_KEYS = {
			five_hour: "quota.tier.fiveHour",
			weekly: "quota.tier.weekly",
			monthly: "quota.tier.monthly",
			balance: "quota.tier.balance"
		};
		/**
		* Render the input-bar quota button for the active session's provider.
		* @param props - the framework session id, the locale seat, and the
		* optional model-directory holder (the chip's live selection).
		* @returns the trigger + panel, or null while hidden (see the module note).
		*/
		function QuotaButton({ sessionId, t, modelDirectory }) {
			const rootRef = (0, react.useRef)(null);
			useColorSchemeMirror(rootRef);
			const [open, setOpen] = (0, react.useState)(false);
			const [panelLeft, setPanelLeft] = (0, react.useState)(void 0);
			const measurePanelLeft = (0, react.useCallback)((width) => {
				const wrapper = rootRef.current;
				if (wrapper === null) return;
				const { left: wrapperLeft, width: wrapperWidth } = wrapper.getBoundingClientRect();
				const panelWidth = Math.min(width, window.innerWidth - 32);
				const desired = (wrapperWidth - panelWidth) / 2;
				const minLeft = PANEL_VIEWPORT_MARGIN - wrapperLeft;
				const maxLeft = window.innerWidth - PANEL_VIEWPORT_MARGIN - panelWidth - wrapperLeft;
				setPanelLeft(Math.min(Math.max(desired, minLeft), Math.max(minLeft, maxLeft)));
			}, []);
			const modelService = modelDirectory?.service;
			const readChipProvider = () => {
				if (sessionId === "" || modelService === void 0) return void 0;
				try {
					return modelService.directoryFor(sessionId).store.getSnapshot().current?.provider ?? void 0;
				} catch {
					return;
				}
			};
			const [chipProvider, setChipProvider] = (0, react.useState)(readChipProvider);
			(0, react.useEffect)(() => {
				setChipProvider(readChipProvider());
				if (sessionId === "" || modelService === void 0) return;
				let directory;
				try {
					directory = modelService.directoryFor(sessionId);
				} catch {
					return;
				}
				return directory.store.subscribe(() => {
					setChipProvider(readChipProvider());
				});
			}, [sessionId, modelService]);
			const [resource, retry] = useAsyncResource((signal) => fetchQuotaPayload(sessionId, chipProvider, signal), [sessionId, chipProvider], {
				silentAfterFirst: true,
				retryToken: 0
			});
			const payload = resource.status === "ready" ? resource.value : null;
			const panelWidth = panelWidthOf(payload);
			const pollMs = (payload?.intervalSec ?? DEFAULT_POLL_SEC) * 1e3;
			(0, react.useEffect)(() => {
				const timer = setInterval(retry, pollMs);
				return () => {
					clearInterval(timer);
				};
			}, [pollMs, retry]);
			const visible = payload !== null && (payload.status === "ok" || payload.status === "error");
			(0, react.useEffect)(() => {
				if (!visible && open) setOpen(false);
			}, [visible, open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onViewportChange = () => {
					measurePanelLeft(panelWidth);
				};
				measurePanelLeft(panelWidth);
				window.addEventListener("resize", onViewportChange);
				window.addEventListener("scroll", onViewportChange, true);
				return () => {
					window.removeEventListener("resize", onViewportChange);
					window.removeEventListener("scroll", onViewportChange, true);
				};
			}, [
				open,
				panelWidth,
				measurePanelLeft
			]);
			if (!visible || payload === null) return null;
			const finest = finestQuotaWindow(payload.status === "ok" ? payload.windows : []);
			const severity = finest === void 0 ? "ok" : quotaSeverityOf(finest);
			const triggerClass = [QuotaButton_module_css_default.trigger];
			if (severity === "warn") triggerClass.push(QuotaButton_module_css_default["icon-warn"]);
			else if (severity === "exhausted") triggerClass.push(QuotaButton_module_css_default["icon-exhausted"]);
			else if (finest !== void 0 && quotaRemainingPercent(finest) !== void 0) triggerClass.push(QuotaButton_module_css_default["icon-ok"]);
			const triggerClassName = triggerClass.join(" ").trim();
			const figure = quotaTriggerFigure(finest);
			const triggerTip = figure === void 0 ? t("quota.trigger") : t("quota.triggerSummary", {
				name: payload.providerName ?? payload.provider,
				figure
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				className: QuotaButton_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: triggerTip,
					side: "top",
					delayMs: 200,
					disabled: open,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: triggerClassName,
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						"aria-label": t("quota.trigger"),
						onClick: () => {
							if (!open) {
								retry();
								measurePanelLeft(panelWidth);
							}
							setOpen(!open);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaGlyph, { share: quotaIconFillShare(finest) })
					})
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QuotaButton_module_css_default.panel,
					role: "dialog",
					"aria-label": t("quota.panel"),
					style: {
						width: `${String(panelWidth)}px`,
						...panelLeft === void 0 ? {} : { left: `${String(panelLeft)}px` }
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QuotaButton_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QuotaButton_module_css_default.title,
							children: [payload.providerName ?? payload.provider, payload.status === "ok" && payload.planTier !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: QuotaButton_module_css_default.plan,
								children: [" · ", payload.planTier]
							}) : null]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QuotaButton_module_css_default.updated,
							children: t("quota.updatedAt", { time: formatQuotaClock(payload.fetchedAt) })
						})]
					}), payload.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QuotaButton_module_css_default.error,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QuotaButton_module_css_default.errorText,
							children: errorText(payload.error, t)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QuotaButton_module_css_default.retry,
							onClick: retry,
							children: t("quota.retry")
						})]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: QuotaButton_module_css_default.grid,
						style: { "--cols": String(Math.min(payload.windows.length, 3)) },
						children: payload.windows.map((window, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaColumn, {
							window,
							t
						}, `${window.tier}:${String(index)}`))
					})]
				})]
			});
		}
		/** Ring geometry matches ContextMeter: 14px viewBox, r 5.5, 2px stroke.
		* Circumference feeds the remaining-share dasharray, starting at 12
		* o'clock. A 0 share omits the fill stroke — a round cap at 0 would still
		* paint a dot. */
		const RING_R = 5.5;
		const RING_C = 2 * Math.PI * RING_R;
		/** Round caps paint half a stroke width beyond each dash end; their
		* combined reach is what the dash compensation subtracts, so the painted
		* arc (dash + caps) equals the nominal share and the caps cannot seal the
		* 12-o'clock gap. */
		const RING_CAP_REACH = 2;
		/** The trigger glyph: a ContextMeter-family donut whose fill arc is the
		* remaining share of the finest window. Color comes from the button's
		* severity class (`currentColor`); this only draws the arc. */
		function QuotaGlyph({ share }) {
			const clamped = Math.min(1, Math.max(0, share));
			const nominal = clamped * RING_C;
			const dashLen = clamped >= 1 ? RING_C : nominal <= RING_CAP_REACH ? nominal : nominal - RING_CAP_REACH;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 14 14",
				width: "14",
				height: "14",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "7",
					cy: "7",
					r: RING_R,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					opacity: "0.22"
				}), clamped > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "7",
					cy: "7",
					r: RING_R,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					strokeLinecap: clamped < 1 ? "round" : "butt",
					strokeDasharray: `${dashLen.toFixed(3)} ${RING_C.toFixed(3)}`,
					transform: "rotate(-90 7 7)"
				}) : null]
			});
		}
		/** One progress column: label / value / bar / aux. The value and the bar
		* both carry the REMAINING share (the traffic-light standard reads what is
		* left), colored by severity. */
		function QuotaColumn({ window, t }) {
			const remaining = quotaRemainingPercent(window);
			const severity = quotaSeverityOf(window);
			const label = t(TIER_LABEL_KEYS[window.tier]);
			let value;
			let meta;
			if (window.tier === "balance" && window.remainingValue !== void 0) {
				const unit = window.unit ?? "cny";
				value = formatQuotaMoney(window.remainingValue, unit);
				if (window.maxValue !== void 0) meta = `/ ${formatQuotaMoney(window.maxValue, unit)}`;
			} else value = remaining !== void 0 ? formatQuotaPercent(remaining) : "—";
			const aux = window.resetAt !== void 0 ? t("quota.resetIn", { time: formatResetCountdown(window.resetAt, Date.now()) }) : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QuotaButton_module_css_default.col,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: QuotaButton_module_css_default.label,
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QuotaButton_module_css_default.value,
						children: [value, meta !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QuotaButton_module_css_default.meta,
							children: [" ", meta]
						}) : null]
					}),
					remaining !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: QuotaButton_module_css_default.bar,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `${QuotaButton_module_css_default.fill} ${QuotaButton_module_css_default[severity]}`,
							style: { width: `${String(Math.round(remaining))}%` }
						})
					}),
					aux !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QuotaButton_module_css_default.aux,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `${QuotaButton_module_css_default.dot} ${QuotaButton_module_css_default[severity]}` }), aux]
					})
				]
			});
		}
		/** The panel's width tier for one payload: what the windows PAINT decides —
		* a lone amount (no computable bar, the DeepSeek shape) reads at the
		* minimal plate, one bar (a weekly-only plan, or a balance with a spend
		* total like OpenRouter) the middle one, two or more bars the full plate.
		* Errors and payloads without windows read the full plate (their copy
		* runs long). */
		function panelWidthOf(payload) {
			if (payload === null || payload.status !== "ok") return PANEL_WIDTH_FULL;
			const bars = payload.windows.filter((window) => quotaUsedPercent(window) !== void 0).length;
			if (bars === 0) return payload.windows.length > 0 ? PANEL_WIDTH_BALANCE : PANEL_WIDTH_FULL;
			return bars === 1 ? PANEL_WIDTH_SINGLE : PANEL_WIDTH_FULL;
		}
		/** Friendly locale copy for one normalized query error. */
		function errorText(error, t) {
			switch (error.kind) {
				case "auth": return t("quota.error.auth", { message: error.message });
				case "no-credential": return t("quota.error.noCredential", { ref: error.message });
				case "http": return t("quota.error.http", { message: error.message });
				case "network": return t("quota.error.network", { message: error.message });
				case "parse": return t("quota.error.parse", { message: error.message });
			}
		}
		/** Defensive shape check: a misrouted response must not paint the button. */
		function looksLikeQuotaPayload(value) {
			return typeof value === "object" && value !== null && typeof value.status === "string" && typeof value.intervalSec === "number";
		}
		/**
		* Fetch the quota payload for the active session, naming the chip-selected
		* provider when one is known. Throws on transport failure or a payload that
		* does not look like one, so the hook can keep the previous render
		* (silentAfterFirst) or stay hidden (first failure).
		*/
		async function fetchQuotaPayload(sessionId, provider, signal) {
			const params = new URLSearchParams();
			if (sessionId !== "") params.set("session", sessionId);
			if (provider !== void 0 && provider !== "") params.set("provider", provider);
			const encoded = params.toString();
			const query = encoded === "" ? "" : `?${encoded}`;
			const response = await fetch(QUOTA_PATH + query, {
				headers: { accept: "application/json" },
				signal
			});
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			const value = await response.json();
			if (!looksLikeQuotaPayload(value)) throw new Error("unexpected quota response");
			return value;
		}
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
		/** Hit-rate thresholds (inclusive lower bound, exclusive upper). Boundary
		* values sit in the higher tier: 0.60 is `amber`, 0.80 is `lime`, 0.95
		* is `healthy`. The numbers are guideposts, not hard cutoffs — a 78%
		* cache hit rate is still in `amber`, exactly because cache misses at
		* ~1/5 of requests is worth flagging. */
		const HIT_RATE_AMBER = .6;
		const HIT_RATE_LIME = .8;
		const HIT_RATE_HEALTHY = .95;
		/** Map a 0-1 fraction to one of the four chip color buckets. */
		function bandOf(hitRate) {
			if (hitRate >= HIT_RATE_HEALTHY) return "healthy";
			if (hitRate >= HIT_RATE_LIME) return "lime";
			if (hitRate >= HIT_RATE_AMBER) return "amber";
			return "critical";
		}
		/**
		* Compute the cache hit rate's display shape in one pass.
		* @param totals - the aggregated totals.
		* @returns `{ text, band }` — `text` is `—` for an empty denominator,
		* `band` defaults to `amber` so an unused session reads as a mild
		* "no signal yet" (neither alarming nor celebratory).
		*/
		function hitRateDisplay(totals) {
			const served = totals.inputTokens + totals.cacheReadTokens;
			if (served === 0) return {
				text: "—",
				band: "amber"
			};
			const rate = totals.cacheReadTokens / served;
			return {
				text: `${percent(rate * 100)}%`,
				band: bandOf(rate)
			};
		}
		/** The RMB display view: amounts render as stored. */
		const CNY_VIEW = {
			symbol: "¥",
			rate: 1
		};
		/**
		* The display view of one stats summary: USD when the region pick says so
		* (amounts ÷ `usdExchangeRate`, `$` prefix), else RMB as stored.
		* @param summary - the stats payload (its `currency`/`usdExchangeRate` fields).
		* @returns the view the format functions render through.
		*/
		function currencyViewOf(summary) {
			return summary.currency === "USD" ? {
				symbol: "$",
				rate: summary.usdExchangeRate
			} : CNY_VIEW;
		}
		/**
		* Cost as display text: the view's symbol plus two decimals, following the
		* analyzer's cost formatting (`¥1.25`, `$0.18`). A cost is always shown,
		* never omitted. USD divides the wire's RMB amount by the exchange rate.
		* @param cost - a non-negative cost in ¥ (as carried on the wire).
		* @param view - the display currency view.
		* @returns e.g. `¥1.25`, or `$0.18` under a rate-7 USD view.
		*/
		function formatCost(cost, view = CNY_VIEW) {
			return `${view.symbol}${(cost / view.rate).toFixed(2)}`;
		}
		/**
		* A per-million-token rate as display text, converted through the view:
		* integral rates stay bare (`8`, `$1.14`-style conversion applied first for
		* USD), fractional ones keep up to four decimals with trailing zeros
		* stripped and a two-decimal minimum (`0.50`, `0.25`, `0.025`). The caller
		* appends the `/M` unit and the view's symbol where needed.
		* @param rate - a non-negative rate in ¥ per million tokens.
		* @param view - the display currency view.
		* @returns the display string (symbol-less, converted for USD).
		*/
		function formatRate(rate, view = CNY_VIEW) {
			const converted = rate / view.rate;
			if (Number.isInteger(converted)) return String(converted);
			let s = converted.toFixed(4);
			const dot = s.indexOf(".");
			s = s.replace(/0+$/u, "");
			if (s.endsWith(".")) s += "00";
			const minEnd = dot + 3;
			while (s.length < minEnd) s += "0";
			return s;
		}
		/**
		* A per-million-token rate as complete display text: the view's symbol plus
		* {@link formatRate}'s converted number — what the pricing table cells render.
		* @param rate - a non-negative rate in ¥ per million tokens.
		* @param view - the display currency view.
		* @returns e.g. `¥8`, or `$1.1429` under a rate-7 USD view.
		*/
		function formatRateWithSymbol(rate, view = CNY_VIEW) {
			return `${view.symbol}${formatRate(rate, view)}`;
		}
		/**
		* Average first-token latency in the shell's compact duration shape:
		* one decimal under a minute (`45.2s`), `2m42s` from there on.
		* @param ms - total first-token latency.
		* @returns the display string.
		*/
		function formatTtft(ms) {
			const s = ms / 1e3;
			if (s < 60) return `${String(Math.round(s * 10) / 10)}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}
		/**
		* Decode-throughput display figure in the shell's shape: whole tokens from
		* ten up, one decimal below (the `tok/s` unit lives in the locale template).
		* @param tokensPerSecond - tokens per second.
		* @returns the display number.
		*/
		function formatSpeed(tokensPerSecond) {
			const clamped = Math.max(0, tokensPerSecond);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\hit-rate-band.module.css.mjs
		const css$6 = ".t6JM8a_band_critical{color:var(--dsw-alias-state-error-primary,#dc2626)}.t6JM8a_band_amber{color:#f59e0b}.t6JM8a_band_lime{color:#84cc16}.t6JM8a_band_healthy{color:var(--dsw-alias-state-success-primary,#16a34a)}";
		const tagId$6 = "@laoyuehanni/dsh-token-usage/hit-rate-band.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$6) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$6;
			tag.textContent = css$6;
			document.head.appendChild(tag);
		}
		var hit_rate_band_module_css_default = {
			"band_amber": "t6JM8a_band_amber",
			"band_critical": "t6JM8a_band_critical",
			"band_healthy": "t6JM8a_band_healthy",
			"band_lime": "t6JM8a_band_lime"
		};
		//#endregion
		//#region src/client/HitRateText.tsx
		/** CSS-module class for one hit-rate colour bucket. */
		function bandClassOf(band) {
			return hit_rate_band_module_css_default[`band_${band}`] ?? "";
		}
		/**
		* Render a hit-rate percentage (or `—`) in its threshold colour.
		* @param totals - the aggregated token buckets the rate is computed from.
		*/
		function HitRateText({ totals }) {
			const { text, band } = hitRateDisplay(totals);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: bandClassOf(band),
				children: text
			});
		}
		//#endregion
		//#region src/client/session-stats.ts
		/** Build a session-parent → direct-subagent-children index in one O(n) pass:
		* every session whose `origin === 'subagent'` lands in its `parentId`'s
		* bucket, in iteration order (so the result matches {@link directSubagentIds}).
		* @param rows - the retained session-summary mirror.
		* @returns the immutable child index.
		*/
		function buildChildIndex(rows) {
			const index = /* @__PURE__ */ new Map();
			for (const [id, summary] of Object.entries(rows)) {
				if (summary.origin !== "subagent" || summary.parentId === void 0) continue;
				const bucket = index.get(summary.parentId);
				if (bucket === void 0) index.set(summary.parentId, [id]);
				else bucket.push(id);
			}
			return index;
		}
		/** Look up the direct subagent children of one session. Falls back to a
		* fresh {@link buildChildIndex} when the caller has no cached index. */
		function directSubagentIds(rows, parentId, index) {
			if (index !== void 0) return index.get(parentId) ?? [];
			return buildChildIndex(rows).get(parentId) ?? [];
		}
		/**
		* The whole subagent subtree of one session, including the root itself,
		* using the parent → children index for an O(n) walk regardless of depth.
		* Cycles are bounded by a `seen` set (a depth-first traversal visits each
		* id once), so a self-referential or cyclic record set returns the root
		* alone. Stacks are reversed after pushing so siblings come back out in
		* insertion order, matching the runtime's lineage index.
		* @param rows - the retained session-summary mirror (unused when the
		* caller already built an index).
		* @param rootId - the scope's root session id.
		* @param index - optional precomputed index from {@link buildChildIndex}.
		* @returns the root and its subagent descendants, depth-first.
		*/
		function subtreeIds(rows, rootId, index = buildChildIndex(rows)) {
			const out = [rootId];
			if (!index.has(rootId) && rows[rootId] === void 0) return out;
			const seen = /* @__PURE__ */ new Set([rootId]);
			const stack = [];
			const seedChildren = index.get(rootId) ?? [];
			for (let i = seedChildren.length - 1; i >= 0; i -= 1) stack.push(seedChildren[i]);
			while (stack.length > 0) {
				const current = stack.pop();
				if (seen.has(current)) continue;
				seen.add(current);
				out.push(current);
				const children = index.get(current) ?? [];
				for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
			}
			return out;
		}
		/**
		* The immediate subagent parent of one session, when the record names one.
		* The check is on `parentId` rather than `origin` so a mirrored summary that
		* lost its origin tag still answers its lineage — the index is built once
		* per render and shared across all three helpers via {@link ChildIndex}.
		* @param rows - the retained session-summary mirror.
		* @param id - the current focus session id.
		* @returns the parent session id, or undefined when the record has no
		* parent link (a top-level session or an ordinary fork).
		*/
		function subagentParentOf(rows, id) {
			const parent = rows[id]?.parentId;
			return parent === void 0 || parent === id ? void 0 : parent;
		}
		/**
		* Sum one or more `SessionStatsProjection` values over a scope. A scope with
		* no value at all yields `undefined` — the view renders an em-dash for an
		* absent capability. The `contributing` count lets the caller tell
		* "every scope session was empty" apart from "the scope itself was empty".
		* @param values - the per-session projection values (typically drawn from
		* the mirror + the live hook).
		* @returns the summed buckets plus the contributing count, or undefined
		* when no projection was present.
		*/
		function aggregateProjections(values) {
			let ttftMs = 0;
			let ttftSteps = 0;
			let decodeMs = 0;
			let decodeTokens = 0;
			let contributing = 0;
			for (const stats of values) {
				if (stats === void 0) continue;
				contributing += 1;
				ttftMs += stats.ttftMs;
				ttftSteps += stats.ttftSteps;
				decodeMs += stats.decodeMs;
				decodeTokens += stats.decodeTokens;
			}
			if (contributing === 0) return void 0;
			return {
				ttftMs,
				ttftSteps,
				decodeMs,
				decodeTokens,
				contributing
			};
		}
		/**
		* Compact fingerprint of one session's retained stats projection — bumps on
		* every finished request step (same signal that drives TTFT / throughput).
		*/
		function sessionStatsFingerprint(stats) {
			if (stats === void 0) return "-";
			return [
				stats.steps,
				stats.ttftSteps,
				stats.decodeTokens,
				stats.turns
			].join(".");
		}
		/**
		* Build a debounce key from mirror `updatedAt` plus `sessionStats` churn.
		* The active session reads live projection values from `useProjection`; every
		* other scoped id reads the mirror copy.
		*/
		function buildStatsFreshnessKey(ids, options) {
			return ids.map((id) => {
				const row = options.rows[id];
				const stats = id === options.activeSessionId ? options.liveSessionStats ?? row?.projectionValues?.sessionStats : row?.projectionValues?.sessionStats;
				return `${id}:${String(row?.updatedAt ?? 0)}:${sessionStatsFingerprint(stats)}`;
			}).join(",");
		}
		//#endregion
		//#region src/client/cost-inflate-motion.ts
		/** The user's motion preference: both runners refuse to animate (returning
		* null) when the OS asks for reduced motion. Exported so the chip hook can
		* skip spawning the DOM for flies that would never animate — a static +Δ
		* flash reads as a glitch, not information. */
		function motionAllowed() {
			return typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		}
		function waapiAvailable(el) {
			return typeof el.animate === "function";
		}
		/** Scale bounce on the cost figure (`costPop`). */
		function runCostPop(el, v) {
			if (!motionAllowed() || !waapiAvailable(el)) return null;
			const popScale = Number(v.popScale);
			const echo = 1 + (popScale - 1) * .28;
			const warnMix = v.warnMix;
			return el.animate([
				{
					transform: "scale(1)",
					color: "var(--dsw-alias-label-primary)"
				},
				{
					transform: `scale(${String(popScale)})`,
					color: `color-mix(in srgb, var(--dsw-alias-state-warn-primary) ${warnMix}, var(--dsw-alias-label-primary))`,
					offset: .35
				},
				{
					transform: `scale(${String(echo)})`,
					color: `color-mix(in srgb, var(--dsw-alias-state-warn-primary) ${warnMix}, var(--dsw-alias-label-primary))`,
					offset: .7
				},
				{
					transform: "scale(1)",
					color: "var(--dsw-alias-label-primary)"
				}
			], {
				duration: v.inflateMs,
				easing: "cubic-bezier(0.25, 0.85, 0.35, 1)",
				fill: "both"
			});
		}
		/** +Δ label rise (`deltaRise`). Caller must position the element (absolute). */
		function runDeltaFly(el, v) {
			if (!motionAllowed() || !waapiAvailable(el)) return null;
			return el.animate([
				{
					opacity: 0,
					transform: "translate(-50%, -20%)"
				},
				{
					opacity: 1,
					transform: "translate(-50%, -20%)",
					offset: .15
				},
				{
					opacity: 0,
					transform: `translate(calc(-50% + ${v.flyX}), calc(-100% - ${v.flyY}))`
				}
			], {
				duration: v.inflateMs,
				easing: "cubic-bezier(0.22, 0.55, 0.25, 1)",
				fill: "both"
			});
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\SessionStatsChip.module.css.mjs
		const css$5 = ".d5ISLa_strip{border:1px solid var(--dsw-alias-border-l2);font-variant-numeric:tabular-nums;background:0 0;border-radius:14px;flex:none;align-items:stretch;min-width:0;height:28px;font-size:12px;line-height:18px;display:inline-flex;overflow:hidden}.d5ISLa_stripFlyOverflow{z-index:2;position:relative;overflow:visible}.d5ISLa_cell{color:var(--dsw-alias-label-primary);white-space:nowrap;align-items:center;padding:0 10px;display:inline-flex}.d5ISLa_cell+.d5ISLa_cell{border-left:1px solid var(--dsw-alias-border-l1)}.d5ISLa_cellHit{font-weight:500}.d5ISLa_costCell{z-index:1;position:relative;overflow:visible}.d5ISLa_costInner{transform-origin:50%;z-index:2;justify-content:center;align-items:center;display:inline-flex;position:relative}.d5ISLa_deltaLayer{pointer-events:none;z-index:3;position:absolute;inset:0;overflow:visible}.d5ISLa_deltaFly{color:var(--dsw-alias-state-warn-primary);font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;text-shadow:0 0 8px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);font-size:11px;font-weight:600;position:absolute;top:0;left:50%;transform:translate(-50%,-100%)}@media (prefers-reduced-motion:reduce){.d5ISLa_deltaFly{display:none}}@media (width<=560px){.d5ISLa_strip{font-size:11px}.d5ISLa_cell{padding:0 7px}}";
		const tagId$5 = "@laoyuehanni/dsh-token-usage/SessionStatsChip.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$5;
			tag.textContent = css$5;
			document.head.appendChild(tag);
		}
		var SessionStatsChip_module_css_default = {
			"cell": "d5ISLa_cell",
			"cellHit": "d5ISLa_cellHit",
			"costCell": "d5ISLa_costCell",
			"costInner": "d5ISLa_costInner",
			"deltaFly": "d5ISLa_deltaFly",
			"deltaLayer": "d5ISLa_deltaLayer",
			"strip": "d5ISLa_strip",
			"stripFlyOverflow": "d5ISLa_stripFlyOverflow"
		};
		//#endregion
		//#region src/client/CostDeltaFlyLabel.tsx
		/** One +Δ fly label; animation starts on mount via WAAPI. */
		function CostDeltaFlyLabel({ text, vars }) {
			const ref = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const el = ref.current;
				if (el === null) return;
				const anim = runDeltaFly(el, vars);
				if (anim === null) {
					el.style.visibility = "hidden";
					return;
				}
				return () => {
					anim.cancel();
				};
			}, [vars]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				ref,
				className: SessionStatsChip_module_css_default["deltaFly"],
				children: text
			});
		}
		//#endregion
		//#region src/client/cost-inflate.ts
		const MISS_RATE_CAP = .55;
		const OUT_CAP = 32e3;
		/** Clamp to the unit interval. */
		function clamp01(n) {
			return Math.max(0, Math.min(1, n));
		}
		/** Token totals of one refresh minus the previous snapshot (non-negative). */
		function deltaTotals(prev, next) {
			return {
				requests: Math.max(0, next.requests - prev.requests),
				inputTokens: Math.max(0, next.inputTokens - prev.inputTokens),
				outputTokens: Math.max(0, next.outputTokens - prev.outputTokens),
				cacheReadTokens: Math.max(0, next.cacheReadTokens - prev.cacheReadTokens),
				cacheWriteTokens: Math.max(0, next.cacheWriteTokens - prev.cacheWriteTokens)
			};
		}
		/**
		* Single-step intensity from the latest request's token delta (not session
		* cumulative hit rate): `I = clamp01(0.55·norm(miss) + 0.45·norm(output))`.
		*/
		function computeIntensityFromDelta(delta) {
			const served = delta.inputTokens + delta.cacheReadTokens;
			const miss = clamp01((1 - (served > 0 ? delta.cacheReadTokens / served : .5)) / MISS_RATE_CAP);
			const out = clamp01(delta.outputTokens / OUT_CAP);
			return clamp01(.55 * miss + .45 * out);
		}
		function lerp(a, b, t) {
			return a + (b - a) * t;
		}
		/** Map step intensity I to animation parameters. */
		function animVars(I) {
			return {
				inflateMs: Math.round(lerp(1e3, 1800, I)),
				popScale: lerp(1.08, 1.32, I).toFixed(3),
				warnMix: `${Math.round(lerp(0, 55, I))}%`,
				flyY: `${lerp(22, 38, I).toFixed(1)}px`,
				flyX: `${((Math.random() - .5) * 10).toFixed(1)}px`
			};
		}
		//#endregion
		//#region src/client/use-cost-inflate.ts
		/**
		* Request-driven cost-cell inflate animation for SessionStatsChip: detects
		* new usage from summary deltas and drives WAAPI motion on the cost figure
		* and ephemeral +Δ fly labels.
		*
		* @module token-usage/client/use-cost-inflate
		*/
		const MIN_WIRE_DELTA_COST = 5e-4;
		function hasUsageChurn(prev, summary) {
			const delta = deltaTotals(prev.totals, summary.total);
			if (delta.requests > 0) return true;
			if (summary.totalCost - prev.totalCost > MIN_WIRE_DELTA_COST) return true;
			return totalTokens(delta) > 0;
		}
		/**
		* Hook the chip uses to play costPop + deltaRise on each new request.
		* @param scopeKey - changes reset the diff baseline.
		* @param costRef - the live cost figure span (WAAPI target).
		*/
		function useCostInflate(scopeKey, costRef) {
			const prevRef = (0, react.useRef)(null);
			const flyIdRef = (0, react.useRef)(0);
			const timersRef = (0, react.useRef)([]);
			const flyCountRef = (0, react.useRef)(0);
			const popAnimRef = (0, react.useRef)(null);
			const [flies, setFlies] = (0, react.useState)([]);
			const [flyOverflow, setFlyOverflow] = (0, react.useState)(false);
			const clearTimers = (0, react.useCallback)(() => {
				for (const id of timersRef.current) window.clearTimeout(id);
				timersRef.current = [];
			}, []);
			const schedule = (0, react.useCallback)((fn, ms) => {
				const id = window.setTimeout(fn, ms);
				timersRef.current.push(id);
			}, []);
			const reset = (0, react.useCallback)(() => {
				clearTimers();
				popAnimRef.current?.cancel();
				popAnimRef.current = null;
				prevRef.current = null;
				flyIdRef.current = 0;
				flyCountRef.current = 0;
				setFlies([]);
				setFlyOverflow(false);
			}, [clearTimers]);
			(0, react.useEffect)(() => {
				reset();
			}, [scopeKey, reset]);
			(0, react.useEffect)(() => () => {
				clearTimers();
			}, [clearTimers]);
			const maybeClearOverflow = (0, react.useCallback)(() => {
				if (flyCountRef.current <= 0) setFlyOverflow(false);
			}, []);
			const playCostPop = (0, react.useCallback)((v) => {
				const el = costRef.current;
				if (el === null) return;
				popAnimRef.current?.cancel();
				popAnimRef.current = runCostPop(el, v);
			}, [costRef]);
			return {
				flies,
				flyOverflow,
				onSummary: (0, react.useCallback)((summary) => {
					const nextSnapshot = {
						totals: summary.total,
						totalCost: summary.totalCost
					};
					const prev = prevRef.current;
					prevRef.current = nextSnapshot;
					if (prev === null) return;
					if (!hasUsageChurn(prev, summary)) return;
					if (!motionAllowed()) return;
					const v = animVars(computeIntensityFromDelta(deltaTotals(prev.totals, summary.total)));
					setFlyOverflow(true);
					window.requestAnimationFrame(() => {
						playCostPop(v);
					});
					const wireDeltaCost = summary.totalCost - prev.totalCost;
					if (wireDeltaCost > MIN_WIRE_DELTA_COST) {
						const view = currencyViewOf(summary);
						const text = `+${view.symbol}${(wireDeltaCost / view.rate).toFixed(2)}`;
						const id = ++flyIdRef.current;
						flyCountRef.current += 1;
						setFlies((current) => [...current, {
							id,
							text,
							vars: v
						}]);
						schedule(() => {
							flyCountRef.current -= 1;
							setFlies((current) => current.filter((fly) => fly.id !== id));
							maybeClearOverflow();
						}, v.inflateMs + 40);
					} else schedule(maybeClearOverflow, v.inflateMs + 40);
				}, [
					maybeClearOverflow,
					playCostPop,
					schedule
				]),
				reset
			};
		}
		//#endregion
		//#region src/client/SessionStatsChip.tsx
		/**
		* Session-header stats chip (browser half): a one-line compact strip rendered
		* into the `conversation.session.header.utilities` slot — three sub-chips
		* (total tokens / cache hit rate / session cost) beside the Session log
		* button. Data comes from `/token-usage/stats?fields=chip` scoped to the
		* active session and its subagent subtree (the Usage tab's "with
		* subagents" range), so a parent that spawned children shows the same
		* folded numbers the header is meant to summarise. Numbers refresh at
		* REQUEST granularity (same cadence as the Usage tab): `sessionStats`
		* projection churn (plus mirror `updatedAt` when present) is debounced
		* into one fetch, so idle sessions do not poll and a finished request
		* updates the header within ~250 ms. When cost
		* rises on a new request, the cost cell plays `costPop` (scale bounce) and
		* `deltaRise` (+Δ fly); reduced-motion users get silent figure updates
		* instead. A failed FIRST fetch retries itself on a 3 s cadence — the old
		* poll's safety net — so an idle-but-used session still gets its chip.
		*
		* Visibility contract: a session with no recorded requests renders nothing
		* (an empty header strip is worse than no strip; the chip never blanks to
		* "—"). Hit-rate colour is the four-bucket mapping in `format.hitRateDisplay`:
		* ≥95% healthy (green), 80–95% lime, 60–80% amber, below 60% critical (red).
		* Amber/lime fill the warm→cool gap so the four stops read as one progression.
		*
		* @module token-usage/client/SessionStatsChip
		*/
		/** Refresh debounce: bursts of session-mirror updates (one request's events)
		* collapse into a single fetch, matching the Usage tab's request-scale
		* cadence instead of a steady poll. */
		const REFRESH_DEBOUNCE_MS$1 = 250;
		/** Self-heal cadence after a failed first fetch. With the poll gone, this
		* retry is the only thing that recovers an idle session's chip: refresh
		* failures after the first land keep the prior figures (silent mode) and
		* self-heal on the next request churn, so they never reach the error state. */
		const FETCH_FAILURE_RETRY_MS = 3e3;
		/**
		* Render the session-header stats chip for the active session. Renders
		* nothing when the session has no recorded usage, when the fetch fails, or
		* while the first fetch is in flight — the spec's "data has no value, the
		* block does not render" rule.
		* @param props - framework session id, the session-list mirror, and the locale seat.
		* @returns the chip strip, or null when the data is empty/unavailable.
		*/
		function SessionStatsChip({ sessionId, useSessions, useProjection, t }) {
			const rootRef = (0, react.useRef)(null);
			const costRef = (0, react.useRef)(null);
			useColorSchemeMirror(rootRef);
			const byId = useSessions((state) => state.byId);
			const childIndex = (0, react.useMemo)(() => buildChildIndex(byId), [byId]);
			const scopeIds = (0, react.useMemo)(() => sessionId === "" ? [] : subtreeIds(byId, sessionId, childIndex), [
				byId,
				sessionId,
				childIndex
			]);
			const freshnessKey = buildStatsFreshnessKey(scopeIds, {
				activeSessionId: sessionId,
				rows: byId,
				liveSessionStats: useProjection("sessionStats")
			});
			const debouncedKey = useDebouncedValue(`${scopeIds.join("\n")}\n\t${freshnessKey}`, REFRESH_DEBOUNCE_MS$1);
			const { flies, flyOverflow, onSummary } = useCostInflate(scopeIds.join("\n"), costRef);
			const [resource, retry] = useAsyncResource((signal) => {
				const [idsPart] = debouncedKey.split("\n	");
				return fetchSessionSummary$1((idsPart ?? "").split("\n").filter((id) => id !== ""), signal);
			}, [debouncedKey], {
				silentAfterFirst: true,
				retryToken: 0
			});
			const summary = resource.status === "ready" ? resource.value : null;
			(0, react.useEffect)(() => {
				if (summary !== null) onSummary(summary);
			}, [summary, onSummary]);
			(0, react.useEffect)(() => {
				if (resource.status !== "error") return;
				const timer = window.setTimeout(retry, FETCH_FAILURE_RETRY_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [resource, retry]);
			if (summary === null || summary.total.requests === 0) return null;
			const view = currencyViewOf(summary);
			const { total } = summary;
			const tokensText = formatTokens(totalTokens(total));
			const hitText = hitRateDisplay(total).text;
			const costText = formatCost(summary.totalCost, view);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: `${SessionStatsChip_module_css_default["strip"]}${flyOverflow ? ` ${SessionStatsChip_module_css_default["stripFlyOverflow"]}` : ""}`,
				role: "group",
				"aria-label": t("view.usage"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: SessionStatsChip_module_css_default["cell"],
						"aria-label": t("chip.tokens", { value: tokensText }),
						children: tokensText
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: `${SessionStatsChip_module_css_default["cell"]} ${SessionStatsChip_module_css_default["cellHit"]}`,
						"aria-label": t("chip.hitRate", { value: hitText }),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HitRateText, { totals: total })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: `${SessionStatsChip_module_css_default["cell"]} ${SessionStatsChip_module_css_default["costCell"]}`,
						"aria-label": t("chip.cost", { value: costText }),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							ref: costRef,
							className: SessionStatsChip_module_css_default["costInner"],
							children: costText
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: SessionStatsChip_module_css_default["deltaLayer"],
							"aria-hidden": "true",
							children: flies.map((fly) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CostDeltaFlyLabel, {
								text: fly.text,
								vars: fly.vars
							}, fly.id))
						})]
					})
				]
			});
		}
		/** Defensive shape check: an older host build or a misrouted response
		* would otherwise paint the header chip with garbage. */
		function looksLikeUsageSummary(value) {
			return typeof value === "object" && value !== null && typeof value.total === "object" && value.total !== null;
		}
		/**
		* Fetch the summary scoped to one session and its subagent subtree. Throws
		* on transport failure (network, abort, non-2xx response, or a payload
		* that doesn't look like a stats summary) so the hook can keep the
		* previous render in place — a transient miss never blanks the chip. The
		* hook's `silentAfterFirst` flag is what suppresses the resulting error
		* state.
		* @param sessionIds - the active session plus its subagent descendants;
		* an empty list skips the fetch (returning null rather than throwing, so
		* the hook's first-load gate stays at "loading").
		* @param signal - the cancellation signal from the hook.
		*/
		async function fetchSessionSummary$1(sessionIds, signal) {
			if (sessionIds.length === 0) return null;
			const response = await fetch(STATS_PATH + encodeStatsQuery({
				sessionIds,
				fields: "chip"
			}), {
				headers: { accept: "application/json" },
				signal
			});
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			const value = await response.json();
			if (!looksLikeUsageSummary(value)) throw new Error("unexpected stats response");
			return value;
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\TokenUsageCard.module.css.mjs
		const css$4 = "._1bMeTa_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}._1bMeTa_card:hover{border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._1bMeTa_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._1bMeTa_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._1bMeTa_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._1bMeTa_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._1bMeTa_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._1bMeTa_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}._1bMeTa_chevronOpen{transform:rotate(180deg)}._1bMeTa_body{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;margin:0 16px;padding:12px 0 8px;display:flex}._1bMeTa_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._1bMeTa_field{flex-direction:column;gap:4px;display:flex}._1bMeTa_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}._1bMeTa_input{box-sizing:border-box;width:100%;font:inherit;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);appearance:none;border-radius:6px;padding:4px 8px;font-size:13px;line-height:20px}._1bMeTa_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}._1bMeTa_input:disabled{opacity:.6}._1bMeTa_inputRow{align-items:center;gap:6px;display:flex}._1bMeTa_inputRow ._1bMeTa_input{flex:1;min-width:0}._1bMeTa_browse{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border-radius:6px;flex:none;padding:4px 10px;font-size:13px;line-height:20px}._1bMeTa_browse:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_browse:disabled{opacity:.4;cursor:default}._1bMeTa_browse:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._1bMeTa_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._1bMeTa_migration{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:6px;flex-direction:column;gap:4px;padding:8px 10px;display:flex}._1bMeTa_migrationLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;line-height:1.5}._1bMeTa_migrationBar{background:var(--dsw-alias-bg-multi-select);border-radius:2px;height:4px;display:block;overflow:hidden}._1bMeTa_migrationFill{background:var(--dsw-alias-brand-primary);border-radius:2px;height:100%;transition:width .2s;display:block}._1bMeTa_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:8px 0 4px;display:flex}._1bMeTa_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}._1bMeTa_discard,._1bMeTa_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}._1bMeTa_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}._1bMeTa_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}._1bMeTa_discard:disabled,._1bMeTa_save:disabled{opacity:.4;cursor:default}._1bMeTa_discard:focus-visible,._1bMeTa_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._1bMeTa_fullSync{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}._1bMeTa_fullSyncHeader{flex-direction:column;gap:2px;display:flex}._1bMeTa_fullSyncTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4}._1bMeTa_fullSyncHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}._1bMeTa_fullSyncButton{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border-radius:6px;align-self:flex-start;padding:4px 12px;font-size:13px;line-height:20px}._1bMeTa_fullSyncButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_fullSyncButton:disabled{opacity:.5;cursor:default}._1bMeTa_fullSyncButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._1bMeTa_fullSyncProgress{flex-direction:column;gap:4px;display:flex}._1bMeTa_fullSyncProgressLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;line-height:1.5}._1bMeTa_fullSyncBar{background:var(--dsw-alias-bg-multi-select);border-radius:2px;height:4px;display:block;overflow:hidden}._1bMeTa_fullSyncFill{background:var(--dsw-alias-brand-primary);border-radius:2px;height:100%;transition:width .2s;display:block}._1bMeTa_fullSyncResult{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin:0;font-size:12px;line-height:1.5}._1bMeTa_fullSyncError{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}";
		const tagId$4 = "@laoyuehanni/dsh-token-usage/TokenUsageCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		var TokenUsageCard_module_css_default = {
			"body": "_1bMeTa_body",
			"browse": "_1bMeTa_browse",
			"card": "_1bMeTa_card",
			"cardOpen": "_1bMeTa_cardOpen",
			"chevron": "_1bMeTa_chevron",
			"chevronOpen": "_1bMeTa_chevronOpen",
			"description": "_1bMeTa_description",
			"discard": "_1bMeTa_discard",
			"failed": "_1bMeTa_failed",
			"field": "_1bMeTa_field",
			"fieldLabel": "_1bMeTa_fieldLabel",
			"footer": "_1bMeTa_footer",
			"fullSync": "_1bMeTa_fullSync",
			"fullSyncBar": "_1bMeTa_fullSyncBar",
			"fullSyncButton": "_1bMeTa_fullSyncButton",
			"fullSyncError": "_1bMeTa_fullSyncError",
			"fullSyncFill": "_1bMeTa_fullSyncFill",
			"fullSyncHeader": "_1bMeTa_fullSyncHeader",
			"fullSyncHint": "_1bMeTa_fullSyncHint",
			"fullSyncProgress": "_1bMeTa_fullSyncProgress",
			"fullSyncProgressLabel": "_1bMeTa_fullSyncProgressLabel",
			"fullSyncResult": "_1bMeTa_fullSyncResult",
			"fullSyncTitle": "_1bMeTa_fullSyncTitle",
			"headText": "_1bMeTa_headText",
			"header": "_1bMeTa_header",
			"hint": "_1bMeTa_hint",
			"input": "_1bMeTa_input",
			"inputRow": "_1bMeTa_inputRow",
			"migration": "_1bMeTa_migration",
			"migrationBar": "_1bMeTa_migrationBar",
			"migrationFill": "_1bMeTa_migrationFill",
			"migrationLabel": "_1bMeTa_migrationLabel",
			"name": "_1bMeTa_name",
			"note": "_1bMeTa_note",
			"pending": "_1bMeTa_pending",
			"save": "_1bMeTa_save"
		};
		//#endregion
		//#region src/client/TokenUsageCard.tsx
		/**
		* The token-usage card on the Plugins configuration tab: a collapsible row
		* whose header names the plugin over a one-line description of what its
		* settings govern, disclosing the data-directory control and the mirror
		* region pick (`domestic` gitee / `overseas` github) when open. The card owns
		* everything inside it — chrome, controls, and copy — per the keyed-slot
		* contract; the tab only dispatches it under the `token-usage` namespace key.
		*
		* Renders nothing while the namespace is unavailable: a deployment that did
		* not compose the host half shows no trace of the card. A region change takes
		* effect live (the host re-syncs the pricing mirror); a directory change the
		* guard refuses while conversations run shows the wait-for-them notice on the
		* failure line, and one that lands migrates the data across under a live
		* progress bar that locks the controls until it settles.
		*
		* @module token-usage/client/TokenUsageCard
		*/
		/**
		* Render the token-usage settings card.
		* @param props - locale copy, the card snapshot, and its form actions.
		* @returns the card, or nothing when the namespace is unavailable.
		*/
		function TokenUsageCard(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const [picking, setPicking] = (0, react.useState)(false);
			const { t } = props;
			const state = props.useTokenUsageCard((snapshot) => snapshot);
			if (!state.available) return null;
			const migrating = state.migration !== void 0;
			const lockInput = !state.writable || migrating;
			const lockActions = !state.dirty || state.saving || migrating;
			/**
			* Open the shell's native folder dialog and stage the chosen path — the
			* same picker the workspace flows use, driven through the injected
			* workspace service. A dismissal leaves the staged draft exactly as it
			* was; the text input stays the fallback either way.
			*/
			const browse = async () => {
				if (picking || lockInput) return;
				setPicking(true);
				try {
					const picked = await props.pickDirectory();
					if (picked !== null && picked !== "") props.editField("path", picked);
				} catch (_pickFailure) {} finally {
					setPicking(false);
				}
			};
			const [fullSync, setFullSync] = (0, react.useState)({ status: "idle" });
			const fullSyncRunning = fullSync.status === "running";
			/**
			* Fetch the current full-sync status from the host. A transport failure
			* keeps the previous view (a transient miss never blanks the bar).
			*/
			const fetchFullSync = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(FULL_SYNC_PATH, { headers: { accept: "application/json" } });
					if (!response.ok) return null;
					const body = await response.json();
					if (body.status === "idle") return { status: "idle" };
					if (body.status === "running" || body.status === "done") {
						if (typeof body.processed === "number" && typeof body.total === "number" && typeof body.added === "number" && typeof body.skipped === "number") return {
							status: body.status,
							processed: body.processed,
							total: body.total,
							added: body.added,
							skipped: body.skipped
						};
						return null;
					}
					if (body.status === "failed" && typeof body.error === "string") return {
						status: "failed",
						error: body.error
					};
					return null;
				} catch (_pollFailure) {
					return null;
				}
			}, []);
			(0, react.useEffect)(() => {
				if (!fullSyncRunning) return;
				let cancelled = false;
				const tick = async () => {
					const next = await fetchFullSync();
					if (cancelled || next === null) return;
					setFullSync(next);
				};
				tick();
				const timer = setInterval(() => {
					tick();
				}, 300);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [fullSyncRunning, fetchFullSync]);
			/**
			* Kick off one full scan. The button shows the request as soon as the
			* POST returns 202; the polling effect above then drives the bar until
			* the host settles into `done` or `failed`. A 409 (already running) is
			* a no-op — the polling will already see the running state.
			*/
			const startFullSync = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(FULL_SYNC_PATH, { method: "POST" });
					if (response.status === 202) {
						setFullSync({
							status: "running",
							processed: 0,
							total: 0,
							added: 0,
							skipped: 0
						});
						return;
					}
					if (response.status === 409) {
						const next = await fetchFullSync();
						if (next !== null) setFullSync(next);
					}
				} catch (_triggerFailure) {}
			}, [fetchFullSync]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: open ? `${TokenUsageCard_module_css_default.card} ${TokenUsageCard_module_css_default.cardOpen}` : TokenUsageCard_module_css_default.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: TokenUsageCard_module_css_default.header,
					"aria-expanded": open,
					"aria-label": `${t(open ? "card.collapse" : "card.expand")}: ${t("card.title")}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: TokenUsageCard_module_css_default.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TokenUsageCard_module_css_default.name,
								children: t("card.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TokenUsageCard_module_css_default.description,
								children: t("card.description")
							})]
						}),
						state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: TokenUsageCard_module_css_default.pending,
							children: t("card.unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? `${TokenUsageCard_module_css_default.chevron} ${TokenUsageCard_module_css_default.chevronOpen}` : TokenUsageCard_module_css_default.chevron })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: TokenUsageCard_module_css_default.body,
					children: [
						!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: TokenUsageCard_module_css_default.note,
							role: "status",
							children: t("card.readOnly")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: TokenUsageCard_module_css_default.field,
							htmlFor: "token-usage-card-path",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TokenUsageCard_module_css_default.fieldLabel,
								children: t("card.pathLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: TokenUsageCard_module_css_default.inputRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "token-usage-card-path",
									className: TokenUsageCard_module_css_default.input,
									type: "text",
									spellCheck: false,
									value: state.fields.path,
									disabled: lockInput,
									onChange: (event) => {
										props.editField("path", event.target.value);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TokenUsageCard_module_css_default.browse,
									disabled: lockInput || picking,
									onClick: () => {
										browse();
									},
									children: t(picking ? "card.picking" : "card.browse")
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: TokenUsageCard_module_css_default.hint,
							children: t("card.pathHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: TokenUsageCard_module_css_default.field,
							htmlFor: "token-usage-card-region",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TokenUsageCard_module_css_default.fieldLabel,
								children: t("card.regionLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								id: "token-usage-card-region",
								className: TokenUsageCard_module_css_default.input,
								value: state.fields.pricingRegion,
								disabled: lockInput,
								onChange: (event) => {
									props.editField("pricingRegion", event.target.value);
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("card.regionDefault")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "domestic",
										children: t("card.region.domestic")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "overseas",
										children: t("card.region.overseas")
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: TokenUsageCard_module_css_default.hint,
							children: [t("card.hint"), state.overridden.pricingRegion ? ` ${t("card.overridden")}` : ""]
						}),
						state.migration !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TokenUsageCard_module_css_default.migration,
							role: "status",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TokenUsageCard_module_css_default.migrationLabel,
								children: t(state.migration.phase === "copying" ? "card.migratingCopy" : "card.migratingClean").replace("{done}", String(state.migration.done)).replace("{total}", String(state.migration.total))
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: TokenUsageCard_module_css_default.migrationBar,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: TokenUsageCard_module_css_default.migrationFill,
									style: { width: `${String(Math.round(state.migration.done / Math.max(state.migration.total, 1) * 100))}%` }
								})
							})]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TokenUsageCard_module_css_default.fullSync,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TokenUsageCard_module_css_default.fullSyncHeader,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TokenUsageCard_module_css_default.fullSyncTitle,
										children: t("card.fullSync.title")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TokenUsageCard_module_css_default.fullSyncHint,
										children: t("card.fullSync.hint")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TokenUsageCard_module_css_default.fullSyncButton,
									disabled: fullSyncRunning,
									onClick: () => {
										startFullSync();
									},
									children: t(fullSyncRunning ? "card.fullSync.running" : "card.fullSync.button")
								}),
								fullSync.status === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: TokenUsageCard_module_css_default.fullSyncProgress,
									role: "status",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TokenUsageCard_module_css_default.fullSyncProgressLabel,
										children: t("card.fullSync.progress", {
											processed: String(fullSync.processed),
											total: String(fullSync.total),
											added: String(fullSync.added),
											skipped: String(fullSync.skipped)
										})
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: TokenUsageCard_module_css_default.fullSyncBar,
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: TokenUsageCard_module_css_default.fullSyncFill,
											style: { width: `${String(Math.round(fullSync.processed / Math.max(fullSync.total, 1) * 100))}%` }
										})
									})]
								}) : null,
								fullSync.status === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: TokenUsageCard_module_css_default.fullSyncResult,
									role: "status",
									children: t("card.fullSync.done", {
										added: String(fullSync.added),
										skipped: String(fullSync.skipped)
									})
								}) : null,
								fullSync.status === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: TokenUsageCard_module_css_default.fullSyncError,
									role: "status",
									children: t("card.fullSync.failed", { error: fullSync.error })
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: TokenUsageCard_module_css_default.footer,
							children: [
								state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: TokenUsageCard_module_css_default.failed,
									role: "status",
									children: state.refusal !== void 0 ? t("card.saveBlockedSessions").replace("{count}", String(state.refusal.interactingSessions)) : t("card.saveFailed")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TokenUsageCard_module_css_default.discard,
									disabled: lockActions,
									onClick: props.discard,
									children: t("card.discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TokenUsageCard_module_css_default.save,
									disabled: lockActions,
									onClick: props.save,
									children: t(state.saving ? "card.saving" : "card.save")
								})
							]
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\StatCard.module.css.mjs
		const css$3 = ".F2LbNW_card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-fill-container,transparent);border-radius:8px;flex-direction:column;gap:2px;min-width:0;padding:10px 12px;display:flex}.F2LbNW_cardLabel{color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;font-size:11px;overflow:hidden}.F2LbNW_cardValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:18px;font-weight:600;overflow:hidden}";
		const tagId$3 = "@laoyuehanni/dsh-token-usage/StatCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var StatCard_module_css_default = {
			"card": "F2LbNW_card",
			"cardLabel": "F2LbNW_cardLabel",
			"cardValue": "F2LbNW_cardValue"
		};
		//#endregion
		//#region src/client/StatCard.tsx
		/**
		* Render one stat card. The value uses the standard label-primary color.
		* The label clamps to one line and ellipsizes if the column is squeezed.
		*/
		function StatCard({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: StatCard_module_css_default["card"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: StatCard_module_css_default["cardLabel"],
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: StatCard_module_css_default["cardValue"],
					children: value
				})]
			});
		}
		//#endregion
		//#region src/client/trend-chart/axis.ts
		/**
		* Trend-chart axis helpers: the roundest step from 1/2/2.5/5 × 10ⁿ not
		* below a rough target, and the y-axis tick values (one nice step apart,
		* inclusive of the chart top). Pure functions, no React, no I/O.
		*
		* @module token-usage/client/trend-chart/axis
		*/
		/**
		* The roundest step from {1, 2, 2.5, 5, 10} × 10ⁿ not below `rough`.
		* A `niceStep(0)` returns 1; a `niceStep(80)` returns 100 (the next nice
		* step above 80 in the same decade).
		* @param rough - the target value (positive).
		* @returns the nice step.
		*/
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
		//#endregion
		//#region src/trend-bucket.ts
		/**
		* Bucket widths tried from fine to coarse (ms); the first whose bucket count
		* stays at or under {@link MAX_BUCKETS} wins, so a short session gets
		* fine-grained 5-second buckets and a multi-day session one per several
		* hours — always within the render cap.
		*/
		const BUCKET_STEPS_MS = [
			5e3,
			15e3,
			6e4,
			3e5,
			9e5,
			36e5,
			108e5,
			216e5,
			432e5,
			864e5
		];
		/** The bucket width for one span: the finest step whose count fits the cap. */
		function bucketWidth(spanMs) {
			for (const step of BUCKET_STEPS_MS) if (Math.ceil(spanMs / step) <= 60) return step;
			return Math.ceil(spanMs / 60 / 36e5) * 36e5;
		}
		/**
		* Fold a request series into uniformly sized time buckets spanning the
		* series' own first-to-last window. The axis starts at the series' first
		* record, ends at its latest, and the middle is evenly divided — the chart
		* shows the trend over TIME, not one point per request. Buckets align to
		* the window's first record, not to wall-clock round hours.
		*
		* Implementation note: the buckets are tracked in a `Map` keyed by their
		* 0-based index, not in a sparse array. A multi-month session could
		* otherwise blow past V8's sparse-array bounds (the indices approach
		* `spanMs / 5_000` which is unbounded); the Map collapses absent keys
		* cleanly.
		*
		* @param requests - the per-request series, time-ascending.
		* @returns the buckets in time order (empty for an empty series; only
		* buckets holding at least one request are emitted).
		*/
		function bucketSeries(requests) {
			if (requests.length === 0) return [];
			const first = requests[0].time;
			const last = requests[requests.length - 1].time;
			const width = bucketWidth(Math.max(last - first, 1));
			const buckets = /* @__PURE__ */ new Map();
			for (const request of requests) {
				const index = Math.floor((request.time - first) / width);
				const existing = buckets.get(index);
				if (existing === void 0) buckets.set(index, {
					start: first + index * width,
					end: first + (index + 1) * width,
					tokens: request.tokens,
					count: 1
				});
				else {
					existing.tokens += request.tokens;
					existing.count += 1;
				}
			}
			return [...buckets.entries()].sort(([left], [right]) => left - right).map(([, bucket]) => bucket);
		}
		//#endregion
		//#region src/client/trend-chart/bucket.ts
		/**
		* Scale one wall time into an x offset across the series' actual span —
		* the first and last points pin the axis ends, and everything in between
		* lands at its real proportion of that span (a 55-request session
		* spreads across the full width, a burst inside one minute bunches up).
		* @param firstTime - the series' first record time.
		* @param lastTime - the series' last record time.
		* @param time - the record's wall time.
		* @param innerWidth - the plottable width in pixels.
		* @returns the x offset from the left edge; the center when every record
		* shares one timestamp (a zero span cannot scale).
		*/
		function scaleToSpan(firstTime, lastTime, time, innerWidth) {
			const span = lastTime - firstTime;
			if (span <= 0) return innerWidth / 2;
			return (time - firstTime) / span * innerWidth;
		}
		//#endregion
		//#region src/client/trend-chart/points.ts
		/** Render-mode priority: request buckets outrank per-hour, which
		* outranks per-day. A session-scoped read passes `requests`; the settings
		* page passes `hours` for a single-day range; everything else plots days. */
		function buildChartPoints(input) {
			if (input.requests !== void 0 && input.requests.length > 0) {
				const buckets = bucketsOf(input.requests);
				if (buckets.length > 0) {
					const crossDay = new Date(buckets[0].start).toDateString() !== new Date(buckets[buckets.length - 1].start).toDateString();
					return {
						mode: "temporal",
						points: buckets.map((bucket, index) => ({
							key: `b${index}`,
							label: bucketLabel(bucket.start, crossDay),
							full: `${bucketLabel(bucket.start, crossDay)}–${bucketLabel(bucket.end, crossDay)}`,
							tokens: bucket.tokens,
							time: bucket.start,
							count: bucket.count
						}))
					};
				}
			}
			if (input.hours !== void 0) {
				const points = hourSeries(input.hours, input.from, input.to);
				if (points.length > 0) return {
					mode: "equidistant",
					points: points.map(hourToPoint)
				};
			}
			const points = daySeries(input.rows, input.from, input.to);
			if (points.length > 0) return {
				mode: "equidistant",
				points: points.map(dayToPoint)
			};
			return null;
		}
		/** A series that already carries `count` (the host's `fields=session`
		* downsample) is plotted as-is; a raw per-request series is folded here. */
		function bucketsOf(requests) {
			if (requests[0]?.count !== void 0) return requests.map((point) => ({
				start: point.time,
				end: point.end ?? point.time,
				tokens: point.tokens,
				count: point.count ?? 1
			}));
			return bucketSeries(requests);
		}
		function dayToPoint(point) {
			return {
				key: point.day,
				label: point.day.slice(5),
				full: point.day,
				tokens: point.tokens
			};
		}
		function hourToPoint(point) {
			return {
				key: point.hour,
				label: `${point.hour.slice(11)}:00`,
				full: `${point.hour.slice(0, 10)} ${point.hour.slice(11)}:00`,
				tokens: point.tokens
			};
		}
		/** Zero-padded HH:mm of one wall time, local-time. */
		function clockOf(time) {
			const d = new Date(time);
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}
		/** The x-axis label of one bucket start: HH:mm within one day,
		* MM-DD HH:mm once the session crosses midnight. */
		function bucketLabel(time, crossDay) {
			if (!crossDay) return clockOf(time);
			const d = new Date(time);
			return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clockOf(time)}`;
		}
		//#endregion
		//#region src/client/trend-chart/scale.ts
		/**
		* Pick the right x scale for a {@link ChartSeries} and produce the
		* per-point offsets in absolute viewBox coordinates. Equidistant modes
		* lay points one stride apart across the `[leftEdge, rightEdge]` span;
		* temporal mode uses each point's wall time against the series' own
		* first-to-last span and adds `leftEdge` to the result. Single-point
		* series pin to the centerline of the span (a zero stride would not
		* scale, and temporal scale would divide by zero).
		*
		* @param series - the discriminated-union series from {@link buildChartPoints}.
		* @param leftEdge - the absolute SVG x of the chart's left edge (the
		* y-axis line in the renderer).
		* @param rightEdge - the absolute SVG x of the chart's right edge
		* (typically `viewBox.width − RIGHT.margin`).
		* @returns the per-point x offsets plus `innerWidth = rightEdge − leftEdge`.
		*/
		function scaleSeries(series, leftEdge, rightEdge) {
			const innerWidth = rightEdge - leftEdge;
			const { points } = series;
			if (series.mode === "equidistant") {
				const xs = [];
				if (points.length === 1) xs.push((leftEdge + rightEdge) / 2);
				else {
					const stride = innerWidth / (points.length - 1);
					for (let i = 0; i < points.length; i += 1) xs.push(leftEdge + i * stride);
				}
				return {
					xs,
					innerWidth
				};
			}
			const temporal = points;
			const first = temporal[0].time;
			const last = temporal[temporal.length - 1].time;
			const xs = [];
			if (temporal.length === 1 || first === last) xs.push((leftEdge + rightEdge) / 2);
			else for (const point of temporal) xs.push(leftEdge + scaleToSpan(first, last, point.time, innerWidth));
			return {
				xs,
				innerWidth
			};
		}
		/**
		* The x-axis label positions: first, middle, and last point for long
		* ranges. Short ranges (≤3 points) label every point so a 1- or 2- day
		* window does not skip the only "middle" data.
		*/
		function labelIndices(length) {
			if (length <= 3) return Array.from({ length }, (_, index) => index);
			const middle = Math.floor((length - 1) / 2);
			return [.../* @__PURE__ */ new Set([
				0,
				middle,
				length - 1
			])];
		}
		/** Choose a dot radius that survives dense point clouds without
		* overlapping but stays visible for sparse ones. Three tiers, picked by
		* point count. */
		function dotRadius(pointCount) {
			if (pointCount > 90) return 1.5;
			if (pointCount > 30) return 2;
			return 3;
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\TrendChart.module.css.mjs
		const css$2 = ".DWJgoW_chart{width:100%;height:auto;display:block}.DWJgoW_axis{stroke:var(--dsw-alias-border-l2);stroke-width:1px}.DWJgoW_grid{stroke:var(--dsw-alias-border-l2);stroke-width:1px;stroke-dasharray:3 3}.DWJgoW_line{fill:none;stroke:var(--dsw-alias-label-primary);stroke-width:2px;stroke-linejoin:round;stroke-linecap:round}.DWJgoW_dot{fill:var(--dsw-alias-label-primary)}.DWJgoW_dotActive{fill:var(--dsw-alias-label-primary);stroke:var(--dsw-alias-bg-layer-2);stroke-width:2px}.DWJgoW_guide{stroke:var(--dsw-alias-label-secondary);stroke-width:1px;stroke-dasharray:3 3}.DWJgoW_hit{cursor:default}.DWJgoW_pointLabel rect{fill:var(--dsw-alias-bg-layer-3);stroke:var(--dsw-alias-border-l2)}.DWJgoW_pointLabel text{fill:var(--dsw-alias-label-primary);font-size:11px}.DWJgoW_tick{fill:var(--dsw-alias-label-secondary);font-size:11px}.DWJgoW_empty{text-align:center;color:var(--dsw-alias-label-secondary);margin:0;padding:24px 0;font-size:13px}";
		const tagId$2 = "@laoyuehanni/dsh-token-usage/TrendChart.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
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
		* Daily / hourly / request-bucketed token trend chart (browser half):
		* a dependency-free SVG line chart over the already-filtered summary.
		* The renderer is pure presentation; the bucketing, scaling, and
		* point-shape decisions live in `./trend-chart/*` so each piece can be
		* tested in isolation.
		*
		* Two granularities share one renderer — per-day rows (x axis spans
		* every calendar day of the active range, days without records plot as
		* zero) and per-hour rows (a single-day window plots every whole hour of
		* that day, 00:00–23:00, future hours of today reading zero). The
		* third mode — request buckets — folds the request series into uniformly
		* sized time buckets spanning the session's actual first-to-last window
		* and scales each bucket at its real temporal proportion of the span.
		*
		* Hovering (or keyboard-focusing) a point highlights it and floats a
		* label with that point's date/time and total tokens.
		*
		* @module token-usage/client/TrendChart
		*/
		/** SVG canvas metrics; the element scales to the section width via viewBox. */
		const WIDTH = 800;
		const HEIGHT = 190;
		const TOP = 12;
		const LEFT = 44;
		const HIT_TARGET_FLOOR = 6;
		/**
		* Apply the `t`-based localisation to a point's `full` tooltip. The pre-shape
		* labels live in points.ts; the chart's aria-label and the floating tooltip
		* both use this single source so the two stay consistent.
		* @param t - the locale seat.
		* @param point - the pre-shaped point.
		* @returns the tooltip / aria-label text.
		*/
		function tipOf(t, point) {
			if (point.time !== void 0) return t("chart.bucket", {
				window: point.full,
				count: String(point.count ?? 0),
				tokens: formatTokens(point.tokens)
			});
			return t("chart.pointLabel", {
				day: point.full,
				tokens: formatTokens(point.tokens)
			});
		}
		/**
		* Render the daily / hourly / request-bucketed token line chart. Pure
		* presentation: every data-driven decision (bucketing, axis scaling,
		* point ordering) lives in `./trend-chart/*`; this component picks the
		* right `chartAria` string for screen readers and forwards hover /
		* focus state to the dot + label.
		*
		* Empty ranges (no data on any branch) render a placeholder instead of an
		* axis so the layout does not collapse to an empty SVG.
		*
		* @param props - the filtered per-day rows plus the optional per-hour rows
		* (when present the chart plots hours instead of days), the optional
		* per-request series (session-scoped reads), the active range bounds
		* (absent when unfiltered; the chart then spans first to last row), and
		* the `t` seat for the empty hint and chart aria-label.
		* @returns the SVG chart, or a placeholder for an empty range.
		*/
		function TrendChart({ rows, hours, requests, from, to, t }) {
			const series = buildChartPoints({
				rows,
				hours,
				requests,
				from,
				to
			});
			if (series === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: TrendChart_module_css_default.empty,
				children: t("chart.empty")
			});
			const points = series.points.map((point) => ({
				key: point.key,
				label: point.label,
				full: point.full,
				tokens: point.tokens,
				time: "time" in point ? point.time : void 0,
				count: "count" in point ? point.count : void 0
			}));
			const { top, ticks } = tickValues(Math.max(...points.map((p) => p.tokens)));
			const innerHeight = 140;
			const { xs, innerWidth } = scaleSeries(series, LEFT, 784);
			const radius = dotRadius(points.length);
			const [active, setActive] = (0, react.useState)(null);
			const activePoint = active === null ? null : points[active] ?? null;
			const y = (tokens) => 152 - tokens / top * innerHeight;
			const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${xs[index].toFixed(1)},${y(point.tokens).toFixed(1)}`).join(" ");
			const chartAria = series.mode === "temporal" ? t("chart.ariaRequests") : hours !== void 0 ? t("chart.ariaHour") : t("chart.aria");
			const hitExtent = (index) => {
				if (points.length === 1) return {
					start: LEFT,
					width: innerWidth
				};
				const center = xs[index];
				const before = index === 0 ? void 0 : xs[index - 1];
				const after = index === points.length - 1 ? void 0 : xs[index + 1];
				const toPrev = before === void 0 ? innerWidth : (center - before) / 2;
				const toNext = after === void 0 ? innerWidth : (after - center) / 2;
				const half = Math.max(Math.min(toPrev, toNext), HIT_TARGET_FLOOR);
				return {
					start: center - half,
					width: half * 2
				};
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				role: "img",
				"aria-label": chartAria,
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
						cx: xs[index],
						cy: y(point.tokens),
						r: active === index ? radius + 2.5 : radius,
						className: active === index ? TrendChart_module_css_default.dotActive : TrendChart_module_css_default.dot
					}, point.key)),
					activePoint !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: xs[active],
						y1: y(activePoint.tokens),
						x2: xs[active],
						y2: y(0),
						className: TrendChart_module_css_default.guide
					}) : null,
					points.map((point, index) => {
						const hit = hitExtent(index);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
							x: hit.start,
							y: TOP,
							width: hit.width,
							height: innerHeight,
							fill: "transparent",
							"aria-label": tipOf(t, point),
							role: "button",
							tabIndex: 0,
							className: TrendChart_module_css_default.hit,
							onMouseEnter: () => setActive(index),
							onFocus: () => setActive(index),
							onBlur: () => setActive((current) => current === index ? null : current)
						}, point.key);
					}),
					activePoint !== null ? (() => {
						const label = tipOf(t, activePoint);
						const labelWidth = label.length * 6.2 + 12;
						const center = xs[active];
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
						x: xs[index],
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
		const css$1 = ".RbkiSa_section{flex-direction:column;gap:16px;width:100%;display:flex}.RbkiSa_head{justify-content:space-between;align-items:center;gap:12px;display:flex}.RbkiSa_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600}.RbkiSa_muted{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}.RbkiSa_rateNote{color:var(--dsw-alias-label-secondary);margin:6px 0 0;font-size:12px}.RbkiSa_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}.RbkiSa_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;font-weight:600}.RbkiSa_tableWrap{overflow-x:auto}.RbkiSa_table{border-collapse:collapse;font-variant-numeric:tabular-nums;width:100%;min-width:500px;font-size:12px}.RbkiSa_table th,.RbkiSa_table td{text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;padding:4px 6px}.RbkiSa_table th.RbkiSa_modelHead,.RbkiSa_table td.RbkiSa_modelCol{text-align:left;width:150px;max-width:150px}.RbkiSa_table th{color:var(--dsw-alias-label-secondary);font-weight:500}.RbkiSa_table td{color:var(--dsw-alias-label-primary)}.RbkiSa_empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.RbkiSa_button{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px;line-height:20px}.RbkiSa_button:hover{background:var(--dsw-interactive-bg-hover)}.RbkiSa_filters{flex-wrap:nowrap;align-items:center;gap:8px;display:flex}.RbkiSa_control,.RbkiSa_modelControl{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 6px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:26px}.RbkiSa_control{box-sizing:border-box;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 26px 4px 8px;font-size:13px;line-height:20px}.RbkiSa_dateControl{box-sizing:border-box;width:138px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;padding:4px 6px;font-size:13px;line-height:20px}.RbkiSa_modelControl{box-sizing:border-box;text-overflow:ellipsis;min-width:0;max-width:220px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 26px 4px 8px;font-size:13px;line-height:20px;overflow:hidden}.RbkiSa_rangeSeparator{color:var(--dsw-alias-label-secondary);font-size:12px}.RbkiSa_cards{grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;display:grid}.RbkiSa_warning{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:6px;margin:0;padding:6px 10px;font-size:12px}.RbkiSa_modelCell{align-items:center;gap:4px;max-width:138px;display:inline-flex;position:relative}.RbkiSa_modelName{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.RbkiSa_unpricedTag{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:8px;flex:none;padding:0 6px;font-size:10px;line-height:16px}.RbkiSa_pricingButton{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:8px;flex:none;padding:0 6px;font-size:10px;line-height:16px}.RbkiSa_pricingButton:hover{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);border-color:var(--dsw-alias-state-warn-primary)}.RbkiSa_dialog{width:min(600px,100vw - 48px);max-height:calc(100vh - 48px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;overflow-y:auto}.RbkiSa_dialog::backdrop{background:#0006}.RbkiSa_dialogHead{justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;display:flex}.RbkiSa_dialogTitle{text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:14px;font-weight:600;overflow:hidden}.RbkiSa_dialogClose{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;padding:2px 8px;font-size:12px;line-height:18px}.RbkiSa_dialogClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-interactive-bg-hover)}th.RbkiSa_conditionHead,td.RbkiSa_conditionCell{text-align:left;white-space:normal;min-width:200px}td.RbkiSa_conditionCell{color:var(--dsw-alias-label-secondary);padding-left:20px}.RbkiSa_groupRow>td{text-align:left;white-space:normal;color:var(--dsw-alias-label-secondary);border-bottom:none;padding-top:8px;font-size:11px;font-weight:600}.RbkiSa_groupRow:not(:first-child)>td{border-top:1px solid var(--dsw-alias-border-l1)}";
		const tagId$1 = "@laoyuehanni/dsh-token-usage/TokenUsageSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var TokenUsageSection_module_css_default = {
			"button": "RbkiSa_button",
			"cards": "RbkiSa_cards",
			"conditionCell": "RbkiSa_conditionCell",
			"conditionHead": "RbkiSa_conditionHead",
			"control": "RbkiSa_control",
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
			"rateNote": "RbkiSa_rateNote",
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
		/**
		* Token-usage settings page (browser half): fetches the stats summary from
		* the host route and renders the filter bar (inclusive day range, model
		* select, 1d/7d/30d quick ranges where 1d spans today 00:00–23:59), the
		* total-usage strip, the daily-token trend chart, the per-model detail
		* table with the hit rate last, and — opened by each priced model row's
		* “定价” affordance — a dialog with that model's full price table — all
		* following the active filters. There is no refresh button: entering the
		* page or changing a filter refetches (the route answers no-store); only
		* the error state keeps a retry.
		*
		* @module token-usage/client/TokenUsageSection
		*/
		/** Fetch the summary for one query string; the caller owns the failure
		* presentation. The AbortSignal wires into the request so a filter change
		* cancels the in-flight fetch instead of letting its response overwrite
		* the next filter's data. */
		function fetchSummary(query, signal) {
			return fetch(STATS_PATH + query, { signal }).then((response) => {
				if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
				return response.json();
			}).then((value) => {
				if (typeof value !== "object" || value === null || typeof value.total !== "object") throw new Error("unexpected stats response");
				return value;
			});
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
		/** The four base rates of one model as display text (symbol included,
		* converted for a USD view); a missing cache rate bills at the input rate. */
		function billedRates(rates, view) {
			return {
				input: formatRateWithSymbol(rates.inputPerMillion, view),
				output: formatRateWithSymbol(rates.outputPerMillion, view),
				cacheRead: formatRateWithSymbol(rates.cacheReadPerMillion ?? rates.inputPerMillion, view),
				cacheWrite: formatRateWithSymbol(rates.cacheWritePerMillion ?? rates.inputPerMillion, view)
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
		function ModelPriceTable({ rules, view, t }) {
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: TokenUsageSection_module_css_default["tableWrap"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
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
						const billed = billedRates(row.rates, view);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: TokenUsageSection_module_css_default["conditionCell"],
								children: row.condition
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: billed.input }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: billed.output }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: billed.cacheRead }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: billed.cacheWrite })
						] }, `${group.title ?? ""}-${index}-${row.condition}`);
					})]) })]
				}), view.symbol === "$" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: TokenUsageSection_module_css_default["rateNote"],
					children: t("pricing.exchangeRateNote", { rate: formatRate(view.rate) })
				}) : null]
			});
		}
		/**
		* The pricing dialog of one model: a native `<dialog>` (Esc closes, focus
		* is trapped, the backdrop dims, and the top layer renders it above the
		* table's scroll shell) opened by the “定价” affordance in a model row.
		* Mounts only while a model is selected; every close path funnels through
		* the dialog's `close` event, which clears the selection and unmounts it.
		*/
		function PricingDialog({ model, rules, view, onClose, t }) {
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
					view,
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
		* Render the Token Usage section content column. The `t` seat arrives from
		* the registration's `locale:` declaration and follows the active locale.
		* @param props - the settings shell's owner share (close is unused: the nav
		* rail owns leaving the panel) plus the framework-injected translate seat.
		* @returns the section, one of loading / error / ready.
		*/
		function TokenUsageSection({ t }) {
			const rootRef = (0, react.useRef)(null);
			useColorSchemeMirror(rootRef);
			const [filters, setFilters] = (0, react.useState)(() => ({
				model: "",
				...quickRange(1)
			}));
			const [models, setModels] = (0, react.useState)([]);
			const [detailModel, setDetailModel] = (0, react.useState)(null);
			const [retryToken, setRetryToken] = (0, react.useState)(0);
			const retry = (0, react.useCallback)(() => {
				setRetryToken((previous) => previous + 1);
			}, []);
			const query = filterQuery(filters);
			const lastValidQueryRef = (0, react.useRef)(query ?? "");
			if (query !== null) lastValidQueryRef.current = query;
			const fetchQuery = query ?? lastValidQueryRef.current;
			const [state] = useAsyncResource((signal) => fetchSummary(fetchQuery, signal), [fetchQuery, retryToken], {
				silentAfterFirst: false,
				retryToken
			});
			(0, react.useEffect)(() => {
				if (state.status !== "ready") return;
				if (filters.model !== "") return;
				const next = state.value.byModel.map((row) => row.model);
				if (next.length === models.length && next.every((m, i) => m === models[i])) return;
				setModels(next);
			}, [
				state,
				filters.model,
				models
			]);
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
			const { total } = state.value;
			const view = currencyViewOf(state.value);
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
						children: t("dataDir", { path: state.value.dataDir })
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
									value: formatCost(state.value.totalCost, view)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.totalTokens"),
									value: formatTokens(totalTokens(total))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.hitRate"),
									value: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HitRateText, { totals: total })
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
						state.value.unpricedModels.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: TokenUsageSection_module_css_default["warning"],
							role: "status",
							children: t("unpriced.warning", {
								count: String(state.value.unpricedModels.length),
								models: state.value.unpricedModels.join(", "),
								zero: formatCost(0, view)
							})
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrendChart, {
							rows: state.value.byDay,
							t,
							...filters.from !== "" ? { from: filters.from } : {},
							...filters.to !== "" ? { to: filters.to } : {},
							...filters.from !== "" && filters.from === filters.to ? { hours: state.value.byHour } : {}
						}),
						state.value.byModel.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
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
								] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: state.value.byModel.map((row) => {
									const rules = state.value.pricing[row.model];
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
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: rules !== void 0 ? formatCost(row.cost, view) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(totalTokens(row.totals)) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.inputTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.outputTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheReadTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheWriteTokens) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HitRateText, { totals: row.totals }) })
									] }, row.model);
								}) })]
							})
						})] }) : null,
						detailModel !== null && state.value.pricing[detailModel] !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PricingDialog, {
							model: detailModel,
							rules: state.value.pricing[detailModel],
							view,
							onClose: () => setDetailModel(null),
							t
						}) : null
					] })
				]
			});
		}
		//#endregion
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\UsageView.module.css.mjs
		const css = "._0MkXVa_root{box-sizing:border-box;width:100%;padding:12px calc(var(--dsh-composer-side-clearance,16px) + 16px);flex-direction:column;gap:12px;max-width:1400px;height:100%;margin:0 auto;display:flex;overflow-y:auto}._0MkXVa_head{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:12px;display:flex}._0MkXVa_headRight{align-items:center;gap:10px;display:flex}._0MkXVa_back{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:6px;padding:3px 10px;font-size:12px}._0MkXVa_back:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}._0MkXVa_segmented{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-fill-container,transparent);border-radius:8px;align-items:stretch;gap:2px;padding:2px;display:inline-flex}._0MkXVa_segBtn{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;background:0 0;border:none;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:500}._0MkXVa_segBtn:hover:not(._0MkXVa_segActive){color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)}._0MkXVa_segBtn:focus-visible{outline:2px solid var(--dsw-alias-border-l2);outline-offset:1px}._0MkXVa_segActive{background:color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);color:var(--dsw-alias-label-primary);font-weight:600}._0MkXVa_muted{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}._0MkXVa_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}._0MkXVa_empty{color:var(--dsw-alias-label-secondary);text-align:center;margin:24px 0 0;font-size:13px}._0MkXVa_button{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:6px;align-self:flex-start;padding:3px 10px;font-size:12px}._0MkXVa_warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));margin:0;font-size:12px}._0MkXVa_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px}._0MkXVa_cards{grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;display:grid}._0MkXVa_tokenStrip{color:var(--dsw-alias-label-secondary);flex-wrap:wrap;gap:18px;padding:6px 2px 0;font-size:12px;display:flex}._0MkXVa_tokenStrip b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}._0MkXVa_mid{grid-template-columns:minmax(0,3fr) minmax(0,2fr);align-items:start;gap:14px;display:grid}._0MkXVa_chartCol,._0MkXVa_modelCol,._0MkXVa_subagents{flex-direction:column;gap:6px;min-width:0;display:flex}._0MkXVa_subagentsHead{align-items:center;gap:8px;display:flex}._0MkXVa_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;font-weight:600}._0MkXVa_tableWrap{overflow-x:auto}._0MkXVa_table{border-collapse:collapse;font-variant-numeric:tabular-nums;width:100%;min-width:480px;font-size:12px}._0MkXVa_table th,._0MkXVa_table td{text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;padding:4px 6px}._0MkXVa_table th:first-child,._0MkXVa_table td:first-child,._0MkXVa_modelHead{text-align:left}._0MkXVa_modelCell{font-variant-numeric:normal;text-overflow:ellipsis;max-width:180px;overflow:hidden}._0MkXVa_childLink{color:var(--dsw-alias-link-primary,var(--dsw-alias-label-primary));cursor:pointer;text-align:left;text-overflow:ellipsis;white-space:nowrap;background:0 0;border:none;max-width:220px;padding:0;font-size:12px;overflow:hidden}._0MkXVa_childLink:hover{text-decoration:underline}._0MkXVa_nestedBadge{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-left:6px;font-size:11px}@media (width<=900px){._0MkXVa_cards{grid-template-columns:repeat(3,minmax(0,1fr))}._0MkXVa_mid{grid-template-columns:1fr}}";
		const tagId = "@laoyuehanni/dsh-token-usage/UsageView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@laoyuehanni/dsh-token-usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var UsageView_module_css_default = {
			"back": "_0MkXVa_back",
			"button": "_0MkXVa_button",
			"cards": "_0MkXVa_cards",
			"chartCol": "_0MkXVa_chartCol",
			"childLink": "_0MkXVa_childLink",
			"empty": "_0MkXVa_empty",
			"error": "_0MkXVa_error",
			"head": "_0MkXVa_head",
			"headRight": "_0MkXVa_headRight",
			"mid": "_0MkXVa_mid",
			"modelCell": "_0MkXVa_modelCell",
			"modelCol": "_0MkXVa_modelCol",
			"modelHead": "_0MkXVa_modelHead",
			"muted": "_0MkXVa_muted",
			"nestedBadge": "_0MkXVa_nestedBadge",
			"note": "_0MkXVa_note",
			"root": "_0MkXVa_root",
			"segActive": "_0MkXVa_segActive",
			"segBtn": "_0MkXVa_segBtn",
			"segmented": "_0MkXVa_segmented",
			"subagents": "_0MkXVa_subagents",
			"subagentsHead": "_0MkXVa_subagentsHead",
			"subtitle": "_0MkXVa_subtitle",
			"table": "_0MkXVa_table",
			"tableWrap": "_0MkXVa_tableWrap",
			"tokenStrip": "_0MkXVa_tokenStrip",
			"warning": "_0MkXVa_warning"
		};
		//#endregion
		//#region src/client/UsageView.tsx
		/**
		* The conversation view tab "Usage" (browser half): one entry of the
		* `conversation.view` slot ring (beside Chat / Trajectory), rendering the
		* per-session token & cost dashboard for the ACTIVE conversation. The tab
		* shows the focused session's totals (4 token buckets, cost, hit rate,
		* TTFT average, decode throughput) with a scope switch between the session
		* alone and its whole subagent subtree, a per-hour trend chart and the
		* per-model table from the host stats route (`sessionId`-scoped), and a
		* subagent table below — each row drill-in switches the focus to that child.
		*
		* Data sources: token/cost figures come from the host route (the pricing
		* rule chain's authority); TTFT and throughput come from the framework's
		* retained `sessionStats` projection values (`useProjection` for the current
		* session, `byId[].projectionValues` for every other session), which cover
		* the whole log including history written before this plugin was installed.
		* A footnote states the two scopes so the difference is not a surprise.
		*
		* @module token-usage/client/UsageView
		*/
		/** Refresh debounce: bursts of session-mirror updates (one request's events)
		* collapse into a single fetch, so the dashboard refreshes at REQUEST
		* granularity instead of per event or per turn. */
		const REFRESH_DEBOUNCE_MS = 250;
		/** One fetch of the session-scoped summary from the host stats route,
		* including the direct-child breakdown for the subagent table. */
		function fetchSessionSummary(sessionIds, childGroups, signal) {
			return fetch(STATS_PATH + encodeStatsQuery({
				sessionIds,
				childGroups,
				fields: "session"
			}), { signal }).then((response) => {
				if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
				return response.json();
			}).then((value) => {
				if (typeof value !== "object" || value === null || typeof value.total !== "object") throw new Error("unexpected stats response");
				return value;
			});
		}
		/**
		* Render the Usage view tab for the active conversation.
		* @param props - the framework session kit, the session mirror, and the
		* locale seat (from the registration's `locale:` declaration).
		* @returns the dashboard: header (title, scope switch, back), stat cards
		* and the 4-token strip, the chart/model columns, and the subagent table.
		*/
		function UsageView({ useSessions, useProjection, sessionId, t }) {
			const rootRef = (0, react.useRef)(null);
			useColorSchemeMirror(rootRef);
			const [scope, setScope] = (0, react.useState)("session");
			const [focusId, setFocusId] = (0, react.useState)(sessionId);
			(0, react.useEffect)(() => {
				setFocusId(sessionId);
			}, [sessionId]);
			const [retryToken, setRetryToken] = (0, react.useState)(0);
			const retry = () => {
				setRetryToken((token) => token + 1);
			};
			const byId = useSessions((state) => state.byId);
			const childIndex = (0, react.useMemo)(() => buildChildIndex(byId), [byId]);
			const scopeIds = (0, react.useMemo)(() => scope === "tree" ? subtreeIds(byId, focusId, childIndex) : [focusId], [
				byId,
				scope,
				focusId,
				childIndex
			]);
			const children = (0, react.useMemo)(() => directSubagentIds(byId, focusId, childIndex), [
				byId,
				focusId,
				childIndex
			]);
			const childGroups = (0, react.useMemo)(() => children.map((id) => scope === "tree" ? subtreeIds(byId, id, childIndex) : [id]), [
				children,
				scope,
				byId,
				childIndex
			]);
			const backParent = subagentParentOf(byId, focusId);
			const liveStats = useProjection("sessionStats");
			const freshnessKey = buildStatsFreshnessKey([.../* @__PURE__ */ new Set([...scopeIds, ...children])], {
				activeSessionId: sessionId,
				rows: byId,
				liveSessionStats: liveStats
			});
			const debouncedKey = useDebouncedValue(`${scopeIds.join("\n")}\n\t${childGroups.map((group) => group.join(",")).join(";")}\n\t${freshnessKey}`, REFRESH_DEBOUNCE_MS);
			const [summaryState] = useAsyncResource((signal) => {
				const [idsPart, groupsPart] = debouncedKey.split("\n	");
				return fetchSessionSummary((idsPart ?? "").split("\n").filter((id) => id !== ""), (groupsPart ?? "").split(";").filter((group) => group !== "").map((group) => group.split(",")), signal);
			}, [debouncedKey, retryToken], {
				silentAfterFirst: true,
				retryToken
			});
			const stats = (0, react.useMemo)(() => {
				return aggregateProjections(scopeIds.map((id) => {
					if (id === sessionId) return liveStats;
					return byId[id]?.projectionValues?.sessionStats;
				}));
			}, [
				scopeIds,
				sessionId,
				liveStats,
				byId
			]);
			const ttftText = stats !== void 0 && stats.ttftSteps > 0 ? formatTtft(stats.ttftMs / stats.ttftSteps) : "—";
			const speedText = stats !== void 0 && stats.decodeMs > 0 ? formatSpeed(stats.decodeTokens / (stats.decodeMs / 1e3)) : "—";
			const header = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("header", {
				className: UsageView_module_css_default["head"],
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: UsageView_module_css_default["headRight"],
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: UsageView_module_css_default["segmented"],
						role: "group",
						"aria-label": t("view.scope.label"),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: scope === "session" ? `${UsageView_module_css_default["segBtn"]} ${UsageView_module_css_default["segActive"]}` : UsageView_module_css_default["segBtn"],
							"aria-pressed": scope === "session",
							onClick: () => setScope("session"),
							children: t("view.scope.session")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: scope === "tree" ? `${UsageView_module_css_default["segBtn"]} ${UsageView_module_css_default["segActive"]}` : UsageView_module_css_default["segBtn"],
							"aria-pressed": scope === "tree",
							onClick: () => setScope("tree"),
							children: t("view.scope.tree")
						})]
					})
				})
			});
			if (summaryState.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: UsageView_module_css_default["root"],
				children: [header, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: UsageView_module_css_default["muted"],
					children: t("loading")
				})]
			});
			if (summaryState.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: UsageView_module_css_default["root"],
				children: [
					header,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: UsageView_module_css_default["error"],
						children: t("loadFailed", { message: summaryState.message })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: UsageView_module_css_default["button"],
						onClick: retry,
						children: t("retry")
					})
				]
			});
			const summary = summaryState.value;
			const view = currencyViewOf(summary);
			const { total } = summary;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				className: UsageView_module_css_default["root"],
				children: [
					header,
					total.requests === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: UsageView_module_css_default["empty"],
						children: t("view.empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: UsageView_module_css_default["cards"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.requests"),
									value: total.requests.toLocaleString()
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.cost"),
									value: formatCost(summary.totalCost, view)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.totalTokens"),
									value: formatTokens(totalTokens(total))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("stat.hitRate"),
									value: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HitRateText, { totals: total })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("view.ttft"),
									value: ttftText
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatCard, {
									label: t("view.speed"),
									value: `${speedText} tok/s`
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: UsageView_module_css_default["tokenStrip"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									t("stat.input"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: formatTokens(total.inputTokens) })
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									t("stat.output"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: formatTokens(total.outputTokens) })
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									t("stat.cacheRead"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: formatTokens(total.cacheReadTokens) })
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									t("stat.cacheWrite"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: formatTokens(total.cacheWriteTokens) })
								] })
							]
						}),
						summary.unpricedModels.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: UsageView_module_css_default["warning"],
							role: "status",
							children: t("unpriced.warning", {
								count: String(summary.unpricedModels.length),
								models: summary.unpricedModels.join(", "),
								zero: formatCost(0, view)
							})
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: UsageView_module_css_default["mid"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: UsageView_module_css_default["chartCol"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: UsageView_module_css_default["subtitle"],
									children: t("view.chart.title")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrendChart, {
									rows: summary.byDay,
									t,
									...summary.requestSeries !== void 0 ? { requests: summary.requestSeries } : {},
									...summary.byDay.length === 1 ? { hours: summary.byHour } : {}
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
								className: UsageView_module_css_default["modelCol"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: UsageView_module_css_default["subtitle"],
									children: t("byModel.title")
								}), summary.byModel.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: UsageView_module_css_default["tableWrap"],
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
										className: UsageView_module_css_default["table"],
										"aria-label": t("byModel.title"),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												className: UsageView_module_css_default["modelHead"],
												children: t("filter.model")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.requests") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.input") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.output") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cacheRead") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cacheWrite") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.hitRate") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cost") })
										] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: summary.byModel.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												className: UsageView_module_css_default["modelCell"],
												children: row.model
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.totals.requests.toLocaleString() }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.inputTokens) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.outputTokens) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheReadTokens) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatTokens(row.totals.cacheWriteTokens) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HitRateText, { totals: row.totals }) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatCost(row.cost, view) })
										] }, row.model)) })]
									})
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: UsageView_module_css_default["muted"],
									children: t("chart.empty")
								})]
							})]
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: UsageView_module_css_default["subagents"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: UsageView_module_css_default["subagentsHead"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: UsageView_module_css_default["subtitle"],
								children: t("view.subagents.title", { count: String(children.length) })
							}), (() => {
								if (backParent === void 0) return null;
								const parentSummary = byId[backParent];
								if (parentSummary === void 0) return null;
								const parentId = backParent;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: UsageView_module_css_default["back"],
									onClick: () => setFocusId(parentId),
									children: t("view.back", { title: parentSummary.displayTitle ?? parentId })
								});
							})()]
						}), children.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: UsageView_module_css_default["muted"],
							children: t("view.subagents.none")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: UsageView_module_css_default["tableWrap"],
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								className: UsageView_module_css_default["table"],
								"aria-label": t("view.subagents.title", { count: String(children.length) }),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										className: UsageView_module_css_default["modelHead"],
										children: t("view.subagents.titleCol")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.requests") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.totalTokens") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.cost") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("stat.hitRate") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("view.ttft") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: t("view.speed") })
								] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: children.map((id) => {
									const child = byId[id];
									const row = summary.children?.[id];
									const childStats = aggregateProjections([byId[id]?.projectionValues?.sessionStats]);
									const nestedCount = directSubagentIds(byId, id, childIndex).length;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: UsageView_module_css_default["modelCell"],
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: UsageView_module_css_default["childLink"],
												onClick: () => setFocusId(id),
												children: child?.displayTitle ?? id
											}), nestedCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: UsageView_module_css_default["nestedBadge"],
												"aria-label": t("view.subagents.nested", { count: String(nestedCount) }),
												children: [
													"(",
													nestedCount,
													")"
												]
											}) : null]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row?.total.requests.toLocaleString() ?? "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row !== void 0 ? formatTokens(totalTokens(row.total)) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row !== void 0 ? formatCost(row.totalCost, view) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HitRateText, { totals: row.total }) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: childStats !== void 0 && childStats.ttftSteps > 0 ? formatTtft(childStats.ttftMs / childStats.ttftSteps) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: childStats !== void 0 && childStats.decodeMs > 0 ? `${formatSpeed(childStats.decodeTokens / (childStats.decodeMs / 1e3))} tok/s` : "—" })
									] }, id);
								}) })]
							})
						})]
					}),
					total.requests > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: UsageView_module_css_default["note"],
						children: t("view.note")
					})
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
			"pricing.exchangeRateNote": "按 1 USD = {rate} CNY 换算",
			"pricing.unpriced": "未定价",
			"pricing.windowSep": "、",
			"unpriced.warning": "{count} 个模型未定价：{models}（费用按 {zero} 计）",
			"dataDir": "数据目录：{path}",
			"card.title": "Token 用量",
			"card.description": "数据目录与定价数据源",
			"card.expand": "展开",
			"card.collapse": "折叠",
			"card.unsaved": "未保存",
			"card.readOnly": "设置文档当前为只读，本次无法修改。",
			"card.pathLabel": "数据目录",
			"card.pathHint": "留空使用默认位置（~/.dsh/token-usage）。",
			"card.browse": "浏览…",
			"card.picking": "选择中…",
			"card.migratingCopy": "正在复制数据 {done}/{total} 个文件…",
			"card.migratingClean": "正在清理旧目录 {done}/{total} 个文件…",
			"card.regionLabel": "定价区域",
			"card.regionDefault": "默认（国内 Gitee）",
			"card.region.domestic": "国内（Gitee）",
			"card.region.overseas": "全球（GitHub）",
			"card.hint": "切换到「全球」后从 GitHub 镜像拉取定价表，费用按美元展示（RMB ÷ 汇率）；保存后立即重新同步，失败沿用旧镜像。",
			"card.overridden": "已覆盖默认值",
			"card.save": "保存",
			"card.saving": "保存中…",
			"card.saveFailed": "保存未生效，请重试。",
			"card.saveBlockedSessions": "有会话正在进行对话，无法保存目录修改；请等待对话结束（当前 {count} 个）。",
			"card.discard": "放弃",
			"card.fullSync.title": "全量扫描同步",
			"card.fullSync.hint": "手动扫一遍所有 session 日志，把可能漏掉的历史请求补进来（已记录的会跳过）。",
			"card.fullSync.button": "开始扫描",
			"card.fullSync.running": "扫描中…",
			"card.fullSync.progress": "已处理 {processed}/{total} 个 session，新增 {added} 条，跳过 {skipped} 条",
			"card.fullSync.done": "扫描完成：新增 {added} 条，跳过 {skipped} 条",
			"card.fullSync.failed": "扫描失败：{error}",
			"loadFailed": "统计加载失败：{message}",
			"empty": "暂无数据。可调整筛选条件；模型请求成功后会自动写入，安装前已发生的历史记录会在首次启动时自动补齐。",
			"chart.empty": "区间内暂无数据",
			"chart.aria": "每日总 token 曲线",
			"chart.ariaHour": "单日分时 token 曲线",
			"chart.ariaRequests": "按时间分段的 token 曲线",
			"chart.pointLabel": "{day} 总量 {tokens}",
			"chart.bucket": "{window} · {count} 请求 · {tokens}",
			"view.usage": "用量",
			"view.scope.label": "统计范围",
			"view.scope.session": "本会话",
			"view.scope.tree": "含子会话",
			"view.back": "← 返回 {title}",
			"view.ttft": "平均首token",
			"view.speed": "token速度",
			"view.empty": "该会话暂无用量记录。",
			"view.chart.title": "趋势",
			"view.subagents.title": "子会话（{count}）",
			"view.subagents.none": "无子会话",
			"view.subagents.titleCol": "会话",
			"view.subagents.nested": "含 {count} 个子会话",
			"view.note": "注：token 与费用来自本插件的请求记录（安装后）；平均首token 与 token速度来自 DSH 会话投影（含安装前历史）。",
			"chip.tokens": "含子会话 token 用量 {value}",
			"chip.hitRate": "含子会话缓存命中率 {value}",
			"chip.cost": "含子会话费用 {value}",
			"quota.trigger": "供应商配额",
			"quota.triggerSummary": "{name} · {figure}",
			"quota.panel": "供应商配额面板",
			"quota.tier.fiveHour": "5 小时",
			"quota.tier.weekly": "每周",
			"quota.tier.monthly": "每月",
			"quota.tier.balance": "余额",
			"quota.resetIn": "{time} 后重置",
			"quota.updatedAt": "更新于 {time}",
			"quota.retry": "重试",
			"quota.error.auth": "鉴权失败（{message}）；请检查该供应商的 API Key。",
			"quota.error.noCredential": "未解析到 API Key（{ref}）；请先在供应商设置中配置密钥。",
			"quota.error.http": "供应商接口返回错误（{message}）。",
			"quota.error.network": "网络错误（{message}）。",
			"quota.error.parse": "响应解析失败（{message}）。"
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
			"pricing.exchangeRateNote": "Converted at 1 USD = {rate} CNY",
			"pricing.unpriced": "Unpriced",
			"pricing.windowSep": ", ",
			"unpriced.warning": "{count} models unpriced: {models} (cost counts as {zero})",
			"dataDir": "Data directory: {path}",
			"card.title": "Token Usage",
			"card.description": "Data directory and pricing source",
			"card.expand": "Expand",
			"card.collapse": "Collapse",
			"card.unsaved": "Unsaved",
			"card.readOnly": "The settings document is read-only right now; changes are disabled.",
			"card.pathLabel": "Data directory",
			"card.pathHint": "Leave empty for the default location (~/.dsh/token-usage).",
			"card.browse": "Browse…",
			"card.picking": "Picking…",
			"card.migratingCopy": "Copying data {done}/{total} files…",
			"card.migratingClean": "Cleaning the old directory {done}/{total} files…",
			"card.regionLabel": "Pricing region",
			"card.regionDefault": "Default (Gitee)",
			"card.region.domestic": "CN (Gitee)",
			"card.region.overseas": "Global (GitHub)",
			"card.hint": "Switching to Global pulls the pricing table from the GitHub mirror and shows costs in USD (RMB ÷ rate); saving re-syncs immediately, falling back to the previous mirror on failure.",
			"card.overridden": "Overriding the default",
			"card.save": "Save",
			"card.saving": "Saving…",
			"card.saveFailed": "The save did not land; try again.",
			"card.saveBlockedSessions": "A conversation is still in progress, so the directory change was not saved; wait for it to end first ({count} active).",
			"card.discard": "Discard",
			"card.fullSync.title": "Full scan sync",
			"card.fullSync.hint": "Walk every session log once and fold any historical requests the log does not yet hold (rows already recorded are skipped).",
			"card.fullSync.button": "Start scan",
			"card.fullSync.running": "Scanning…",
			"card.fullSync.progress": "Processed {processed}/{total} sessions, added {added}, skipped {skipped}",
			"card.fullSync.done": "Scan complete: added {added}, skipped {skipped}",
			"card.fullSync.failed": "Scan failed: {error}",
			"loadFailed": "Failed to load stats: {message}",
			"empty": "No data yet. Adjust the filters; requests are written automatically after each successful model call, and pre-install history is backfilled automatically on the first startup.",
			"chart.empty": "No data in range",
			"chart.aria": "Daily total token trend",
			"chart.ariaHour": "Single-day hourly token trend",
			"chart.ariaRequests": "Time-bucketed token trend",
			"chart.pointLabel": "{day} total {tokens}",
			"chart.bucket": "{window} · {count} requests · {tokens}",
			"view.usage": "Usage",
			"view.scope.label": "Scope",
			"view.scope.session": "Session",
			"view.scope.tree": "With subagents",
			"view.back": "← Back to {title}",
			"view.ttft": "Avg TTFT",
			"view.speed": "Token speed",
			"view.empty": "No usage recorded for this session.",
			"view.chart.title": "Trend",
			"view.subagents.title": "Subagents ({count})",
			"view.subagents.none": "No subagents",
			"view.subagents.titleCol": "Session",
			"view.subagents.nested": "With {count} subagents",
			"view.note": "Note: tokens and cost come from this plugin's request log (post-install); average TTFT and token speed come from the DSH session projection (includes pre-install history).",
			"chip.tokens": "Tokens with subagents {value}",
			"chip.hitRate": "Cache hit rate with subagents {value}",
			"chip.cost": "Cost with subagents {value}",
			"quota.trigger": "Provider quota",
			"quota.triggerSummary": "{name} · {figure}",
			"quota.panel": "Provider quota panel",
			"quota.tier.fiveHour": "5-hour",
			"quota.tier.weekly": "Weekly",
			"quota.tier.monthly": "Monthly",
			"quota.tier.balance": "Balance",
			"quota.resetIn": "resets in {time}",
			"quota.updatedAt": "Updated {time}",
			"quota.retry": "Retry",
			"quota.error.auth": "Authentication failed ({message}); check this provider's API key.",
			"quota.error.noCredential": "No API key resolved ({ref}); configure the provider's key first.",
			"quota.error.http": "The provider endpoint returned an error ({message}).",
			"quota.error.network": "Network error ({message}).",
			"quota.error.parse": "Failed to parse the response ({message})."
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* Namespace of the token-usage settings section. Spelled here rather than
		* imported: a client package must not depend on a Host package.
		*/
		const TOKEN_USAGE_NS = "token-usage";
		/** Required services: the slot registry, the locale dictionaries, the
		* settings scope, and the workspace service (its native directory picker
		* backs the card's browse button). */
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"settingsScope",
			"workspaces"
		];
		/**
		* Register the dictionary pair, then the settings page and the plugin
		* configuration card once the shell's declarations are on the ledger.
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
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "usage",
				order: 20,
				label: () => t("view.usage"),
				locale: NS
			}, UsageView));
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "session-stats",
				order: -10,
				locale: NS
			}, SessionStatsChip));
			const modelDirectory = { service: void 0 };
			ctx.inject(["modelDirectories"], (modelCtx) => {
				modelCtx.effect(() => {
					modelDirectory.service = modelCtx.modelDirectories;
					return () => {
						modelDirectory.service = void 0;
					};
				}, "token-usage: model directory seam");
			});
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "token-usage-quota",
				order: 10,
				locale: NS,
				inject: () => ({ modelDirectory })
			}, QuotaButton));
			const form = new CardForm(ctx.settingsScope.bind({ namespace: TOKEN_USAGE_NS }));
			const store = form.bind();
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: TOKEN_USAGE_NS,
				locale: NS,
				inject: () => ({
					hooks: { tokenUsageCard: store },
					...form.actions(),
					pickDirectory: () => ctx.workspaces.pickDirectory()
				})
			}, TokenUsageCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map