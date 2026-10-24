/**
 * 文本流处理：Claude 5+ 有时把工具调用写成正文文本
 * （`<invoke name="web_search"><parameter name="query">…</parameter></invoke>`）。
 *
 * 处理分三步：
 *  1. `<invoke>` 标签本身不显示 —— 流里吞掉，并同步改写
 *     `partial.content[i].text`，保证界面与会话记录都不留 XML；
 *  2. 正文里确实有完整的 `<invoke>` 调用块时，把它**转换成真正的工具调用**
 *     （合成 pi-ai 的 toolcall_start / toolcall_delta / toolcall_end 事件），
 *     这样工具会真的执行，而不是变成一段没人理会的文字；
 *  3. 调用出现之后的正文**全部丢弃**。那部分内容是模型在还没拿到工具结果时
 *     凭想象写的（例如「联网工具全都没返回，没法下结论」），真结果回来以后
 *     必然自相矛盾，只会误导用户。保留调用之前的那句开场白。
 *
 * 注意：这里改写了 assistant 正文，签名绑定的前缀会失配。因此 provider 层必须
 * 让请求带上 `thinking.block_binding.prefix_mismatch_behavior = "drop_block"`
 * （见 fingerprint.js 的说明），否则下一轮会被拒或返回空回复。
 */

const OPEN = "<invoke";
const CLOSE = "</invoke>";

function holdOpenTail(buf) {
	for (let size = Math.min(OPEN.length - 1, buf.length); size > 0; size -= 1) {
		if (OPEN.startsWith(buf.slice(buf.length - size))) return size;
	}
	return 0;
}

function holdCloseTail(buf) {
	for (let size = Math.min(CLOSE.length - 1, buf.length); size > 0; size -= 1) {
		if (CLOSE.startsWith(buf.slice(buf.length - size))) return size;
	}
	return 0;
}

/**
 * 从文本里解析出 `<invoke>` 调用块。只有闭合的调用才算数：
 * 被截断的生成不能拿去执行。
 * @param {string} text 原始文本。
 * @returns {Array<{ name: string, arguments: object }>} 解析结果。
 */
export function parseInvokeCalls(text) {
	if (typeof text !== "string" || !text.includes(OPEN)) return [];
	const calls = [];
	const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
	const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
	let match;
	while ((match = invokeRe.exec(text)) !== null) {
		const name = match[1].trim();
		const body = match[2] ?? "";
		const args = {};
		let param;
		paramRe.lastIndex = 0;
		while ((param = paramRe.exec(body)) !== null) args[param[1].trim()] = coerce(param[2]);
		// 手写的旧式调用用 query；宿主 schema 要 queries[]。
		if (name === "web_search" && args.queries === undefined && typeof args.query === "string") {
			args.queries = [args.query];
			delete args.query;
		}
		if (name !== "") calls.push({ name, arguments: args });
		if (match[0].length === 0) break;
	}
	return calls;
}

/** 参数值尽量还原类型（纯数字/布尔/JSON 对象按字面量解析）。 */
function coerce(raw) {
	const text = String(raw ?? "").trim();
	if (text === "") return "";
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

/** 创建一个文本过滤器：返回可见文本，并记录被吞掉的 XML。 */
export function createInvokeFilter() {
	let pending = "";
	let dropping = false;
	let cleaned = "";
	let dropped = "";
	let raw = "";

	const push = (chunk, final = false) => {
		raw += typeof chunk === "string" ? chunk : "";
		pending += typeof chunk === "string" ? chunk : "";
		let out = "";
		for (;;) {
			if (dropping) {
				const close = pending.indexOf(CLOSE);
				if (close >= 0) {
					dropped += pending.slice(0, close + CLOSE.length);
					pending = pending.slice(close + CLOSE.length);
					dropping = false;
					continue;
				}
				const hold = final ? 0 : holdCloseTail(pending);
				dropped += hold === 0 ? pending : pending.slice(0, pending.length - hold);
				pending = hold === 0 ? "" : pending.slice(pending.length - hold);
				break;
			}
			const open = pending.indexOf(OPEN);
			if (open < 0) {
				const hold = final ? 0 : holdOpenTail(pending);
				out += hold === 0 ? pending : pending.slice(0, pending.length - hold);
				pending = hold === 0 ? "" : pending.slice(pending.length - hold);
				break;
			}
			out += pending.slice(0, open);
			pending = pending.slice(open);
			dropping = true;
		}
		if (final && !dropping) {
			out += pending;
			pending = "";
		}
		cleaned += out;
		return out;
	};

	return { push, cleaned: () => cleaned, dropped: () => dropped, raw: () => raw };
}

/** 找不到任何正文时的占位符：anthropic 拒绝空 text 块。 */
const PLACEHOLDER = "（调用工具）";

/**
 * 包一层 pi-ai 的事件流：
 *  - 吞掉正文里的 `<invoke>` 标签；
 *  - 把完整的调用块转成真正的工具调用事件；
 *  - 丢掉调用之后的「想象出来的结论」。
 * @param {AsyncIterable} stream pi-ai 的 AssistantMessageEventStream。
 * @param {{ convert?: boolean }} [options] convert=false 时只做隐藏、不转换。
 * @returns {AsyncIterable} 处理后的事件流。
 */
export function filterInvokeText(stream, options = {}) {
	const convert = options.convert !== false;
	/** 每个 text 块的原始文本。 */
	const raws = new Map();
	/** 每个 text 块已经流式发出去的可见前缀长度。 */
	const emitted = new Map();
	/** 每个 text 块最终的可见文本。 */
	const finals = new Map();
	let pendingCalls = [];
	/** 已经出现过工具调用（原生或合成）：之后的正文一律不算数。 */
	let toolBoundary = false;
	let hasNative = false;
	let synthesised = 0;
	/** convert=false 分支里每个 text 块的遮蔽器。 */
	const hidden = new Map();

	function* synth(partial, calls) {
		for (const call of calls) {
			const block = {
				type: "toolCall",
				id: `call_cc_${Date.now().toString(36)}_${++synthesised}`,
				name: call.name,
				arguments: call.arguments
			};
			partial.content.push(block);
			const contentIndex = partial.content.length - 1;
			yield { type: "toolcall_start", contentIndex, partial };
			yield { type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial };
			yield { type: "toolcall_end", contentIndex, toolCall: block, partial };
		}
	}

	async function* run() {
		for await (const event of stream) {
			if (event?.type === "toolcall_start") {
				hasNative = true;
				if (convert) toolBoundary = true;
				yield event;
				continue;
			}
			if (event?.type === "text_delta") {
				const index = event.contentIndex ?? 0;
				const raw = (raws.get(index) ?? "") + (event.delta ?? "");
				raws.set(index, raw);
				if (!convert) {
					let filter = hidden.get(index);
					if (filter === undefined) {
						filter = createInvokeFilter();
						hidden.set(index, filter);
					}
					const visible = filter.push(event.delta ?? "", false);
					if (visible === "") continue;
					emitted.set(index, (emitted.get(index) ?? "") + visible);
					yield { ...event, delta: visible };
					continue;
				}
				if (toolBoundary) continue; // 调用之后的正文直接丢弃
				/*
				 * 逐段放出「安全前缀」：`<invoke` 之前的正文照常实时显示，
				 * 从可能出现标签的位置起先扣住，等 text_end 再判定。
				 */
				const open = raw.indexOf(OPEN);
				const safe = open >= 0 ? raw.slice(0, open) : raw.slice(0, raw.length - holdOpenTail(raw));
				const shown = emitted.get(index) ?? "";
				const delta = safe.slice(shown.length);
				emitted.set(index, safe);
				if (delta !== "") yield { ...event, delta };
				continue;
			}
			if (event?.type === "text_end") {
				const index = event.contentIndex ?? 0;
				const raw = raws.get(index) ?? event.content ?? "";
				let visible;
				if (!convert) {
					const filter = hidden.get(index) ?? createInvokeFilter();
					filter.push("", true);
					visible = filter.cleaned();
					hidden.delete(index);
					if (visible.trim() === "" && raw.trim() !== "") visible = raw;
				} else {
					/*
					 * 调用可以跨多个文本块（模型常常一块一个 <invoke>），所以每一块都要解析。
					 * 一旦出现过调用，之后的正文一律丢弃。
					 */
					const calls = parseInvokeCalls(raw);
					if (toolBoundary) {
						if (calls.length > 0) pendingCalls.push(...calls);
						visible = "";
					} else if (calls.length > 0) {
						visible = raw.slice(0, raw.indexOf(OPEN));
						pendingCalls.push(...calls);
						toolBoundary = true;
					} else {
						const filter = createInvokeFilter();
						filter.push(raw, true);
						const cleaned = filter.cleaned();
						visible = cleaned.trim() === "" && raw.trim() !== "" ? raw : cleaned;
					}
				}
				/*
				 * anthropic 拒绝空 text 块，所以清空过的块要留点东西：
				 * 第一个（也就是承载调用的那块）给一句占位，之后的块只留一个空格。
				 */
				if (convert && visible === "" && toolBoundary) visible = finals.size === 0 ? PLACEHOLDER : " ";
				finals.set(index, visible);
				const block = event.partial?.content?.[index];
				if (block?.type === "text") block.text = visible;
				const rest = visible.slice((emitted.get(index) ?? "").length);
				if (rest !== "") yield { type: "text_delta", contentIndex: index, delta: rest, partial: event.partial };
				// toStreamChunks 读的是 event.content，两个地方必须一致
				yield { ...event, content: visible };
				continue;
			}
			if (event?.type === "done") {
				const message = event.message;
				for (const [index, text] of finals) {
					const block = message.content[index];
					if (block?.type === "text") block.text = text;
				}
				for (const block of message.content) if (block?.type === "toolCall") hasNative = true;
				/*
				 * 合成的调用只能追加在末尾：上游的 contentIndex 已经用掉了前面的位置，
				 * 插进去会撞 block-start/block-end 的序号。
				 * 生成被截断（length）或失败（error/aborted）时不执行，避免拿半截参数跑工具。
				 */
				const runnable = ["stop", "toolUse"].includes(message.stopReason);
				if (convert && !hasNative && pendingCalls.length > 0 && runnable) {
					yield* synth(message, pendingCalls);
					message.stopReason = "toolUse";
					yield { ...event, reason: "toolUse", message };
					continue;
				}
				// 有原生调用却说 stop：结束原因跟着实际情况走
				if (convert && hasNative && message.stopReason === "stop") {
					message.stopReason = "toolUse";
					yield { ...event, reason: "toolUse", message };
					continue;
				}
				yield event;
				continue;
			}
			yield event;
		}
	}

	return run();
}
