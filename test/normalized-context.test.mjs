import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSubscriptionProvider } from "../lib/fingerprint.js";
import { sanitizeContextForModel } from "../lib/persona.js";

const TOKEN = "sk-ant-oat01-offline-normalized";
const TOOL = { name: "offline_echo", description: "Offline echo", parameters: {
  type: "object", properties: { value: { type: "string" } }, required: ["value"],
} };
const MODERN = { id: "claude-fable-5-1" };
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const inputContext = () => ({ systemPrompt: "ORIGINAL_PRIVATE_PROMPT", tools: [structuredClone(TOOL)], messages: [
  { role: "user", content: [{ type: "text", text: "Echo offline" }], timestamp: 1 },
] });
function response(model, native = false, xml = false) {
  const events = [
    { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: native
      ? { type: "tool_use", id: "toolu_native", name: TOOL.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: native
      ? { type: "input_json_delta", partial_json: '{"value":"offline"}' }
      : { type: "text_delta", text: xml
        ? '<invoke name="offline_echo"><parameter name="value">offline</parameter></invoke>' : "Offline complete" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: native ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
async function complete(stream) {
  let terminal;
  for await (const event of stream) if (event.type === "done" || event.type === "error") terminal = event;
  assert.equal(terminal?.type, "done", JSON.stringify(terminal));
  return terminal.message;
}
let sdk, sdkError;
try {
  const root = process.env.PI_AI_PACKAGE_ROOT;
  const load = (file, specifier) => import(root ? pathToFileURL(path.join(root, "dist", file)).href : specifier);
  const [core, anthropic] = await Promise.all([
    load("models.js", "@earendil-works/pi-ai"),
    load("providers/anthropic.js", "@earendil-works/pi-ai/providers/anthropic"),
  ]);
  sdk = { createModels: core.createModels, anthropicProvider: anthropic.anthropicProvider };
} catch (error) { sdkError = error; }

test("Models.streamSimple normalization → default minimal wrapper → offline wire payload", { timeout: 30000 }, async t => {
  if (sdkError) {
    if (process.env.PI_AI_PACKAGE_ROOT) throw sdkError;
    t.skip(`Set PI_AI_PACKAGE_ROOT to require real SDK tests: ${sdkError.message}`);
    return;
  }
  const oldHome = process.env.DSH_HOME;
  const home = await mkdtemp(path.join(tmpdir(), "subscription-normalized-"));
  process.env.DSH_HOME = home;
  const originalFetch = globalThis.fetch;
  let escaped = 0;
  globalThis.fetch = async () => { escaped++; throw Error("External network forbidden by offline test"); };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
    assert.equal(escaped, 0);
  });
  const injectFile = path.join(home, "prompt-inject.md");
  await writeFile(injectFile, "SYNTHETIC_INJECTION", "utf8");
  function setup(mode = "minimal") {
    const provider = createSubscriptionProvider(sdk.anthropicProvider(), () => ({}), () => ({ mode, file: injectFile }));
    const models = sdk.createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(provider);
    const model = models.getModel("anthropic", MODERN.id);
    assert.ok(model, "SDK must contain Fable 5.1; this regression must not fall back to an older model");
    return { models, model };
  }
  async function run(route, context, responseOptions = {}) {
    const before = structuredClone(context);
    freeze(context);
    const requests = [];
    const fetch = async (url, init) => {
      assert.equal(new URL(String(url)).origin, "https://api.anthropic.com");
      const body = JSON.parse(init.body);
      requests.push(body);
      return response(body.model, responseOptions.native, responseOptions.xml);
    };
    const message = await complete(route.models.streamSimple(route.model, context, {
      apiKey: TOKEN, fetch, maxTokens: 128, maxRetries: 0, cacheRetention: "none",
    }));
    assert.deepEqual(context, before, "normalization, persona and replay must preserve frozen caller input");
    assert.equal(requests.length, 1, "no hidden empty-response retry");
    return { message, body: requests[0] };
  }
  const route = setup();
  await t.test("first request preserves normalized tool table while replacing original prompt", async () => {
    const { body } = await run(route, inputContext());
    assert.deepEqual(body.tools.map(t => t.name), [TOOL.name]);
    assert.equal(JSON.stringify(body.system).includes("ORIGINAL_PRIVATE_PROMPT"), false);
    assert.ok(JSON.stringify(body.system).includes("DeepSeek Harness"));
  });
  for (const kind of ["native", "xml"]) await t.test(`${kind} tool call and result replay keeps tools and drops thinking signatures`, async () => {
    const first = await run(route, inputContext(), { [kind]: true });
    const call = first.message.content.find(b => b.type === "toolCall");
    assert.ok(call, `${kind} response must become a real pi-ai toolCall`);
    assert.match(call.id, kind === "xml" ? /^call_cc_/ : /^toolu_native/);
    const assistant = { ...first.message, content: [
      { type: "thinking", thinking: "signed original", thinkingSignature: "SYNTHETIC_SIGNATURE" },
      { type: "reasoning", text: "Harness-shaped reasoning" },
      ...first.message.content,
    ] };
    const context = inputContext();
    context.messages.push(assistant, { role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "offline result" }], isError: false, timestamp: 2 });
    const { body } = await run(route, context);
    assert.deepEqual(body.tools.map(t => t.name), [TOOL.name]);
    const blocks = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
    assert.ok(blocks.some(b => b.type === "tool_use" && b.id === call.id));
    assert.ok(blocks.some(b => b.type === "tool_result" && b.tool_use_id === call.id));
    assert.equal(blocks.some(b => b.type === "thinking" || b.type === "reasoning"), false);
    assert.equal(JSON.stringify(body).includes("SYNTHETIC_SIGNATURE"), false);
    assert.equal(JSON.stringify(body).includes("Harness-shaped reasoning"), false);
  });
  await t.test("later toolsAdded/toolsRemoved survive minimal replacement and reach resolved wire table", async () => {
    const context = inputContext();
    context.messages.push({ role: "system", content: [{ type: "text", text: "Tool delta" }], timestamp: 2,
      toolsRemoved: [{ name: TOOL.name }], toolsAdded: [{ ...structuredClone(TOOL), name: "offline_second" }] });
    const { body } = await run(route, context);
    assert.deepEqual(body.tools.map(t => t.name), ["offline_second"]);
  });
  await t.test("strip-inject route retains unrelated prompt and normalized tools", async () => {
    const context = inputContext();
    context.systemPrompt = "Keep this prompt";
    const { body } = await run(setup("strip-inject"), context);
    assert.deepEqual(body.tools.map(t => t.name), [TOOL.name]);
    assert.ok(JSON.stringify(body.system).includes("Keep this prompt"));
  });
  await t.test("minimal replaces array-content injection without restoring the old system or losing metadata", () => {
    const head = { role: "system", content: [{ type: "text", text: "SYNTHETIC_INJECTION" }], timestamp: 7,
      toolsAdded: [structuredClone(TOOL)], toolsRemoved: [{ name: "stale" }], sections: { keep: "metadata" } };
    const later = { role: "system", content: [], timestamp: 8, toolsAdded: [{ ...TOOL, name: "later" }] };
    const input = freeze({ messages: [head, later] });
    const before = structuredClone(input);
    const output = sanitizeContextForModel(input, MODERN, { mode: "minimal", file: injectFile });
    assert.deepEqual(input, before);
    assert.equal(output.systemPrompt, undefined);
    assert.deepEqual(output.messages[0].toolsAdded, head.toolsAdded);
    assert.deepEqual(output.messages[0].toolsRemoved, head.toolsRemoved);
    assert.deepEqual(output.messages[0].sections, head.sections);
    assert.equal(output.messages[0].timestamp, 7);
    assert.equal(output.messages[1], later);
    assert.equal(JSON.stringify(output.messages[0].content).includes("SYNTHETIC_INJECTION"), false);
    assert.ok(JSON.stringify(output.messages[0].content).includes("DeepSeek Harness"));
  });
});
