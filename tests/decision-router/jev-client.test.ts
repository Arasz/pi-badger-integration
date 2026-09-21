/**
 * Jev client tests for the decision-router core (plan v2 P1, rows A1–A15 + F5).
 *
 * Hermetic by construction: the classifier under test receives a stub fetchFn, a
 * manual scheduler, a fixed clock and an env record — no network, no wall clock,
 * no real timers. SYNTH error bodies live in `fixtures/jev-fixtures.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRoutingRequest,
	buildTierChoiceRequest,
	buildToolChoiceRequest,
	CACHE_MAX_ENTRIES,
	createFallbackClassifier,
	createJevClassifier,
	CRITERION_CHAR_CAP,
	DEMOTE_CONFIDENCE_GATE,
	JEV_ENDPOINT_DEFAULT,
	JEV_MODEL_DEFAULT,
	MIN_PROMPT_CHARS,
	PROMPT_CHAR_CAP,
	REQUEST_TIMEOUT_MS,
	RETRY_AFTER_CEIL_MS,
	RETRY_AFTER_FLOOR_MS,
	STATE_BYTE_BUDGET,
	TIER_CRITERIA,
	TOOL_CONFIDENCE_GATE,
	TOOL_PROB_FLOOR,
	UPGRADE_CONFIDENCE_GATE,
	type JevClassifierDeps,
	type JevFetchInit,
	type JevFetchResponse,
	type JevRequest,
} from "../../extensions/decision-router/decision-router-client.ts";
import {
	PAYOUT_RESPONSE,
	SYNTH_PAYMENT_REQUIRED_BODY,
	SYNTH_RATE_LIMITED_BODY,
	SYNTH_TRUNCATED_JSON,
	SYNTH_ERROR_ENVELOPE,
	SYNTH_UNAUTHORIZED_BODY,
} from "./fixtures/jev-fixtures.ts";

// ------------------------------------------------------------------ test doubles

interface RecordedCall {
	readonly url: string;
	readonly init: JevFetchInit;
}

interface StubState {
	readonly status: number;
	readonly headers?: Record<string, string>;
	readonly text: string;
	readonly never?: boolean;
	readonly throws?: unknown;
}

function stubResponding(state: StubState): { fetchFn: JevClassifierDeps["fetchFn"]; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchFn: JevClassifierDeps["fetchFn"] = (url, init) => {
		calls.push({ url, init });
		if (state.throws !== undefined) return Promise.reject(state.throws);
		if (state.never === true) return new Promise<JevFetchResponse>(() => {});
		const headers = state.headers ?? {};
		const lowered: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
		return Promise.resolve({
			status: state.status,
			headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null },
			text: () => Promise.resolve(state.text),
		});
	};
	return { fetchFn, calls };
}

interface ManualScheduler {
	readonly scheduler: JevClassifierDeps["scheduler"];
	fire(): number;
	pendingCount(): number;
	lastDelayMs(): number | undefined;
}

function makeManualScheduler(): ManualScheduler {
	const pending = new Map<unknown, () => void>();
	let seq = 0;
	let lastDelay: number | undefined;
	return {
		scheduler: {
			setTimeout: (handler: () => void, timeoutMs: number) => {
				seq += 1;
				pending.set(seq, handler);
				lastDelay = timeoutMs;
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
		lastDelayMs: () => lastDelay,
	};
}

const FIXED_NOW = 1_700_000_000_000;

function depsFor(
	stub: { fetchFn: JevClassifierDeps["fetchFn"] },
	manual: ManualScheduler,
	env: Record<string, string | undefined>,
): { deps: JevClassifierDeps; manual: ManualScheduler } {
	return { deps: { fetchFn: stub.fetchFn, scheduler: manual.scheduler, now: () => FIXED_NOW, env }, manual };
}

function toolRequest(): JevRequest {
	const built = buildToolChoiceRequest({
		task: "Fix the failing build",
		tools: [
			{ name: "read", description: "Read files" },
			{ name: "bash", description: "Run shell commands" },
		],
	});
	if (built.status !== "ok") throw new Error("expected ok build");
	return built.request;
}

// ------------------------------------------------------------------ frozen consts (F1 + P1 budgets)

describe("frozen consts match the plan (F1 + P1 budgets)", () => {
	test("thresholds, timeout, cache cap and budgets are the frozen values", () => {
		expect(TOOL_PROB_FLOOR).toBe(0.2);
		expect(TOOL_CONFIDENCE_GATE).toBe(0.7);
		expect(UPGRADE_CONFIDENCE_GATE).toBe(0.6);
		expect(DEMOTE_CONFIDENCE_GATE).toBe(0.85);
		expect(MIN_PROMPT_CHARS).toBe(12);
		expect(REQUEST_TIMEOUT_MS).toBe(2500);
		expect(CACHE_MAX_ENTRIES).toBe(50);
		expect(STATE_BYTE_BUDGET).toBe(8192);
		expect(PROMPT_CHAR_CAP).toBe(2000);
		expect(CRITERION_CHAR_CAP).toBe(200);
		expect(JEV_MODEL_DEFAULT).toBe("typesafe/jev-1.13");
		expect(JEV_ENDPOINT_DEFAULT).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(RETRY_AFTER_FLOOR_MS).toBe(60_000);
		expect(RETRY_AFTER_CEIL_MS).toBe(3_600_000);
	});
});

// ------------------------------------------------------------------ A1–A4 golden bodies

describe("A1 — tool-choice builder golden body", () => {
	test("names sorted, criteria mirror the catalogue, state carries task + tools", () => {
		expect(toolRequest()).toEqual({
			model: "typesafe/jev-1.13",
			state: {
				task: "Fix the failing build",
				tools: [
					{ name: "bash", description: "Run shell commands" },
					{ name: "read", description: "Read files" },
				],
			},
			questions: {
				tools: {
					type: "choice",
					instructions: "Which tools are needed for this task?",
					criteria: { bash: "Run shell commands", read: "Read files" },
				},
			},
		});
	});

	test("explicit model overrides the default", () => {
		const built = buildToolChoiceRequest({ task: "t", tools: [{ name: "bash", description: "d" }], model: "m" });
		if (built.status !== "ok") throw new Error("expected ok");
		expect(built.request.model).toBe("m");
	});
});

describe("A2 — tier-choice builder golden body", () => {
	test("fixed low/medium/high rubric over a task-only state", () => {
		expect(buildTierChoiceRequest({ task: "Rename x to y" })).toEqual({
			model: "typesafe/jev-1.13",
			state: { task: "Rename x to y" },
			questions: {
				tier: {
					type: "choice",
					instructions: "Which model tier is sufficient for this task?",
					criteria: { ...TIER_CRITERIA },
				},
			},
		});
		expect(TIER_CRITERIA).toEqual({
			low: "Mechanical, single-file or rename-level change",
			medium: "Multi-file change needing judgement",
			high: "Design, debugging, architecture",
		});
	});
});

describe("A3 — routing fan-out golden body", () => {
	test("skill choice plus needs_subagent noul, none always present", () => {
		expect(
			buildRoutingRequest({
				task: "Review this diff",
				skills: [
					{ name: "review", description: "Review code" },
					{ name: "deploy" },
				],
			}),
		).toEqual({
			model: "typesafe/jev-1.13",
			state: { task: "Review this diff" },
			questions: {
				skill: {
					type: "choice",
					instructions: "Which skill should handle this task?",
					criteria: { deploy: "", none: "No skill applies to this task", review: "Review code" },
				},
				needs_subagent: { type: "noul", instructions: "Does this task need a subagent?" },
			},
		});
	});
});

describe("A4 — requests carry exactly zero extra params", () => {
	test("top-level, state and question key sets are exact", () => {
		const request = toolRequest();
		expect(Object.keys(request).sort()).toEqual(["model", "questions", "state"]);
		expect(Object.keys(request.state).sort()).toEqual(["task", "tools"]);
		expect(Object.keys(request.questions)).toEqual(["tools"]);
		expect(Object.keys(request.questions["tools"]!).sort()).toEqual(["criteria", "instructions", "type"]);

		const tier = buildTierChoiceRequest({ task: "t" });
		expect(Object.keys(tier).sort()).toEqual(["model", "questions", "state"]);
		expect(Object.keys(tier.state)).toEqual(["task"]);

		const routing = buildRoutingRequest({ task: "t", skills: [] });
		expect(Object.keys(routing.questions).sort()).toEqual(["needs_subagent", "skill"]);
		expect(Object.keys(routing.questions["needs_subagent"]!).sort()).toEqual(["instructions", "type"]);
	});
});

// ------------------------------------------------------------------ A12/A14 truncation and guards

describe("A12 — 255-option build-time guard", () => {
	test("256 tools trip the count guard first; 255 never do; empty holds as empty-catalogue", () => {
		// Tiny names keep the state under budget, isolating the count guard from F5.
		// (With realistic names the 8 KB budget holds first — that interaction is F5's row.)
		const tiny = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ name: `n${i.toString(36)}`, description: "" }));
		expect(buildToolChoiceRequest({ task: "t", tools: tiny(256) })).toMatchObject({
			status: "hold",
			reason: "too-many-options",
		});
		const atMax = buildToolChoiceRequest({ task: "t", tools: tiny(255) });
		if (atMax.status === "hold") expect(atMax.reason).not.toBe("too-many-options");
		else expect(atMax.status).toBe("ok");
		expect(buildToolChoiceRequest({ task: "t", tools: [] })).toMatchObject({
			status: "hold",
			reason: "empty-catalogue",
		});
	});
});

describe("A14 — prompt and criterion caps truncate", () => {
	test("a 2500-char prompt truncates to exactly 2000 chars", () => {
		const built = buildToolChoiceRequest({ task: "x".repeat(2500), tools: [{ name: "bash", description: "d" }] });
		if (built.status !== "ok") throw new Error("expected ok");
		expect(built.request.state.task).toBe("x".repeat(2000));
	});

	test("a 300-char description truncates to exactly 200 chars", () => {
		const built = buildToolChoiceRequest({ task: "t", tools: [{ name: "bash", description: "y".repeat(300) }] });
		if (built.status !== "ok") throw new Error("expected ok");
		const question = built.request.questions["tools"];
		if (question?.type !== "choice") throw new Error("expected choice");
		expect(question.criteria?.["bash"]).toBe("y".repeat(200));
	});
});

describe("F5 — catalogue cap: sorted names, uniform truncation, typed hold", () => {
	test("over-budget descriptions shrink uniformly and every name survives sorted", () => {
		const tools = Array.from({ length: 40 }, (_, i) => ({
			name: `tool-${String(i).padStart(2, "0")}`,
			description: "d".repeat(200),
		}));
		const built = buildToolChoiceRequest({ task: "t", tools });
		if (built.status !== "ok") throw new Error("expected ok under truncation");
		const question = built.request.questions["tools"];
		if (question?.type !== "choice") throw new Error("expected choice");
		const criteria = question.criteria ?? {};
		const names = Object.keys(criteria);
		expect(names).toEqual([...names].sort());
		expect(names).toHaveLength(40);
		const lengths = new Set(Object.values(criteria).map((d) => d.length));
		expect(lengths.size).toBe(1); // uniform: every description truncated to the same length
		expect([...lengths][0]).toBeLessThan(200);
		const stateBytes = new TextEncoder().encode(JSON.stringify(built.request.state)).length;
		expect(stateBytes).toBeLessThanOrEqual(8192);
	});

	test("names alone over budget hold as catalogue-over-budget, never a silent drop", () => {
		const tools = Array.from({ length: 100 }, (_, i) => ({
			name: `tool-with-a-very-long-name-${"n".repeat(90)}-${i}`,
			description: "",
		}));
		const built = buildToolChoiceRequest({ task: "t", tools });
		expect(built).toMatchObject({ status: "hold", reason: "catalogue-over-budget" });
	});
});

// ------------------------------------------------------------------ A5/A7–A10 error mapping

describe("A5 — missing or empty key fails before any fetch", () => {
	test.each(["missing", "empty", "blank"])("%s key → missing-key with zero fetch calls", async (kind) => {
		const stub = stubResponding({ status: 200, text: JSON.stringify(PAYOUT_RESPONSE) });
		const manual = makeManualScheduler();
		const env =
			kind === "missing"
				? {}
				: kind === "empty"
					? { OPENROUTER_API_KEY: "" }
					: { OPENROUTER_API_KEY: "   " };
		const { deps } = depsFor(stub, manual, env);
		const outcome = await createJevClassifier(deps).classify(toolRequest());
		expect(outcome).toMatchObject({ status: "error", kind: "missing-key" });
		expect(stub.calls).toHaveLength(0);
		expect(manual.pendingCount()).toBe(0);
	});
});

describe("A7–A10 — HTTP status maps to distinct error kinds", () => {
	test("401 → auth", async () => {
		const stub = stubResponding({ status: 401, text: SYNTH_UNAUTHORIZED_BODY });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
			status: "error",
			kind: "auth",
		});
	});

	test("402 → billing", async () => {
		const stub = stubResponding({ status: 402, text: SYNTH_PAYMENT_REQUIRED_BODY });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
			status: "error",
			kind: "billing",
		});
	});

	test("500 → server", async () => {
		const stub = stubResponding({ status: 500, text: "upstream exploded" });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
			status: "error",
			kind: "server",
		});
	});

	test("400 → misrouted-refusal with a fixed string that echoes no body", async () => {
		const stub = stubResponding({ status: 400, text: "SECRET-BODY-MARKER" });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		const outcome = await createJevClassifier(deps).classify(toolRequest());
		expect(outcome).toMatchObject({ status: "error", kind: "misrouted-refusal" });
		if (outcome.status !== "error") throw new Error("expected error");
		expect(outcome.detail).not.toContain("SECRET-BODY-MARKER");
	});
});

describe("A13 — 429 arms a clamped Retry-After cooldown", () => {
	test.each([
		["5", 60_000],
		["120", 120_000],
		["7200", 3_600_000],
	] as Array<[string, number]>)("retry-after %ss → retryAfterMs %d", async (header, expected) => {
		const stub = stubResponding({ status: 429, headers: { "retry-after": header }, text: SYNTH_RATE_LIMITED_BODY });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toEqual({
			status: "error",
			kind: "rate-limited",
			retryAfterMs: expected,
			detail: expect.any(String),
		});
	});

	test("missing or garbage header falls back to the 60 s floor", async () => {
		for (const headers of [undefined, { "retry-after": "soon" }]) {
			const stub = stubResponding({ status: 429, headers, text: SYNTH_RATE_LIMITED_BODY });
			const manual = makeManualScheduler();
			const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
			expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
				status: "error",
				kind: "rate-limited",
				retryAfterMs: 60_000,
			});
		}
	});
});

describe("A15 — timeout env sanitizes to the frozen default", () => {
	test.each([["0"], ["-1"], ["not-a-number"], [""], ["Infinity"]] as Array<[string]>)(
		"timeout %p → scheduler armed at 2500 ms",
		async ([raw]) => {
			const stub = stubResponding({ status: 200, text: "", never: true });
			const manual = makeManualScheduler();
			const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k", PI_BADGER_JEV_TIMEOUT_MS: raw });
			const pending = createJevClassifier(deps).classify(toolRequest());
			expect(manual.lastDelayMs()).toBe(2500);
			manual.fire();
			expect(await pending).toMatchObject({ status: "error", kind: "transport-timeout" });
		},
	);

	test("an explicit timeout is honored", async () => {
		const stub = stubResponding({ status: 200, text: "", never: true });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k", PI_BADGER_JEV_TIMEOUT_MS: "5000" });
		const pending = createJevClassifier(deps).classify(toolRequest());
		expect(manual.lastDelayMs()).toBe(5000);
		manual.fire();
		expect(await pending).toMatchObject({ status: "error", kind: "transport-timeout" });
	});
});

// ------------------------------------------------------------------ decided + malformed + transport paths

describe("decided path — 200 with a measured body", () => {
	test("billing decision arrives with the exact three-param wire body and bearer auth", async () => {
		const stub = stubResponding({ status: 200, text: JSON.stringify(PAYOUT_RESPONSE) });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "live-key" });
		const outcome = await createJevClassifier(deps).classify(toolRequest());
		expect(outcome.status).toBe("decided");
		if (outcome.status !== "decided") throw new Error("expected decided");
		const answer = outcome.response.answers["tools"];
		expect(answer?.status).toBe("reject"); // tools spec vs department body: mis-keyed, per-question
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
		const sent = JSON.parse(stub.calls[0]?.init.body ?? "{}") as Record<string, unknown>;
		expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
		expect(stub.calls[0]?.init.headers["Authorization"]).toBe("Bearer live-key");
		expect(manual.pendingCount()).toBe(0); // deadline cleared after settle
	});

	test("a matching spec decides with the winner intact", async () => {
		const stub = stubResponding({ status: 200, text: JSON.stringify(PAYOUT_RESPONSE) });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		const request: JevRequest = {
			model: "typesafe/jev-1.13",
			state: { task: "My payout has failed three days in a row." },
			questions: {
				department: {
					type: "choice",
					instructions: "Which team should handle this message?",
					criteria: { billing: "Payments", technical: "Bugs", sales: "Pricing" },
				},
			},
		};
		const outcome = await createJevClassifier(deps).classify(request);
		expect(outcome.status).toBe("decided");
		if (outcome.status !== "decided") throw new Error("expected decided");
		expect(outcome.response.answers["department"]).toMatchObject({
			status: "ok",
			answer: { type: "choice", choice: "billing", confidence: 0.99 },
		});
	});
});

describe("malformed and transport failures", () => {
	test("bad JSON on a 200 → malformed", async () => {
		const stub = stubResponding({ status: 200, text: SYNTH_TRUNCATED_JSON });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
			status: "error",
			kind: "malformed",
		});
	});

	test("a 200 error envelope → server", async () => {
		const stub = stubResponding({ status: 200, text: SYNTH_ERROR_ENVELOPE });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
			status: "error",
			kind: "server",
		});
	});

	test("a throwing fetch → transport-timeout", async () => {
		const stub = stubResponding({ status: 200, text: "", throws: new Error("socket hang up") });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		expect(await createJevClassifier(deps).classify(toolRequest())).toMatchObject({
			status: "error",
			kind: "transport-timeout",
		});
	});
});

// ------------------------------------------------------------------ A11 rewritten timeout

describe("A11 — never-resolving fetch settles on the injected deadline (no real sleep)", () => {
	test("the deadline aborts the signal and returns typed transport-timeout", async () => {
		const stub = stubResponding({ status: 200, text: "", never: true });
		const manual = makeManualScheduler();
		const { deps } = depsFor(stub, manual, { OPENROUTER_API_KEY: "k" });
		const pending = createJevClassifier(deps).classify(toolRequest());
		expect(manual.pendingCount()).toBe(1);
		expect(manual.lastDelayMs()).toBe(2500);
		expect(manual.fire()).toBe(1);
		const outcome = await pending;
		expect(outcome).toMatchObject({ status: "error", kind: "transport-timeout" });
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.init.signal.aborted).toBe(true);
		expect(manual.pendingCount()).toBe(0);
	});
});

// ------------------------------------------------------------------ A6 fallback classifier

describe("A6 — deterministic fallback classifier", () => {
	test("keyword tool match is bounded, tier holds, route is none", () => {
		const fallback = createFallbackClassifier();
		const decision = fallback.classify("Why does the build fail? Check with bash and read the log", [
			"bash",
			"read",
			"grep",
			"write",
		]);
		expect(decision.tools).toEqual({ status: "ok", names: ["bash", "read"] });
		expect(decision.tier).toEqual({ status: "hold", reason: "fallback-tier-hold" });
		expect(decision.route).toEqual({ choice: "none", confidence: 0 });
	});

	test("no keyword match and empty tasks hold without touching the network", () => {
		const fallback = createFallbackClassifier();
		expect(fallback.classify("zzzz unrelated", ["bash"]).tools).toMatchObject({ status: "hold" });
		expect(fallback.classify("", ["bash"]).tools).toMatchObject({ status: "hold" });
		expect(fallback.classify("   ", ["bash"]).tools).toMatchObject({ status: "hold" });
	});

	test("substring false friends do not match (already ≠ read)", () => {
		const fallback = createFallbackClassifier();
		expect(fallback.classify("this already happened", ["read"]).tools).toMatchObject({ status: "hold" });
	});

	test("matches are bounded to the newest five sorted names", () => {
		const fallback = createFallbackClassifier();
		const tools = ["zeta", "bash", "alpha", "read", "grep", "edit", "write", "delta"];
		const decision = fallback.classify("use bash read grep edit write zeta alpha delta", tools);
		expect(decision.tools).toEqual({ status: "ok", names: ["alpha", "bash", "delta", "edit", "grep"] });
	});
});

// ------------------------------------------------------------------ banned tokens (F11)

describe("client + core stay I/O-free (F11 banned tokens cover both per F25)", () => {
	test("no process.env, globalThis.fetch, bare fetch(, Date.now( outside injection points", () => {
		for (const file of ["decision-router-client.ts", "decision-router-core.ts"]) {
			const source = readFileSync(join(import.meta.dir, "..", "..", "extensions", "decision-router", file), "utf8");
			expect(source).not.toContain("process.env");
			expect(source).not.toContain("globalThis.fetch");
			expect(source).not.toContain("Date.now(");
			expect(source).not.toMatch(/(?<![A-Za-z0-9_$])fetch\(/);
			const withoutInjectionPoints = source
				.replaceAll("scheduler.setTimeout(", "")
				.replace("setTimeout(handler: () => void, timeoutMs: number): unknown;", "");
			expect(withoutInjectionPoints).not.toContain("setTimeout(");
		}
	});
});
