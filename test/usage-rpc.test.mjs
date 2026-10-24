import { test } from "node:test";
import assert from "node:assert/strict";
import { readResolvedSubscriptionUsage, readSubscriptionUsage } from "../lib/usage.js";
import { registerClaudeRpc } from "../lib/rpc.js";
const access = "sk-ant-oat01-offline-only";

test("quota resolves refreshed auth before sending request; redirects forbidden", async () => {
	const events = [];
	const result = await readResolvedSubscriptionUsage(async () => {
		events.push("refresh"); return { auth: { apiKey: access } };
	}, undefined, async (url, init) => {
		events.push("request");
		assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
		assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${access}`);
		assert.equal(init.redirect, "error");
		return Response.json({ five_hour: { utilization: 25 } });
	});
	assert.deepEqual(events, ["refresh", "request"]);
	assert.equal(result.five_hour.utilization, 25);
});

test("quota response errors do not expose body and invalid JSON is sanitized", async () => {
	await assert.rejects(readSubscriptionUsage({ access }, undefined, async () => new Response("private sk-ant-oat01-secret", { status: 401 })), (e) => /401/.test(e.message) && !e.message.includes("secret"));
	await assert.rejects(readSubscriptionUsage({ access }, undefined, async () => new Response("private sk-ant-oat01-secret")), (e) => /JSON/.test(e.message) && !e.message.includes("secret"));
});

test("quota timeouts and cancellation settle even if fetch ignores signal", async () => {
	const keepAlive = setTimeout(() => {}, 1000);
	try {
		await assert.rejects(readSubscriptionUsage({ access }, undefined, () => new Promise(() => {}), { timeoutMs: 10 }), { name: "TimeoutError" });
		const controller = new AbortController();
		const pending = readSubscriptionUsage({ access }, undefined, () => new Promise(() => {}), { signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
	} finally { clearTimeout(keepAlive); }
});

test("cancelled quota never resolves auth or launches fetch", async () => {
	let calls = 0;
	await assert.rejects(readResolvedSubscriptionUsage(async () => { calls++; }, undefined, async () => { calls++; }, { signal: AbortSignal.abort() }));
	assert.equal(calls, 0);
});

function fixture(handler) {
	const routes = new Map();
	const dispose = registerClaudeRpc({ fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } }, handler);
	return { routes, dispose, invoke(endpoint, payload = {}, headers = {}, method) {
		const route = routes.get(`/api/claude-subscription/${endpoint}`);
		return route.fetch(new Request(`http://localhost/api/claude-subscription/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ rpcId: "offline", method: method ?? `claude-subscription/${endpoint}`, payload }) }));
	} };
}

test("RPC exposes cancellation and passes request signal, unknown exceptions are sanitized", async () => {
	let seen;
	const f = fixture(async (endpoint, _payload, options) => {
		seen = options.signal;
		if (endpoint === "status") throw Error("upstream body contains sk-ant-oat01-private");
		return { cancelled: true };
	});
	const response = await f.invoke("login/cancel");
	assert.equal((await response.json()).result.value.cancelled, true);
	assert.ok(seen instanceof AbortSignal);
	const error = JSON.stringify(await (await f.invoke("status")).json());
	assert.ok(!error.includes("private"));
	f.dispose();
	assert.equal(f.routes.size, 0);
});

test("RPC failure envelope carries an object details field the host client requires", async () => {
	const f = fixture(async () => { throw new Error("boom"); });
	const body = await (await f.invoke("status")).json();
	assert.equal(body.result.ok, false);
	assert.equal(typeof body.result.error.code, "string");
	assert.equal(typeof body.result.error.message, "string");
	// 宿主客户端 parseConnectionResponse 要求 details 是对象，缺了会抛
	// "connection: invalid server-response failure"，把原因吞掉。
	assert.equal(typeof body.result.error.details, "object");
	assert.notEqual(body.result.error.details, null);
	f.dispose();
});

test("RPC rejects malformed payloads, oversized requests and wrong envelope before handler", async () => {
	let calls = 0;
	const f = fixture(async () => { calls++; });
	assert.equal((await f.invoke("login/submit", { code: 123 })).status, 400);
	assert.equal((await f.invoke("login/submit", { code: "a".repeat(65537) })).status, 413);
	assert.equal((await f.invoke("status", {}, {}, "wrong")).status, 400);
	assert.equal((await f.invoke("status", [])).status, 400);
	assert.equal((await f.invoke("status", {}, { "content-type": "text/plain" })).status, 415);
	assert.equal(calls, 0);
});
