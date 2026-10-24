/** Shared cancellation and public-error boundary. Never expose provider bodies or causes. */
export function operationError(message, code = "SUBSCRIPTION_ERROR") {
	const error = new Error(message);
	error.code = code;
	error.publicMessage = message;
	return error;
}

export function publicErrorMessage(error, fallback = "Claude 订阅操作失败，请重试或重新登录。") {
	if (error?.name === "AbortError") return "操作已取消";
	if (error?.name === "TimeoutError") return "操作超时，请重试";
	return typeof error?.publicMessage === "string" ? error.publicMessage : fallback;
}

/** A timeout/abort must settle even when the supplied operation ignores its signal. */
export function abortable(operation, signal) {
	if (!signal) return Promise.resolve(operation);
	return new Promise((resolve, reject) => {
		const onAbort = () => { cleanup(); reject(signal.reason ?? new DOMException("Operation cancelled", "AbortError")); };
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(operation).then(
			(value) => { cleanup(); signal.aborted ? onAbort() : resolve(value); },
			(error) => { cleanup(); reject(signal.aborted ? signal.reason : error); }
		);
		function cleanup() { signal.removeEventListener("abort", onAbort); }
		if (signal.aborted) { cleanup(); onAbort(); }
	});
}
