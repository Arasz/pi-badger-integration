/** Pure mapping between pi tool_result events and rtk's Claude-shaped PostToolUse payload. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

/** Bodies shorter than this pass untouched, matching rtk's `guards.min_size`. */
export const MIN_POSTHOOK_CHARS = 512;
/** `rtk …` commands are already compressed; only output this large is worth a second pass. */
export const RTK_COMMAND_MIN_CHARS = 20_000;

export type HookPayload = {
	hook_event_name: "PostToolUse";
	session_id: string;
	tool_use_id: string;
	cwd: string;
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_response: Record<string, unknown>;
};

export type HookRequest = { payload: HookPayload; trailer: string; bodyChars: number };

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const EXIT_LINE = /\n\nCommand exited with code -?\d+$/;
const NOTICE =
	/\n\n\[(?:Showing (?:lines|last) |\d+ more lines in file|\d+ matches limit reached|[^\]\n]*limit reached|Some lines truncated|Line \d+ is )[^\n]*\]$/;

/** Splits pi's appended status lines (exit code, then one truncation notice) off the end of a result. */
function splitTrailer(tool: string, full: string): { body: string; trailer: string } {
	let body = full;
	if (tool === "bash" || tool === "powershell") body = body.replace(EXIT_LINE, "");
	if (tool !== "find" && tool !== "ls" && !tool.startsWith("mcp__")) body = body.replace(NOTICE, "");
	return { body, trailer: full.slice(body.length) };
}

function textBlocks(event: ToolResultEvent): string[] | undefined {
	const texts: string[] = [];
	for (const block of event.content) {
		if (block.type !== "text") return undefined;
		texts.push(block.text);
	}
	return texts;
}

/** Resolves a read path the way pi's read tool does: strip a leading `@`, expand `~`, then resolve against cwd. */
function resolveReadPath(path: string, cwd: string, home: string): string {
	const p = path.startsWith("@") ? path.slice(1) : path;
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return resolve(cwd, p);
}

/** True when any command in a (possibly compound, env-prefixed) shell line is an `rtk …` invocation. */
const RTK_COMMAND = /(^|&&|;|\|\|?)\s*(\w+=\S+\s+)*rtk\s/;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Builds the PostToolUse payload for one tool result, or undefined when rtk should not see it. */
export function toHookPayload(event: ToolResultEvent, cwd: string, env: Env, home = homedir()): HookRequest | undefined {
	if (env.RTK_DISABLED === "1" || event.parentToolCallId) return undefined;
	const tool = event.toolName;
	const input = isRecord(event.input) ? event.input : {};
	const isShell = tool === "bash" || tool === "powershell";
	const isMcp = tool.startsWith("mcp__");
	if (!isShell && !isMcp && tool !== "read" && tool !== "grep") return undefined;
	if (isShell && event.isError && event.structuredContent === undefined) return undefined;
	const blocks = textBlocks(event);
	if (!blocks) return undefined;

	const { body, trailer } = splitTrailer(tool, blocks.join("\n"));
	if (body.length < MIN_POSTHOOK_CHARS) return undefined;

	let name: string;
	let toolInput: Json;
	let toolResponse: Json;
	if (isShell) {
		const command = input.command;
		if (typeof command !== "string") return undefined;
		if (RTK_COMMAND.test(command.trimStart()) && body.length < RTK_COMMAND_MIN_CHARS) return undefined;
		name = "Bash";
		toolInput = { command };
		toolResponse = { stdout: body, stderr: "", interrupted: false };
	} else if (tool === "read") {
		if (typeof input.path !== "string") return undefined;
		const filePath = resolveReadPath(input.path, cwd, home);
		name = "Read";
		toolInput = { file_path: filePath };
		toolResponse = { type: "text", file: { filePath, content: body } };
	} else if (tool === "grep") {
		if (typeof input.pattern !== "string") return undefined;
		name = "Grep";
		toolInput = { pattern: input.pattern, path: typeof input.path === "string" ? input.path : "." };
		toolResponse = { mode: "content", content: body };
	} else {
		name = tool;
		toolInput = input;
		toolResponse = { content: blocks.map((text) => ({ type: "text", text })) };
	}

	return {
		payload: {
			hook_event_name: "PostToolUse",
			session_id: "",
			tool_use_id: event.toolCallId,
			cwd,
			tool_name: name,
			tool_input: toolInput,
			tool_response: toolResponse,
		},
		trailer,
		bodyChars: body.length,
	};
}

/** Pulls the compressed text out of rtk's `updatedToolOutput` for the given pi tool. */
function replacedText(tool: string, out: Json): string | undefined {
	if (tool === "bash" || tool === "powershell") return typeof out.stdout === "string" ? out.stdout : undefined;
	if (tool === "read") return isRecord(out.file) && typeof out.file.content === "string" ? out.file.content : undefined;
	if (tool === "grep") return typeof out.content === "string" ? out.content : undefined;
	if (!tool.startsWith("mcp__") || !Array.isArray(out.content)) return undefined;
	const texts: string[] = [];
	for (const part of out.content) {
		if (!isRecord(part) || typeof part.text !== "string") return undefined;
		texts.push(part.text);
	}
	return texts.join("\n");
}

/** Maps rtk's reply to a tool_result patch, or undefined to keep the original result. */
export function fromHookOutput(
	stdout: string,
	code: number,
	killed: boolean,
	event: ToolResultEvent,
	trailer: string,
): ToolResultEventResult | undefined {
	if (killed || code !== 0 || !stdout.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.hookSpecificOutput)) return undefined;
	const updated = parsed.hookSpecificOutput.updatedToolOutput;
	if (!isRecord(updated)) return undefined;
	const body = replacedText(event.toolName, updated);
	if (!body?.trim()) return undefined;

	const blocks = textBlocks(event);
	if (!blocks) return undefined;
	const original = blocks.join("\n");
	const next = body + trailer;
	if (next === original || next.length > original.length) return undefined;

	const details = isRecord((event as { details?: unknown }).details) ? (event as { details: Json }).details : {};
	const result: ToolResultEventResult = {
		content: [{ type: "text", text: next }],
		details: { ...details, rtk: { from: original.length, to: next.length } },
	};
	if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
	return result;
}
