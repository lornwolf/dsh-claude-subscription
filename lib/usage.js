import { buildIdentityHeaders, DEFAULT_IDENTITY } from "./fingerprint.js";
import { abortable, operationError } from "./operation.js";
import { AccountCache, retryAfterMs } from "./cache.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Only a resolved/refreshed credential may be passed by callers. No response bodies in errors. */
export async function readSubscriptionUsage(credential, identity = DEFAULT_IDENTITY, fetchImpl = globalThis.fetch, options = {}) {
	if (typeof credential?.access !== "string" || !/^sk-ant-oat\d*-/.test(credential.access)) {
		throw operationError("还没有可用的 Claude 订阅授权", "MISSING_CREDENTIAL");
	}
	options.signal?.throwIfAborted();
	const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
	try {
		return await abortable((async () => {
			const response = await fetchImpl(USAGE_URL, {
				method: "GET",
				headers: buildIdentityHeaders({ accept: "application/json", authorization: `Bearer ${credential.access}` }, identity),
				redirect: "error",
				signal
			});
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				const error = operationError(`额度接口返回 HTTP ${response.status}`, "USAGE_HTTP");
				error.status = response.status;
				error.retryAfterMs = retryAfterMs(response.headers);
				throw error;
			}
			let payload;
			try { payload = await response.json(); }
			catch { throw operationError("额度接口返回的不是有效 JSON", "USAGE_JSON"); }
			if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
				throw operationError("额度接口返回了无效的数据结构", "USAGE_SHAPE");
			}
			return payload;
		})(), signal);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (error?.publicMessage) throw error;
		throw operationError("额度接口请求失败，请检查网络后重试", "USAGE_NETWORK");
	}
}

/** Resolve auth before querying, including SDK-managed token refresh. */
export async function readResolvedSubscriptionUsage(resolveAuth, identity, fetchImpl, options = {}) {
	options.signal?.throwIfAborted();
	const resolved = await abortable(resolveAuth({ signal: options.signal }), options.signal);
	return readSubscriptionUsage({ access: resolved?.auth?.apiKey }, identity, fetchImpl, options);
}

/** Bind each quota response to the account whose resolved token is actually used. */
export async function readAccountSubscriptionUsage(vault, resolveAuth, identity, fetchImpl, options = {}) {
	options.signal?.throwIfAborted();
	const auth = await abortable(resolveAuth({ signal: options.signal }), options.signal);
	const account = await vault.activeRecord(options);
	if (!account || account.credential.access !== auth?.auth?.apiKey) throw operationError("当前账号已变化，请重新查询额度", "ACCOUNT_CHANGED");
	const payload = await readSubscriptionUsage({ access: auth.auth.apiKey }, identity, fetchImpl, options);
	const windows = summarizeUsage(payload), spend = summarizeSpend(payload);
	return {
		accountId: account.id, windows, spend, raw: payload, fetchedAt: new Date().toISOString(),
		message: windows?.length ? windows.map((entry) => `${entry.window}: 已用 ${entry.utilization}%，剩余 ${entry.remainingPercent}%${entry.resetsAt ? `（重置 ${entry.resetsAt}）` : ""}`).join("\n") : "服务端暂未返回可展示的额度窗口。"
	};
}

export function summarizeUsage(payload) {
	if (payload === null || typeof payload !== "object") return undefined;
	const modern = Array.isArray(payload.limits) ? payload.limits.flatMap(entry => {
		if (!entry || typeof entry.percent !== "number" || !Number.isFinite(entry.percent) || entry.percent < 0) return [];
		const window = entry.kind === "session" ? "five_hour" : ["weekly_all", "weekly_scoped"].includes(entry.kind) ? "seven_day" : "other";
		const scope = entry.scope?.model?.display_name;
		return [{ window, utilization: entry.percent, remainingPercent: Math.max(0, Math.min(100, 100 - entry.percent)),
			...(typeof scope === "string" && scope.length <= 256 ? { scope } : {}),
			...(typeof entry.resets_at === "string" && Number.isFinite(Date.parse(entry.resets_at)) ? { resetsAt: entry.resets_at } : {}) }];
	}) : [];
	if (modern.length) return modern;
	const windows = [];
	for (const [key, value] of Object.entries(payload)) {
		if (["spend", "extra_usage", "limits", "pace"].includes(key) || value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const used = value.utilization ?? value.used ?? value.usage;
		if (typeof used !== "number" || !Number.isFinite(used) || used < 0) continue;
		const rawReset = value.resets_at ?? value.resetsAt ?? value.reset_at;
		const resetsAt = typeof rawReset === "string" && Number.isFinite(Date.parse(rawReset)) ? rawReset : undefined;
		windows.push({ window: key, utilization: used, remainingPercent: Math.max(0, Math.min(100, 100 - used)), ...(resetsAt ? { resetsAt } : {}) });
	}
	return windows.length ? windows : undefined;
}

/** Host-wide, account-bound quota cache used by tools, settings and the composer. */
export function createUsageService({ vault, resolveAccount, identity, fetchImpl = (...args) => globalThis.fetch(...args), ...cacheOptions }) {
	const cache = new AccountCache(cacheOptions);
	return {
		invalidate: (id) => cache.invalidate(id),
		async read(options = {}) {
			const account = await vault.record(options.accountId, options);
			if (!account) throw operationError("还没有可用的 Claude 订阅授权", "MISSING_CREDENTIAL");
			const cached = await cache.get(account.id, async signal => {
				const credential = await resolveAccount(account.id, { signal });
				const payload = await readSubscriptionUsage(credential, typeof identity === "function" ? identity() : identity, fetchImpl, { signal });
				return { accountId: account.id, windows: summarizeUsage(payload) ?? [], spend: summarizeSpend(payload), fetchedAt: new Date().toISOString() };
			}, options);
			const current = await vault.record(account.id, options);
			if (!current || (!options.accountId && (await vault.list(options)).activeId !== account.id)) throw operationError("当前账号已变化，请重新查询额度", "ACCOUNT_CHANGED");
			return { ...cached.value, stale: cached.stale, ...(cached.warning ? { warning: cached.warning, retryAt: cached.retryAt } : {}),
				message: cached.value.windows.length ? cached.value.windows.map(entry => `${entry.scope ? entry.scope + " " : ""}${entry.window}: 剩余 ${entry.remainingPercent}%`).join("\n") : "服务端暂未返回可展示的额度窗口。" };
		}
	};
}

function money(value) {
	if (!value || typeof value !== "object" || !Number.isFinite(value.amount_minor) || !Number.isInteger(value.exponent) || value.exponent < 0 || value.exponent > 8 || typeof value.currency !== "string" || !/^[A-Za-z]{3}$/.test(value.currency)) return undefined;
	return { amount: value.amount_minor / 10 ** value.exponent, currency: value.currency.toUpperCase() };
}

/** Money objects are not percentage windows. Never stringify them into '[object Object]'. */
export function summarizeSpend(payload) {
	const input = payload?.spend;
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const used = money(input.used), limit = money(input.limit);
		const sameCurrency = !used || !limit || used.currency === limit.currency;
		return {
			enabled: input.enabled === true,
			...(used ? { used: used.amount, currency: used.currency } : {}),
			...(limit && sameCurrency ? { limit: limit.amount, currency: limit.currency } : {}),
			...(typeof input.percent === "number" && Number.isFinite(input.percent) && input.percent >= 0 ? { utilization: input.percent } : {})
		};
	}
	if (typeof payload?.extra_usage?.is_enabled === "boolean") {
		const extra = payload.extra_usage;
		return { enabled: extra.is_enabled, ...(typeof extra.utilization === "number" && Number.isFinite(extra.utilization) && extra.utilization >= 0 ? { utilization: extra.utilization } : {}) };
	}
	return undefined;
}
