import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { getEventListeners } from "node:events";
import { createSubscriptionOAuth } from "../lib/oauth.js";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const tokens = (extra = {}) => ({ access_token: "sk-ant-oat01-access_test", refresh_token: "sk-ant-ort01-refresh_test", expires_in: 3600, token_type: "Bearer", scope: "user:profile user:inference", ...extra });
const response = (data = tokens()) => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const forever = () => new Promise(() => {});
const old = { type: "oauth", access: "sk-ant-oat01-old", refresh: "sk-ant-ort01-old", expires: 1, metadata: { account: "offline" }, custom: 42 };

function copyInteraction(input = (state) => `offline-code#${state}`, signal) {
  let auth;
  return {
    signal,
    get auth() { return auth; },
    notify(event) { if (event.type === "auth_url") auth = new URL(event.url); },
    prompt(prompt) {
      if (prompt.type === "select") return "copy_code";
      return input(auth.searchParams.get("state"), auth);
    },
  };
}
async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server.address().port;
}
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
async function free(port) {
  const server = createServer();
  await listen(server, port);
  await close(server);
}
function local(url, method = "GET") {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: parsed.port, path: parsed.pathname + parsed.search, method, agent: false }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject); req.end();
  });
}
function browserInteraction(controller, manual = forever) {
  const ready = deferred();
  let manualSignal;
  return {
    signal: controller?.signal,
    ready: ready.promise,
    get manualSignal() { return manualSignal; },
    notify(event) { if (event.type === "auth_url") ready.resolve(new URL(event.url)); },
    prompt(prompt) {
      if (prompt.type === "select") return "browser";
      manualSignal = prompt.signal;
      return manual(prompt);
    },
  };
}

 test("copy_code PKCE, independent random state, official URI and seam", async () => {
  const captured = [];
  const oauth = createSubscriptionOAuth(async (url, init) => { captured.push({ url, init, body: JSON.parse(init.body) }); return response(); });
  assert.equal(oauth.name, "Anthropic (Claude Pro/Max)");
  assert.equal(oauth.isSubscription, true);
  for (let i = 0; i < 2; i++) {
    const interaction = copyInteraction();
    const before = Date.now();
    const credential = await oauth.login(interaction);
    const { body, init, url } = captured.at(-1);
    assert.equal(url, TOKEN_URL);
    assert.equal(init.redirect, "error");
    assert.equal(body.redirect_uri, "https://platform.claude.com/oauth/code/callback");
    assert.equal(body.state, interaction.auth.searchParams.get("state"));
    assert.notEqual(body.state, body.code_verifier);
    assert.equal(interaction.auth.searchParams.get("code_challenge"), createHash("sha256").update(body.code_verifier).digest("base64url"));
    assert.equal(interaction.auth.searchParams.get("code_challenge_method"), "S256");
    assert.ok(credential.expires >= before + 3300000 && credential.expires <= Date.now() + 3300000);
    assert.deepEqual(await oauth.toAuth(credential), { apiKey: tokens().access_token });
  }
  assert.notEqual(captured[0].body.state, captured[1].body.state);
  assert.notEqual(captured[0].body.code_verifier, captured[1].body.code_verifier);
});

test("structured manual responses require unique matching state/code and reject error; zero exchanges", async () => {
  const invalid = [
    () => "x#wrong", () => "x#", () => "x#state#extra", () => "",
    () => "https://localhost/callback?code=x", (s) => `?code=x&state=${s}&state=${s}`,
    (s) => `code=x&code=y&state=${s}`, (s) => `code=x&state=${s}&error=denied`,
    (s) => `https://localhost/callback?code=x&state=${s}&error=`,
    (s) => `https://localhost/callback?code=x&state=${s}#ignored`,
    (s) => `state=${s}`, () => "code=x&state=bad", () => "error=denied",
  ];
  let calls = 0;
  const oauth = createSubscriptionOAuth(async () => { calls++; return response(); });
  for (const input of invalid) await assert.rejects(oauth.login(copyInteraction(input)));
  assert.equal(calls, 0);
});

test("valid URL/query and deliberate legacy bare-code compatibility", async () => {
  const inputs = [(s) => `https://platform.claude.com/oauth/code/callback?code=abc&state=${s}`,
    (s) => `?code=abc&state=${s}`, (s) => `code=abc&state=${s}`, () => "legacy-bare-code"];
  let calls = 0;
  const oauth = createSubscriptionOAuth(async () => { calls++; return response(); });
  for (const input of inputs) await oauth.login(copyInteraction(input));
  assert.equal(calls, inputs.length);
});

test("refresh preserves omitted refresh_token and credential extension metadata", async () => {
  let body;
  const data = tokens(); delete data.refresh_token;
  const result = await createSubscriptionOAuth(async (_url, init) => { body = JSON.parse(init.body); return response(data); }).refresh(old);
  assert.equal(result.refresh, old.refresh);
  assert.equal(result.metadata, old.metadata);
  assert.equal(result.custom, 42);
  assert.equal(result.access, tokens().access_token);
  assert.equal(old.access, "sk-ant-oat01-old");
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, old.refresh);
});

test("token response validation and redaction", async () => {
  const invalid = [null, [], tokens({ access_token: "sk-api-secret" }), tokens({ refresh_token: "bad" }),
    tokens({ access_token: "sk-ant-oat01-" }), tokens({ expires_in: "3600" }), tokens({ expires_in: 0 }),
    tokens({ expires_in: Infinity }), tokens({ expires_in: 1e99 }), tokens({ token_type: "Basic" }),
    tokens({ token_type: undefined }), tokens({ scope: "user:profile" }), tokens({ scope: ["user:inference"] }),
    tokens({ refresh_token: null })];
  for (const data of invalid) {
    await assert.rejects(createSubscriptionOAuth(async () => response(data)).refresh(old), (error) => {
      assert.equal(error.message, "Invalid OAuth token response");
      assert.doesNotMatch(error.message, /secret|sk-ant|stack/i); return true;
    });
  }
  await createSubscriptionOAuth(async () => response(tokens({ scope: undefined }))).refresh(old);
});

test("HTTP, malformed JSON and thrown errors never reflect body/token/foreign stack", async () => {
  const secret = "sk-ant-oat01-DO_NOT_EXPOSE FOREIGN_STACK";
  const mocks = [
    async () => { throw new Error(secret); },
    async () => ({ ok: false, status: 401, text: async () => secret }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(secret); } }),
  ];
  for (const mock of mocks) await assert.rejects(createSubscriptionOAuth(mock).refresh(old), (error) => {
    assert.doesNotMatch(error.message, /DO_NOT_EXPOSE|FOREIGN_STACK|sk-ant/);
    assert.equal(error.cause, undefined); return true;
  });
});

test("redirect:error is mandatory and redirected/3xx mock responses are rejected", async () => {
  for (const result of [{ ...response(), status: 302 }, { ...response(), redirected: true }]) {
    let seen;
    await assert.rejects(createSubscriptionOAuth(async (_url, init) => { seen = init; return result; }).refresh(old));
    assert.equal(seen.redirect, "error");
  }
});

test("caller cancellation and 30s configurable deadline defeat signal-ignoring fetch/body", async () => {
  for (const mock of [forever, async () => ({ ...response(), json: forever })]) {
    const controller = new AbortController();
    const entered = deferred();
    let receivedSignal;
    const oauth = createSubscriptionOAuth(async (...args) => { receivedSignal = args[1].signal; entered.resolve(); return mock(); }, { timeoutMs: 50 });
    const pending = oauth.refresh(old, controller.signal);
    await entered.promise;
    controller.abort("SECRET_REASON");
    await assert.rejects(pending, /cancelled/);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  await assert.rejects(createSubscriptionOAuth(forever, { timeoutMs: 20 }).refresh(old), /cancelled/);
});

test("pre-aborted calls and signal-ignoring select/manual UI stop promptly", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(createSubscriptionOAuth(async () => { calls++; }).refresh(old, controller.signal));
  await assert.rejects(createSubscriptionOAuth().login({ signal: controller.signal, prompt: () => { calls++; } }));
  assert.equal(calls, 0);
  for (const type of ["select", "manual_code"]) {
    const c = new AbortController(); const entered = deferred();
    const interaction = copyInteraction(() => { entered.resolve(); return forever(); }, c.signal);
    if (type === "select") interaction.prompt = () => { entered.resolve(); return forever(); };
    const pending = createSubscriptionOAuth().login(interaction);
    await entered.promise; c.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(getEventListeners(c.signal, "abort").length, 0);
  }
});

test("browser validates method/path/unique code/state then callback beats ignored UI; listener closes", async () => {
  let exchanges = 0;
  const controller = new AbortController();
  const interaction = browserInteraction(controller);
  const pending = createSubscriptionOAuth(async () => { exchanges++; return response(); }, { callbackPort: 0 }).login(interaction);
  const auth = await interaction.ready;
  const redirect = auth.searchParams.get("redirect_uri");
  const state = auth.searchParams.get("state");
  const port = Number(new URL(redirect).port);
  for (const [suffix, method, status] of [
    [`?code=x&state=${state}`, "POST", 404], [`/wrong?code=x&state=${state}`, "GET", 404],
    ["?code=x", "GET", 400], ["?code=x&state=bad", "GET", 400],
    [`?code=x&state=${state}&state=${state}`, "GET", 400],
    [`?code=x&code=y&state=${state}`, "GET", 400],
    [`?code=x&state=${state}&error=denied`, "GET", 400],
  ]) assert.equal(await local(redirect + suffix, method), status);
  assert.equal(exchanges, 0);
  assert.equal(await local(`${redirect}?code=callback-code&state=${state}`), 200);
  await pending;
  assert.equal(exchanges, 1);
  assert.equal(interaction.manualSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await free(port);
});

test("browser manual wins and releases listener even while token exchange ignores signal", async () => {
  const controller = new AbortController(); const manual = deferred(); const exchange = deferred();
  const interaction = browserInteraction(controller, () => manual.promise);
  const pending = createSubscriptionOAuth(async () => { exchange.resolve(); return forever(); }, { callbackPort: 0 }).login(interaction);
  const auth = await interaction.ready;
  manual.resolve(`manual-code#${auth.searchParams.get("state")}`);
  await exchange.promise;
  await free(Number(new URL(auth.searchParams.get("redirect_uri")).port));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("browser cancellation closes listener promptly despite ignored manual UI", async () => {
  const controller = new AbortController(); const interaction = browserInteraction(controller);
  const pending = createSubscriptionOAuth(async () => { throw new Error("unexpected"); }, { callbackPort: 0 }).login(interaction);
  const auth = await interaction.ready;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await free(Number(new URL(auth.searchParams.get("redirect_uri")).port));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("occupied preferred callback port falls back to random loopback port", async () => {
  const occupied = createServer(); const port = await listen(occupied);
  const controller = new AbortController(); const interaction = browserInteraction(controller);
  const pending = createSubscriptionOAuth(undefined, { callbackPort: port }).login(interaction);
  try {
    const auth = await interaction.ready;
    const redirect = new URL(auth.searchParams.get("redirect_uri"));
    assert.equal(redirect.hostname, "localhost");
    assert.notEqual(Number(redirect.port), port);
    controller.abort(); await assert.rejects(pending, /cancelled/);
    await free(Number(redirect.port));
    assert.equal(occupied.listening, true);
  } finally { controller.abort(); await close(occupied); }
});
