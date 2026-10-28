/** Host-independent Claude account storage. The caller supplies the credential ref. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PROVIDER = "anthropic";
export const OAUTH_EXPIRY_SKEW_MS = 60_000;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function aborted(options) {
	const signal = options?.signal;
	if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function serializer() {
	let tail = Promise.resolve();
	return (operation, options) => {
		const result = tail.then(() => {
			aborted(options);
			return operation();
		});
		tail = result.catch(() => undefined);
		return result;
	};
}

function checkProvider(providerId) {
	if (providerId !== PROVIDER) throw new Error(`Claude credential store does not hold provider ${JSON.stringify(providerId)}`);
}

/** Validate without embedding credentials in diagnostics. Expired credentials remain refreshable. */
function credential(value, previous) {
	if (!object(value) || value.type !== "oauth") throw new Error("Invalid Claude OAuth credential: expected type oauth");
	const next = clone(value);
	if (next.refresh === undefined && previous !== undefined) next.refresh = previous.refresh;
	if (typeof next.access !== "string" || !/^sk-ant-oat\d{2}-[A-Za-z0-9_-]+$/.test(next.access)) {
		throw new Error("Invalid Claude OAuth credential: access token format");
	}
	if (typeof next.refresh !== "string" || !/^sk-ant-ort\d{2}-[A-Za-z0-9_-]+$/.test(next.refresh)) {
		throw new Error("Invalid Claude OAuth credential: refresh token format");
	}
	if (!Number.isSafeInteger(next.expires) || next.expires <= 0) {
		throw new Error("Invalid Claude OAuth credential: expires must be a positive safe integer in milliseconds");
	}
	return next;
}

function validateState(value) {
	if (!object(value) || value.version !== 1) throw new Error("Invalid Claude account vault: unsupported or missing version");
	if (!Array.isArray(value.accounts)) throw new Error("Invalid Claude account vault: accounts must be an array");
	const ids = new Set();
	for (const [index, account] of value.accounts.entries()) {
		if (!object(account) || typeof account.id !== "string" || !account.id.trim() || ids.has(account.id)) {
			throw new Error(`Invalid Claude account vault: invalid or duplicate account id at index ${index}`);
		}
		ids.add(account.id);
		if (typeof account.label !== "string" || !account.label.trim() || typeof account.addedAt !== "string" || !Number.isFinite(Date.parse(account.addedAt))) {
			throw new Error(`Invalid Claude account vault: malformed metadata at index ${index}`);
		}
		try { credential(account.credential); }
		catch (error) { throw new Error(`Invalid Claude account vault: account ${index}: ${error.message}`, { cause: error }); }
	}
	if (value.accounts.length ? !ids.has(value.activeId) : value.activeId !== undefined && value.activeId !== null) {
		throw new Error("Invalid Claude account vault: activeId does not identify an account");
	}
	return clone(value);
}

function skew(value) {
	return value === undefined ? undefined : { ...clone(value), expires: value.expires - OAUTH_EXPIRY_SKEW_MS };
}

/** 自动生成的占位名（Claude 1 / 账号 id）不是给人看的名字，拿到真实资料后要换掉。 */
function placeholderLabel(label, id) {
	const value = typeof label === "string" ? label.trim() : "";
	return value === "" || value === id || /^claude(?:[\s_-]*\d+|-[a-z0-9-]+)$/i.test(value);
}

/** Public profile metadata is always allowlisted; never spread a credential onto the wire. */
function profileOf(account) {
	const input = { ...(account?.credential?.profile ?? {}), ...(account?.profile ?? {}) };
	const result = {};
	for (const key of ["accountUuid", "displayName", "email", "organizationUuid", "organizationName", "subscriptionStatus"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) result[key] = value.trim();
	}
	if (["max", "pro"].includes(input.plan)) result.plan = input.plan;
	if (Number.isFinite(input.checkedAt) && input.checkedAt > 0) result.checkedAt = input.checkedAt;
	if (["oauth-profile", "token"].includes(input.source)) result.source = input.source;
	return result.displayName || result.email ? result : undefined;
}

function publicAccount(account) {
	const profile = profileOf(account);
	const fallback = /^Claude\s+\d+$/i.test(account.label) ? undefined : account.label;
	return {
		id: account.id, label: account.label, addedAt: account.addedAt, expires: account.credential.expires,
		displayName: profile?.displayName ?? profile?.email ?? fallback,
		email: profile?.email, plan: profile?.plan, organizationName: profile?.organizationName,
		profileStatus: profile ? "ready" : "missing"
	};
}

export class AccountVault {
	#credentials;
	#ref;
	#serialize = serializer();

	constructor(credentials, ref, { withLock } = {}) {
		if (!credentials || !["resolve", "set", "unset"].every((key) => typeof credentials[key] === "function")) {
			throw new Error("Claude account vault requires resolve/set/unset credential service");
		}
		if (ref === undefined || ref === null) throw new Error("Claude account vault requires a caller-supplied credential ref");
		this.#credentials = credentials;
		this.#ref = ref;
		if (withLock) {
			const queue = this.#serialize;
			this.#serialize = (operation, options) => queue(() => withLock(operation, options), options);
		}
	}

	async #load() {
		const hit = await this.#credentials.resolve(this.#ref);
		if (hit === undefined || hit === null) return { version: 1, activeId: undefined, accounts: [] };
		if (typeof hit.value !== "string" || hit.value.length === 0) throw new Error("Invalid Claude account vault: stored value must be nonempty JSON");
		let parsed;
		try { parsed = JSON.parse(hit.value); }
		catch { throw new Error("Invalid Claude account vault: malformed JSON"); }
		return validateState(parsed);
	}

	async #save(state, options) {
		validateState(state);
		aborted(options); // Commit point: a completed backend write is not reported as cancelled.
		if (state.accounts.length === 0) await this.#credentials.unset(this.#ref);
		else await this.#credentials.set(this.#ref, JSON.stringify(state));
	}

	list(options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			return { activeId: state.activeId, accounts: state.accounts.map(publicAccount) };
		}, options);
	}

	active(options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			return skew(state.accounts.find((entry) => entry.id === state.activeId)?.credential);
		}, options);
	}

	/** Host-only atomic identity/token snapshot for profile lookup; never returned by status. */
	activeRecord(options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			const account = state.accounts.find((entry) => entry.id === state.activeId);
			return account ? { id: account.id, credential: skew(account.credential), profile: profileOf(account) } : undefined;
		}, options);
	}

	/** Host-only account snapshot; omitted id means the manually selected default. */
	record(id, options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			const account = state.accounts.find(entry => entry.id === (id ?? state.activeId));
			return account ? clone({ id: account.id, credential: account.credential }) : undefined;
		}, options);
	}

	modifyAccount(id, update, options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			const account = state.accounts.find(entry => entry.id === id);
			if (!account) throw new Error("Claude account no longer exists");
			let next, updateError;
			try { next = await update(clone(account.credential)); }
			catch (error) { updateError = error; }
			aborted(options);
			// Non-cooperating writers may replace credentials during the HTTP refresh.
			const latest = await this.#load();
			const current = latest.accounts.find(entry => entry.id === id);
			if (!current) throw new Error("Claude account no longer exists");
			if (!isDeepStrictEqual(current.credential, account.credential)) return clone(current.credential);
			if (updateError) throw updateError;
			if (next !== undefined && !isDeepStrictEqual(next, account.credential)) {
				current.credential = credential(next, account.credential);
				await this.#save(latest, options);
			}
			return clone(current.credential);
		}, options);
	}

	/** Update one existing account only when the request's credential still matches. */
	updateProfile(id, value, options = {}) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			const account = state.accounts.find((entry) => entry.id === id);
			if (!account || !options.expectedAccess || account.credential.access !== options.expectedAccess) return false;
			const profile = profileOf({ profile: value });
			if (!profile) throw new Error("Invalid Claude public account profile");
			if (profile.accountUuid && account.profile?.accountUuid && profile.accountUuid !== account.profile.accountUuid) {
				throw new Error("Claude account profile identity mismatch");
			}
			account.profile = profile;
			// 只有占位名才覆盖；用户自己起的备注名保持不动。
			if (placeholderLabel(account.label, account.id)) {
				const readable = profile.displayName ?? profile.email;
				if (readable) account.label = readable;
			}
			await this.#save(state, options);
			return true;
		}, options);
	}

	add(label, value, options) {
		return this.#serialize(async () => {
			const nextCredential = credential(value);
			const state = await this.#load();
			const profile = profileOf({ credential: nextCredential });
			const account = {
				id: `claude-${randomUUID()}`,
				label: typeof label === "string" && label.trim() ? label.trim() : profile?.displayName ?? profile?.email ?? `Claude ${state.accounts.length + 1}`,
				addedAt: new Date().toISOString(), credential: nextCredential,
				...(profile ? { profile } : {})
			};
			state.accounts.push(account);
			state.activeId = account.id;
			await this.#save(state, options);
			return { id: account.id, label: account.label };
		}, options);
	}

	/** Atomic read -> await update -> write. All vault operations share this queue.
	 * update receives the same skewed view as read(); undefined or an equal view is a no-op.
	 * New expiration values are raw epoch milliseconds; an unchanged view expiration is restored.
	 * Do not await another operation on this vault inside update (the lock is non-reentrant).
	 */
	modifyActive(update, options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			const account = state.accounts.find((entry) => entry.id === state.activeId);
			const current = skew(account?.credential);
			const next = await update(clone(current));
			aborted(options);
			if (next === undefined || isDeepStrictEqual(next, current)) return clone(current);
			const normalized = credential(next, account?.credential);
			if (account === undefined) throw new Error("Claude account vault has no active account to update");
			if (next.expires === current.expires) normalized.expires = account.credential.expires;
			account.credential = normalized;
			await this.#save(state, options);
			return clone(normalized);
		}, options);
	}

	/** Explicit replacement uses raw expiry; prefer modifyActive for refresh transactions. */
	writeActive(value, options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			aborted(options);
			const account = state.accounts.find((entry) => entry.id === state.activeId);
			if (account === undefined) return;
			account.credential = credential(value, account.credential);
			await this.#save(state, options);
		}, options);
	}

	select(id, options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			if (!state.accounts.some((entry) => entry.id === id)) throw new Error(`Unknown Claude account: ${id}`);
			state.activeId = id;
			await this.#save(state, options);
			return id;
		}, options);
	}

	remove(id, options) {
		return this.#serialize(async () => {
			const state = await this.#load();
			const accounts = state.accounts.filter((entry) => entry.id !== id);
			if (accounts.length === state.accounts.length) throw new Error(`Unknown Claude account: ${id}`);
			if (accounts.length === 0) throw new Error("This is the last Claude account; use logout to clear it");
			state.accounts = accounts;
			if (state.activeId === id) state.activeId = accounts[0].id;
			await this.#save(state, options);
		}, options);
	}

	clear(options) {
		return this.#serialize(async () => {
			// Even explicit clear diagnoses corrupt state; repair must be an intentional external action.
			await this.#load();
			aborted(options);
			await this.#credentials.unset(this.#ref);
		}, options);
	}
}

export class VaultCredentialStore {
	#vault;
	constructor(vault) { this.#vault = vault; }
	read(providerId, options) { checkProvider(providerId); return this.#vault.active(options); }
	async list(options) { return await this.read(PROVIDER, options) === undefined ? [] : [{ providerId: PROVIDER, type: "oauth" }]; }
	modify(providerId, update, options) { checkProvider(providerId); return this.#vault.modifyActive(update, options); }
	delete(providerId, options) { checkProvider(providerId); return this.#vault.clear(options); }
}

/** Login-only cell: raw expiry, no persistence, no host dependencies. */
export class PendingCredentialStore {
	#credential;
	#serialize = serializer();
	read(providerId, options) { checkProvider(providerId); aborted(options); return clone(this.#credential); }
	async list(options) { aborted(options); return []; }
	modify(providerId, update, options) {
		checkProvider(providerId);
		return this.#serialize(async () => {
			const next = await update(clone(this.#credential));
			aborted(options);
			if (next !== undefined) this.#credential = credential(next, this.#credential);
			return clone(this.#credential);
		}, options);
	}
	delete(providerId, options) {
		checkProvider(providerId);
		return this.#serialize(() => { aborted(options); this.#credential = undefined; }, options);
	}
	credential() { return clone(this.#credential); }
}
