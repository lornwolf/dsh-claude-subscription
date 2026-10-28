/**
 * Host↔浏览器 RPC：设置页里的按钮需要一个能穿透到宿主的通道。
 *
 * DSH 的 web 宿主把自定义端点挂在 `connection.fetch` 上，客户端用
 * `ctx.get("connection").rpc.call("/api", "<prefix>/<endpoint>", payload)` 调用。
 * 信封沿用宿主既有的形状：请求 `{rpcId, method, payload}`，应答
 * `{type: "server-response", rpcId, result}`，`result` 是 `{ok:true, value}`
 * 或 `{ok:false, error:{code, message}}`。
 */

import { publicErrorMessage } from "./operation.js";

export const RPC_PREFIX = "claude-subscription";

/** 允许浏览器调用的端点。 */
export const RPC_ENDPOINTS = Object.freeze(["status", "login", "login/submit", "login/cancel", "logout", "quota", "accounts/select", "accounts/remove", "models/refresh", "routing/set"]);

const json = (value) => JSON.parse(JSON.stringify(value ?? null));

/**
 * 注册全部端点。
 * @param {object} connection 宿主的 connection 服务。
 * @param {(endpoint: string, payload: object) => Promise<object>} handler 端点实现。
 * @returns {() => void} 注销函数。
 */
export function registerClaudeRpc(connection, handler) {
	const disposers = [];
	for (const endpoint of RPC_ENDPOINTS) {
		const method = `${RPC_PREFIX}/${endpoint}`;
		const disposable = connection.fetch.register({
			path: `/api/${method}`,
			methods: ["POST"],
			requestBody: "buffered",
			async fetch(request) {
				const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
				if (contentType !== "application/json") return new Response("content type must be application/json", { status: 415 });
				if (Number(request.headers.get("content-length")) > 65536) return new Response("request too large", { status: 413 });
				let body;
				try {
					const text = await request.text();
					if (new TextEncoder().encode(text).length > 65536) return new Response("request too large", { status: 413 });
					body = JSON.parse(text);
				} catch {
					return new Response("invalid JSON", { status: 400 });
				}
				if (body?.method !== method || body === null || typeof body !== "object" || Array.isArray(body)) return new Response("invalid RPC envelope", { status: 400 });
				const payload = body.payload ?? {};
				if (typeof payload !== "object" || Array.isArray(payload)) return new Response("invalid RPC payload", { status: 400 });
				for (const key of ["force", "refreshProfile"]) if (payload[key] !== undefined && typeof payload[key] !== "boolean") return new Response("invalid RPC field", { status: 400 });
				for (const [key, limit] of [["code", 16384], ["id", 256], ["label", 256], ["method", 32], ["mode", 32], ["sessionId", 256], ["model", 256]]) {
					if (payload[key] !== undefined && (typeof payload[key] !== "string" || payload[key].length > limit)) return new Response("invalid RPC field", { status: 400 });
				}
				let result;
				try {
					request.signal.throwIfAborted();
					result = { ok: true, value: json(await handler(endpoint, payload, { signal: request.signal })) };
				} catch (error) {
					/*
					 * 宿主客户端要求失败信封里 error.details 必须是对象，缺了它会直接抛
					 * "invalid server-response failure"，把真实原因吞掉（面板只剩一句看不懂的连接错误）。
					 */
					result = { ok: false, error: { code: "internal", message: publicErrorMessage(error), details: {} } };
				}
				return Response.json({ type: "server-response", rpcId: body.rpcId, result });
			}
		});
		disposers.push(disposable);
	}
	return () => {
		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch {
				/* 注销失败不影响其它端点 */
			}
		}
	};
}
