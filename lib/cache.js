import { abortable } from "./operation.js";

/** Shared work has its own cancellation; one subscriber cannot cancel another. */
export class AccountCache {
	#entries = new Map();
	#flights = new Map();
	constructor({ ttlMs = 300_000, failureMs = 60_000, now = Date.now } = {}) {
		Object.assign(this, { ttlMs, failureMs, now });
	}
	peek(key) { return this.#entries.get(key); }
	invalidate(key) {
		for (const id of key === undefined ? new Set([...this.#entries.keys(), ...this.#flights.keys()]) : [key]) {
			this.#entries.delete(id);
			this.#flights.get(id)?.controller.abort();
			this.#flights.delete(id);
		}
	}
	seed(key, value, at) { if (!this.#entries.has(key)) this.#entries.set(key, { value, at, retryAt: 0 }); }
	async get(key, load, { signal, force = false, background = true } = {}) {
		signal?.throwIfAborted();
		const cached = this.#entries.get(key);
		const result = (entry) => ({ value: structuredClone(entry.value), stale: !!entry.error || this.now() - entry.at >= this.ttlMs,
			...(entry.error ? { warning: "暂时无法刷新，显示上次成功的数据。", retryAt: entry.retryAt } : {}) });
		if (cached?.retryAt > this.now()) {
			if (cached.value !== undefined) return result(cached);
			throw cached.error;
		}
		if (!force && cached?.value !== undefined && this.now() - cached.at < this.ttlMs) return result(cached);
		let flight = this.#flights.get(key);
		if (!flight) {
			flight = { controller: new AbortController(), users: 0, keep: false };
			const entry = flight;
			flight.promise = abortable(Promise.resolve().then(() => { entry.controller.signal.throwIfAborted(); return load(entry.controller.signal); }), entry.controller.signal).then(value => {
				if (this.#flights.get(key) === entry && !entry.controller.signal.aborted) this.#entries.set(key, { value, at: this.now(), retryAt: 0 });
				return { value: structuredClone(value), stale: false };
			}).catch(error => {
				if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
				const next = { ...cached, error, retryAt: this.now() + (error.retryAfterMs ?? this.failureMs) };
				if (this.#flights.get(key) === entry) this.#entries.set(key, next);
				if (next.value !== undefined) return result(next);
				throw error;
			}).finally(() => { if (this.#flights.get(key) === entry) this.#flights.delete(key); });
			this.#flights.set(key, flight);
		}
		if (!force && background && cached?.value !== undefined) {
			flight.keep = true;
			void flight.promise.catch(() => {});
			return result(cached);
		}
		flight.users++;
		try { return await abortable(flight.promise, signal); }
		finally {
			if (--flight.users === 0 && !flight.keep && this.#flights.get(key) === flight) {
				this.#flights.delete(key);
				flight.controller.abort();
			}
		}
	}
}

export function retryAfterMs(headers, now = Date.now()) {
	const raw = headers.get("retry-after");
	if (raw === null) return undefined;
	const seconds = Number(raw);
	const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
	return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 7 * 86400_000) : undefined;
}
