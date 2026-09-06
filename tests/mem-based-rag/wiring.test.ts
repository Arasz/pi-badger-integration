/**
 * P6 wiring tests for the mem-based-rag extension (test-only lane).
 *
 * No stdio child ever: every install passes deps.createClient returning a fake
 * (Pick<"call"|"stop">), and the pi surface is the shared fake-pi harness
 * capturing on()/registerCommand()/registerMessageRenderer().
 *
 * Order follows the task pins (fail-first 1→8):
 *  (1) capture→filter→inject FIFO shape
 *  (2) both modes card (default + expanded with per-hit fallback)
 *  (3) skips incl no-hits
 *  (4) fail-open
 *  (5) /rag status + mode off
 *  (6) readConfig defaults/clamping/per-call re-read (via observable status+block —
 *      readConfig itself is NOT exported; see seam gap note at bottom)
 *  (7) resolveProjectId (via observable search args/skip — NOT exported; seam gap)
 *  (8) truncation / STOP / multi-word command / f:-marker / jsaa boundary
 *
 * Seam gap (reported, not refactored — orchestrator folds): readConfig and
 * resolveProjectId are module-private in extensions/mem-based-rag/index.ts, so
 * (6)/(7) pin them black-box through /rag status floors, block truncation, and
 * search projectId args instead of direct import.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";
import factory, { MEM_RAG_CUSTOM_TYPE } from "../../extensions/mem-based-rag/index.ts";

// ------------------------------------------------------------------ env + tmp hygiene

const RAG_KEYS = [
	"PI_BADGER_MEM_RAG",
	"PI_BADGER_MEM_RAG_MODE",
	"PI_BADGER_MEM_RAG_MIN_WORDS",
	"PI_BADGER_MEM_RAG_MIN_CHARS",
	"PI_BADGER_MEM_RAG_TIMEOUT_MS",
	"PI_BADGER_MEM_RAG_SNIPPET_CHARS",
	"PI_BADGER_MEM_RAG_BIN",
	"AI_BADGER_PROJECT_ID",
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};
for (const k of RAG_KEYS) ORIG_ENV[k] = process.env[k];

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

afterEach(() => {
	for (const k of RAG_KEYS) {
		const v = ORIG_ENV[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	while (tmpDirs.length > 0) {
		const d = tmpDirs.pop()!;
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// hygiene only
		}
	}
});

function clearRagEnv(): void {
	for (const k of RAG_KEYS) delete process.env[k];
}

// ------------------------------------------------------------------ fakes

interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
	timeoutMs: number;
}

interface FakeBehavior {
	results?: Array<Record<string, unknown>>;
	code?: Array<Record<string, unknown>>;
	/** hash → full value object, plain string value, or Error to throw (per-hit failure). */
	values?: Record<string, Record<string, unknown> | string | Error>;
	/** Artificial delay (ms) applied to every memory_get/code_get (concurrency probe). */
	getDelayMs?: number;
	searchError?: Error;
	/** When true, memory_search waits timeoutMs then rejects (simulates real client timeout). */
	timeoutReject?: boolean;
	searchDelayMs?: number;
}

function makeFakeRaccoon(calls: ToolCall[], behavior: FakeBehavior) {
	return {
		call: async (tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> => {
			calls.push({ tool, args, timeoutMs });
			if (tool === "memory_search") {
				if (behavior.searchError) throw behavior.searchError;
				if (behavior.timeoutReject) {
					await new Promise((_resolve, reject) =>
						setTimeout(
							() => reject(new Error(`ai-raccoon memory_search timed out after ${timeoutMs}ms`)),
							timeoutMs,
						),
					);
					throw new Error("unreachable");
				}
				if (behavior.searchDelayMs) await new Promise((r) => setTimeout(r, behavior.searchDelayMs));
				return JSON.stringify({
					data: { results: behavior.results ?? [], code: behavior.code ?? [] },
				});
			}
			if (tool === "memory_get" || tool === "code_get") {
				if (behavior.getDelayMs) await new Promise((r) => setTimeout(r, behavior.getDelayMs));
				const hash = String((args as Record<string, unknown>)["hash"] ?? "");
				const v = behavior.values?.[hash];
				if (v instanceof Error) throw v;
				if (typeof v === "string") return JSON.stringify({ data: { value: v, path: `shared/${hash}.md` } });
				if (v !== undefined && typeof v === "object") return JSON.stringify({ data: v });
				return JSON.stringify({ data: {} });
			}
			throw new Error(`unexpected tool ${tool}`);
		},
		stop: () => {},
	};
}

function install(behavior: FakeBehavior = {}): { pi: FakePi; calls: ToolCall[] } {
	const pi = createFakePi();
	const calls: ToolCall[] = [];
	const fake = makeFakeRaccoon(calls, behavior);
	(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
		createClient: () => fake,
	});
	return { pi, calls };
}

interface TestCtx {
	cwd: string;
	sessionManager: { getSessionId: () => string };
	ui: { notify: (message: string, type: string) => void };
}

function makeCtx(cwd: string, sessionId: string, onNotify?: (message: string, type: string) => void): TestCtx {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string, type: string) => onNotify?.(message, type) },
	};
}

async function fireInput(pi: FakePi, text: string, ctx: unknown, source = "user"): Promise<unknown> {
	let last: unknown;
	for (const h of pi.handlers.get("input") ?? []) {
		last = await (h as (e: unknown, c: unknown) => unknown)({ text, source }, ctx);
	}
	return last;
}

async function fireBefore(pi: FakePi, prompt: string | undefined, ctx: unknown): Promise<any> {
	let last: unknown;
	for (const h of pi.handlers.get("before_agent_start") ?? []) {
		last = await (h as (e: unknown, c: unknown) => unknown)({ prompt }, ctx);
	}
	return last as any;
}

async function ragStatus(pi: FakePi, cwd: string, sessionId = "sess-test"): Promise<string> {
	const cmd = pi.commands.get("rag") as unknown as {
		handler: (args: string, ctx: unknown) => Promise<void>;
	};
	const notes: string[] = [];
	const ctx = makeCtx(cwd, sessionId, (m) => notes.push(m));
	await cmd.handler("status", ctx as never);
	return notes.join("\n");
}

async function ragMode(pi: FakePi, mode: string, cwd: string, sessionId = "sess-test"): Promise<string> {
	const cmd = pi.commands.get("rag") as unknown as {
		handler: (args: string, ctx: unknown) => Promise<void>;
	};
	const notes: string[] = [];
	const ctx = makeCtx(cwd, sessionId, (m) => notes.push(m));
	await cmd.handler(mode, ctx as never);
	return notes.join("\n");
}

const themeStub = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };

function renderMessage(pi: FakePi, message: any): any {
	const renderer = pi.renderers.get(MEM_RAG_CUSTOM_TYPE);
	expect(renderer).toBeDefined();
	return (renderer as (m: unknown, o: unknown, t: unknown) => unknown)(
		message,
		{ outputPad: 0, expanded: false },
		themeStub,
	);
}

function renderedText(component: any): string {
	if (component === undefined || component === null) return "";
	if (typeof component?.render === "function") {
		const lines = component.render(100) as string[];
		return lines.join("\n");
	}
	return String(component);
}

// Realistic enrichable prompts (≥20 chars, ≥6 unique 3+char words, no command/control).
const P1 = "explain how delegation timeout interacts with slow CI runners tomorrow morning please";
const P2 = "describe prompt context injection filtering before agent start handling quickly today";
// 6-word jsaa probe (uniqueLongWords == 6 at default minWords 6).
const JSAA_PROBE = "prompt context injection extension before_agent_start filter";

const MEM_HITS = [
	{ hash: "m1", ranking: 1, path: "shared/a.md", snippet: "first memory snippet about delegation" },
	{ hash: "m2", ranking: 0.9, path: "shared/b.md", snippet: "second memory snippet about timeouts" },
];
const CODE_HITS = [{ hash: "c1", ranking: 1, path: "src/a.ts", snippet: "some code snippet", lineStart: 10, lineEnd: 20 }];

// ------------------------------------------------------------------ (1) capture→filter→inject FIFO shape

describe("(1) capture→filter→inject shape", () => {
	test("input x2 rapid → before_agent_start x2 pairs FIFO in order with inject shape", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-fifo";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-fifo", "sess-fifo");

		await fireInput(pi, P1, ctx as never);
		await fireInput(pi, P2, ctx as never);
		const r1 = await fireBefore(pi, "", ctx as never);
		const r2 = await fireBefore(pi, "", ctx as never);

		// FIFO: first queued raw pairs with first turn, second with second.
		expect(calls).toHaveLength(2);
		expect((calls[0]!.args as Record<string, unknown>)["query"]).toBe(P1);
		expect((calls[1]!.args as Record<string, unknown>)["query"]).toBe(P2);

		for (const r of [r1, r2]) {
			expect(r?.message?.customType).toBe("mem-based-rag");
			expect(r?.message?.display).toBe(true);
			expect(typeof r?.message?.content).toBe("string");
			expect(r?.message?.details?.mode).toBe("default");
			expect(typeof r?.message?.details?.uniqueWords).toBe("number");
			expect(r?.message?.details?.uniqueWords).toBeGreaterThanOrEqual(6);
			expect(Array.isArray(r?.message?.details?.memHashes)).toBe(true);
			expect(Array.isArray(r?.message?.details?.codeHashes)).toBe(true);
			expect(typeof r?.message?.details?.latencyMs).toBe("number");
		}
		expect(r1?.message?.details?.memHashes).toEqual(["m1", "m2"]);
		expect(r1?.message?.details?.codeHashes).toEqual(["c1"]);

		// Behaviour radius: neighbouring state — enriched counter moved twice.
		const status = await ragStatus(pi, "/tmp/wiring-fifo", "sess-fifo");
		expect(status).toContain("enriched 2");
	});

	test("queued raw wins over expanded event.prompt; extension-echoed input never seeds the queue", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-raw";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-raw", "sess-raw");

		// Capture contract: input sees pre-expansion text; before_agent_start must use it.
		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, P2, ctx as never);
		expect((calls[0]!.args as Record<string, unknown>)["query"]).toBe(P1);
		expect(r?.message?.customType).toBe("mem-based-rag");

		// Extension-echoed turns neither seed nor clobber: a fresh install with only an
		// extension input and an empty turn must skip (empty), not enrich.
		const second = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx2 = makeCtx("/tmp/wiring-raw", "sess-raw2");
		await fireInput(second.pi, P1, ctx2 as never, "extension");
		const skipped = await fireBefore(second.pi, "", ctx2 as never);
		expect(skipped).toBeUndefined();
		expect(second.calls).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ (2) both modes card

describe("(2) both modes card", () => {
	test("default mode yields display:true with renderer-accepted string body", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-default";
		delete process.env["PI_BADGER_MEM_RAG_MODE"];
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-default", "sess-default");

		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, "", ctx as never);
		expect(r?.message?.display).toBe(true);
		expect(typeof r?.message?.content).toBe("string");
		expect(String(r?.message?.content)).toContain("Memory context (ai-raccoon memory_search");
		expect(String(r?.message?.content)).toContain("first memory snippet");
		expect(String(r?.message?.content)).toContain("memory_get");

		const component = renderMessage(pi, r.message);
		expect(component).toBeDefined();
		expect(renderedText(component)).toContain("Memory context");
	});

	test("expanded mode fans out with provenance lines and per-hit snippet fallback on one failing get", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-expanded";
		process.env["PI_BADGER_MEM_RAG_MODE"] = "expanded";
		const { pi, calls } = install({
			results: MEM_HITS,
			code: CODE_HITS,
			values: {
				m1: { value: "the full decision text for delegation timeouts", path: "shared/a.md", chunkIndex: 1, totalChunks: 36 },
				m2: new Error("memory_get exploded"),
				c1: { value: "full code body for the injection path", path: "src/a.ts", lineStart: 10, lineEnd: 20 },
			},
		});
		const ctx = makeCtx("/tmp/wiring-expanded", "sess-expanded");

		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, "", ctx as never);
		expect(r?.message?.display).toBe(true);
		expect(r?.message?.details?.mode).toBe("expanded");
		const body = String(r?.message?.content ?? "");
		expect(body).toContain("memory_get/code_get, expanded");
		// Provenance: path + chunk for the successful get.
		expect(body).toContain("shared/a.md");
		expect(body).toContain("chunk 2/36");
		expect(body).toContain("the full decision text");
		// Per-hit fallback: the failing m2 falls back to its search snippet, whole block survives.
		expect(body).toContain("second memory snippet about timeouts");
		expect(body).toContain("full code body");

		const tools = calls.map((c) => c.tool);
		expect(tools).toContain("memory_search");
		expect(tools).toContain("memory_get");
		expect(tools).toContain("code_get");

		const component = renderMessage(pi, r.message);
		expect(component).toBeDefined();
		expect(renderedText(component)).toContain("Memory context");
	});
});

// ------------------------------------------------------------------ (3) skips incl no-hits

describe("(3) skips incl no-hits", () => {
	test("thin/control/command/bare-skill/empty each skip with named reason, enriched untouched", async () => {
		const cases: Array<{ prompt: string; reason: string }> = [
			{ prompt: "prompt context injection extension filter", reason: "too-thin" },
			{ prompt: "stop", reason: "control-word" },
			{ prompt: "/delegate some long task with many words here today please", reason: "command" },
			{ prompt: "/skill:task", reason: "bare-skill-call" },
			{ prompt: "   ", reason: "empty" },
		];
		for (const { prompt, reason } of cases) {
			clearRagEnv();
			process.env["AI_BADGER_PROJECT_ID"] = "proj-skip";
			const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
			const ctx = makeCtx("/tmp/wiring-skip", `sess-skip-${reason}`);
			const r = await fireBefore(pi, prompt, ctx as never);
			expect(r, `prompt ${JSON.stringify(prompt)}`).toBeUndefined();
			expect(calls, `prompt ${JSON.stringify(prompt)}`).toHaveLength(0);
			const status = await ragStatus(pi, "/tmp/wiring-skip", `sess-skip-${reason}`);
			expect(status).toContain("enriched 0");
			expect(status).toContain("skipped 1");
			expect(status).toContain(reason);
		}
	});

	test("both-empty search after pruning skips as no-hits without enriching", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-nohits";
		const { pi, calls } = install({ results: [], code: [] });
		const ctx = makeCtx("/tmp/wiring-nohits", "sess-nohits");
		const r = await fireBefore(pi, P1, ctx as never);
		expect(r).toBeUndefined();
		// Filter passed (search ran) but hits were empty.
		expect(calls.map((c) => c.tool)).toContain("memory_search");
		const status = await ragStatus(pi, "/tmp/wiring-nohits", "sess-nohits");
		expect(status).toContain("enriched 0");
		expect(status).toContain("skipped 1");
		expect(status).toContain("no-hits");
	});
});

// ------------------------------------------------------------------ (4) fail-open

describe("(4) fail-open", () => {
	test("client throw resolves undefined with skipped+1, never throws", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-throw";
		const { pi } = install({ searchError: new Error("bank exploded") });
		const ctx = makeCtx("/tmp/wiring-throw", "sess-throw");
		let result: unknown;
		let threw = false;
		try {
			result = await fireBefore(pi, P1, ctx as never);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		const status = await ragStatus(pi, "/tmp/wiring-throw", "sess-throw");
		expect(status).toContain("skipped 1");
		expect(status).toContain("bank error");
	});

	test("timeout beyond budget resolves undefined, never throws", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-timeout";
		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "500";
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS, timeoutReject: true });
		const ctx = makeCtx("/tmp/wiring-timeout", "sess-timeout");
		let result: unknown;
		let threw = false;
		try {
			result = await fireBefore(pi, P1, ctx as never);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		const status = await ragStatus(pi, "/tmp/wiring-timeout", "sess-timeout");
		expect(status).toContain("skipped 1");
		expect(status).toContain("timed out");
	}, 10_000);

	test("blank session id skips without searching, never throws", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-blank-sess";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		// Empty string is the fail-open blank: resolveSessionId("") → "" → skipped (no session id).
		const ctx = makeCtx("/tmp/wiring-blank", "");
		let result: unknown;
		let threw = false;
		try {
			result = await fireBefore(pi, P1, ctx as never);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		const status = await ragStatus(pi, "/tmp/wiring-blank", "");
		expect(status).toContain("no session id");
	});

	test("whitespace-only session id skips like blank, never searches", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ws-sess";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-ws", "   ");
		let result: unknown;
		let threw = false;
		try {
			result = await fireBefore(pi, P1, ctx as never);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("prompt-less turn (prompt undefined, empty queue) skips as empty, never throws", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-noprompt";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-noprompt", "sess-noprompt");
		let result: unknown;
		let threw = false;
		try {
			result = await fireBefore(pi, undefined, ctx as never);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		const status = await ragStatus(pi, "/tmp/wiring-noprompt", "sess-noprompt");
		expect(status).toContain("empty");
	});
});

// ------------------------------------------------------------------ (5) /rag status + mode off

describe("(5) /rag status and mode off", () => {
	test("status reflects counters/reasons/floors/project presence/child-alive", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-status";
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS });
		const cwd = "/tmp/wiring-status";
		const session = "sess-status";

		const idle = await ragStatus(pi, cwd, session);
		expect(idle).toContain("enriched 0");
		expect(idle).toContain("skipped 0");
		expect(idle).toContain("none yet");
		expect(idle).toContain("Project: found");
		expect(idle).toContain("child: idle");
		expect(idle).toContain("≥6 unique words");
		expect(idle).toContain("≥20 chars");
		expect(idle).toContain("timeout 8000ms");

		const ctx = makeCtx(cwd, session);
		await fireInput(pi, P1, ctx as never);
		const enriched = await fireBefore(pi, "", ctx as never);
		expect(enriched?.message).toBeDefined();
		await fireBefore(pi, "stop", ctx as never);

		const after = await ragStatus(pi, cwd, session);
		expect(after).toContain("enriched 1");
		expect(after).toContain("skipped 1");
		expect(after).toContain("control-word");
		expect(after).toContain("Project: found");
		expect(after).toContain("child: alive");
		expect(after).toContain("on (default)");
	});

	test("mode off always skips; mode default re-enables", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-modeoff";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const cwd = "/tmp/wiring-modeoff";
		const session = "sess-modeoff";

		await ragMode(pi, "mode off", cwd, session);
		const offStatus = await ragStatus(pi, cwd, session);
		expect(offStatus).toContain("off");

		const ctx = makeCtx(cwd, session);
		await fireInput(pi, P1, ctx as never);
		const skipped = await fireBefore(pi, "", ctx as never);
		expect(skipped).toBeUndefined();
		expect(calls).toHaveLength(0);

		await ragMode(pi, "mode default", cwd, session);
		await fireInput(pi, P1, ctx as never);
		const enriched = await fireBefore(pi, "", ctx as never);
		expect(enriched?.message?.customType).toBe("mem-based-rag");
	});
});

// ------------------------------------------------------------------ (6) readConfig defaults/clamping/per-call re-read

describe("(6) readConfig defaults, clamping, per-call re-read", () => {
	test("defaults are 6 words / 20 chars / 8000ms timeout / 300 snippet chars", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-defaults";
		const { pi } = install({
			results: [{ hash: "m1", path: "shared/a.md", snippet: `x`.repeat(500) }],
			code: [],
		});
		const status = await ragStatus(pi, "/tmp/wiring-defaults");
		expect(status).toContain("≥6 unique words");
		expect(status).toContain("≥20 chars");
		expect(status).toContain("timeout 8000ms");

		// Snippet default 300: a 500-char snippet truncates to 300 + ellipsis.
		const ctx = makeCtx("/tmp/wiring-defaults", "sess-defaults");
		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, "", ctx as never);
		const line = String(r?.message?.content ?? "").split("\n").find((l) => l.startsWith("[m1]")) ?? "";
		const snippet = (line.split(" :: ")[1] ?? "").trim();
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBe(301);
	});

	test("timeout clamps to 500–60000 and snippet clamps to 50–2000", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-clamp";

		// Timeout floor/ceiling via status floors.
		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "10";
		const low = install();
		expect(await ragStatus(low.pi, "/tmp/wiring-clamp")).toContain("timeout 500ms");

		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "999999";
		const high = install();
		expect(await ragStatus(high.pi, "/tmp/wiring-clamp")).toContain("timeout 60000ms");
		delete process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"];

		// Snippet floor: env 10 clamps to 50 — a 100-char snippet truncates to 50.
		process.env["PI_BADGER_MEM_RAG_SNIPPET_CHARS"] = "10";
		const floorPi = install({
			results: [{ hash: "m1", path: "shared/a.md", snippet: "x".repeat(100) }],
			code: [],
		});
		const floorCtx = makeCtx("/tmp/wiring-clamp", "sess-snip-floor");
		await fireInput(floorPi.pi, P1, floorCtx as never);
		const floorRes = await fireBefore(floorPi.pi, "", floorCtx as never);
		const floorLine =
			String(floorRes?.message?.content ?? "").split("\n").find((l) => l.startsWith("[m1]")) ?? "";
		expect((floorLine.split(" :: ")[1] ?? "").trim().length).toBe(51);

		// Snippet ceiling: env 5000 clamps to 2000 — a 2500-char snippet truncates to 2000.
		process.env["PI_BADGER_MEM_RAG_SNIPPET_CHARS"] = "5000";
		const ceilPi = install({
			results: [{ hash: "m1", path: "shared/a.md", snippet: "x".repeat(2500) }],
			code: [],
		});
		const ceilCtx = makeCtx("/tmp/wiring-clamp", "sess-snip-ceil");
		await fireInput(ceilPi.pi, P1, ceilCtx as never);
		const ceilRes = await fireBefore(ceilPi.pi, "", ceilCtx as never);
		const ceilLine =
			String(ceilRes?.message?.content ?? "").split("\n").find((l) => l.startsWith("[m1]")) ?? "";
		expect((ceilLine.split(" :: ")[1] ?? "").trim().length).toBe(2001);
	});

	test("per-call env re-read: status and enrichment follow env changes without reinstall", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-reread";
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS });

		expect(await ragStatus(pi, "/tmp/wiring-reread")).toContain("≥6 unique words");
		process.env["PI_BADGER_MEM_RAG_MIN_WORDS"] = "10";
		expect(await ragStatus(pi, "/tmp/wiring-reread")).toContain("≥10 unique words");

		// Behaviour follows: JSAA 6-word probe enriched at 6, thin at re-read 10.
		delete process.env["PI_BADGER_MEM_RAG_MIN_WORDS"];
		const ctx = makeCtx("/tmp/wiring-reread", "sess-reread");
		await fireInput(pi, JSAA_PROBE, ctx as never);
		const enriched = await fireBefore(pi, "", ctx as never);
		expect(enriched?.message).toBeDefined();

		process.env["PI_BADGER_MEM_RAG_MIN_WORDS"] = "10";
		await fireInput(pi, JSAA_PROBE, ctx as never);
		const thin = await fireBefore(pi, "", ctx as never);
		expect(thin).toBeUndefined();
	});
});

// ------------------------------------------------------------------ (7) resolveProjectId

describe("(7) resolveProjectId", () => {
	test("AI_BADGER_PROJECT_ID wins over the project-id file", async () => {
		clearRagEnv();
		const root = mkTmp("wiring-proj-wins-");
		mkdirSync(join(root, ".ai-badger"), { recursive: true });
		writeFileSync(join(root, ".ai-badger", "project-id"), "file-id\n");
		process.env["AI_BADGER_PROJECT_ID"] = "env-wins";

		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx(root, "sess-wins");
		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, "", ctx as never);
		expect(r?.message).toBeDefined();
		expect((calls[0]!.args as Record<string, unknown>)["projectId"]).toBe("env-wins");
	});

	test("walks past a bare .ai-badger/ dir to the real id above", async () => {
		clearRagEnv();
		const root = mkTmp("wiring-proj-walk-");
		mkdirSync(join(root, ".ai-badger"), { recursive: true });
		writeFileSync(join(root, ".ai-badger", "project-id"), "parent-id\n");
		const bare = join(root, "sub", "bare");
		mkdirSync(join(bare, ".ai-badger"), { recursive: true });
		const work = join(bare, "work");
		mkdirSync(work, { recursive: true });

		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx(work, "sess-walk");
		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, "", ctx as never);
		expect(r?.message).toBeDefined();
		expect((calls[0]!.args as Record<string, unknown>)["projectId"]).toBe("parent-id");
	});

	test("missing id skips as no project id and reports Project: missing", async () => {
		clearRagEnv();
		const empty = mkTmp("wiring-proj-missing-");
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx(empty, "sess-missing");
		const r = await fireBefore(pi, P1, ctx as never);
		expect(r).toBeUndefined();
		expect(calls).toHaveLength(0);
		const status = await ragStatus(pi, empty, "sess-missing");
		expect(status).toContain("Project: missing");
		expect(status).toContain("no project id");
	});
});

// ------------------------------------------------------------------ (8) truncation / STOP / command / f: / jsaa

describe("(8) truncation, STOP, multi-word command, f:-marker, jsaa boundary", () => {
	test("snippet >300 truncates; expanded value >1200 truncates", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-trunc";

		const snip = install({
			results: [{ hash: "m1", path: "shared/a.md", snippet: "x".repeat(500) }],
			code: [],
		});
		const snipCtx = makeCtx("/tmp/wiring-trunc", "sess-snip");
		await fireInput(snip.pi, P1, snipCtx as never);
		const snipRes = await fireBefore(snip.pi, "", snipCtx as never);
		const snipLine =
			String(snipRes?.message?.content ?? "").split("\n").find((l) => l.startsWith("[m1]")) ?? "";
		const snipPart = (snipLine.split(" :: ")[1] ?? "").trim();
		expect(snipPart.endsWith("…")).toBe(true);
		expect(snipPart.length).toBeLessThanOrEqual(301);

		process.env["PI_BADGER_MEM_RAG_MODE"] = "expanded";
		const val = install({
			results: [{ hash: "m1", path: "shared/a.md", snippet: "short" }],
			code: [],
			values: { m1: { value: "y".repeat(2000), path: "shared/a.md" } },
		});
		const valCtx = makeCtx("/tmp/wiring-trunc", "sess-val");
		await fireInput(val.pi, P1, valCtx as never);
		const valRes = await fireBefore(val.pi, "", valCtx as never);
		const valLine =
			String(valRes?.message?.content ?? "").split("\n").find((l) => l.startsWith("[m1]")) ?? "";
		const valPart = (valLine.split(" :: ")[1] ?? "").trim();
		expect(valPart.endsWith("…")).toBe(true);
		expect(valPart.length).toBeLessThanOrEqual(1201);
	});

	test("uppercase STOP skips as control-word; STOP with extension text enriches (exact match)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-stop";
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS });

		const stopCtx = makeCtx("/tmp/wiring-stop", "sess-stop-upper");
		expect(await fireBefore(pi, "STOP", stopCtx as never)).toBeUndefined();
		expect(await ragStatus(pi, "/tmp/wiring-stop", "sess-stop-upper")).toContain("control-word");

		const longCtx = makeCtx("/tmp/wiring-stop", "sess-stop-long");
		const r = await fireBefore(
			pi,
			"STOP now please continue the deployment because runners are slow and flaky today",
			longCtx as never,
		);
		expect(r?.message?.customType).toBe("mem-based-rag");
	});

	test("multi-word slash commands skip as command", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-cmd";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-cmd", "sess-cmd");
		const r = await fireBefore(pi, "/compact some long task with many words here today please", ctx as never);
		expect(r).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(await ragStatus(pi, "/tmp/wiring-cmd", "sess-cmd")).toContain("command");
	});

	test("f:-marker text enriches with the marker kept in the search query", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-fmarker";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const prompt = "f: please explain how the delegation timeout interacts with slow CI runners tomorrow morning";
		const ctx = makeCtx("/tmp/wiring-fmarker", "sess-fmarker");
		const r = await fireBefore(pi, prompt, ctx as never);
		expect(r?.message).toBeDefined();
		expect(String((calls[0]!.args as Record<string, unknown>)["query"] ?? "")).toContain("f:");
	});

	test("jsaa boundary: 6-word probe enriches at default 6, too-thin at minWords 7", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-jsaa";
		const atDefault = install({ results: MEM_HITS, code: CODE_HITS });
		const ctxDefault = makeCtx("/tmp/wiring-jsaa", "sess-jsaa-6");
		const enriched = await fireBefore(atDefault.pi, JSAA_PROBE, ctxDefault as never);
		expect(enriched?.message?.customType).toBe("mem-based-rag");
		expect(enriched?.message?.details?.uniqueWords).toBe(6);

		process.env["PI_BADGER_MEM_RAG_MIN_WORDS"] = "7";
		const atSeven = install({ results: MEM_HITS, code: CODE_HITS });
		const ctxSeven = makeCtx("/tmp/wiring-jsaa", "sess-jsaa-7");
		const thin = await fireBefore(atSeven.pi, JSAA_PROBE, ctxSeven as never);
		expect(thin).toBeUndefined();
		expect(atSeven.calls).toHaveLength(0);
		expect(await ragStatus(atSeven.pi, "/tmp/wiring-jsaa", "sess-jsaa-7")).toContain("too-thin");
	});
});

// ------------------------------------------------------------------ review-gate pins (MUST3 + SHOULD5/6/7)

async function fireSession(pi: FakePi, event: "session_start" | "session_shutdown", ctx: unknown): Promise<void> {
	for (const h of pi.handlers.get(event) ?? []) {
		await (h as (e: unknown, c: unknown) => unknown)({}, ctx);
	}
}

describe("review gate: session reset, isolation, renderer fallback, shared deadline", () => {
	test("session_start zeroes counters and drains the queue (stale input never leaks)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-reset";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-reset", "sess-reset");

		await fireInput(pi, P1, ctx as never);
		const r1 = await fireBefore(pi, "", ctx as never);
		expect(r1?.message).toBeDefined();
		expect(await ragStatus(pi, "/tmp/wiring-reset", "sess-reset")).toContain("enriched 1");

		// Queue one more raw, then reset before its turn: it must not leak through.
		await fireInput(pi, P2, ctx as never);
		await fireSession(pi, "session_start", ctx as never);
		expect(await ragStatus(pi, "/tmp/wiring-reset", "sess-reset")).toContain("enriched 0");
		expect(await ragStatus(pi, "/tmp/wiring-reset", "sess-reset")).toContain("skipped 0");

		const after = await fireBefore(pi, "", ctx as never);
		expect(after).toBeUndefined();
		expect(calls).toHaveLength(1); // only the pre-reset search ran
		expect(await ragStatus(pi, "/tmp/wiring-reset", "sess-reset")).toContain("empty");
	});

	test("session_shutdown zeroes counters too", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-shutdown";
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-shutdown", "sess-shutdown");
		await fireInput(pi, P1, ctx as never);
		await fireBefore(pi, "", ctx as never);
		await fireSession(pi, "session_shutdown", ctx as never);
		expect(await ragStatus(pi, "/tmp/wiring-shutdown", "sess-shutdown")).toContain("enriched 0");
	});

	test("cross-session FIFO isolation: interleaved sessions never cross-leak queries", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-xsession";
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctxA = makeCtx("/tmp/wiring-xsession", "sess-A");
		const ctxB = makeCtx("/tmp/wiring-xsession", "sess-B");

		await fireInput(pi, P1, ctxA as never);
		await fireInput(pi, P2, ctxB as never);
		await fireBefore(pi, "", ctxA as never);
		await fireBefore(pi, "", ctxB as never);

		expect(calls).toHaveLength(2);
		expect((calls[0]!.args as Record<string, unknown>)["query"]).toBe(P1);
		expect((calls[1]!.args as Record<string, unknown>)["query"]).toBe(P2);
	});

	test("renderer survives a throwing theme with a plain-text fallback", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-render";
		const { pi } = install({ results: MEM_HITS, code: CODE_HITS });
		const ctx = makeCtx("/tmp/wiring-render", "sess-render");
		await fireInput(pi, P1, ctx as never);
		const r = await fireBefore(pi, "", ctx as never);
		const renderer = pi.renderers.get(MEM_RAG_CUSTOM_TYPE) as (m: unknown, o: unknown, t: unknown) => unknown;
		const throwing = {
			fg: (_c: string, _t: string): string => {
				throw new Error("theme exploded");
			},
			bg: (_c: string, _t: string): string => {
				throw new Error("theme exploded");
			},
		};
		let component: unknown;
		let threw = false;
		try {
			component = renderer(r.message, { outputPad: 0, expanded: false }, throwing);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(component).toBeDefined();
		expect(renderedText(component)).toContain("Memory context");
	});

	test("expanded gets run concurrently under one deadline (wall time proves it)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-deadline";
		process.env["PI_BADGER_MEM_RAG_MODE"] = "expanded";
		// 3 gets x 1500ms: sequential fan-out costs ~4500ms; concurrent ~1500ms.
		// The 4000ms bound reddens on a revert to sequential full-budget gets
		// while tolerating CI scheduling slop on the concurrent path.
		const { pi, calls } = install({ results: MEM_HITS, code: CODE_HITS, getDelayMs: 1500 });
		const ctx = makeCtx("/tmp/wiring-deadline", "sess-deadline");
		await fireInput(pi, P1, ctx as never);
		const startedAt = Date.now();
		const r = await fireBefore(pi, "", ctx as never);
		const elapsed = Date.now() - startedAt;
		expect(r?.message).toBeDefined();
		const gets = calls.filter((c) => c.tool === "memory_get" || c.tool === "code_get");
		expect(gets.length).toBe(3);
		for (const g of gets) expect(g.timeoutMs).toBeLessThanOrEqual(8000);
		expect(elapsed).toBeLessThan(4000);
	}, 15_000);
});
