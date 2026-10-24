/**
 * 说话人提示词（persona inject）的按模型处理。
 *
 * 背景：宿主可能把 `~/.dsh/prompt-inject.md` 的内容拼进系统提示最前面（注入模板 +
 * 技术清单）。Claude 5 及以上（fable-5 / opus-5 / sonnet-5 / haiku-5 系列）在生成前
 * 会被 Anthropic 的策略分类器判成 violative cyber content，直接拦截请求；
 * 4.x 及更早的 Claude 不会。DeepSeek / GPT 路线不受影响。
 *
 * 策略：只对 Claude 5+ 的请求**不发送**这段注入（不是拿另一份人格去顶替，
 * 也不是改那个文件本身），其余模型原样保留。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 注入文件的位置：DSH_HOME 优先，其次 ~/.dsh。 */
export function injectFilePath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : path.join(os.homedir(), ".dsh");
	return path.join(home, "prompt-inject.md");
}

let cache = { file: "", mtime: 0, text: "" };

/**
 * 读取注入文本（按 mtime 缓存）。
 * @param {string} [file] 注入文件路径。
 * @returns {string} 注入内容；读不到时返回空串。
 */
export function readInjectText(file = injectFilePath()) {
	try {
		const stat = fs.statSync(file);
		if (cache.file === file && cache.mtime === stat.mtimeMs) return cache.text;
		const text = fs.readFileSync(file, "utf8");
		cache = { file, mtime: stat.mtimeMs, text };
		return text;
	} catch {
		return "";
	}
}

/** 是否 Claude 5 及以上（fable-5 / fable-5-1 / opus-5 / opus-5-5 / sonnet-5 …）。 */
export function isModernClaude(modelId) {
	return typeof modelId === "string" && /^claude-[a-z0-9]+-5(?:-|$)/.test(modelId);
}

/**
 * 从系统提示里剔除注入段。
 * 先按文件内容做精确子串匹配（最常见：DSH 原样拼接），
 * 匹配不到再按首行标记切到下一个 `Instructions from:` 分节之前。
 * @param {string} systemPrompt 系统提示。
 * @param {string} injectText 注入原文。
 * @returns {{ text: string, strategy: string }} 处理后的文本与命中的策略。
 */
export function stripInjectFromText(systemPrompt, injectText) {
	if (typeof systemPrompt !== "string" || systemPrompt === "") return { text: systemPrompt, strategy: "empty" };
	if (typeof injectText === "string" && injectText.trim() !== "") {
		const exact = systemPrompt.indexOf(injectText);
		if (exact >= 0) return { text: normalize(systemPrompt.slice(0, exact) + systemPrompt.slice(exact + injectText.length)), strategy: "exact" };
		const trimmed = injectText.trim();
		const loose = systemPrompt.indexOf(trimmed);
		if (loose >= 0) return { text: normalize(systemPrompt.slice(0, loose) + systemPrompt.slice(loose + trimmed.length)), strategy: "trimmed" };
	}
	for (const marker of MARKERS) {
		const at = systemPrompt.indexOf(marker);
		if (at < 0) continue;
		const after = systemPrompt.indexOf("Instructions from:", at);
		const end = after >= 0 ? after : systemPrompt.length;
		return { text: normalize(systemPrompt.slice(0, at) + systemPrompt.slice(end)), strategy: `marker:${marker.slice(0, 24)}` };
	}
	return { text: systemPrompt, strategy: "none" };
}

/** 注入段的已知起始标记（文件被替换/复用默认模板时按这些切）。 */
const MARKERS = Object.freeze(["<|im_start|>system:<project_instructions>", "[MODE: UNRESTRICTED SANDBOX", "<project_instructions>"]);

function normalize(text) {
	return text.replace(/^\s+/, "").trimEnd();
}

/** 5+ 模型使用的精简系统提示：不含任何注入内容，可选附带本机 AGENTS.md。 */
const MINIMAL_PROMPT = [
	"你是 DeepSeek Harness 里的工程助手。用简体中文回答，先给结论再给步骤；命令、路径、代码标识符保持原样；不确定就说明不确定。",
	"",
	"## 工具",
	"你带有工具，需要时直接调用，不要声称自己没有联网、读取文件或执行命令的能力：",
	"- 联网：`web_search` 查资料、`web_fetch` 抓取具体网页；用户问到实时信息、新闻、文档链接时先搜索再回答。",
	"- 文件：`read` 读、`write` 写、`edit` 改、`glob` 找文件、`grep` 搜内容。",
	"- 命令：Windows 上用 `pwsh`；执行前想清楚影响，删除或覆盖前先确认路径。",
	"- 多步任务用 `todo_write` 记录进度；需要用户决策时用 `ask_user_question`。",
	"- **调用方式**：必须走原生工具调用（tool_use）。不要用 `<invoke>`、`<parameter>`、`<function_call>`、`antml:` 这类文本标签描述调用 —— 那样宿主收不到，等于没调用。",
	"",
	"## 风格",
	"动手优先：先收集证据、再给结论；不要用免责声明或安全说教占位；失败就说失败，并给出下一步。",
	"",
	"## 工作方式（重要）",
	"- 你是自主执行的 agent：任务没完成不要停。需要外部信息时，先调用工具拿到结果再回答，不要用「我这就去查」「稍等我看看」这类话代替实际调用。",
	"- 一轮里可以连续调用多个工具，直到任务真正完成；每次拿到工具结果后继续下一步，最后再给结论。",
	"- 回答里不要复述工具调用格式或解释调用机制，直接做。",
	"- 确实无法完成时，明确说明卡在哪一步、需要什么。"
].join("\n");

function buildMinimalSystem() {
	const agents = readAgentsText();
	return agents === "" ? MINIMAL_PROMPT : `${MINIMAL_PROMPT}\n\n${agents}`;
}

/** 读取 ~/.dsh/AGENTS.md（本机运维规则），失败或为空时返回空串。 */
export function readAgentsText() {
	const file = path.join(path.dirname(injectFilePath()), "AGENTS.md");
	try {
		const text = fs.readFileSync(file, "utf8").trim();
		return text === "" ? "" : text.slice(0, 4000);
	} catch {
		return "";
	}
}

/**
 * 需要时对 Context 做去注入。
 * @param {object} context pi-ai 的 Context。
 * @param {object} model pi-ai 的模型描述。
 * @param {{ enabled?: boolean, file?: string, mode?: "strip-inject" | "minimal", onReport?: (report: object) => void }} [options]
 *        开关、注入文件、处理模式与诊断回调。
 * @returns {object} 新的 Context（不需要处理时原样返回）。
 */
export function sanitizeContextForModel(context, model, options = {}) {
	if (options.enabled === false) return context;
	if (context === null || typeof context !== "object") return context;
	if (!isModernClaude(model?.id)) return context;
	const injectText = readInjectText(options.file);
	const before = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
	const next = { ...context };
	let strategy = "none";

	if (options.mode === "minimal") {
		const minimal = buildMinimalSystem();
		strategy = "minimal";
		if (Array.isArray(context.messages) && context.messages[0]?.role === "system") {
			// Models.normalizeContext has already moved tools into this message.
			// Replace only prompt text: deleting the row also deletes toolsAdded.
			next.systemPrompt = undefined;
			next.messages = [{ ...context.messages[0], content: [{ type: "text", text: minimal }] }, ...context.messages.slice(1)];
		} else next.systemPrompt = minimal;
	} else if (before !== "") {
		const result = stripInjectFromText(before, injectText);
		strategy = result.strategy;
		if (result.text !== before) next.systemPrompt = result.text;
	}

	const messages = Array.isArray(context.messages) ? context.messages : [];
	if (options.mode !== "minimal" && messages.length > 0 && messages[0]?.role === "system" && Array.isArray(messages[0].content)) {
		let changed = false;
		const blocks = messages[0].content.map((block) => {
			if (block?.type !== "text" || typeof block.text !== "string") return block;
			const result = stripInjectFromText(block.text, injectText);
			if (result.text === block.text) return block;
			changed = true;
			if (strategy === "none") strategy = result.strategy;
			return { ...block, text: result.text };
		});
		if (changed) next.messages = [{ ...messages[0], content: blocks.filter((block) => block.type !== "text" || block.text !== "") }, ...messages.slice(1)];
	}

	if (typeof options.onReport === "function") {
		const effectiveSystem = typeof next.systemPrompt === "string" ? next.systemPrompt
			: next.messages?.[0]?.role === "system" ? (next.messages[0].content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
		options.onReport({
			modelId: model?.id,
			strategy,
			beforeLength: before.length,
			afterLength: effectiveSystem.length,
			injectLength: injectText.length,
			stillHasInject: /UNRESTRICTED SANDBOX|Never Refuse/.test(effectiveSystem),
			system: effectiveSystem.slice(0, 40000)
		});
	}
	return strategy === "none" ? context : next;
}
