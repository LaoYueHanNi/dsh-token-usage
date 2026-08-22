window.__ModuleLoader__.load({
	id: "dsh-token-usage",
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
		//#region \0dsh-css:D:\Code\dsh-token-usage\src\client\TokenUsageCard.module.css.mjs
		const css$2 = "._1bMeTa_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}._1bMeTa_card:hover{border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._1bMeTa_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._1bMeTa_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._1bMeTa_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._1bMeTa_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._1bMeTa_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._1bMeTa_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}._1bMeTa_chevronOpen{transform:rotate(180deg)}._1bMeTa_body{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;margin:0 16px;padding:12px 0 8px;display:flex}._1bMeTa_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._1bMeTa_field{flex-direction:column;gap:4px;display:flex}._1bMeTa_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}._1bMeTa_input{box-sizing:border-box;width:100%;font:inherit;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);appearance:none;border-radius:6px;padding:4px 8px;font-size:13px;line-height:20px}._1bMeTa_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}._1bMeTa_input:disabled{opacity:.6}._1bMeTa_inputRow{align-items:center;gap:6px;display:flex}._1bMeTa_inputRow ._1bMeTa_input{flex:1;min-width:0}._1bMeTa_browse{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border-radius:6px;flex:none;padding:4px 10px;font-size:13px;line-height:20px}._1bMeTa_browse:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_browse:disabled{opacity:.4;cursor:default}._1bMeTa_browse:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._1bMeTa_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}._1bMeTa_migration{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:6px;flex-direction:column;gap:4px;padding:8px 10px;display:flex}._1bMeTa_migrationLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;line-height:1.5}._1bMeTa_migrationBar{background:var(--dsw-alias-bg-multi-select);border-radius:2px;height:4px;display:block;overflow:hidden}._1bMeTa_migrationFill{background:var(--dsw-alias-brand-primary);border-radius:2px;height:100%;transition:width .2s;display:block}._1bMeTa_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:8px 0 4px;display:flex}._1bMeTa_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}._1bMeTa_discard,._1bMeTa_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}._1bMeTa_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}._1bMeTa_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}._1bMeTa_discard:disabled,._1bMeTa_save:disabled{opacity:.4;cursor:default}._1bMeTa_discard:focus-visible,._1bMeTa_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._1bMeTa_fullSync{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}._1bMeTa_fullSyncHeader{flex-direction:column;gap:2px;display:flex}._1bMeTa_fullSyncTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4}._1bMeTa_fullSyncHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}._1bMeTa_fullSyncButton{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border-radius:6px;align-self:flex-start;padding:4px 12px;font-size:13px;line-height:20px}._1bMeTa_fullSyncButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._1bMeTa_fullSyncButton:disabled{opacity:.5;cursor:default}._1bMeTa_fullSyncButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}._1bMeTa_fullSyncProgress{flex-direction:column;gap:4px;display:flex}._1bMeTa_fullSyncProgressLabel{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;line-height:1.5}._1bMeTa_fullSyncBar{background:var(--dsw-alias-bg-multi-select);border-radius:2px;height:4px;display:block;overflow:hidden}._1bMeTa_fullSyncFill{background:var(--dsw-alias-brand-primary);border-radius:2px;height:100%;transition:width .2s;display:block}._1bMeTa_fullSyncResult{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin:0;font-size:12px;line-height:1.5}._1bMeTa_fullSyncError{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}";
		const tagId$2 = "dsh-token-usage/TokenUsageCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
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
		const css = ".RbkiSa_section{flex-direction:column;gap:16px;width:100%;display:flex}.RbkiSa_head{justify-content:space-between;align-items:center;gap:12px;display:flex}.RbkiSa_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600}.RbkiSa_muted{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}.RbkiSa_rateNote{color:var(--dsw-alias-label-secondary);margin:6px 0 0;font-size:12px}.RbkiSa_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px}.RbkiSa_subtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;font-weight:600}.RbkiSa_tableWrap{overflow-x:auto}.RbkiSa_table{border-collapse:collapse;font-variant-numeric:tabular-nums;width:100%;min-width:500px;font-size:12px}.RbkiSa_table th,.RbkiSa_table td{text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;padding:4px 6px}.RbkiSa_table th.RbkiSa_modelHead,.RbkiSa_table td.RbkiSa_modelCol{text-align:left;width:150px;max-width:150px}.RbkiSa_table th{color:var(--dsw-alias-label-secondary);font-weight:500}.RbkiSa_table td{color:var(--dsw-alias-label-primary)}.RbkiSa_empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.RbkiSa_button{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px;line-height:20px}.RbkiSa_button:hover{background:var(--dsw-interactive-bg-hover)}.RbkiSa_filters{flex-wrap:nowrap;align-items:center;gap:8px;display:flex}.RbkiSa_control,.RbkiSa_modelControl{appearance:none;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-position:right 6px center;background-repeat:no-repeat;background-size:12px 12px;padding-right:26px}.RbkiSa_control{box-sizing:border-box;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 26px 4px 8px;font-size:13px;line-height:20px}.RbkiSa_dateControl{box-sizing:border-box;width:138px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;padding:4px 6px;font-size:13px;line-height:20px}.RbkiSa_modelControl{box-sizing:border-box;text-overflow:ellipsis;min-width:0;max-width:220px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 26px 4px 8px;font-size:13px;line-height:20px;overflow:hidden}.RbkiSa_rangeSeparator{color:var(--dsw-alias-label-secondary);font-size:12px}.RbkiSa_cards{grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;display:grid}.RbkiSa_card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}.RbkiSa_cardLabel{color:var(--dsw-alias-label-secondary);font-size:12px;display:block}.RbkiSa_cardValue{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}.RbkiSa_cardValueCost{font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-warn-primary);margin-top:4px;font-size:18px;font-weight:600;display:block}.RbkiSa_warning{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:6px;margin:0;padding:6px 10px;font-size:12px}.RbkiSa_modelCell{align-items:center;gap:4px;max-width:138px;display:inline-flex;position:relative}.RbkiSa_modelName{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.RbkiSa_unpricedTag{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:8px;flex:none;padding:0 6px;font-size:10px;line-height:16px}.RbkiSa_costCell{color:var(--dsw-alias-state-warn-primary);font-weight:600}.RbkiSa_pricingButton{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;border-radius:8px;flex:none;padding:0 6px;font-size:10px;line-height:16px}.RbkiSa_pricingButton:hover{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);border-color:var(--dsw-alias-state-warn-primary)}.RbkiSa_dialog{width:min(600px,100vw - 48px);max-height:calc(100vh - 48px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;overflow-y:auto}.RbkiSa_dialog::backdrop{background:#0006}.RbkiSa_dialogHead{justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;display:flex}.RbkiSa_dialogTitle{text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:14px;font-weight:600;overflow:hidden}.RbkiSa_dialogClose{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;padding:2px 8px;font-size:12px;line-height:18px}.RbkiSa_dialogClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-interactive-bg-hover)}th.RbkiSa_conditionHead,td.RbkiSa_conditionCell{text-align:left;white-space:normal;min-width:200px}td.RbkiSa_conditionCell{color:var(--dsw-alias-label-secondary);padding-left:20px}.RbkiSa_groupRow>td{text-align:left;white-space:normal;color:var(--dsw-alias-label-secondary);border-bottom:none;padding-top:8px;font-size:11px;font-weight:600}.RbkiSa_groupRow:not(:first-child)>td{border-top:1px solid var(--dsw-alias-border-l1)}";
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
			const view = currencyViewOf(state.summary);
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
									value: formatCost(state.summary.totalCost, view),
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
								models: state.summary.unpricedModels.join(", "),
								zero: formatCost(0, view)
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
											children: rules !== void 0 ? formatCost(row.cost, view) : "—"
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
							view,
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
			"chart.pointLabel": "{day} total {tokens}"
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