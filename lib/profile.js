import { buildIdentityHeaders, DEFAULT_IDENTITY } from "./fingerprint.js";
import { abortable, operationError } from "./operation.js";

export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const WARNING = "Claude 账号资料暂未更新，请稍后重试。";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function text(value, limit) {
	if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= limit ? trimmed : undefined;
}
function timestamp(options) {
	const value = options.checkedAt ?? (typeof options.now === "function" ? options.now() : Date.now());
	return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

/** Public metadata only. No inferred names, provider payloads, or credentials survive. */
export function normalizeAccountProfile(payload, options = {}) {
	if (!object(payload)) return undefined;
	const account = object(payload.account) ? payload.account : {};
	const organization = object(payload.organization) ? payload.organization : {};
	const fields = {
		accountUuid: text(account.uuid, 256),
		displayName: text(account.display_name, 512) ?? text(account.full_name, 512),
		email: text(account.email, 320) ?? text(account.email_address, 320),
		plan: account.has_claude_max === true ? "max" : account.has_claude_pro === true ? "pro" : undefined,
		organizationUuid: text(organization.uuid, 256),
		organizationName: text(organization.name, 512),
		subscriptionStatus: text(organization.subscription_status, 128)
	};
	const metadata = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
	if (Object.keys(metadata).length === 0) return undefined;
	const source = options.source === "token" || options.source === "oauth-profile" ? options.source
		: Object.hasOwn(account, "email_address") && !Object.hasOwn(account, "email") ? "token" : "oauth-profile";
	return { ...metadata, checkedAt: timestamp(options), source };
}

/** Official OAuth endpoint; cancellation also covers fetch/json implementations ignoring signal. */
export async function readAccountProfile(credential, identity = DEFAULT_IDENTITY, fetchImpl = globalThis.fetch, options = {}) {
	options.signal?.throwIfAborted();
	if (typeof credential?.access !== "string" || !/^sk-ant-oat\d+-[A-Za-z0-9_-]+$/.test(credential.access)) {
		throw operationError("还没有可用的 Claude 订阅授权", "MISSING_CREDENTIAL");
	}
	const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
	let publicFailure;
	const fail = (message, code) => { publicFailure = operationError(message, code); return publicFailure; };
	try {
		return await abortable((async () => {
			const response = await fetchImpl(PROFILE_URL, {
				method: "GET", redirect: "error", signal,
				headers: buildIdentityHeaders({ accept: "application/json", authorization: `Bearer ${credential.access}` }, identity)
			});
			signal.throwIfAborted();
			if (!response.ok) {
				try { Promise.resolve(response.body?.cancel()).catch(() => undefined); } catch { /* best effort */ }
				throw fail(`账号资料接口返回 HTTP ${Number.isInteger(response.status) ? response.status : "错误"}`, "PROFILE_HTTP");
			}
			let payload;
			try { payload = await response.json(); }
			catch { throw fail("账号资料接口返回的不是有效 JSON", "PROFILE_JSON"); }
			signal.throwIfAborted();
			const profile = normalizeAccountProfile(payload, { ...options, source: "oauth-profile" });
			if (!profile) throw fail("账号资料接口返回了无效的数据结构", "PROFILE_SHAPE");
			return profile;
		})(), signal);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (publicFailure && error === publicFailure) throw error;
		throw operationError("账号资料接口请求失败，请检查网络后重试", "PROFILE_NETWORK");
	}
}

/**
 * vault: list(options), activeRecord(options), updateProfile(id, profile, {expectedAccess, signal}).
 * resolveAuth(options) returns {auth:{apiKey}} after any refresh. No auth/inference identity is changed here.
 * forceRefresh bypasses successful metadata cache, not the failure cooldown.
 */
export function createAccountProfileService({ vault, resolveAuth, identity, fetchImpl = globalThis.fetch,
	now = Date.now, cacheTtlMs = 30 * 60_000, failureCooldownMs = 60_000 }) {
	const flights = new Map();
	const failures = new Map();
	const fresh = (profile) => profile?.source === "oauth-profile" && Number.isFinite(profile.checkedAt)
		&& now() >= profile.checkedAt && now() - profile.checkedAt < cacheTtlMs;

	function start(record, options) {
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
		const entry = { access: record.credential.access, controller, users: 0, settled: false };
		entry.promise = (async () => {
			let expectedAccess = entry.access;
			try {
				const resolved = await abortable(resolveAuth({ signal }), signal);
				const current = await abortable(vault.activeRecord({ signal }), signal);
				if (current?.id !== record.id || current.credential?.access !== resolved?.auth?.apiKey) return;
				expectedAccess = current.credential.access;
				entry.access = expectedAccess;
				const profile = await readAccountProfile(current.credential, typeof identity === "function" ? identity() : identity,
					fetchImpl, { signal, timeoutMs: options.timeoutMs, now });
				signal.throwIfAborted();
				await abortable(vault.updateProfile(record.id, profile, { expectedAccess, signal }), signal);
				failures.delete(record.id);
			} catch {
				// All subscribers leaving is not a provider failure and must not poison a later call.
				if (!controller.signal.aborted) failures.set(record.id, { access: expectedAccess, at: now() });
			} finally {
				entry.settled = true;
				if (flights.get(record.id) === entry) flights.delete(record.id);
			}
		})();
		flights.set(record.id, entry);
		return entry;
	}

	return { async ensure(options = {}) {
		options.signal?.throwIfAborted();
		const record = await abortable(vault.activeRecord(options), options.signal);
		if (record?.credential?.access && (options.forceRefresh || !fresh(record.profile))) {
			const failure = failures.get(record.id);
			const cooling = failure?.access === record.credential.access && now() >= failure.at && now() - failure.at < failureCooldownMs;
			if (!cooling) {
				let entry = flights.get(record.id);
				if (!entry || entry.access !== record.credential.access || entry.controller.signal.aborted) entry = start(record, options);
				entry.users++;
				try { await abortable(entry.promise, options.signal); }
				finally {
					entry.users--;
					if (entry.users === 0 && !entry.settled) entry.controller.abort();
				}
			}
		}
		options.signal?.throwIfAborted();
		const current = await abortable(vault.activeRecord(options), options.signal);
		const result = await abortable(vault.list(options), options.signal);
		const failure = current && failures.get(current.id);
		return failure && result.activeId === current.id && failure.access === current.credential?.access
			? { ...result, profileWarning: WARNING } : result;
	} };
}
