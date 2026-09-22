/**
 * PKG-2 Jev score-client rows: S1–S16 from the test plan, corrected where the
 * committed plan §4 supersedes the older P3 table, plus the plan-review C4 rows
 * (warm one-call/state/cap/discard/never-throws; per-attempt
 * `min(env, deadline−now)` and ≤0→skip; pool cap 48; usage sum; error-kind
 * union parity; score clamp; `path` falls back to `sourceFile`).
 *
 * Supersessions recorded here (plan §4 is authoritative):
 *  - S1's old `timeout 30000` is `SCORE_TIMEOUT_DEFAULT_MS = 15000` (§4 env table).
 *  - S4's old "retry on the injected scheduler" is "no backoff; retry immediately";
 *    the scheduler is only ever armed for the per-attempt timeout.
 *  - S8's old "429 arms the scheduler at Retry-After" is "Retry-After recorded,
 *    never slept on" (§4 bullet).
 *
 * Hermetic by construction: stub fetch, manual scheduler, fixed clock, injected
 * env — zero network, zero real timers. Fixtures live in
 * `fixtures/score-fixtures.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { JevErrorKind } from "../../extensions/decision-router/decision-router-client.ts";
import {
	classifyScoreResponse,
	createJevScorer,
	SCORE_ATTEMPTS,
	SCORE_BATCH_MAX,
	SCORE_CRITERIA,
	SCORE_ENDPOINT_DEFAULT,
	SCORE_ERROR_KINDS,
	SCORE_MODEL_DEFAULT,
	SCORE_NON_RETRYABLE_KINDS,
	SCORE_POOL_MAX,
	SCORE_QUESTION,
	SCORE_RETRYABLE_KINDS,
	SCORE_TIMEOUT_DEFAULT_MS,
	WARM_TIMEOUT_MS,
	warmJevScore,
	type JevScoreDeps,
	type JevScoreErrorKind,
	type JevScoreFetchFn,
	type JevScoreFetchInit,
	type JevScoreFetchResponse,
} from "../../extensions/query-pipeline/jev-client.ts";
import type { PipelineCandidate, PipelineScheduler, PipelineScorerFn } from "../../extensions/query-pipeline/types.ts";
import {
	MEASURED_CRITERIA,
	MEASURED_PROMPT,
	MEASURED_QUESTION,
	MEASURED_SCORE_ANSWER,
	SYNTH_SCORE_BAD_REQUEST_BODY,
	SYNTH_SCORE_ERROR_ENVELOPE,
	SYNTH_SCORE_PARTIAL_ANSWERS_BODY,
	SYNTH_SCORE_PAYMENT_REQUIRED_BODY,
	SYNTH_SCORE_RATE_LIMITED_BODY,
	SYNTH_SCORE_SERVER_ERROR_BODY,
	SYNTH_SCORE_TRUNCATED_JSON,
	SYNTH_SCORE_UNAUTHORIZED_BODY,
	SYNTH_SCORE_WRONG_SHAPES_BODY,
	measuredScoreQuestion,
} from "./fixtures/score-fixtures.ts";

// ------------------------------------------------------------------ test doubles

const FIXED_NOW = 1_700_000_000_000;
const DEADLINE = FIXED_NOW + 60_000;
const PROMPT = "raw prompt for scoring";

interface StubState {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly text?: string;
	readonly never?: boolean;
	readonly throws?: unknown;
}

type StubResponder = (callIndex: number, url: string, init: JevScoreFetchInit) => StubState;

interface Stub {
	readonly fetchFn: JevScoreFetchFn;
	readonly calls: Array<{ url: string; init: JevScoreFetchInit }>;
}

function makeStub(responder: StubState | StubResponder): Stub {
	const calls: Array<{ url: string; init: JevScoreFetchInit }> = [];
	const fetchFn: JevScoreFetchFn = (url, init) => {
		const callIndex = calls.length;
		calls.push({ url, init });
		const state = typeof responder === "function" ? responder(callIndex, url, init) : responder;
		if (state.throws !== undefined) return Promise.reject(state.throws);
		if (state.never === true) return new Promise<never>(() => {});
		const lowered: Record<string, string> = {};
		for (const [name, value] of Object.entries(state.headers ?? {})) lowered[name.toLowerCase()] = value;
		return Promise.resolve({
			status: state.status,
			headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null },
			text: () => Promise.resolve(state.text ?? ""),
		});
	};
	return { fetchFn, calls };
}

interface ManualScheduler extends PipelineScheduler {
	fire(): number;
	pendingCount(): number;
	lastDelayMs(): number | undefined;
}

function makeManualScheduler(): ManualScheduler {
	const pending = new Map<unknown, () => void>();
	let seq = 0;
	let lastDelay: number | undefined;
	return {
		setTimeout: (handler, timeoutMs) => {
			seq += 1;
			pending.set(seq, handler);
			lastDelay = timeoutMs;
			return seq;
		},
		clearTimeout: (handle) => {
			pending.delete(handle);
		},
		fire: () => {
			const handlers = [...pending.values()];
			pending.clear();
			for (const handler of handlers) handler();
			return handlers.length;
		},
		pendingCount: () => pending.size,
		lastDelayMs: () => lastDelay,
	};
}

interface DepsOptions {
	readonly env?: Record<string, string | undefined>;
	readonly manual?: ManualScheduler;
	readonly now?: () => number;
}

function depsFor(stub: Stub, options: DepsOptions = {}): { deps: JevScoreDeps; manual: ManualScheduler } {
	const manual = options.manual ?? makeManualScheduler();
	return {
		deps: {
			fetchFn: stub.fetchFn,
			scheduler: manual,
			now: options.now ?? (() => FIXED_NOW),
			env: options.env ?? { OPENROUTER_API_KEY: "test-key" },
		},
		manual,
	};
}

function cand(hash: string, overrides: Partial<PipelineCandidate> = {}): PipelineCandidate {
	return { hash, path: `docs/${hash}.md`, snippet: `snippet ${hash}`, kind: "memory", ...overrides };
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

/** A response double for the classifier rows. */
function responseLike(status: number, text: string, headers?: Record<string, string>): JevScoreFetchResponse {
	return {
		status,
		headers: { get: (name: string) => headers?.[name.toLowerCase()] ?? null },
		text: () => Promise.resolve(text),
	};
}

/** A 200 body that answers every question in the request body with the given score. */
function answeringStub(
	scoreFor: (path: string, name: string) => number = () => 1,
	usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5, cost: 0.001 },
): Stub {
	return makeStub((_callIndex, _url, init) => {
		const sent = JSON.parse(init.body) as {
			questions: Record<string, { instructions: { candidate: { path: string } } }>;
		};
		const answers: Record<string, unknown> = {};
		for (const [name, question] of Object.entries(sent.questions)) {
			answers[name] = { type: "score", score: scoreFor(question.instructions.candidate.path, name), confidence: 0.9 };
		}
		return {
			status: 200,
			text: JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage }),
		};
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 25; i++) await Promise.resolve();
}

// Compile-level seam assertion (plan-review C4 / architect F3): type drift fails
// this package's typecheck gate.
const _compileStub = makeStub({ status: 200, text: "{}" });
const _compileScheduler = makeManualScheduler();
const _score: PipelineScorerFn = createJevScorer({
	env: {},
	scheduler: _compileScheduler,
	now: () => 0,
	fetchFn: _compileStub.fetchFn,
});

// ------------------------------------------------------------------ S1 + vocabulary

describe("frozen consts and vocabulary (S1, S7, C4)", () => {
	test("S1 frozen consts: batch 12, attempts 3, pool 48, timeout 15000, warm 5000, endpoint and model defaults", () => {
		expect(SCORE_BATCH_MAX).toBe(12);
		expect(SCORE_ATTEMPTS).toBe(3);
		expect(SCORE_POOL_MAX).toBe(48);
		expect(SCORE_TIMEOUT_DEFAULT_MS).toBe(15000);
		expect(WARM_TIMEOUT_MS).toBe(5000);
		expect(SCORE_ENDPOINT_DEFAULT).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(SCORE_MODEL_DEFAULT).toBe("typesafe/jev-1.13");
		expect(SCORE_QUESTION).toBe(MEASURED_QUESTION);
		expect([...SCORE_CRITERIA]).toEqual([...MEASURED_CRITERIA]);
		expect(typeof _score).toBe("function");
	});

	test("S7 HTTP status maps to the frozen error-kind vocabulary", async () => {
		expect(await classifyScoreResponse(responseLike(400, SYNTH_SCORE_BAD_REQUEST_BODY), ["c0"])).toMatchObject({
			status: "error",
			kind: "misrouted-refusal",
		});
		expect(await classifyScoreResponse(responseLike(401, SYNTH_SCORE_UNAUTHORIZED_BODY), ["c0"])).toMatchObject({
			status: "error",
			kind: "auth",
		});
		expect(await classifyScoreResponse(responseLike(402, SYNTH_SCORE_PAYMENT_REQUIRED_BODY), ["c0"])).toMatchObject({
			status: "error",
			kind: "billing",
		});
		expect(await classifyScoreResponse(responseLike(429, SYNTH_SCORE_RATE_LIMITED_BODY), ["c0"])).toMatchObject({
			status: "error",
			kind: "rate-limited",
		});
		expect(await classifyScoreResponse(responseLike(500, SYNTH_SCORE_SERVER_ERROR_BODY), ["c0"])).toMatchObject({
			status: "error",
			kind: "server",
		});
		expect(await classifyScoreResponse(responseLike(503, ""), ["c0"])).toMatchObject({ status: "error", kind: "server" });
	});

	test("C4 error-kind union parity with decision-router's list", () => {
		// Bidirectional assignability: a member missing on either side is a compile error.
		const routerKinds: JevErrorKind[] = [...SCORE_ERROR_KINDS];
		const scoreKinds: JevScoreErrorKind[] = routerKinds;
		expect(scoreKinds).toHaveLength(routerKinds.length);
		expect([...SCORE_ERROR_KINDS].sort()).toEqual([
			"auth",
			"billing",
			"malformed",
			"misrouted-refusal",
			"missing-key",
			"rate-limited",
			"server",
			"transport-timeout",
		]);
		expect([...SCORE_RETRYABLE_KINDS, ...SCORE_NON_RETRYABLE_KINDS].sort()).toEqual([...SCORE_ERROR_KINDS].sort());
		expect([...SCORE_RETRYABLE_KINDS].sort()).toEqual(["malformed", "rate-limited", "server", "transport-timeout"]);
	});
});

// ------------------------------------------------------------------ batching + wire shape

describe("batching and wire shape (S2, S3, S13, C4)", () => {
	test("S2 25 candidates batch into 12/12/1 requests, each carrying only its own candidates", async () => {
		const stub = answeringStub();
		const { deps } = depsFor(stub);
		const candidates = Array.from({ length: 25 }, (_, i) => cand(`h${i}`));
		const result = await createJevScorer(deps)(PROMPT, candidates, signal(), DEADLINE);

		expect(stub.calls).toHaveLength(3);
		const keySets = stub.calls.map((call) => Object.keys((JSON.parse(call.init.body) as { questions: object }).questions));
		expect(keySets[0]).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`));
		expect(keySets[1]).toEqual(Array.from({ length: 12 }, (_, i) => `c${i + 12}`));
		expect(keySets[2]).toEqual(["c24"]);
		for (const call of stub.calls) {
			const sent = JSON.parse(call.init.body) as { state: string };
			expect(sent.state).toBe(PROMPT);
		}
		expect(result.batches).toBe(3);
		expect(result.results).toHaveLength(25);
		expect(result.results.every((entry) => entry.score === 1)).toBe(true);
	});

	test("S3 12 candidates make one request; 13 make two", async () => {
		const twelve = answeringStub();
		const twelveDeps = depsFor(twelve);
		await createJevScorer(twelveDeps.deps)(PROMPT, Array.from({ length: 12 }, (_, i) => cand(`h${i}`)), signal(), DEADLINE);
		expect(twelve.calls).toHaveLength(1);

		const thirteen = answeringStub();
		const thirteenDeps = depsFor(thirteen);
		await createJevScorer(thirteenDeps.deps)(PROMPT, Array.from({ length: 13 }, (_, i) => cand(`h${i}`)), signal(), DEADLINE);
		expect(thirteen.calls).toHaveLength(2);
	});

	test("S13 the request body is the frozen score wire shape", async () => {
		const stub = makeStub({ status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) });
		const { deps } = depsFor(stub);
		await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);

		const call = stub.calls[0];
		expect(call?.url).toBe(SCORE_ENDPOINT_DEFAULT);
		expect(call?.init.method).toBe("POST");
		expect(call?.init.headers["Authorization"]).toBe("Bearer test-key");
		expect(call?.init.headers["Content-Type"]).toBe("application/json");

		const sent = JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
		expect(sent.model).toBe(SCORE_MODEL_DEFAULT);
		expect(sent.state).toBe(PROMPT);

		const questions = sent.questions as Record<string, Record<string, unknown>>;
		expect(Object.keys(questions)).toEqual(["c0"]);
		const question = questions["c0"] ?? {};
		expect(Object.keys(question).sort()).toEqual(["criteria", "instructions", "type"]);
		expect(question["type"]).toBe("score");
		const instructions = question["instructions"] as Record<string, unknown>;
		expect(Object.keys(instructions).sort()).toEqual(["candidate", "question"]);
		const candidate = instructions["candidate"] as Record<string, unknown>;
		expect(Object.keys(candidate).sort()).toEqual(["excerpt", "kind", "path"]);
		expect(candidate).toEqual({ path: "docs/a.md", kind: "memory", excerpt: "snippet a" });
		expect(question["criteria"]).toEqual([...MEASURED_CRITERIA]);
		expect(instructions["question"]).toBe(MEASURED_QUESTION);
		expect(question).toEqual(JSON.parse(JSON.stringify(measuredScoreQuestion({ path: "docs/a.md", kind: "memory", excerpt: "snippet a" }))));
	});

	test("S13b state caps at 32000 chars and excerpt at 500 chars", async () => {
		const stub = makeStub({ status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) });
		const { deps } = depsFor(stub);
		await createJevScorer(deps)(
			"x".repeat(40_000),
			[cand("a", { snippet: "y".repeat(700) })],
			signal(),
			DEADLINE,
		);
		const sent = JSON.parse(stub.calls[0]?.init.body ?? "{}") as {
			state: string;
			questions: Record<string, { instructions: { candidate: { excerpt: string } } }>;
		};
		expect(sent.state).toHaveLength(32_000);
		expect(sent.questions["c0"]?.instructions.candidate.excerpt).toHaveLength(500);
	});

	test("C4 candidate path falls back to sourceFile, then to the empty string", async () => {
		const stub = answeringStub();
		const { deps } = depsFor(stub);
		const candidates: PipelineCandidate[] = [
			{ hash: "s1", sourceFile: "docs/source.md", snippet: "x" },
			{ hash: "s2", snippet: "x" },
			{ hash: "s3", path: "", sourceFile: "docs/ignored.md", snippet: "x" },
		];
		await createJevScorer(deps)(PROMPT, candidates, signal(), DEADLINE);
		const sent = JSON.parse(stub.calls[0]?.init.body ?? "{}") as {
			questions: Record<string, { instructions: { candidate: { path: string } } }>;
		};
		expect(sent.questions["c0"]?.instructions.candidate.path).toBe("docs/source.md");
		expect(sent.questions["c1"]?.instructions.candidate.path).toBe("");
		// `??` semantics: an empty `path` is kept, `sourceFile` is not consulted.
		expect(sent.questions["c2"]?.instructions.candidate.path).toBe("");
	});
});

// ------------------------------------------------------------------ retries

describe("retries (S4, S5, S6)", () => {
	test("S4 a server error retries immediately and succeeds on attempt 2", async () => {
		const stub = makeStub((callIndex) =>
			callIndex === 0
				? { status: 500, text: SYNTH_SCORE_SERVER_ERROR_BODY }
				: { status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) },
		);
		const { deps, manual } = depsFor(stub);
		const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);
		expect(stub.calls).toHaveLength(2);
		expect(result.results[0]?.score).toBe(2.5);
		expect(result.batches).toBe(1);
		// No backoff: the only scheduler delays are the per-attempt timeouts, all cleared.
		expect(manual.lastDelayMs()).toBe(SCORE_TIMEOUT_DEFAULT_MS);
		expect(manual.pendingCount()).toBe(0);
	});

	test("S5 retry is capped at three attempts; a fourth is never sent", async () => {
		const stub = makeStub({ status: 500, text: SYNTH_SCORE_SERVER_ERROR_BODY });
		const { deps, manual } = depsFor(stub);
		const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);
		expect(stub.calls).toHaveLength(SCORE_ATTEMPTS);
		expect(stub.calls).toHaveLength(3);
		expect(result.results[0]?.score).toBeNull();
		expect(result.batches).toBe(1);
		expect(manual.pendingCount()).toBe(0);
	});

	test("S6 auth, billing and misrouted-refusal make exactly one call", async () => {
		const rows: Array<[number, string, JevScoreErrorKind]> = [
			[401, SYNTH_SCORE_UNAUTHORIZED_BODY, "auth"],
			[402, SYNTH_SCORE_PAYMENT_REQUIRED_BODY, "billing"],
			[400, SYNTH_SCORE_BAD_REQUEST_BODY, "misrouted-refusal"],
		];
		for (const [status, body, kind] of rows) {
			const stub = makeStub({ status, text: body });
			const { deps } = depsFor(stub);
			const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);
			expect(stub.calls).toHaveLength(1);
			expect(result.results[0]?.score).toBeNull();
			expect(await classifyScoreResponse(responseLike(status, body), ["c0"])).toMatchObject({ status: "error", kind });
		}
	});

	test("S8 429's Retry-After is recorded on the typed outcome, never slept on", async () => {
		const rows: Array<[string | undefined, number]> = [
			["5", 60_000],
			["120", 120_000],
			["7200", 3_600_000],
			[undefined, 60_000],
			["soon", 60_000],
		];
		for (const [header, expected] of rows) {
			const classified = await classifyScoreResponse(
				responseLike(429, SYNTH_SCORE_RATE_LIMITED_BODY, header === undefined ? undefined : { "retry-after": header }),
				["c0"],
			);
			expect(classified).toMatchObject({ status: "error", kind: "rate-limited", retryAfterMs: expected });
		}

		// The scorer retries immediately: 429 then 200, and the only scheduler
		// delay observed is the per-attempt timeout, not the Retry-After value.
		const stub = makeStub((callIndex) =>
			callIndex === 0
				? { status: 429, headers: { "retry-after": "5" }, text: SYNTH_SCORE_RATE_LIMITED_BODY }
				: { status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) },
		);
		const { deps, manual } = depsFor(stub);
		const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);
		expect(stub.calls).toHaveLength(2);
		expect(result.results[0]?.score).toBe(2.5);
		expect(manual.lastDelayMs()).toBe(SCORE_TIMEOUT_DEFAULT_MS);
		expect(manual.pendingCount()).toBe(0);
	});

	test("S14 one failed batch leaves the other batches' scores intact", async () => {
		// Batch 1 answers all 12 questions; batch 2 (candidate 13) fails all three attempts.
		const stub = makeStub((callIndex, _url, init) => {
			if (callIndex !== 0) return { status: 500, text: SYNTH_SCORE_SERVER_ERROR_BODY };
			const sent = JSON.parse(init.body) as { questions: Record<string, unknown> };
			const answers: Record<string, unknown> = {};
			for (const name of Object.keys(sent.questions)) answers[name] = { type: "score", score: 1, confidence: 0.9 };
			return {
				status: 200,
				text: JSON.stringify({
					model: "m",
					answers,
					usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
				}),
			};
		});
		const { deps, manual } = depsFor(stub);
		const result = await createJevScorer(deps)(
			PROMPT,
			Array.from({ length: 13 }, (_, i) => cand(`h${i}`)),
			signal(),
			DEADLINE,
		);
		expect(stub.calls).toHaveLength(4); // batch 1: one call; batch 2: three attempts
		expect(result.batches).toBe(2);
		for (let i = 0; i < 12; i++) expect(result.results[i]?.score).toBe(1);
		expect(result.results[12]?.score).toBeNull();
		expect(manual.pendingCount()).toBe(0);
	});
});

// ------------------------------------------------------------------ timeout + abort

describe("timeout and abort (S9, S16, C4)", () => {
	test("S9 a never-resolving fetch settles to transport-timeout and aborts the signal", async () => {
		const stub = makeStub({ status: 200, never: true });
		const { deps, manual } = depsFor(stub);
		const pending = createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);

		expect(manual.pendingCount()).toBe(1);
		expect(manual.lastDelayMs()).toBe(SCORE_TIMEOUT_DEFAULT_MS);
		manual.fire();
		await flushMicrotasks();
		expect(manual.pendingCount()).toBe(1); // attempt 2 armed
		manual.fire();
		await flushMicrotasks();
		expect(manual.pendingCount()).toBe(1); // attempt 3 armed
		manual.fire();

		const result = await pending;
		expect(result.results[0]?.score).toBeNull();
		expect(result.batches).toBe(1);
		expect(stub.calls).toHaveLength(3);
		for (const call of stub.calls) expect(call.init.signal.aborted).toBe(true);
		expect(manual.pendingCount()).toBe(0);
	});

	test("S16 a timeout on attempt 1 and success on attempt 2 leaves no armed timer and the first signal aborted", async () => {
		const stub = makeStub((callIndex) =>
			callIndex === 0
				? { status: 200, never: true }
				: { status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) },
		);
		const { deps, manual } = depsFor(stub);
		const pending = createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);

		manual.fire();
		await flushMicrotasks();
		const result = await pending;
		expect(result.results[0]?.score).toBe(2.5);
		expect(stub.calls).toHaveLength(2);
		expect(stub.calls[0]?.init.signal.aborted).toBe(true);
		expect(stub.calls[1]?.init.signal.aborted).toBe(false);
		expect(manual.pendingCount()).toBe(0);
	});

	test("C4 per-attempt timeout is min(env, deadline - now)", async () => {
		const rows: Array<{ env: string | undefined; deadline: number; expected: number }> = [
			{ env: "30000", deadline: FIXED_NOW + 4000, expected: 4000 },
			{ env: "3000", deadline: FIXED_NOW + 60_000, expected: 3000 },
			{ env: undefined, deadline: FIXED_NOW + 60_000, expected: 15000 },
			{ env: "1", deadline: FIXED_NOW + 60_000, expected: 1000 },
			{ env: "999999999", deadline: FIXED_NOW + 600_000, expected: 120_000 },
			{ env: "garbage", deadline: FIXED_NOW + 60_000, expected: 15000 },
		];
		for (const row of rows) {
			const stub = makeStub({ status: 200, never: true });
			const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "k" };
			if (row.env !== undefined) env["PI_BADGER_JEV_SCORE_TIMEOUT_MS"] = row.env;
			const { deps, manual } = depsFor(stub, { env });
			const outer = new AbortController();
			const pending = createJevScorer(deps)(PROMPT, [cand("a")], outer.signal, row.deadline);
			expect(manual.lastDelayMs()).toBe(row.expected);
			expect(manual.pendingCount()).toBe(1);
			outer.abort();
			await pending;
			expect(manual.pendingCount()).toBe(0);
		}
	});

	test("C4 a non-positive remaining deadline skips the batch with nulls and zero fetches", async () => {
		for (const deadline of [FIXED_NOW, FIXED_NOW - 5]) {
			const stub = makeStub({ status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) });
			const { deps, manual } = depsFor(stub);
			const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), deadline);
			expect(stub.calls).toHaveLength(0);
			expect(manual.pendingCount()).toBe(0);
			expect(result.results[0]?.score).toBeNull();
			expect(result.batches).toBe(0);
		}
	});
});

// ------------------------------------------------------------------ error + tolerance

describe("error and tolerance (S10, S11, S12, S15)", () => {
	test("S10 missing or blank key fails before any fetch and arms no timer", async () => {
		const rows: Array<Record<string, string | undefined>> = [{}, { OPENROUTER_API_KEY: "" }, { OPENROUTER_API_KEY: "   " }];
		for (const env of rows) {
			const stub = makeStub({ status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) });
			const { deps, manual } = depsFor(stub, { env });
			const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);
			expect(stub.calls).toHaveLength(0);
			expect(manual.pendingCount()).toBe(0);
			expect(result.results[0]?.score).toBeNull();
			expect(result.batches).toBe(0);
		}
	});

	test("S11 missing answers are null, never fabricated zeros", async () => {
		const stub = makeStub({ status: 200, text: SYNTH_SCORE_PARTIAL_ANSWERS_BODY });
		const { deps } = depsFor(stub);
		const result = await createJevScorer(deps)(PROMPT, [cand("a"), cand("b"), cand("c")], signal(), DEADLINE);
		expect(result.results[0]?.score).toBe(2.5);
		expect(result.results[1]?.score).toBeNull();
		expect(result.results[2]?.score).toBeNull();
		// The distinction is the point: a fabricated 0 would sort as Jev's verdict.
		expect(result.results[1]?.score).not.toBe(0);
	});

	test("S12 a 200 error envelope and a truncated body map to server/malformed, never throw", async () => {
		expect(await classifyScoreResponse(responseLike(200, SYNTH_SCORE_ERROR_ENVELOPE), ["c0"])).toMatchObject({
			status: "error",
			kind: "server",
		});
		expect(await classifyScoreResponse(responseLike(200, SYNTH_SCORE_TRUNCATED_JSON), ["c0"])).toMatchObject({
			status: "error",
			kind: "malformed",
		});

		for (const body of [SYNTH_SCORE_ERROR_ENVELOPE, SYNTH_SCORE_TRUNCATED_JSON]) {
			const stub = makeStub({ status: 200, text: body });
			const { deps, manual } = depsFor(stub);
			const result = await createJevScorer(deps)(PROMPT, [cand("a")], signal(), DEADLINE);
			expect(result.results[0]?.score).toBeNull();
			expect(stub.calls).toHaveLength(3); // both kinds are retryable
			expect(manual.pendingCount()).toBe(0);
		}
	});

	test("S15 a 400 detail never echoes the response body", async () => {
		const classified = await classifyScoreResponse(responseLike(400, SYNTH_SCORE_BAD_REQUEST_BODY), ["c0"]);
		expect(classified.status).toBe("error");
		if (classified.status === "error") {
			expect(classified.detail).not.toContain("SECRET-BODY-MARKER");
			expect(classified.detail).toContain("400");
		}
	});
});

// ------------------------------------------------------------------ pool, usage, clamp

describe("pool, usage, clamp (C4)", () => {
	test("C4 pool cap 48 by server rank before batching", async () => {
		const stub = answeringStub();
		const { deps } = depsFor(stub);
		// rank(h_i) = 50 - i, so the top 48 by rank are h2..h49.
		const candidates = Array.from({ length: 50 }, (_, i) => cand(`h${i}`, { ranking: 50 - i }));
		const result = await createJevScorer(deps)(PROMPT, candidates, signal(), DEADLINE);

		expect(stub.calls).toHaveLength(4); // 48 candidates / 12
		expect(result.results).toHaveLength(50);
		for (let i = 2; i < 50; i++) expect(result.results[i]?.score).toBe(1);
		expect(result.results[0]?.score).toBeNull();
		expect(result.results[1]?.score).toBeNull();
		const sentPaths = stub.calls.flatMap((call) => {
			const sent = JSON.parse(call.init.body) as {
				questions: Record<string, { instructions: { candidate: { path: string } } }>;
			};
			return Object.values(sent.questions).map((question) => question.instructions.candidate.path);
		});
		expect(sentPaths).toHaveLength(48);
		expect(sentPaths).not.toContain("docs/h0.md");
		expect(sentPaths).not.toContain("docs/h1.md");
	});

	test("C4 usage sums parsed batches and ignores non-finite fields", async () => {
		const stub = makeStub((callIndex) =>
			callIndex === 0
				? {
						status: 200,
						text: JSON.stringify({
							model: "m",
							answers: { c0: { type: "score", score: 1 } },
							usage: { input_tokens: 10, output_tokens: 5, cost: 0.001 },
						}),
					}
				: {
						status: 200,
						text: JSON.stringify({
							model: "m",
							answers: { c12: { type: "score", score: 1 } },
							usage: { input_tokens: "x", output_tokens: null, cost: Number.NaN },
						}),
					},
		);
		const { deps } = depsFor(stub);
		const result = await createJevScorer(deps)(
			PROMPT,
			Array.from({ length: 13 }, (_, i) => cand(`h${i}`)),
			signal(),
			DEADLINE,
		);
		expect(result.usage.input_tokens).toBe(10);
		expect(result.usage.output_tokens).toBe(5);
		expect(result.usage.cost).toBeCloseTo(0.001, 12);
	});

	test("C4 score clamp: finite clamped to [0,3], non-finite/wrong-type -> null", async () => {
		const stub = makeStub({ status: 200, text: SYNTH_SCORE_WRONG_SHAPES_BODY });
		const { deps } = depsFor(stub);
		const result = await createJevScorer(deps)(
			PROMPT,
			Array.from({ length: 7 }, (_, i) => cand(`h${i}`)),
			signal(),
			DEADLINE,
		);
		expect(result.results.map((entry) => entry.score)).toEqual([0, 3, null, null, null, null, 1.5]);
		expect(result.results[0]?.confidence).toBe(1);
		expect(result.results[1]?.confidence).toBe(0);
		expect(result.results[6]?.confidence).toBeUndefined();
	});
});

// ------------------------------------------------------------------ warm

describe("warm preload (C4)", () => {
	test("C4 warmJevScore issues exactly one warm call, 5 s cap, and discards it", async () => {
		const stub = makeStub({ status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) });
		const { deps, manual } = depsFor(stub);
		const returned = await warmJevScore(deps);
		expect(returned).toBeUndefined();
		expect(stub.calls).toHaveLength(1);
		const sent = JSON.parse(stub.calls[0]?.init.body ?? "{}") as {
			model: string;
			state: string;
			questions: Record<string, { instructions: { candidate: unknown } }>;
		};
		expect(sent.model).toBe(SCORE_MODEL_DEFAULT);
		expect(sent.state).toBe("warm");
		expect(Object.keys(sent.questions)).toEqual(["c0"]);
		expect(sent.questions["c0"]?.instructions.candidate).toEqual({ path: "warm", kind: "memory", excerpt: "" });
		expect(manual.lastDelayMs()).toBe(5000);
		expect(manual.pendingCount()).toBe(0);
	});

	test("C4 warmJevScore is fail-open: errors and missing keys resolve, never throw", async () => {
		const throwing = makeStub({ status: 0, throws: new Error("socket hang up") });
		expect(await warmJevScore(depsFor(throwing).deps)).toBeUndefined();
		expect(throwing.calls).toHaveLength(1);

		const failing = makeStub({ status: 500, text: SYNTH_SCORE_SERVER_ERROR_BODY });
		expect(await warmJevScore(depsFor(failing).deps)).toBeUndefined();
		expect(failing.calls).toHaveLength(1); // exactly one call: warm never retries

		const missingKey = makeStub({ status: 200, text: JSON.stringify(MEASURED_SCORE_ANSWER) });
		expect(await warmJevScore(depsFor(missingKey, { env: {} }).deps)).toBeUndefined();
		expect(missingKey.calls).toHaveLength(0);
	});
});
