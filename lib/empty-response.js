/**
 * 空回复兜底。
 *
 * Claude 5+ 在签名前缀失配、或单纯抽风时，会返回一条**只有 thinking、没有任何
 * 正文和工具调用**的消息，stop_reason 却是 end_turn。DSH 的判空条件看的是
 * `content.length === 0`，这种「有 thinking 块但没有内容」的响应会一路被当成
 * 正常完成 —— 界面上就是「已完成」加一片空白。
 *
 * 这里做两件事：
 *  1. 首轮事件先缓冲，确认这一轮真的产出了正文或工具调用再放行；
 *  2. 确实什么都没有就原样重发一次（同样的上下文，不改前缀，缓存还能命中）；
 *     第二次还是空，就交一个明确错误上去，至少让用户看到失败而不是「完成」。
 *
 * @param {(attempt: number) => AsyncIterable} createStream 每次尝试新建事件流。
 * @param {{ signal?: AbortSignal }} [options] 取消信号；已取消则不重试。
 * @returns {AsyncIterable} 处理后的事件流。
 */
export async function* recoverEmptyResponse(createStream, options = {}) {
	const signal = options.signal;
	const aborted = () => signal?.aborted === true;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (aborted()) return;
		let pending = [];
		let meaningful = false;
		let retry = false;

		for await (const event of createStream(attempt)) {
			if (event?.type === "done") {
				const message = event.message;
				if (!meaningful && !hasContent(message)) {
					if (attempt === 0 && !aborted()) {
						retry = true;
						break;
					}
					yield* pending;
					yield {
						type: "error",
						error: {
							...message,
							stopReason: "error",
							errorMessage:
								"Claude 连续两次返回空回复（只有思考、没有正文或工具调用）。可以重试，或换一个模型继续。"
						}
					};
					return;
				}
				yield* pending;
				yield event;
				return;
			}
			if (event?.type === "error") {
				yield* pending;
				yield event;
				return;
			}
			if (!meaningful && isMeaningful(event)) {
				meaningful = true;
				yield* pending;
				pending = [];
			}
			if (meaningful) yield event;
			else pending.push(event);
		}

		// 流在没给出 done/error 的情况下结束：交给上层按 STREAM_CLOSED 处理。
		if (!retry) {
			yield* pending;
			return;
		}
	}
}

/** 这一轮到底有没有产出：正文（非空）或工具调用。 */
function hasContent(message) {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content.some(
		(block) =>
			block?.type === "toolCall" ||
			(block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
	);
}

/** 流里的「有效产出」事件：开始调用工具，或真正吐出了非空正文。 */
function isMeaningful(event) {
	switch (event?.type) {
		case "toolcall_start":
			return true;
		case "text_delta":
			return typeof event.delta === "string" && event.delta.trim() !== "";
		case "text_end":
			return typeof event.content === "string" && event.content.trim() !== "";
		default:
			return false;
	}
}
