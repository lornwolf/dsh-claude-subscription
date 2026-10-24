import test from "node:test";
import assert from "node:assert/strict";
import { AccountVault, VaultCredentialStore, PendingCredentialStore, PROVIDER, OAUTH_EXPIRY_SKEW_MS } from "../lib/accounts.js";

// Synthetic tokens only. Never resolve host credentials or make network requests.
const oauth = (name = "a", expires = 2_000_000_000_000) => ({ type: "oauth", access: `sk-ant-oat01-synthetic_${name}`, refresh: `sk-ant-ort01-synthetic_${name}`, expires });
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function memory(initial) {
	let value = initial;
	const calls = { resolve: 0, set: 0, unset: 0 };
	return {
		calls,
		async resolve(ref) { assert.equal(ref, "synthetic-ref"); calls.resolve++; return value === undefined ? undefined : { value }; },
		async set(ref, next) { assert.equal(ref, "synthetic-ref"); calls.set++; value = next; },
		async unset(ref) { assert.equal(ref, "synthetic-ref"); calls.unset++; value = undefined; },
		raw: () => value,
		state: () => value === undefined ? undefined : JSON.parse(value)
	};
}
function fixture(initial) {
	const backend = memory(initial);
	const vault = new AccountVault(backend, "synthetic-ref");
	return { backend, vault, store: new VaultCredentialStore(vault) };
}
async function pair() {
	const f = fixture();
	f.a = await f.vault.add("A", oauth("a"));
	f.b = await f.vault.add("B", oauth("b"));
	await f.vault.select(f.a.id);
	return f;
}
function blockedRefresh(store, next = oauth("fresh", 2_000_001_000_000), options) {
	const entered = deferred(), release = deferred();
	const run = store.modify(PROVIDER, async (current) => {
		entered.resolve(current);
		await release.promise;
		return next;
	}, options);
	return { entered: entered.promise, release: release.resolve, run };
}

test("API: list/add/active/select/write/remove/clear and clone boundaries", async () => {
	const { vault, backend, store } = fixture();
	assert.deepEqual(await vault.list(), { activeId: undefined, accounts: [] });
	assert.equal(await store.read(PROVIDER), undefined);
	assert.deepEqual(await store.list(), []);
	const input = oauth();
	const a = await vault.add(" A ", input);
	input.access = "mutated";
	assert.equal(a.label, "A");
	assert.equal((await vault.active()).expires, oauth().expires - OAUTH_EXPIRY_SKEW_MS);
	const read = await vault.active(); read.refresh = "mutated";
	assert.equal((await vault.active()).refresh, oauth().refresh);
	assert.deepEqual(await store.list(), [{ providerId: PROVIDER, type: "oauth" }]);
	const listed = await vault.list();
	assert.equal(listed.accounts[0].expires, oauth().expires);
	assert.equal("credential" in listed.accounts[0], false);
	assert.equal("access" in listed.accounts[0], false);
	const b = await vault.add("", oauth("b"));
	assert.equal(b.label, "Claude 2");
	assert.equal(await vault.select(a.id), a.id);
	assert.equal(await vault.writeActive(oauth("written")), undefined);
	assert.equal((await vault.active()).access, oauth("written").access);
	await vault.remove(a.id);
	assert.equal((await vault.list()).activeId, b.id);
	await assert.rejects(vault.remove(b.id), /last/);
	await assert.rejects(vault.select("missing"), /Unknown/);
	await assert.rejects(vault.remove("missing"), /Unknown/);
	await store.delete(PROVIDER);
	assert.equal(backend.raw(), undefined);
});

test("refresh + select: whole transaction stays on original account", async () => {
	const { vault, store, backend, a, b } = await pair();
	const refresh = blockedRefresh(store);
	assert.equal((await refresh.entered).access, oauth("a").access);
	const readsBeforeSelect = backend.calls.resolve;
	let selectFinished = false;
	const selected = vault.select(b.id).then((id) => { selectFinished = true; return id; });
	// Deliberate contract: select waits for the in-flight refresh transaction.
	await Promise.resolve();
	assert.equal(selectFinished, false);
	assert.equal(backend.calls.resolve, readsBeforeSelect);
	assert.equal(backend.state().activeId, a.id);
	refresh.release();
	await refresh.run;
	await selected;
	const state = backend.state();
	assert.equal(state.activeId, b.id);
	assert.equal(state.accounts.find((x) => x.id === a.id).credential.access, oauth("fresh").access);
	assert.equal(state.accounts.find((x) => x.id === b.id).credential.access, oauth("b").access);
});

test("select before refresh means refresh sees newly selected account", async () => {
	const { vault, store, b } = await pair();
	const selected = vault.select(b.id);
	const run = store.modify(PROVIDER, (current) => { assert.equal(current.access, oauth("b").access); });
	await Promise.all([selected, run]);
});

test("refresh + remove: removed account never resurrects", async () => {
	const { vault, store, backend, a, b } = await pair();
	const refresh = blockedRefresh(store); await refresh.entered;
	const removed = vault.remove(a.id);
	refresh.release(); await refresh.run; await removed;
	assert.deepEqual(backend.state().accounts.map((x) => x.id), [b.id]);
	assert.equal(backend.state().accounts[0].credential.access, oauth("b").access);
});

test("refresh + clear: clear wins and no delayed write resurrects vault", async () => {
	const { vault, store, backend } = await pair();
	const refresh = blockedRefresh(store); await refresh.entered;
	const cleared = vault.clear();
	refresh.release(); await refresh.run; await cleared;
	assert.equal(backend.raw(), undefined);
	const sets = backend.calls.set;
	await assert.rejects(store.modify(PROVIDER, () => oauth("late")), /no active account/);
	assert.equal(backend.calls.set, sets);
	assert.equal(backend.raw(), undefined);
});

test("clear before queued refresh gives update undefined and never creates account", async () => {
	const { vault, store, backend } = await pair();
	const cleared = vault.clear();
	const refresh = store.modify(PROVIDER, (current) => { assert.equal(current, undefined); return undefined; });
	await Promise.all([cleared, refresh]);
	assert.equal(backend.raw(), undefined);
});

test("refresh + add is serialized; newly added credential is not overwritten", async () => {
	const { vault, store, backend } = await pair();
	const refresh = blockedRefresh(store); await refresh.entered;
	const added = vault.add("C", oauth("c"));
	refresh.release(); await refresh.run; const c = await added;
	assert.equal(backend.state().activeId, c.id);
	assert.equal((await store.read(PROVIDER)).access, oauth("c").access);
});

test("multiple stores share the vault lock across read/modify/delete", async () => {
	const { vault, store, backend } = await pair();
	const second = new VaultCredentialStore(vault);
	const refresh = blockedRefresh(store); await refresh.entered;
	const read = second.read(PROVIDER);
	const next = second.modify(PROVIDER, (current) => {
		assert.equal(current.access, oauth("fresh").access);
		return { ...oauth("second"), refresh: undefined };
	});
	refresh.release(); await refresh.run;
	assert.equal((await read).access, oauth("fresh").access);
	assert.equal((await next).refresh, oauth("fresh").refresh);
	await second.delete(PROVIDER);
	assert.equal(backend.raw(), undefined);
});

test("refresh rotation and omitted refresh token preserve correct previous token", async () => {
	const { vault, store, backend } = fixture(); await vault.add("A", oauth("a"));
	let result = await store.modify(PROVIDER, () => oauth("rotated", 2_000_000_100_000));
	assert.equal(result.refresh, oauth("rotated").refresh);
	const next = oauth("new", 2_000_000_200_000); delete next.refresh;
	result = await store.modify(PROVIDER, () => next);
	assert.equal(result.refresh, oauth("rotated").refresh);
	assert.equal(backend.state().accounts[0].credential.refresh, result.refresh);
	assert.equal(result.expires, next.expires);
});

test("undefined / same object / equal clone no-op returns skew view and never persists it", async () => {
	const { vault, store, backend } = fixture(); await vault.add("A", oauth());
	const raw = backend.raw(), sets = backend.calls.set;
	for (const update of [() => undefined, (current) => current, (current) => structuredClone(current)]) {
		const result = await store.modify(PROVIDER, update);
		assert.equal(result.expires, oauth().expires - OAUTH_EXPIRY_SKEW_MS);
		assert.equal(backend.raw(), raw);
	}
	assert.equal(backend.calls.set, sets);
	assert.equal((await store.read(PROVIDER)).expires, oauth().expires - OAUTH_EXPIRY_SKEW_MS);
});

test("mutating callback input does not hide changes or persist skew twice", async () => {
	const { vault, store, backend } = fixture(); await vault.add("A", oauth());
	await store.modify(PROVIDER, (current) => { current.access = oauth("mutated").access; return current; });
	assert.equal(backend.state().accounts[0].credential.expires, oauth().expires);
	assert.equal((await store.read(PROVIDER)).expires, oauth().expires - OAUTH_EXPIRY_SKEW_MS);
	assert.equal((await store.read(PROVIDER)).access, oauth("mutated").access);
	const raw = backend.raw();
	await store.modify(PROVIDER, (current) => { current.access = oauth("discarded").access; });
	assert.equal(backend.raw(), raw);
});

test("OAuth validation rejects malformed fields without changing storage", async () => {
	const invalid = [
		undefined, {}, { ...oauth(), type: "api_key" },
		{ ...oauth(), access: "" }, { ...oauth(), access: "sk-ant-api03-notOAuth" },
		{ ...oauth(), access: "sk-ant-oat01-has whitespace" },
		{ ...oauth(), refresh: "" }, { ...oauth(), refresh: null }, { ...oauth(), refresh: "wrong" },
		{ ...oauth(), expires: undefined }, { ...oauth(), expires: "2000000000000" },
		{ ...oauth(), expires: NaN }, { ...oauth(), expires: Infinity },
		{ ...oauth(), expires: -1 }, { ...oauth(), expires: 0 }, { ...oauth(), expires: 1.5 }
	];
	const { vault, store, backend } = fixture(); await vault.add("A", oauth());
	const raw = backend.raw();
	for (const value of invalid) {
		await assert.rejects(vault.add("bad", value), /Invalid Claude OAuth/);
		if (value !== undefined) await assert.rejects(store.modify(PROVIDER, () => value), /Invalid Claude OAuth/);
		assert.equal(backend.raw(), raw);
	}
	const missingRefresh = oauth(); delete missingRefresh.refresh;
	await assert.rejects(vault.add("bad", missingRefresh), /refresh/);
});

test("expired credentials remain readable for refresh", async () => {
	const { vault, store } = fixture(); await vault.add("expired", oauth("old", 1000));
	assert.equal((await store.read(PROVIDER)).expires, 1000 - OAUTH_EXPIRY_SKEW_MS);
});

test("bad or unknown persisted vault never silently clears or overwrites", async () => {
	const validAccount = { id: "a", label: "A", addedAt: "2026-10-24T00:00:00.000Z", credential: oauth() };
	const valid = { version: 1, activeId: "a", accounts: [validAccount] };
	const cases = ["", "{broken", "null", "[]", "{}", JSON.stringify({ ...valid, version: 2 }),
		JSON.stringify({ ...valid, accounts: {} }), JSON.stringify({ ...valid, activeId: "missing" }),
		JSON.stringify({ ...valid, accounts: [validAccount, validAccount] }),
		JSON.stringify({ ...valid, accounts: [{ ...validAccount, addedAt: "invalid" }] }),
		JSON.stringify({ ...valid, accounts: [{ ...validAccount, credential: { ...oauth(), access: "bad" } }] })];
	for (const raw of cases) {
		const { vault, backend } = fixture(raw);
		for (const operation of [() => vault.list(), () => vault.active(), () => vault.add("B", oauth("b")),
			() => vault.writeActive(oauth("b")), () => vault.modifyActive(() => oauth("b")),
			() => vault.select("a"), () => vault.remove("a"), () => vault.clear()]) {
			await assert.rejects(operation(), /Invalid Claude account vault/);
			assert.equal(backend.raw(), raw);
		}
		assert.equal(backend.calls.set + backend.calls.unset, 0);
	}
});

test("non-string backend values are diagnostic rather than treated as empty", async () => {
	for (const value of [false, 0, {}, []]) {
		const { vault, backend } = fixture(value);
		await assert.rejects(vault.add("A", oauth()), /stored value/);
		assert.equal(backend.calls.set, 0);
	}
});

test("abort before enqueue performs no read or update", async () => {
	const { vault, store, backend } = fixture();
	const controller = new AbortController(); controller.abort();
	let called = false;
	await assert.rejects(store.modify(PROVIDER, () => { called = true; }, { signal: controller.signal }), { name: "AbortError" });
	await assert.rejects(vault.add("A", oauth(), { signal: controller.signal }), { name: "AbortError" });
	assert.equal(called, false);
	assert.equal(backend.calls.resolve, 0);
});

test("abort while queued skips callback, reads, and mutation then queue continues", async () => {
	const { vault, store, backend } = await pair();
	const refresh = blockedRefresh(store); await refresh.entered;
	const controller = new AbortController();
	let called = false;
	const queued = store.modify(PROVIDER, () => { called = true; return oauth("bad"); }, { signal: controller.signal });
	const rejection = assert.rejects(queued, { name: "AbortError" });
	controller.abort();
	const reads = backend.calls.resolve;
	refresh.release(); await refresh.run; await rejection;
	assert.equal(called, false);
	assert.equal(backend.calls.resolve, reads);
	assert.equal((await vault.active()).access, oauth("fresh").access);
});

test("abort after async load is checked before invoking update", async () => {
	const { vault, store, backend } = fixture(); await vault.add("A", oauth());
	const entered = deferred(), release = deferred();
	const resolve = backend.resolve;
	backend.resolve = async (ref) => { const hit = await resolve(ref); entered.resolve(); await release.promise; return hit; };
	const controller = new AbortController(); let called = false;
	const run = store.modify(PROVIDER, () => { called = true; }, { signal: controller.signal });
	const rejection = assert.rejects(run, { name: "AbortError" });
	await entered.promise; controller.abort(); release.resolve(); await rejection;
	assert.equal(called, false);
});

test("abort add during awaited load prevents login account creation", async () => {
	const { vault, backend } = fixture();
	const entered = deferred(), release = deferred(), controller = new AbortController();
	const resolve = backend.resolve;
	backend.resolve = async (ref) => { const hit = await resolve(ref); entered.resolve(); await release.promise; return hit; };
	const added = vault.add("Cancelled login", oauth(), { signal: controller.signal });
	const rejection = assert.rejects(added, { name: "AbortError" });
	await entered.promise; controller.abort(); release.resolve(); await rejection;
	assert.equal(backend.raw(), undefined);
	assert.equal(backend.calls.set + backend.calls.unset, 0);
});

test("abort during awaited update discards result; subsequent select still runs", async () => {
	const { vault, store, backend, b } = await pair();
	const raw = backend.raw();
	const controller = new AbortController();
	const refresh = blockedRefresh(store, oauth("cancelled"), { signal: controller.signal });
	const rejection = assert.rejects(refresh.run, { name: "AbortError" });
	await refresh.entered; controller.abort(); refresh.release(); await rejection;
	assert.equal(backend.raw(), raw);
	await vault.select(b.id);
	assert.equal((await store.read(PROVIDER)).access, oauth("b").access);
});

test("abort queued select/remove/clear/add/delete/read cannot mutate", async () => {
	const { vault, store, backend, a, b } = await pair();
	const refresh = blockedRefresh(store); await refresh.entered;
	const controller = new AbortController(), options = { signal: controller.signal };
	const queued = [vault.select(b.id, options), vault.remove(a.id, options), vault.clear(options),
		vault.add("C", oauth("c"), options), store.delete(PROVIDER, options), store.read(PROVIDER, options)];
	const rejected = queued.map((promise) => assert.rejects(promise, { name: "AbortError" }));
	controller.abort(); refresh.release(); await refresh.run; await Promise.all(rejected);
	assert.equal(backend.state().activeId, a.id);
	assert.equal(backend.state().accounts.length, 2);
});

test("abort after write commit does not misreport persisted success", async () => {
	const { vault, store, backend } = fixture(); await vault.add("A", oauth());
	const entered = deferred(), release = deferred(), controller = new AbortController();
	const set = backend.set;
	backend.set = async (...args) => { await set(...args); entered.resolve(); await release.promise; };
	const run = store.modify(PROVIDER, () => oauth("committed"), { signal: controller.signal });
	await entered.promise; controller.abort(); release.resolve();
	assert.equal((await run).access, oauth("committed").access);
	assert.equal(backend.state().accounts[0].credential.access, oauth("committed").access);
});

test("callback/backend failures release lock and preserve old state", async () => {
	const { vault, store, backend } = fixture(); await vault.add("A", oauth());
	const raw = backend.raw();
	await assert.rejects(store.modify(PROVIDER, () => { throw new Error("update failed"); }), /update failed/);
	const set = backend.set;
	backend.set = async () => { throw new Error("backend failed"); };
	await assert.rejects(store.modify(PROVIDER, () => oauth("failed")), /backend failed/);
	assert.equal(backend.raw(), raw);
	backend.set = set;
	await store.modify(PROVIDER, () => oauth("ok"));
	assert.equal((await store.read(PROVIDER)).access, oauth("ok").access);
});

test("PendingCredentialStore raw expiry, no-op return, cloning, rotation, provider and abort", async () => {
	const pending = new PendingCredentialStore();
	assert.equal(pending.read(PROVIDER), undefined);
	assert.deepEqual(await pending.list(), []);
	assert.equal(await pending.modify(PROVIDER, () => undefined), undefined);
	const input = oauth();
	await pending.modify(PROVIDER, () => input); input.access = "mutated";
	assert.equal(pending.credential().access, oauth().access);
	assert.equal(pending.read(PROVIDER).expires, oauth().expires);
	const copy = pending.read(PROVIDER); copy.refresh = "mutated";
	assert.equal(pending.credential().refresh, oauth().refresh);
	assert.deepEqual(await pending.modify(PROVIDER, () => undefined), oauth());
	const next = oauth("next"); delete next.refresh;
	assert.equal((await pending.modify(PROVIDER, () => next)).refresh, oauth().refresh);
	assert.throws(() => pending.read("other"), /provider/);
	assert.throws(() => pending.modify("other", () => undefined), /provider/);
	assert.throws(() => pending.delete("other"), /provider/);
	await assert.rejects(pending.modify(PROVIDER, () => ({ ...oauth(), expires: NaN })), /expires/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(pending.modify(PROVIDER, () => oauth(), { signal: controller.signal }), { name: "AbortError" });
	await pending.delete(PROVIDER);
	assert.equal(pending.credential(), undefined);
});

test("provider mismatch never touches vault", () => {
	const { store, backend } = fixture();
	for (const run of [() => store.read("other"), () => store.modify("other", () => undefined), () => store.delete("other")]) {
		assert.throws(run, /provider/);
	}
	assert.equal(backend.calls.resolve, 0);
});
