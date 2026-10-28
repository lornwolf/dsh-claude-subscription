/**
 * dsh-claude-subscription — 在 DeepSeek Harness 里用 Claude Pro/Max 订阅。
 *
 * 一条路由把 Claude Pro/Max 订阅接进 DSH，分四层：
 *
 *   1. 认证：插件自管的 Claude Pro/Max OAuth（claude.ai 授权页、PKCE、
 *      本地回调 53692 或复制授权码），凭据写进 DSH 凭据库，不读 ~/.claude。
 *   2. 凭据：一个 DSH 凭据引用存多账号 JSON，激活账号的 credential 直接喂给
 *      pi-ai 的 CredentialStore 接口，刷新在存储锁内完成。
 *   3. 指纹：见 ./fingerprint.js —— 头、system 首段、metadata 三层伪装。
 *   4. 路由：PiAiAdapter + anthropic provider，注册成 DSH 的 `anthropic` 路由，
 *      模型选择器里直接出现。
 *
 * 刻意没做的：生图、云端压缩、速度档、手机远控、第三方连接器。
 */

import * as dshLlm from "@deepseek-ai/dsh-llm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import {
	CLAUDE_CODE_IDENTITY,
	CLAUDE_CODE_VERSION,
	DEFAULT_IDENTITY,
	createSubscriptionProvider,
	buildIdentityHeaders
} from "./fingerprint.js";
import { registerClaudeRpc } from "./rpc.js";
import { AccountVault, VaultCredentialStore } from "./accounts.js";
import { ClaudeLoginCoordinator } from "./login.js";
import { createSubscriptionOAuth } from "./oauth.js";
import { createUsageService } from "./usage.js";
import { createCatalogService } from "./catalog.js";
import { createRefreshService } from "./refresh.js";
import { createVaultLock } from "./vault-lock.js";
import { createAccountRouter } from "./routing.js";
import { createAccountProfileService } from "./profile.js";
import { operationError, publicErrorMessage } from "./operation.js";
export { AccountVault, VaultCredentialStore, PendingCredentialStore } from "./accounts.js";
export { ClaudeLoginCoordinator } from "./login.js";
export { USAGE_URL, readSubscriptionUsage, summarizeUsage } from "./usage.js";

export const name = "claude-subscription";
export const PLUGIN_VERSION = "0.2.1";

/** 只依赖 LLM、凭据、工具三个 seam；其余都用 ctx.get 兜底。 */
export const inject = ["llm", "credentials", "tools"];

/** pi-ai 目录里的 provider id，也是 DSH 侧的路由名。 */
export const PROVIDER = "anthropic";

/** 多账号库：一个 JSON 字符串凭据。 */
export const ACCOUNT_STORE_REF = credentialRef("CLAUDE_SUBSCRIPTION_ACCOUNTS");

const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * DSH 的工具输出校验要求 lossless JSON：带 `undefined` 的值会被直接判为非法输出。
 * 工具结果里 `authUrl`、`error`、`expires` 这类字段天然可能是 undefined，统一洗一遍。
 * @param {*} value 工具返回值。
 * @returns {*} 去掉 undefined / 非有限数字后的纯 JSON 值。
 */
function jsonSafe(value) {
	if (Array.isArray(value)) return value.map(jsonSafe).filter((entry) => entry !== undefined);
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(value)) {
			const safe = jsonSafe(entry);
			if (safe !== undefined) out[key] = safe;
		}
		return out;
	}
	return value;
}

/** 工具注册壳：执行结果先过一遍 jsonSafe，再交给校验。 */
const safeTool = (options) =>
	defineTool({
		...options,
		execute: async (args, exec) => {
			try { exec?.signal?.throwIfAborted(); return jsonSafe(await options.execute(args, exec)); }
			catch (error) { throw operationError(publicErrorMessage(error), "SUBSCRIPTION_TOOL"); }
		}
	});
/** 所有工具共用的输出壳：模型只需要读一段人话。 */
const TEXT_OUTPUT = Object.freeze({
	schema: { type: "object", additionalProperties: true },
	render: (_args, value) => [{ type: "text", text: typeof value?.message === "string" ? value.message : JSON.stringify(value, null, 2) }]
});

/**
 * 插件入口。
 * @param {object} ctx DSH 插件上下文。
 * @param {object} config 指纹与展示名覆盖。
 */
export function apply(ctx, config = {}) {
	const identity = { ...DEFAULT_IDENTITY, ...(config.identity ?? {}) };
	const displayName = typeof config.displayName === "string" && config.displayName !== "" ? config.displayName : "Claude 订阅";
	const getIdentity = () => identity;
	/*
	 * Claude 5 及以上对宿主系统提示里夹带的注入段比较敏感，会被请求级拦截
	 * （violative cyber content）。默认对 5+ 不发送宿主那一整段提示，
	 * 4.x 及更早的 Claude、以及其它 provider 完全不受影响；宿主那边的文件本身不动。
	 */
	const personaPolicy = {
		enabled: config.sanitizeModernClaude !== false,
		mode: config.modernClaudeMode === "strip-inject" ? "strip-inject" : "minimal",
		...(typeof config.injectFile === "string" && config.injectFile !== "" ? { file: config.injectFile } : {}),
		onReport: (report) => {
			if (config.diagnostics === false) return;
			try {
				const dir = path.join(process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : path.join(os.homedir(), ".dsh"), "state", "claude-subscription");
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "last-request.json"), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2), "utf8");
			} catch {
				/* 诊断写盘失败不影响请求 */
			}
		}
	};
	const getPersonaPolicy = () => personaPolicy;

	const catalog = anthropicProvider();
	// The subscription route owns OAuth only; ambient/API-key auth never participates.
	const oauth = createSubscriptionOAuth();
	const base = { ...catalog, auth: { oauth } };
	const provider = createSubscriptionProvider(base, getIdentity, getPersonaPolicy);
	const stateDirectory = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "state", "claude-subscription");
	const vault = new AccountVault(ctx.credentials, ACCOUNT_STORE_REF, { withLock: createVaultLock(path.join(stateDirectory, "accounts")) });
	const store = new VaultCredentialStore(vault);
	const authContext = Object.freeze({ env: async () => undefined, fileExists: async () => false });
	const refreshService = createRefreshService({ vault, oauth });
	const resolveAccount = (id, options) => refreshService.resolve(id, options);

	const resolveAuth = async (options = {}) => {
		const account = await vault.record(undefined, options);
		if (!account) return undefined;
		const credential = await resolveAccount(account.id, options);
		return { auth: { apiKey: credential.access } };
	};
	const usageService = createUsageService({ vault, resolveAccount, identity: getIdentity });
	const catalogs = createCatalogService({ vault, resolveAccount, fallback: () => catalog.getModels(), directory: path.join(stateDirectory, "catalogs"), identity: getIdentity,
		onChanged: () => ctx.llm.emitAdaptersUpdated?.() });
	let selectedAccount;
	let catalogAccounts = [];
	let routing;
	const availableModels = () => {
		if (!routing || routing.mode() === "off") return catalogs.models(selectedAccount);
		const union = new Map();
		for (const id of catalogAccounts) for (const model of catalogs.models(id)) if (!union.has(model.id)) union.set(model.id, model);
		return [...union.values()];
	};
	provider.getModels = () => createSubscriptionProvider({ ...base, getModels: availableModels }, getIdentity, getPersonaPolicy).getModels();
	provider.getAllModels = provider.getModels;

	const accountProfiles = createAccountProfileService({ vault, resolveAuth, identity });

	/** 面板/工具里给人看的账号名：显示名优先，其次邮箱，最后才是备注名。 */
	const accountTitle = (entry) =>
		entry?.displayName || entry?.email || entry?.label || "Claude 订阅账号";

	const resolveApiKey = async () => {
		const record = await vault.record();
		selectedAccount = record?.id;
		const resolved = await resolveAuth();
		const key = resolved?.auth?.apiKey;
		if (typeof key !== "string" || key === "") throw new dshLlm.LlmError("Claude 订阅未登录", "MISSING_CREDENTIAL");
		return key;
	};

	const profile = Object.freeze({
		provider: PROVIDER,
		displayName,
		piProvider: provider,
		configuredMaxTokens: new Map(),
		modelErrors: new Map(),
		maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
		requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
		requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
		streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
		cacheRetention: "short"
	});
	const profiles = () => new Map([[PROVIDER, profile]]);

	const adapter = new PiAiAdapter({
		profiles,
		resolveApiKey,
		auth: { credentials: store, authContext },
		resolveAttachments: () => ctx.get?.("attachments")
	});
	let savedRouting;
	try { savedRouting = JSON.parse(fs.readFileSync(path.join(stateDirectory, "routing.json"), "utf8")).mode; } catch { /* Default configuration. */ }
	const configuredMode = config.autoSwitch === false ? "off" : config.autoSwitch === true ? "priority" : typeof config.autoSwitch === "string" ? config.autoSwitch : undefined;
	routing = createAccountRouter({ adapter, vault, usage: usageService,
		mode: ["off", "priority", "quota-aware"].includes(configuredMode ?? savedRouting) ? configuredMode ?? savedRouting : "off",
		makeError: (message, code) => new dshLlm.LlmError(message, code),
		async adapterFor(id, options) {
			await catalogs.refresh(id, options).catch(error => { options.signal?.throwIfAborted(); });
			const credential = await resolveAccount(id, options);
			const requestModels = catalogs.models(id);
			// pi-ai resolves auth again even when an API key is supplied. Its request store
			// must be pinned too; using the default vault here silently sends account A's token for B.
			// Refresh was already handled transactionally above; this snapshot cannot write credentials.
			const requestStore = {
				read: async () => structuredClone(credential),
				modify: async (_provider, update) => { await update(structuredClone(credential)); return structuredClone(credential); },
				list: async () => [{ providerId: PROVIDER, type: "oauth" }]
			};
			const accountBase = { ...base, auth: { oauth: { ...oauth, refresh: async () => structuredClone(credential) } } };
			const accountProvider = createSubscriptionProvider({ ...accountBase, getModels: () => requestModels, getAllModels: () => requestModels },
				() => ({ ...identity, onResponse: (model, response) => routing.observe(id, model, response) }), getPersonaPolicy);
			const accountProfile = { ...profile, piProvider: accountProvider };
			return new PiAiAdapter({ profiles: () => new Map([[PROVIDER, accountProfile]]),
				resolveApiKey: async () => credential.access,
				auth: { credentials: requestStore, authContext }, resolveAttachments: () => ctx.get?.("attachments") });
		}
	});
	// Catalog refresh happens before the SDK captures its operation snapshot.
	const prepareCatalog = async signal => {
		const listing = await vault.list({ signal });
		selectedAccount = listing.activeId;
		catalogAccounts = [listing.activeId, ...listing.accounts.map(account => account.id).filter(id => id !== listing.activeId)].filter(Boolean);
		const ids = routing.mode() === "off" ? catalogAccounts.slice(0, 1) : catalogAccounts;
		await Promise.all(ids.map(id => catalogs.refresh(id, { signal }).catch(() => { signal?.throwIfAborted(); })));
	};
	const registered = new Proxy(routing.adapter, { get(target, key) {
		if (key === "listModels") return async providerId => {
			await prepareCatalog();
			if (routing.mode() === "off") return target.listModels(providerId);
			return provider.getModels().map(model => ({ provider: PROVIDER, id: model.id, name: model.name, inputModalities: [...model.input] }));
		};
		if (key === "resolveModel") return async (providerId, model, signal) => { await prepareCatalog(signal); return target.resolveModel(providerId, model, signal); };
		if (key === "prepareCall") return async (providerId, model, signal) => { await prepareCatalog(signal); return target.prepareCall(providerId, model, signal); };
		return Reflect.get(target, key);
	} });
	ctx.llm.registerAdapter([PROVIDER], registered);
	const coordinator = new ClaudeLoginCoordinator({ vault, provider, authContext, createModels });
	ctx.effect?.(() => {
		const controller = new AbortController();
		let timer;
		const run = async () => {
			try { if (config.catalogRefresh !== false) await prepareCatalog(controller.signal); } catch { /* Retain the cached catalog. */ }
			if (!controller.signal.aborted) { timer = setTimeout(run, 60 * 60_000); timer.unref?.(); }
		};
		void run();
		return () => { controller.abort(); clearTimeout(timer); catalogs.close(); usageService.invalidate(); coordinator.cancel(); };
	}, "claude-subscription: catalog lifecycle");

	/** 登录/切换/退出之后叫醒模型选择器，免得要等下一次界面刷新才看到 Claude 模型。 */
	const notifyModels = () => {
		routing.clear();
		if (config.catalogRefresh !== false) void prepareCatalog().catch(() => {});
		try {
			ctx.llm.emitAdaptersUpdated?.();
		} catch {
			/* 界面刷新失败不影响登录结果 */
		}
	};

	const modelList = (id = selectedAccount) => {
		try {
			return catalogs.models(id).map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }));
		} catch {
			return [];
		}
	};

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_status",
			description:
				"查看 Claude 订阅（Claude Pro/Max）的登录状态：是否已登录、有哪些账号、当前激活账号、可用的 Claude 模型，以及客户端指纹层的当前取值。用户问『Claude 订阅登没登』『Claude 账号情况』时使用。",
			parameters: {},
			async execute(_args, exec = {}) {
				const auth = await resolveAuth({ signal: exec.signal }).catch(error => { exec.signal?.throwIfAborted(); return undefined; });
				const signedIn = typeof auth?.auth?.apiKey === "string" && auth.auth.apiKey !== "";
				const accounts = await accountProfiles.ensure({ signal: exec.signal });
				const login = coordinator.state();
				return {
					signedIn,
					provider: PROVIDER,
					pluginVersion: PLUGIN_VERSION,
					displayName,
					accounts: accounts.accounts,
					activeId: accounts.activeId,
					routingMode: routing.mode(),
					refreshState: await refreshService.status(undefined, { signal: exec.signal }),
					models: modelList(accounts.activeId),
					identity: {
						userAgent: identity.userAgent,
						appHeader: identity.appHeader,
						identityPrefix: CLAUDE_CODE_IDENTITY,
						claudeCodeVersion: CLAUDE_CODE_VERSION
					},
					login,
					...(accounts.profileWarning ? { profileWarning: accounts.profileWarning } : {}),
					message: signedIn
						? `已登录 Claude 订阅，当前账号：${accountTitle(accounts.accounts.find((entry) => entry.id === accounts.activeId))}；可用模型 ${modelList().length} 个。`
						: "尚未登录 Claude 订阅。调用 claude_subscription_login 获取授权链接。"
				};
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_login",
			description:
				"开始 Claude 订阅（Claude Pro/Max）OAuth 登录，返回授权链接。默认 copy_code：用户在浏览器完成授权后把页面上那串 code#state 交回来，再调用 claude_subscription_login_submit。method=browser 会在本机 53692 端口起回调服务，适合在浏览器同一台机器上登录。",
			parameters: {
				method: {
					type: "string",
										enum: ["copy_code", "browser"],
					description: "copy_code（默认，推荐）| browser（本机回调）"
				},
				label: {
					type: "string",
										description: "这个账号的备注名，例如 work、personal；留空自动编号"
				}
			},
			async execute(args, exec = {}) {
				const result = await coordinator.start({ method: args?.method ?? "copy_code", label: args?.label });
				const url = result.authUrl;
				return {
					...result,
					message: url === undefined
						? `登录没有拿到授权链接：${result.error ?? result.phase}`
						: `请在浏览器打开这个链接完成 Claude 授权：${url}\n授权后把页面上显示的 code#state 整串交回，我调用 claude_subscription_login_submit 收尾。`
				};
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_login_submit",
			description: "提交 Claude 授权页给出的授权码（形如 code#state），完成 OAuth 登录并把账号存进多账号库。",
			parameters: {
				code: { type: "string", required: true, description: "授权页显示的授权码，形如 code#state" }
			},
			async execute(args, exec = {}) {
				const account = await coordinator.submit(args?.code, { signal: exec.signal });
				notifyModels();
				return {
					signedIn: true,
					account,
					models: modelList(),
					message: `Claude 订阅已登录：${account.label}。现在可以在模型选择器里选 Claude 模型了。`
				};
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_logout",
			description: "退出 Claude 订阅：删除本地保存的全部 Claude 账号凭据。",
			parameters: {},
			async execute(_args, exec = {}) {
				coordinator.cancel();
				for (const account of (await vault.list({ signal: exec.signal })).accounts) await catalogs.remove(account.id);
				await vault.clear({ signal: exec.signal });
				usageService.invalidate();
				refreshService.invalidate();
				notifyModels();
				return { signedIn: false, message: "已退出 Claude 订阅并清空本地账号。" };
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_account_select",
			description: "切换当前使用的 Claude 订阅账号（多账号时用）。先用 claude_subscription_status 看 id。",
			parameters: {
				id: { type: "string", required: true, description: "账号 id，来自 claude_subscription_status 的 accounts" }
			},
			async execute(args, exec = {}) {
				const activeId = await vault.select(args?.id, { signal: exec.signal });
				let title = activeId;
				try {
					const listing = await vault.list({ signal: exec.signal });
					title = accountTitle(listing.accounts.find((entry) => entry.id === activeId));
				} catch {
					/* 名字解析失败不影响切换结果 */
				}
				notifyModels();
				return { activeId, message: `已切换到 Claude 账号 ${title}。` };
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_account_remove",
			description: "移除一个 Claude 订阅账号（不能移除最后一个；要全清用 claude_subscription_logout）。",
			parameters: {
				id: { type: "string", required: true, description: "账号 id" }
			},
			async execute(args, exec = {}) {
				let title = args?.id;
				try {
					const listing = await vault.list({ signal: exec.signal });
					title = accountTitle(listing.accounts.find((entry) => entry.id === args?.id));
				} catch {
					/* 名字解析失败不影响移除结果 */
				}
				await vault.remove(args?.id, { signal: exec.signal });
				await catalogs.remove(args?.id);
				usageService.invalidate(args?.id);
				refreshService.invalidate(args?.id);
				notifyModels();
				return { removed: args.id, message: `已移除 Claude 账号 ${title}。` };
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.tools.register(
		safeTool({
			name: "claude_subscription_quota",
			description:
				"查询 Claude 订阅额度：调用 Claude Code /usage 面板用的接口，返回服务端给出的窗口与重置时间（实验性，字段以服务端为准）。",
			parameters: {},
			async execute(_args, exec = {}) {
				return usageService.read({ signal: exec.signal });
			},
			output: TEXT_OUTPUT
		})
	);

	ctx.logger?.info?.("Claude 订阅路由已注册：%s（插件 %s，模型 %d 个）", PROVIDER, PLUGIN_VERSION, modelList().length);

	/* 设置页走同一条链路：RPC 只转发到上面这些函数，凭据与网络都不出宿主进程。 */
	const statusPayload = async (options = {}) => {
		const auth = await resolveAuth(options).catch(error => { options.signal?.throwIfAborted(); return undefined; });
		const refreshState = await refreshService.status(undefined, options);
		/*
		 * 面板要显示真实账号名（displayName/邮箱/计划），这些字段只能由 /api/oauth/profile
		 * 拿到并落进 vault。首次或缓存过期时会在锁内刷新一次；失败则退回缓存并带上提示，
		 * 面板不会因为拿不到资料而整块空掉。
		 */
		let accounts;
		try {
			accounts = await accountProfiles.ensure({ timeoutMs: 8_000, ...options });
		} catch {
			accounts = await vault.list(options);
		}
		return {
			signedIn: typeof auth?.auth?.apiKey === "string" && auth.auth.apiKey !== "",
			provider: PROVIDER,
			pluginVersion: PLUGIN_VERSION,
			displayName,
			accounts: accounts.accounts,
			activeId: accounts.activeId,
			routingMode: routing.mode(),
			refreshState,
			...(accounts.profileWarning ? { profileWarning: accounts.profileWarning } : {}),
			models: modelList(accounts.activeId),
			identity: {
				userAgent: identity.userAgent,
				appHeader: identity.appHeader,
				identityPrefix: CLAUDE_CODE_IDENTITY,
				claudeCodeVersion: CLAUDE_CODE_VERSION
			},
			login: coordinator.state()
		};
	};

	const rpcHandler = async (endpoint, payload, options = {}) => {
		switch (endpoint) {
			case "status":
				return statusPayload({ ...options, forceRefresh: payload?.refreshProfile === true });
			case "login": {
				const result = await coordinator.start({ method: payload?.method === "browser" ? "browser" : "copy_code", label: payload?.label });
				return { phase: result.phase, authUrl: result.authUrl, instructions: result.instructions, error: result.error };
			}
			case "login/submit": {
				const account = await coordinator.submit(payload?.code, options);
				notifyModels();
				return { account };
			}
			case "login/cancel":
				return { cancelled: coordinator.cancel() };
			case "logout":
				coordinator.cancel();
				for (const account of (await vault.list(options)).accounts) await catalogs.remove(account.id);
				await vault.clear(options);
				usageService.invalidate();
				refreshService.invalidate();
				notifyModels();
				return { signedIn: false };
			case "quota": {
				/*
				 * 面板要靠 accountId 判断这份额度属于哪个账号，所以必须走带 accountId 的那条链路；
				 * 只回渲染需要的窗口、额外用量与时间戳，上游原始 payload 留在宿主侧。
				 */
				const actual = payload?.sessionId && payload?.model ? routing.current(payload.sessionId, payload.model) : undefined;
				const usage = await usageService.read({ ...options, accountId: actual?.accountId, force: payload?.force === true });
				const listing = await vault.list(options);
				return { ...usage, accountName: accountTitle(listing.accounts.find(account => account.id === usage.accountId)),
					defaultAccount: usage.accountId === listing.activeId };
			}
			case "models/refresh": {
				const account = await vault.record(undefined, options);
				if (!account) throw operationError("请先登录 Claude 账号", "MISSING_CREDENTIAL");
				selectedAccount = account.id;
				const result = await catalogs.refresh(account.id, { ...options, force: true });
				return { accountId: account.id, models: modelList(account.id), fetchedAt: result.fetchedAt, stale: result.stale, warning: result.warning };
			}
			case "routing/set": {
				if (!["off", "priority", "quota-aware"].includes(payload?.mode)) throw operationError("无效的账号切换策略", "ROUTING_MODE");
				options.signal?.throwIfAborted();
				await writeFileAtomic(path.join(stateDirectory, "routing.json"), JSON.stringify({ mode: payload.mode }), { mode: 0o600 });
				routing.setMode(payload.mode);
				return { mode: routing.mode() };
			}
			case "accounts/select":
				await vault.select(payload?.id, options);
				notifyModels();
				return { activeId: payload?.id };
			case "accounts/remove":
				await vault.remove(payload?.id, options);
				await catalogs.remove(payload?.id);
				usageService.invalidate(payload?.id);
				refreshService.invalidate(payload?.id);
				notifyModels();
				return { removed: payload?.id };
			default:
				throw new Error(`未知的 Claude 订阅端点：${String(endpoint)}`);
		}
	};

	ctx.inject(["connection"], (scoped) => {
		scoped.effect(() => registerClaudeRpc(scoped.connection, rpcHandler), "claude-subscription: settings RPC");
	});
}

export { CLAUDE_CODE_IDENTITY, CLAUDE_CODE_VERSION, DEFAULT_IDENTITY, buildIdentityHeaders };
export { PiAiAdapter };
