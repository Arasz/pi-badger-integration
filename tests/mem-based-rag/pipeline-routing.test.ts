/**
 * PKG-5 integration rows (I1–I8): the mem-based-rag hook routes enrichment
 * through the query-pipeline.
 *
 * Self-contained fakes (the 1,100-line wiring file is not disturbed): a fake
 * raccoon client over `createClient`, injected `plan`/`score` through the new
 * `MemRagDeps.pipeline` seam, and a ctx that records `ui.setStatus`/`setWidget`.
 * No stdio, no network, no real timers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";
import factory from "../../extensions/mem-based-rag/index.ts";
import type { PipelineCandidate, PipelineScorerFn } from "../../extensions/query-pipeline/types.ts";

const ENV_KEYS = [
	"PI_BADGER_MEM_RAG",
	"PI_BADGER_MEM_RAG_MODE",
	"PI_BADGER_MEM_RAG_TIMEOUT_MS",
	"AI_BADGER_PROJECT_ID",
	"OPENROUTER_API_KEY",
	"PI_BADGER_QUERY_PIPELINE",
	"PI_BADGER_QUERY_PIPELINE_TOTAL_MS",
	"PI_BADGER_QUERY_PIPELINE_SEARCH_LIMIT",
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIG_ENV[key] = process.env[key];

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = ORIG_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const PROMPT = "/skill:task explain how delegation timeout interacts with slow CI runners tomorrow morning please";

interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
}

interface StatusCall {
	key: string;
	text: string | undefined;
}

interface TestCtx {
	cwd: string;
	sessionManager: { getSessionId: () => string };
	ui: {
		notify: (message: string, type: string) => void;
		setStatus: (key: string, text: string | undefined) => void;
		setWidget: (key: string, content: string[] | undefined) => void;
	};
}

function makeCtx(status: StatusCall[], widgets: StatusCall[]): TestCtx {
	return {
		cwd: "/tmp/pipeline-routing",
		sessionManager: { getSessionId: () => "sess-pipeline" },
		ui: {
			notify: () => {},
			setStatus: (key, text) => status.push({ key, text }),
			setWidget: (key, content) => widgets.push({ key, text: content?.[0] }),
		},
	};
}

function hit(hash: string, path: string, ranking: number): PipelineCandidate {
	return { hash, path, ranking, snippet: `snippet ${hash}` };
}

function envelope(mem: PipelineCandidate[], code: PipelineCandidate[] = []): string {
	return JSON.stringify({ data: { results: mem, code } });
}

type SearchHandler = (query: string, args: Record<string, unknown>, timeoutMs: number) => Promise<string>;

function makeClient(calls: ToolCall[], handler: SearchHandler) {
	return {
		call: async (tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> => {
			calls.push({ tool, args });
			return handler(String(args["query"] ?? ""), args, timeoutMs);
		},
		stop: () => {},
	};
}

const NULL_SCORES: PipelineScorerFn = async (_prompt, candidates) => ({
	results: candidates.map((c) => ({ hash: c.hash, score: null })),
	usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
	batches: 0,
});

interface InstallOptions {
	handler: SearchHandler;
	pipeline?: Record<string, unknown>;
}

function install(options: InstallOptions): { pi: FakePi; calls: ToolCall[] } {
	const pi = createFakePi();
	const calls: ToolCall[] = [];
	const client = makeClient(calls, options.handler);
	(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
		createClient: () => client,
		...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
	});
	return { pi, calls };
}

async function fireInput(pi: FakePi, text: string, ctx: unknown): Promise<void> {
	for (const handler of pi.handlers.get("input") ?? []) {
		await (handler as (e: unknown, c: unknown) => unknown)({ text, source: "user" }, ctx);
	}
}

async function fireBefore(pi: FakePi, prompt: string, ctx: unknown): Promise<any> {
	let last: unknown;
	for (const handler of pi.handlers.get("before_agent_start") ?? []) {
		last = await (handler as (e: unknown, c: unknown) => unknown)({ prompt }, ctx);
	}
	return last;
}

async function ragStatus(pi: FakePi, ctx: unknown): Promise<string> {
	const cmd = pi.commands.get("rag") as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
	const notes: string[] = [];
	const statusCtx = { ...(ctx as object), ui: { ...(ctx as TestCtx).ui, notify: (m: string) => notes.push(m) } };
	await cmd.handler("status", statusCtx as never);
	return notes.join("\n");
}

function setupEnv(): void {
	process.env["AI_BADGER_PROJECT_ID"] = "proj-pipeline";
	delete process.env["PI_BADGER_MEM_RAG"];
	delete process.env["PI_BADGER_MEM_RAG_MODE"];
	delete process.env["PI_BADGER_MEM_RAG_TIMEOUT_MS"];
	delete process.env["OPENROUTER_API_KEY"];
	delete process.env["PI_BADGER_QUERY_PIPELINE"];
}

describe("I1 pipeline routing", () => {
	test("an enrichable turn routes through the injected pipeline and injects the merged block", async () => {
		setupEnv();
		const planCalls: string[] = [];
		const { pi, calls } = install({
			handler: async (query) =>
				query === "q1" ? envelope([hit("h1", "docs/a.md", 1), hit("h2", "docs/b.md", 2)]) : envelope([hit("h3", "docs/c.md", 1)]),
			pipeline: {
				plan: async (query: string) => {
					planCalls.push(query);
					return { status: "ok", plan: { concepts: [{ name: "c", queries: ["q1", "q2"] }] } };
				},
				score: NULL_SCORES,
			},
		});
		const status: StatusCall[] = [];
		const widgets: StatusCall[] = [];
		const ctx = makeCtx(status, widgets);
		await fireInput(pi, PROMPT, ctx);
		const message = await fireBefore(pi, PROMPT, ctx);

		expect(planCalls).toEqual(["explain how delegation timeout interacts with slow CI runners tomorrow morning please"]);
		expect(calls.map((c) => c.tool)).toEqual(["memory_search", "memory_search"]);
		expect(message?.message?.content).toContain("docs/a.md");
		expect(message?.message?.content).toContain("docs/c.md");
		// Progress painted and cleared.
		expect(status.some((s) => s.key === "query-pipeline" && s.text?.includes("planning"))).toBe(true);
		expect(status.at(-1)).toEqual({ key: "query-pipeline", text: undefined });
	});
});

describe("I2 single-flight", () => {
	test("two overlapping turns serialize their searches through the single-flight chain", async () => {
		setupEnv();
		let active = 0;
		let maxActive = 0;
		const { pi } = install({
			handler: async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise<void>((resolve) => setImmediate(resolve));
				active -= 1;
				return envelope([hit("h1", "docs/a.md", 1)]);
			},
			pipeline: {
				plan: async () => ({ status: "ok", plan: { concepts: [{ name: "c", queries: ["q1", "q2"] }] } }),
				score: NULL_SCORES,
			},
		});
		const status: StatusCall[] = [];
		const ctxA = makeCtx(status, []);
		const ctxB = makeCtx(status, []);
		await fireInput(pi, PROMPT, ctxA);
		await fireInput(pi, PROMPT, ctxB);
		const [a, b] = await Promise.all([fireBefore(pi, PROMPT, ctxA), fireBefore(pi, PROMPT, ctxB)]);
		expect(maxActive).toBe(1);
		expect(a?.message?.content).toContain("docs/a.md");
		expect(b?.message?.content).toContain("docs/a.md");
	});
});

describe("I3 fallback", () => {
	test("pipeline fallback falls back to the single-query search and still injects", async () => {
		setupEnv();
		const { pi, calls } = install({
			handler: async () => envelope([hit("h-raw", "docs/raw.md", 1)]),
			pipeline: { plan: async () => ({ status: "fallback", reason: "no-model" }), score: NULL_SCORES },
		});
		const ctx = makeCtx([], []);
		await fireInput(pi, PROMPT, ctx);
		const message = await fireBefore(pi, PROMPT, ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args["query"]).toBe("explain how delegation timeout interacts with slow CI runners tomorrow morning please");
		expect(message?.message?.content).toContain("docs/raw.md");
	});
});

describe("I4 kill switch", () => {
	test("the kill switch disables routing; the single query runs and the pipeline is never called", async () => {
		setupEnv();
		process.env["PI_BADGER_QUERY_PIPELINE"] = "0";
		let planCalls = 0;
		const { pi, calls } = install({
			handler: async () => envelope([hit("h1", "docs/a.md", 1)]),
			pipeline: {
				plan: async () => {
					planCalls += 1;
					return { status: "fallback", reason: "no-model" };
				},
				score: NULL_SCORES,
			},
		});
		const ctx = makeCtx([], []);
		await fireInput(pi, PROMPT, ctx);
		const message = await fireBefore(pi, PROMPT, ctx);
		expect(planCalls).toBe(0);
		expect(calls).toHaveLength(1);
		expect(message?.message?.content).toContain("docs/a.md");
	});
});

describe("I5/I6 resilience", () => {
	test("a throwing planner never rejects the hook", async () => {
		setupEnv();
		const { pi } = install({
			handler: async () => envelope([hit("h1", "docs/a.md", 1)]),
			pipeline: {
				plan: () => {
					throw new Error("planner exploded");
				},
			},
		});
		const ctx = makeCtx([], []);
		await fireInput(pi, PROMPT, ctx);
		let threw = false;
		let message: unknown;
		try {
			message = await fireBefore(pi, PROMPT, ctx);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(message).toBeDefined();
	});

	test("zero merged candidates skip as no-hits without injecting", async () => {
		setupEnv();
		const { pi } = install({
			handler: async () => envelope([]),
			pipeline: {
				plan: async () => ({ status: "ok", plan: { concepts: [{ name: "c", queries: ["q1"] }] } }),
				score: NULL_SCORES,
			},
		});
		const ctx = makeCtx([], []);
		await fireInput(pi, PROMPT, ctx);
		const message = await fireBefore(pi, PROMPT, ctx);
		expect(message).toBeUndefined();
		const status = await ragStatus(pi, ctx);
		expect(status).toContain("no-hits");
	});
});

describe("I7 expanded mode", () => {
	test("expanded mode expands exactly the merged hashes", async () => {
		setupEnv();
		process.env["PI_BADGER_MEM_RAG_MODE"] = "expanded";
		const getHashes: string[] = [];
		const { pi } = install({
			handler: async (query, args) => {
				if (args["hash"] !== undefined) {
					getHashes.push(String(args["hash"]));
					return JSON.stringify({ data: { value: `full ${String(args["hash"])}`, path: "shared/x.md" } });
				}
				return query === "q1"
					? envelope([hit("h1", "docs/a.md", 1), hit("h2", "docs/b.md", 2)])
					: envelope([hit("h3", "docs/c.md", 1), hit("h4", "docs/d.md", 2)]);
			},
			pipeline: {
				plan: async () => ({ status: "ok", plan: { concepts: [{ name: "c", queries: ["q1", "q2"] }] } }),
				score: NULL_SCORES,
			},
		});
		const ctx = makeCtx([], []);
		await fireInput(pi, PROMPT, ctx);
		const message = await fireBefore(pi, PROMPT, ctx);
		expect(new Set(getHashes)).toEqual(new Set(["h1", "h2", "h3", "h4"]));
		expect(message?.message?.content).toContain("full h1");
	});
});

describe("I8 status", () => {
	test("status counters and lastReason reflect the pipeline run", async () => {
		setupEnv();
		const { pi } = install({
			handler: async () => envelope([hit("h1", "docs/a.md", 1)]),
			pipeline: {
				plan: async () => ({ status: "ok", plan: { concepts: [{ name: "c", queries: ["q1"] }] } }),
				score: NULL_SCORES,
			},
		});
		const ctx = makeCtx([], []);
		await fireInput(pi, PROMPT, ctx);
		await fireBefore(pi, PROMPT, ctx);
		const status = await ragStatus(pi, ctx);
		expect(status).toContain("enriched 1");
		expect(status).toContain("Pipeline: ok");
	});
});
