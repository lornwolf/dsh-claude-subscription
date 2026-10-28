import { createHash } from "node:crypto";
import { operationError } from "./operation.js";

/** Called inside the vault transaction; status contains only public warning metadata. */
export function createRefreshService({ vault, oauth, now = Date.now, skewMs = 5 * 60_000 }) {
	const states = new Map();
	const fingerprint = credential => createHash("sha256").update(JSON.stringify([credential.access, credential.refresh, credential.expires])).digest("hex");
	return {
		invalidate(id) { if (id === undefined) states.clear(); else states.delete(id); },
		async status(id, options) {
			const record = await vault.record(id, options);
			const state = record && states.get(record.id);
			return record && state && state.fingerprint === fingerprint(record.credential) ? { warning: state.message, retryAt: Number.isFinite(state.retryAt) ? state.retryAt : undefined, loginRequired: state.permanent } : {};
		},
		async resolve(id, options = {}) {
			return vault.modifyAccount(id, async credential => {
				options.signal?.throwIfAborted();
				if (credential.expires - now() > skewMs) { states.delete(id); return credential; }
				const hash = fingerprint(credential);
				let state = states.get(id);
				if (state?.fingerprint !== hash) { states.delete(id); state = undefined; }
				if (!state || now() >= state.retryAt) {
					try {
						const next = await oauth.refresh(credential, options.signal);
						states.delete(id);
						return next;
					} catch (error) {
						options.signal?.throwIfAborted();
						const permanent = [400, 401, 403].includes(error.status) || error.code === "OAUTH_RESPONSE";
						state = { fingerprint: hash, permanent, retryAt: permanent ? Infinity : now() + (error.retryAfterMs ?? 60_000),
							message: permanent ? "授权续期已暂停，请重新登录 Claude 账号。" : "授权暂时无法续期，稍后自动重试。" };
						states.set(id, state);
					}
				}
				if (credential.expires > now()) return credential;
				throw operationError(state.message, state.permanent ? "AUTH_REQUIRED" : "AUTH_RETRY");
			}, options);
		}
	};
}
