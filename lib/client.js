/**
 * 浏览器侧：往设置面板的 `settings.section` 槽里挂一个「Claude 订阅」分区。
 *
 * 只有两件事：画界面、通过 connection.rpc 调宿主端点。所有凭据与网络都留在
 * 宿主进程里，浏览器拿到的只有状态摘要与授权链接。
 */
window.__ModuleLoader__.load({
	id: "dsh-claude-subscription",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const reactModule = require("react");
		const React = reactModule && reactModule.createElement ? reactModule : reactModule.default;
		const h = React.createElement;

		const NS = "settings.claudeSubscription";
		const RPC_PREFIX = "claude-subscription";

		const zh = {
			nav: "Claude 订阅",
			title: "Claude 订阅",
			description: "用 Claude Pro / Max 订阅登录，在 DSH 里直接使用 Claude 模型。凭据只存在宿主进程，浏览器只拿状态。",
			signedIn: "已登录",
			signedOut: "未登录",
			activeAccount: "当前账号",
			login: "登录 Claude",
			loginHint: "点开后把下面的链接在浏览器里打开；授权完成后把页面上的 code#state 整串粘贴回来。",
			openLink: "打开授权页",
			copy: "复制链接",
			copied: "已复制",
			codePlaceholder: "粘贴 code#state",
			submit: "提交授权码",
			cancel: "取消",
			logout: "退出登录",
			refresh: "刷新",
			quota: "查询额度",
			quotaTitle: "额度",
			quotaHint: "来自 Claude Code /usage 接口，字段以服务端返回为准。",
			accounts: "账号",
			select: "切换",
			remove: "移除",
			models: "可用模型",
			identity: "客户端指纹",
			busy: "处理中…",
			failed: "操作失败",
			noModels: "登录后这里会列出账号可用的 Claude 模型。",
			savedHint: "登录成功后到输入框的模型选择器里选 Claude 订阅。"
		};
		const en = {
			nav: "Claude subscription",
			title: "Claude subscription",
			description: "Sign in with a Claude Pro / Max subscription and use Claude models in DSH. Credentials stay in the host process; the browser only sees status.",
			signedIn: "Signed in",
			signedOut: "Signed out",
			activeAccount: "Active account",
			login: "Sign in to Claude",
			loginHint: "Open the link below in a browser, then paste the code#state shown on the page back here.",
			openLink: "Open authorization page",
			copy: "Copy link",
			copied: "Copied",
			codePlaceholder: "Paste code#state",
			submit: "Submit code",
			cancel: "Cancel",
			logout: "Sign out",
			refresh: "Refresh",
			quota: "Read quota",
			quotaTitle: "Quota",
			quotaHint: "From the Claude Code /usage endpoint; fields follow the server response.",
			accounts: "Accounts",
			select: "Use",
			remove: "Remove",
			models: "Available models",
			identity: "Client identity",
			busy: "Working…",
			failed: "Request failed",
			noModels: "Models appear here once you sign in.",
			savedHint: "After signing in, pick Claude subscription in the composer's model picker."
		};

		Object.assign(zh, { profileMissing: "账号资料暂未获取", remaining: "剩余", reset: "重置", resetUnknown: "重置时间暂未获取", quotaEmpty: "额度资料暂未获取", daily: "每日额度", weekly: "每周额度", session: "当前会话", spend: "额外用量", disabled: "未启用", used: "已用", limit: "上限", unknown: "暂无数据", planMax: "Max 订阅", planPro: "Pro 订阅", profileWarning: "账号资料这次没能刷新，先显示本地缓存的信息。", quotaUpdated: "更新于", quotaLoading: "正在读取额度…", refreshProfile: "更新账号资料" });
		Object.assign(en, { profileMissing: "Account details not available yet", remaining: "remaining", reset: "Resets", resetUnknown: "Reset time unavailable", quotaEmpty: "Quota details not available yet", daily: "Daily limit", weekly: "Weekly limit", session: "Current session", spend: "Extra usage", disabled: "Disabled", used: "Used", limit: "Limit", unknown: "Unavailable", planMax: "Max plan", planPro: "Pro plan", profileWarning: "Account details could not be refreshed; showing the cached copy.", quotaUpdated: "Updated", quotaLoading: "Reading quota…", refreshProfile: "Refresh account details" });

		Object.assign(zh, { refreshModels: "刷新模型目录", routing: "账号自动切换", routingOff: "关闭（使用默认账号）", routingPriority: "故障时切换", routingQuota: "按额度选择", routingHint: "默认账号保持不变；会话固定实际账号，仅在尚未输出内容时尝试其他账号。", stale: "上次成功的数据，暂未刷新", currentAccount: "本会话实际账号", defaultAccount: "默认账号", badgeError: "额度暂不可用", badgeTitle: "Claude 额度" });
		Object.assign(en, { refreshModels: "Refresh model catalog", routing: "Automatic account switching", routingOff: "Off (default account)", routingPriority: "Fail over on errors", routingQuota: "Select by quota", routingHint: "The default stays unchanged. Sessions keep their serving account; failover stops once content starts.", stale: "Last successful data; refresh pending", currentAccount: "Serving account", defaultAccount: "Default account", badgeError: "Quota unavailable", badgeTitle: "Claude usage" });
		const inject = ["slots", "locale", "connection"];

		/** 调宿主端点，把 {ok,value} 拆成值或异常。 */
		function callRpc(rpc, endpoint, payload, signal) {
			return rpc.call("/api", `${RPC_PREFIX}/${endpoint}`, payload ?? {}, signal).then((response) => {
				if (!response?.ok) throw new Error(response?.error?.message ?? "RPC failed");
				return response.value;
			});
		}

		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "16px", padding: "4px 2px 24px", color: "var(--dsw-alias-label-primary, inherit)", fontFamily: "inherit", fontSize: "13px", lineHeight: 1.55, minWidth: 0 },
			title: { fontSize: "16px", fontWeight: 600, margin: 0 },
			desc: { margin: 0, color: "var(--dsw-alias-label-secondary, inherit)", opacity: 0.85 },
			card: { border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))", borderRadius: "10px", padding: "14px", display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: 0 },
			sectionHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", minWidth: 0 },
			label: { fontWeight: 600, fontSize: "13px" },
			button: { fontFamily: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))", background: "transparent", color: "inherit", borderRadius: "8px", padding: "5px 12px", cursor: "pointer", fontSize: "13px" },
			primary: { fontFamily: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.16))", color: "inherit", borderRadius: "8px", padding: "5px 12px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
			input: { fontFamily: "inherit", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))", background: "transparent", color: "inherit", borderRadius: "8px", padding: "6px 10px", fontSize: "13px", minWidth: 0, width: "100%", flex: "1 1 200px" },
			link: { fontFamily: "inherit", fontSize: "12px", overflowWrap: "anywhere", opacity: 0.85 },
			muted: { color: "var(--dsw-alias-label-secondary, inherit)", opacity: 0.8 },
			error: { color: "var(--dsw-alias-error-primary, #d64545)", overflowWrap: "anywhere" },
			ok: { color: "var(--dsw-alias-brand-primary, #3964fe)" },
			badge: { borderRadius: "999px", padding: "2px 8px", fontSize: "12px", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.12))", flexShrink: 0 },
			list: { margin: 0, paddingLeft: "18px" },
			account: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1 1 160px", overflowWrap: "anywhere" },
			accountTitle: { fontFamily: "inherit", fontSize: "13px", fontWeight: 600, overflowWrap: "anywhere" },
			accountMeta: { fontFamily: "inherit", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary, inherit)", overflowWrap: "anywhere" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "8px", minWidth: 0 },
			limit: { minWidth: 0, borderRadius: "10px", padding: "9px 12px", background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.09))", display: "flex", flexDirection: "column", gap: "6px", overflowWrap: "anywhere" },
			limitTop: { display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" },
			limitLabel: { fontFamily: "inherit", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary, inherit)" },
			percent: { fontFamily: "inherit", fontSize: "18px", lineHeight: "24px", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
			progress: { fontFamily: "inherit", width: "100%", height: "4px", border: 0, borderRadius: "999px", overflow: "hidden", accentColor: "var(--dsw-alias-brand-primary, #3964fe)", background: "var(--dsw-alias-border-l3, rgba(127,127,127,0.22))" },
			meta: { fontFamily: "inherit", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-tertiary, inherit)", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "4px 10px" },
			freshness: { fontFamily: "inherit", fontSize: "11px", lineHeight: "17px", color: "var(--dsw-alias-label-tertiary, inherit)" },
			dl: { display: "flex", flexDirection: "column", gap: "8px", margin: 0, fontFamily: "inherit", fontSize: "13px", minWidth: 0 },
			dlRow: { display: "flex", flexWrap: "wrap", gap: "4px 12px", minWidth: 0 },
			dlKey: { fontFamily: "inherit", flex: "0 1 90px", color: "var(--dsw-alias-label-secondary, inherit)" },
			dlValue: { fontFamily: "inherit", margin: 0, flex: "1 1 180px", overflowWrap: "anywhere", minWidth: 0 }
		};

		const text = (value) => typeof value === "string" ? value.trim() : "";
		const numeric = (value) => typeof value === "number" && Number.isFinite(value);
		const clamp = (value) => Math.max(0, Math.min(100, value));

		/** 计划名是 max/pro 这种内部值，面板上换成可读文案。 */
		function planText(plan, t) {
			const value = text(plan).toLowerCase();
			if (value === "max") return t("planMax");
			if (value === "pro") return t("planPro");
			return "";
		}

		/**
		 * 账号展示：显示名 → 邮箱 → 备注名，内部 id 和「Claude 1」这类占位名一律不出现。
		 * @param {object} props account/t。
		 */
		function AccountIdentity({ account, t }) {
			const email = text(account?.email);
			const friendly = (value) => value && value !== account?.id && !/^claude(?:[\s_-]*\d+|-[a-z0-9-]+)$/i.test(value) ? value : "";
			const name = friendly(text(account?.displayName)) || friendly(text(account?.label));
			const title = name || email || t("profileMissing");
			const organization = text(account?.organizationName);
			// Claude 的组织名默认就是「<邮箱>'s Organization」，和邮箱重复时不再占一行。
			const showOrganization = organization && !(email && organization.includes(email));
			const details = [planText(account?.plan, t), showOrganization ? organization : ""].filter(Boolean).join(" · ");
			return h("div", { style: styles.account },
				h("span", { style: styles.accountTitle }, title),
				email && email !== title ? h("span", { style: styles.accountMeta }, email) : null,
				details ? h("span", { style: styles.accountMeta }, details) : null);
		}

		function windowLabel(window, t) {
			return ({ daily: t("daily"), day: t("daily"), weekly: t("weekly"), week: t("weekly"), seven_day: t("weekly"), five_hour: t("session"), session: t("session") })[window] || text(window) || t("quotaTitle");
		}

		function ResetTime({ resetsAt, t, now = Date.now(), locale }) {
			const date = new Date(resetsAt);
			if (!resetsAt || !Number.isFinite(date.getTime())) return h("span", null, t("resetUnknown"));
			const seconds = (date.getTime() - now) / 1000;
			const unit = Math.abs(seconds) >= 86400 ? "day" : Math.abs(seconds) >= 3600 ? "hour" : "minute";
			const amount = Math.round(seconds / ({ day: 86400, hour: 3600, minute: 60 })[unit]);
			const language = locale || (t("remaining") === "剩余" ? "zh-CN" : "en");
			const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(amount, unit);
			return h("time", { dateTime: date.toISOString(), title: date.toLocaleString(language) }, `${t("reset")}: ${date.toLocaleString(language)} (${relative})`);
		}

		/** Pure presentation: no RPC, account identifiers, or raw response serialization. */
		function QuotaCards({ quota, t, now, locale }) {
			const windows = Array.isArray(quota?.windows) ? quota.windows.filter((entry) => numeric(entry?.remainingPercent) && numeric(entry?.utilization)) : [];
			const spend = quota?.spend && typeof quota.spend === "object" ? quota.spend : undefined;
			const amount = (value) => {
				if (!numeric(value)) return t("unknown");
				const currency = text(spend?.currency);
				if (/^[a-z]{3}$/i.test(currency)) {
					try { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value); } catch { /* preserve unknown units below */ }
				}
				return `${value.toLocaleString(locale)}${currency ? ` ${currency}` : ""}`;
			};
			return h("div", { style: { minWidth: 0 }, "aria-live": "polite" },
				h("style", null, ".claudeSubscriptionProgress{-webkit-appearance:none;appearance:none}.claudeSubscriptionProgress::-webkit-progress-bar{background:var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:999px}.claudeSubscriptionProgress::-webkit-progress-value{background:var(--dsw-alias-brand-primary,#3964fe);border-radius:999px}.claudeSubscriptionProgress::-moz-progress-bar{background:var(--dsw-alias-brand-primary,#3964fe);border-radius:999px}"),
				h("div", { style: styles.grid }, windows.map((entry, index) => {
					const remaining = clamp(entry.remainingPercent);
					const label = `${entry.scope ? entry.scope + " · " : ""}${windowLabel(entry.window, t)}`;
					return h("div", { key: `${entry.window}-${index}`, style: styles.limit },
						h("div", { style: styles.limitTop }, h("span", { style: styles.limitLabel }, label), h("strong", { style: styles.percent }, `${Math.round(remaining)}%`)),
						h("progress", { className: "claudeSubscriptionProgress", style: styles.progress, max: 100, value: remaining, "aria-label": `${label} ${t("remaining")} ${Math.round(remaining)}%` }),
						h("div", { style: styles.meta }, h("span", null, `${t("remaining")} ${Math.round(remaining)}%`), h(ResetTime, { resetsAt: entry.resetsAt, t, now, locale })));
				}), spend ? h("div", { style: styles.limit },
					h("div", { style: styles.limitTop }, h("span", { style: styles.limitLabel }, t("spend")), spend.enabled === false ? h("span", { style: styles.limitLabel }, t("disabled")) : null),
					spend.enabled === true ? h("div", { style: styles.meta }, h("span", null, `${t("used")}: ${amount(spend.used)}`), h("span", null, `${t("limit")}: ${amount(spend.limit)}`)) : null,
					spend.enabled === true && numeric(spend.utilization) ? h("progress", { className: "claudeSubscriptionProgress", style: styles.progress, max: 100, value: clamp(spend.utilization), "aria-label": `${t("spend")} ${t("used")}` }) : null) : null),
				windows.length === 0 && !spend ? h("p", { style: styles.muted }, typeof quota?.message === "string" && quota.message.trim() ? quota.message : t("quotaEmpty")) : null);
		}

		/**
		 * 设置分区组件。
		 * @param {object} props 槽位注入的属性：rpc、t。
		 * @returns {object} React 元素。
		 */
		function ClaudePanel(props) {
			const { rpc, t } = props;
			const [status, setStatus] = React.useState(undefined);
			const [busy, setBusy] = React.useState("");
			const [error, setError] = React.useState("");
			const [authUrl, setAuthUrl] = React.useState("");
			const [code, setCode] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [quota, setQuota] = React.useState(undefined);
			const requests = React.useRef({ generation: 0, status: 0, quota: 0, operation: 0, activeId: undefined, mounted: true });
			const clearQuota = React.useCallback(() => {
				requests.current.generation++;
				requests.current.status++;
				requests.current.quota++;
				setQuota(undefined);
			}, []);

			const run = React.useCallback(
				async (key, action) => {
					const operation = ++requests.current.operation;
					setBusy(key);
					setError("");
					try {
						await action();
					} catch (failure) {
						if (requests.current.mounted && operation === requests.current.operation) setError(String(failure?.message ?? failure));
					} finally {
						if (requests.current.mounted && operation === requests.current.operation) setBusy("");
					}
				},
				[]
			);

			const refresh = React.useCallback(
				(options = {}) =>
					run("status", async () => {
						const generation = requests.current.generation;
						const sequence = ++requests.current.status;
						const next = await callRpc(rpc, "status", options.forceProfile ? { refreshProfile: true } : {});
						if (!requests.current.mounted || generation !== requests.current.generation || sequence !== requests.current.status) return;
						const activeId = next?.signedIn ? next.activeId : undefined;
						if (activeId !== requests.current.activeId) clearQuota();
						requests.current.activeId = activeId;
						setStatus(next);
					}),
				[run, rpc, clearQuota]
			);

			React.useEffect(() => {
				requests.current.mounted = true;
				refresh();
				return () => {
					requests.current.mounted = false;
					requests.current.generation++;
				};
			}, [refresh]);

			const signedIn = status?.signedIn === true;
			const accounts = status?.accounts ?? [];
			const models = status?.models ?? [];
			const localeTag = t("remaining") === "剩余" ? "zh-CN" : "en";
			const fetchedAt = typeof quota?.fetchedAt === "string" && Number.isFinite(Date.parse(quota.fetchedAt)) ? new Date(quota.fetchedAt) : undefined;

			const signIn = () =>
				run("login", async () => {
					const result = await callRpc(rpc, "login", { method: "copy_code" });
					setAuthUrl(result?.authUrl ?? "");
					setNotice("");
					if (!result?.authUrl) throw new Error(result?.error ?? "没有拿到授权链接");
				});

			const submit = () =>
				run("submit", async () => {
					clearQuota();
					await callRpc(rpc, "login/submit", { code });
					setCode("");
					setAuthUrl("");
					setNotice(t("savedHint"));
					await refresh();
				});

			const cancel = () =>
				run("cancel", async () => {
					await callRpc(rpc, "login/cancel");
					setAuthUrl("");
					setCode("");
					await refresh();
				});

			const signOut = () =>
				run("logout", async () => {
					clearQuota();
					await callRpc(rpc, "logout");
					await refresh();
				});

			const readQuota = (force = true) =>
				run("quota", async () => {
					const accountId = requests.current.activeId;
					if (!accountId) return;
					const generation = requests.current.generation;
					const sequence = ++requests.current.quota;
					const result = await callRpc(rpc, "quota", { force });
					if (!requests.current.mounted || generation !== requests.current.generation || sequence !== requests.current.quota || accountId !== requests.current.activeId || result?.accountId !== accountId) return;
					setQuota(result);
				});

			/* 面板打开就自动读一次额度（每个账号一次），不必先点按钮。 */
			const activeAccountId = signedIn ? status?.activeId : undefined;
			React.useEffect(() => {
				if (!activeAccountId || requests.current.quotaFor === activeAccountId) return;
				requests.current.quotaFor = activeAccountId;
				readQuota(false);
			}, [activeAccountId]);

			const selectAccount = (id) =>
				run(`select:${id}`, async () => {
					clearQuota();
					await callRpc(rpc, "accounts/select", { id });
					await refresh();
				});

			const removeAccount = (id) =>
				run(`remove:${id}`, async () => {
					if (id === requests.current.activeId) clearQuota();
					await callRpc(rpc, "accounts/remove", { id });
					await refresh();
				});

			const copyLink = async () => {
				try {
					await navigator.clipboard?.writeText(authUrl);
					setNotice(t("copied"));
				} catch {
					setNotice("");
				}
			};
			const refreshModels = () => run("models", async () => {
				const activeId = requests.current.activeId;
				const result = await callRpc(rpc, "models/refresh");
				if (!requests.current.mounted || activeId !== requests.current.activeId || result.accountId !== activeId) return;
				setStatus(current => ({ ...current, models: result.models }));
				setNotice(result.warning ?? (result.stale ? t("stale") : `${t("quotaUpdated")} ${new Date(result.fetchedAt).toLocaleString(localeTag)}`));
			});
			const setRouting = event => run("routing", async () => {
				const result = await callRpc(rpc, "routing/set", { mode: event.target.value });
				if (requests.current.mounted) setStatus(current => ({ ...current, routingMode: result.mode }));
			});

			return h(
				"div",
				{ style: styles.wrap },
				h("h2", { style: styles.title }, t("title")),
				h("p", { style: styles.desc }, t("description")),

				h(
					"div",
					{ style: styles.card },
					h(
						"div",
						{ style: styles.row },
						h("span", { style: { ...styles.badge, ...(signedIn ? styles.ok : styles.muted) } }, signedIn ? t("signedIn") : t("signedOut")),
						signedIn ? h(AccountIdentity, { account: accounts.find((entry) => entry.id === status.activeId), t }) : null,
						h("span", { style: { flex: 1 } }),
						h("button", { style: styles.button, onClick: refresh, disabled: busy !== "" }, t("refresh")),
						signedIn ? h("button", { style: styles.button, onClick: signOut, disabled: busy !== "" }, t("logout")) : null
					),
					error ? h("div", { style: styles.error }, `${t("failed")}: ${error}`) : null,
					busy ? h("div", { style: styles.muted }, busy === "quota" ? t("quotaLoading") : t("busy")) : null,
					status?.profileWarning ? h("div", { style: styles.muted }, t("profileWarning")) : null,
					status?.refreshState?.warning ? h("div", { style: styles.error, role: "status" }, status.refreshState.warning) : null,
					notice ? h("div", { style: styles.ok }, notice) : null
				),

				!signedIn || authUrl
					? h(
							"div",
							{ style: styles.card },
							h("div", { style: styles.row }, h("span", { style: styles.label }, t("login"))),
							h("p", { style: styles.muted }, t("loginHint")),
							authUrl ? h("div", { style: styles.link }, authUrl) : null,
							authUrl
								? h(
										"div",
										{ style: styles.row },
										h("a", { href: authUrl, target: "_blank", rel: "noreferrer", style: styles.button }, t("openLink")),
										h("button", { style: styles.button, onClick: copyLink }, t("copy")),
										h("button", { style: styles.button, onClick: cancel, disabled: busy !== "" }, t("cancel"))
									)
								: h("button", { style: styles.primary, onClick: signIn, disabled: busy !== "" }, t("login")),
							authUrl
								? h(
										"div",
										{ style: styles.row },
										h("input", { style: styles.input, value: code, placeholder: t("codePlaceholder"), onChange: (event) => setCode(event.target.value) }),
										h("button", { style: styles.primary, onClick: submit, disabled: busy !== "" || code.trim() === "" }, t("submit"))
									)
								: null
						)
					: null,

				accounts.length > 0
					? h(
							"div",
							{ style: styles.card },
							h("div", { style: styles.label }, t("accounts")),
							h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 } },
								accounts.map((account) =>
									h(
										"div",
										{ key: account.id, style: styles.row },
										h(AccountIdentity, { account, t }),
										account.id === status?.activeId ? h("span", { style: { ...styles.badge, ...styles.ok } }, t("activeAccount")) : null,
										account.id === status?.activeId
											? null
											: h(
													"button",
													{ style: { ...styles.button, marginLeft: "8px" }, onClick: () => selectAccount(account.id), disabled: busy !== "" },
													t("select")
												),
										h("button", { style: { ...styles.button, marginLeft: "6px" }, onClick: () => removeAccount(account.id), disabled: busy !== "" }, t("remove"))
									)
								)
							)
						)
					: null,

				h(
					"div",
					{ style: styles.card },
					h(
						"div",
						{ style: styles.sectionHead },
						h(
							"div",
							{ style: styles.row },
							h("span", { style: styles.label }, t("quotaTitle")),
							fetchedAt ? h("time", { style: styles.freshness, dateTime: fetchedAt.toISOString() }, `${t("quotaUpdated")} ${fetchedAt.toLocaleString(localeTag)}`) : null
						),
						h("button", { style: styles.button, onClick: () => readQuota(true), disabled: busy !== "" || !signedIn }, t("quota"))
					),
					h("p", { style: styles.muted }, t("quotaHint")),
					quota?.stale ? h("p", { style: styles.muted, role: "status" }, t("stale")) : null,
					h(QuotaCards, { quota: quota?.accountId === status?.activeId ? quota : undefined, t, locale: localeTag })
				),

				h(
					"div",
					{ style: styles.card },
					h("div", { style: styles.label }, t("models")),
					h("button", { style: styles.button, onClick: refreshModels, disabled: busy !== "" || !signedIn }, t("refreshModels")),
					models.length === 0
						? h("p", { style: styles.muted }, t("noModels"))
						: h(
								"ul",
								{ style: styles.list },
								models.map((model) => h("li", { key: model.id }, h("span", null, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)))
							)
				),

				h("div", { style: styles.card },
					h("label", null, t("routing"), h("select", { value: status?.routingMode ?? "off", onChange: setRouting, disabled: busy !== "", style: styles.input, "aria-label": t("routing") },
						[["off", "routingOff"], ["priority", "routingPriority"], ["quota-aware", "routingQuota"]].map(([value, label]) => h("option", { key: value, value }, t(label))))),
					h("p", { style: styles.muted }, t("routingHint"))),
				status?.identity
					? h(
							"div",
							{ style: styles.card },
							h("div", { style: styles.label }, t("identity")),
							h("dl", { style: styles.dl }, [["user-agent", status.identity.userAgent], ["x-app", status.identity.appHeader], ["system[0]", status.identity.identityPrefix]].map(([key, value]) =>
								h("div", { key, style: styles.dlRow }, h("dt", { style: styles.dlKey }, key), h("dd", { style: styles.dlValue }, typeof value === "string" ? value : "—"))))
						)
					: null
			);
		}

		/** 面板出错时显示一行原因，而不是整块空白。 */
		const SectionBoundary = React.Component
			? class SectionBoundary extends React.Component {
					constructor(props) {
						super(props);
						this.state = { error: "" };
					}
					static getDerivedStateFromError(error) {
						return { error: String(error?.message ?? error) };
					}
					render() {
						if (this.state.error !== "") return h("div", { style: styles.error }, `Claude 订阅面板渲染失败：${this.state.error}`);
						return this.props.children;
					}
				}
			: (props) => props.children;

		/** 设置槽位组件：套一层错误边界再交给面板。 */
		function ClaudeSection(props) {
			return h(SectionBoundary, null, h(ClaudePanel, props));
		}

		/** Poll only while this mounted conversation uses the subscription route. */
		function UsageBadge({ rpc, t, sessionId, currentModel }) {
			const [state, setState] = React.useState(undefined);
			const [expanded, setExpanded] = React.useState(false);
			React.useEffect(() => {
				let live = true;
				let running = false;
				const update = async () => {
					if (running) return;
					running = true;
					try {
						const model = await currentModel();
						if (model?.provider !== "anthropic") { if (live) setState(undefined); return; }
						const quota = await callRpc(rpc, "quota", { sessionId, model: model.model });
						const latest = await currentModel();
						if (live && latest?.provider === model.provider && latest?.model === model.model) setState({ quota });
					} catch { if (live) setState({ error: true }); }
					finally { running = false; }
				};
				void update();
				const timer = setInterval(update, 15_000);
				return () => { live = false; clearInterval(timer); };
			}, [rpc, sessionId, currentModel]);
			if (!state) return null;
			const quota = state.quota;
			const window = quota?.windows?.find(entry => entry.window === "five_hour") ?? quota?.windows?.[0];
			return h("div", { style: { position: "relative", fontFamily: "inherit", fontSize: "12px", minWidth: 0 } },
				h("button", { type: "button", style: styles.button, onClick: () => setExpanded(value => !value), "aria-expanded": expanded },
					state.error ? t("badgeError") : `${t("badgeTitle")} · ${window ? `${t("remaining")} ${Math.round(window.remainingPercent)}%` : t("unknown")}${quota?.stale ? " *" : ""}`),
				expanded ? h("div", { role: "region", "aria-label": t("badgeTitle"), style: { ...styles.card, position: "absolute", bottom: "100%", left: 0, width: "min(380px,80vw)", background: "var(--dsw-alias-bg-base,#fff)", zIndex: 20 } },
					h("strong", null, `${t(quota?.defaultAccount ? "defaultAccount" : "currentAccount")}: ${quota?.accountName ?? t("unknown")}`),
					quota?.fetchedAt ? h("time", { dateTime: quota.fetchedAt }, `${t("quotaUpdated")} ${new Date(quota.fetchedAt).toLocaleString()}`) : null,
					quota?.stale ? h("span", null, t("stale")) : null,
					h(QuotaCards, { quota, t })) : null);
		}

		/**
		 * 挂载设置分区。
		 * @param {object} ctx 浏览器插件上下文。
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "claude-subscription: dictionaries");
			const rpc = ctx.get("connection").rpc;
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock", id: "claude-subscription-usage", order: 15, locale: NS,
				inject: sessionId => ({ rpc, t, sessionId, currentModel: async () => {
					let directories;
					try { directories = ctx.get("modelDirectories"); } catch { return undefined; }
					return (await directories?.directoryFor?.(sessionId)?.load())?.current;
				} })
			}, UsageBadge));
			ctx.slots.inject(
				"settings.section",
				() =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "claude-subscription",
							order: 16,
							label: () => t("nav"),
							locale: NS,
							inject: () => ({ rpc, t })
						},
						ClaudeSection
					)
			);
		}

		exports.AccountIdentity = AccountIdentity;
		exports.QuotaCards = QuotaCards;
		exports.UsageBadge = UsageBadge;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
