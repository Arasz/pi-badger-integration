/**
 * PKG-4 extension-wiring tests (E rows + the runner-defaults row).
 *
 * The extension owns exactly two hooks: session_start (gated, session-scoped,
 * fail-open Jev preload) and session_shutdown (reset + guarded status/widget
 * clear). All seams injected — no network, no real timers, no stdio.
 */
import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import factory, { type QueryPipelineExtensionDeps } from "../../extensions/query-pipeline/index.ts";
import { createQueryPipeline } from "../../extensions/query-pipeline/pipeline.ts";
import { QP_STATUS_KEY, QP_WIDGET_KEY, type PipelineScheduler } from "../../extensions/query-pipeline/types.ts";

function manualScheduler(): PipelineScheduler & { pendingCount: () => number } {
	let next = 1;
	const timers = new Map<number, () => void>();
	return {
		setTimeout(handler: () => void) {
			const id = next++;
			timers.set(id, handler);
			return id;
		},
		clearTimeout(handle: unknown) {
			timers.delete(handle as number);
		},
		pendingCount: () => timers.size,
	};
}

interface StatusCall {
	key: string;
	text: string | undefined;
}

function makeCtx(ui: { status: StatusCall[]; widgets: StatusCall[] }): unknown {
	return {
		ui: {
			setStatus: (key: string, text: string | undefined) => ui.status.push({ key, text }),
			setWidget: (key: string, content: string[] | undefined) => ui.widgets.push({ key, text: content?.[0] }),
		},
	};
}

async function fire(pi: ReturnType<typeof createFakePi>, name: string, ctx: unknown): Promise<void> {
	for (const handler of pi.handlers.get(name) ?? []) await handler({}, ctx);
}

function install(deps: QueryPipelineExtensionDeps) {
	const pi = createFakePi();
	factory(pi as never, deps);
	return pi;
}

describe("query-pipeline extension preload", () => {
	test("E1 session_start issues exactly one warm call per session", async () => {
		let warms = 0;
		const pi = install({ warm: async () => { warms += 1; }, env: { OPENROUTER_API_KEY: "k" } });
		const ctx = makeCtx({ status: [], widgets: [] });
		await fire(pi, "session_start", ctx);
		await fire(pi, "session_start", ctx);
		expect(warms).toBe(1);
	});

	test("E2 a shutdown resets the session scope; the next start warms again", async () => {
		let warms = 0;
		const pi = install({ warm: async () => { warms += 1; }, env: { OPENROUTER_API_KEY: "k" } });
		const ctx = makeCtx({ status: [], widgets: [] });
		await fire(pi, "session_start", ctx);
		await fire(pi, "session_shutdown", ctx);
		await fire(pi, "session_start", ctx);
		expect(warms).toBe(2);
	});

	test("E3 a failing warm call is fail-open", async () => {
		const pi = install({ warm: async () => { throw new Error("network"); }, env: { OPENROUTER_API_KEY: "k" } });
		const ctx = makeCtx({ status: [], widgets: [] });
		await fire(pi, "session_start", ctx);
		await fire(pi, "session_start", ctx); // second start is still swallowed by the session scope
		expect(true).toBe(true);
	});

	test("E4 the kill switch suppresses the warm call and is read per call", async () => {
		let warms = 0;
		const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "k", PI_BADGER_QUERY_PIPELINE: "0" };
		const pi = install({ warm: async () => { warms += 1; }, env });
		const ctx = makeCtx({ status: [], widgets: [] });
		await fire(pi, "session_start", ctx);
		expect(warms).toBe(0);
		delete env.PI_BADGER_QUERY_PIPELINE;
		await fire(pi, "session_start", ctx);
		expect(warms).toBe(1);
	});

	test("E5 a missing key suppresses the warm call", async () => {
		let warms = 0;
		const pi = install({ warm: async () => { warms += 1; }, env: {} });
		await fire(pi, "session_start", makeCtx({ status: [], widgets: [] }));
		expect(warms).toBe(0);
	});

	test("E8 env is read per call, not cached at factory load", async () => {
		let warms = 0;
		const env: Record<string, string | undefined> = {};
		const pi = install({ warm: async () => { warms += 1; }, env });
		const ctx = makeCtx({ status: [], widgets: [] });
		await fire(pi, "session_start", ctx);
		env.OPENROUTER_API_KEY = "late-key";
		await fire(pi, "session_start", ctx);
		expect(warms).toBe(1);
	});

	test("E6 session_shutdown clears the pinned status and widget keys", async () => {
		const ui = { status: [] as StatusCall[], widgets: [] as StatusCall[] };
		const pi = install({ warm: async () => {}, env: { OPENROUTER_API_KEY: "k" } });
		await fire(pi, "session_shutdown", makeCtx(ui));
		expect(ui.status).toContainEqual({ key: QP_STATUS_KEY, text: undefined });
		expect(ui.widgets).toContainEqual({ key: QP_WIDGET_KEY, text: undefined });
	});

	test("a throwing ui surface never breaks session_shutdown", async () => {
		const pi = install({ warm: async () => {}, env: { OPENROUTER_API_KEY: "k" } });
		const ctx = {
			ui: {
				setStatus: () => { throw new Error("stale ctx"); },
				setWidget: () => { throw new Error("stale ctx"); },
			},
		};
		await fire(pi, "session_shutdown", ctx);
		expect(true).toBe(true);
	});
});

describe("runner defaults", () => {
	test("createQueryPipeline with no plan/score overrides still plans through the registry", async () => {
		const scheduler = manualScheduler();
		const registry = {
			find: (provider: string, id: string) => ({ provider, id }),
			complete: async () => ({
				content: [{ type: "text", text: '{"concepts":[{"name":"c","queries":["q1"]},{"name":"d","queries":["q2"]}]}' }],
			}),
		};
		const search = async (): Promise<string> =>
			JSON.stringify({ data: { results: [{ hash: "h1", path: "docs/a.md", ranking: 1, snippet: "s" }], code: [] } });
		const pipeline = createQueryPipeline({
			search,
			registry,
			env: { PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL: "acme/model-x" }, // no OPENROUTER key → scorer nulls, no fetch
			scheduler,
			now: () => 0,
		});
		const result = await pipeline.retrieveResult({ query: "q" });
		expect(result.status).toBe("pipeline");
		expect(result.queries).toEqual(["q1", "q2"]);
		expect(result.mem.map((h) => h.hash)).toEqual(["h1"]);
	});
});
