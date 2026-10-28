import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSubscriptionProvider, CLAUDE_CODE_IDENTITY } from "../lib/fingerprint.js";
import { materializeContext } from "../lib/context.js";
import { mapCatalog } from "../lib/catalog.js";

// Only this explicit fake credential is used; no account store/auth resolution is invoked.
const TOKEN = "sk-ant-oat01-offline-only";
const TOOL = { name: "offline_echo", description: "Echo a test value", parameters: {
  type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
} };
const context = () => ({ systemPrompt: "Offline system prompt", tools: [structuredClone(TOOL)], messages: [
  { role: "user", content: [{ type: "text", text: "Echo offline" }], timestamp: 1 },
] });

function sse(model, { tool = false, name = TOOL.name } = {}) {
  const events = [
    { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: "toolu_offline", name, input: {} }
      : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: '{"value":"offline"}' }
      : { type: "text_delta", text: "Offline complete" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  const data = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  // Real Response/ReadableStream, with fragmented SSE bytes (not synthetic pi-ai events).
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 23) controller.enqueue(bytes.slice(i, i + 23));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream", "request-id": "req_offline" } });
}

function transport(responder) {
  const requests = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text());
    requests.push({ url: request.url, headers: new Headers(request.headers), body });
    return responder(body, requests.length);
  };
  return { fetch, requests };
}
async function collect(open) {
  const events = [];
  try {
    for await (const event of open()) events.push(structuredClone(event));
  } catch (error) {
    return { events, thrown: error };
  }
  const terminal = events.findLast(event => event.type === "done" || event.type === "error");
  return { events, terminal, message: terminal?.message ?? terminal?.error };
}
function success(result) {
  assert.equal(result.thrown, undefined, result.thrown?.stack);
  assert.equal(result.terminal?.type, "done", JSON.stringify(result.message));
  return result.message;
}
function failure(result) {
  assert.ok(result.thrown || result.terminal?.type === "error", "must surface an error, not successful body text");
  assert.equal(result.events.filter(e => e.type === "text_delta").map(e => e.delta).join(""), "");
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

let sdk;
let sdkError;
try {
  sdk = await import(process.env.PI_AI_PACKAGE_ROOT
    ? pathToFileURL(path.join(process.env.PI_AI_PACKAGE_ROOT, "dist/providers/anthropic.js")).href
    : "@earendil-works/pi-ai/providers/anthropic");
} catch (error) { sdkError = error; }

test("real pi-ai SDK → subscription wrapper → offline fetch", { timeout: 30000 }, async t => {
  if (sdkError) {
    if (process.env.PI_AI_PACKAGE_ROOT) throw sdkError; // Explicit root means required, never silently skip.
    t.skip(`pi-ai dependency unavailable; set PI_AI_PACKAGE_ROOT to require this suite: ${sdkError.message}`);
    return;
  }
  const oldHome = process.env.DSH_HOME;
  const home = await mkdtemp(path.join(tmpdir(), "subscription-transport-"));
  process.env.DSH_HOME = home; // Existing diagnostic trace stays inside the disposable test directory.
  const originalFetch = globalThis.fetch;
  let escapedFetch = 0;
  globalThis.fetch = async () => { escapedFetch++; throw new Error("Unexpected global fetch: offline tests forbid network"); };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
    assert.equal(escapedFetch, 0, "all SDK HTTP requests must use the supplied fake fetch");
  });
  const base = sdk.anthropicProvider();
  const provider = createSubscriptionProvider(base, () => ({}));
  const models = provider.getModels();
  const model = models.find(m => m.id === "claude-sonnet-4-6") ?? models.find(m => m.api === "anthropic-messages");
  assert.ok(model, "SDK must supply an Anthropic chat model");
  t.diagnostic(`real SDK model: ${model.id}; PI_AI_PACKAGE_ROOT=${process.env.PI_AI_PACKAGE_ROOT ? "explicit" : "normal import"}`);
  const options = fake => ({ apiKey: TOKEN, fetch: fake.fetch, maxTokens: 128, maxRetries: 0, cacheRetention: "none" });

  await t.test("materializeContext merges initial system and tools immutably and idempotently", () => {
    const input = context();
    input.messages.unshift({ role: "system", content: [{ type: "text", text: "Existing system" }], timestamp: 0 });
    const before = structuredClone(input);
    freeze(input);
    const next = materializeContext(input);
    assert.deepEqual(input, before);
    assert.notEqual(next, input);
    assert.deepEqual(next.messages[0].content.map(b => b.text), ["Offline system prompt", "Existing system"]);
    assert.deepEqual(next.messages[0].toolsAdded, [TOOL]);
    assert.deepEqual(materializeContext(next), next);
  });

  for (const method of ["stream", "streamSimple"]) {
    await t.test(`${method}: real final system/tools, Bearer only, immutable context`, async () => {
      const input = context();
      const before = structuredClone(input);
      freeze(input);
      const fake = transport(body => sse(body.model));
      const result = await collect(() => provider[method](model, input, { ...options(fake), headers: { "x-api-key": "offline-residual-key", Authorization: "Bearer offline-unrelated-credential" } }));
      assert.deepEqual(input, before);
      success(result);
      assert.equal(fake.requests.length, 1);
      const { headers, body, url } = fake.requests[0];
      assert.equal(new URL(url).origin, "https://api.anthropic.com");
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(headers.has("x-api-key"), false);
      assert.equal(body.system[0].text, CLAUDE_CODE_IDENTITY);
      assert.ok(body.system.some(b => b.text.includes("Offline system prompt")));
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].name, TOOL.name);
      // The SDK deliberately normalizes JSON schema (e.g. drops additionalProperties).
      assert.equal(body.tools[0].input_schema.type, TOOL.parameters.type);
      assert.deepEqual(body.tools[0].input_schema.properties, TOOL.parameters.properties);
      assert.deepEqual(body.tools[0].input_schema.required, TOOL.parameters.required);
      assert.equal(JSON.stringify(body).includes("__pi_deferred_placeholder__"), false);
      assert.deepEqual(body.messages.map(m => m.role), ["user"]);
    });
  }

  await t.test("onPayload rewrite restores exactly one identity, including in-place edits", async () => {
    for (const inPlace of [false, true]) {
      const fake = transport(body => sse(body.model));
      let hooks = 0;
      success(await collect(() => provider.stream(model, context(), { ...options(fake), onPayload(payload, hookModel) {
        hooks++;
        assert.equal(hookModel.id, model.id);
        assert.equal(payload.system[0].text, CLAUDE_CODE_IDENTITY);
        const rewritten = { ...payload, system: [{ type: "text", text: "Downstream rewrite" }] };
        if (inPlace) { payload.system = rewritten.system; return undefined; }
        return rewritten;
      } })));
      assert.equal(hooks, 1);
      const system = fake.requests[0].body.system;
      assert.equal(system.filter(b => b.text === CLAUDE_CODE_IDENTITY).length, 1);
      assert.equal(system[0].text, CLAUDE_CODE_IDENTITY);
      assert.equal(system[1].text, "Downstream rewrite");
    }
  });

  await t.test("identity remains idempotent when onPayload returns its input", async () => {
    const fake = transport(body => sse(body.model));
    success(await collect(() => provider.stream(model, context(), { ...options(fake), onPayload: payload => payload })));
    assert.equal(fake.requests[0].body.system.filter(b => b.text === CLAUDE_CODE_IDENTITY).length, 1);
  });

  await t.test("native SDK toolcall → toolResult → followup round trip", async () => {
    const fake = transport((body, turn) => sse(body.model, { tool: turn === 1, name: body.tools[0].name }));
    const input = context();
    const first = await collect(() => provider.stream(model, input, options(fake)));
    const assistant = success(first);
    const call = first.events.find(e => e.type === "toolcall_end")?.toolCall;
    assert.ok(call, "real SDK must emit toolcall_end.toolCall");
    assert.equal(call.name, TOOL.name);
    assert.deepEqual(call.arguments, { value: "offline" });
    assert.equal(assistant.stopReason, "toolUse");
    const followup = { ...input, messages: [...input.messages, assistant, { role: "toolResult", toolCallId: call.id,
      toolName: call.name, content: [{ type: "text", text: "echo: offline" }], isError: false, timestamp: 2 }] };
    const before = structuredClone(followup);
    freeze(followup);
    const final = success(await collect(() => provider.streamSimple(model, followup, options(fake))));
    assert.deepEqual(followup, before);
    assert.equal(final.stopReason, "stop");
    assert.equal(final.content.filter(b => b.type === "text").map(b => b.text).join(""), "Offline complete");
    assert.equal(fake.requests.length, 2);
    const messages = fake.requests[1].body.messages;
    const toolUse = messages.find(m => m.role === "assistant").content.find(b => b.type === "tool_use");
    const toolResult = messages.flatMap(m => m.content).find(b => b.type === "tool_result");
    assert.equal(toolUse.id, call.id);
    assert.deepEqual(toolUse.input, call.arguments);
    assert.equal(toolResult.tool_use_id, call.id);
    assert.equal(toolResult.is_error, false);
    assert.ok(JSON.stringify(toolResult.content).includes("echo: offline"));
    assert.equal(fake.requests[1].body.tools.length, 1);
  });

  await t.test("pre-aborted request never reaches fake fetch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("offline cancellation"));
    const fake = transport(body => sse(body.model));
    const result = await collect(() => provider.stream(model, context(), { ...options(fake), signal: controller.signal }));
    failure(result);
    assert.equal(fake.requests.length, 0);
  });

  await t.test("HTTP error surfaces as error, never assistant text", async () => {
    const marker = "OFFLINE_HTTP_ERROR_NOT_ASSISTANT_TEXT";
    const fake = transport(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: marker } }),
      { status: 400, headers: { "content-type": "application/json" } }));
    const result = await collect(() => provider.stream(model, context(), options(fake)));
    failure(result);
    assert.equal(fake.requests.length, 1);
    assert.match(String(result.thrown?.message ?? result.message?.errorMessage), /400|OFFLINE_HTTP_ERROR/);
    assert.equal(result.events.some(e => e.type === "text_end" && e.content.includes(marker)), false);
  });

  await t.test("ordinary API key is blocked before transport", async () => {
    const fake = transport(body => sse(body.model));
    const result = await collect(() => provider.stream(model, context(), { ...options(fake), apiKey: "sk-ant-api03-offline-only" }));
    assert.equal(fake.requests.length, 0, "subscription wrapper must reject ordinary API-key credentials before fetch");
    failure(result);
  });

  await t.test("discovered adaptive Claude models retain off:null and never send thinking.type:disabled", async () => {
    const known = base.getModels().find(entry => entry.compat?.forceAdaptiveThinking && entry.thinkingLevelMap?.off === null);
    assert.ok(known, "SDK must supply an adaptive Claude with omitted-thinking semantics");
    const rows = [known.id, "claude-regression-5"].map(id => ({ id, max_input_tokens: 1000000, max_tokens: 128000,
      capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
        effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: true } } } }));
    const discovered = mapCatalog(rows, base.getModels());
    const wrapped = createSubscriptionProvider({ ...base, getModels: () => discovered }, () => ({}));
    for (const entry of wrapped.getModels()) {
      assert.equal(entry.thinkingLevelMap.off, null);
      for (const reasoning of ["off", "low", "high"]) {
        const fake = transport(body => body.thinking?.type === "disabled"
          ? Response.json({ error: { type: "invalid_request_error", message: "thinking.type.disabled is not supported" } }, { status: 400 })
          : sse(body.model));
        success(await collect(() => wrapped.streamSimple(entry, context(), { ...options(fake), reasoning })));
        assert.notEqual(fake.requests[0].body.thinking?.type, "disabled");
      }
    }
  });

  await t.test("subscription credential is blocked for nonofficial endpoint before transport", async () => {
    for (const baseUrl of ["https://offline.invalid", "https://api.anthropic.com.offline.invalid", "http://api.anthropic.com"]) {
      const fake = transport(body => sse(body.model));
      const result = await collect(() => provider.stream({ ...model, baseUrl }, context(), options(fake)));
      assert.equal(fake.requests.length, 0, `must not forward subscription credential to ${baseUrl}`);
      failure(result);
    }
  });
});
