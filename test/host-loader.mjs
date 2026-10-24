// Test-only host peer resolution. Reads installed packages; never installs or links them.
import path from "node:path";
import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
	if (process.env.DSH_TEST_HOST_ROOT && /^(?:@deepseek-ai|@earendil-works)\//.test(specifier)) {
		return nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(process.env.DSH_TEST_HOST_ROOT, "package.json")).href });
	}
	return nextResolve(specifier, context);
}
