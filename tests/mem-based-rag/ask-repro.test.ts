/**
 * P1 repro + lock hunt (RED-first lane).
 *
 * Drives the REAL /ask handler (extensions/mem-based-rag/index.ts:782) with
 * hung seams. Every hung leg names the awaiting seam file:line — the
 * non-settling path IS the input lock (commands-first branch awaits the
 * handler, so a hung handler = locked TUI).
 *
 * Settle bounds (M2 — prod timers bypassed by hung fakes, so the fix must
 * impose these; REDs set PI_BADGER_MEM_RAG_TIMEOUT_MS=500, precedent
 * ask.test.ts (5); bound ≤1s vs 5s budget):
 *   pre-search  getClient      index.ts:521 (await fresh.initialize) — SYNC
 *               createClient cannot hang (M1, see below); bound = config.timeoutMs
 *   search      searchCall     index.ts:833 (await searchCall) → 534 (raccoon.call)
 *               bound = config.timeoutMs (500ms in REDs)
 *   expanded    fan-out        index.ts:866 (Promise.all) → 870/875 (fetchFull)
 *               → 722 (raccoon.call); bound = min(remaining,5000) (500ms in REDs)
 *   child-await spawn race     index.ts:907 (Promise.race spawn/abort)
 *               bound = config.timeoutMs (500ms in REDs; prod default 90s
 *               ASK_CHILD_TIMEOUT_MS cannot settle ≤5s)
 *   abort-race  askAbort       index.ts:904-905 (rejectAbort) → 907 race
 *               bound = immediate on session_shutdown, NO notify (M5)
 *   flight      poisoning      index.ts:535 (searchFlight.then(run,run))
 *               bound = search bound (flight advances on timeout, never poisons)
 *
 * M1 FOLD: MemRagDeps.createClient (index.ts:458,427-429) is SYNCHRONOUS
 * `(bin) => RaccoonClientLike` — an injected fake returns immediately, so it
 * can never hang getClient (index.ts:517-524, await only when
 * `fresh instanceof RaccoonClient` at 521). The only hanging pre-search leg
 * would be a RaccoonClient subclass overriding initialize() (342-347) to
 * never settle, bypassing the prod 15s init timer (354-357). Dropped per the
 * allowed escape hatch: initPromise catch (343-346) already clears the memo
 * on rejection, prod init is bounded (15s), and search-call + poisoning legs
 * cover the pre-search lock surface. No subclass leg in this file.
 *
 * M5 FOLD: abort-race asserts settles + counters reset + NO notify —
 * notifying into shutdown is wrong (precedent ask.test.ts (9)). No other
 * path pins notify shape.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";
import factory from "../../extensions/mem-based-rag/index.ts";

// ------------------------------------------------------------------ env hygiene

const RAG_KEYS = [
	"PI_BADGER_MEM_RAG",
	"PI_BADGER_MEM_RAG_MODE",
	"PI_BADGER_MEM_RAG_MIN_WORDS",
	"PI_BADGER_MEM_RAG_MIN_CHARS",
	"PI_BADGER_MEM_RAG_TIMEOUT_MS",
	"PI_BADGER_MEM_RAG_ASK_CHILD_TIMEOUT_MS",
	"PI_BADGER_MEM_RAG_SNIPPET_CHARS",
	"PI_BADGER_MEM_RAG_BIN",
	"AI_BADGER_PROJECT_ID",
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};
for (const k of RAG_KEYS) ORIG_ENV[k] = process.env[k];

afterEach(() => {
	for (const k of RAG_KEYS) {
		const v = ORIG_ENV[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function clearRagEnv(): void {
	for (const k of RAG_KEYS) delete process.env[k];
}

// ------------------------------------------------------------------ helpers

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
	return cmd.handler(args, makeAskCtx(cwd, sessionId, notes) as never);
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
	await cmd.handler("status", makeAskCtx(cwd, sessionId, notes) as never);
	return notes.map((n) => n.message).join("\n");
}

/** Never-settling seam — bypasses every prod timer by never resolving. */
function never<T = string>(): Promise<T> {
	return new Promise<T>(() => {});
}

function jsonlAnswer(text: string): string {
	return [
		JSON.stringify({ type: "session", id: "sess-ask" }),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		}),
	].join("\n");
}

/** Race a handler against a budget; settled=false IS the lock. */
async function raceBudget(
	promise: Promise<unknown>,
	budgetMs: number,
): Promise<{ settled: boolean; value?: unknown; error?: unknown }> {
	const hung = { settled: false as const };
	const raced = await Promise.race([
		promise.then(
			(value) => ({ settled: true as const, value }),
			(error: unknown) => ({ settled: true as const, error }),
		),
		new Promise<typeof hung>((resolve) => setTimeout(() => resolve(hung), budgetMs)),
	]);
	return raced;
}

const P1 = "explain how delegation timeout interacts with slow CI runners tomorrow morning please";
const MEM_HITS = [
	{ hash: "m1", ranking: 1, path: "shared/a.md", snippet: "first memory snippet about delegation" },
	{ hash: "m2", ranking: 0.9, path: "shared/b.md", snippet: "second memory snippet about timeouts" },
];
const CODE_HITS = [{ hash: "c1", ranking: 1, path: "src/a.ts", snippet: "some code snippet", lineStart: 10, lineEnd: 20 }];

const BUDGET_MS = 5000;

// ------------------------------------------------------------------ H1 thin pin

describe("P1 H1 thin-skip stays NOTIFY-ONLY", () => {
	test("hi → too-short notifies exactly once with info (notify-spy)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-repro-h1";
		const pi = createFakePi();
		const calls: Array<{ tool: string }> = [];
		const spawnCalls: unknown[] = [];
		(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
			createClient: () => ({
				call: async (tool: string): Promise<string> => {
					calls.push({ tool });
					return JSON.stringify({ data: { results: [], code: [] } });
				},
				stop: () => {},
			}),
			spawnAsk: async (..._a: unknown[]): Promise<never> => {
				spawnCalls.push(_a);
				return never();
			},
		});
		const notes: Notify[] = [];
		let result: unknown = "sentinel";
		let threw = false;
		try {
			result = await fireAsk(pi, "hi", "/tmp/repro-h1", "sess-repro-h1", notes);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(spawnCalls).toHaveLength(0);
		// NOTIFY-ONLY forever: exactly one info notify (P2 must not card this — M5).
		expect(notes).toHaveLength(1);
		expect(notes[0]!.message).toContain("too-short");
		expect(notes[0]!.type).toBe("info");
	});
});

// ------------------------------------------------------------------ H3 every-path-settles

describe("P1 H3 every-path-settles (hung seam = locked TUI)", () => {
	test("search-level hung call settles within budget (seam index.ts:833→534)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-repro-search";
		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "500";
		const pi = createFakePi();
		(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
			createClient: () => ({
				call: async (tool: string): Promise<string> => {
					if (tool === "memory_search") return never();
					return JSON.stringify({ data: {} });
				},
				stop: () => {},
			}),
			spawnAsk: async () => ({ stdout: jsonlAnswer("unreached"), stderr: "", exitCode: 0 }),
		});
		const notes: Notify[] = [];
		const raced = await raceBudget(fireAsk(pi, P1, "/tmp/repro-search", "sess-repro-search", notes), BUDGET_MS);
		expect(raced.settled).toBe(true);
		if (!raced.settled) return;
		expect(raced.error).toBeUndefined();
	}, 10_000);

	test("per-hit hung get settles within budget (seam index.ts:866→870/875→722)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-repro-get";
		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "500";
		process.env["PI_BADGER_MEM_RAG_MODE"] = "expanded";
		const pi = createFakePi();
		(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
			createClient: () => ({
				call: async (tool: string): Promise<string> => {
					if (tool === "memory_search")
						return JSON.stringify({ data: { results: MEM_HITS, code: CODE_HITS } });
					return never();
				},
				stop: () => {},
			}),
			spawnAsk: async () => ({ stdout: jsonlAnswer("expanded fallback answer"), stderr: "", exitCode: 0 }),
		});
		const notes: Notify[] = [];
		const raced = await raceBudget(fireAsk(pi, P1, "/tmp/repro-get", "sess-repro-get", notes), BUDGET_MS);
		expect(raced.settled).toBe(true);
		if (!raced.settled) return;
		expect(raced.error).toBeUndefined();
	}, 10_000);

	test("hung spawnAsk settles within budget (seam index.ts:907)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-repro-spawn";
		process.env["PI_BADGER_MEM_RAG_ASK_CHILD_TIMEOUT_MS"] = "500";
		const pi = createFakePi();
		(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
			createClient: () => ({
				call: async (): Promise<string> =>
					JSON.stringify({ data: { results: MEM_HITS, code: CODE_HITS } }),
				stop: () => {},
			}),
			spawnAsk: async (): Promise<never> => never(),
		});
		const notes: Notify[] = [];
		const raced = await raceBudget(fireAsk(pi, P1, "/tmp/repro-spawn", "sess-repro-spawn", notes), BUDGET_MS);
		expect(raced.settled).toBe(true);
		if (!raced.settled) return;
		expect(raced.error).toBeUndefined();
	}, 10_000);

	test("poisoned searchFlight: NEXT turn settles (seam index.ts:535)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-repro-poison";
		process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"] = "500";
		const pi = createFakePi();
		let searches = 0;
		(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
			createClient: () => ({
				call: async (tool: string): Promise<string> => {
					if (tool === "memory_search") {
						searches += 1;
						if (searches === 1) return never();
						return JSON.stringify({ data: { results: MEM_HITS, code: CODE_HITS } });
					}
					return JSON.stringify({ data: {} });
				},
				stop: () => {},
			}),
			spawnAsk: async () => ({ stdout: jsonlAnswer("poison-recovery answer"), stderr: "", exitCode: 0 }),
		});
		// Prior hung search occupies the single-flight chain (index.ts:535).
		const firstNotes: Notify[] = [];
		const first = fireAsk(pi, P1, "/tmp/repro-poison", "sess-repro-poison", firstNotes);
		// Let the first turn reach its hung search before the next turn queues.
		await new Promise((r) => setTimeout(r, 100));
		const secondNotes: Notify[] = [];
		const raced = await raceBudget(
			fireAsk(pi, P1, "/tmp/repro-poison", "sess-repro-poison", secondNotes),
			BUDGET_MS,
		);
		expect(raced.settled).toBe(true);
		if (!raced.settled) {
			await Promise.race([first.then(() => undefined, () => undefined), new Promise((r) => setTimeout(r, 100))]);
			return;
		}
		expect(raced.error).toBeUndefined();
		// Prior hung turn must also settle (bounded) — never leaks a poisoned flight.
		const firstRaced = await raceBudget(first, BUDGET_MS);
		expect(firstRaced.settled).toBe(true);
	}, 10_000);

	test("abort-race: shutdown settles promptly + counters reset + NO notify (seam index.ts:904-905→907)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-repro-abort";
		process.env["PI_BADGER_MEM_RAG_ASK_CHILD_TIMEOUT_MS"] = "500";
		const pi = createFakePi();
		let spawnSeen = 0;
		(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
			createClient: () => ({
				call: async (): Promise<string> =>
					JSON.stringify({ data: { results: MEM_HITS, code: CODE_HITS } }),
				stop: () => {},
			}),
			spawnAsk: async (): Promise<never> => {
				spawnSeen += 1;
				return never();
			},
		});
		const notes: Notify[] = [];
		const pending = fireAsk(pi, P1, "/tmp/repro-abort", "sess-repro-abort", notes);
		const deadline = Date.now() + 5000;
		while (spawnSeen === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(spawnSeen).toBe(1);
		await fireSession(pi, "session_shutdown", makeAskCtx("/tmp/repro-abort", "sess-repro-abort", []) as never);
		const raced = await raceBudget(pending, 2000);
		expect(raced.settled).toBe(true);
		if (!raced.settled) return;
		expect(raced.error).toBeUndefined();
		// M5: notifying into shutdown is wrong — the aborted turn itself emits
		// nothing at/after shutdown. P2 H4 amend (forced: H4's pre-first-await ack
		// fires during live operation, before this shutdown): the lone note is
		// the ack, never a result/failure, and no durable card goes out either.
		expect(notes).toHaveLength(1);
		expect(notes[0]!.message).toContain("searching for");
		expect(pi.sent).toHaveLength(0);
		// SHOULD-1: a delayed stray finish from the orphaned askSettle budget
		// (500ms here) would land after the settle asserts — wait it out, then
		// re-assert nothing further was emitted post-shutdown.
		await new Promise((r) => setTimeout(r, 1200));
		expect(notes).toHaveLength(1);
		expect(pi.sent).toHaveLength(0);
		const status = await ragStatus(pi, "/tmp/repro-abort", "sess-repro-abort");
		expect(status).toContain("asked 0");
		expect(status).toContain("skippedAsk 0");
	}, 10_000);
});
