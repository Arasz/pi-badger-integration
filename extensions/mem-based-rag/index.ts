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
 * session boundaries. Measured 2026-09-06: spawn+init ~0.3 s (amortized), first
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
	hitDisplayPath,
	pruneHits,
	shouldEnrich,
	toCardLines,
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
		minWords: numEnv(MEM_RAG_MIN_WORDS_ENV, 6, 1, 100),
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
		// A bare .ai-badger/ dir (no project-id file) must not shadow a real id
		// higher up the tree — keep walking.
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveSessionId(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		// Trimmed like queueKeyFor: whitespace-only is blank, not a session.
		if (typeof id === "string" && id.trim()) return id;
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
 * Minimal MCP client over a stdio child: initialize once (memoized, dropped on
 * any restart so the next call re-initializes), tools/call per search.
 * Concurrent in-flight ids are safe — each request is one synchronous stdin
 * write and replies demux via the pending map — so expanded-mode gets fan out
 * under one shared deadline while searches stay single-flight via the
 * factory's chain. Fail-open throughout — every failure is an Error to the
 * caller, which skips enrichment.
 */
export class RaccoonClient {
	private proc: ChildProcess | null = null;
	private seq = 0;
	private readonly pending = new Map<number, PendingCall>();
	private buffer = "";
	private initPromise: Promise<void> | null = null;

	constructor(private readonly bin: string) {}

	/** True while the stdio child handle is held (diagnostics for /rag status). */
	isAlive(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	private rejectAll(error: Error): void {
		for (const [, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(error);
		}
		this.pending.clear();
	}

	private ensureStarted(): void {
		if (this.proc) return;
		const proc = spawn(this.bin, ["--transport", "stdio"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.proc = proc;
		proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
		proc.on("exit", () => {
			this.proc = null;
			this.initPromise = null;
			this.rejectAll(new Error("ai-raccoon child exited"));
		});
		proc.on("error", (error: Error) => {
			console.error(`ai-badger mem-based-rag: failed to spawn "${this.bin}" —`, error);
			this.proc = null;
			this.initPromise = null;
			this.rejectAll(error instanceof Error ? error : new Error(`ai-raccoon spawn failed: ${String(error)}`));
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
					// initialize/results without a text envelope resolve raw: only
					// tools/call responses are expected to carry content, and a
					// missing envelope there degrades downstream (no data →
					// no-hits skip) instead of rejecting the handshake.
					call.resolve(textPart ?? JSON.stringify(msg.result ?? null));
				}
			} catch {
				// a non-JSON line on stdout — ignore, keep framing on later lines
			}
		}
	}

	private send(method: string, params: unknown, id: number): void {
		this.ensureStarted();
		// One synchronous write per message: concurrent in-flight ids cannot
		// interleave on the pipe; replies demux via the pending map.
		const stdin = this.proc?.stdin;
		if (!stdin) throw new Error("ai-raccoon child has no stdin");
		stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	}

	/**
	 * Handshake, memoized: overlapping turns share one in-flight initialize,
	 * and any failure (or child restart) drops the memo so the next call
	 * re-initializes instead of talking to a never-initialized server.
	 */
	initialize(): Promise<void> {
		this.initPromise ??= this.doInitialize().catch((error) => {
			this.initPromise = null;
			throw error;
		});
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
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
				reject: (error: Error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			});
		});
		try {
			this.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-mem-based-rag", version: "1.0.0" } }, id);
		} catch (error) {
			const call = this.pending.get(id);
			if (call) {
				this.pending.delete(id);
				clearTimeout(call.timer);
				call.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		await ready;
		this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	/**
	 * Raw tools/call: safe for concurrent use (unique ids, pending-map demux).
	 * Searches go through the factory's single-flight chain; expanded-mode
	 * gets call this directly under one shared deadline.
	 */
	call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
		const id = ++this.seq;
		const result = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ai-raccoon ${tool} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		try {
			this.send("tools/call", { name: tool, arguments: args }, id);
		} catch (error) {
			const call = this.pending.get(id);
			if (call) {
				this.pending.delete(id);
				clearTimeout(call.timer);
				call.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		return result;
	}

	stop(): void {
		this.initPromise = null;
		try {
			this.proc?.kill();
		} catch {
			// already gone — nothing to reap
		}
		this.proc = null;
		this.rejectAll(new Error("ai-raccoon client stopped"));
	}
}

// ---------------------------------------------------------------- factory

/** Injectable client seam for the wiring-test lane (no stdio in `bun test`). */
export type RaccoonClientLike = Pick<RaccoonClient, "call" | "stop">;
export interface MemRagDeps {
	createClient?: (bin: string) => RaccoonClientLike;
}

export default function (pi: ExtensionAPI, deps?: MemRagDeps) {
	if (typeof pi?.registerTool !== "function" || typeof pi?.on !== "function") {
		console.error(
			"ai-badger: mem-based-rag extension API unavailable — prompt enrichment is not installed.",
		);
		return;
	}

	let client: RaccoonClientLike | null = null;
	let sessionMode: PromptContextMode | "off" | undefined;
	/** Session-keyed FIFO of raw pre-expansion prompts ("*" = blank session id). */
	const promptQueues = new Map<string, string[]>();
	/** Single-flight chain for searches; expanded-mode gets bypass it. */
	let searchFlight: Promise<void> = Promise.resolve();
	let enriched = 0;
	let skipped = 0;
	let lastMs = 0;
	let lastReason = "none yet";

	const createClient = deps?.createClient ?? ((bin: string): RaccoonClientLike => new RaccoonClient(bin));

	const getClient = async (bin: string): Promise<RaccoonClientLike> => {
		if (!client) {
			const fresh = createClient(bin);
			// Real clients handshake; injected fakes (Pick<"call" | "stop">) skip it.
			if (fresh instanceof RaccoonClient) await fresh.initialize();
			client = fresh;
		}
		return client;
	};

	/** Searches stay single-flight so two turns never interleave a query. */
	const searchCall = (
		raccoon: RaccoonClientLike,
		tool: string,
		args: Record<string, unknown>,
		timeoutMs: number,
	): Promise<string> => {
		const run = (): Promise<string> => raccoon.call(tool, args, timeoutMs);
		const next = searchFlight.then(run, run);
		searchFlight = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const queueKeyFor = (ctx: ExtensionContext): string => {
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			if (typeof id === "string" && id.trim()) return id;
		} catch {
			// session shape unavailable — fall through to the shared queue
		}
		return "*";
	};

	/** Injected fakes expose only call/stop — probe liveness when available. */
	const isChildAlive = (candidate: RaccoonClientLike | null): boolean => {
		if (!candidate) return false;
		const maybe = candidate as Partial<Pick<RaccoonClient, "isAlive">>;
		return typeof maybe.isAlive === "function" ? maybe.isAlive() : true;
	};

	const resetSessionState = (): void => {
		try {
			client?.stop();
		} catch {
			// already gone — nothing to reap
		}
		client = null;
		searchFlight = Promise.resolve();
		sessionMode = undefined;
		promptQueues.clear();
		enriched = 0;
		skipped = 0;
		lastMs = 0;
		lastReason = "none yet";
	};

	// Raw prompt capture: `input` sees text BEFORE skill/template expansion,
	// which is exactly the query contract (user words, never skill content).
	// Extension-echoed turns must neither seed nor clobber the queue.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (typeof event.text === "string") {
			const key = queueKeyFor(ctx);
			const queue = promptQueues.get(key) ?? [];
			queue.push(event.text);
			promptQueues.set(key, queue);
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Drain one queued raw prompt FIRST: a skipped or disabled turn must
		// never leak stale raw into the next turn.
		const key = queueKeyFor(ctx);
		const queue = promptQueues.get(key);
		const queued = queue?.shift();
		if (queue !== undefined && queue.length === 0) promptQueues.delete(key);
		const config = readConfig(sessionMode);
		if (!config.enabled) return undefined;
		// Prefer the raw pre-expansion prompt; fall back to the expanded one
		// (rpc/extension-injected turns may never pass through `input`, and a
		// whitespace-only capture carries no query).
		const raw = queued !== undefined && queued.trim() ? queued : String(event.prompt ?? "");
		const decision = shouldEnrich(raw, { minChars: config.minChars, minWords: config.minWords });
		if (!decision.enrich) {
			skipped += 1;
			lastReason = `skipped (${decision.reason})`;
			return undefined;
		}
		const startedAt = Date.now();
		try {
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
			const raccoon = await getClient(config.bin);
			const searchText = await searchCall(
				raccoon,
				"memory_search",
				{ projectId, sessionId, query: decision.query, limit: 5 },
				config.timeoutMs,
			);
			const envelope = JSON.parse(searchText) as {
				data?: { results?: MemoryHit[]; code?: MemoryHit[] };
			};
			const pruned = pruneHits(envelope.data?.results ?? [], envelope.data?.code ?? []);
			const mem = pruned.mem.slice(0, 3);
			const code = pruned.code.slice(0, 2);
			if (mem.length === 0 && code.length === 0) {
				skipped += 1;
				lastReason = "skipped (no-hits)";
				return undefined;
			}
			let content: string;
			if (config.mode === "expanded") {
				// One shared deadline for the whole fan-out: concurrent
				// in-flight ids, each budgeted from the same expiry — never a
				// sequential per-hit timeout inside this blocking handler.
				const deadline = Date.now() + config.timeoutMs;
				const remaining = (): number => Math.max(1, deadline - Date.now());
				const items = await Promise.all([
					...mem.map(async (hit) => ({ hit, kind: "memory" as const, ...(await fetchFull(raccoon, "memory_get", projectId, hit, remaining())) })),
					...code.map(async (hit) => ({ hit, kind: "code" as const, ...(await fetchFull(raccoon, "code_get", projectId, hit, remaining())) })),
				]);
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
						// Display-only relative paths for the card renderer —
						// the block content above keeps absolute paths for the agent.
						memDisplay: mem.map((hit) => hitDisplayPath(hit, ctx.cwd)),
						codeDisplay: code.map((hit) => hitDisplayPath(hit, ctx.cwd)),
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
		raccoon: RaccoonClientLike,
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
				ctx.ui?.notify?.(message, type);
			};
			const config = readConfig(sessionMode);
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "" || trimmed === "status") {
				let project: string;
				try {
					project = resolveProjectId(ctx.cwd, process.env) ? "found" : "missing";
				} catch {
					project = "unknown";
				}
				notify(
					`mem-based-rag: ${config.enabled ? `on (${config.mode})` : "off"} — enriched ${enriched}, skipped ${skipped}, last: ${lastReason}. ` +
						`Project: ${project}, child: ${isChildAlive(client) ? "alive" : "idle"}. ` +
						`Floors: ≥${config.minWords} unique words (≥3 chars ex-noise), ≥${config.minChars} chars, timeout ${config.timeoutMs}ms.`,
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
		// A partial theme (or renderer double) without paint helpers degrades
		// to a plain Text block instead of throwing inside render.
		try {
			const paint = theme as unknown as {
				fg: (color: string, text: string) => string;
				bg: (color: string, line: string) => string;
			};
			if (typeof paint.fg !== "function" || typeof paint.bg !== "function") return new Text(body, 0, 0);
			// Display-only transform: bullets, no [m1]/[c1] prefixes,
			// cwd-relative paths. The LLM block (message.content) is untouched.
			const details = (message as { details?: { memDisplay?: string[]; codeDisplay?: string[] } }).details;
			const lines = toCardLines(body, details?.memDisplay, details?.codeDisplay);
			const box = new Box(options.outputPad, 1, (line: string) => paint.bg("customMessageBg", line));
			const styled = lines
				.map((line) => {
					switch (line.tone) {
						case "head":
							return paint.fg("success", line.text);
						case "section":
							return paint.fg("accent", line.text);
						case "hit":
							return paint.fg("mdListBullet", "• ") + line.text.slice(2);
						case "dim":
						case "empty":
							return paint.fg("dim", line.text);
						default:
							return line.text;
					}
				})
				.join("\n");
			box.addChild(new Text(styled, 0, 0));
			return box;
		} catch {
			return new Text(body, 0, 0);
		}
	});

	// Factory-closure state (queues, counters, mode override, client) survives
	// new/resume/reload in-process — reset it on both session boundaries.
	pi.on("session_start", () => {
		resetSessionState();
	});

	pi.on("session_shutdown", () => {
		resetSessionState();
	});
}
