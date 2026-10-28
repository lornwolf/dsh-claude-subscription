// Run with: node --loader ./test/host-loader.mjs ./test/plugin-smoke.mjs
// DSH_TEST_HOST_ROOT must point at a disposable/read-only installed DSH package root.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
const previousHome = process.env.DSH_HOME;
const testHome = fs.mkdtempSync(path.join(tmpdir(), "claude-plugin-smoke-"));
process.env.DSH_HOME = testHome;
const pluginRoot = process.env.DSH_TEST_PLUGIN_ROOT
	? pathToFileURL(path.resolve(process.env.DSH_TEST_PLUGIN_ROOT) + path.sep)
	: new URL("../", import.meta.url);
const { apply, PLUGIN_VERSION } = await import(new URL("lib/index.js", pluginRoot));
assert.equal(PLUGIN_VERSION, JSON.parse(fs.readFileSync(new URL("package.json", pluginRoot))).version);
const previous = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Smoke test forbids network"); };
try {
	const tools = new Map();
	const routes = new Map();
	let adapter;
	let memory;
	let gate;
	let writes = 0;
	apply({
		credentials: {
			async resolve() { if (gate) { gate.enter(); await gate.promise; } return memory === undefined ? undefined : { value: memory }; },
			async set(_ref, value) { writes++; memory = value; },
			async unset() { writes++; memory = undefined; }
		},
		tools: { register(tool) { tools.set(tool.name, tool); } },
		llm: { registerAdapter(providers, value) { assert.deepEqual(providers, ["anthropic"]); adapter = value; }, emitAdaptersUpdated() {} },
		inject(_dependencies, callback) { callback({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } }, effect(effect) { effect(); } }); },
		logger: { info() {} }
	}, { diagnostics: false, catalogRefresh: false });
	assert.ok(adapter);
	assert.equal(tools.size, 7);
	assert.equal(routes.size, 10);
	const route = routes.get("/api/claude-subscription/status");
	const result = await route.fetch(new Request("http://localhost/api/claude-subscription/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rpcId: "offline", method: "claude-subscription/status", payload: {} }) }));
	const status = await result.json();
	assert.equal(status.result.ok, true, JSON.stringify(status));
	assert.equal(status.result.value.signedIn, false);
	assert.ok(status.result.value.models.length > 0);
	assert.deepEqual(status.result.value.accounts, []);
	assert.equal(status.result.value.pluginVersion, PLUGIN_VERSION);
	const account = (id) => ({ id, label: id, addedAt: new Date().toISOString(), credential: { type: "oauth", access: id === "a" ? "sk-ant-oat01-offline" : "sk-ant-oat01-offline-b", refresh: "sk-ant-ort01-offline", expires: Date.now() + 3600_000 } });
	memory = JSON.stringify({ version: 1, activeId: "a", accounts: [account("a"), account("b")] });
	// 设置页额度 RPC：必须带 accountId（面板按它判断归属），且不回传上游原始 payload。
	const usageBody = { five_hour: { utilization: 35, resets_at: "2026-10-24T06:20:00Z" }, seven_day: { utilization: 1, resets_at: "2026-10-31T05:00:00Z" } };
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
		assert.equal(new Headers(init.headers).get("authorization"), "Bearer sk-ant-oat01-offline");
		return Response.json(usageBody);
	};
	const quotaResult = (await (await routes.get("/api/claude-subscription/quota").fetch(new Request("http://localhost/api/claude-subscription/quota", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ rpcId: "offline", method: "claude-subscription/quota", payload: {} })
	}))).json()).result;
	assert.equal(quotaResult.ok, true);
	assert.equal(quotaResult.value.accountId, "a");
	assert.deepEqual(quotaResult.value.windows.map((entry) => entry.window), ["five_hour", "seven_day"]);
	assert.equal(quotaResult.value.windows[0].remainingPercent, 65);
	assert.equal(quotaResult.value.raw, undefined);
	globalThis.fetch = async () => { throw new Error("Smoke test forbids network"); };
	for (const mode of ["rpc", "tool"]) {
		let enter, release;
		const entered = new Promise((resolve) => { enter = resolve; });
		gate = { enter, promise: new Promise((resolve) => { release = resolve; }) };
		const controller = new AbortController();
		const run = mode === "rpc"
			? routes.get("/api/claude-subscription/accounts/select").fetch(new Request("http://localhost/api/claude-subscription/accounts/select", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ rpcId: "offline", method: "claude-subscription/accounts/select", payload: { id: "b" } }) }))
			: tools.get("claude_subscription_account_select").execute({ id: "b" }, { signal: controller.signal });
		const observed = run.then(async (result) => mode === "rpc" ? (await result.json()).result.ok : true, () => false);
		await entered;
		controller.abort();
		release();
		assert.equal(await observed, false);
		assert.equal(JSON.parse(memory).activeId, "a");
		assert.equal(writes, 0);
		gate = undefined;
	}
	const invoke = async (endpoint, payload = {}) => {
		const result = await (await routes.get(`/api/claude-subscription/${endpoint}`).fetch(new Request(`http://localhost/api/claude-subscription/${endpoint}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rpcId: "offline", method: `claude-subscription/${endpoint}`, payload })
		}))).json();
		assert.equal(result.result.ok, true, JSON.stringify(result)); return result.result.value;
	};
	// Online discovery overlays a model absent from the SDK catalog; real PiAiAdapter sends it over an offline SSE transport.
	const modelId = "claude-offline-6";
	const requests = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.startsWith("https://api.anthropic.com/v1/models")) return Response.json({ data: [{ id: modelId, display_name: "Offline Claude", max_input_tokens: 9000, max_tokens: 1234, capabilities: { thinking: { supported: false } } }] });
		if (url === "https://api.anthropic.com/api/oauth/usage") return Response.json({ limits: [{ kind: "session", percent: 25 }] });
		assert.ok(url.startsWith("https://api.anthropic.com/v1/messages"), url);
		const authorization = new Headers(init.headers).get("authorization");
		const body = JSON.parse(init.body); requests.push({ authorization, body });
		if (authorization === "Bearer sk-ant-oat01-offline") return Response.json({ error: { type: "rate_limit_error", message: "offline quota limit" } }, { status: 429, headers: { "retry-after": "0" } });
		const events = [
			["message_start", { message: { id: "msg_offline", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
			["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
			["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Offline account B" } }],
			["content_block_stop", { index: 0 }],
			["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
			["message_stop", {}]
		];
		return new Response(events.map(([type, fields]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
	const discovered = await invoke("models/refresh");
	assert.equal(discovered.models[0].id, modelId);
	const resolvedModel = await adapter.resolveModel("anthropic", modelId);
	assert.equal(resolvedModel.context.contextWindow, 9000);
	assert.equal((await invoke("routing/set", { mode: "priority" })).mode, "priority");
	const prepared = await adapter.prepareCall("anthropic", modelId);
	const chunks = [];
	for await (const chunk of prepared.stream({ provider: "anthropic", model: modelId, sessionId: "offline-session", system: "Offline system", messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })) chunks.push(chunk);
	assert.ok(requests.some(request => request.authorization === "Bearer sk-ant-oat01-offline"));
	assert.equal(requests.at(-1).authorization, "Bearer sk-ant-oat01-offline-b");
	assert.equal(requests.at(-1).body.model, modelId);
	assert.equal(requests.at(-1).body.max_tokens, 1234);
	assert.equal(chunks.at(-1).type, "finish");
	assert.equal(chunks.at(-1).replayState.response.kind, "claude-subscription-account");
	assert.equal(JSON.parse(memory).activeId, "a");
	const actualUsage = await invoke("quota", { sessionId: "offline-session", model: modelId });
	assert.equal(actualUsage.accountId, "b"); assert.equal(actualUsage.defaultAccount, false);
	assert.equal(actualUsage.windows[0].remainingPercent, 75);
	console.log(JSON.stringify({ pluginSmoke: "PASS", version: PLUGIN_VERSION, tools: tools.size, routes: routes.size, models: status.result.value.models.length, queuedCancellation: "RPC+tool PASS" }));
} finally {
	globalThis.fetch = previous;
	if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
	fs.rmSync(testHome, { recursive: true, force: true });
}
