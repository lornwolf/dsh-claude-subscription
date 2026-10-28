import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { operationError } from "./operation.js";
import { normalizeAccountProfile } from "./profile.js";
import { retryAfterMs } from "./cache.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const COPY_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const cancelled = () => operationError("OAuth operation cancelled");

// Race even implementations which ignore AbortSignal; never expose their error details.
function guarded(action, signal, message = "OAuth interaction failed") {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const finish = (value, error) => {
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(undefined, cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw cancelled();
      return action();
    }).then((value) => finish(value), () => finish(undefined,
      signal?.aborted ? cancelled() : operationError(message)));
  });
}

async function operation(signal, timeoutMs, action) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

function structuredCode(params, state) {
  if (params.has("error") || params.getAll("code").length !== 1 ||
      params.getAll("state").length !== 1 || params.get("state") !== state || !params.get("code")?.trim()) {
    throw operationError("Invalid OAuth authorization response");
  }
  return params.get("code");
}

function parseInput(input, state) {
  if (typeof input !== "string" || !input.trim()) throw operationError("Missing OAuth authorization code");
  const value = input.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw operationError("Invalid OAuth authorization response"); }
    if (url.hash) throw operationError("Invalid OAuth authorization response");
    return structuredCode(url.searchParams, state);
  }
  if (value.includes("=") || value.includes("&") || value.startsWith("?")) {
    return structuredCode(new URLSearchParams(value.replace(/^\?/, "")), state);
  }
  if (value.includes("#")) {
    const parts = value.split("#");
    if (parts.length !== 2 || !parts[0] || parts[1] !== state) throw operationError("Invalid OAuth authorization response");
    return parts[0];
  }
  // Legacy bare authorization codes are deliberately supported. Structured input
  // never falls back to this branch when state is absent, duplicated or invalid.
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) throw operationError("Invalid OAuth authorization response");
  return value;
}

function validToken(value, prefix) {
  return typeof value === "string" && value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length));
}

function credentialFrom(data, previous, now) {
  const refresh = data?.refresh_token === undefined ? previous?.refresh : data.refresh_token;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      !validToken(data.access_token, "sk-ant-oat01-") || !validToken(refresh, "sk-ant-ort01-") ||
      typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      !Number.isSafeInteger(Math.ceil(now + data.expires_in * 1000)) ||
      typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer" ||
      (data.scope !== undefined && (typeof data.scope !== "string" || !data.scope.split(/\s+/).includes("user:inference")))) {
    throw operationError("Invalid OAuth token response");
  }
  const profile = normalizeAccountProfile(data, { source: "token", checkedAt: now });
  return { ...previous, type: "oauth", access: data.access_token, refresh,
    expires: now + data.expires_in * 1000,
    ...(profile ? { profile: { ...(previous?.profile ?? {}), ...profile } } : {}) };
}

async function callbackServer(port, state, signal) {
  let resolve;
  let reject;
  let settled = false;
  const result = new Promise((res, rej) => { resolve = res; reject = rej; });
  result.catch(() => {});
  const finish = (value, error) => {
    if (settled) return;
    settled = true;
    if (error) reject(error); else resolve(value);
  };
  const server = createServer((request, response) => {
    let status = 400;
    let code;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== "/callback") status = 404;
      else if (settled) status = 409;
      else {
        code = structuredCode(url.searchParams, state);
        status = 200;
      }
    } catch { /* Return only a constant message, never supplied data. */ }
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" });
    response.end(status === 200 ? "Sign-in received. You may close this page." : "Invalid OAuth callback.");
    if (status === 200) finish(code);
  });
  const close = () => {
    signal.removeEventListener("abort", abort);
    finish(undefined, cancelled());
    return new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  };
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await guarded(() => new Promise((res, rej) => {
      server.once("error", rej);
      server.listen({ port, host: "127.0.0.1", signal }, () => {
        server.off("error", rej);
        res();
      });
    }), signal, "OAuth callback listener failed");
    const address = server.address();
    if (!address || typeof address === "string") throw operationError("OAuth callback listener failed");
    server.on("error", () => finish(undefined, operationError("OAuth callback listener failed")));
    return { result, close, redirectUri: `http://localhost:${address.port}/callback` };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Standalone pi-ai OAuth seam; options only adjust ports and deadlines for tests. */
export function createSubscriptionOAuth(fetchImpl = globalThis.fetch, options = {}) {
  const callbackPort = options.callbackPort ?? 53692;
  const timeoutMs = options.timeoutMs ?? 30_000;
  async function post(body, signal, previous) {
    return operation(signal, timeoutMs, async (requestSignal) => {
      const response = await guarded(() => fetchImpl(TOKEN_URL, {
        method: "POST", redirect: "error", signal: requestSignal,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }), requestSignal, "OAuth token request failed");
      if (!response || response.ok !== true || response.status < 200 || response.status >= 300 || response.redirected) {
        const error = operationError("OAuth token request failed");
        error.status = response?.status;
        if (response?.headers) error.retryAfterMs = retryAfterMs(response.headers);
        void response?.body?.cancel().catch(() => {});
        throw error;
      }
      const data = await guarded(() => response.json(), requestSignal, "Invalid OAuth token response");
      try { return credentialFrom(data, previous, Date.now()); }
      catch { throw operationError("Invalid OAuth token response", "OAUTH_RESPONSE"); }
    });
  }
  return {
    name: "Anthropic (Claude Pro/Max)",
    isSubscription: true,
    async login(interaction) {
      return operation(interaction.signal, options.loginTimeoutMs, async (signal) => {
        let callback;
        const manualAbort = new AbortController();
        const abortManual = () => manualAbort.abort();
        signal.addEventListener("abort", abortManual, { once: true });
        try {
          const method = await guarded(() => interaction.prompt({
            type: "select", message: "Select Anthropic login method:", signal,
            options: [
              { id: "browser", label: "Browser login (default)" },
              { id: "copy_code", label: "Copy code login (headless)" },
            ],
          }), signal);
          if (method !== "browser" && method !== "copy_code") throw operationError("Unknown Anthropic login method");
          const verifier = randomBytes(32).toString("base64url");
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          const state = randomBytes(32).toString("base64url");
          if (method === "browser") {
            try { callback = await callbackServer(callbackPort, state, signal); }
            catch {
              if (signal.aborted) throw cancelled();
              try { callback = await callbackServer(0, state, signal); }
              catch { if (signal.aborted) throw cancelled(); }
            }
          }
          const redirectUri = method === "copy_code" ? COPY_REDIRECT : callback?.redirectUri ?? `http://localhost:${callbackPort}/callback`;
          const params = new URLSearchParams({ code: "true", client_id: CLIENT_ID, response_type: "code",
            redirect_uri: redirectUri, scope: SCOPES, code_challenge: challenge,
            code_challenge_method: "S256", state });
          await guarded(() => interaction.notify({ type: "auth_url", url: `https://claude.ai/oauth/authorize?${params}`,
            instructions: "Complete login in your browser, then paste the authorization code or redirect URL." }), signal);
          const manual = guarded(() => interaction.prompt({ type: "manual_code",
            message: "Paste the authorization code / redirect URL:",
            placeholder: method === "copy_code" ? "code#state" : redirectUri,
            signal: manualAbort.signal,
          }), manualAbort.signal).then((input) => parseInput(input, state));
          const code = await guarded(() => callback ? Promise.race([callback.result, manual]) : manual, signal);
          manualAbort.abort();
          // Release the listener before exchange, including keep-alive sockets.
          if (callback) await callback.close();
          await guarded(() => interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." }), signal);
          return await post({ grant_type: "authorization_code", client_id: CLIENT_ID, code, state,
            redirect_uri: redirectUri, code_verifier: verifier }, signal);
        } finally {
          signal.removeEventListener("abort", abortManual);
          manualAbort.abort();
          if (callback) await callback.close();
        }
      });
    },
    async refresh(credential, signal) {
      if (!validToken(credential?.refresh, "sk-ant-ort01-")) throw operationError("Invalid OAuth refresh credential");
      return post({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credential.refresh }, signal, credential);
    },
    async toAuth(credential) { return { apiKey: credential.access }; },
  };
}
