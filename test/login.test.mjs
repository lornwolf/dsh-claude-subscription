import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountVault } from "../lib/accounts.js";
import { ClaudeLoginCoordinator } from "../lib/login.js";

const credential = () => ({ type: "oauth", access: "sk-ant-oat01-offline", refresh: "sk-ant-ort01-offline", expires: Date.now() + 3600_000 });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(behavior, timing) {
	let value;
	const vault = new AccountVault({ async resolve() { return value === undefined ? undefined : { value }; }, async set(_ref, next) { value = next; }, async unset() { value = undefined; } }, "test");
	let calls = 0;
	const coordinator = new ClaudeLoginCoordinator({ vault, provider: {}, authContext: {}, timing,
		createModels({ credentials }) { return { setProvider() {}, async login(_provider, _type, interaction) {
			const n = ++calls;
			await interaction.prompt({ type: "select" });
			interaction.notify({ type: "auth_url", url: `https://example.invalid/authorize/${n}` });
			await behavior(interaction, n);
			await credentials.modify("anthropic", () => credential());
		} }; }
	});
	return { coordinator, vault };
}

test("cancel old login and immediately start another: old finally cannot clear new state", async () => {
	const f = fixture((interaction) => interaction.prompt({ type: "manual_code", signal: interaction.signal }));
	await f.coordinator.start();
	assert.equal(f.coordinator.cancel(), true);
	const next = await f.coordinator.start();
	assert.match(next.authUrl, /\/2$/);
	assert.equal(f.coordinator.pending, true);
	await f.coordinator.submit("synthetic-code");
	assert.equal((await f.vault.list()).accounts.length, 1);
});

test("submit deadline aborts background login which ignores its signal", async () => {
	const blocked = deferred();
	const f = fixture(async (interaction) => { await interaction.prompt({ type: "manual_code" }); await blocked.promise; }, { submitTimeoutMs: 15 });
	await f.coordinator.start();
	await assert.rejects(f.coordinator.submit("synthetic-code"), /超时/);
	assert.equal(f.coordinator.pending, false);
	blocked.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await f.vault.list()).accounts.length, 0);
});

test("total login deadline ends a prompt that ignores abort", async () => {
	const f = fixture(() => new Promise(() => {}), { loginTimeoutMs: 20 });
	await f.coordinator.start();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(f.coordinator.pending, false);
	assert.match(f.coordinator.state().error, /超时/);
	assert.equal((await f.vault.list()).accounts.length, 0);
});

test("failed old login never replaces successor's last error", async () => {
	const blocked = deferred();
	const f = fixture(async (interaction, n) => n === 1 ? blocked.promise : interaction.prompt({ type: "manual_code" }));
	await f.coordinator.start();
	f.coordinator.cancel();
	await f.coordinator.start();
	blocked.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.coordinator.state().pending, true);
	assert.equal(f.coordinator.state().error, undefined);
	f.coordinator.cancel();
});

test("caller cancellation reaches submitted login and no account is added", async () => {
	const f = fixture(() => new Promise(() => {}));
	await f.coordinator.start();
	const controller = new AbortController();
	const submission = f.coordinator.submit("synthetic-code", { signal: controller.signal });
	controller.abort();
	await assert.rejects(submission, /取消/);
	assert.equal((await f.vault.list()).accounts.length, 0);
});

test("provider exception body is not exposed by coordinator", async () => {
	const f = fixture(async () => { throw Error("secret-response sk-ant-oat01-private refresh-token"); });
	const status = await f.coordinator.start();
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(!JSON.stringify(f.coordinator.state()).includes("private"));
	assert.ok(!JSON.stringify(status).includes("private"));
});
