/**
 * PKG-3 planner-adapter rows (plan-tests "C4 — Missing rows") plus the
 * compile-level `PipelinePlannerFn` assertion.
 *
 * Unit tests only: a structural fake ModelRegistry, no clock, no network, no
 * env beyond the injected record, no randomness. The fake registry mirrors the
 * pi 0.84.4 `ModelRegistry` seam — `find(provider, modelId)` and
 * `complete(model, context, options)` — verified against
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`.
 * That type has no `streamSimple`; the adapter must not use one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistryPlanner } from "../../extensions/query-pipeline/planner-call.ts";
import { DELEGATOR_PERSONA, PLANNER_ADDENDUM, buildPlannerUserPrompt } from "../../extensions/query-pipeline/planner.ts";
import type { PlannerFallbackReason, PlannerResult, PipelinePlannerFn } from "../../extensions/query-pipeline/types.ts";

const query = "explain the delegation timeout watchdog and how retries interact with the queue";
// The frozen PipelinePlannerFn takes the stage timeout; the adapter forwards the signal
// only (the runner owns the deadline race), but the argument is required.
const timeoutMs = 15000;
const modelA = { provider: "test", id: "model-a" };

// Compile-level assertion (plan-review F3): createRegistryPlanner must return
// the frozen PipelinePlannerFn type. A signature drift fails typecheck here.
const _plan: PipelinePlannerFn = createRegistryPlanner({ registry: {}, model: {}, env: {} });
void _plan;

const validPlanText = (): string =>
	JSON.stringify({
		concepts: [
			{ name: "watchdog", queries: ["delegation timeout watchdog retry queue interaction"] },
			{ name: "retries", queries: ["delegation retry attempt cap scheduler backoff"] },
		],
	});

interface CompleteCall {
	model: unknown;
	context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown }> };
	options: { signal?: AbortSignal };
}

/** A registry whose `complete` records its arguments and resolves `text`. */
const okRegistry = (text: string = validPlanText()): { registry: Record<string, unknown>; calls: CompleteCall[] } => {
	const calls: CompleteCall[] = [];
	const registry = {
		find: (provider: string, modelId: string) => ({ provider, id: modelId }),
		complete: async (model: unknown, context: CompleteCall["context"], options: CompleteCall["options"]) => {
			calls.push({ model, context, options });
			return { role: "assistant", content: [{ type: "text", text }] };
		},
	};
	return { registry, calls };
};

const fakeRegistry = (
	complete: unknown,
	find: (provider: string, modelId: string) => unknown = () => modelA,
): Record<string, unknown> => ({ find, complete });

const okMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** Rejects on the next microtask so a synchronous return cannot pass by accident. */
const rejecting = (error: unknown) => async () => {
	await Promise.resolve();
	throw error;
};

const callFail = async (
	adapter: PipelinePlannerFn,
	signal: AbortSignal | undefined = new AbortController().signal,
): Promise<{ status: "fallback"; reason: PlannerFallbackReason }> => {
	const result = await adapter(query, signal, timeoutMs);
	expect(result.status).toBe("fallback");
	if (result.status !== "fallback") throw new Error(`expected fallback, got ${JSON.stringify(result)}`);
	return result;
};

describe("createRegistryPlanner — registry.complete call shape", () => {
	test("C4 row: complete receives the exact {systemPrompt, messages, signal} shape", async () => {
		const { registry, calls } = okRegistry();
		const controller = new AbortController();
		const adapter = createRegistryPlanner({ registry, model: modelA, env: {} });

		const result = await adapter(query, controller.signal, timeoutMs);

		expect(result.status).toBe("ok");
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("registry.complete was never called");

		// The resolved model is the injected ctx.model (env unset) and is passed through.
		expect(call.model).toBe(modelA);
		// Exactly one option key: the forwarded signal, no timeoutMs/stream knobs.
		expect(Object.keys(call.options)).toEqual(["signal"]);
		expect(call.options.signal).toBe(controller.signal);

		// System prompt = persona + blank line + addendum (plan §3).
		expect(call.context.systemPrompt).toBe(`${DELEGATOR_PERSONA}\n\n${PLANNER_ADDENDUM}`);
		expect(call.context.systemPrompt?.startsWith(DELEGATOR_PERSONA)).toBe(true);
		expect(call.context.systemPrompt).toContain(PLANNER_ADDENDUM);

		// One user message with the measured harness prompt carrying the raw query.
		expect(call.context.messages).toEqual([{ role: "user", content: buildPlannerUserPrompt(query) }]);
	});

	test("C4 row: a non-aborted signal is forwarded and complete is called", async () => {
		const { registry, calls } = okRegistry();
		const controller = new AbortController();
		const adapter = createRegistryPlanner({ registry, model: modelA, env: {} });

		const result = await adapter(query, controller.signal, timeoutMs);

		expect(result.status).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.signal).toBe(controller.signal);
	});

	test("the returned plan is the last complete JSON object (parsePlan, not a re-implementation)", async () => {
		const earlier = validPlanText();
		const later = JSON.stringify({
			concepts: [
				{ name: "later-first", queries: ["later-q1"] },
				{ name: "later-second", queries: ["later-q2"] },
			],
		});
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(async () => okMessage(`${earlier}\n${later}`)),
			model: modelA,
			env: {},
		});

		const result = await adapter(query, new AbortController().signal, timeoutMs);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.plan.concepts[0]?.name).toBe("later-first");
	});

	test("C4 row: only text parts are joined; thinking parts are ignored", async () => {
		// The thinking part carries a valid-looking later plan on a `text` key:
		// joining non-text parts (or any `.text`) would let it win.
		const thinkingPlan = JSON.stringify({
			concepts: [
				{ name: "thinking-first", queries: ["thinking-q1"] },
				{ name: "thinking-second", queries: ["thinking-q2"] },
			],
		});
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(async () => ({
				role: "assistant",
				content: [
					{ type: "text", text: validPlanText() },
					{ type: "thinking", thinking: "scratchpad", text: thinkingPlan },
					{ type: "toolCall", name: "memory_search", arguments: {} },
				],
			})),
			model: modelA,
			env: {},
		});

		const result = await adapter(query, new AbortController().signal, timeoutMs);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.plan.concepts[0]?.name).toBe("watchdog");
	});
});

describe("createRegistryPlanner — typed fallbacks", () => {
	test("C4 row: empty text → empty-text fallback", async () => {
		for (const content of [[], [{ type: "text", text: "   " }]]) {
			const adapter = createRegistryPlanner({
				registry: fakeRegistry(async () => ({ role: "assistant", content })),
				model: modelA,
				env: {},
			});
			const result = await callFail(adapter);
			expect(result.reason).toBe<PlannerFallbackReason>("empty-text");
		}
	});

	test("C4 row: a complete-but-invalid plan → invalid-shape fallback", async () => {
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(async () => okMessage('{"concepts":[]}')),
			model: modelA,
			env: {},
		});
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("invalid-shape");
	});

	test("C4 row: a rejected complete promise → transport fallback", async () => {
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(rejecting(new Error("401 unauthorized"))),
			model: modelA,
			env: {},
		});
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("transport");
	});

	test("C4 row: a synchronous auth throw inside complete → transport fallback", async () => {
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(() => {
				throw new Error("no credentials for provider");
			}),
			model: modelA,
			env: {},
		});
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("transport");
	});

	test("C4 row: an error result (stopReason error) → transport fallback", async () => {
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(async () => ({
				role: "assistant",
				stopReason: "error",
				errorMessage: "auth failed",
				content: [],
			})),
			model: modelA,
			env: {},
		});
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("transport");
	});

	test("C4 row: absent complete → no-model fallback", async () => {
		const adapter = createRegistryPlanner({ registry: { find: () => modelA }, model: modelA, env: {} });
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("no-model");
	});

	test("C4 row: absent find → no-model fallback (a configured ref never reaches find)", async () => {
		// The env ref forces the find path, so removing the find guard throws into
		// the catch and reddens this row as transport.
		const adapter = createRegistryPlanner({
			registry: {},
			model: modelA,
			env: { PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL: "acme/model-x" },
		});
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("no-model");
	});

	test("C4 row: abort before resolution → timeout fallback", async () => {
		const controller = new AbortController();
		controller.abort();
		const adapter = createRegistryPlanner({
			registry: fakeRegistry(rejecting(new Error("Request aborted"))),
			model: modelA,
			env: {},
		});
		const result = await callFail(adapter, controller.signal);
		expect(result.reason).toBe<PlannerFallbackReason>("timeout");
	});
});

describe("createRegistryPlanner — model resolution", () => {
	test("C4 row: the env model ref splits on the first / (provider/model)", async () => {
		const { registry, calls } = okRegistry();
		const adapter = createRegistryPlanner({
			registry,
			model: modelA,
			env: { PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL: "acme/group/model-x" },
		});

		await adapter(query, new AbortController().signal, timeoutMs);

		expect(calls[0]?.model).toEqual({ provider: "acme", id: "group/model-x" });
	});

	test("C4 row: a model ref with no slash → no-model and find is never called", async () => {
		const findCalls: string[][] = [];
		const adapter = createRegistryPlanner({
			registry: {
				find: (provider: string, modelId: string) => {
					findCalls.push([provider, modelId]);
					return modelA;
				},
				complete: async () => okMessage(validPlanText()),
			},
			model: modelA,
			env: { PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL: "noslashmodel" },
		});

		const result = await callFail(adapter);

		expect(result.reason).toBe<PlannerFallbackReason>("no-model");
		expect(findCalls).toHaveLength(0);
	});

	test("C4 row: env unset → the injected ctx.model is used", async () => {
		const { registry, calls } = okRegistry();
		const injected = { provider: "injected", id: "injected-model" };
		const adapter = createRegistryPlanner({ registry, model: injected, env: {} });

		await adapter(query, new AbortController().signal, timeoutMs);

		expect(calls[0]?.model).toBe(injected);
	});

	test("C4 row: a configured ref resolving to no model → no-model fallback", async () => {
		const adapter = createRegistryPlanner({
			registry: { find: () => undefined },
			model: modelA,
			env: { PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL: "acme/missing" },
		});
		const result = await callFail(adapter);
		expect(result.reason).toBe<PlannerFallbackReason>("no-model");
	});
});

describe("createRegistryPlanner — never throws and structural narrowing", () => {
	test("C4 row: never throws across the whole fallback table", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const table: Array<{
			name: string;
			registry: unknown;
			model?: unknown;
			env?: Record<string, string | undefined>;
			signal?: AbortSignal;
		}> = [
			{ name: "registry undefined", registry: undefined },
			{ name: "registry null", registry: null },
			{ name: "registry empty object", registry: {} },
			{ name: "find not a function", registry: { find: 42, complete: async () => okMessage(validPlanText()) } },
			{
				name: "find throws",
				registry: {
					find: () => {
						throw new Error("auth exploded");
					},
				},
			},
			{ name: "find returns undefined", registry: { find: () => undefined } },
			{ name: "complete absent", registry: { find: () => modelA } },
			{ name: "complete not a function", registry: { find: () => modelA, complete: 42 } },
			{
				name: "complete sync throws",
				registry: {
					find: () => modelA,
					complete: () => {
						throw new Error("sync auth");
					},
				},
			},
			{ name: "complete rejects", registry: { find: () => modelA, complete: rejecting(new Error("rejected")) } },
			{ name: "complete resolves null", registry: { find: () => modelA, complete: async () => null } },
			{ name: "message without content", registry: { find: () => modelA, complete: async () => ({ role: "assistant" }) } },
			{
				name: "content undefined",
				registry: { find: () => modelA, complete: async () => ({ role: "assistant", content: undefined }) },
			},
			{
				name: "content wrong type",
				registry: { find: () => modelA, complete: async () => ({ role: "assistant", content: "not-an-array" }) },
			},
			{
				name: "content parts null",
				registry: {
					find: () => modelA,
					complete: async () => ({ role: "assistant", content: [null, { type: "text", text: null }] }),
				},
			},
			{ name: "model undefined", registry: { find: () => undefined }, model: undefined },
			{ name: "aborted signal", registry: { find: () => modelA }, signal: aborted.signal },
		];

		for (const entry of table) {
			let result: PlannerResult;
			try {
				const adapter = createRegistryPlanner({
					registry: entry.registry,
					model: entry.model,
					env: entry.env ?? {},
				});
				result = await adapter(query, entry.signal ?? new AbortController().signal, timeoutMs);
			} catch (error) {
				throw new Error(`adapter threw for ${entry.name}: ${String(error)}`);
			}
			expect(["ok", "fallback"]).toContain(result.status);
			if (result.status === "fallback") {
				expect(["no-model", "timeout", "transport", "empty-text", "no-json-object", "invalid-shape"]).toContain(
					result.reason,
				);
			}
		}
	});

	test("C4 row: planner-call.ts imports no @earendil-works/pi-ai (structural narrowing only)", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "..", "extensions", "query-pipeline", "planner-call.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/from\s+["']@earendil-works\/pi-ai["']/);
		expect(source).not.toMatch(/import\(\s*["']@earendil-works\/pi-ai["']\s*\)/);
		expect(source).not.toMatch(/require\(\s*["']@earendil-works\/pi-ai["']\s*\)/);
	});
});
