import { createHash } from "node:crypto";
import { retryAfterMs } from "./cache.js";
import { operationError } from "./operation.js";

const replayKind = "claude-subscription-account";
const replayKey = (id, model) => createHash("sha256").update(JSON.stringify([id, model])).digest("hex");

export function bindAccountHistory(messages, id, model, allowLegacy) {
	const key = replayKey(id, model);
	return messages.map(message => {
		if (message.role !== "assistant" || message.source?.replayState === undefined) return message;
		const response = message.source.replayState?.response;
		if (response?.kind === replayKind && response.version === 1 && response.key === key) {
			return { ...message, source: { ...message.source, replayState: { ...message.source.replayState, response: response.state } } };
		}
		if (allowLegacy && response?.kind !== replayKind) return message;
		const { replayState, ...source } = message.source;
		return { ...message, source };
	});
}

/** A request pins its own account adapter; the manually selected default never changes. */
export function createAccountRouter({ adapter, vault, adapterFor, usage, mode = "off", now = Date.now, makeError = operationError }) {
	const sessions = new Map(), cooling = new Map();
	let strategy = mode;
	const sessionKey = (sessionId, model) => `${sessionId}/${model}`;
	const remember = (options, id) => {
		if (!options.sessionId) return;
		const key = sessionKey(options.sessionId, options.model);
		sessions.delete(key);
		if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
		sessions.set(key, { accountId: id, model: options.model, usedAt: now() });
	};
	const failover = code => ["AUTH", "AUTH_FAILED", "AUTH_REQUIRED", "AUTH_RETRY", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL", "UNKNOWN_MODEL", "RATE_LIMIT", "QUOTA", "ACCOUNT_QUOTA", "QUOTA_EXCEEDED", "SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED", "EMPTY_RESPONSE"].includes(code);
	const router = {
		mode: () => strategy,
		setMode(value) { if (!["off", "priority", "quota-aware"].includes(value)) throw operationError("无效的账号切换策略", "ROUTING_MODE"); strategy = value; sessions.clear(); },
		clear(id) {
			for (const [key, value] of sessions) if (id === undefined || value.accountId === id) sessions.delete(key);
			for (const key of cooling.keys()) if (id === undefined || key.startsWith(`${id}/`)) cooling.delete(key);
		},
		current(sessionId, model) { return sessions.get(sessionKey(sessionId, model)); },
		observe(id, model, response) {
			if (![401, 403, 429].includes(response.status) && response.status < 500) return;
			const reset = Number(response.headers.get("anthropic-ratelimit-unified-reset")) * 1000;
			const ms = retryAfterMs(response.headers, now()) ?? (response.status === 429 && reset > now() ? reset - now() : response.status === 401 || response.status === 403 ? 86400_000 : 60_000);
			cooling.set(`${id}/${response.status === 401 || response.status === 403 ? "*" : model}`, now() + ms);
		},
		async *stream(options) {
			options.signal?.throwIfAborted();
			const listing = await vault.list({ signal: options.signal });
			let ids = listing.accounts.map(account => account.id);
			const defaultId = listing.activeId;
			ids.sort((a, b) => (a === defaultId ? -1 : b === defaultId ? 1 : 0));
			if (strategy === "off") ids = ids.filter(id => id === defaultId);
			else {
				ids = ids.filter(id => Math.max(cooling.get(`${id}/*`) ?? 0, cooling.get(`${id}/${options.model}`) ?? 0) <= now());
				if (strategy === "quota-aware") {
					const scores = new Map();
					await Promise.all(ids.map(async id => {
						try {
							const snapshot = await usage.read({ accountId: id, signal: options.signal });
							const windows = snapshot.windows.filter(window => (!window.scope || options.model.toLowerCase().includes(window.scope.toLowerCase()))
								&& (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now()));
							const full = !snapshot.stale && windows.some(window => window.utilization >= 95);
							const urgency = snapshot.stale ? 0 : Math.min(...windows.map(window => window.remainingPercent / Math.max(60_000, Date.parse(window.resetsAt) - now() || 86400_000)), 1);
							scores.set(id, full ? -1 : urgency);
						} catch { scores.set(id, 0); }
					}));
					options.signal?.throwIfAborted();
					ids = ids.filter(id => scores.get(id) >= 0).sort((a, b) => scores.get(b) - scores.get(a));
				}
				const sticky = router.current(options.sessionId, options.model)?.accountId;
				if (ids.includes(sticky)) ids = [sticky, ...ids.filter(id => id !== sticky)];
			}
			if (!ids.length) throw makeError("没有可用的 Claude 账号，请登录或等待额度恢复。", "MISSING_CREDENTIAL");
			let last;
			for (const id of ids) {
				let emitted = false;
				const leading = [];
				try {
					const target = await adapterFor(id, { signal: options.signal });
					const messages = bindAccountHistory(options.messages, id, options.model, strategy === "off" && id === defaultId);
					for await (const chunk of target.stream({ ...options, messages })) {
						options.signal?.throwIfAborted();
						// The host adapter reports provider failures in terminal chunks, not only throws.
						if (!emitted && chunk.type === "finish" && chunk.reason?.kind === "error") {
							const code = chunk.reason.failure?.code ?? "PI_AI_ERROR";
							throw makeError(code === "INVALID_REQUEST" ? "Claude 拒绝了请求参数，请检查模型及思考设置，或更新插件。" : "Claude 账号请求失败，请重试或检查授权与额度。", code);
						}
						if (!emitted && chunk.type === "usage") { leading.push(chunk); continue; }
						if (!emitted) { emitted = true; remember(options, id); yield* leading; }
						if (chunk.type === "finish" && chunk.replayState !== undefined) {
							yield { ...chunk, replayState: { ...chunk.replayState, response: { kind: replayKind, version: 1, key: replayKey(id, options.model), state: chunk.replayState.response } } };
						} else yield chunk;
					}
					if (!emitted) throw makeError("Claude 返回了空回复", "EMPTY_RESPONSE");
					return;
				} catch (error) {
					options.signal?.throwIfAborted();
					if (emitted || strategy === "off" || !failover(error.code)) throw error;
					const key = `${id}/${["AUTH", "AUTH_REQUIRED", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL"].includes(error.code) ? "*" : options.model}`;
					cooling.set(key, Math.max(cooling.get(key) ?? 0, now() + 60_000));
					last = error;
				}
			}
			throw last;
		}
	};
	router.adapter = new Proxy(adapter, { get(target, property) {
		if (property === "stream") return router.stream;
		if (property === "prepareCall") return async (provider, model, signal) => ({ model: await target.resolveModel(provider, model, signal), stream: options => router.stream(options) });
		const value = Reflect.get(target, property);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	return router;
}
