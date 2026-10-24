import { test } from "node:test";
import assert from "node:assert/strict";
import { filterInvokeText, parseInvokeCalls } from "../lib/text-filter.js";
import { recoverEmptyResponse } from "../lib/empty-response.js";
import { createSubscriptionProvider, stripReasoning } from "../lib/fingerprint.js";

const INVOKE = (name = "web_search", param = "query", value = "Tokyo") =>
	`<invoke name="${name}"><parameter name="${param}">${value}</parameter></invoke>`;

/** 把一个字符串按逐字符切碎喂进流，模拟分块到达的 SSE。 */
function scripted(texts, { native = false, stop = "stop", error = null } = {}) {
	const message = { content: [], stopReason: "stop", model: "claude-fable-5-1" };
	async function* source() {
		for (const text of texts) {
			const index = message.content.length;
			message.content.push({ type: "text", text: "" });
			yield { type: "text_start", contentIndex: index, partial: message };
			for (const ch of text) {
				message.content[index].text += ch;
				yield { type: "text_delta", contentIndex: index, delta: ch, partial: message };
			}
			yield { type: "text_end", contentIndex: index, content: text, partial: message };
		}
		if (native) {
			const contentIndex = message.content.length;
			const toolCall = { type: "toolCall", id: "native_1", name: "web_fetch", arguments: { url: "https://example.com" } };
			message.content.push(toolCall);
			yield { type: "toolcall_start", contentIndex, partial: message };
			yield { type: "toolcall_delta", contentIndex, delta: "{}", partial: message };
			yield { type: "toolcall_end", contentIndex, toolCall, partial: message };
		}
		message.stopReason = stop;
		if (error) yield { type: "error", error: { ...message, stopReason: "error", errorMessage: error } };
		else yield { type: "done", reason: stop, message };
	}
	return source();
}

async function collect(stream, options = {}) {
	const events = [];
	let partial;
	for await (const event of filterInvokeText(stream, options)) {
		events.push(structuredClone(event));
		partial = event.partial ?? partial;
	}
	return {
		events,
		partial,
		visible: events.filter((e) => e.type === "text_delta").map((e) => e.delta).join(""),
		calls: events.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall),
		textEnds: events.filter((e) => e.type === "text_end").map((e) => e.content),
		done: events.find((e) => e.type === "done" || e.type === "error")
	};
}

test("同一块里的「凭空结论」被丢掉，调用照常执行", async () => {
	const r = await collect(scripted([`我先查一下。${INVOKE()}工具全都没返回，没法判断。`]));
	assert.equal(r.visible, "我先查一下。");
	assert.equal(r.calls.length, 1);
	assert.deepEqual(r.calls[0].arguments, { queries: ["Tokyo"] });
	assert.equal(r.done.type, "done");
	assert.equal(r.done.message.stopReason, "toolUse");
	assert.equal(r.textEnds[0], "我先查一下。");
});

test("调用之后的后续文本块整块丢弃", async () => {
	const r = await collect(scripted([INVOKE(), "工具全都没返回，没法判断。"]));
	assert.equal(r.visible.trim(), "（调用工具）");
	assert.ok(!JSON.stringify(r.events).includes("没法判断"));
	assert.equal(r.calls.length, 1);
});

test("多个手写调用跨块也能收集全，且 id 不重复", async () => {
	const r = await collect(scripted([`${INVOKE("web_fetch", "url", "https://a.example")}`, `${INVOKE("web_fetch", "url", "https://b.example")}`]));
	assert.equal(r.calls.length, 2);
	assert.equal(new Set(r.calls.map((c) => c.id)).size, 2);
	assert.equal(r.calls[0].arguments.url, "https://a.example");
});

test("普通回答原样通过，不做任何改写", async () => {
	const r = await collect(scripted(["明天东京下雨，", "但不会有台风。"]));
	assert.equal(r.visible, "明天东京下雨，但不会有台风。");
	assert.equal(r.done.message.stopReason, "stop");
	assert.equal(r.calls.length, 0);
});

test("原生 tool_use 不会被合成调用重复一遍", async () => {
	const r = await collect(scripted([INVOKE()], { native: true, stop: "toolUse" }));
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].id, "native_1");
});

test("没闭合的 <invoke> 不执行，正文保留", async () => {
	const broken = INVOKE().replace("</invoke>", "");
	assert.deepEqual(parseInvokeCalls(broken), []);
	const r = await collect(scripted([`正文${broken}`]));
	assert.equal(r.calls.length, 0);
	assert.equal(r.textEnds[0], "正文");
	assert.equal(r.done.type, "done");
	assert.equal(r.done.message.stopReason, "stop");
});

test("被截断（length）的生成不执行半截调用", async () => {
	const r = await collect(scripted([INVOKE()], { stop: "length" }));
	assert.equal(r.calls.length, 0);
	assert.equal(r.done.message.stopReason, "length");
});

test("convert=false 只隐藏标签，不转换也不吞正文", async () => {
	const r = await collect(scripted([`前缀${INVOKE()}后缀`]), { convert: false });
	assert.equal(r.visible, "前缀后缀");
	assert.equal(r.calls.length, 0);
});

test("event.content 与 partial 的文本块保持一致（DSH 读的是 event.content）", async () => {
	const r = await collect(scripted([`开场白${INVOKE()}胡说`]));
	assert.equal(r.textEnds[0], "开场白");
	assert.equal(r.partial.content[0].text, "开场白");
});

test("已有的 queries 数组优先于 query", () => {
	const calls = parseInvokeCalls('<invoke name="web_search"><parameter name="queries">["a","b"]</parameter></invoke>');
	assert.deepEqual(calls[0].arguments, { queries: ["a", "b"] });
});

// ---- 空回复兜底 ----

function emptyThen(contents, { abort = false } = {}) {
	let calls = 0;
	const make = (text) => async function* () {
		calls += 1;
		const message = { content: [], stopReason: "stop", model: "claude-fable-5-1" };
		if (text === null) {
			message.content.push({ type: "reasoning", text: "" });
		} else {
			message.content.push({ type: "text", text });
			yield { type: "text_delta", contentIndex: 0, delta: text, partial: message };
		}
		yield { type: "done", reason: "stop", message };
	};
	const attempts = [];
	const controller = new AbortController();
	if (abort) controller.abort();
	return {
		stream: recoverEmptyResponse((attempt) => {
			attempts.push(attempt);
			return make(contents[Math.min(attempt, contents.length - 1)])();
		}, { signal: controller.signal }),
		count: () => calls,
		attempts
	};
}

test("空回复（只有 thinking）会重发一次并拿到正文", async () => {
	const t = emptyThen([null, "明天东京下雨，没有台风。"]);
	const events = [];
	for await (const e of t.stream) events.push(e);
	assert.equal(t.count(), 2);
	assert.equal(t.attempts.length, 2);
	const texts = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
	assert.equal(texts, "明天东京下雨，没有台风。");
	assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("连续两次空回复 → 明确报错，不再假装完成", async () => {
	const t = emptyThen([null, null]);
	const events = [];
	for await (const e of t.stream) events.push(e);
	assert.equal(t.count(), 2);
	const err = events.find((e) => e.type === "error");
	assert.ok(err, "应当产出 error 事件");
	assert.equal(err.error.stopReason, "error");
	assert.match(err.error.errorMessage, /空回复/);
	assert.equal(events.filter((e) => e.type === "done").length, 0);
});

test("正常回复不触发重试", async () => {
	const t = emptyThen(["直接给结论"]);
	const events = [];
	for await (const e of t.stream) events.push(e);
	assert.equal(t.count(), 1);
	assert.equal(events.filter((e) => e.type === "done").length, 1);
});

test("已取消的请求不重试", async () => {
	const t = emptyThen([null, "不该走到这里"], { abort: true });
	const events = [];
	for await (const e of t.stream) events.push(e);
	assert.equal(events.length, 0);
	assert.equal(t.count(), 0);
});

// ---- provider 层参数 ----

const CATALOG_MODEL = {
	id: "claude-fable-5-1",
	api: "anthropic-messages",
	provider: "anthropic",
	reasoning: true,
	contextWindow: 1000000,
	thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
	compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, forceAdaptiveThinking: true }
};

function fakeProvider() {
	const seen = [];
	const base = {
		getModels: () => [structuredClone(CATALOG_MODEL)],
		stream(model, context, options) {
			seen.push(options);
			return scripted(["ok"]);
		},
		streamSimple(model, context, options) {
			seen.push(options);
			return scripted(["ok"]);
		}
	};
	const provider = createSubscriptionProvider(base, () => ({}), () => ({ filterNarration: true }));
	return { provider, seen };
}

test("provider 关掉 supportsMidConvoEffort（服务端拒绝 thinking.block_binding）", () => {
	const { provider } = fakeProvider();
	const model = provider.getModels()[0];
	assert.equal(model.compat.supportsMidConvoEffort, false);
	assert.equal(model.compat.supportsMidConvoSystemMessages, false);
	assert.equal(model.compat.supportsMidConvoToolChanges, false);
});

test("出站历史丢掉 thinking 块、空 text 块与空 system 消息", async () => {
	const context = {
		messages: [
			{ role: "system", content: [{ type: "text", text: "sys" }], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "问题" }], timestamp: 0 },
			{ role: "user", content: [], timestamp: 0 },
			{
				role: "assistant",
				timestamp: 0,
				content: [
					{ type: "reasoning", text: "", thinkingSignature: "sig-1" },
					{ type: "text", text: "我先查一下。" },
					{ type: "reasoning", text: "", thinkingSignature: "sig-2" },
					{ type: "text", text: " " },
					{ type: "toolCall", id: "call_1", name: "web_search", arguments: { queries: ["x"] } }
				]
			},
			{ role: "user", content: [{ type: "toolResult", toolCallId: "call_1", content: [] }], timestamp: 0 }
		]
	};
	const out = stripReasoning(context);
	assert.equal(out.messages.length, 4, "空 user 消息应被移除");
	const assistant = out.messages[2];
	assert.deepEqual(
		assistant.content.map((b) => b.type),
		["text", "toolCall"]
	);
	assert.equal(assistant.content[0].text, "我先查一下。");
	assert.equal(JSON.stringify(out).includes("thinkingSignature"), false);
});

test("assistant 被清空时保留占位，不产生空的非法消息", async () => {
	const out = stripReasoning({
		messages: [{ role: "assistant", content: [{ type: "reasoning", text: "", thinkingSignature: "s" }], timestamp: 0 }]
	});
	assert.equal(out.messages.length, 1);
	assert.deepEqual(out.messages[0].content, [{ type: "text", text: " " }]);
});

test("provider 不再自己加 thinkingEnabled:false（off:null 时会把 thinking 参数整个弄丢）", async () => {
	const { provider, seen } = fakeProvider();
	const context = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] };
	for await (const _ of provider.stream(provider.getModels()[0], context, { apiKey: "sk-ant-oat01-offline-only", reasoning: "high" })) {
		// drain
	}
	assert.equal(seen.length, 1);
	assert.equal(seen[0].thinkingEnabled, undefined);
	assert.equal(seen[0].reasoning, "high");
});
