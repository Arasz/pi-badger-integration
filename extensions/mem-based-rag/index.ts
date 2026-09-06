/**
 * Mem-based RAG extension: prompt-enriching retrieval on the ai-raccoon bank.
 *
 * Flow (f: 2026-09-06 contract): the `input` handler captures the RAW user
 * prompt (pre skill/template expansion); `before_agent_start` filters it
 * (rag-core.shouldEnrich — commands, control words, bare skill calls, thin
 * prompts skip) and, when it passes, searches the bank and injects a labelled
 * "Prompt context:" block as a message. The prompt itself is never rewritten.
 *
 * Transport: pi extensions cannot invoke MCP tools, so this extension speaks
 * MCP itself — a persistent `ai-raccoon --transport stdio` child (JSON-RPC,
 * line-delimited) spawned lazily on the first enrichable prompt and reaped at
 * session_shutdown. Measured 2026-09-06: spawn+init ~0.3 s (amortized), first
 * search ~4.5 s (model warm-up), steady ~0.4–0.5 s. Every search is bounded by
 * a timeout and fail-open: a slow or dead bank skips enrichment, never the turn.
 *
 * Agent memory is untouched: same server, separate call site — the agent keeps
 * its own memory_search tool; this only enriches the user prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	shouldEnrich,
	toExpandedMemoryContext,
	toMemoryContext,
	type MemoryHit,
} from "./rag-core.ts";

/** Custom message type of the injected context block. */
export const MEM_RAG_CUSTOM_TYPE = "mem-based-rag";

/** Human command: status + session-scoped mode override. */
export const MEM_RAG_COMMAND_NAME = "rag";

/** Kill switch: the literal string "0" disables the whole extension. */
export const MEM_RAG_ENV = "PI_BADGER_MEM_RAG";
export const MEM_RAG_MODE_ENV = "PI_BADGER_MEM_RAG_MODE";
export const MEM_RAG_MIN_WORDS_ENV = "PI_BADGER_MEM_RAG_MIN_WORDS";
export const MEM_RAG_MIN_CHARS_ENV = "PI_BADGER_MEM_RAG_MIN_CHARS";
export const MEM_RAG_TIMEOUT_ENV = "PI_BADGER_MEM_RAG_TIMEOUT_MS";
export const MEM_RAG_SNIPPET_ENV = "PI_BADGER_MEM_RAG_SNIPPET_CHARS";
export const MEM_RAG_BIN_ENV = "PI_BADGER_MEM_RAG_BIN";

export type PromptContextMode = "default" | "expanded";

interface PromptContextConfig {
	enabled: boolean;
	mode: PromptContextMode;
	minWords: number;
	minChars: number;
	timeoutMs: number;
	snippetChars: number;
	bin: string;
}

function numEnv(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw.trim());
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function readConfig(sessionMode: PromptContextMode | "off" | undefined): PromptContextConfig {
	const envMode = (process.env[MEM_RAG_MODE_ENV] ?? "default").trim().toLowerCase();
	const baseMode: PromptContextMode = envMode === "expanded" ? "expanded" : "default";
	return {
		enabled: process.env[MEM_RAG_ENV] !== "0" && sessionMode !== "off",
		mode: sessionMode === "default" || sessionMode === "expanded" ? sessionMode : baseMode,
		minWords: numEnv(MEM_RAG_MIN_WORDS_ENV, 8, 1, 100),
		minChars: numEnv(MEM_RAG_MIN_CHARS_ENV, 20, 0, 10000),
		timeoutMs: numEnv(MEM_RAG_TIMEOUT_ENV, 8000, 500, 60000),
		snippetChars: numEnv(MEM_RAG_SNIPPET_ENV, 300, 50, 2000),
		bin: process.env[MEM_RAG_BIN_ENV]?.trim() || join(homedir(), ".dotnet", "tools", "ai-raccoon"),
	};
}

/** Sender project: AI_BADGER_PROJECT_ID wins, else nearest .ai-badger/project-id above cwd. */
function resolveProjectId(cwd: string, env: Record<string, string | undefined>): string | null {
	const override = env.AI_BADGER_PROJECT_ID;
	if (typeof override === "string" && override.trim()) return override.trim();
	let dir = resolve(cwd);
	for (;;) {
		const aib = join(dir, ".ai-badger");
		if (existsSync(join(aib, "project-id"))) {
			try {
				const value = readFileSync(join(aib, "project-id"), "utf8").trim();
				if (value) return value;
			} catch {
				return null;
			}
			return null;
		}
		if (existsSync(aib)) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveSessionId(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) return id;
	} catch {
		// older build shape — fail-open below
	}
	return "";
}

// ---------------------------------------------------------------- MCP client

interface PendingCall {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal MCP client over a stdio child: initialize once, tools/call per
 * search. Single-flight via a promise chain so concurrent turns cannot
 * interleave lines on the pipe. Fail-open throughout — every failure is an
 * Error to the caller, which skips enrichment.
 */
class RaccoonClient {
	private proc: ChildProcess | null = null;
	private seq = 0;
	private readonly pending = new Map<number, PendingCall>();
	private buffer = "";
	private chain: Promise<void> = Promise.resolve();

	constructor(private readonly bin: string) {}

	private ensureStarted(): void {
		if (this.proc) return;
		const proc = spawn(this.bin, ["--transport", "stdio"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.proc = proc;
		proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
		proc.on("exit", () => {
			this.proc = null;
			for (const [, call] of this.pending) {
				clearTimeout(call.timer);
				call.reject(new Error("ai-raccoon child exited"));
			}
			this.pending.clear();
		});
		proc.on("error", () => {
			this.proc = null;
		});
	}

	private onData(text: string): void {
		this.buffer += text;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl < 0) return;
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			try {
				const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
				if (typeof msg.id !== "number") continue;
				const call = this.pending.get(msg.id);
				if (!call) continue;
				this.pending.delete(msg.id);
				clearTimeout(call.timer);
				if (msg.error) call.reject(new Error(`ai-raccoon: ${msg.error.message ?? "unknown error"}`));
				else {
					const content = (msg.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
					const textPart = content?.find((part) => part?.type === "text" && typeof part.text === "string")?.text;
					if (textPart === undefined) call.reject(new Error("ai-raccoon: empty tool result"));
					else call.resolve(textPart);
				}
			} catch {
				// a non-JSON line on stdout — ignore, keep framing on later lines
			}
		}
	}

	private send(method: string, params: unknown, id: number): void {
		this.ensureStarted();
		this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	}

	async initialize(): Promise<void> {
		this.ensureStarted();
		const id = ++this.seq;
		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("ai-raccoon initialize timed out"));
			}, 15000);
			this.pending.set(id, {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			});
		});
		this.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-mem-based-rag", version: "1.0.0" } }, id);
		await ready;
		this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
		const run = async (): Promise<string> => {
			const id = ++this.seq;
			const result = new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`ai-raccoon ${tool} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				this.pending.set(id, { resolve, reject, timer });
			});
			this.send("tools/call", { name: tool, arguments: args }, id);
			return result;
		};
		// Single-flight: chain onto the tail so two turns never interleave.
		const next = this.chain.then(run, run);
		this.chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	stop(): void {
		try {
			this.proc?.kill();
		} catch {
			// already gone — nothing to reap
		}
		this.proc = null;
	}
}

// ---------------------------------------------------------------- factory

export default function (pi: ExtensionAPI) {
	if (typeof pi?.registerTool !== "function" || typeof pi?.on !== "function") {
		console.error(
			"ai-badger: mem-based-rag extension API unavailable — prompt enrichment is not installed.",
		);
		return;
	}

	let client: RaccoonClient | null = null;
	let initialized = false;
	let sessionMode: PromptContextMode | "off" | undefined;
	let rawPrompt = "";
	let enriched = 0;
	let skipped = 0;
	let lastMs = 0;
	let lastReason = "none yet";

	const getClient = async (bin: string): Promise<RaccoonClient> => {
		if (!client) {
			client = new RaccoonClient(bin);
			await client.initialize();
			initialized = true;
		} else if (!initialized) {
			await client.initialize();
			initialized = true;
		}
		return client;
	};

	// Raw prompt capture: `input` sees text BEFORE skill/template expansion,
	// which is exactly the query contract (user words, never skill content).
	pi.on("input", async (event) => {
		if (typeof event.text === "string") rawPrompt = event.text;
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const config = readConfig(sessionMode);
		if (!config.enabled) return undefined;
		// Prefer the raw pre-expansion prompt; fall back to the expanded one
		// (rpc/extension-injected turns may never pass through `input`).
		const raw = rawPrompt || event.prompt;
		rawPrompt = "";
		const decision = shouldEnrich(raw, { minChars: config.minChars, minWords: config.minWords });
		if (!decision.enrich) {
			skipped += 1;
			lastReason = `skipped (${decision.reason})`;
			return undefined;
		}
		const projectId = resolveProjectId(ctx.cwd, process.env);
		if (!projectId) {
			skipped += 1;
			lastReason = "skipped (no project id)";
			return undefined;
		}
		const sessionId = resolveSessionId(ctx);
		if (!sessionId) {
			skipped += 1;
			lastReason = "skipped (no session id)";
			return undefined;
		}
		const startedAt = Date.now();
		try {
			const raccoon = await getClient(config.bin);
			const searchText = await raccoon.call(
				"memory_search",
				{ projectId, sessionId, query: decision.query, limit: 5 },
				config.timeoutMs,
			);
			const envelope = JSON.parse(searchText) as {
				data?: { results?: MemoryHit[]; code?: MemoryHit[] };
			};
			const mem = (envelope.data?.results ?? []).slice(0, 3);
			const code = (envelope.data?.code ?? []).slice(0, 2);
			let content: string;
			if (config.mode === "expanded") {
				const items: Array<{ hit: MemoryHit; kind: "memory" | "code"; value?: string; path?: string; chunk?: string }> = [];
				for (const hit of mem) {
					items.push({ hit, kind: "memory", ...(await fetchFull(raccoon, "memory_get", projectId, hit, config.timeoutMs)) });
				}
				for (const hit of code) {
					items.push({ hit, kind: "code", ...(await fetchFull(raccoon, "code_get", projectId, hit, config.timeoutMs)) });
				}
				content = toExpandedMemoryContext(decision.query, items, { snippetChars: config.snippetChars });
			} else {
				content = toMemoryContext(decision.query, mem, code, { snippetChars: config.snippetChars });
			}
			enriched += 1;
			lastMs = Date.now() - startedAt;
			lastReason = `enriched (${config.mode}, ${lastMs}ms)`;
			return {
				message: {
					customType: MEM_RAG_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						mode: config.mode,
						uniqueWords: decision.uniqueWords,
						memHashes: mem.map((hit) => hit.hash),
						codeHashes: code.map((hit) => hit.hash),
						latencyMs: lastMs,
					},
				},
			};
		} catch (error) {
			// Fail-open: a slow or dead bank skips enrichment, never the turn.
			skipped += 1;
			lastReason = `skipped (bank error: ${error instanceof Error ? error.message : String(error)})`;
			console.error("ai-badger mem-based-rag: enrichment failed fail-open —", error);
			return undefined;
		}
	});

	async function fetchFull(
		raccoon: RaccoonClient,
		tool: "memory_get" | "code_get",
		projectId: string,
		hit: MemoryHit,
		timeoutMs: number,
	): Promise<{ value?: string; path?: string; chunk?: string }> {
		try {
			const text = await raccoon.call(tool, { projectId, hash: hit.hash }, Math.min(timeoutMs, 5000));
			const data = (JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {};
			const value = typeof data.value === "string" ? data.value : typeof data.content === "string" ? data.content : undefined;
			const path = typeof data.path === "string" ? data.path : undefined;
			const chunk =
				typeof data.chunkIndex === "number" && typeof data.totalChunks === "number"
					? `chunk ${data.chunkIndex + 1}/${data.totalChunks}`
					: typeof data.lineStart === "number" && typeof data.lineEnd === "number"
						? `lines ${data.lineStart}-${data.lineEnd}`
						: undefined;
			return { ...(value !== undefined ? { value } : {}), ...(path !== undefined ? { path } : {}), ...(chunk !== undefined ? { chunk } : {}) };
		} catch {
			return {}; // per-hit fallback to the snippet happens in the formatter
		}
	}

	pi.registerCommand(MEM_RAG_COMMAND_NAME, {
		description: "Memory RAG status; `mode default|expanded|off` overrides for this session.",
		getArgumentCompletions(argumentPrefix) {
			const first = argumentPrefix.trim().split(/\s+/)[0] ?? "";
			const verbs = ["status", "mode"].filter((v) => v.startsWith(first));
			const items = verbs.map((verb) => ({ value: verb, label: verb, description: `rag ${verb}` }));
			return items.length > 0 ? items : null;
		},
		async handler(args, ctx) {
			const notify = (message: string, type: "info" | "warning" | "error"): void => {
				ctx.ui.notify(message, type);
			};
			const config = readConfig(sessionMode);
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "" || trimmed === "status") {
				notify(
					`mem-based-rag: ${config.enabled ? `on (${config.mode})` : "off"} — enriched ${enriched}, skipped ${skipped}, last: ${lastReason}. ` +
						`Floors: ≥${config.minWords} unique words (>3 chars), ≥${config.minChars} chars, timeout ${config.timeoutMs}ms.`,
					"info",
				);
				return;
			}
			const modeMatch = /^mode\s+(default|expanded|off)\s*$/.exec(trimmed);
			if (modeMatch) {
				sessionMode = modeMatch[1] as PromptContextMode | "off";
				notify(`mem-based-rag: session mode → ${modeMatch[1]}.`, "info");
				return;
			}
			notify("usage: /rag [status|mode default|expanded|off]", "info");
		},
	});

	pi.registerMessageRenderer(MEM_RAG_CUSTOM_TYPE, (message, options, theme) => {
		const body = typeof message.content === "string" ? message.content : "";
		if (!body) return undefined;
		const box = new Box(options.outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
		const lines = body.split("\n");
		box.addChild(new Text([theme.fg("success", lines[0] ?? ""), ...lines.slice(1)].join("\n"), 0, 0));
		return box;
	});

	pi.on("session_shutdown", () => {
		client?.stop();
		client = null;
		initialized = false;
		rawPrompt = "";
	});
}
