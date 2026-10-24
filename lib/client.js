window.__ModuleLoader__.load({
	id: "dsh-connect-tabbit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		/**
		 * Element factory.
		 *
		 * `react.createElement` is used directly instead of the jsx runtime so
		 * this file stays readable without a build step: every node is one call,
		 * and the whole card is plain JavaScript that the loader can evaluate as
		 * it stands.
		 */
		const h = react.createElement;

		//#region paths
		/** Plugin-owned read-only route the card renders its model rows from. */
		const MODELS_PATH = "/plugins/dsh-connect-tabbit/models";
		/** Plugin-owned route the pool + credit panel reads. */
		const USAGE_PATH = "/plugins/dsh-connect-tabbit/usage";
		/** Plugin-owned route for pool mutations. */
		const ACCOUNTS_PATH = "/plugins/dsh-connect-tabbit/accounts";
		/** Plugin-owned route that runs the daily check-in. */
		const CHECKIN_PATH = "/plugins/dsh-connect-tabbit/checkin";
		//#endregion

		//#region styles
		/**
		 * Card styles, injected once into the page head.
		 *
		 * The card reuses the host's own card classes (`dsm-plugin-card` and its
		 * header/body parts) so it sits in the settings list exactly like the
		 * cards the desktop ships, and adds only the rows it owns. Every colour is
		 * a theme token with a literal fallback, so the card follows the active
		 * theme instead of pinning one.
		 */
		const CSS = [
			".dsm-tabbit-body{padding:12px 14px;display:flex;flex-direction:column;gap:12px}",
			".dsm-tabbit-hint{margin:0;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:12px;line-height:1.6}",
			".dsm-tabbit-state{margin:0;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dsm-tabbit-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20)}",
			".dsm-tabbit-section{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
			".dsm-tabbit-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsm-tabbit-section-title{margin:0;font-size:13px;font-weight:600}",
			".dsm-tabbit-section-title .dsm-tabbit-state{margin-left:auto}",
			".dsm-tabbit-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}",
			".dsm-tabbit-row-main{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}",
			".dsm-tabbit-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsm-tabbit-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap}",
			".dsm-tabbit-badge-ok{border-color:var(--dsw-alias-state-success-primary,#12b76a);color:var(--dsw-alias-state-success-primary,#12b76a)}",
			".dsm-tabbit-badge-warn{border-color:var(--dsw-alias-state-warning-primary,#f79009);color:var(--dsw-alias-state-warning-primary,#f79009)}",
			".dsm-tabbit-badge-bad{border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}",
			".dsm-tabbit-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto}",
			".dsm-tabbit-row-off .dsm-tabbit-name{opacity:.55}",
			".dsm-tabbit-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
			".dsm-tabbit-button{font-size:12px;padding:5px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:transparent;color:inherit;cursor:pointer}",
			".dsm-tabbit-button:disabled{opacity:.5;cursor:default}",
			".dsm-tabbit-input{font-size:12px;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#202126);color:inherit;border:1px solid var(--dsw-alias-border-l2,#36373b);min-width:0;flex:1}",
			".dsm-tabbit-textarea{font-size:12px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#202126);color:inherit;border:1px solid var(--dsw-alias-border-l2,#36373b);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:52px;resize:vertical}",
			".dsm-tabbit-form{display:flex;flex-direction:column;gap:8px}",
			".dsm-tabbit-select{font-size:12px;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,#202126);color:inherit;border:1px solid var(--dsw-alias-border-l2,#36373b)}",
			".dsm-tabbit-figure{font-size:12px;font-variant-numeric:tabular-nums}",
			".dsm-tabbit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}",
			".dsm-tabbit-kv{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
			".dsm-tabbit-kv strong{font-size:13px;font-weight:600}",
		].join("");

		/** Inject the card stylesheet once per page. */
		function installStyles() {
			const cssId = "dsh-connect-tabbit/client.css";
			if (document.querySelector(`style[data-plugin-css="${cssId}"]`) !== null) return;
			const styleTag = document.createElement("style");
			styleTag.dataset.plugin = "dsh-connect-tabbit";
			styleTag.dataset.pluginCss = cssId;
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
		}
		//#endregion

		//#region copy
		const zh = {
			"row.title": "接入使用 Tabbit 模型与账号池 (dsh-connect-tabbit)",
			"row.desc": "内置网关随插件自动运行；登录或导入 Tabbit 国内版 / 国际版账号，查看周期额度与模型用量、每日签到。",
			"row.expand": "展开",
			"row.collapse": "收起",
			"row.loading": "正在读取…",
			"row.emptyModels": "没有可用模型：请先登录或导入该版本的账号，然后刷新模型。",
			"row.requestFailed": "读取失败",
			"row.save": "保存",
			"row.saving": "保存中…",
			"row.saved": "已保存",
			"row.discard": "撤销更改",
			"row.unsaved": "有未保存的更改",
			"row.failed": "保存失败",
			"row.refresh": "刷新模型",
			"row.refreshing": "刷新中…",
			"row.refreshed": "已更新（{time}）",
			"row.showInPicker": "在下拉框中显示",
			"row.showHint": "取消勾选的模型不会出现在模型选择器里。",
			"row.enabledCount": "已选 {count} / {total}",
			"row.enableAll": "全部显示",
			"row.imageTitle": "图像",
			"row.imageAuto": "跟随网关",
			"row.imageOn": "开启",
			"row.imageOff": "关闭",
			"row.reasonTitle": "推理",
			"row.reasonAuto": "跟随模型声明",
			"row.usageMultiplier": "用量消耗",
			"row.usageHint": "倍率来自 Tabbit，表示相对额度消耗。默认模型 0×，不消耗模型额度。",
			"row.context": "上下文 {size}",
			"row.contextFallback": "上下文 {size}（保守）",
			"row.contextOfficialHint": "Tabbit 模型目录标称长度；实际可用长度仍受服务端处理限制。",
			"row.contextFallbackHint": "Tabbit 未公布此模型长度，暂用保守值。上传附件不代表无限上下文。",
			"row.contextGatewayHint": "由网关声明的上下文长度。",
			"row.reasonOn": "开启",
			"row.reasonOff": "关闭",
			"row.vision": "视觉",
			"row.textOnly": "纯文本",
			"row.region.tabbit-cn": "国内版",
			"row.region.tabbit-global": "国际版",
			"access.free_unlimited": "免费",
			"access.free_metered": "计量",
			"access.premium_only": "PRO",
			"usage.title": "账号池与用量",
			"usage.refresh": "刷新",
			"usage.loading": "正在读取账号池…",
			"usage.unavailable": "该区域网关不可达。",
			"usage.gateway": "网关",
			"usage.embedded": "内置网关 · 自动运行",
			"usage.requests": "请求",
			"usage.successRate": "成功率",
			"usage.tokens": "账号",
			"usage.credits": "周期额度",
			"usage.cycle": "当前周期",
			"usage.reset": "距离重置",
			"usage.minutes": "分钟",
			"usage.billingHint": "额度和倍率来自 Tabbit。Token 见上方独立统计；金额仍以官方账单为准。",
			"usage.inputTokens": "输入 Token",
			"usage.outputTokens": "输出 Token",
			"usage.totalTokenUsage": "累计 Token",
			"usage.reportedTokens": "官方返回",
			"usage.notReported": "暂无回传",
			"usage.estimatedTokens": "本地估算",
			"usage.tokenHint": "含估算的请求文本量，包含重试和失败请求；不代表实际扣费。估算不含隐藏推理、图片或服务端附加 Token，不写入金额账单。记录在重启后保留。",
			"usage.recentTokens": "最近请求的 Token",
			"usage.inflight": "进行中",
			"usage.reconnects": "已续接",
			"usage.result.success": "完成",
			"usage.result.failed": "失败",
			"usage.result.cancelled": "已取消",
			"usage.result.retrying": "自动修正",
			"usage.remaining": "剩余",
			"usage.used": "已用",
			"usage.total": "总量",
			"usage.noAccounts": "账号池是空的，先在下面添加一个账号。",
			"usage.creditsUnsupported": "Tabbit 用量接口暂不可用，请确认账号所属版本后刷新。",
			"usage.noCredits": "该账号暂无可读的用量字段。",
			"usage.error": "读取失败",
			"pool.title": "账号池",
			"pool.hint": "账号保存在本机账号池，内置网关随插件自动运行；执行副本仅在内存中保留。外部网关模式会同步到外部服务。",
			"pool.add": "添加账号",
			"pool.name": "备注名",
			"pool.token": "凭据（jwt 或 jwt|nextauth|device_id）",
			"pool.region": "所属版本",
			"pool.adding": "添加中…",
			"pool.login": "登录 Tabbit",
			"pool.loginHint": "在弹出的 Tabbit 窗口中登录；完成后会自动加入账号池。",
			"pool.loginWaiting": "正在等待 Tabbit 登录完成…",
			"pool.loginSaving": "登录完成，正在保存账号…",
			"pool.loginCancel": "取消登录",
			"pool.loginSuccess": "登录成功，账号已加入账号池。",
			"pool.importLocal": "导入本机已登录账号",
			"pool.importFile": "从文件导入",
			"pool.import": "导入账号",
			"pool.importing": "正在导入…",
			"pool.importHint": "也可粘贴 JWT、完整 Cookie 或账号 JSON，或选择导出的 JSON / 文本文件。同一账号重新导入会更新登录状态。",
			"pool.importToken": "粘贴凭据、Cookie 或账号 JSON",
			"pool.imported": "导入完成：新增 {added} 个，更新 {updated} 个，已存在 {present} 个。",
			"pool.fileTooLarge": "文件过大，请选择小于 48 KB 的账号文件。",
			"pool.saved": "账号操作已完成。",
			"pool.syncWarning": "账号已保存，但同步到网关失败：{message}",
			"pool.sync": "同步到网关",
			"pool.syncing": "同步中…",
			"pool.test": "测试",
			"pool.testing": "测试中…",
			"pool.remove": "删除",
			"pool.enable": "启用",
			"pool.state.active": "可用",
			"pool.state.cooldown": "冷却",
			"pool.state.error": "异常",
			"pool.state.unknown": "未知",
			"pool.state.unmirrored": "未同步",
			"pool.checkin": "每日签到",
			"pool.checking": "签到中…",
			"pool.claimed": "已签到",
			"pool.already": "今天已签",
			"pool.checkinFailed": "签到失败",
			"pool.never": "从未签到",
			"pool.lastCheckin": "上次签到 {date}",
		};
		const en = {
			"row.title": "Connect Tabbit models and account pool (dsh-connect-tabbit)",
			"row.desc": "Sign in or import Tabbit CN / global accounts, manage the pool, cycle quota, model usage rates and daily check-in.",
			"row.expand": "Expand",
			"row.collapse": "Collapse",
			"row.loading": "Reading…",
			"row.emptyModels": "No models available: sign in or import an account for this edition, then refresh models.",
			"row.requestFailed": "Request failed",
			"row.save": "Save",
			"row.saving": "Saving…",
			"row.saved": "Saved",
			"row.discard": "Discard",
			"row.unsaved": "Unsaved changes",
			"row.failed": "Save failed",
			"row.refresh": "Refresh models",
			"row.refreshing": "Refreshing…",
			"row.refreshed": "Updated ({time})",
			"row.showInPicker": "Show in the model picker",
			"row.showHint": "Unticked models do not appear in the model picker.",
			"row.enabledCount": "{count} of {total} selected",
			"row.enableAll": "Show all",
			"row.imageTitle": "Image",
			"row.imageAuto": "Follow gateway",
			"row.imageOn": "On",
			"row.imageOff": "Off",
			"row.reasonTitle": "Reasoning",
			"row.reasonAuto": "Follow model metadata",
			"row.usageMultiplier": "Quota usage",
			"row.usageHint": "Rates come from Tabbit and compare relative quota use. The default model uses 0× quota.",
			"row.context": "Context {size}",
			"row.contextFallback": "Context {size} (conservative)",
			"row.contextOfficialHint": "Capacity stated in the Tabbit catalog; actual service processing limits still apply.",
			"row.contextFallbackHint": "Tabbit has not published this capacity; using a conservative value. Attachments do not provide unlimited context.",
			"row.contextGatewayHint": "Context capacity declared by the gateway.",
			"row.reasonOn": "On",
			"row.reasonOff": "Off",
			"row.vision": "Vision",
			"row.textOnly": "Text only",
			"row.region.tabbit-cn": "CN",
			"row.region.tabbit-global": "Global",
			"access.free_unlimited": "Free",
			"access.free_metered": "Metered",
			"access.premium_only": "PRO",
			"usage.title": "Account pool and usage",
			"usage.refresh": "Refresh",
			"usage.loading": "Reading the pool…",
			"usage.unavailable": "This region's gateway is unreachable.",
			"usage.gateway": "Gateway",
			"usage.embedded": "Built-in gateway · running automatically",
			"usage.requests": "Requests",
			"usage.successRate": "Success",
			"usage.tokens": "Accounts",
			"usage.credits": "Cycle quota",
			"usage.cycle": "Current cycle",
			"usage.reset": "Resets in",
			"usage.minutes": "minutes",
			"usage.billingHint": "Quota and rates come from Tabbit. Token telemetry is shown separately above; monetary cost requires an official bill.",
			"usage.inputTokens": "Input tokens",
			"usage.outputTokens": "Output tokens",
			"usage.totalTokenUsage": "Total tokens",
			"usage.reportedTokens": "Upstream reported",
			"usage.notReported": "Not reported",
			"usage.estimatedTokens": "Locally estimated",
			"usage.tokenHint": "Request text counts include estimates, retries and failed requests, not actual charges. Estimates exclude hidden reasoning, images and server-side tokens. They are not written to monetary bills. Records survive restarts.",
			"usage.recentTokens": "Recent token usage",
			"usage.inflight": "In progress",
			"usage.reconnects": "Reconnections",
			"usage.result.success": "Completed",
			"usage.result.failed": "Failed",
			"usage.result.cancelled": "Cancelled",
			"usage.result.retrying": "Correcting",
			"usage.remaining": "Remaining",
			"usage.used": "Used",
			"usage.total": "Total",
			"usage.noAccounts": "The pool is empty — add an account below.",
			"usage.creditsUnsupported": "Tabbit usage is unavailable. Check the account region and refresh.",
			"usage.noCredits": "No readable usage field for this account.",
			"usage.error": "Read failed",
			"pool.title": "Account pool",
			"pool.hint": "Accounts stay in the local pool. The built-in gateway starts with the plugin and keeps its execution copy in memory. External mode synchronizes to the external service.",
			"pool.add": "Add account",
			"pool.name": "Label",
			"pool.token": "Credential (jwt or jwt|nextauth|device_id)",
			"pool.region": "Edition",
			"pool.adding": "Adding…",
			"pool.login": "Log in to Tabbit",
			"pool.loginHint": "Log in in the Tabbit window. Your account will be added automatically.",
			"pool.loginWaiting": "Waiting for Tabbit login…",
			"pool.loginSaving": "Logged in, saving account…",
			"pool.loginCancel": "Cancel login",
			"pool.loginSuccess": "Logged in. Your account is in the pool.",
			"pool.importLocal": "Import local signed-in accounts",
			"pool.importFile": "Import from file",
			"pool.import": "Import accounts",
			"pool.importing": "Importing…",
			"pool.importHint": "Paste a JWT, Cookie header or account JSON, or choose an exported JSON / text file. Importing the same account renews its login.",
			"pool.importToken": "Paste credentials, cookies or account JSON",
			"pool.imported": "Imported: {added} added, {updated} updated, {present} already present.",
			"pool.fileTooLarge": "Choose an account file smaller than 48 KB.",
			"pool.saved": "Account operation completed.",
			"pool.syncWarning": "Accounts saved, but gateway sync failed: {message}",
			"pool.sync": "Sync to gateway",
			"pool.syncing": "Syncing…",
			"pool.test": "Test",
			"pool.testing": "Testing…",
			"pool.remove": "Remove",
			"pool.enable": "Enabled",
			"pool.state.active": "active",
			"pool.state.cooldown": "cooling",
			"pool.state.error": "error",
			"pool.state.unknown": "unknown",
			"pool.state.unmirrored": "not synced",
			"pool.checkin": "Daily check-in",
			"pool.checking": "Checking in…",
			"pool.claimed": "Checked in",
			"pool.already": "Already today",
			"pool.checkinFailed": "Check-in failed",
			"pool.never": "never",
			"pool.lastCheckin": "last check-in {date}",
		};
		//#endregion

		//#region helpers
		/** GET one plugin route. */
		async function getJson(path, signal) {
			const response = await fetch(path, {
				headers: { accept: "application/json" },
				credentials: "same-origin",
				signal,
			});
			const value = await response.json().catch(() => undefined);
			if (!response.ok || value === undefined) throw new Error(`HTTP ${response.status}`);
			return value;
		}

		/** POST one plugin route. */
		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(body ?? {}),
			});
			const value = await response.json().catch(() => undefined);
			if (!response.ok || value === undefined) {
				throw new Error(value?.error ?? `HTTP ${response.status}`);
			}
			return value;
		}

		function accountResultText(value, t) {
			const warnings = (value?.mirrors ?? []).flatMap(mirror => mirror.rows ?? [mirror])
				.filter(row => row.ok === false || row.state === "failed").map(row => row.message).filter(Boolean);
			const summary = value?.imported ? t("pool.imported", value.imported) : t("pool.saved");
			return warnings.length ? `${summary} ${t("pool.syncWarning", { message: [...new Set(warnings)].join("；") })}` : summary;
		}

		/**
		 * The set of model ids currently ticked, given what the host reported.
		 *
		 * The host stores an empty list as "no filter" (every model shows), so the
		 * card presents that same state as "everything ticked" — otherwise a
		 * fresh install would render every box empty while every model was
		 * visible.
		 */
		function enabledSetFor(models, saved) {
			const list = Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
			if (list.length === 0) return new Set(models.map((model) => model.id));
			return new Set(list);
		}

		/** Badge class for one pool state. */
		function stateClass(state) {
			if (state === "active") return "dsm-tabbit-badge dsm-tabbit-badge-ok";
			if (state === "cooldown") return "dsm-tabbit-badge dsm-tabbit-badge-warn";
			if (state === "error") return "dsm-tabbit-badge dsm-tabbit-badge-bad";
			return "dsm-tabbit-badge";
		}

		/** `2026-10-20T05:00:00Z` → `10-20 13:00`, tolerant of junk. */
		function formatWhen(iso) {
			if (typeof iso !== "string" || iso === "") return undefined;
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return undefined;
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		function ContextBadge({ t, model }) {
			const count = Number(model.contextWindow);
			if (!Number.isSafeInteger(count) || count <= 0) return null;
			const size = count >= 1000000 && count % 100000 === 0 ? `${count / 1000000}M`
				: count >= 1000 && count % 100 === 0 ? `${count / 1000}K` : String(count);
			const fallback = model.contextSource === "fallback";
			const hint = fallback ? "row.contextFallbackHint" : model.contextSource?.startsWith("tabbit-")
				? "row.contextOfficialHint" : "row.contextGatewayHint";
			return h("span", { className: "dsm-tabbit-badge", title: t(hint) },
				t(fallback ? "row.contextFallback" : "row.context", { size }));
		}
		//#endregion

		//#region components
		/** One number with a label. */
		function Figure({ label, value }) {
			return h(
				"div",
				{ className: "dsm-tabbit-kv" },
				h("strong", null, value),
				h("span", null, label),
			);
		}

		/** The gateway + credits panel for one region. */
		function RegionUsage({ t, entry }) {
			if (entry.available !== true) {
				return h(
					"div",
					{ className: "dsm-tabbit-section" },
					h(
						"p",
						{ className: "dsm-tabbit-state" },
						`${entry.regionName}: ${t("usage.unavailable")}`,
					),
				);
			}
			const gateway = entry.gateway;
			const credits = Array.isArray(entry.credits) ? entry.credits : [];
			const children = [
				h(
					"div",
					{ className: "dsm-tabbit-section-head" },
					h("p", { className: "dsm-tabbit-section-title" }, entry.regionName),
					h("span", { className: "dsm-tabbit-state" }, entry.gatewayMode === "embedded" ? t("usage.embedded") : entry.gatewayUrl ?? ""),
				),
			];

			if (gateway !== undefined) {
				children.push(
					h(
						"div",
						{ className: "dsm-tabbit-grid" },
						h(Figure, { label: t("usage.requests"), value: String(gateway.totalRequests) }),
						h(Figure, { label: t("usage.successRate"), value: `${gateway.successRate}%` }),
						h(Figure, {
							label: t("usage.tokens"),
							value: `${gateway.activeTokens}/${gateway.totalTokens}`,
						}),
					),
				);
				const usage = gateway.tokenUsage;
				if (usage) {
					const reported = usage.reported ?? {};
					const estimated = usage.estimated ?? {};
					const number = value => Number(value || 0).toLocaleString();
					const sum = key => number((reported[key] || 0) + (estimated[key] || 0));
					const results = { success: t("usage.result.success"), failed: t("usage.result.failed"), cancelled: t("usage.result.cancelled"), retrying: t("usage.result.retrying") };
					children.push(
						h("div", { className: "dsm-tabbit-grid", "aria-label": t("usage.totalTokenUsage") },
							h(Figure, { label: t("usage.inputTokens"), value: sum("prompt_tokens") }),
							h(Figure, { label: t("usage.outputTokens"), value: sum("completion_tokens") }),
							h(Figure, { label: t("usage.totalTokenUsage"), value: sum("total_tokens") })),
						h("p", { className: "dsm-tabbit-state" },
							`${t("usage.reportedTokens")}: ${reported.requests ? number(reported.total_tokens) : t("usage.notReported")} · ${t("usage.estimatedTokens")}: ${number(estimated.total_tokens)} · ${t("usage.inflight")}: ${number(usage.inflight)} · ${t("usage.reconnects")}: ${number(usage.reconnects)}`),
						h("p", { className: "dsm-tabbit-hint" }, t("usage.tokenHint")),
					);
					if (usage.storageError) children.push(h("p", { className: "dsm-tabbit-error" }, usage.storageError));
					if (usage.recent?.length) children.push(h("details", null,
						h("summary", null, t("usage.recentTokens")),
						h("ul", { className: "dsm-tabbit-list" }, usage.recent.slice(0, 8).map(row => h("li", { key: `${row.id}-${row.at}-${row.attempt}` },
							`${new Date(row.at).toLocaleTimeString()} · ${row.model} · ${t(row.usage.source === "reported" ? "usage.reportedTokens" : "usage.estimatedTokens")} · ${t("usage.inputTokens")}: ${number(row.usage.prompt_tokens)} · ${t("usage.outputTokens")}: ${number(row.usage.completion_tokens)} · ${results[row.status] ?? row.status}`)))));
				}
			} else if (typeof entry.gatewayError === "string") {
				children.push(
					h("p", { className: "dsm-tabbit-error" }, `${t("usage.error")}: ${entry.gatewayError}`),
				);
			}

			if (credits.length === 0) {
				children.push(h("p", { className: "dsm-tabbit-hint" }, t("usage.noAccounts")));
			} else {
				children.push(
					h(
						"ul",
						{ className: "dsm-tabbit-list" },
						credits.map((row) => {
							const parts = [];
							if (row.status !== "ok") {
								parts.push(
									h("span", { className: "dsm-tabbit-badge dsm-tabbit-badge-bad" }, t("usage.error")),
									h(
										"span",
										{ className: "dsm-tabbit-hint" },
										row.code === "credits_unsupported"
											? t("usage.creditsUnsupported")
											: (row.message ?? ""),
									),
								);
							} else if (row.kind === "quota") {
								parts.push(
									h("span", { className: "dsm-tabbit-badge" }, (row.memberLevel ?? "").toUpperCase()),
									h("span", { className: "dsm-tabbit-figure" }, `${t("usage.used")} ${row.used}%`),
									h("span", { className: "dsm-tabbit-badge" }, `${t("usage.remaining")} ${row.remaining}%`),
								);
								if (row.cycleStart && row.cycleEnd) parts.push(h("span", { className: "dsm-tabbit-hint" }, `${t("usage.cycle")} ${row.cycleStart} – ${row.cycleEnd}`));
								if (row.resetMinutes !== undefined) parts.push(h("span", { className: "dsm-tabbit-hint" }, `${t("usage.reset")} ${row.resetMinutes} ${t("usage.minutes")}`));
								parts.push(h("span", { className: "dsm-tabbit-hint" }, t("usage.billingHint")));
							} else if (row.remaining === undefined && row.total === undefined) {
								parts.push(h("span", { className: "dsm-tabbit-hint" }, t("usage.noCredits")));
							} else {
								if (row.remaining !== undefined) {
									parts.push(
										h(
											"span",
											{ className: "dsm-tabbit-figure" },
											`${t("usage.remaining")} ${row.remaining}`,
										),
									);
								}
								if (row.total !== undefined) {
									parts.push(
										h("span", { className: "dsm-tabbit-badge" }, `${t("usage.total")} ${row.total}`),
									);
								}
								if (row.used !== undefined) {
									parts.push(
										h("span", { className: "dsm-tabbit-badge" }, `${t("usage.used")} ${row.used}`),
									);
								}
							}
							return h(
								"li",
								{ className: "dsm-tabbit-row", key: `${entry.region}:${row.accountId}` },
								h(
									"span",
									{ className: "dsm-tabbit-row-main" },
									h("span", { className: "dsm-tabbit-name" }, row.accountName),
									...parts,
								),
							);
						}),
					),
				);
			}
			return h("div", { className: "dsm-tabbit-section" }, ...children);
		}

		/** The pool manager: add, enable/disable, test, remove, sync, check in. */
		function PoolPanel({ t, accounts, poolByAccount, busy, regions, onImport, onImportLocal, onLogin, onCancelLogin, login, onToggle, onRemove, onTest, onSync, onCheckin, checkinRows }) {
			const [name, setName] = react.useState("");
			const [token, setToken] = react.useState("");
			const [region, setRegion] = react.useState("");
			const [fileError, setFileError] = react.useState(undefined);
			const loggingIn = ["starting", "waiting", "saving"].includes(login?.status);

			// The region list arrives asynchronously with the model catalog, so the
			// selection is resolved at render time rather than seeded in an effect:
			// before the first load there is nothing to seed from, and an account
			// cannot be added without an edition to bind it to.
			const editions = Array.isArray(regions) ? regions : [];
			const regionId = region !== "" ? region : (editions[0]?.id ?? "");

			const submit = async () => {
				if (token.trim() === "" || regionId === "") return;
				const result = await onImport(name.trim(), token.trim(), regionId);
				if (result?.ok) {
					setName("");
					setToken("");
				}
			};

			const rows = accounts.map((account) => {
				const pool = poolByAccount.get(account.id);
				const state = pool?.state ?? "unmirrored";
				const when = formatWhen(account.lastCheckinAt);
				// A pool shared by two editions needs each row to say which one it
				// belongs to, or the reader cannot tell why one account checks in and
				// the other does not.
				const edition = editions.find((entry) => entry.id === account.region);
				const checkinRow = Array.isArray(checkinRows)
					? checkinRows.find((row) => row.accountId === account.id)
					: undefined;
				const checkinBadge = checkinRow === undefined
					? when === undefined
						? t("pool.never")
						: t("pool.lastCheckin", { date: when })
					: checkinRow.status === "claimed"
						? t("pool.claimed")
						: checkinRow.status === "already"
							? t("pool.already")
							: `${t("pool.checkinFailed")}: ${checkinRow.message ?? ""}`;
				return h(
					"li",
					{
						className: `dsm-tabbit-row${account.enabled ? "" : " dsm-tabbit-row-off"}`,
						key: account.id,
					},
					h(
						"span",
						{ className: "dsm-tabbit-row-main" },
						h("input", {
							type: "checkbox",
							checked: account.enabled,
							disabled: busy !== undefined,
							"aria-label": `${t("pool.enable")}: ${account.name}`,
							onChange: (event) => onToggle(account.id, event.target.checked),
						}),
						h("span", { className: "dsm-tabbit-name", title: account.preview }, account.name),
						edition === undefined ? null : h("span", { className: "dsm-tabbit-badge" }, edition.name),
						h("span", { className: stateClass(state) }, t(`pool.state.${state}`)),
						h("span", { className: "dsm-tabbit-badge" }, checkinBadge),
					),
					h(
						"span",
						{ className: "dsm-tabbit-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dsm-tabbit-button",
								disabled: busy !== undefined,
								onClick: () => onTest(account.id),
							},
							busy === `test:${account.id}` ? t("pool.testing") : t("pool.test"),
						),
						h(
							"button",
							{
								type: "button",
								className: "dsm-tabbit-button",
								disabled: busy !== undefined,
								onClick: () => onRemove(account.id),
							},
							t("pool.remove"),
						),
					),
				);
			});

			return h(
				"div",
				{ className: "dsm-tabbit-section" },
				h(
					"div",
					{ className: "dsm-tabbit-section-head" },
					h("p", { className: "dsm-tabbit-section-title" }, t("pool.title")),
					h(
						"span",
						{ className: "dsm-tabbit-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dsm-tabbit-button",
								disabled: busy !== undefined,
								onClick: onSync,
							},
							busy === "sync" ? t("pool.syncing") : t("pool.sync"),
						),
						h(
							"button",
							{
								type: "button",
								className: "dsm-tabbit-button",
								disabled: busy !== undefined || accounts.length === 0,
								onClick: onCheckin,
							},
							busy === "checkin" ? t("pool.checking") : t("pool.checkin"),
						),
					),
				),
				h("p", { className: "dsm-tabbit-hint" }, t("pool.hint")),
				rows.length === 0
					? h("p", { className: "dsm-tabbit-hint" }, t("usage.noAccounts"))
					: h("ul", { className: "dsm-tabbit-list" }, ...rows),
				h(
					"div",
					{ className: "dsm-tabbit-form" },
					h(
						"select",
						{
							className: "dsm-tabbit-input",
							value: regionId,
							disabled: busy !== undefined || loggingIn || editions.length === 0,
							"aria-label": t("pool.region"),
							onChange: (event) => setRegion(event.target.value),
						},
						...editions.map((entry) =>
							h("option", { value: entry.id, key: entry.id }, entry.name ?? entry.id),
						),
					),
					h("input", {
						className: "dsm-tabbit-input",
						placeholder: t("pool.name"),
						"aria-label": t("pool.name"),
						value: name,
						disabled: busy !== undefined,
						onChange: (event) => setName(event.target.value),
					}),
					h("div", { className: "dsm-tabbit-actions" },
						h("button", { type: "button", className: "dsm-tabbit-button", disabled: busy !== undefined || loggingIn || !regionId, onClick: () => onLogin(name.trim(), regionId) }, t("pool.login")),
						h("button", { type: "button", className: "dsm-tabbit-button", disabled: busy !== undefined || loggingIn || !regionId, onClick: () => onImportLocal(regionId) }, busy === "import-local" ? t("pool.importing") : t("pool.importLocal")),
					),
					h("p", { className: "dsm-tabbit-hint" }, t("pool.loginHint")),
					loggingIn ? h("div", { className: "dsm-tabbit-actions", role: "status", "aria-live": "polite" },
						h("span", { className: "dsm-tabbit-state" }, t(login.status === "saving" ? "pool.loginSaving" : "pool.loginWaiting")),
						h("button", { type: "button", className: "dsm-tabbit-button", disabled: busy !== undefined || login.status === "saving", onClick: onCancelLogin }, t("pool.loginCancel")),
					) : null,
					h("p", { className: "dsm-tabbit-hint" }, t("pool.importHint")),
					h("textarea", {
						className: "dsm-tabbit-textarea",
						placeholder: t("pool.importToken"),
						"aria-label": t("pool.importToken"),
						autoComplete: "off",
						spellCheck: false,
						value: token,
						disabled: busy !== undefined,
						onChange: (event) => setToken(event.target.value),
					}),
					h(
						"div",
						{ className: "dsm-tabbit-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dsm-tabbit-button",
								disabled: busy !== undefined || loggingIn || token.trim() === "" || regionId === "",
								onClick: submit,
							},
							busy === "import" ? t("pool.importing") : t("pool.import"),
						),
						h("label", { className: "dsm-tabbit-state" }, t("pool.importFile"), " ", h("input", {
							type: "file", accept: ".json,.txt,application/json,text/plain", "aria-label": t("pool.importFile"), disabled: busy !== undefined || loggingIn || !regionId,
							onChange: async event => {
								const input = event.target;
								const file = input.files?.[0];
								if (!file) return;
								setFileError(undefined);
								try {
									if (file.size > 48 * 1024) throw new Error(t("pool.fileTooLarge"));
									const content = await file.text();
									await onImport(name.trim(), content, regionId);
								} catch (error) { setFileError(error instanceof Error ? error.message : String(error)); }
								finally { input.value = ""; }
							},
						})),
					),
					fileError ? h("p", { className: "dsm-tabbit-error", role: "alert" }, fileError) : null,
				),
			);
		}
		//#endregion

		//#region card
		/** The settings card. */
		function TabbitPluginCard({ t, settingsScope }) {
			if (t === undefined) throw new Error("Tabbit settings card requires its translation function");

			const [open, setOpen] = react.useState(false);
			const [models, setModels] = react.useState([]);
			const [regions, setRegions] = react.useState([]);
			const [enabledIds, setEnabledIds] = react.useState({});
			const [savedEnabledIds, setSavedEnabledIds] = react.useState({});
			const [imageOverrides, setImageOverrides] = react.useState({});
			const [savedImageOverrides, setSavedImageOverrides] = react.useState({});
			const [reasoningOverrides, setReasoningOverrides] = react.useState({});
			const [savedReasoningOverrides, setSavedReasoningOverrides] = react.useState({});
			const [status, setStatus] = react.useState("loading");
			const [saving, setSaving] = react.useState(false);
			const [notice, setNotice] = react.useState(undefined);
			const [refreshing, setRefreshing] = react.useState(false);
			const [refreshedAt, setRefreshedAt] = react.useState(undefined);
			const [usage, setUsage] = react.useState([]);
			const [usageStatus, setUsageStatus] = react.useState("idle");
			const [accounts, setAccounts] = react.useState([]);
			const [busy, setBusy] = react.useState(undefined);
			const [checkinRows, setCheckinRows] = react.useState(undefined);
			const [login, setLogin] = react.useState({ status: "idle" });
			const mounted = react.useRef(true);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			/**
			 * Read the model roster from the host route.
			 *
			 * The roster is live catalog state, not configuration, so it is never
			 * persisted. `refresh` asks the host to re-read it from the gateway and
			 * the gateway to re-read it from Tabbit. The settings fields are only
			 * seeded on the first load: a refresh must not clobber edits the user
			 * has staged but not yet saved.
			 */
			const load = react.useCallback(async (refresh, signal) => {
				if (refresh) setRefreshing(true);
				try {
					const value = await getJson(`${MODELS_PATH}${refresh ? "?refresh=1" : ""}`, signal);
					if (!mounted.current) return;
					setModels(Array.isArray(value.models) ? value.models : []);
					setRegions(Array.isArray(value.regions) ? value.regions : []);
					if (!refresh) {
						const overrides = value.imageOverrides !== null && typeof value.imageOverrides === "object" ? value.imageOverrides : {};
						const reasoning = value.reasoningOverrides !== null && typeof value.reasoningOverrides === "object" ? value.reasoningOverrides : {};
						const savedEnabled = value.enabledModelIds !== null && typeof value.enabledModelIds === "object" ? value.enabledModelIds : {};
						setImageOverrides(overrides);
						setSavedImageOverrides(overrides);
						setReasoningOverrides(reasoning);
						setSavedReasoningOverrides(reasoning);
						setEnabledIds(savedEnabled);
						setSavedEnabledIds(savedEnabled);
					}
					setRefreshedAt(typeof value.refreshedAt === "number" ? value.refreshedAt : Date.now());
					setStatus("ready");
				} catch (error) {
					if (!mounted.current || signal?.aborted === true) return;
					setStatus("error");
					setNotice(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setRefreshing(false);
				}
			}, []);

			/** Read the pool + credit panel and the account list. */
			const loadUsage = react.useCallback(async (refresh) => {
				setUsageStatus("loading");
				try {
					const [usageValue, accountsValue] = await Promise.all([
						getJson(`${USAGE_PATH}${refresh ? "?refresh=1" : ""}`),
						getJson(ACCOUNTS_PATH),
					]);
					if (!mounted.current) return;
					setUsage(Array.isArray(usageValue.regions) ? usageValue.regions : []);
					setAccounts(Array.isArray(accountsValue.accounts) ? accountsValue.accounts : []);
					if (accountsValue.login) setLogin(accountsValue.login);
					setUsageStatus("ready");
				} catch (error) {
					if (!mounted.current) return;
					setUsageStatus("error");
					setNotice(error instanceof Error ? error.message : String(error));
				}
			}, []);

			react.useEffect(() => {
				if (!["starting", "waiting", "saving"].includes(login.status)) return;
				let stopped = false;
				const timer = setTimeout(async () => {
					try {
						const value = await postJson(ACCOUNTS_PATH, { action: "login-status" });
						if (stopped || !mounted.current) return;
						setLogin(value.login);
						if (value.login.status === "success") {
							if (Array.isArray(value.accounts)) setAccounts(value.accounts);
							setNotice(`${t("pool.loginSuccess")} ${accountResultText(value.login.result, t)}`);
							void loadUsage(true);
						} else if (value.login.status === "error") setNotice(value.login.message);
					} catch (error) {
						if (stopped || !mounted.current) return;
						setNotice(error instanceof Error ? error.message : String(error));
						setLogin(current => ({ ...current, status: "error" }));
					}
				}, 1500);
				return () => { stopped = true; clearTimeout(timer); };
			}, [login, loadUsage, t]);

			react.useEffect(() => {
				const controller = new AbortController();
				void load(false, controller.signal);
				return () => {
					controller.abort();
				};
			}, [load]);

			// The panel is only read once the card is opened: it makes upstream
			// calls for every account, and a collapsed card must cost nothing.
			react.useEffect(() => {
				if (!open) return;
				void loadUsage(false);
			}, [open, loadUsage]);

			react.useEffect(() => {
				if (!open) return;
				let stopped = false;
				let pending = false;
				const timer = setInterval(async () => {
					if (pending || document.visibilityState === "hidden") return;
					pending = true;
					try {
						const value = await getJson(`${USAGE_PATH}?telemetry=1`);
						if (!stopped && mounted.current) setUsage(Array.isArray(value.regions) ? value.regions : []);
					} catch { /* retain the last successful reading */ }
					finally { pending = false; }
				}, 5000);
				return () => { stopped = true; clearInterval(timer); };
			}, [open]);

			const dirty = react.useMemo(
				() =>
					JSON.stringify(imageOverrides) !== JSON.stringify(savedImageOverrides) ||
					JSON.stringify(reasoningOverrides) !== JSON.stringify(savedReasoningOverrides) ||
					JSON.stringify(enabledIds) !== JSON.stringify(savedEnabledIds),
				[imageOverrides, savedImageOverrides, reasoningOverrides, savedReasoningOverrides, enabledIds, savedEnabledIds],
			);

			const setImage = react.useCallback((modelId, mode) => {
				setImageOverrides((current) => {
					const next = { ...current };
					// "auto" is the absence of an override, so an auto row never writes
					// a key — the saved document stays minimal and a future catalog
					// change is picked up again.
					if (mode === "auto") delete next[modelId];
					else next[modelId] = mode;
					return next;
				});
				setNotice(undefined);
			}, []);

			const setReasoning = react.useCallback((modelId, mode) => {
				setReasoningOverrides((current) => {
					const next = { ...current };
					if (mode === "auto") delete next[modelId];
					else next[modelId] = mode === "on";
					return next;
				});
				setNotice(undefined);
			}, []);

			/**
			 * Tick or untick one model for the picker.
			 *
			 * Ticking is recorded against the region's **full** roster, so the saved
			 * list is a complete allow-list rather than a diff. A full selection is
			 * stored as the empty list, which is the "no filter" state.
			 */
			const toggleModel = react.useCallback(
				(regionId, modelId) => {
					setEnabledIds((current) => {
						const roster = models.filter((model) => model.region === regionId).map((model) => model.id);
						const active = enabledSetFor(models.filter((model) => model.region === regionId), current[regionId]);
						if (!active.delete(modelId)) active.add(modelId);
						const list = roster.filter((id) => active.has(id));
						return { ...current, [regionId]: list.length === roster.length ? [] : list };
					});
					setNotice(undefined);
				},
				[models],
			);

			const resetRegion = react.useCallback((regionId) => {
				setEnabledIds((current) => ({ ...current, [regionId]: [] }));
				setNotice(undefined);
			}, []);

			const save = react.useCallback(async () => {
				if (settingsScope === undefined) return;
				setSaving(true);
				try {
					await settingsScope.set("imageOverrides", imageOverrides);
					await settingsScope.set("reasoningOverrides", reasoningOverrides);
					await settingsScope.set("enabledModelIds", enabledIds);
					setSavedImageOverrides(imageOverrides);
					setSavedReasoningOverrides(reasoningOverrides);
					setSavedEnabledIds(enabledIds);
					setNotice(t("row.saved"));
				} catch (error) {
					setNotice(`${t("row.failed")}: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (mounted.current) setSaving(false);
				}
			}, [settingsScope, imageOverrides, reasoningOverrides, enabledIds, t]);

			const discard = react.useCallback(() => {
				setImageOverrides(savedImageOverrides);
				setReasoningOverrides(savedReasoningOverrides);
				setEnabledIds(savedEnabledIds);
				setNotice(undefined);
			}, [savedImageOverrides, savedReasoningOverrides, savedEnabledIds]);

			/** One pool mutation, with the busy flag and a reload afterwards. */
			const mutate = react.useCallback(
				async (flag, action) => {
					setBusy(flag);
					setNotice(undefined);
					try {
						const value = await postJson(ACCOUNTS_PATH, action);
						if (!mounted.current) return value;
						if (Array.isArray(value.accounts)) setAccounts(value.accounts);
						if (value.login) setLogin(value.login);
						else {
							setNotice(value.ok === false ? (value.rows ?? []).map(row => row.message).filter(Boolean).join("；") : accountResultText(value, t));
							void loadUsage(true);
						}
						return value;
					} catch (error) {
						if (mounted.current) setNotice(error instanceof Error ? error.message : String(error));
						return undefined;
					} finally {
						if (mounted.current) setBusy(undefined);
					}
				},
				[loadUsage, t],
			);

			const poolByAccount = react.useMemo(() => {
				const map = new Map();
				for (const region of usage) {
					for (const row of Array.isArray(region.pool) ? region.pool : []) {
						// One account appears once per region; the first region that
						// knows about it wins, so a healthy CN mirror is not masked by a
						// missing global one.
						if (!map.has(row.accountId)) map.set(row.accountId, row);
					}
				}
				return map;
			}, [usage]);

			const regionLabel = (model) => {
				const key = `row.region.${model.region}`;
				const translated = t(key);
				return translated === key ? (model.regionName ?? model.region) : translated;
			};

			const body = open
				? h(
						"div",
						{ className: "dsm-tabbit-body" },
						usageStatus === "loading" && usage.length === 0
							? h("p", { className: "dsm-tabbit-state" }, t("usage.loading"))
							: null,
						...usage.map((entry) => h(RegionUsage, { t, entry, key: `usage:${entry.region}` })),
						h(
							"div",
							{ className: "dsm-tabbit-actions" },
							h(
								"button",
								{
									type: "button",
									className: "dsm-tabbit-button",
									disabled: usageStatus === "loading",
									onClick: () => void loadUsage(true),
								},
								t("usage.refresh"),
							),
						),
						h(PoolPanel, {
							t,
							accounts,
							poolByAccount,
							busy,
							checkinRows,
							regions,
							login,
							onLogin: (name, region) => mutate("login", { action: "login", name, region }),
							onCancelLogin: () => mutate("login-cancel", { action: "login-cancel" }),
							onImportLocal: (region) => mutate("import-local", { action: "import-local", region }),
							onImport: (name, value, region) => mutate("import", { action: "import", name, value, region }),
							onToggle: (id, enabled) => mutate(`toggle:${id}`, { action: "update", id, enabled }),
							onRemove: (id) => mutate(`remove:${id}`, { action: "remove", id }),
							onTest: (id) => mutate(`test:${id}`, { action: "test", id }),
							onSync: () => mutate("sync", { action: "sync" }),
							onCheckin: async () => {
								setBusy("checkin");
								setNotice(undefined);
								try {
									const value = await postJson(CHECKIN_PATH, {});
									if (!mounted.current) return;
									if (Array.isArray(value.accounts)) setAccounts(value.accounts);
									const rows = [];
									for (const region of Array.isArray(value.regions) ? value.regions : []) {
										for (const row of Array.isArray(region.rows) ? region.rows : []) rows.push(row);
									}
									setCheckinRows(rows);
									void loadUsage(true);
								} catch (error) {
									if (mounted.current) setNotice(error instanceof Error ? error.message : String(error));
								} finally {
									if (mounted.current) setBusy(undefined);
								}
							},
						}),
						notice ? h("p", { className: "dsm-tabbit-state", role: "status", "aria-live": "polite" }, notice) : null,
						h("p", { className: "dsm-tabbit-hint" }, t("row.showHint")),
						h("p", { className: "dsm-tabbit-hint" }, t("row.usageHint")),
						status === "loading" ? h("p", { className: "dsm-tabbit-state" }, t("row.loading")) : null,
						status === "error"
							? h("p", { className: "dsm-tabbit-error" }, `${t("row.requestFailed")}: ${notice ?? ""}`)
							: null,
						status === "ready" && models.length === 0
							? h("p", { className: "dsm-tabbit-state" }, t("row.emptyModels"))
							: null,
						...regions.map((region) => {
							const roster = models.filter((model) => model.region === region.id);
							if (roster.length === 0) return null;
							const active = enabledSetFor(roster, enabledIds[region.id]);
							return h(
								"div",
								{ className: "dsm-tabbit-section", key: `models:${region.id}` },
								h(
									"div",
									{ className: "dsm-tabbit-section-head" },
									h("p", { className: "dsm-tabbit-section-title" }, region.name),
									h(
										"span",
										{ className: "dsm-tabbit-state" },
										t("row.enabledCount", { count: active.size, total: roster.length }),
									),
									h(
										"button",
										{
											type: "button",
											className: "dsm-tabbit-button",
											disabled: saving,
											onClick: () => resetRegion(region.id),
										},
										t("row.enableAll"),
									),
								),
								h(
									"ul",
									{ className: "dsm-tabbit-list" },
									...roster.map((model) => {
										const ticked = active.has(model.id);
										const imageMode = typeof imageOverrides[model.id] === "string" ? imageOverrides[model.id] : "auto";
										const reasoningMode =
											typeof reasoningOverrides[model.id] === "boolean"
												? reasoningOverrides[model.id]
													? "on"
													: "off"
												: "auto";
										return h(
											"li",
											{
												className: `dsm-tabbit-row${ticked ? "" : " dsm-tabbit-row-off"}`,
												key: `${model.region}:${model.id}`,
											},
											h(
												"span",
												{ className: "dsm-tabbit-row-main" },
												h("label", { className: "dsm-tabbit-actions", title: t("row.showInPicker") },
													h("input", {
														type: "checkbox",
														checked: ticked,
														disabled: saving,
														"aria-label": `${t("row.showInPicker")}: ${model.name}`,
														onChange: () => toggleModel(model.region, model.id),
													}),
												),
												h("span", { className: "dsm-tabbit-name", title: model.description ?? model.id }, model.name),
												model.usageMultiplier === undefined ? null : h("span", { className: "dsm-tabbit-badge", title: t("row.usageHint") }, `${t("row.usageMultiplier")} ${model.usageMultiplier}×`),
												h(ContextBadge, { t, model }),
												model.accessType === "premium_only"
													? h("span", { className: "dsm-tabbit-badge dsm-tabbit-badge-warn" }, t("access.premium_only"))
													: model.accessType === "free_unlimited"
														? h("span", { className: "dsm-tabbit-badge dsm-tabbit-badge-ok" }, t("access.free_unlimited"))
														: h("span", { className: "dsm-tabbit-badge" }, t("access.free_metered")),
												h(
													"span",
													{ className: "dsm-tabbit-badge" },
													model.supportsVision ? t("row.vision") : t("row.textOnly"),
												),
											),
											h(
												"span",
												{ className: "dsm-tabbit-actions" },
												h(
													"select",
													{
														className: "dsm-tabbit-select",
														value: imageMode,
														disabled: saving,
														"aria-label": `${t("row.imageTitle")}: ${model.name}`,
														onChange: (event) => setImage(model.id, event.target.value),
													},
													h("option", { value: "auto" }, t("row.imageAuto")),
													h("option", { value: "on" }, t("row.imageOn")),
													h("option", { value: "off" }, t("row.imageOff")),
												),
												h(
													"select",
													{
														className: "dsm-tabbit-select",
														value: reasoningMode,
														disabled: saving,
														"aria-label": `${t("row.reasonTitle")}: ${model.name}`,
														onChange: (event) => setReasoning(model.id, event.target.value),
													},
													h("option", { value: "auto" }, t("row.reasonAuto")),
													h("option", { value: "on" }, t("row.reasonOn")),
													h("option", { value: "off" }, t("row.reasonOff")),
												),
											),
										);
									}),
								),
							);
						}),
						h(
							"div",
							{ className: "dsm-tabbit-actions" },
							h(
								"button",
								{
									type: "button",
									className: "dsm-tabbit-button",
									disabled: saving || !dirty || settingsScope === undefined,
									onClick: save,
								},
								saving ? t("row.saving") : t("row.save"),
							),
							h(
								"button",
								{ type: "button", className: "dsm-tabbit-button", disabled: saving || !dirty, onClick: discard },
								t("row.discard"),
							),
							h(
								"button",
								{
									type: "button",
									className: "dsm-tabbit-button",
									disabled: refreshing,
									onClick: () => void load(true),
								},
								refreshing ? t("row.refreshing") : t("row.refresh"),
							),
							dirty
								? h("span", { className: "dsm-tabbit-state" }, t("row.unsaved"))
								: refreshedAt !== undefined
									? h(
											"span",
											{ className: "dsm-tabbit-state" },
											t("row.refreshed", { time: new Date(refreshedAt).toLocaleTimeString() }),
										)
									: notice !== undefined
										? h("span", { className: "dsm-tabbit-state" }, notice)
										: null,
						),
					)
				: null;

			return h(
				"li",
				{ className: `dsm-plugin-card${open ? " dsm-plugin-card-open" : ""}` },
				h(
					"button",
					{
						type: "button",
						className: "dsm-plugin-card-header",
						"aria-expanded": open,
						"aria-label": `${t(open ? "row.collapse" : "row.expand")}: ${t("row.title")}`,
						onClick: () => setOpen(!open),
					},
					h(
						"span",
						{ className: "dsm-plugin-card-head" },
						h("span", { className: "dsm-plugin-card-title" }, t("row.title")),
						h("span", { className: "dsm-plugin-card-description" }, t("row.desc")),
					),
					h(
						"span",
						{
							"aria-hidden": "true",
							className: `dsm-plugin-card-chevron${open ? " dsm-plugin-card-chevron-open" : ""}`,
						},
						open ? "▾" : "▸",
					),
				),
				h("div", { className: "dsm-plugin-card-body", hidden: !open }, body),
			);
		}
		//#endregion

		//#region plugin
		/** Stable browser-plugin name. */
		const name = "dsh-connect-tabbit-client";
		/**
		 * Client services this card reads.
		 *
		 * Deliberately only the two that exist on BOTH host lines. The settings
		 * surface differs by line — 0.1.5 serves `settingsScope`, 0.1.7 replaces it
		 * with `configForms` — and Cordis' dependency gate is hard: any inject entry
		 * the running line does not provide keeps `apply` from ever running, which
		 * the shell reports as "1 entry did not activate" and drops the whole
		 * desktop into recovery mode. Both settings faces are therefore probed with
		 * `ctx.get()`, which returns undefined for an absent service instead of
		 * throwing, so one build serves both lines.
		 */
		const inject = ["slots", "locale"];

		/** Every namespace spelling the browser half follows, in preference order. */
		const SETTINGS_NS_CANDIDATES = [
			"dsh-connect-tabbit",
			"include:dsh-connect-tabbit",
			"tabbit",
		];

		/**
		 * The card slots this build mounts on, and the key each registration uses.
		 *
		 * `plugins.bundle.config` is the card under a plugin's entry in the Plugins
		 * page; `plugins.row.config` is the per-row config beside it. Both are KEYED
		 * slots, and both sides of the key comparison are exact: the page renders
		 * them with `entryKey: pkg.name` and decides whether to render the section at
		 * all from the set of registered keys, compared against the plugin
		 * inventory's own package name. A card registered under a spelling nobody
		 * looks up gets no card and no error, which is worse than a wrong key.
		 *
		 * The row key is `<bundle key>#<row id>`; the two halves are the same string
		 * here because the settings namespace is the package name. Both the bare
		 * package name and the `include:`-wrapped Loader id are registered, because
		 * which one the inventory answers to depends on how the profile mounted the
		 * plugin — registering both is a shadowing-free duplicate, and strictly safer
		 * than betting on one.
		 */
		const CARD_KEYS = ["dsh-connect-tabbit", "include:dsh-connect-tabbit"];
		const CARD_SLOTS = [
			["plugins.bundle.config", (key) => key],
			["plugins.row.config", (key) => `${key}#${key}`],
		];

		/**
		 * Register the Tabbit card under Plugin configuration.
		 *
		 * The whole body is wrapped so that a future DSH slot-API change degrades
		 * to a `console.error` instead of throwing into the loader and raising the
		 * red "Failed to load plugins" banner — the host provider keeps working
		 * either way.
		 */
		function apply(ctx) {
			try {
				installStyles();
				const namespace = "settings.tabbit";
				ctx.effect(
					() => ctx.locale.register(namespace, { zh, en }),
					"dsh-connect-tabbit: settings copy",
				);
				const t = ctx.locale.bind(namespace);

				/** Probe a service without gating `apply` on it. */
				const softGet = (service) => ctx.get(service);
				const legacyScope = softGet("settingsScope");
				const forms = softGet("configForms");
				let settingsScope =
					legacyScope === undefined ? undefined : legacyScope.bind({ namespace: "dsh-connect-tabbit" });

				let liveDisposers = [];
				const disposeLive = () => {
					for (const dispose of liveDisposers) {
						try {
							dispose();
						} catch {}
					}
					liveDisposers = [];
				};

				/** Register one card slot; returns its disposer, or undefined if it failed. */
				const registerCard = (slotName, key) => {
					try {
						return ctx.slots.inject(slotName, () =>
							ctx.slots.register(
								{
									name: slotName,
									key,
									priority: 30,
									// A card with no settings scope renders read-only rather than
									// disappearing: the model list and the account pool stay
									// visible on a line that serves no settings face at all.
									inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
								},
								TabbitPluginCard,
							),
						);
					} catch (error) {
						console.error(
							`[dsh-connect-tabbit] card slot "${slotName}" failed to register (host provider unaffected):`,
							error,
						);
						return undefined;
					}
				};

				const registerAllSlots = () => {
					disposeLive();
					for (const key of CARD_KEYS) {
						for (const [slotName, cardKeyOf] of CARD_SLOTS) {
							const dispose = registerCard(slotName, cardKeyOf(key));
							if (dispose !== undefined) liveDisposers.push(dispose);
						}
					}
				};

				/**
				 * Resolve the namespace the Host actually serves, then rebind the card.
				 *
				 * The namespace must be ASKED for, not assumed: `describe()` keys a
				 * form by its Loader entry id, and that id is chosen by the profile
				 * patch. Rebinding — rather than reading the snapshot once — is also
				 * what makes a mirror that lands after `apply` work, because the
				 * renderer caches each entry's inject result by object identity and
				 * never re-evaluates it.
				 */
				const bindSettingsScope = () => {
					if (forms === undefined || typeof forms.whileServed !== "function") {
						if (settingsScope === undefined && forms !== undefined && typeof forms.get === "function") {
							settingsScope = forms.get("dsh-connect-tabbit");
						}
						registerAllSlots();
						console.log(`[dsh-connect-tabbit] card bound; settings form: ${settingsScope === void 0 ? "none (no configForms)" : "legacy"}`);
						return;
					}
					ctx.effect(
						() =>
							forms.whileServed(SETTINGS_NS_CANDIDATES, (served) => {
								const ns = SETTINGS_NS_CANDIDATES.find((candidate) => served.has(candidate));
								settingsScope = ns === undefined ? undefined : forms.get(ns);
								registerAllSlots();
								// The namespace has to be asked for rather than assumed — the
								// served spelling is a Loader entry id the profile patch chose —
								// so which one matched is the one fact worth logging when a
								// deployment's card comes up read-only.
								console.log(
									`[dsh-connect-tabbit] card bound; settings form: ${ns ?? "none"} `
									+ `(served: ${[...served].join(", ") || "nothing"})`,
								);
								return () => disposeLive();
							}),
						"dsh-connect-tabbit: settings namespace binding",
					);
					registerAllSlots();
				};
				bindSettingsScope();
			} catch (error) {
				console.error("[dsh-connect-tabbit] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
