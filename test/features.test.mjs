import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AccountVault } from "../lib/accounts.js";
import { AccountCache, retryAfterMs } from "../lib/cache.js";
import { createUsageService, summarizeUsage } from "../lib/usage.js";
import { createRefreshService } from "../lib/refresh.js";
import { createCatalogService, mapCatalog } from "../lib/catalog.js";
import { createAccountRouter, bindAccountHistory } from "../lib/routing.js";
import { createVaultLock } from "../lib/vault-lock.js";

const credential = (expires = Date.now() + 3600_000) => ({ type: "oauth", access: "sk-ant-oat01-fake", refresh: "sk-ant-ort01-fake", expires });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
	let value;
	const vault = new AccountVault({ resolve: async () => value ? { value } : undefined, set: async (_, next) => { value = next; }, unset: async () => { value = undefined; } }, "fake");
	const a = await vault.add("Alice", credential()), b = await vault.add("Bob", credential());
	await vault.select(a.id);
	return { vault, a: a.id, b: b.id, resolveAccount: async id => (await vault.record(id)).credential };
}
const model = { id: "claude-offline-5", name: "Offline", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", type: "chat", contextWindow: 1000, maxTokens: 100,
	reasoning: false, input: ["text", "image"], compat: {}, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test("modern quota windows win; malformed arrays fall back; model scope and overspend survive", () => {
	const modern = summarizeUsage({ five_hour: { utilization: 1 }, limits: [null, { percent: "10" }, { kind: "weekly_scoped", percent: 110, resets_at: "2030-01-01T00:00:00Z", scope: { model: { display_name: "Opus" } } }] });
	assert.equal(modern.length, 1); assert.equal(modern[0].scope, "Opus"); assert.equal(modern[0].remainingPercent, 0);
	assert.equal(summarizeUsage({ limits: [null], five_hour: { utilization: 20 } })[0].remainingPercent, 80);
	assert.equal(summarizeUsage({ limits: [{ percent: -1 }] }), undefined);
});

test("cache merges callers; one cancellation does not cancel another", async () => {
	const cache = new AccountCache(), gate = deferred(), controller = new AbortController();
	let calls = 0, sharedSignal;
	const load = async signal => { calls++; sharedSignal = signal; await gate.promise; return { ok: true }; };
	const a = cache.get("a", load, { signal: controller.signal }), b = cache.get("a", load);
	controller.abort(); await assert.rejects(a, { name: "AbortError" });
	assert.equal(sharedSignal.aborted, false); gate.resolve();
	assert.deepEqual((await b).value, { ok: true }); assert.equal(calls, 1);
});

test("all cache callers leaving aborts work; late completion cannot publish", async () => {
	const cache = new AccountCache(), gate = deferred(), controller = new AbortController();
	const task = cache.get("a", async () => { await gate.promise; return "late"; }, { signal: controller.signal });
	controller.abort(); await assert.rejects(task); gate.resolve(); await new Promise(resolve => setImmediate(resolve));
	assert.equal(cache.peek("a"), undefined);
	assert.equal((await cache.get("a", async () => "new request")).value, "new request");
});

test("429 negative caching respects Retry-After even for forced refresh; stale success stays visible", async () => {
	let time = 1000, calls = 0, fail = false;
	const cache = new AccountCache({ ttlMs: 100, now: () => time });
	const load = async () => { calls++; if (fail) throw Object.assign(new Error("safe"), { retryAfterMs: 2000 }); return { percent: 12 }; };
	await cache.get("a", load); time += 101; fail = true;
	assert.equal((await cache.get("a", load, { force: true })).stale, true);
	await cache.get("a", load, { force: true }); assert.equal(calls, 2);
	time += 2001; fail = false; assert.equal((await cache.get("a", load, { force: true })).stale, false);
	const cold = new AccountCache({ now: () => time }); calls = 0; fail = true;
	await assert.rejects(cold.get("a", load)); await assert.rejects(cold.get("a", load, { force: true })); assert.equal(calls, 1);
	assert.equal(retryAfterMs(new Headers({ "retry-after": "2" }), 1000), 2000);
	assert.equal(retryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:04 GMT" }), 1000), 3000);
});

test("usage service isolates accounts, strips raw payloads and rejects an active-account switch", async () => {
	const f = await fixture(); let calls = 0;
	const gate = deferred(); let block = false;
	const service = createUsageService({ ...f, fetchImpl: async () => { calls++; if (block) await gate.promise; return Response.json({ five_hour: { utilization: 20 }, secret: "never on wire" }); } });
	const first = await service.read(); assert.equal(first.accountId, f.a); assert.equal(first.raw, undefined);
	await service.read(); assert.equal(calls, 1);
	await service.read({ accountId: f.b }); assert.equal(calls, 2);
	block = true; const task = service.read({ force: true });
	while (calls < 3) await new Promise(resolve => setImmediate(resolve));
	await f.vault.select(f.b); gate.resolve(); await assert.rejects(task, { code: "ACCOUNT_CHANGED" });
});

test("refresh permanent rejection pauses until credentials change, preserving a valid access token", async () => {
	const f = await fixture(); let time = 10000, calls = 0;
	await f.vault.writeActive(credential(time + 1000));
	const service = createRefreshService({ vault: f.vault, now: () => time, oauth: { refresh: async () => { calls++; throw Object.assign(new Error("upstream secret"), { status: 400 }); } } });
	await service.resolve(f.a); await service.resolve(f.a); assert.equal(calls, 1);
	assert.equal((await service.status(f.a)).loginRequired, true);
	time += 2000; await assert.rejects(service.resolve(f.a), { code: "AUTH_REQUIRED" }); assert.equal(calls, 1);
	await f.vault.writeActive({ ...credential(time + 1000), refresh: "sk-ant-ort01-new" });
	await service.resolve(f.a); assert.equal(calls, 2);
	assert.doesNotMatch(JSON.stringify(await service.status(f.a)), /secret|sk-ant/);
});

test("transient refresh failure backs off, then retries; cancellation never creates a warning", async () => {
	const f = await fixture(); let time = 10000, calls = 0;
	await f.vault.writeActive(credential(time + 120_000));
	const service = createRefreshService({ vault: f.vault, now: () => time, oauth: { refresh: async () => { calls++; if (calls === 1) throw new Error("network"); return credential(time + 3600_000); } } });
	await service.resolve(f.a); await service.resolve(f.a); assert.equal(calls, 1);
	time += 61_000; await service.resolve(f.a); assert.equal(calls, 2); assert.deepEqual(await service.status(f.a), {});
	const controller = new AbortController(); controller.abort();
	await assert.rejects(service.resolve(f.a, { signal: controller.signal })); assert.deepEqual(await service.status(f.a), {});
});

test("refresh cannot overwrite a newer credential written during the HTTP request", async () => {
	let state = { version: 1, activeId: "a", accounts: [{ id: "a", label: "A", addedAt: new Date().toISOString(), credential: credential(1) }] };
	const vault = new AccountVault({ resolve: async () => ({ value: JSON.stringify(state) }), set: async (_, value) => { state = JSON.parse(value); }, unset: async () => {} }, "fixture");
	const service = createRefreshService({ vault, oauth: { refresh: async () => { state.accounts[0].credential = { ...credential(), access: "sk-ant-oat01-newlogin" }; return { ...credential(), access: "sk-ant-oat01-oldrefresh" }; } } });
	assert.equal((await service.resolve("a")).access, "sk-ant-oat01-newlogin");
});

test("catalog validates capabilities and IDs without inheriting another model's fallbacks", () => {
	const mapped = mapCatalog([{ id: "claude-new-6", display_name: "New", max_input_tokens: 9000, max_tokens: 400,
		capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true, high: { supported: true }, max: { supported: false } } } }, { id: "../../bad" }], [model]);
	assert.equal(mapped.length, 1); assert.equal(mapped[0].contextWindow, 9000); assert.equal(mapped[0].maxTokens, 400);
	assert.equal(mapped[0].compat.forceAdaptiveThinking, true); assert.deepEqual(mapped[0].thinkingLevelMap, { high: "high", off: null });
	assert.throws(() => mapCatalog([], [model]), { code: "CATALOG_EMPTY" });
	assert.equal(model.reasoning, false);
});

test("catalog persists only safe metadata, restores offline, and separates accounts", async t => {
	const f = await fixture(), directory = await mkdtemp(path.join(tmpdir(), "claude-catalog-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let calls = 0;
	const options = { ...f, fallback: () => [model], directory, fetchImpl: async () => { calls++; return Response.json({ data: [{ id: "claude-new-6", private: "secret", max_input_tokens: 8000 }] }); } };
	const catalog = createCatalogService(options);
	await catalog.refresh(f.a); await catalog.refresh(f.a); assert.equal(calls, 1);
	assert.equal(catalog.models(f.b)[0].id, model.id);
	const disk = await readFile(path.join(directory, `${f.a}.json`), "utf8"); assert.doesNotMatch(disk, /secret|sk-ant/);
	const offline = createCatalogService({ ...options, fetchImpl: async () => { throw new Error("offline"); } });
	assert.equal((await offline.refresh(f.a)).models[0].id, "claude-new-6");
	await offline.remove(f.a); assert.equal(offline.models(f.a)[0].id, model.id);
	catalog.close(); offline.close();
});

test("catalog rejects broken pagination and cancellation without publishing", async () => {
	const f = await fixture();
	const catalog = createCatalogService({ ...f, fallback: () => [model], fetchImpl: async () => Response.json({ data: [{ id: "claude-new-6" }], has_more: true }) });
	await assert.rejects(catalog.refresh(f.a), { code: "CATALOG_SHAPE" });
	assert.equal(catalog.models(f.a)[0].id, model.id);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(catalog.refresh(f.b, { signal: controller.signal })); catalog.close();
});

function routerFixture(f, serve, mode = "priority") {
	const calls = [];
	const router = createAccountRouter({ vault: f.vault, adapter: { resolveModel: async () => ({ id: model.id }) }, usage: { read: async () => ({ windows: [] }) }, mode,
		adapterFor: async id => ({ stream(options) { calls.push(id); return serve(id, options); } }) });
	return { router, calls, options: { provider: "anthropic", model: model.id, messages: [], sessionId: "s" } };
}

test("failover only before content; usage is buffered; next turn stays sticky; default remains unchanged", async () => {
	const f = await fixture(); let first = true;
	const r = routerFixture(f, async function* (id) {
		if (id === f.a && first) { first = false; yield { type: "usage", usage: { inputTokens: 1 } }; throw Object.assign(new Error("limited"), { code: "RATE_LIMIT" }); }
		yield { type: "text-delta", text: "OK" }; yield { type: "finish", replayState: { response: { kind: "pi-ai" }, blocks: [] } };
	});
	const output = await collect(r.router.adapter.stream(r.options));
	assert.deepEqual(r.calls, [f.a, f.b]); assert.equal(output[0].type, "text-delta");
	assert.equal(output[1].replayState.response.kind, "claude-subscription-account");
	const history = [{ role: "assistant", source: { replayState: output[1].replayState }, content: [] }];
	assert.equal(bindAccountHistory(history, f.b, model.id, false)[0].source.replayState.response.kind, "pi-ai");
	assert.equal(bindAccountHistory(history, f.a, model.id, false)[0].source.replayState, undefined);
	assert.equal(bindAccountHistory(history, f.b, "claude-other", false)[0].source.replayState, undefined);
	await collect(r.router.adapter.stream(r.options)); assert.equal(r.calls.at(-1), f.b);
	assert.equal((await f.vault.list()).activeId, f.a); assert.equal(r.router.current("s", model.id).accountId, f.b);
});

test("partial content, invalid requests and cancellation never fail over", async () => {
	for (const scenario of ["partial", "invalid", "abort"]) {
		const f = await fixture(), controller = new AbortController();
		const r = routerFixture(f, async function* () {
			if (scenario === "partial") yield { type: "reasoning-delta", text: "thinking" };
			if (scenario === "abort") controller.abort();
			throw Object.assign(new Error("failed"), { code: scenario === "invalid" ? "INVALID_REQUEST" : "SERVER" });
		});
		await assert.rejects(collect(r.router.adapter.stream({ ...r.options, signal: controller.signal })));
		assert.equal(r.calls.length, 1);
	}
});

test("disabled routing uses default only; prepared calls use the router", async () => {
	const f = await fixture();
	const r = routerFixture(f, async function* () { throw Object.assign(new Error("server"), { code: "SERVER" }); }, "off");
	const prepared = await r.router.adapter.prepareCall("anthropic", model.id);
	await assert.rejects(collect(prepared.stream(r.options))); assert.deepEqual(r.calls, [f.a]);
	assert.throws(() => r.router.setMode("bogus"));
});

test("quota-aware routing avoids full windows and respects model scope", async () => {
	const f = await fixture();
	const router = createAccountRouter({ vault: f.vault, adapter: {}, mode: "quota-aware", usage: { read: async ({ accountId }) => ({ windows: [{ utilization: accountId === f.a ? 99 : 10, remainingPercent: accountId === f.a ? 1 : 90 }] }) },
		adapterFor: async id => ({ async *stream() { yield { type: "text-delta", text: id }; } }) });
	assert.equal((await collect(router.adapter.stream({ provider: "anthropic", model: model.id, messages: [] })))[0].text, f.b);
});

test("replay is accepted only by its originating account and model", () => {
	const wrapped = { role: "assistant", source: { replayState: { response: { kind: "claude-subscription-account", version: 1, key: "wrong", state: {} }, blocks: [] } }, content: [] };
	assert.equal(bindAccountHistory([wrapped], "a", model.id, false)[0].source.replayState, undefined);
	const legacy = { ...wrapped, source: { replayState: { response: { kind: "pi-ai" }, blocks: [] } } };
	assert.equal(bindAccountHistory([legacy], "b", model.id, false)[0].source.replayState, undefined);
	assert.ok(bindAccountHistory([legacy], "a", model.id, true)[0].source.replayState);
});

test("vault lock serializes distinct processes, and cancellation cannot run a queued mutation", async t => {
	const directory = await mkdtemp(path.join(tmpdir(), "claude-lock-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const data = path.join(directory, "counter"), file = path.join(directory, "vault");
	await writeFile(data, "0");
	const code = `import {createVaultLock} from ${JSON.stringify(new URL("../lib/vault-lock.js", import.meta.url).href)}; import {readFile,writeFile} from 'node:fs/promises'; const lock=createVaultLock(${JSON.stringify(file)}); for(let i=0;i<4;i++)await lock(async()=>{const n=Number(await readFile(${JSON.stringify(data)},'utf8'));await new Promise(r=>setTimeout(r,5));await writeFile(${JSON.stringify(data)},String(n+1));});`;
	const child = () => new Promise((resolve, reject) => {
		const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		let errors = ""; process.stderr.on("data", chunk => { errors += chunk; }); process.on("error", reject); process.on("exit", status => status === 0 ? resolve() : reject(new Error(errors)));
	});
	await Promise.all([child(), child(), child()]); assert.equal(await readFile(data, "utf8"), "12");
	const lock = createVaultLock(file), gate = deferred(), entered = deferred();
	const first = lock(async () => { entered.resolve(); await gate.promise; }); await entered.promise;
	const controller = new AbortController(); let mutated = false;
	const second = lock(async () => { mutated = true; }, { signal: controller.signal }); controller.abort();
	await assert.rejects(second); gate.resolve(); await first;
	await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(mutated, false);
});
