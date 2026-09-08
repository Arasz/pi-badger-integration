/**
 * PKG-2 /ask isolated RAG command tests (RED-first lane).
 *
 * Fake-pi + fake raccoon (wiring harness pattern) + fake spawnAsk (never real
 * spawn). Every /ask failure path notifies and returns undefined — never throws.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";
import factory from "../../extensions/mem-based-rag/index.ts";
import { ASK_CHILD_EXCLUDED_TOOLS, ASK_CHILD_TIMEOUT_MS, ASK_ANSWER_CAP_CHARS, askPiInvocation, capAskAnswer, parseAskAnswer } from "../../extensions/mem-based-rag/index.ts";
import { CHILD_EXCLUDED_TOOLS } from "../../extensions/subagent/index.ts";

// ------------------------------------------------------------------ env hygiene

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
	values?: Record<string, Record<string, unknown> | string | Error>;
	getDelayMs?: number;
	searchError?: Error;
	timeoutReject?: boolean;
	searchDelayMs?: number;
}

interface SpawnCall {
	cmd: string;
	argv: string[];
	opts: { cwd: string; timeoutMs: number };
}

interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
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

/** Minimal pi --mode json stdout carrying one assistant text answer. */
function jsonlAnswer(text: string): string {
	return [
		JSON.stringify({ type: "session", id: "sess-ask" }),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		}),
	].join("\n");
}

function installAsk(
	behavior: FakeBehavior = {},
	spawnImpl?: (call: SpawnCall) => Promise<SpawnResult>,
): { pi: FakePi; calls: ToolCall[]; spawnCalls: SpawnCall[] } {
	const pi = createFakePi();
	const calls: ToolCall[] = [];
	const spawnCalls: SpawnCall[] = [];
	const fake = makeFakeRaccoon(calls, behavior);
	const spawnAsk =
		spawnImpl !== undefined
			? async (cmd: string, argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<SpawnResult> => {
					spawnCalls.push({ cmd, argv, opts });
					return spawnImpl({ cmd, argv, opts });
				}
			: async (cmd: string, argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<SpawnResult> => {
					spawnCalls.push({ cmd, argv, opts });
					return { stdout: jsonlAnswer("default canned answer"), stderr: "", exitCode: 0 };
				};
	(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
		createClient: () => fake,
		spawnAsk,
	});
	return { pi, calls, spawnCalls };
}

interface Notify {
	message: string;
	type: string;
}

function makeAskCtx(cwd: string, sessionId: string, notes: Notify[]) {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string, type: string) => notes.push({ message, type }) },
	};
}

async function fireAsk(pi: FakePi, args: string, cwd: string, sessionId: string, notes: Notify[]): Promise<unknown> {
	const cmd = pi.commands.get("ask") as unknown as {
		handler: (args: string, ctx: unknown) => Promise<unknown>;
	};
	expect(cmd).toBeDefined();
	const ctx = makeAskCtx(cwd, sessionId, notes);
	return cmd.handler(args, ctx as never);
}

async function fireSession(pi: FakePi, event: "session_start" | "session_shutdown", ctx: unknown): Promise<void> {
	for (const h of pi.handlers.get(event) ?? []) {
		await (h as (e: unknown, c: unknown) => unknown)({}, ctx);
	}
}

async function ragStatus(pi: FakePi, cwd: string, sessionId = "sess-test"): Promise<string> {
	const cmd = pi.commands.get("rag") as unknown as {
		handler: (args: string, ctx: unknown) => Promise<void>;
	};
	const notes: Notify[] = [];
	const ctx = makeAskCtx(cwd, sessionId, notes);
	await cmd.handler("status", ctx as never);
	return notes.map((n) => n.message).join("\n");
}

const P1 = "explain how delegation timeout interacts with slow CI runners tomorrow morning please";
const MEM_HITS = [
	{ hash: "m1", ranking: 1, path: "shared/a.md", snippet: "first memory snippet about delegation" },
	{ hash: "m2", ranking: 0.9, path: "shared/b.md", snippet: "second memory snippet about timeouts" },
];
const CODE_HITS = [{ hash: "c1", ranking: 1, path: "src/a.ts", snippet: "some code snippet", lineStart: 10, lineEnd: 20 }];

// ------------------------------------------------------------------ (1) rich default

describe("(1) rich /ask default", () => {
	test("1 search {limit:5} + 1 spawn exact argv, notify contains answer tail, returns answer", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-1";
		const answer = "the isolated answer about delegation timeouts and slow runners";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => ({
			stdout: jsonlAnswer(answer),
			stderr: "",
			exitCode: 0,
		}));
		const notes: Notify[] = [];
		let result: unknown;
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-1", "sess-ask-1", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		// One search with limit 5.
		const searches = calls.filter((c) => c.tool === "memory_search");
		expect(searches).toHaveLength(1);
		expect((searches[0]!.args as Record<string, unknown>)["limit"]).toBe(5);
		expect((searches[0]!.args as Record<string, unknown>)["query"]).toBe(P1);
		// One spawn with exact argv shape (tail: piInvocation may prefix the runner
		// script, so pin the last 8 — the isolated child argv per spec).
		expect(spawnCalls).toHaveLength(1);
		const argv = spawnCalls[0]!.argv;
		const tail = argv.slice(-8);
		expect(tail.length).toBe(8);
		expect(tail.slice(0, 7)).toEqual([
			"-p",
			"--mode",
			"json",
			"--no-session",
			"--exclude-tools",
			ASK_CHILD_EXCLUDED_TOOLS,
			"--",
		]);
		expect(tail[5]).toBe(CHILD_EXCLUDED_TOOLS);
		const prompt = String(tail[7] ?? "");
		expect(prompt).toContain("Memory context (ai-raccoon memory_search");
		expect(prompt).toContain(`Question: ${P1}`);
		expect(spawnCalls[0]!.opts.cwd).toBe("/tmp/ask-1");
		expect(spawnCalls[0]!.opts.timeoutMs).toBe(ASK_CHILD_TIMEOUT_MS);
		// No --model in argv.
		expect(argv).not.toContain("--model");
		// Notify contains answer tail + return value is the answer.
		expect(notes.length).toBeGreaterThan(0);
		expect(notes[notes.length - 1]!.message).toContain(answer);
		expect(notes[notes.length - 1]!.type).toBe("info");
		expect(result).toBe(notes[notes.length - 1]!.message);
		// Status reflects ask counters.
		const status = await ragStatus(pi, "/tmp/ask-1", "sess-ask-1");
		expect(status).toContain("asked 1");
	});
});

// ------------------------------------------------------------------ (2) expanded

describe("(2) expanded /ask", () => {
	test("per-hit gets under deadline with fallback, then spawn", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-2";
		process.env["PI_BADGER_MEM_RAG_MODE"] = "expanded";
		const answer = "expanded isolated answer";
		const { pi, calls, spawnCalls } = installAsk(
			{
				results: MEM_HITS,
				code: CODE_HITS,
				values: {
					m1: { value: "the full decision text for delegation timeouts", path: "shared/a.md", chunkIndex: 1, totalChunks: 36 },
					m2: new Error("memory_get exploded"),
					c1: { value: "full code body for the injection path", path: "src/a.ts", lineStart: 10, lineEnd: 20 },
				},
			},
			async () => ({ stdout: jsonlAnswer(answer), stderr: "", exitCode: 0 }),
		);
		const notes: Notify[] = [];
		const result = await fireAsk(pi, P1, "/tmp/ask-2", "sess-ask-2", notes);
		expect(result).toBe(notes[notes.length - 1]!.message);
		expect(String(result)).toContain(answer);
		const gets = calls.filter((c) => c.tool === "memory_get" || c.tool === "code_get");
		expect(gets.length).toBe(3);
		for (const g of gets) expect(g.timeoutMs).toBeLessThanOrEqual(5000);
		// Fallback + provenance land in the spawned prompt (tail: script prefix aware).
		expect(spawnCalls).toHaveLength(1);
		const prompt = String(spawnCalls[0]!.argv.slice(-8)[7] ?? "");
		expect(prompt).toContain("memory_get/code_get, expanded");
		expect(prompt).toContain("the full decision text");
		expect(prompt).toContain("second memory snippet about timeouts");
	});
});

// ------------------------------------------------------------------ (3) thin

describe("(3) thin /ask", () => {
	test("/ask hi => too-short, no search/spawn, no throw", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-3";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS });
		const notes: Notify[] = [];
		let result: unknown;
		let threw = false;
		try {
			result = await fireAsk(pi, "hi", "/tmp/ask-3", "sess-ask-3", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(spawnCalls).toHaveLength(0);
		expect(notes.length).toBeGreaterThan(0);
		expect(notes[notes.length - 1]!.message).toContain("too-short");
		expect(notes[notes.length - 1]!.type).toBe("info");
	});
});

// ------------------------------------------------------------------ (4) /skill: body

describe("(4) /ask with /skill: body", () => {
	test("skill-prefixed question enriches on stripped query", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-4";
		const answer = "skill-prefixed isolated answer";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => ({
			stdout: jsonlAnswer(answer),
			stderr: "",
			exitCode: 0,
		}));
		const notes: Notify[] = [];
		const result = await fireAsk(pi, `/skill:task ${P1}`, "/tmp/ask-4", "sess-ask-4", notes);
		expect(String(result)).toContain(answer);
		const searches = calls.filter((c) => c.tool === "memory_search");
		expect(searches).toHaveLength(1);
		expect((searches[0]!.args as Record<string, unknown>)["query"]).toBe(P1);
		expect(spawnCalls).toHaveLength(1);
	});
});

// ------------------------------------------------------------------ (5) bank errors

describe("(5) bank throw/timeout", () => {
	test("bank throw => skipped bank-error, no spawn, no throw", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-5";
		const { pi, calls, spawnCalls } = installAsk({ searchError: new Error("bank exploded") });
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-5", "sess-ask-5", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(spawnCalls).toHaveLength(0);
		expect(calls.filter((c) => c.tool === "memory_search")).toHaveLength(1);
		expect(notes[notes.length - 1]!.message).toContain("bank error");
		expect(notes[notes.length - 1]!.type).toBe("info");
	});

	test("bank timeout => skipped bank-error, no spawn, no throw", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-5t";
		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "500";
		const { pi, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS, timeoutReject: true });
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-5t", "sess-ask-5t", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(spawnCalls).toHaveLength(0);
		expect(notes[notes.length - 1]!.message).toContain("bank error");
	}, 10_000);
});

// ------------------------------------------------------------------ (6) child failures

describe("(6) child non-zero/timeout", () => {
	test("non-zero exit => notify failure naming exit code, no throw", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-6";
		const { pi, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => ({
			stdout: jsonlAnswer("partial answer"),
			stderr: "boom",
			exitCode: 1,
		}));
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-6", "sess-ask-6", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(notes[notes.length - 1]!.type).toBe("warning");
		expect(notes[notes.length - 1]!.message).toContain("1");
	});

	test("spawn timeout/reject => notify failure, no throw", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-6t";
		const { pi } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => {
			throw new Error(`ask child timed out after ${ASK_CHILD_TIMEOUT_MS}ms`);
		});
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-6t", "sess-ask-6t", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(notes[notes.length - 1]!.type).toBe("warning");
		expect(notes[notes.length - 1]!.message).toContain("timed out");
	});

	test("empty/silent/malformed stdout => notify skip, never empty answer", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-6e";
		for (const stdout of ["", "not json at all\nstill not json\n", JSON.stringify({ type: "session", id: "x" })]) {
			const { pi } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => ({
				stdout,
				stderr: "",
				exitCode: 0,
			}));
			const notes: Notify[] = [];
			let result: unknown = "sentinel";
			let threw = false;
			try {
				result = await fireAsk(pi, P1, "/tmp/ask-6e", "sess-ask-6e", notes);
			} catch {
				threw = true;
			}
			expect(threw, JSON.stringify(stdout)).toBe(false);
			expect(result, JSON.stringify(stdout)).toBeUndefined();
			expect(notes.length, JSON.stringify(stdout)).toBeGreaterThan(0);
			expect(notes[notes.length - 1]!.type, JSON.stringify(stdout)).toBe("info");
		}
	});
});

// ------------------------------------------------------------------ (7) missing ids

describe("(7) missing project/session id", () => {
	test("no project id => skip, no search/spawn", async () => {
		clearRagEnv();
		const empty = mkTmp("ask-noproj-");
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS });
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, empty, "sess-ask-7", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(spawnCalls).toHaveLength(0);
		expect(notes[notes.length - 1]!.message).toContain("no project id");
	});

	test("no session id => skip, no search/spawn", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-7";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS });
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-7", "", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(spawnCalls).toHaveLength(0);
		expect(notes[notes.length - 1]!.message).toContain("no session id");
	});
});

// ------------------------------------------------------------------ (8) excluded-tools pin

describe("(8) CHILD_EXCLUDED_TOOLS pin", () => {
	test("ask excluded-tools duplicates subagent value (copy literal, no runtime import)", async () => {
		expect(ASK_CHILD_EXCLUDED_TOOLS).toBe(CHILD_EXCLUDED_TOOLS);
		expect(ASK_CHILD_EXCLUDED_TOOLS).toBe("delegate,delegations,queue,monitor,wait");
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-8";
		const { pi, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => ({
			stdout: jsonlAnswer("pin answer"),
			stderr: "",
			exitCode: 0,
		}));
		const notes: Notify[] = [];
		await fireAsk(pi, P1, "/tmp/ask-8", "sess-ask-8", notes);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]!.argv.slice(-8)[5]).toBe(CHILD_EXCLUDED_TOOLS);
	});
});

// ------------------------------------------------------------------ (9) shutdown kills in-flight + resets

describe("(9) shutdown kills in-flight + resets ask counters", () => {
	test("pending spawn settles on shutdown, counters reset", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-9";
		const { pi, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS }, () => new Promise<SpawnResult>(() => {}));
		const notes: Notify[] = [];
		const pending = fireAsk(pi, P1, "/tmp/ask-9", "sess-ask-9", notes);
		// Wait for the spawn to start (search is fast, spawn hangs).
		const deadline = Date.now() + 5000;
		while (spawnCalls.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(spawnCalls).toHaveLength(1);
		const ctx = makeAskCtx("/tmp/ask-9", "sess-ask-9", []);
		await fireSession(pi, "session_shutdown", ctx as never);
		// Pending handler must settle (abort), never hang on the fake.
		let settled = false;
		let threw = false;
		try {
			const raced = await Promise.race([
				pending.then(
					() => "settled",
					() => "settled",
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2000)),
			]);
			settled = raced === "settled";
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(settled).toBe(true);
		const status = await ragStatus(pi, "/tmp/ask-9", "sess-ask-9");
		expect(status).toContain("asked 0");
		expect(status).toContain("skippedAsk 0");
	}, 10_000);
});

// ------------------------------------------------------------------ (10) mode off

describe("(10) mode off / env kill-switch", () => {
	test("session mode off => skip, no search/spawn", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-10";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS });
		const cwd = "/tmp/ask-10";
		const rag = pi.commands.get("rag") as unknown as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const tmp: Notify[] = [];
		await rag.handler("mode off", makeAskCtx(cwd, "sess-ask-10", tmp) as never);
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, cwd, "sess-ask-10", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(spawnCalls).toHaveLength(0);
		expect(notes[notes.length - 1]!.message).toMatch(/off/i);
	});

	test("PI_BADGER_MEM_RAG=0 => skip, no search/spawn", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-10e";
		process.env["PI_BADGER_MEM_RAG"] = "0";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS });
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, P1, "/tmp/ask-10e", "sess-ask-10e", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(spawnCalls).toHaveLength(0);
		expect(notes[notes.length - 1]!.message).toMatch(/off/i);
	});
});

// ------------------------------------------------------------------ (11) review SHOULD-1: stripped question

describe("(11) /ask child prompt carries the stripped query", () => {
	test("/skill:<id> <text> args => search query AND Question: both stripped", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-ask-11";
		const answer = "stripped-question answer";
		const { pi, calls, spawnCalls } = installAsk({ results: MEM_HITS, code: CODE_HITS }, async () => ({
			stdout: jsonlAnswer(answer),
			stderr: "",
			exitCode: 0,
		}));
		const notes: Notify[] = [];
		const args = `/skill:task ${P1}`;
		const result = await fireAsk(pi, args, "/tmp/ask-11", "sess-ask-11", notes);
		expect(result).toBe(notes[notes.length - 1]!.message);
		const searches = calls.filter((c) => c.tool === "memory_search");
		expect(searches).toHaveLength(1);
		expect((searches[0]!.args as Record<string, unknown>)["query"]).toBe(P1);
		expect(spawnCalls).toHaveLength(1);
		const prompt = String(spawnCalls[0]!.argv.slice(-8)[7] ?? "");
		expect(prompt).toContain(`Question: ${P1}`);
		expect(prompt).not.toContain("/skill:task");
	});
});

// ------------------------------------------------------------------ (12) review SHOULD-2: pure-function pins

describe("(12) ask pure-function pins", () => {
	test("capAskAnswer: short text untouched, long text tail-capped with drop notice", () => {
		expect(capAskAnswer("tiny", 100)).toBe("tiny");
		expect(capAskAnswer("x".repeat(100), 100)).toBe("x".repeat(100));
		const long = `head-${"y".repeat(200)}-tail`;
		const capped = capAskAnswer(long, 50);
		expect(capped.length).toBeLessThan(long.length);
		expect(capped).toContain("earlier characters dropped");
		expect(capped.endsWith(long.slice(-50))).toBe(true);
		expect(ASK_ANSWER_CAP_CHARS).toBe(8 * 1024);
	});

	test("parseAskAnswer: flat {result|answer|text} + {event:{...}} shapes", () => {
		expect(parseAskAnswer(`${JSON.stringify({ result: "flat result" })}\n`)).toBe("flat result");
		expect(parseAskAnswer(`${JSON.stringify({ answer: "flat answer" })}\n`)).toBe("flat answer");
		expect(parseAskAnswer(`${JSON.stringify({ text: "flat text" })}\n`)).toBe("flat text");
		expect(parseAskAnswer(`${JSON.stringify({ event: { text: "wrapped text" } })}\n`)).toBe("wrapped text");
		expect(parseAskAnswer(`${JSON.stringify({ event: { answer: "wrapped answer" } })}\n`)).toBe("wrapped answer");
		// Non-JSON lines ignored, empty envelope yields "".
		expect(parseAskAnswer("not json\n\n")).toBe("");
		expect(parseAskAnswer("")).toBe("");
	});

	test("askPiInvocation: script-exists re-runs the runner, else pi on PATH", () => {
		const argv = ["-p", "--", "q"];
		const via = askPiInvocation(argv, { argv: ["node", "/tmp/pi-run.js"], execPath: "/usr/bin/node" }, () => true);
		expect(via).toEqual({ command: "/usr/bin/node", args: ["/tmp/pi-run.js", ...argv] });
		const fallback = askPiInvocation(argv, { argv: [], execPath: "/usr/bin/node" }, () => false);
		expect(fallback).toEqual({ command: "pi", args: argv });
	});
});
