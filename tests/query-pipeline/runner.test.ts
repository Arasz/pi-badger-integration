/**
 * PKG-4 runner tests (R rows + plan-review C4 rows).
 *
 * All seams injected: manual scheduler + injected now (no real timers), fake
 * search/plan/score (no network, no stdio), progress spy. The runner's contract
 * is "never rejects" — every failure row asserts a typed result, not a throw.
 */
import { describe, expect, test } from "bun:test";
import {
	createQueryPipeline,
	formatProgress,
	resolvePipelineBudget,
	runPipeline,
	toEnvelope,
} from "../../extensions/query-pipeline/pipeline.ts";
import type {
	PipelineCandidate,
	PipelinePlannerFn,
	PipelineResult,
	PipelineScorerFn,
	PipelineScheduler,
} from "../../extensions/query-pipeline/types.ts";

// ------------------------------------------------------------------ manual scheduler

interface ManualScheduler {
	scheduler: PipelineScheduler;
	fireFirst(): void;
	fireNth(n: number): void;
	pendingCount(): number;
	delays(): number[];
}

function manualScheduler(): ManualScheduler {
	let next = 1;
	const timers = new Map<number, { handler: () => void; ms: number }>();
	const scheduler: PipelineScheduler = {
		setTimeout(handler: () => void, ms: number) {
			const id = next++;
			timers.set(id, { handler, ms });
			return id;
		},
		clearTimeout(handle: unknown) {
			timers.delete(handle as number);
		},
	};
	const ordered = (): Array<[number, { handler: () => void; ms: number }]> => [...timers.entries()];
	return {
		scheduler,
		fireFirst() {
			const entry = ordered()[0];
			if (entry) {
				timers.delete(entry[0]);
				entry[1].handler();
			}
		},
		fireNth(n: number) {
			const entry = ordered()[n - 1];
			if (entry) {
				timers.delete(entry[0]);
				entry[1].handler();
			}
		},
		pendingCount: () => timers.size,
		delays: () => ordered().map(([, t]) => t.ms),
	};
}

// ------------------------------------------------------------------ fakes

function hit(hash: string, path: string, ranking: number, kind: "memory" | "code" = "memory"): PipelineCandidate {
	return { hash, path, ranking, snippet: `snippet ${hash}`, kind };
}

function envelope(mem: PipelineCandidate[], code: PipelineCandidate[] = []): string {
	return JSON.stringify({ data: { results: mem, code } });
}

const OK_PLAN: PipelinePlannerFn = async () => ({
	status: "ok",
	plan: { concepts: [{ name: "c1", queries: ["q1", "q2"] }] },
});

const FALLBACK_PLAN: PipelinePlannerFn = async () => ({ status: "fallback", reason: "no-model" });

const NULL_SCORES: PipelineScorerFn = async (_prompt, candidates) => ({
	results: candidates.map((c) => ({ hash: c.hash, score: null })),
	usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
	batches: 0,
});

const BASE_ENV = { OPENROUTER_API_KEY: "test-key" };

// ------------------------------------------------------------------ R1/R2 stage order + sequencing

describe("runPipeline stage order and sequencing", () => {
	test("R1 stage order is plan, search-per-query, score, merge", async () => {
		const calls: string[] = [];
		const plan: PipelinePlannerFn = async () => {
			calls.push("plan");
			return { status: "ok", plan: { concepts: [{ name: "c", queries: ["q1", "q2"] }] } };
		};
		const search = async (query: string): Promise<string> => {
			calls.push(`search:${query}`);
			return envelope([hit(query, `docs/${query}.md`, 1)]);
		};
		const score: PipelineScorerFn = async (_p, candidates) => {
			calls.push("score");
			return { results: candidates.map((c) => ({ hash: c.hash, score: 1.5 })), usage: { input_tokens: 0, output_tokens: 0, cost: 0 }, batches: 1 };
		};
		const result = await runPipeline({ search, plan, score, env: BASE_ENV }, { query: "raw query" });
		expect(result.status).toBe("pipeline");
		expect(calls).toEqual(["plan", "search:q1", "search:q2", "score"]);
	});

	test("R2 searches run once per planned query, sequentially, never for the input query", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const seen: string[] = [];
		const search = async (query: string): Promise<string> => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			seen.push(query);
			await new Promise((resolve) => setTimeout(resolve, 1));
			concurrent -= 1;
			return envelope([hit(query, `docs/${query}.md`, 1)]);
		};
		await runPipeline({ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV }, { query: "the raw query" });
		expect(seen).toEqual(["q1", "q2"]);
		expect(maxConcurrent).toBe(1);
	});

	test("R10 the planner receives the caller query verbatim", async () => {
		let seen = "";
		const plan: PipelinePlannerFn = async (query) => {
			seen = query;
			return { status: "fallback", reason: "no-model" };
		};
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		await runPipeline({ search, plan, score: NULL_SCORES, env: BASE_ENV }, { query: "decision query text" });
		expect(seen).toBe("decision query text");
	});

	test("R12 the fallback reason names the failing stage", async () => {
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		const plannerThrows: PipelinePlannerFn = async () => {
			throw new Error("planner exploded");
		};
		const r1 = await runPipeline({ search, plan: plannerThrows, score: NULL_SCORES, env: BASE_ENV }, { query: "q" });
		expect(r1.reason).toBe("transport");

		const searchThrows = async (): Promise<string> => {
			throw new Error("bank exploded");
		};
		const r2 = await runPipeline({ search: searchThrows, plan: FALLBACK_PLAN, score: NULL_SCORES, env: BASE_ENV }, { query: "q" });
		expect(r2.reason).toBe("search-error");
		expect(r2.error).toContain("bank exploded");
	});
});

// ------------------------------------------------------------------ R5/R6 progress

describe("progress", () => {
	test("R5 progress fires for each stage in order", async () => {
		const events: string[] = [];
		const search = async (query: string): Promise<string> => envelope([hit(query, `docs/${query}.md`, 1)]);
		const score: PipelineScorerFn = async (_p, candidates) => ({
			results: candidates.map((c) => ({ hash: c.hash, score: 2 })),
			usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
			batches: 1,
		});
		await runPipeline(
			{ search, plan: OK_PLAN, score, env: BASE_ENV, onProgress: (p) => events.push(p.stage) },
			{ query: "q" },
		);
		expect(events).toEqual(["planning", "searching", "searching", "scoring", "merging"]);
	});

	test("R6 a throwing progress callback never breaks the run", async () => {
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		const result = await runPipeline(
			{ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV, onProgress: () => { throw new Error("ui boom"); } },
			{ query: "q" },
		);
		expect(result.status).toBe("pipeline");
	});

	test("formatProgress pins the four stage strings", () => {
		expect(formatProgress({ stage: "planning" })).toBe("query-pipeline: planning queries…");
		expect(formatProgress({ stage: "searching", index: 2, total: 5, query: "find the thing" })).toBe(
			'query-pipeline: searching 2/5 — "find the thing"',
		);
		expect(formatProgress({ stage: "scoring", candidates: 24, batches: 2 })).toBe(
			"query-pipeline: scoring 24 candidates (2 batches)…",
		);
		expect(formatProgress({ stage: "merging", pool: 24 })).toBe("query-pipeline: merging 24 candidates…");
	});
});

// ------------------------------------------------------------------ R3/R4/R9/R11 budget

describe("budget", () => {
	test("resolvePipelineBudget clamps every env var and stays enabled on the kill-switch value", () => {
		const b = resolvePipelineBudget({
			PI_BADGER_QUERY_PIPELINE: "0",
			PI_BADGER_QUERY_PIPELINE_TOTAL_MS: "1",
			PI_BADGER_QUERY_PIPELINE_PLANNER_MS: "999999",
			PI_BADGER_QUERY_PIPELINE_SEARCH_MS: "abc",
			PI_BADGER_QUERY_PIPELINE_SCORE_MS: "-5",
			PI_BADGER_QUERY_PIPELINE_SEARCH_LIMIT: "0",
		});
		expect(b.totalMs).toBe(5000);
		expect(b.plannerMs).toBe(60000);
		expect(b.searchMs).toBe(15000);
		expect(b.scoreMs).toBe(1000);
		expect(b.searchLimit).toBe(1);
		const d = resolvePipelineBudget({});
		expect(d).toEqual({ totalMs: 90000, plannerMs: 15000, searchMs: 15000, scoreMs: 8000, searchLimit: 5 });
	});

	test("R11 the whole-run deadline is armed on the injected scheduler, not a real timer", async () => {
		const manual = manualScheduler();
		const search = async (): Promise<string> => new Promise<string>(() => {});
		const run = runPipeline(
			{ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV, scheduler: manual.scheduler, now: () => 0 },
			{ query: "q" },
		);
		expect(manual.pendingCount()).toBeGreaterThan(0);
		manual.fireFirst(); // the whole-run deadline is the first timer armed
		const result = await run;
		expect(result.reason).toBe("budget-exhausted");
	});

	test("R9 per-search timeout is bounded by the remaining budget, not the full budget", async () => {
		const manual = manualScheduler();
		let clock = 0;
		const search = async (): Promise<string> => new Promise<string>(() => {});
		const run = runPipeline(
			{
				search,
				plan: async () => {
					clock += 30000; // a slow planner eats most of the total budget
					return { status: "ok", plan: { concepts: [{ name: "c", queries: ["q1"] }] } };
				},
				score: NULL_SCORES,
				env: {
					...BASE_ENV,
					PI_BADGER_QUERY_PIPELINE_TOTAL_MS: "40000",
					PI_BADGER_QUERY_PIPELINE_PLANNER_MS: "35000",
					PI_BADGER_QUERY_PIPELINE_SEARCH_MS: "10000",
					PI_BADGER_QUERY_PIPELINE_SCORE_MS: "5000",
				},
				scheduler: manual.scheduler,
				now: () => clock,
			},
			{ query: "q" },
		);
		// Flush the planner microtasks so the search race timer is armed, then inspect.
		await new Promise((resolve) => setImmediate(resolve));
		const delays = manual.delays();
		expect(delays).toContain(40000); // the whole-run deadline
		expect(delays).toContain(5000); // remaining(10000) - scoreMs(5000), not searchMs(10000)
		expect(delays).not.toContain(10000);
		manual.fireFirst(); // the run deadline
		const result = await run;
		expect(result.reason).toBe("budget-exhausted");
	});

	test("R4 a planner timeout falls back without searching the planned queries", async () => {
		const manual = manualScheduler();
		const searched: string[] = [];
		const search = async (query: string): Promise<string> => {
			searched.push(query);
			return envelope([hit("h1", "docs/a.md", 1)]);
		};
		const never: PipelinePlannerFn = async () => new Promise(() => {});
		const run = runPipeline(
			{
				search,
				plan: never,
				score: NULL_SCORES,
				env: { ...BASE_ENV, PI_BADGER_QUERY_PIPELINE_PLANNER_MS: "2000", PI_BADGER_QUERY_PIPELINE_TOTAL_MS: "60000" },
				scheduler: manual.scheduler,
				now: () => 0,
			},
			{ query: "raw" },
		);
		// The budget timer arms first; runStages (and its planner timer) start on a microtask.
		await new Promise((resolve) => setImmediate(resolve));
		manual.fireNth(2); // outer deadline, planner race → planner timeout
		const result = await run;
		expect(result.status).toBe("fallback");
		expect(result.reason).toBe("timeout");
		expect(searched).toEqual(["raw"]); // only the fallback search on the caller query
	});

	test("one failed query does not cancel the remaining queries", async () => {
		const searched: string[] = [];
		const search = async (query: string): Promise<string> => {
			searched.push(query);
			if (query === "q1") throw new Error("boom");
			return envelope([hit(query, `docs/${query}.md`, 1)]);
		};
		const result = await runPipeline({ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV }, { query: "raw" });
		expect(searched).toEqual(["q1", "q2"]);
		expect(result.status).toBe("pipeline");
	});

	test("all searches failing performs at most one fallback search and never throws", async () => {
		const searched: string[] = [];
		const search = async (query: string): Promise<string> => {
			searched.push(query);
			throw new Error("bank down");
		};
		const result = await runPipeline({ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV }, { query: "raw" });
		expect(searched).toEqual(["q1", "q2", "raw"]);
		expect(result.reason).toBe("search-error");
	});

	test("an external aborted signal is honored without a throw", async () => {
		const controller = new AbortController();
		controller.abort();
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		const result = await runPipeline(
			{ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV, signal: controller.signal },
			{ query: "q" },
		);
		expect(result.status).toBe("fallback");
	});
});

// ------------------------------------------------------------------ R7/R8 failure table + envelope

describe("failure semantics", () => {
	test("R7 planner/search/score throws each resolve a typed result", async () => {
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		const scoreThrows: PipelineScorerFn = async () => {
			throw new Error("jev down");
		};
		const result = await runPipeline({ search, plan: OK_PLAN, score: scoreThrows, env: BASE_ENV }, { query: "q" });
		expect(result.status).toBe("pipeline");
		expect(result.scored).toBe(0);
		expect(result.mem.length).toBeGreaterThan(0);
	});

	test("R8 zero candidates skip scoring and take the single-query fallback", async () => {
		let scoreCalls = 0;
		const search = async (query: string): Promise<string> =>
			query === "raw" ? envelope([hit("h-raw", "docs/raw.md", 1)]) : envelope([]);
		const score: PipelineScorerFn = async (_p, candidates) => {
			scoreCalls += 1;
			return { results: candidates.map((c) => ({ hash: c.hash, score: 1 })), usage: { input_tokens: 0, output_tokens: 0, cost: 0 }, batches: 1 };
		};
		const result = await runPipeline({ search, plan: OK_PLAN, score, env: BASE_ENV }, { query: "raw" });
		expect(scoreCalls).toBe(0);
		expect(result.status).toBe("fallback");
		expect(result.reason).toBe("no-candidates");
		expect(result.mem.map((h) => h.hash)).toEqual(["h-raw"]);
	});

	test("C4 toEnvelope is the bank envelope on every path", async () => {
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		const pipeline = createQueryPipeline({ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV });
		const happy = JSON.parse(await pipeline.retrieve({ query: "q" })) as { data: { results: unknown[]; code: unknown[] } };
		expect(Array.isArray(happy.data.results)).toBe(true);
		expect(Array.isArray(happy.data.code)).toBe(true);

		const failing = createQueryPipeline({
			search: async () => { throw new Error("down"); },
			plan: OK_PLAN,
			score: NULL_SCORES,
			env: BASE_ENV,
		});
		const empty = JSON.parse(await failing.retrieve({ query: "q" })) as { data: { results: unknown[]; code: unknown[] } };
		expect(empty).toEqual({ data: { results: [], code: [] } });
	});

	test("C4 retrieve equals toEnvelope(retrieveResult)", async () => {
		const search = async (): Promise<string> => envelope([hit("h1", "docs/a.md", 1)]);
		const pipeline = createQueryPipeline({ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV });
		const typed: PipelineResult = await pipeline.retrieveResult({ query: "q" });
		const envelopeText = await pipeline.retrieve({ query: "q" });
		expect(JSON.parse(envelopeText)).toEqual(JSON.parse(toEnvelope(typed)));
	});

	test("C4 the search limit is pinned to 5 by default and configurable", async () => {
		const limits: number[] = [];
		const search = async (_q: string, limit: number): Promise<string> => {
			limits.push(limit);
			return envelope([hit("h1", "docs/a.md", 1)]);
		};
		await runPipeline({ search, plan: OK_PLAN, score: NULL_SCORES, env: BASE_ENV }, { query: "raw" });
		expect(limits).toEqual([5, 5]);
		await runPipeline(
			{ search, plan: OK_PLAN, score: NULL_SCORES, env: { ...BASE_ENV, PI_BADGER_QUERY_PIPELINE_SEARCH_LIMIT: "10" } },
			{ query: "raw" },
		);
		expect(limits.slice(2)).toEqual([10, 10]);
	});

	test("C4 counters come from the injected clock", async () => {
		const manual = manualScheduler();
		let clock = 0;
		const search = async (): Promise<string> => {
			clock += 25;
			return envelope([hit("h1", "docs/a.md", 1)]);
		};
		const result = await runPipeline(
			{
				search,
				plan: async () => {
					clock += 10;
					return { status: "ok", plan: { concepts: [{ name: "c", queries: ["q1"] }] } };
				},
				score: NULL_SCORES,
				env: BASE_ENV,
				scheduler: manual.scheduler,
				now: () => clock,
			},
			{ query: "q" },
		);
		expect(result.plannerMs).toBe(10);
		expect(result.searchMs).toBe(25);
		expect(result.latencyMs).toBe(35);
	});
});
