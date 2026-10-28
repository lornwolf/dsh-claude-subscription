/**
 * 客户端指纹层：让订阅请求在 Anthropic 看来就是 Claude Code 自己的请求。
 *
 * 这一层只做三件事，全部发生在请求离开本机之前：
 *   1. HTTP 头：UA 写成 `claude-cli/<ver> (external, cli)`，`x-app: cli`，
 *      去掉浏览器 SDK 才会带的 `anthropic-dangerous-direct-browser-access`，
 *      补齐 `claude-code-20250219` / `oauth-2025-04-20` 两个 beta。
 *   2. 请求体：`system[0]` 补回 "You are Claude Code, Anthropic's official CLI
 *      for Claude."（部分 pi-ai 版本会把它丢掉，这里在运行期补回，
 *      不依赖宿主文件补丁）。
 *   3. 可选：`metadata.user_id`（Claude Code 会带，默认关闭）。
 *
 * 之所以不复用 pi-ai 的 OAuth 分支：那一支在宿主里是静态文件，升级一次就丢。
 * 放在这里等于每次请求都重新盖一次章。
 */

import { materializeContext } from "./context.js";
import { isModernClaude, sanitizeContextForModel } from "./persona.js";
import { filterInvokeText } from "./text-filter.js";
import { recoverEmptyResponse } from "./empty-response.js";
import { operationError } from "./operation.js";

function requireSubscriptionRequest(url, apiKey) {
	let parsed;
	try { parsed = new URL(url); } catch { throw operationError("Claude 请求地址无效", "SUBSCRIPTION_ENDPOINT"); }
	if (parsed.origin !== "https://api.anthropic.com" || parsed.username || parsed.password) {
		throw operationError("Claude 订阅请求仅发送到官方 API 地址", "SUBSCRIPTION_ENDPOINT");
	}
	if (typeof apiKey !== "string" || !/^sk-ant-oat\d+-[A-Za-z0-9_-]+$/.test(apiKey)) {
		throw operationError("Claude 订阅路由需要 OAuth 凭据", "SUBSCRIPTION_CREDENTIAL");
	}
}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 把一次出站请求/响应记录到本地 trace（失败或异常时才需要回头看）。 */
function trace(entry) {
	try {
		const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : path.join(os.homedir(), ".dsh");
		const dir = path.join(home, "state", "claude-subscription");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "http-trace.jsonl");
		fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
		const size = fs.statSync(file).size;
		if (size > 2 * 1024 * 1024) fs.writeFileSync(file, "", "utf8");
	} catch {
		/* 诊断失败不影响请求 */
	}
}

export const CLAUDE_CODE_VERSION = "2.1.280";

/** Claude Code 的首段系统提示，Anthropic 用它认客户端。 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** 订阅 OAuth 必备的两个 beta；其余 beta 若已在头里则原样保留。 */
export const OAUTH_BETAS = Object.freeze(["claude-code-20250219", "oauth-2025-04-20"]);

/** 浏览器 SDK 专属的请求头，官方 CLI 不会发；留着等于自报第三方。 */
const BROWSER_ONLY_HEADERS = Object.freeze(["anthropic-dangerous-direct-browser-access"]);

export const DEFAULT_IDENTITY = Object.freeze({
	userAgent: `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
	appHeader: "cli",
	dropBrowserHeaders: true,
	dropSdkHeaders: false,
	metadataUserId: undefined
});

/**
 * 合并出最终请求头。
 * @param {HeadersInit | undefined} source 原始请求头。
 * @param {object} identity 指纹配置。
 * @returns {Headers} 处理后的请求头。
 */
export function buildIdentityHeaders(source, identity = DEFAULT_IDENTITY) {
	const headers = new Headers(source ?? undefined);
	headers.set("user-agent", identity.userAgent);
	headers.set("x-app", identity.appHeader);
	if (identity.dropBrowserHeaders) for (const name of BROWSER_ONLY_HEADERS) headers.delete(name);
	if (identity.dropSdkHeaders) for (const key of [...headers.keys()]) if (key.toLowerCase().startsWith("x-stainless")) headers.delete(key);
	// 订阅只认 Bearer；任何残留的 x-api-key 都会让服务端把它当 API Key 请求。
	headers.delete("x-api-key");
	const current = (headers.get("anthropic-beta") ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	headers.set("anthropic-beta", [...new Set([...current, ...OAUTH_BETAS])].join(","));
	return headers;
}

/**
 * 包装 fetch：所有出站请求统一过一遍指纹。
 * @param {typeof fetch} inner 原始 fetch。
 * @param {() => object} getIdentity 读取当前指纹配置。
 * @returns {typeof fetch} 包装后的 fetch。
 */
export function createIdentityFetch(inner, getIdentity, apiKey) {
	const call = typeof inner === "function" ? inner : globalThis.fetch;
	return async (input, init) => {
		const identity = { ...DEFAULT_IDENTITY, ...(getIdentity() ?? {}) };
		const request = input instanceof Request ? input : undefined;
		const url = request?.url ?? String(input);
		requireSubscriptionRequest(url, apiKey);
		const headers = buildIdentityHeaders(init?.headers ?? request?.headers, identity);
		headers.set("authorization", `Bearer ${apiKey}`);
		headers.delete("cf-aig-authorization");
		let requestSummary;
		try {
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			if (body !== undefined) {
				requestSummary = {
					model: body.model,
					systemBlocks: Array.isArray(body.system) ? body.system.length : 0,
					systemLength: Array.isArray(body.system) ? body.system.map((b) => b.text ?? "").join("").length : 0,
					thinking: body.thinking,
					outputConfig: body.output_config,
					tools: Array.isArray(body.tools) ? body.tools.map((tool) => tool.name) : [],
					messages: Array.isArray(body.messages)
						? body.messages.map((message) => ({
								role: message.role,
								blocks: Array.isArray(message.content) ? message.content.map((block) => block.type + (block.type === "text" ? `(${(block.text ?? "").length})` : block.type === "tool_use" ? `(${block.id})` : "")) : `text(${typeof message.content === "string" ? message.content.length : 0})`
							}))
						: 0
				};
			}
		} catch {
			requestSummary = undefined;
		}
		const response = await call(input, { ...(init ?? {}), headers, redirect: "error" });
		identity.onResponse?.(requestSummary?.model, response);
		if (!response.ok) {
			// Provider bodies can echo credentials or private prompts; log only structural data.
			trace({ kind: "http-error", status: response.status, request: requestSummary });
		} else {
			trace({ kind: "http-ok", status: response.status, request: requestSummary });
		}
		return response;
	};
}

/** 把 system 规范成 blocks 数组。 */
function systemBlocks(system) {
	if (Array.isArray(system)) return system;
	if (typeof system === "string" && system.length > 0) return [{ type: "text", text: system }];
	return [];
}

/** 首块是否已经是 Claude Code 身份句（pi-ai 没被抹掉时就是）。 */
function hasIdentity(blocks) {
	const first = blocks[0];
	return typeof first?.text === "string" && first.text.startsWith("You are Claude Code");
}

/**
 * 出站前清理 Claude 5+ 的历史消息。
 *
 * 起因：这类模型的 thinking 块带签名，签名绑定的是模型**原始**的 assistant 内容。
 * 而 filterInvokeText 会把正文里的 `<invoke>` 剥掉、再追加合成的 tool_use，
 * 内容一变签名就失效。实测服务端对这种情况的表现是返回一条只有 thinking、
 * 没有任何正文和工具调用的 200 响应 —— 也就是用户看到的「空回复」。
 *
 * 实测同样确认：把 assistant 消息里的 thinking 块整块去掉，请求照样被接受
 * （200），模型会自己重新思考。所以这里丢弃 Harness 的 reasoning 与 pi-ai 的 thinking 历史块，不留签名包袱。
 * 顺带清掉空 text 块与空 system 消息 —— 服务端对空内容块会直接 400。
 *
 * @param {object} context pi-ai 的 Context。
 * @returns {object} 处理后的 Context。
 */
export function stripReasoning(context) {
	if (context === null || typeof context !== "object") return context;
	const messages = Array.isArray(context.messages) ? context.messages : [];
	let changed = false;
	const next = [];
	for (const message of messages) {
		if (message === null || typeof message !== "object") {
			next.push(message);
			continue;
		}
		const content = Array.isArray(message.content) ? message.content : undefined;
		if (content === undefined) {
			next.push(message);
			continue;
		}
		const kept = content.filter(
			(block) =>
				block?.type !== "reasoning" && block?.type !== "thinking" &&
				!(block?.type === "text" && typeof block.text === "string" && block.text.trim() === "")
		);
		if (kept.length === content.length && content.length > 0) {
			next.push(message);
			continue;
		}
		changed = true;
		// 空 system 消息服务端会直接拒（"system content must contain at least one block"）
		if (kept.length === 0 && message.role !== "assistant") continue;
		// assistant 消息不能为空，否则同样非法；留一个空格兜底。
		next.push({ ...message, content: kept.length === 0 ? [{ type: "text", text: " " }] : kept });
	}
	return changed ? { ...context, messages: next } : context;
}

/**
 * 在 payload 层补回身份句与可选的 metadata.user_id。
 * 幂等：已经带身份句的请求原样返回。
 * @param {object} params Anthropic Messages 请求体。
 * @param {object} identity 指纹配置。
 * @returns {object} 处理后的请求体。
 */
export function applySystemIdentity(params, identity = DEFAULT_IDENTITY) {
	if (params === null || typeof params !== "object") return params;
	const blocks = systemBlocks(params.system);
	const next = { ...params };
	if (!hasIdentity(blocks)) next.system = [{ type: "text", text: CLAUDE_CODE_IDENTITY }, ...blocks];
	if (identity.metadataUserId !== undefined && next.metadata === undefined) {
		next.metadata = { user_id: identity.metadataUserId };
	}
	return next;
}

/**
 * 包装 pi-ai 的 stream 选项：补 fetch、补头、补 payload 钩子。
 * @param {object} options pi-ai 的调用选项。
 * @param {() => object} getIdentity 读取当前指纹配置。
 * @returns {object} 新的调用选项。
 */
export function shapeStreamOptions(options, getIdentity) {
	const identity = { ...DEFAULT_IDENTITY, ...(getIdentity() ?? {}) };
	const downstream = options?.onPayload;
	return {
		...options,
		headers: { ...(options?.headers ?? {}), "user-agent": identity.userAgent, "x-app": identity.appHeader },
		fetch: createIdentityFetch(options?.fetch ?? globalThis.fetch, getIdentity, options?.apiKey),
		async onPayload(params, model) {
			const shaped = applySystemIdentity(params, identity);
			if (typeof downstream !== "function") return shaped;
			const next = await downstream(shaped, model);
			return applySystemIdentity(next === undefined ? shaped : next, identity);
		}
	};
}

/**
 * 用指纹层包住 pi-ai 的 anthropic provider。provider 的 id、auth、模型目录
 * 全部沿用目录里的那一份，只改出站路径。
 * @param {object} base pi-ai 的 anthropic provider。
 * @param {() => object} getIdentity 读取当前指纹配置。
 * @returns {object} 包装后的 provider。
 */
export function createSubscriptionProvider(base, getIdentity, getPersonaPolicy) {
	/*
	 * 只关「对话中系统消息 / 工具增删」两条 compat：它们会让 pi-ai 把工具声明
	 * 走占位符分支（请求里多出一个 `__pi_deferred_placeholder__` 工具），
	 * 而真实 Claude Code 每个请求只带一份固定工具表。关掉之后工具列表照常
	 * 从 toolsAdded 取，请求体干净得多。
	 *
	 * `supportsMidConvoEffort` 仍保持关闭：pi-ai 在该 compat 为 true 时会给请求
	 * 加 `thinking.block_binding`，而服务端明确拒绝这个字段
	 * （400 `thinking.adaptive.block_binding: Extra inputs are not permitted`）。
	 * 签名前缀的问题改用「出站前丢掉 thinking 块」解决，见 stripReasoning。
	 */
	const getModels = () =>
		base.getModels().map((model) =>
			model?.compat === undefined
				? model
				: {
						...model,
						compat: { ...model.compat, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false, supportsMidConvoEffort: false }
					}
		);
	const prepare = (model, context) => {
		const policy = typeof getPersonaPolicy === "function" ? getPersonaPolicy() : undefined;
		const sanitized = policy === undefined ? context : sanitizeContextForModel(context, model, policy);
		const materialized = materializeContext(sanitized);
		return isModernClaude(model?.id) ? stripReasoning(materialized) : materialized;
	};
	/** Claude 5+ 额外过滤正文里手写的 <invoke> 工具语法。 */
	const finish = (model, stream) => {
		const policy = typeof getPersonaPolicy === "function" ? getPersonaPolicy() : undefined;
		if (policy === undefined || policy.filterNarration === false) return stream;
		return isModernClaude(model?.id) ? filterInvokeText(stream) : stream;
	};
	/** 一次完整的模型调用：物化上下文 → 指纹 → 文本过滤。 */
	const call = (model, context, options, open) => {
		requireSubscriptionRequest(model?.baseUrl ?? "https://api.anthropic.com", options?.apiKey);
		return finish(model, open(model, prepare(model, context), shapeStreamOptions(options, getIdentity)));
	};
	/*
	 * Claude 5+ 的空回复兜底：只有 thinking、没有正文和工具调用时重发一次，
	 * 两次都空就报明确错误，避免界面停在「已完成」的白屏上。
	 * 非 5+ 模型保持原样，不额外缓冲。
	 */
	const guard = (model, options, open2) => {
		if (!isModernClaude(model?.id)) return open2(0);
		const signal = options?.signal ?? options?.abortSignal;
		return recoverEmptyResponse((attempt) => open2(attempt), { signal });
	};
	return {
		...base,
		getModels,
		stream: (model, context, options) =>
			guard(model, options, (attempt) => call(model, context, options, base.stream)),
		streamSimple: (model, context, options) =>
			guard(model, options, (attempt) => call(model, context, options, base.streamSimple))
	};
}
