import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { abortable, operationError } from "./operation.js";

/** The host's lock coordinates the entire read/refresh/write transaction. */
export function createVaultLock(file, { timeoutMs = 45_000 } = {}) {
	return async (operation, options = {}) => {
		options.signal?.throwIfAborted();
		await mkdir(path.dirname(file), { recursive: true });
		return abortable(withFileLock(file, async () => {
			options.signal?.throwIfAborted();
			return operation();
		}, { waitMs: timeoutMs }).catch(error => {
			if (String(error.message).startsWith("atomic-write: timed out")) throw operationError("账号库正由另一个进程使用，请稍后重试。", "VAULT_BUSY");
			throw error;
		}), options.signal);
	};
}
