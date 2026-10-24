/**
 * 上下文落地层。
 *
 * pi-ai 1.1.0 的 anthropic 分支只从 `context.messages` 里取 system 文本与工具
 * 声明（`buildParams` 读 `initialSystemText` / `getCurrentTools(messages)`），
 * 完全不看 `context.systemPrompt` 与 `context.tools`。DSH 的 PiAiAdapter 恰好
 * 只往这两个字段里放初始提示词和工具，于是走 anthropic 路由时系统提示与工具
 * 会被静默丢掉（实测：请求体里既没有 system 也没有 tools）。
 *
 * 这里在调用 pi-ai 之前把它们物化成首条 system 消息：文本进 content，
 * 工具进 toolsAdded。pi-ai 的 `getInitialSystemMessage` / `getCurrentTools`
 * 认的就是这个形状，后续 conversationMessages 会把它 slice 掉，不会污染对话。
 */

/** 是否已经是 pi-ai 认的初始 system 消息。 */
function isSystem(message) {
	return message?.role === "system";
}

/** 归一化 content 为 blocks 数组。 */
function blocksOf(message) {
	if (Array.isArray(message?.content)) return message.content;
	if (typeof message?.content === "string" && message.content !== "") return [{ type: "text", text: message.content }];
	return [];
}

/**
 * 把 systemPrompt / tools 物化进 messages。
 * @param {object} context pi-ai 的 Context。
 * @returns {object} 新的 Context；本来就空则原样返回。
 */
export function materializeContext(context) {
	if (context === null || typeof context !== "object") return context;
	const prompt = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
	const tools = Array.isArray(context.tools) ? context.tools : [];
	if (prompt === "" && tools.length === 0) return context;

	const messages = Array.isArray(context.messages) ? context.messages : [];
	const [first, ...rest] = messages;
	const headBlocks = prompt === "" ? [] : [{ type: "text", text: prompt }];

	if (isSystem(first)) {
		const merged = {
			...first,
			content: [...headBlocks, ...blocksOf(first)],
			...tools.length > 0 && first.toolsAdded === undefined ? { toolsAdded: tools } : {}
		};
		return { ...context, systemPrompt: undefined, messages: [merged, ...rest] };
	}
	return {
		...context,
		systemPrompt: undefined,
		messages: [{ role: "system", content: headBlocks, timestamp: 0, ...(tools.length > 0 ? { toolsAdded: tools } : {}) }, ...messages]
	};
}
