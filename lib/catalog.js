import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountCache } from "./cache.js";
import { abortable, operationError } from "./operation.js";
import { buildIdentityHeaders } from "./fingerprint.js";

const positive = value => Number.isSafeInteger(value) && value > 0;

/** Validate remote metadata, then overlay it onto the SDK's wire-compatible model shape. */
export function mapCatalog(rows, fallback) {
	if (!Array.isArray(rows)) throw operationError("模型目录格式无效", "CATALOG_SHAPE");
	const template = fallback.find(model => model.api === "anthropic-messages");
	if (!template) throw operationError("缺少可用的 Claude SDK 模型模板", "CATALOG_TEMPLATE");
	const seen = new Set();
	const models = rows.flatMap(row => {
		if (!row || typeof row.id !== "string" || !/^claude-[a-z0-9.-]+$/.test(row.id) || seen.has(row.id)) return [];
		seen.add(row.id);
		const known = fallback.find(model => model.id === row.id);
		const model = { ...structuredClone(known ?? template), id: row.id,
			name: typeof row.display_name === "string" && row.display_name.length <= 256 ? row.display_name : row.id,
			provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
		model.compat = { ...(model.compat ?? {}) };
		if (positive(row.max_input_tokens)) model.contextWindow = row.max_input_tokens;
		if (positive(row.max_tokens)) model.maxTokens = row.max_tokens;
		const thinking = row.capabilities?.thinking;
		if (thinking) {
			model.reasoning = thinking.supported === true || thinking.types?.enabled?.supported === true || thinking.types?.adaptive?.supported === true;
			model.compat = { ...model.compat, forceAdaptiveThinking: thinking.types?.adaptive?.supported === true && thinking.types?.enabled?.supported !== true };
		}
		const effort = row.capabilities?.effort;
		if (effort) {
			model.thinkingLevelMap = effort.supported === true ? Object.fromEntries(["low", "medium", "high", "xhigh", "max"].filter(level => effort[level]?.supported === true).map(level => [level, level])) : {};
		}
		if (!known) {
			// Unknown models must not inherit another model's fallback identities or prices.
			delete model.compat?.allowedFallbackModels;
			model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			if (!positive(row.max_input_tokens)) model.contextWindow = Math.min(template.contextWindow, 200_000);
			if (!positive(row.max_tokens)) model.maxTokens = Math.min(template.maxTokens, 4096);
			model.input = ["text"];
			if (!thinking) { model.reasoning = false; model.compat.forceAdaptiveThinking = false; }
			if (!effort) model.thinkingLevelMap = {};
		}
		// `off:null` is a wire directive, not an advertised effort level: the SDK
		// must retain its model-specific off behavior instead of sending disabled.
		// Keep it through both live discovery and disk-cache reconstruction.
		if (Object.hasOwn(known?.thinkingLevelMap ?? {}, "off")) {
			model.thinkingLevelMap = { ...model.thinkingLevelMap, off: known.thinkingLevelMap.off };
		}
		if (model.compat.forceAdaptiveThinking === true) model.thinkingLevelMap = { ...model.thinkingLevelMap, off: null };
		return [model];
	});
	if (!models.length) throw operationError("模型目录为空", "CATALOG_EMPTY");
	return models;
}

/** Per-account durable successful catalogs; cache corruption is recoverable. */
export function createCatalogService({ vault, resolveAccount, fallback, directory, identity, onChanged = () => {}, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now }) {
	const cache = new AccountCache({ ttlMs: 60 * 60_000, now });
	const snapshots = new Map();
	const files = new Map();
	const generations = new Map();
	const fileFor = id => path.join(directory, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
	let closed = false;
	async function restore(id) {
		if (snapshots.has(id) || !directory) return;
		const generation = generations.get(id) ?? 0;
		if (!files.has(id)) files.set(id, (async () => {
			try {
				const stored = JSON.parse(await readFile(fileFor(id), "utf8"));
				if (stored.version !== 1 || stored.accountId !== id || !Number.isFinite(stored.at) || stored.at > now()) return;
				const models = mapCatalog(stored.rows, fallback());
				if (!closed && generation === (generations.get(id) ?? 0)) { snapshots.set(id, models); cache.seed(id, { models, fetchedAt: new Date(stored.at).toISOString() }, stored.at); }
			} catch { /* Missing/corrupt cache falls back to the SDK. */ }
		})());
		await files.get(id);
	}
	return {
		models: id => snapshots.get(id) ?? fallback(),
		invalidate(id) { cache.invalidate(id); },
		async refresh(id, options = {}) {
			options.signal?.throwIfAborted();
			if (closed) throw operationError("模型目录服务已停止", "CATALOG_CLOSED");
			const generation = generations.get(id) ?? 0;
			await restore(id);
			if (generation !== (generations.get(id) ?? 0)) throw operationError("账号已移除", "ACCOUNT_CHANGED");
			const result = await cache.get(id, async signal => {
				const credential = await resolveAccount(id, { signal });
				const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
				const rows = [];
				let after;
				for (let page = 0; page < 20; page++) {
					const url = new URL("https://api.anthropic.com/v1/models");
					url.searchParams.set("limit", "100");
					if (after) url.searchParams.set("after_id", after);
					const response = await abortable(fetchImpl(url.href, { redirect: "error", signal: requestSignal,
						headers: buildIdentityHeaders({ authorization: `Bearer ${credential.access}`, "anthropic-version": "2023-06-01" }, typeof identity === "function" ? identity() : identity) }), requestSignal);
					if (!response.ok) { void response.body?.cancel().catch(() => {}); throw operationError(`模型接口返回 HTTP ${response.status}`, "CATALOG_HTTP"); }
					const payload = await abortable(response.json(), requestSignal);
					if (!Array.isArray(payload.data)) throw operationError("模型目录格式无效", "CATALOG_SHAPE");
					rows.push(...payload.data);
					if (!payload.has_more) break;
					if (page === 19 || typeof payload.last_id !== "string" || payload.last_id === after) throw operationError("模型目录分页无效", "CATALOG_SHAPE");
					after = payload.last_id;
				}
				const models = mapCatalog(rows, fallback());
				signal.throwIfAborted();
				if (closed || !await vault.record(id, { signal })) throw operationError("账号已移除", "ACCOUNT_CHANGED");
				const at = now();
				if (directory) {
					const file = fileFor(id), temp = `${file}.${randomUUID()}.tmp`;
					try {
						await mkdir(directory, { recursive: true });
						// Persist allowlisted catalog metadata only, never upstream payloads or credentials.
						const safeRows = models.map(model => ({ id: model.id, display_name: model.name, max_input_tokens: model.contextWindow, max_tokens: model.maxTokens,
							capabilities: { thinking: { supported: model.reasoning, types: { adaptive: { supported: model.compat?.forceAdaptiveThinking === true }, enabled: { supported: model.reasoning && !model.compat?.forceAdaptiveThinking } } },
								effort: { supported: true, ...Object.fromEntries(Object.keys(model.thinkingLevelMap ?? {}).filter(level => ["low", "medium", "high", "xhigh", "max"].includes(level)).map(level => [level, { supported: true }])) } } }));
						await writeFile(temp, JSON.stringify({ version: 1, accountId: id, at, rows: safeRows }), { flag: "wx", mode: 0o600 });
						signal.throwIfAborted();
						for (let attempt = 0;; attempt++) {
							try { await rename(temp, file); break; }
							catch (error) { if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1))); }
						}
					} catch { /* Persistence failure does not discard a valid live catalog. */ }
					finally { await unlink(temp).catch(() => {}); }
				}
				signal.throwIfAborted();
				if (generation !== (generations.get(id) ?? 0)) throw operationError("账号已移除", "ACCOUNT_CHANGED");
				snapshots.set(id, models);
				try { onChanged(); } catch { /* UI notification cannot discard a valid catalog. */ }
				return { models, fetchedAt: new Date(at).toISOString() };
			}, options);
			return { models: result.value.models, fetchedAt: result.value.fetchedAt, stale: result.stale, warning: result.warning };
		},
		async remove(id) { generations.set(id, (generations.get(id) ?? 0) + 1); cache.invalidate(id); snapshots.delete(id); files.delete(id); if (directory) await unlink(fileFor(id)).catch(() => {}); },
		close() { closed = true; cache.invalidate(); }
	};
}
