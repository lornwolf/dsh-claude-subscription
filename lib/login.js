import { PendingCredentialStore } from "./accounts.js";
import { abortable, operationError, publicErrorMessage } from "./operation.js";

function deferred() {
	let resolve;
	const promise = new Promise((yes) => { resolve = yes; });
	return { promise, resolve };
}

/** One login owns its state until completion; cancelled generations never clear a successor. */
export class ClaudeLoginCoordinator {
	#vault;
	#provider;
	#authContext;
	#createModels;
	#current;
	#lastError;
	#timing;

	constructor({ vault, provider, authContext, createModels, timing = {} }) {
		this.#vault = vault;
		this.#provider = provider;
		this.#authContext = authContext;
		this.#createModels = createModels;
		this.#timing = { loginTimeoutMs: 10 * 60_000, submitTimeoutMs: 120_000, urlWaitMs: 8_000, ...timing };
	}

	get pending() { return this.#current !== undefined; }

	async start({ method = "copy_code", label } = {}) {
		if (this.#current) throw operationError("已有一个 Claude 订阅登录在进行中；先提交授权码或取消", "LOGIN_PENDING");
		if (!["copy_code", "browser"].includes(method)) throw operationError("未知的登录方式", "LOGIN_METHOD");
		const controller = new AbortController();
		const code = deferred();
		const ready = deferred();
		const session = { phase: "starting" };
		const state = { controller, session, resolveCode: code.resolve, finished: false };
		const timer = setTimeout(() => controller.abort(new DOMException("Login timed out", "TimeoutError")), this.#timing.loginTimeoutMs);
		timer.unref?.();
		this.#current = state;
		this.#lastError = undefined;
		const pending = new PendingCredentialStore();
		state.run = (async () => {
			try {
				const models = this.#createModels({ credentials: pending, authContext: this.#authContext });
				models.setProvider(this.#provider);
				controller.signal.throwIfAborted();
				await abortable(models.login("anthropic", "oauth", {
					signal: controller.signal,
					prompt: async (prompt) => {
						controller.signal.throwIfAborted();
						if (prompt?.type === "select") return method;
						if (prompt?.type === "manual_code" || prompt?.type === "text") {
							const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
							return abortable(code.promise, signal);
						}
						throw operationError("Claude 登录出现不支持的交互", "LOGIN_PROMPT");
					},
					notify: (event) => {
						if (controller.signal.aborted || this.#current !== state) return;
						if (event?.type === "auth_url") {
							session.authUrl = event.url;
							session.instructions = event.instructions;
							session.phase = method === "browser" ? "waiting_browser" : "waiting_code";
							ready.resolve();
						}
						if (event?.type === "progress") session.phase = "exchanging";
					}
				}), controller.signal);
				controller.signal.throwIfAborted();
				if (this.#current !== state) throw operationError("登录已取消", "LOGIN_CANCELLED");
				const credential = pending.credential();
				if (!credential) throw operationError("Claude 登录没有返回凭据", "LOGIN_CREDENTIAL");
				const account = await this.#vault.add(label, credential, { signal: controller.signal });
				session.phase = "signed_in";
				return account;
			} catch (error) {
				const timeout = controller.signal.reason?.name === "TimeoutError";
				session.phase = timeout ? "failed" : controller.signal.aborted ? "cancelled" : "failed";
				const message = timeout ? "登录超时，请重新开始" : controller.signal.aborted ? "登录已取消" : publicErrorMessage(error, "Claude 登录失败，请重试。");
				if (this.#current === state) this.#lastError = message;
				throw operationError(message, timeout ? "LOGIN_TIMEOUT" : "LOGIN_FAILED");
			} finally {
				clearTimeout(timer);
				state.finished = true;
				ready.resolve();
				if (this.#current === state) this.#current = undefined;
			}
		})();
		state.run.catch(() => undefined);
		let readyTimer;
		await Promise.race([ready.promise, new Promise((resolve) => { readyTimer = setTimeout(resolve, this.#timing.urlWaitMs); })]);
		clearTimeout(readyTimer);
		return {
			method,
			phase: state.finished ? session.phase : session.authUrl ? session.phase : "starting",
			authUrl: session.authUrl,
			instructions: session.instructions,
			error: session.phase === "failed" ? this.#lastError : undefined
		};
	}

	async submit(rawCode, options = {}) {
		const state = this.#current;
		if (!state) throw operationError("当前没有进行中的 Claude 登录", "LOGIN_MISSING");
		const value = typeof rawCode === "string" ? rawCode.trim() : "";
		if (!value) throw operationError("授权码为空", "LOGIN_CODE");
		options.signal?.throwIfAborted();
		state.resolveCode(value);
		const timeout = setTimeout(() => state.controller.abort(new DOMException("Login submission timed out", "TimeoutError")), this.#timing.submitTimeoutMs);
		const onAbort = () => state.controller.abort(options.signal.reason);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try { return await state.run; }
		finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	cancel() {
		const state = this.#current;
		if (!state) return false;
		this.#current = undefined;
		this.#lastError = "登录已取消";
		state.controller.abort(new DOMException("Login cancelled", "AbortError"));
		return true;
	}

	state() {
		const site = this.#current?.session;
		return {
			pending: this.pending,
			phase: site?.phase ?? (this.#lastError === undefined ? "idle" : this.#lastError === "登录已取消" ? "cancelled" : "failed"),
			authUrl: site?.authUrl,
			error: this.#lastError
		};
	}
}
