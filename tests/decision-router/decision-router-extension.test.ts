/**
 * Wiring tests for the decision-router extension (plan v2 P3, rows D1–D25).
 *
 * Hermetic by construction: `createFakePi` unchanged plus injected deps
 * `{fetchFn, scheduler, now, env, getAllToolsFn, getActiveToolsFn,
 * setActiveToolsFn, setModelFn, setThinkingLevelFn, getModelFn}`. Every no-op
 * row asserts spy-uncalled + snapshot-identical together with branch-ran
 * evidence (fetch count); every gate below was seen red before green.
 */

import { describe, expect, test } from "bun:test";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DECISION_ROUTER_ENV,
	DECISION_ROUTER_TOOLS_ENV,
} from "../../extensions/decision-router/decision-router-core.ts";
import {
	JEV_ENDPOINT_ENV,
	JEV_MODEL_ENV,
	type JevFetchInit,
} from "../../extensions/decision-router/decision-router-client.ts";
import createDecisionRouter, {
	DECISIONS_COMMAND,
	DECISIONS_SUBCOMMANDS,
	DECISIONS_USAGE,
	TIER_HIGH_MODEL_ENV,
	type DecisionRouterDeps,
} from "../../extensions/decision-router/index.ts";
import { ROUTER_FALLBACK_CHANNEL } from "../../extensions/router-fallback/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

// ------------------------------------------------------------------ doubles

type FetchSpec =
	| { readonly status: number; readonly headers?: Record<string, string>; readonly text: string }
	| { readonly never: true }
	| { readonly throws: unknown };

interface RecordedFetch {
	readonly url: string;
	readonly init: JevFetchInit;
}

function makeManualScheduler(): {
	scheduler: NonNullable<DecisionRouterDeps["scheduler"]>;
	fire(): number;
	pendingCount(): number;
} {
	const pending = new Map<unknown, () => void>();
	let seq = 0;
	return {
		scheduler: {
			setTimeout: (handler: () => void, timeoutMs: number) => {
				seq += 1;
				pending.set(seq, () => handler());
				void timeoutMs;
				return seq;
			},
			clearTimeout: (handle: unknown) => {
				pending.delete(handle);
			},
		},
		fire: () => {
			const handlers = [...pending.values()];
			pending.clear();
			for (const handler of handlers) handler();
			return handlers.length;
		},
		pendingCount: () => pending.size,
	};
}

function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence: number): unknown {
	return { type: "choice", choice, probabilities, confidence };
}

function jevBody(answers: Record<string, unknown>, cost = 0.00001): string {
	return JSON.stringify({
		model: "typesafe/jev-1.13",
		id: "gen-dec-test",
		provider: "TypeSafe",
		usage: { input_tokens: 10, output_tokens: 5, cost },
		answers,
	});
}

/** Full-actuation fan-out: tools→[bash], tier→upgrade(high), skill→review. */
function fullActuationBody(): string {
	return jevBody({
		tools: choiceAnswer("bash", { bash: 0.9, grep: 0.05, read: 0.03 }, 0.9),
		tier: choiceAnswer("high", { high: 0.9, medium: 0.1, low: 0 }, 0.9),
		skill: choiceAnswer("review", { review: 0.8, none: 0.2 }, 0.8),
		needs_subagent: { type: "noul", noul: 0.2 },
	});
}

interface Harness {
	readonly pi: FakePi;
	readonly env: Record<string, string | undefined>;
	readonly fetchCalls: RecordedFetch[];
	readonly fetchCount: () => number;
	readonly scheduler: ReturnType<typeof makeManualScheduler>;
	readonly toolState: { all: Array<{ name: string; description: string }>; active: string[] };
	readonly modelState: { current: { provider: string; id: string } };
	readonly registry: Map<string, Record<string, unknown>>;
	readonly setActiveToolsCalls: string[][];
	readonly setModelCalls: unknown[][];
	readonly setThinkingCalls: unknown[];
	readonly notifies: string[];
	readonly skills: Array<{ name: string; description: string; disableModelInvocation: boolean }>;
	nowMs: number;
	fireTurn: (prompt: string, opts?: { skills?: Harness["skills"] }) => Promise<unknown>;
	runCmd: (args: string) => Promise<string[]>;
	status: () => Promise<string>;
	snapshot: () => { active: string[]; model: string };
}

const TIER_MODELS = {
	low: "test/tier-low-model",
	medium: "test/tier-medium-model",
	high: "test/tier-high-model",
} as const;

/**
 * Full registry model (M1): pi stores the setModel argument verbatim as
 * `session.model` and never re-resolves it, so a `{provider,id}` stub breaks
 * the next provider request. The registry double returns this shape.
 */
function fullModel(provider: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		provider,
		id,
		api: "openai-completions",
		baseUrl: `https://${provider}.test/v1`,
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

const DEFAULT_CATALOGUE = [
	{ name: "bash", description: "Run shell commands" },
	{ name: "grep", description: "Search file contents" },
	{ name: "read", description: "Read files" },
];

const DEFAULT_SKILLS = [{ name: "review", description: "Review code", disableModelInvocation: false }];

function setup(
	respond: (call: number) => FetchSpec = () => ({ status: 200, text: fullActuationBody() }),
	mutations: {
		readonly setActiveToolsFn?: (names: string[]) => void;
		readonly setModelFn?: (model: unknown) => Promise<boolean>;
		readonly getActiveToolsFn?: () => string[];
	} = {},
): Harness {
	const pi = createFakePi();
	const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "test-key" };
	const fetchCalls: RecordedFetch[] = [];
	let calls = 0;
	const scheduler = makeManualScheduler();
	const toolState = { all: [...DEFAULT_CATALOGUE], active: ["read"] };
	const modelState = { current: { provider: "test", id: "tier-low-model" } };
	const registry = new Map<string, Record<string, unknown>>();
	for (const id of ["tier-low-model", "tier-medium-model", "tier-high-model"]) {
		registry.set(`test/${id}`, fullModel("test", id));
	}
	const setActiveToolsCalls: string[][] = [];
	const setModelCalls: unknown[][] = [];
	const setThinkingCalls: unknown[] = [];
	const notifies: string[] = [];
	const skills = [...DEFAULT_SKILLS];
	let nowMs = 1_700_000_000_000;

	const fetchFn: NonNullable<DecisionRouterDeps["fetchFn"]> = (url, init) => {
		const index = calls++;
		fetchCalls.push({ url, init });
		const spec = respond(index);
		if ("throws" in spec) return Promise.reject(spec.throws);
		if ("never" in spec) return new Promise<never>(() => {});
		const headers = spec.headers ?? {};
		const lowered: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
		return Promise.resolve({
			status: spec.status,
			headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null },
			text: () => Promise.resolve(spec.text),
		});
	};

	const defaultSetActiveTools = (names: string[]): void => {
		setActiveToolsCalls.push([...names]);
		toolState.active = [...names];
	};
	const defaultSetModel = async (...args: unknown[]): Promise<boolean> => {
		// Records every received arg: the D6 one-positional-arg gate inspects
		// the call shape, so extras must survive the double (a fixed (model)
		// parameter would silently drop them and the gate would prove nothing).
		setModelCalls.push(args);
		return true;
	};

	createDecisionRouter(pi as never, {
		fetchFn,
		scheduler: scheduler.scheduler,
		now: () => nowMs,
		env,
		getAllToolsFn: () => [...toolState.all],
		getActiveToolsFn: mutations.getActiveToolsFn ?? (() => [...toolState.active]),
		setActiveToolsFn: mutations.setActiveToolsFn ?? defaultSetActiveTools,
		setModelFn: mutations.setModelFn ?? defaultSetModel,
		setThinkingLevelFn: (level) => {
			setThinkingCalls.push(level);
		},
		getModelFn: () => ({ ...modelState.current }),
		tierModels: { ...TIER_MODELS },
	});

	const ctxOf = (): ExtensionContext =>
		({
			getModel: () => ({ ...modelState.current }),
			modelRegistry: { find: (provider: string, id: string) => registry.get(`${provider}/${id}`) },
			getSystemPromptOptions: () => ({ skills: [...skills] }),
			ui: { notify: (message: string) => notifies.push(message) },
		}) as unknown as ExtensionContext;

	const handlers = pi.handlers.get("before_agent_start") ?? [];
	if (handlers.length !== 1) throw new Error(`expected one before_agent_start handler, saw ${handlers.length}`);
	const handler = handlers[0]!;

	const harness: Harness = {
		pi,
		env,
		fetchCalls,
		fetchCount: () => fetchCalls.length,
		scheduler,
		toolState,
		modelState,
		registry,
		setActiveToolsCalls,
		setModelCalls,
		setThinkingCalls,
		notifies,
		skills,
		get nowMs() {
			return nowMs;
		},
		set nowMs(value: number) {
			nowMs = value;
		},
		fireTurn: async (prompt, opts) => {
			const event = {
				type: "before_agent_start",
				prompt,
				systemPrompt: "",
				systemPromptOptions: { skills: opts?.skills ?? skills },
			};
			return handler(event, ctxOf());
		},
		runCmd: async (args) => {
			const cmd = pi.commands.get(DECISIONS_COMMAND) as {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			};
			notifies.length = 0;
			await cmd.handler(args, ctxOf() as unknown as ExtensionCommandContext);
			return [...notifies];
		},
		status: async () => (await harness.runCmd("status")).join("\n"),
		snapshot: () => ({ active: [...toolState.active].sort(), model: `${modelState.current.provider}/${modelState.current.id}` }),
	};
	return harness;
}

// ------------------------------------------------------------------ D1 single fan-out

describe("D1 — one fetch per enabled DISTINCT turn, tools→model→routing order", () => {
	test("two distinct prompts fire two fanned-out calls; one handler is registered", async () => {
		const h = setup();
		expect(h.pi.handlers.get("before_agent_start")).toHaveLength(1);
		const r1 = await h.fireTurn("Fix the failing build in the deploy pipeline");
		const r2 = await h.fireTurn("Refactor the auth module to use the new session store");
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();
		expect(h.fetchCount()).toBe(2);
		const body = JSON.parse(h.fetchCalls[0]!.init.body) as { questions: Record<string, unknown> };
		expect(Object.keys(body.questions).sort()).toEqual(["needs_subagent", "skill", "tier", "tools"]);
		// Apply order tools→model→routing: tools actuated once (second turn hits
		// already-enabled), model upgraded per turn, ring logged.
		expect(h.setActiveToolsCalls).toEqual([["bash", "read"]]);
		expect(h.setModelCalls).toHaveLength(2);
		expect(h.setModelCalls[0]).toHaveLength(1);
		expect(h.setModelCalls[0]![0]).toMatchObject({
			provider: "test",
			id: "tier-high-model",
			api: expect.any(String),
			baseUrl: expect.any(String),
		});
		expect(h.setThinkingCalls).toEqual(["high", "high"]);
		const shadow = await h.runCmd("shadow");
		expect(shadow.join("\n")).toContain("review");
	});
});

// ------------------------------------------------------------------ no-op rows

describe("D2/D3/D5 — no-op paths never fetch, never mutate, snapshot-identical", () => {
	test("D2 missing key: zero fetch, spies uncalled, snapshot identical", async () => {
		const h = setup();
		delete h.env["OPENROUTER_API_KEY"];
		const before = h.snapshot();
		const result = await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(result).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.setThinkingCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
	});

	test("D3 master kill: zero fetch, spies uncalled, snapshot identical", async () => {
		const h = setup();
		h.env[DECISION_ROUTER_ENV] = "0";
		const before = h.snapshot();
		expect(await h.fireTurn("Fix the failing build in the deploy pipeline")).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
	});

	test("D3b all three per-cap kills skip the turn outright", async () => {
		const h = setup();
		h.env["PI_BADGER_DECISION_ROUTER_TOOLS"] = "0";
		h.env["PI_BADGER_DECISION_ROUTER_MODEL"] = "0";
		h.env["PI_BADGER_DECISION_ROUTER_ROUTING"] = "0";
		expect(await h.fireTurn("Fix the failing build in the deploy pipeline")).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect((await h.status()).split("\n").find((line) => line.startsWith("last turn:"))).toContain("tools-kill");
	});

	test("D5 short prompt: zero fetch, spies uncalled, snapshot identical", async () => {
		const h = setup();
		const before = h.snapshot();
		expect(await h.fireTurn("fix it")).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
	});

	test("slash-prefixed prompt skips without priced work", async () => {
		const h = setup();
		expect(await h.fireTurn("/decisions status and do the thing please")).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ D6 session-only model

describe("D6 — setModelFn called exactly once with ONE positional arg; persist-surface negatives", () => {
	test("upgrade calls setModelFn once with the FULL resolved registry model and no persist surface", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.setModelCalls).toHaveLength(1);
		expect(h.setModelCalls[0]).toHaveLength(1);
		const target = h.setModelCalls[0]![0] as Record<string, unknown>;
		// The full registry model, not the two-key stub that corrupts session.model (M1).
		expect(target["provider"]).toBe("test");
		expect(target["id"]).toBe("tier-high-model");
		expect(typeof target["api"]).toBe("string");
		expect(typeof target["baseUrl"]).toBe("string");
		expect(Object.keys(target).length).toBeGreaterThan(2);
		expect(h.setThinkingCalls).toEqual(["high"]);
		expect(h.pi.entries).toHaveLength(0);
		expect(h.pi.sent).toHaveLength(0);
	});

	test("already-on-target holds: setModelFn and setThinkingLevelFn uncalled, fetch proves the turn ran", async () => {
		const h = setup();
		h.modelState.current = { provider: "test", id: "tier-high-model" };
		h.toolState.active = ["bash", "read"]; // subset [bash] already enabled: tools hold too
		const before = h.snapshot();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.setThinkingCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
		expect((await h.status())).toContain("already-on-target");
	});
});

// ------------------------------------------------------------------ A1 registry resolution

describe("A1 (code-M1) — tier apply resolves a FULL registry model or holds without setModel", () => {
	test("empty or whitespace env target holds tier-target-unset with no setModel call", async () => {
		for (const raw of ["", "   "]) {
			const h = setup();
			h.env[TIER_HIGH_MODEL_ENV] = raw;
			await h.fireTurn("Fix the failing build in the deploy pipeline");
			expect(h.fetchCount()).toBe(1);
			expect(h.setModelCalls).toHaveLength(0);
			expect(h.setThinkingCalls).toHaveLength(0);
			expect(h.modelState.current).toEqual({ provider: "test", id: "tier-low-model" });
			expect(await h.status()).toContain("tier-target-unset");
		}
	});

	test("an unparseable target (no provider/id split) holds tier-target-unset", async () => {
		const h = setup();
		h.env[TIER_HIGH_MODEL_ENV] = "no-slash-target";
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.setModelCalls).toHaveLength(0);
		expect(await h.status()).toContain("tier-target-unset");
	});

	test("a target absent from the registry holds target-not-in-registry", async () => {
		const h = setup();
		h.env[TIER_HIGH_MODEL_ENV] = "ghost/not-installed";
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.setThinkingCalls).toHaveLength(0);
		expect(h.modelState.current).toEqual({ provider: "test", id: "tier-low-model" });
		expect(await h.status()).toContain("target-not-in-registry");
	});
});

// ------------------------------------------------------------------ A3 active-read failure

describe("A3 (code-S2) — a failed getActiveTools read holds the tool step, never narrows", () => {
	test("a throwing getActiveToolsFn holds tools as active-read-failed while tier still applies", async () => {
		const h = setup(() => ({ status: 200, text: fullActuationBody() }), {
			getActiveToolsFn: () => {
				throw new Error("getActiveTools unavailable");
			},
		});
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		// The destructive narrowing (write [bash] over the real active set) never happens.
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(await h.status()).toContain("hold (active-read-failed)");
		// Other steps stay fail-open and independent.
		expect(h.setModelCalls).toHaveLength(1);
		expect((await h.runCmd("shadow")).join("\n")).toContain("review");
	});
});

// ------------------------------------------------------------------ A5 own model_select

describe("A5 (code-N2) — the extension's own model_select during the await does not invalidate", () => {
	test("a model_select emitted while setModel is pending does not evict an earlier cached turn", async () => {
		let h!: Harness;
		h = setup(() => ({ status: 200, text: fullActuationBody() }), {
			setModelFn: async (model: unknown) => {
				// pi emits model_select{source:"set"} before setModel resolves.
				for (const handler of h.pi.handlers.get("model_select") ?? []) {
					await handler({ type: "model_select", model, previousModel: undefined, source: "set" }, {});
				}
				return true;
			},
		});
		const firstPrompt = "Fix the failing build in the deploy pipeline";
		await h.fireTurn(firstPrompt);
		expect(h.fetchCount()).toBe(1);
		// A different target than the previous switch, so the stale applied id
		// cannot mask the pending one.
		h.env[TIER_HIGH_MODEL_ENV] = "test/tier-medium-model";
		await h.fireTurn("Refactor the auth module to use the new session store");
		expect(h.fetchCount()).toBe(2);
		// The second turn's own switch must not have wiped the first turn's entry.
		await h.fireTurn(firstPrompt);
		expect(h.fetchCount()).toBe(2);
	});
});

// ------------------------------------------------------------------ A6 stale status

describe("A6 (code-N4) — a tools-only decided turn clears the previous error/fallback", () => {
	test("after an error turn, a tools-only hold reports no stale lastError or fallback", async () => {
		const h = setup(() => ({ status: 500, text: "boom" }));
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		let status = await h.status();
		expect(status).toContain("lastError: server");
		expect(status).toContain("fallback: ");
		// Next turn decides tools-only: catalogue empty + model/routing killed.
		h.env["PI_BADGER_DECISION_ROUTER_MODEL"] = "0";
		h.env["PI_BADGER_DECISION_ROUTER_ROUTING"] = "0";
		h.toolState.all = [];
		await h.fireTurn("Refactor the auth module to use the new session store");
		status = await h.status();
		expect(status).toContain("last turn: decided");
		expect(status).toContain("lastError: none");
		expect(status).not.toContain("fallback: ");
	});
});

// ------------------------------------------------------------------ B1 declined setModel

describe("B1 (qa-F1) — a declined setModel holds and applies nothing", () => {
	test("setModel false: no thinking change, no applied target, status reports the decline", async () => {
		const calls: unknown[][] = [];
		const h = setup(() => ({ status: 200, text: fullActuationBody() }), {
			setModelFn: async (...args: unknown[]) => {
				calls.push(args);
				return false;
			},
		});
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(1);
		expect(h.setThinkingCalls).toHaveLength(0);
		const status = await h.status();
		expect(status).toContain("last model: hold (set-model-declined)");
		// lastAppliedTarget must not have been set: a same-id model_select is foreign.
		for (const handler of h.pi.handlers.get("model_select") ?? []) {
			await handler(
				{ type: "model_select", model: { provider: "test", id: "tier-high-model" }, previousModel: undefined, source: "set" },
				{},
			);
		}
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
	});
});

// ------------------------------------------------------------------ B2 live env overrides

describe("B2 (qa-F2) — live env overrides drive URL, body model and tier target", () => {
	test("JEV_ENDPOINT, JEV_MODEL and TIER_HIGH_MODEL reach the wire and the resolved setModel", async () => {
		const h = setup();
		h.registry.set("env/tier-high-override", fullModel("env", "tier-high-override"));
		h.env[JEV_ENDPOINT_ENV] = "https://example.test/decisions";
		h.env[JEV_MODEL_ENV] = "custom/jev-model-x";
		h.env[TIER_HIGH_MODEL_ENV] = "env/tier-high-override";
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCalls[0]!.url).toBe("https://example.test/decisions");
		const body = JSON.parse(h.fetchCalls[0]!.init.body) as { model: string };
		expect(body.model).toBe("custom/jev-model-x");
		expect(h.setModelCalls).toHaveLength(1);
		expect(h.setModelCalls[0]![0]).toMatchObject({ provider: "env", id: "tier-high-override" });
	});
});

// ------------------------------------------------------------------ B3 LRU

describe("B3 (qa-F3) — cache LRU cap and recency", () => {
	const prompts = (n: number) => `Fix the failing build number ${n} in the deploy pipeline`;

	test("a 51st distinct decision evicts the coldest entry", async () => {
		const h = setup();
		for (let i = 1; i <= 51; i++) await h.fireTurn(prompts(i));
		expect(h.fetchCount()).toBe(51);
		expect(await h.status()).toContain("cache: 50 entries");
		await h.fireTurn(prompts(1));
		expect(h.fetchCount()).toBe(52);
	});

	test("a cache hit refreshes recency so the untouched entry is evicted first", async () => {
		const h = setup();
		for (let i = 1; i <= 50; i++) await h.fireTurn(prompts(i));
		await h.fireTurn(prompts(1)); // hit: entry 1 becomes the newest
		expect(h.fetchCount()).toBe(50);
		await h.fireTurn(prompts(51)); // evicts entry 2, not entry 1
		expect(h.fetchCount()).toBe(51);
		await h.fireTurn(prompts(1));
		expect(h.fetchCount()).toBe(51);
		await h.fireTurn(prompts(2));
		expect(h.fetchCount()).toBe(52);
	});
});

// ------------------------------------------------------------------ B4 skill filter

describe("B4 (qa-F4) — disableModelInvocation skills are excluded from routing options", () => {
	test("both the turn event and the check command filter out model-invocation-disabled skills", async () => {
		const h = setup();
		h.skills.push({ name: "hidden-skill", description: "Never model-invoked", disableModelInvocation: true });
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		const turnBody = JSON.parse(h.fetchCalls[0]!.init.body) as {
			questions: { skill: { criteria: Record<string, string> } };
		};
		expect(Object.keys(turnBody.questions.skill.criteria)).toContain("review");
		expect(Object.keys(turnBody.questions.skill.criteria)).not.toContain("hidden-skill");
		await h.runCmd("check Fix the failing build in the deploy pipeline");
		const checkBody = JSON.parse(h.fetchCalls[1]!.init.body) as {
			questions: { skill: { criteria: Record<string, string> } };
		};
		expect(Object.keys(checkBody.questions.skill.criteria)).toContain("review");
		expect(Object.keys(checkBody.questions.skill.criteria)).not.toContain("hidden-skill");
	});
});

// ------------------------------------------------------------------ B6 error-path ring

describe("B6 (qa-F6) — a failed turn records the fallback ring entry (D8)", () => {
	test("after a failed turn /decisions shadow shows the observe-only record", async () => {
		const h = setup(() => ({ status: 500, text: "boom" }));
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		const shadow = (await h.runCmd("shadow")).join("\n");
		expect(shadow).toContain("shadow 1: skill=none conf=0");
		expect(shadow).not.toContain("no records");
	});
});

// ------------------------------------------------------------------ D23 timeout twin

describe("D23 — timeout twin: fallback ran, session untouched", () => {
	test("never-resolving fetch settles on the injected deadline with zero mutations", async () => {
		const h = setup(() => ({ never: true }));
		const before = h.snapshot();
		const pending = h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.scheduler.pendingCount()).toBe(1);
		h.scheduler.fire();
		expect(await pending).toBeUndefined();
		expect(h.fetchCount()).toBe(1);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
		const status = await h.status();
		expect(status).toContain("transport-timeout");
		expect(status).toContain("fallback");
	});
});

// ------------------------------------------------------------------ D7/D10 honesty ×6

describe("D10 (D7 honesty pattern) — six SYNTH error fixtures: fetch once, untouched, lastError", () => {
	const cases: Array<[string, FetchSpec]> = [
		["400 misrouted-refusal", { status: 400, text: "SECRET-BODY-MARKER" }],
		["401 auth", { status: 401, text: '{"error":{"message":"bad key","code":401}}' }],
		["402 billing", { status: 402, text: '{"error":{"message":"no credits","code":402}}' }],
		["429 rate-limited", { status: 429, headers: { "retry-after": "5" }, text: '{"error":{"code":429}}' }],
		["500 server", { status: 500, text: "upstream exploded" }],
		["truncated malformed", { status: 200, text: '{"model":"typesafe/jev-1.13","answers":{"depart' }],
	];
	test.each(cases)("%s → one fetch, both mutation spies uncalled, snapshot identical, lastError recorded", async (_name, spec) => {
		const h = setup(() => spec);
		const before = h.snapshot();
		expect(await h.fireTurn("Fix the failing build in the deploy pipeline")).toBeUndefined();
		expect(h.fetchCount()).toBe(1);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.setThinkingCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
		const status = await h.status();
		expect(status).toContain("lastError: ");
		expect(status).not.toContain("lastError: none");
		const line = status.split("\n").find((l) => l.startsWith("lastError: "))!;
		expect(line.length).toBeLessThanOrEqual("lastError: ".length + 120);
		expect(status).not.toContain("SECRET-BODY-MARKER");
	});
});

// ------------------------------------------------------------------ D21 mixed fan-out

describe("D21 — mixed fan-out step-independence, both directions", () => {
	test("tools actuate while tier holds neutral: tools applied, model untouched, routing logged", async () => {
		const h = setup(() =>
			({
				status: 200,
				text: jevBody({
					tools: choiceAnswer("bash", { bash: 0.9, grep: 0.05, read: 0.03 }, 0.9),
					tier: choiceAnswer("medium", { medium: 0.79, low: 0.21, high: 0 }, 0.69),
					skill: choiceAnswer("review", { review: 0.8, none: 0.2 }, 0.8),
				}),
			}),
		);
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.setActiveToolsCalls).toEqual([["bash", "read"]]);
		expect(h.setModelCalls).toHaveLength(0);
		expect((await h.runCmd("shadow")).join("\n")).toContain("review");
	});

	test("tools hold low-confidence while tier upgrades: model applied, tools untouched", async () => {
		const h = setup(() =>
			({
				status: 200,
				text: jevBody({
					tools: choiceAnswer("read", { read: 0.69, bash: 0.23, grep: 0.08 }, 0.61),
					tier: choiceAnswer("high", { high: 0.9, medium: 0.1, low: 0 }, 0.9),
					skill: choiceAnswer("none", { none: 0.95, review: 0.05 }, 0.95),
				}),
			}),
		);
		const before = h.snapshot();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.snapshot().active).toEqual(before.active);
		expect(h.setModelCalls).toHaveLength(1);
		expect((await h.status())).toContain("low-confidence");
	});

	test("a throwing setActiveToolsFn never blocks the model step or the routing log", async () => {
		const toolCalls: string[][] = [];
		const failing = setup(() => ({ status: 200, text: fullActuationBody() }), {
			setActiveToolsFn: (names) => {
			toolCalls.push([...names]);
			throw new Error("boom: tools mutation failed");
		},
		});
		await failing.fireTurn("Fix the failing build in the deploy pipeline");
		expect(toolCalls).toEqual([["bash", "read"]]);
		expect(failing.setModelCalls).toHaveLength(1);
		expect((await failing.runCmd("shadow")).join("\n")).toContain("review");
	});

	test("a throwing setModelFn never blocks the tools step or the routing log", async () => {
		const modelCalls: unknown[][] = [];
		const failing = setup(() => ({ status: 200, text: fullActuationBody() }), {
			setModelFn: async (...args: unknown[]) => {
				modelCalls.push(args);
				throw new Error("boom: model mutation failed");
			},
		});
		await failing.fireTurn("Fix the failing build in the deploy pipeline");
		expect(modelCalls).toHaveLength(1);
		expect(failing.setActiveToolsCalls).toEqual([["bash", "read"]]);
		expect((await failing.runCmd("shadow")).join("\n")).toContain("review");
	});
});

// ------------------------------------------------------------------ D12 status golden

describe("D12 — /decisions status golden", () => {
	test("status shows effective config, key presence never value, last decisions, cooldown, cache, cost", async () => {
		const h = setup();
		h.env["OPENROUTER_API_KEY"] = "super-secret-value";
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		const status = await h.status();
		expect(status).toContain("decisions status");
		expect(status).toContain("tools=yes");
		expect(status).toContain("model=yes");
		expect(status).toContain("routing=yes");
		expect(status).toContain("key: present");
		expect(status).not.toContain("super-secret-value");
		expect(status).toContain("bash");
		expect(status).toContain("upgrade");
		expect(status).toContain("review");
		expect(status).toContain("cooldown: none");
		expect(status).toContain("cache: 1 entries, 0 hits");
		expect(status).toContain("cost: $0.000010");
	});
});

// ------------------------------------------------------------------ D13 off/on + env precedence

describe("D13 — /decisions off/on; session on never lifts an env kill (F10)", () => {
	test("off skips with zero fetch; on resumes deciding", async () => {
		const h = setup();
		expect(await h.runCmd("off")).toEqual([expect.stringContaining("off")]);
		expect(await h.fireTurn("Fix the failing build in the deploy pipeline")).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect((await h.status())).toContain("session off");
		expect(await h.runCmd("on")).toEqual([expect.stringContaining("on")]);
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
	});

	test("D13b: on never lifts an env kill", async () => {
		const h = setup();
		h.env[DECISION_ROUTER_ENV] = "0";
		await h.runCmd("on");
		expect(await h.fireTurn("Fix the failing build in the deploy pipeline")).toBeUndefined();
		expect(h.fetchCount()).toBe(0);
		expect((await h.status())).toContain("master-kill");
	});
});

// ------------------------------------------------------------------ D14 check

describe("D14 — /decisions check bypasses cooldown+cache, not kill/key", () => {
	test("check re-fires an already-cached prompt while the normal path stays cached", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		await h.runCmd("check Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
		// And the normal path still serves the cached key without fetching.
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
	});

	test("check fires while a 429 cooldown is armed", async () => {
		const h = setup(() => ({ status: 429, headers: { "retry-after": "5" }, text: '{"error":{"code":429}}' }));
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		await h.runCmd("check Probe the cache layer for stale entries");
		expect(h.fetchCount()).toBe(2);
	});

	test("check respects kill and key", async () => {
		const h = setup();
		h.env[DECISION_ROUTER_ENV] = "0";
		await h.runCmd("check Probe the cache layer for stale entries");
		expect(h.fetchCount()).toBe(0);
		delete h.env[DECISION_ROUTER_ENV];
		delete h.env["OPENROUTER_API_KEY"];
		await h.runCmd("check Probe the cache layer for stale entries");
		expect(h.fetchCount()).toBe(0);
	});

	test("check with no prompt and no history reports instead of fetching", async () => {
		const h = setup();
		const out = await h.runCmd("check");
		expect(h.fetchCount()).toBe(0);
		expect(out.join("\n")).toContain("no prompt yet");
	});
});

// ------------------------------------------------------------------ D15 reset/unknown/completions

describe("D15 — reset clears session state; unknown answers usage; completions list six verbs", () => {
	test("reset clears cache, cooldown, errors and ring so the next turn re-fires", async () => {
		const h = setup(() => ({ status: 500, text: "boom" }));
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		expect((await h.status())).not.toContain("lastError: none");
		await h.runCmd("reset");
		const status = await h.status();
		expect(status).toContain("lastError: none");
		expect(status).toContain("cache: 0 entries, 0 hits");
		expect(status).toContain("cooldown: none");
		expect((await h.runCmd("shadow")).join("\n")).toContain("no records");
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
	});

	test("unknown subcommand answers usage", async () => {
		const h = setup();
		expect(await h.runCmd("frobnicate")).toEqual([DECISIONS_USAGE]);
	});

	test("completions offer the six verbs and filter by prefix", async () => {
		const h = setup();
		const cmd = h.pi.commands.get(DECISIONS_COMMAND) as {
			getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null;
		};
		const all = cmd.getArgumentCompletions("");
		if (all === null) throw new Error("expected completions for empty prefix");
		expect(all.map((item) => item.value).sort()).toEqual([...DECISIONS_SUBCOMMANDS].sort());
		const st = cmd.getArgumentCompletions("st");
		if (st === null) throw new Error("expected completions for st");
		expect(st.map((item) => item.value)).toEqual(["status"]);
		expect(cmd.getArgumentCompletions("zzz")).toBeNull();
	});
});

// ------------------------------------------------------------------ D16 shutdown

describe("D16 — session_shutdown resets ring/cache/cooldown/lastError/override with NO appendEntry", () => {
	test("shutdown returns the session to a blank slate and never appends", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		await h.runCmd("off");
		expect(h.fetchCount()).toBe(1);
		for (const handler of h.pi.handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown", reason: "quit" }, {});
		}
		const status = await h.status();
		expect(status).toContain("cache: 0 entries, 0 hits");
		expect(status).toContain("cooldown: none");
		expect(status).toContain("lastError: none");
		expect(status).toContain("session on");
		expect((await h.runCmd("shadow")).join("\n")).toContain("no records");
		expect(h.pi.entries).toHaveLength(0);
		// After shutdown the next turn decides fresh.
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
	});
});

// ------------------------------------------------------------------ D17 model_select

describe("D17 — foreign model_select invalidates; same-as-applied keeps the cache", () => {
	test("a foreign model change re-fires the cached prompt", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		for (const handler of h.pi.handlers.get("model_select") ?? []) {
			await handler(
				{ type: "model_select", model: { provider: "test", id: "tier-low-model" }, previousModel: undefined, source: "cycle" },
				{},
			);
		}
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
	});

	test("a select confirming our last-applied target keeps the cache (F7)", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		for (const handler of h.pi.handlers.get("model_select") ?? []) {
			await handler(
				{ type: "model_select", model: { provider: "test", id: "tier-high-model" }, previousModel: undefined, source: "set" },
				{},
			);
		}
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
	});
});

// ------------------------------------------------------------------ D18/D18b fallback latch

describe("D18/D18b — fallback switched invalidates and latches upgrades off", () => {
	test("switched clears the cache and latches upgrades while demotes still actuate", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		h.pi.fireTransition(ROUTER_FALLBACK_CHANNEL, {
			episodeId: "ep-1",
			kind: "billing-exhaustion",
			reason: "router down",
			from: { provider: "test", model: "tier-high-model" },
			to: { provider: "free", model: "free-model" },
			servedBy: ["free"],
		});
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
		// While latched, an upgrade holds with upgrade-latched and no model call.
		const callsBefore = h.setModelCalls.length;
		await h.fireTurn("Design the new multi-region failover architecture");
		expect((await h.status())).toContain("upgrade-latched");
		expect(h.setModelCalls).toHaveLength(callsBefore);
	});

	test("D18b: a demote still actuates while latched", async () => {
		const h = setup(() =>
			({
				status: 200,
				text: jevBody({
					tools: choiceAnswer("bash", { bash: 0.1, grep: 0.05 }, 0.9),
					tier: choiceAnswer("low", { low: 0.9, medium: 0.1, high: 0 }, 0.9),
					skill: choiceAnswer("none", { none: 1 }, 1),
				}),
			}),
		);
		h.modelState.current = { provider: "test", id: "tier-high-model" };
		h.pi.fireTransition(ROUTER_FALLBACK_CHANNEL, { kind: "switched", episodeId: "ep-1" });
		await h.fireTurn("Rename the cooldownMs variable across the codebase");
		expect(h.setModelCalls).toHaveLength(1);
		expect(h.setModelCalls[0]![0]).toMatchObject({ provider: "test", id: "tier-low-model" });
	});

	test("D18b: the latch clears on a settled successful turn, then upgrades actuate again", async () => {
		const h = setup();
		h.pi.fireTransition(ROUTER_FALLBACK_CHANNEL, { kind: "switched", episodeId: "ep-1" });
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		const callsAfterFirst = h.setModelCalls.length;
		expect((await h.status())).toContain("upgrade-latched");
		for (const handler of h.pi.handlers.get("agent_settled") ?? []) {
			await handler({ type: "agent_settled" }, {});
		}
		await h.fireTurn("Design the new multi-region failover architecture");
		expect(h.setModelCalls.length).toBeGreaterThan(callsAfterFirst);
	});

	test("D18b: a failed turn keeps the latch across settle", async () => {
		const h = setup(() => ({ status: 500, text: "boom" }));
		h.pi.fireTransition(ROUTER_FALLBACK_CHANNEL, { kind: "switched", episodeId: "ep-1" });
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		for (const handler of h.pi.handlers.get("agent_settled") ?? []) {
			await handler({ type: "agent_settled" }, {});
		}
		const h2latchStatus = await h.status();
		expect(h2latchStatus).toContain("latch: upgrades held");
	});
});

// ------------------------------------------------------------------ D19 failure-phrased prompt

describe("D19 — failure-phrased prompt holds the model; fetch proves the turn ran", () => {
	test("API-500 language never escalates by itself: medium tier holds, no model call", async () => {
		const h = setup(() =>
			({
				status: 200,
				text: jevBody({
					tools: choiceAnswer("read", { read: 0.69, bash: 0.23, grep: 0.08 }, 0.61),
					tier: choiceAnswer("medium", { medium: 0.79, low: 0.21, high: 0 }, 0.69),
					skill: choiceAnswer("none", { none: 0.9, review: 0.1 }, 0.9),
				}),
			}),
		);
		const before = h.snapshot();
		await h.fireTurn("API returns 500 errors after the deploy, investigate the technical failure");
		expect(h.fetchCount()).toBe(1);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.snapshot()).toEqual(before);
	});
});

// ------------------------------------------------------------------ D22 catalogue change

describe("D22 — catalogue change at a fixed prompt re-fires", () => {
	test("adding a tool to the catalogue misses the cache and fetches again", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		h.toolState.all = [...h.toolState.all, { name: "write", description: "Write files" }];
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(2);
	});
});

// ------------------------------------------------------------------ D20 cooldown machine

describe("D20 — 429 arms retryAfterMs; armed skips all calls; expiry re-fires", () => {
	test("while armed every prompt skips as rate-limited with zero fetch; the clock releases it", async () => {
		const h = setup(() => ({ status: 429, headers: { "retry-after": "5" }, text: '{"error":{"code":429}}' }));
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		expect((await h.status())).toContain("armed");
		// Same prompt AND a distinct prompt both skip while armed.
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		await h.fireTurn("Refactor the auth module to use the new session store");
		expect(h.fetchCount()).toBe(1);
		expect((await h.status()).split("\n").find((line) => line.startsWith("last turn:"))).toContain("rate-limited");
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(0);
		// 60 s floor: advancing 59 s still skips; 60 s re-fires.
		h.nowMs += 59_000;
		await h.fireTurn("Refactor the auth module to use the new session store");
		expect(h.fetchCount()).toBe(1);
		h.nowMs += 1_000;
		await h.fireTurn("Refactor the auth module to use the new session store");
		expect(h.fetchCount()).toBe(2);
	});
});

// ------------------------------------------------------------------ D24 cache fetch counts

describe("D24a/b — cache wiring: repeat → one fetch, changed prompt → two", () => {
	test("D24a: the same prompt three times costs one fetch with two cache hits", async () => {
		const h = setup();
		const prompt = "Fix the failing build in the deploy pipeline";
		await h.fireTurn(prompt);
		await h.fireTurn(prompt);
		await h.fireTurn(prompt);
		expect(h.fetchCount()).toBe(1);
		expect((await h.status())).toContain("cache: 1 entries, 2 hits");
	});

	test("D24b: a changed prompt misses and fetches on the same cache instance", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		await h.fireTurn("Refactor the auth module to use the new session store");
		expect(h.fetchCount()).toBe(2);
		expect((await h.status())).toContain("cache: 2 entries, 0 hits");
	});
});

// ------------------------------------------------------------------ D25 fan-out narrowing

describe("D25 — fan-out carries ONLY enabled questions", () => {
	test("tools-off still fires one call for tier+shadow whose body has no tools key", async () => {
		const h = setup();
		h.env[DECISION_ROUTER_TOOLS_ENV] = "0";
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		const body = JSON.parse(h.fetchCalls[0]!.init.body) as { questions: Record<string, unknown> };
		expect(Object.keys(body.questions).sort()).toEqual(["needs_subagent", "skill", "tier"]);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(1);
		expect((await h.status())).toContain("tools=no");
	});
});

// ------------------------------------------------------------------ D11 env per call

describe("D11 — env is read per call from the live record", () => {
	test("flipping the kill switch mid-session changes the next turn with no restart", async () => {
		const h = setup();
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		h.env[DECISION_ROUTER_ENV] = "0";
		await h.fireTurn("Refactor the auth module to use the new session store");
		expect(h.fetchCount()).toBe(1);
		delete h.env[DECISION_ROUTER_ENV];
		await h.fireTurn("Triage the inbox routing rules for the support team");
		expect(h.fetchCount()).toBe(2);
	});
});

// ------------------------------------------------------------------ F15 privacy

describe("F15 — key never logged; ring stores promptHash, never prompt text", () => {
	test("status and shadow never carry the key value or the prompt text", async () => {
		const h = setup();
		h.env["OPENROUTER_API_KEY"] = "super-secret-value";
		const prompt = "Fix the failing build in the deploy pipeline";
		await h.fireTurn(prompt);
		const status = await h.status();
		const shadow = (await h.runCmd("shadow")).join("\n");
		for (const text of [status, shadow]) {
			expect(text).not.toContain("super-secret-value");
			expect(text).not.toContain(prompt);
		}
		expect(shadow).toMatch(/hash=[0-9a-f]+/);
	});
});

// ------------------------------------------------------------------ in-flight + empty catalogue

describe("in-flight — a concurrent turn skips while a classify is outstanding", () => {
	test("two concurrent same-prompt turns cost one fetch", async () => {
		// Deferred fetch: resolve manually after both turns are in flight.
		let resolveFetch!: (spec: { status: number; text: string }) => void;
		const h2 = setupDeferred((r) => {
			resolveFetch = r;
		});
		const p1 = h2.fireTurn("Fix the failing build in the deploy pipeline");
		await new Promise((r) => setTimeout(r, 0));
		const p2 = h2.fireTurn("Fix the failing build in the deploy pipeline");
		expect(await p2).toBeUndefined();
		expect(h2.fetchCount()).toBe(1);
		resolveFetch({ status: 200, text: fullActuationBody() });
		expect(await p1).toBeUndefined();
		expect(h2.fetchCount()).toBe(1);
	});
});

function setupDeferred(onWait: (resolve: (spec: { status: number; text: string }) => void) => void): Harness {
	const pi = createFakePi();
	const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "test-key" };
	const fetchCalls: RecordedFetch[] = [];
	const scheduler = makeManualScheduler();
	const toolState = { all: [...DEFAULT_CATALOGUE], active: ["read"] };
	const modelState = { current: { provider: "test", id: "tier-low-model" } };
	const registry = new Map<string, Record<string, unknown>>();
	for (const id of ["tier-low-model", "tier-medium-model", "tier-high-model"]) {
		registry.set(`test/${id}`, fullModel("test", id));
	}
	const setActiveToolsCalls: string[][] = [];
	const setModelCalls: unknown[][] = [];
	const setThinkingCalls: unknown[] = [];
	const notifies: string[] = [];
	const nowMs = 1_700_000_000_000;
	const fetchFn: NonNullable<DecisionRouterDeps["fetchFn"]> = (url, init) => {
		fetchCalls.push({ url, init });
		return new Promise((resolve) => {
			onWait((spec) =>
				resolve({
					status: spec.status,
					headers: { get: () => null },
					text: () => Promise.resolve(spec.text),
				}),
			);
		});
	};
	createDecisionRouter(pi as never, {
		fetchFn,
		scheduler: scheduler.scheduler,
		now: () => nowMs,
		env,
		getAllToolsFn: () => [...toolState.all],
		getActiveToolsFn: () => [...toolState.active],
		setActiveToolsFn: (names) => {
			setActiveToolsCalls.push([...names]);
			toolState.active = [...names];
		},
		setModelFn: async (...args: unknown[]) => {
			setModelCalls.push(args);
			return true;
		},
		setThinkingLevelFn: (level) => {
			setThinkingCalls.push(level);
		},
		getModelFn: () => ({ ...modelState.current }),
		tierModels: { ...TIER_MODELS },
	});
	const ctxOf = () =>
		({
			getModel: () => ({ ...modelState.current }),
			modelRegistry: { find: (provider: string, id: string) => registry.get(`${provider}/${id}`) },
			ui: { notify: (m: string) => notifies.push(m) },
		}) as unknown as ExtensionContext;
	const handler = (pi.handlers.get("before_agent_start") ?? [])[0]!;
	return {
		pi,
		env,
		fetchCalls,
		fetchCount: () => fetchCalls.length,
		scheduler,
		toolState,
		modelState,
		registry,
		setActiveToolsCalls,
		setModelCalls,
		setThinkingCalls,
		notifies,
		skills: [...DEFAULT_SKILLS],
		nowMs,
		fireTurn: (prompt) =>
			Promise.resolve(
				handler(
					{ type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: { skills: [...DEFAULT_SKILLS] } },
					ctxOf(),
				),
			),
		runCmd: async (args) => {
			const cmd = pi.commands.get(DECISIONS_COMMAND) as {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			};
			notifies.length = 0;
			await cmd.handler(args, ctxOf() as unknown as ExtensionCommandContext);
			return [...notifies];
		},
		status: async () => "unused",
		snapshot: () => ({ active: [...toolState.active].sort(), model: `${modelState.current.provider}/${modelState.current.id}` }),
	};
}

describe("empty catalogue — tools question holds without priced surprises", () => {
	test("no tools in the catalogue holds tools and still decides tier+shadow in one call", async () => {
		const h = setup();
		h.toolState.all = [];
		await h.fireTurn("Fix the failing build in the deploy pipeline");
		expect(h.fetchCount()).toBe(1);
		const body = JSON.parse(h.fetchCalls[0]!.init.body) as { questions: Record<string, unknown> };
		expect(Object.keys(body.questions).sort()).toEqual(["needs_subagent", "skill", "tier"]);
		expect(h.setActiveToolsCalls).toHaveLength(0);
		expect(h.setModelCalls).toHaveLength(1);
		expect((await h.status())).toContain("empty-catalogue");
	});
});
