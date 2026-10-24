import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccountProfile, readAccountProfile, createAccountProfileService, PROFILE_URL } from "../lib/profile.js";

const token = (id) => `sk-ant-oat01-synthetic-${id}`;
const payload = (name = "Real A") => ({ account: { uuid: "uuid-a", display_name: name, full_name: "Full A", email: "a@example.invalid", has_claude_max: true, has_claude_pro: true }, organization: { uuid: "org-a", name: "Org A", subscription_status: "active" } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
	const records = new Map(["A", "B"].map((id) => [id, { id, credential: { access: token(id) } }]));
	let activeId = "A", time = 1000, calls = 0, resolves = 0;
	const writes = [];
	const vault = {
		async activeRecord({ signal } = {}) { signal?.throwIfAborted(); return structuredClone(records.get(activeId)); },
		async list({ signal } = {}) { signal?.throwIfAborted(); return { activeId, accounts: [...records.values()].map(({ id, profile }) => ({ id, profile: structuredClone(profile) })) }; },
		async updateProfile(id, profile, { expectedAccess, signal }) {
			signal?.throwIfAborted();
			const record = records.get(id);
			if (!record || record.credential.access !== expectedAccess) return false;
			record.profile = structuredClone(profile); writes.push(id); return true;
		}
	};
	const service = createAccountProfileService({ vault, now: () => time,
		resolveAuth: async (options) => { resolves++; return overrides.resolveAuth ? overrides.resolveAuth({ records, options, activeId }) : { auth: { apiKey: records.get(activeId)?.credential.access } }; },
		fetchImpl: async (...args) => { calls++; return overrides.fetchImpl ? overrides.fetchImpl(...args) : Response.json(payload()); },
		...overrides.service });
	return { service, records, writes, vault, select(id) { activeId = id; }, tick(ms) { time += ms; }, get calls() { return calls; }, get resolves() { return resolves; } };
}

test("normalizes official profile allowlist, true plan booleans and display-name priority", () => {
	assert.deepEqual(normalizeAccountProfile({ ...payload(" Display "), access_token: token("secret") }, { checkedAt: 123 }), {
		accountUuid: "uuid-a", displayName: "Display", email: "a@example.invalid", plan: "max", organizationUuid: "org-a", organizationName: "Org A", subscriptionStatus: "active", checkedAt: 123, source: "oauth-profile"
	});
	assert.equal(normalizeAccountProfile({ account: { has_claude_pro: true } }).plan, "pro");
	assert.equal(normalizeAccountProfile({ account: { has_claude_pro: "true" } }), undefined);
});

test("token metadata works without re-login; names are never invented", () => {
	assert.deepEqual(normalizeAccountProfile({ account: { uuid: " token-id ", email_address: " email@example.invalid " }, access_token: token("secret") }, { now: () => 42 }),
		{ accountUuid: "token-id", email: "email@example.invalid", checkedAt: 42, source: "token" });
	assert.equal(normalizeAccountProfile({ account: { display_name: " ", full_name: " Full " } }).displayName, "Full");
	assert.equal(normalizeAccountProfile({ account: { display_name: " ", email: "x@example.invalid" } }).displayName, undefined);
	for (const p of [null, [], {}, { account: [] }, { access_token: token("secret"), refresh_token: "private" }]) assert.equal(normalizeAccountProfile(p), undefined);
});

test("invalid, control-character and oversized fields are omitted, not truncated", () => {
	const p = normalizeAccountProfile({ account: { uuid: "x".repeat(257), display_name: "bad\nname", full_name: " Good ", email: "x".repeat(321) }, organization: { name: "bad\u202ename", subscription_status: 1 } }, { checkedAt: 0 });
	assert.deepEqual(p, { displayName: "Good", checkedAt: 0, source: "oauth-profile" });
	assert.equal(normalizeAccountProfile({ account: { full_name: "x".repeat(513) } }), undefined);
});

test("official endpoint uses identity headers, bearer, GET and redirect:error", async () => {
	const result = await readAccountProfile({ access: token("A") }, undefined, async (url, init) => {
		assert.equal(url, PROFILE_URL); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
		assert.equal(init.headers.get("authorization"), `Bearer ${token("A")}`);
		assert.equal(init.headers.get("x-app"), "cli"); assert.match(init.headers.get("anthropic-beta"), /oauth-/);
		assert.ok(init.signal instanceof AbortSignal); return Response.json(payload());
	}, { now: () => 12 });
	assert.equal(result.checkedAt, 12); assert.equal(result.source, "oauth-profile");
});

test("errors discard upstream body, causes and network messages", async () => {
	const cases = [async () => new Response("secret-token-and-body", { status: 401 }), async () => new Response("secret-token-and-body"), async () => Response.json([]), async () => { throw Error("secret-token-and-body"); }, async () => { throw Object.assign(Error("secret-token-and-body"), { code: "PROFILE_HTTP", publicMessage: "secret-token-and-body" }); }, async () => { throw undefined; }];
	for (const fetchImpl of cases) await assert.rejects(readAccountProfile({ access: token("A") }, undefined, fetchImpl), (e) => !JSON.stringify(e).includes("secret-token") && !e.message.includes("secret-token") && e.cause === undefined);
});

test("cancel/timeout settle ignored fetch and ignored response-json signals", async () => {
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		await assert.rejects(readAccountProfile({ access: token("A") }, undefined, () => new Promise(() => {}), { timeoutMs: 5 }), { name: "TimeoutError" });
		await assert.rejects(readAccountProfile({ access: token("A") }, undefined, async () => ({ ok: true, json: () => new Promise(() => {}) }), { timeoutMs: 5 }), { name: "TimeoutError" });
		const c = new AbortController();
		const pending = readAccountProfile({ access: token("A") }, undefined, () => new Promise(() => {}), { signal: c.signal });
		c.abort(); await assert.rejects(pending, { name: "AbortError" });
		let calls = 0;
		await assert.rejects(readAccountProfile({ access: token("A") }, undefined, async () => { calls++; }, { signal: AbortSignal.abort() }));
		assert.equal(calls, 0);
	} finally { clearTimeout(keepAlive); }
});

test("existing token metadata upgrades; official cache and forceRefresh work", async () => {
	const f = fixture();
	f.records.get("A").profile = normalizeAccountProfile({ account: { email_address: "old@example.invalid" } }, { checkedAt: 1000 });
	assert.equal((await f.service.ensure()).accounts[0].profile.displayName, "Real A"); assert.equal(f.calls, 1);
	await f.service.ensure(); assert.equal(f.calls, 1); assert.equal(f.resolves, 1);
	await f.service.ensure({ forceRefresh: true }); assert.equal(f.calls, 2);
	f.tick(30 * 60_000); await f.service.ensure(); assert.equal(f.calls, 3);
});

test("singleflight shares concurrent callers", async () => {
	const gate = deferred(); const started = deferred();
	const f = fixture({ fetchImpl: async () => { started.resolve(); await gate.promise; return Response.json(payload()); } });
	const pending = Array.from({ length: 12 }, () => f.service.ensure());
	await started.promise; gate.resolve(); await Promise.all(pending);
	assert.equal(f.calls, 1); assert.equal(f.resolves, 1); assert.deepEqual(f.writes, ["A"]);
});

test("A fetch completing after switch to B updates only A and returns current B list", async () => {
	const gate = deferred(); const started = deferred();
	const f = fixture({ fetchImpl: async (_url, init) => {
		if (init.headers.get("authorization").endsWith("-A")) { started.resolve(); await gate.promise; }
		return Response.json(payload(init.headers.get("authorization").endsWith("-A") ? "Real A" : "Real B"));
	} });
	const a = f.service.ensure(); await started.promise; f.select("B");
	await f.service.ensure(); gate.resolve(); assert.equal((await a).activeId, "B");
	assert.equal(f.records.get("A").profile.displayName, "Real A"); assert.equal(f.records.get("B").profile.displayName, "Real B");
	assert.equal(f.calls, 2);
});

test("switch during auth resolution skips mismatched request entirely", async () => {
	const gate = deferred(), started = deferred();
	const f = fixture({ resolveAuth: async () => { started.resolve(); await gate.promise; return { auth: { apiKey: token("A") } }; } });
	const pending = f.service.ensure(); await started.promise; f.select("B"); gate.resolve(); await pending;
	assert.equal(f.calls, 0); assert.deepEqual(f.writes, []);
});

test("resolved refresh token is rechecked atomically and used for GET", async () => {
	const f = fixture({ resolveAuth: async ({ records }) => { records.get("A").credential.access = token("new"); return { auth: { apiKey: token("new") } }; },
		fetchImpl: async (_url, init) => { assert.equal(init.headers.get("authorization"), `Bearer ${token("new")}`); return Response.json(payload()); } });
	await f.service.ensure(); assert.deepEqual(f.writes, ["A"]);
	const mismatch = fixture({ resolveAuth: async () => ({ auth: { apiKey: token("other") } }) });
	await mismatch.service.ensure(); assert.equal(mismatch.calls, 0);
});

for (const mutation of ["refresh", "delete"]) test(`pending result cannot overwrite after ${mutation}`, async () => {
	const gate = deferred(), started = deferred();
	const f = fixture({ fetchImpl: async () => { started.resolve(); await gate.promise; return Response.json(payload()); } });
	const pending = f.service.ensure(); await started.promise;
	if (mutation === "refresh") f.records.get("A").credential.access = token("changed");
	else f.records.delete("A");
	gate.resolve(); await pending; assert.deepEqual(f.writes, []);
	assert.equal(f.records.get("A")?.profile, undefined);
});

test("failure cooldown is per account/token and preserves existing true metadata", async () => {
	const f = fixture({ fetchImpl: async () => { throw Error("secret upstream body"); } });
	f.records.get("A").profile = normalizeAccountProfile(payload("Existing real name"), { checkedAt: 0 });
	f.tick(30 * 60_000);
	const failed = await f.service.ensure(); assert.match(failed.profileWarning, /资料/); assert.ok(!JSON.stringify(failed).includes("secret"));
	assert.equal(f.records.get("A").profile.displayName, "Existing real name");
	await f.service.ensure({ forceRefresh: true }); assert.equal(f.calls, 1);
	f.select("B"); await f.service.ensure(); assert.equal(f.calls, 2);
	f.select("A"); f.records.get("A").credential.access = token("fresh"); await f.service.ensure(); assert.equal(f.calls, 3);
	f.tick(60_000); await f.service.ensure(); assert.equal(f.calls, 4);
});

test("cancelled caller does not cancel another singleflight subscriber", async () => {
	const gate = deferred(), started = deferred(); let signal;
	const f = fixture({ fetchImpl: async (_url, init) => { signal = init.signal; started.resolve(); await gate.promise; return Response.json(payload()); } });
	const c = new AbortController(); const first = f.service.ensure({ signal: c.signal }); const second = f.service.ensure();
	await started.promise; c.abort(); await assert.rejects(first, { name: "AbortError" });
	assert.equal(signal.aborted, false); gate.resolve(); await second; assert.deepEqual(f.writes, ["A"]);
});

test("all-caller cancellation aborts ignored fetch without cooldown or late writes", async () => {
	const gate = deferred(), started = deferred(); let signal;
	const f = fixture({ fetchImpl: async (_url, init) => { signal = init.signal; started.resolve(); await gate.promise; return Response.json(payload()); } });
	const c = new AbortController(), pending = f.service.ensure({ signal: c.signal });
	await started.promise; c.abort(); await assert.rejects(pending, { name: "AbortError" }); assert.equal(signal.aborted, true);
	gate.resolve(); await f.service.ensure(); assert.equal(f.calls, 2); assert.deepEqual(f.writes, ["A"]);
});

test("service bounds ignored resolveAuth and returns a sanitized status warning", async () => {
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		const f = fixture({ resolveAuth: () => new Promise(() => {}) });
		const result = await f.service.ensure({ timeoutMs: 5 }); assert.match(result.profileWarning, /资料/); assert.equal(f.calls, 0);
	} finally { clearTimeout(keepAlive); }
});

test("no active account needs neither auth nor network; pre-abort propagates", async () => {
	const f = fixture(); f.select(undefined); assert.deepEqual(await f.service.ensure(), { activeId: undefined, accounts: [{ id: "A", profile: undefined }, { id: "B", profile: undefined }] });
	await assert.rejects(f.service.ensure({ signal: AbortSignal.abort() }), { name: "AbortError" }); assert.equal(f.resolves, 0); assert.equal(f.calls, 0);
});
