/**
 * Policy tests for the decision-router core (plan v2 P2, rows C-S/C-T/C-M/C-R).
 *
 * Pure by construction: every row drives `evaluateTurn` / `decideTools` /
 * `decideTier` / `decideRouting` / `decidePolicies` with stub answers, an env
 * record, an injected clock and predicate stubs — no fetch, no pi, no timers.
 * Measured behaviour pins against `fixtures/jev-fixtures.ts` (raw-05 tier,
 * api500 department); run-specific plan numbers are never used.
 */

import { describe, expect, test } from "bun:test";
import {
	DECISION_ROUTER_ENV,
	DECISION_ROUTER_MODEL_ENV,
	DECISION_ROUTER_ROUTING_ENV,
	DECISION_ROUTER_TOOLS_ENV,
	TIER_TO_THINKING,
} from "../../extensions/decision-router/decision-router-core.ts";
import {
	createFallbackClassifier,
	parseJevResponseBody,
	type AnswerParse,
} from "../../extensions/decision-router/decision-router-client.ts";
import {
	decidePolicies,
	decideRouting,
	decideTier,
	decideTools,
	evaluateTurn,
	isCapabilityEnabled,
	isCoolingDown,
	isShortPrompt,
	isSlashPrefixed,
	keyOf,
	type SkipReason,
	type TurnContext,
	type TurnDecision,
} from "../../extensions/decision-router/decision-router-core.ts";
import { API500_RESPONSE, MODEL_TIER_RESPONSE } from "./fixtures/jev-fixtures.ts";

// ------------------------------------------------------------------ helpers

function choiceAnswer(
	choice: string,
	probabilities: Record<string, number>,
	confidence: number,
): AnswerParse {
	return { status: "ok", answer: { type: "choice", choice, probabilities, confidence } };
}

const BASE_ENV = { OPENROUTER_API_KEY: "test-key" };

function baseTurn(overrides: Partial<TurnContext> = {}): TurnContext {
	return {
		prompt: "Fix the failing build in the deploy pipeline",
		promptHash: "ph",
		catalogueHash: "ch",
		modelId: "model-m",
		env: { ...BASE_ENV },
		sessionDecisionsOn: true,
		cooldownUntilMs: 0,
		nowMs: 1000,
		inFlight: false,
		cacheKeys: new Set<string>(),
		isMarkerPrefixed: () => false,
		...overrides,
	};
}

function proceedKey(ctx: TurnContext): string {
	return keyOf({ promptHash: ctx.promptHash, catalogueHash: ctx.catalogueHash, modelId: ctx.modelId });
}

const CATALOGUE = ["bash", "read", "grep"];

const TIER_MODELS = { low: "tier-low-model", medium: "tier-medium-model", high: "tier-high-model" } as const;

// --------------------------------------------------------------- C-S skip chain

describe("C-S1 — master kill switch skips with zero priced work", () => {
	test("PI_BADGER_DECISION_ROUTER=0 → skip master-kill", () => {
		expect(evaluateTurn(baseTurn({ env: { ...BASE_ENV, [DECISION_ROUTER_ENV]: "0" } }))).toEqual({
			status: "skip",
			reason: "master-kill",
		});
	});

	test("only the literal \"0\" kills; \"off\"/\"false\"/\"1\" proceed", () => {
		for (const value of ["off", "false", "1", ""]) {
			const decision = evaluateTurn(baseTurn({ env: { ...BASE_ENV, [DECISION_ROUTER_ENV]: value } }));
			expect(decision).toMatchObject({ status: "proceed" });
		}
	});
});

describe("C-S1b — defensive slash-prefix skip for unknown commands (F3)", () => {
	test("any slash-prefixed prompt skips, even a long one", () => {
		expect(evaluateTurn(baseTurn({ prompt: "/nope-not-a-command do stuff here please" }))).toEqual({
			status: "skip",
			reason: "slash-prefixed",
		});
	});

	test("isSlashPrefixed is a strict first-character check", () => {
		expect(isSlashPrefixed("/decisions status")).toBe(true);
		expect(isSlashPrefixed("/")).toBe(true);
		expect(isSlashPrefixed("Fix the build")).toBe(false);
		expect(isSlashPrefixed("")).toBe(false);
		expect(isSlashPrefixed(" use /decisions later")).toBe(false);
	});
});

describe("C-S2 — missing key skips before any priced work", () => {
	test.each(["absent", "empty", "blank"] as const)("%s key → skip missing-key", (kind) => {
		const env =
			kind === "absent" ? {} : kind === "empty" ? { OPENROUTER_API_KEY: "" } : { OPENROUTER_API_KEY: "   " };
		expect(evaluateTurn(baseTurn({ env }))).toEqual({ status: "skip", reason: "missing-key" });
	});

	test("a present key proceeds past the key gate", () => {
		expect(evaluateTurn(baseTurn())).toMatchObject({ status: "proceed" });
	});
});

describe("C-S5 — marker prefix skips via the injected predicate", () => {
	test("isMarkerPrefixed true → skip marker-prefixed", () => {
		expect(evaluateTurn(baseTurn({ isMarkerPrefixed: () => true }))).toEqual({
			status: "skip",
			reason: "marker-prefixed",
		});
	});

	test("the prompt is passed through to the predicate untouched", () => {
		const seen: string[] = [];
		const prompt = "Fix the failing build in the deploy pipeline";
		evaluateTurn(
			baseTurn({
				isMarkerPrefixed: (p) => {
					seen.push(p);
					return false;
				},
			}),
		);
		expect(seen).toEqual([prompt]);
	});
});

describe("C-S6 — short prompts skip below 12 non-whitespace chars", () => {
	test("isShortPrompt counts non-whitespace only", () => {
		expect(isShortPrompt("fix it")).toBe(true);
		expect(isShortPrompt("abcdefghijk")).toBe(true); // 11
		expect(isShortPrompt("abcdefghijkl")).toBe(false); // 12
		expect(isShortPrompt("  fix   the   build   now  ")).toBe(false); // 14 non-ws
		expect(isShortPrompt("   ")).toBe(true);
	});

	test("an 11-char prompt skips; a 12-char prompt proceeds", () => {
		expect(evaluateTurn(baseTurn({ prompt: "abcdefghijk" }))).toEqual({
			status: "skip",
			reason: "short-prompt",
		});
		expect(evaluateTurn(baseTurn({ prompt: "abcdefghijkl" }))).toMatchObject({ status: "proceed" });
	});
});

describe("C-S7 — in-flight turns skip", () => {
	test("inFlight true → skip in-flight", () => {
		expect(evaluateTurn(baseTurn({ inFlight: true }))).toEqual({ status: "skip", reason: "in-flight" });
	});
});

describe("R10 order — the first hit in chain order wins", () => {
	test("kill > key > cooldown > slash > marker > short > in-flight > cache", () => {
		const ctx = baseTurn();
		const key = proceedKey(ctx);
		const reasonOf = (candidate: TurnContext): SkipReason => {
			const decision = evaluateTurn(candidate);
			expect(decision.status).toBe("skip");
			if (decision.status !== "skip") throw new Error("expected skip");
			return decision.reason;
		};
		// Each pair arms two gates; the earlier in R10 order must win.
		expect(
			reasonOf(baseTurn({ env: { [DECISION_ROUTER_ENV]: "0" }, cooldownUntilMs: 5000, nowMs: 1000 })),
		).toBe("master-kill"); // kill beats key
		expect(reasonOf(baseTurn({ env: {}, cooldownUntilMs: 5000 }))).toBe("missing-key"); // key beats cooldown
		expect(reasonOf(baseTurn({ prompt: "/x", cooldownUntilMs: 5000, nowMs: 1000 }))).toBe(
			"cooldown",
		); // cooldown beats slash
		expect(reasonOf(baseTurn({ prompt: "/x", isMarkerPrefixed: () => true }))).toBe(
			"slash-prefixed",
		); // slash beats marker
		expect(reasonOf(baseTurn({ prompt: "tiny", isMarkerPrefixed: () => true }))).toBe(
			"marker-prefixed",
		); // marker beats short
		expect(reasonOf(baseTurn({ prompt: "tiny", inFlight: true }))).toBe("short-prompt"); // short beats in-flight
		expect(reasonOf(baseTurn({ inFlight: true, cacheKeys: new Set([key]) }))).toBe(
			"in-flight",
		); // in-flight beats cache
		expect(evaluateTurn(baseTurn({ cacheKeys: new Set([key]) }))).toEqual({
			status: "skip",
			reason: "cache-hit",
		});
		expect(key).toBe(proceedKey(ctx));
	});
});

describe("C-S9 — kill precedence matrix (F10: per-cap > master > session; on never lifts a kill)", () => {
	test("master=0 kills even with session on and per-caps on", () => {
		const env = {
			...BASE_ENV,
			[DECISION_ROUTER_ENV]: "0",
			[DECISION_ROUTER_TOOLS_ENV]: "1",
			[DECISION_ROUTER_MODEL_ENV]: "1",
			[DECISION_ROUTER_ROUTING_ENV]: "1",
		};
		expect(evaluateTurn(baseTurn({ env, sessionDecisionsOn: true }))).toEqual({
			status: "skip",
			reason: "master-kill",
		});
	});

	test("a single per-cap kill narrows the fan-out instead of skipping the turn", () => {
		const decision = evaluateTurn(
			baseTurn({ env: { ...BASE_ENV, [DECISION_ROUTER_TOOLS_ENV]: "0" } }),
		);
		expect(decision).toEqual({
			status: "proceed",
			key: proceedKey(baseTurn()),
			enabled: { tools: false, model: true, routing: true },
		});
	});

	test("all three per-caps killed → skip with the first per-cap reason (F10 order)", () => {
		const env = {
			...BASE_ENV,
			[DECISION_ROUTER_TOOLS_ENV]: "0",
			[DECISION_ROUTER_MODEL_ENV]: "0",
			[DECISION_ROUTER_ROUTING_ENV]: "0",
		};
		expect(evaluateTurn(baseTurn({ env }))).toEqual({ status: "skip", reason: "tools-kill" });
	});

	test("per-cap kill wins over master kill in the reason (F10 literal order)", () => {
		const env = { ...BASE_ENV, [DECISION_ROUTER_ENV]: "0", [DECISION_ROUTER_TOOLS_ENV]: "0" };
		expect(evaluateTurn(baseTurn({ env }))).toEqual({ status: "skip", reason: "tools-kill" });
	});

	test("session off skips an otherwise enabled turn; kills still come first", () => {
		expect(evaluateTurn(baseTurn({ sessionDecisionsOn: false }))).toEqual({
			status: "skip",
			reason: "session-off",
		});
		expect(
			evaluateTurn(
				baseTurn({ sessionDecisionsOn: false, env: { ...BASE_ENV, [DECISION_ROUTER_ENV]: "0" } }),
			),
		).toEqual({ status: "skip", reason: "master-kill" });
	});

	test("isCapabilityEnabled folds per-cap, master and session (D13b analogue)", () => {
		expect(isCapabilityEnabled({ ...BASE_ENV }, true, "tools")).toBe(true);
		expect(isCapabilityEnabled({ ...BASE_ENV, [DECISION_ROUTER_TOOLS_ENV]: "0" }, true, "tools")).toBe(false);
		expect(isCapabilityEnabled({ ...BASE_ENV, [DECISION_ROUTER_ENV]: "0" }, true, "tools")).toBe(false);
		expect(isCapabilityEnabled({ ...BASE_ENV }, false, "tools")).toBe(false);
		// Session "on" never lifts an env kill.
		expect(
			isCapabilityEnabled({ ...BASE_ENV, [DECISION_ROUTER_ENV]: "0" }, true, "model"),
		).toBe(false);
		// Kills are per-capability: killing tools leaves model enabled.
		expect(
			isCapabilityEnabled({ ...BASE_ENV, [DECISION_ROUTER_TOOLS_ENV]: "0" }, true, "model"),
		).toBe(true);
	});
});

describe("C-S3a / C-S4a — pure skip-reason rows (no fetch counting; that is D24 wiring)", () => {
	test("C-S3a: an armed cooldown skips; an expired one proceeds", () => {
		expect(evaluateTurn(baseTurn({ cooldownUntilMs: 5000, nowMs: 1000 }))).toEqual({
			status: "skip",
			reason: "cooldown",
		});
		expect(evaluateTurn(baseTurn({ cooldownUntilMs: 5000, nowMs: 5000 }))).toMatchObject({
			status: "proceed",
		});
		expect(isCoolingDown(999, 5000)).toBe(true);
		expect(isCoolingDown(5000, 5000)).toBe(false);
	});

	test("C-S4a: a cached key skips; a key miss proceeds with the computed key", () => {
		const ctx = baseTurn();
		const key = proceedKey(ctx);
		expect(evaluateTurn(baseTurn({ cacheKeys: new Set([key]) }))).toEqual({
			status: "skip",
			reason: "cache-hit",
		});
		const miss = evaluateTurn(baseTurn({ cacheKeys: new Set(["other"]) }));
		expect(miss).toEqual({
			status: "proceed",
			key,
			enabled: { tools: true, model: true, routing: true },
		});
	});
});

describe("C-S8 — keyOf names every dependency (prompt, catalogue, model)", () => {
	test("equal inputs give equal keys", () => {
		const input = { promptHash: "p", catalogueHash: "c", modelId: "m" };
		expect(keyOf(input)).toBe(keyOf({ ...input }));
		expect(typeof keyOf(input)).toBe("string");
	});

	test("each dimension alone flips the key", () => {
		const base = { promptHash: "p", catalogueHash: "c", modelId: "m" };
		const key = keyOf(base);
		expect(keyOf({ ...base, promptHash: "p2" })).not.toBe(key);
		expect(keyOf({ ...base, catalogueHash: "c2" })).not.toBe(key);
		expect(keyOf({ ...base, modelId: "m2" })).not.toBe(key);
	});
});

// --------------------------------------------------------------- C-T tool subset

describe("C-T1 — probability floor 0.2 both directions (±ε)", () => {
	test("0.199 excluded; 0.2 and 0.201 included", () => {
		const below = decideTools({
			answer: choiceAnswer("bash", { bash: 0.9, grep: 0.199 }, 0.9),
			catalogue: CATALOGUE,
			activeTools: [],
			enabled: true,
		});
		expect(below).toEqual({ status: "actuate", enable: ["bash"] });
		for (const prob of [0.2, 0.201]) {
			expect(
				decideTools({
					answer: choiceAnswer("bash", { bash: 0.9, grep: prob }, 0.9),
					catalogue: CATALOGUE,
					activeTools: [],
					enabled: true,
				}),
			).toEqual({ status: "actuate", enable: ["bash", "grep"] });
		}
	});
});

describe("C-T2 / C-T3 — confidence gate boundaries", () => {
	test("0.69 holds; exactly 0.7 actuates (gate inclusive)", () => {
		const vector = { bash: 0.9, read: 0.05 };
		expect(
			decideTools({ answer: choiceAnswer("bash", vector, 0.69), catalogue: CATALOGUE, activeTools: [], enabled: true }),
		).toEqual({ status: "hold", reason: "low-confidence" });
		expect(
			decideTools({ answer: choiceAnswer("bash", vector, 0.7), catalogue: CATALOGUE, activeTools: [], enabled: true }),
		).toEqual({ status: "actuate", enable: ["bash"] });
	});
});

describe("C-T4 — additive enable set plus already-enabled skip (F13)", () => {
	test("enabled = active ∪ {p ≥ 0.2}, sorted", () => {
		expect(
			decideTools({
				answer: choiceAnswer("bash", { bash: 0.9, read: 0.8, grep: 0.05 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: ["read"],
				enabled: true,
			}),
		).toEqual({ status: "actuate", enable: ["bash", "read"] });
	});

	test("subset ⊆ active → hold already-enabled", () => {
		expect(
			decideTools({
				answer: choiceAnswer("bash", { bash: 0.9 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: ["bash", "read"],
				enabled: true,
			}),
		).toEqual({ status: "hold", reason: "already-enabled" });
	});
});

describe("C-T4b — ghost winner rejects the whole question (F6)", () => {
	test("winning delegate at conf 0.9 with bash 0.90 in probs → hold unknown-choice, no partial actuation", () => {
		expect(
			decideTools({
				answer: choiceAnswer("delegate", { delegate: 0.9, bash: 0.9, read: 0.05 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: [],
				enabled: true,
			}),
		).toEqual({ status: "hold", reason: "unknown-choice" });
	});
});

describe("C-T5 — catalogue filter applies to non-winner probabilities only", () => {
	test("a ghost non-winner at 0.95 is ignored; the known subset still actuates", () => {
		expect(
			decideTools({
				answer: choiceAnswer("bash", { bash: 0.9, ghosttool: 0.95 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: [],
				enabled: true,
			}),
		).toEqual({ status: "actuate", enable: ["bash"] });
	});
});

describe("C-T6 — frozen gate pair 0.69 hold / 0.71 actuate on the same vector", () => {
	const vector = { bash: 0.85, grep: 0.3, read: 0.1 };

	test("conf 0.69 → hold low-confidence", () => {
		expect(
			decideTools({ answer: choiceAnswer("bash", vector, 0.69), catalogue: CATALOGUE, activeTools: [], enabled: true }),
		).toEqual({ status: "hold", reason: "low-confidence" });
	});

	test("conf 0.71 → actuate the floor-filtered subset", () => {
		expect(
			decideTools({ answer: choiceAnswer("bash", vector, 0.71), catalogue: CATALOGUE, activeTools: [], enabled: true }),
		).toEqual({ status: "actuate", enable: ["bash", "grep"] });
	});
});

describe("tool edge cases — strict R7 reading, rejects, disabled", () => {
	test("the winner is NOT force-included: winner prob 0.1 stays out while grep 0.5 actuates", () => {
		expect(
			decideTools({
				answer: choiceAnswer("bash", { bash: 0.1, grep: 0.5 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: [],
				enabled: true,
			}),
		).toEqual({ status: "actuate", enable: ["grep"] });
	});

	test("every prob below the floor → hold empty-subset", () => {
		expect(
			decideTools({
				answer: choiceAnswer("bash", { bash: 0.1, grep: 0.05 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: [],
				enabled: true,
			}),
		).toEqual({ status: "hold", reason: "empty-subset" });
	});

	test("reject / missing / noul answers → hold answer-reject", () => {
		const reject: AnswerParse = { status: "reject", reason: "unknown-choice", detail: "ghost" };
		for (const answer of [reject, undefined, { status: "ok", answer: { type: "noul", noul: 0.5 } } as AnswerParse]) {
			expect(decideTools({ answer, catalogue: CATALOGUE, activeTools: [], enabled: true })).toEqual({
				status: "hold",
				reason: "answer-reject",
			});
		}
	});

	test("disabled capability → hold capability-killed without reading the answer", () => {
		expect(
			decideTools({
				answer: choiceAnswer("bash", { bash: 0.9 }, 0.9),
				catalogue: CATALOGUE,
				activeTools: [],
				enabled: false,
			}),
		).toEqual({ status: "hold", reason: "capability-killed" });
	});
});

// --------------------------------------------------------------- C-M tier asymmetry

describe("C-M1 / C-M2 — upgrade and demote actuate with target model + thinking", () => {
	test("high at conf 0.9 upgrades to the high model with high thinking", () => {
		expect(
			decideTier({
				answer: choiceAnswer("high", { high: 0.9, medium: 0.1, low: 0 }, 0.9),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({
			status: "actuate",
			direction: "upgrade",
			targetModel: TIER_MODELS.high,
			thinking: "high",
		});
	});

	test("low at conf 0.9 demotes to the low model with low thinking", () => {
		expect(
			decideTier({
				answer: choiceAnswer("low", { low: 0.9, medium: 0.1, high: 0 }, 0.9),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({
			status: "actuate",
			direction: "demote",
			targetModel: TIER_MODELS.low,
			thinking: "low",
		});
	});
});

describe("C-M3 — F7 regression: committed raw-05 (medium 0.79/0.21, conf 0.69) never demotes", () => {
	test("the measured tier body holds neutral-tier", () => {
		const parsed = parseJevResponseBody(JSON.stringify(MODEL_TIER_RESPONSE), {
			questions: { tier: { type: "choice", options: ["low", "medium", "high"] } },
		});
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		const answer = parsed.answers["tier"];
		if (answer?.status !== "ok") throw new Error("expected ok tier answer");
		expect(answer.answer).toMatchObject({ type: "choice", choice: "medium", confidence: 0.69 });
		expect(
			decideTier({ answer, currentModel: TIER_MODELS.high, tierModels: TIER_MODELS, upgradesLatched: false }),
		).toEqual({ status: "hold", reason: "neutral-tier" });
	});
});

describe("C-M4 — demotion needs BOTH cheap-tier choice AND gate (exact oracles)", () => {
	test("low choice below gate → hold below-gate", () => {
		expect(
			decideTier({
				answer: choiceAnswer("low", { low: 0.5, medium: 0.4, high: 0.1 }, 0.5),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "below-gate" });
	});

	test("non-cheap choice above gate → hold neutral-tier (choice alone never demotes)", () => {
		expect(
			decideTier({
				answer: choiceAnswer("medium", { medium: 0.99, low: 0.01, high: 0 }, 0.99),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "neutral-tier" });
	});

	test("low choice above gate → demote", () => {
		expect(
			decideTier({
				answer: choiceAnswer("low", { low: 0.86, medium: 0.14, high: 0 }, 0.86),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({
			status: "actuate",
			direction: "demote",
			targetModel: TIER_MODELS.low,
			thinking: "low",
		});
	});
});

describe("C-M5 — malformed or missing tier answers hold", () => {
	test("reject / missing / noul → hold answer-reject", () => {
		const reject: AnswerParse = { status: "reject", reason: "mis-keyed", detail: "absent" };
		for (const answer of [reject, undefined, { status: "ok", answer: { type: "noul", noul: 0.5 } } as AnswerParse]) {
			expect(
				decideTier({ answer, currentModel: TIER_MODELS.high, tierModels: TIER_MODELS, upgradesLatched: false }),
			).toEqual({ status: "hold", reason: "answer-reject" });
		}
	});

	test("an off-rubric choice string holds neutral-tier", () => {
		expect(
			decideTier({
				answer: choiceAnswer("ultra", { ultra: 1 }, 0.99),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "neutral-tier" });
	});
});

describe("C-M6 — demote boundary 0.84 hold / 0.86 demote", () => {
	const vector = { low: 0.85, medium: 0.15, high: 0 };

	test("conf 0.84 → hold below-gate", () => {
		expect(
			decideTier({
				answer: choiceAnswer("low", vector, 0.84),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "below-gate" });
	});

	test("conf 0.86 → demote", () => {
		expect(
			decideTier({
				answer: choiceAnswer("low", vector, 0.86),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({
			status: "actuate",
			direction: "demote",
			targetModel: TIER_MODELS.low,
			thinking: "low",
		});
	});
});

describe("C-M7 — upgrade boundary 0.59 hold / 0.61 upgrade", () => {
	const vector = { high: 0.6, medium: 0.3, low: 0.1 };

	test("conf 0.59 → hold below-gate", () => {
		expect(
			decideTier({
				answer: choiceAnswer("high", vector, 0.59),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "below-gate" });
	});

	test("conf 0.61 → upgrade", () => {
		expect(
			decideTier({
				answer: choiceAnswer("high", vector, 0.61),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({
			status: "actuate",
			direction: "upgrade",
			targetModel: TIER_MODELS.high,
			thinking: "high",
		});
	});
});

describe("B5 (qa-F5) — tier gates are inclusive at the exact threshold", () => {
	test("upgrade at exactly 0.6 actuates; 0.599 holds", () => {
		const actuate = decideTier({
			answer: choiceAnswer("high", { high: 0.6, medium: 0.3, low: 0.1 }, 0.6),
			currentModel: TIER_MODELS.low,
			tierModels: TIER_MODELS,
			upgradesLatched: false,
		});
		expect(actuate).toEqual({
			status: "actuate",
			direction: "upgrade",
			targetModel: TIER_MODELS.high,
			thinking: "high",
		});
		expect(
			decideTier({
				answer: choiceAnswer("high", { high: 0.6, medium: 0.3, low: 0.1 }, 0.599),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "below-gate" });
	});

	test("demote at exactly 0.85 actuates; 0.849 holds", () => {
		const actuate = decideTier({
			answer: choiceAnswer("low", { low: 0.85, medium: 0.15, high: 0 }, 0.85),
			currentModel: TIER_MODELS.high,
			tierModels: TIER_MODELS,
			upgradesLatched: false,
		});
		expect(actuate).toEqual({
			status: "actuate",
			direction: "demote",
			targetModel: TIER_MODELS.low,
			thinking: "low",
		});
		expect(
			decideTier({
				answer: choiceAnswer("low", { low: 0.85, medium: 0.15, high: 0 }, 0.849),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "below-gate" });
	});
});

describe("C-M8a — already on the target model holds", () => {
	test("high answer while already on the high model → already-on-target", () => {
		expect(
			decideTier({
				answer: choiceAnswer("high", { high: 0.9, medium: 0.1, low: 0 }, 0.9),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "already-on-target" });
	});

	test("low answer while already on the low model → already-on-target", () => {
		expect(
			decideTier({
				answer: choiceAnswer("low", { low: 0.9, medium: 0.1, high: 0 }, 0.9),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
			}),
		).toEqual({ status: "hold", reason: "already-on-target" });
	});
});

describe("C-M8b — frozen tier→thinking map (F16)", () => {
	test("low→low, medium→medium, high→high and nothing else", () => {
		expect(TIER_TO_THINKING).toEqual({ low: "low", medium: "medium", high: "high" });
		expect(Object.keys(TIER_TO_THINKING).sort()).toEqual(["high", "low", "medium"]);
	});
});

describe("tier latch + disabled (F14)", () => {
	test("a latched upgrade holds; a latched demote still actuates", () => {
		expect(
			decideTier({
				answer: choiceAnswer("high", { high: 0.9, medium: 0.1, low: 0 }, 0.9),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: true,
			}),
		).toEqual({ status: "hold", reason: "upgrade-latched" });
		expect(
			decideTier({
				answer: choiceAnswer("low", { low: 0.9, medium: 0.1, high: 0 }, 0.9),
				currentModel: TIER_MODELS.high,
				tierModels: TIER_MODELS,
				upgradesLatched: true,
			}),
		).toMatchObject({ status: "actuate", direction: "demote" });
	});

	test("disabled capability → hold capability-killed", () => {
		expect(
			decideTier({
				answer: choiceAnswer("high", { high: 0.9 }, 0.9),
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
				enabled: false,
			}),
		).toEqual({ status: "hold", reason: "capability-killed" });
	});
});

// --------------------------------------------------------------- C-R shadow routing

describe("C-R1 — shadow record has the exact shape", () => {
	test("skill answer maps to {question, choice, confidence, promptHash} and nothing else", () => {
		expect(
			decideRouting({
				answer: choiceAnswer("review", { review: 0.8, none: 0.2 }, 0.8),
				promptHash: "abc123",
				enabled: true,
			}),
		).toEqual({
			status: "record",
			record: { question: "skill", choice: "review", confidence: 0.8, promptHash: "abc123" },
		});
	});
});

describe("C-R2 — verdict none means record-only, never actuation", () => {
	test("a none choice records none with no actuation surface", () => {
		const action = decideRouting({
			answer: choiceAnswer("none", { none: 0.95, review: 0.05 }, 0.95),
			promptHash: "abc123",
			enabled: true,
		});
		expect(action).toEqual({
			status: "record",
			record: { question: "skill", choice: "none", confidence: 0.95, promptHash: "abc123" },
		});
		expect(Object.keys(action)).toEqual(["status", "record"]);
	});

	test("reject / missing / disabled answers record none at confidence 0", () => {
		const reject: AnswerParse = { status: "reject", reason: "mis-keyed", detail: "absent" };
		for (const input of [
			{ answer: reject, promptHash: "h", enabled: true },
			{ answer: undefined, promptHash: "h", enabled: true },
			{ answer: choiceAnswer("review", { review: 0.8 }, 0.8), promptHash: "h", enabled: false },
		] as const) {
			expect(decideRouting(input)).toEqual({
				status: "record",
				record: { question: "skill", choice: "none", confidence: 0, promptHash: "h" },
			});
		}
	});
});

describe("C-R5 — deterministic fallback is a bounded keyword match", () => {
	test("matches are word-part based, sorted and capped at five", () => {
		const fallback = createFallbackClassifier();
		const tools = ["zeta", "bash", "alpha", "read", "grep", "edit", "write", "delta"];
		expect(fallback.classify("use bash read grep edit write zeta alpha delta", tools).tools).toEqual({
			status: "ok",
			names: ["alpha", "bash", "delta", "edit", "grep"],
		});
	});

	test("substring false friends never match", () => {
		expect(createFallbackClassifier().classify("this already happened", ["read"]).tools).toMatchObject({
			status: "hold",
		});
	});
});

describe("C-R7 — fallback agrees with the api500 fixture", () => {
	test("Jev says technical at conf 1; the fallback keyword match lands on technical and routes none", () => {
		const parsed = parseJevResponseBody(JSON.stringify(API500_RESPONSE), {
			questions: { department: { type: "choice", options: ["billing", "technical", "sales"] } },
		});
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toMatchObject({
			status: "ok",
			answer: { type: "choice", choice: "technical", confidence: 1 },
		});
		const fallback = createFallbackClassifier().classify(
			"API returns 500 errors after the deploy, investigate the technical failure",
			["billing", "technical", "sales"],
		);
		expect(fallback.tools).toEqual({ status: "ok", names: ["technical"] });
		expect(fallback.route).toEqual({ choice: "none", confidence: 0 });
		// Shadow policy agrees: record-only, never actuation.
		expect(
			decideRouting({ answer: undefined, promptHash: "api500", enabled: true }).status,
		).toBe("record");
	});
});

// --------------------------------------------------------------- frozen entry point

describe("decidePolicies — the frozen P3 entry point maps answers + context to per-capability actions", () => {
	test("all enabled: tools actuate, tier upgrades, routing records", () => {
		expect(
			decidePolicies({
				enabled: { tools: true, model: true, routing: true },
				toolsAnswer: choiceAnswer("bash", { bash: 0.9, read: 0.1 }, 0.9),
				tierAnswer: choiceAnswer("high", { high: 0.9, medium: 0.1, low: 0 }, 0.9),
				skillAnswer: choiceAnswer("review", { review: 0.8, none: 0.2 }, 0.8),
				catalogue: CATALOGUE,
				activeTools: [],
				currentModel: TIER_MODELS.low,
				tierModels: TIER_MODELS,
				upgradesLatched: false,
				promptHash: "ph",
			}),
		).toEqual({
			tools: { status: "actuate", enable: ["bash"] },
			tier: {
				status: "actuate",
				direction: "upgrade",
				targetModel: TIER_MODELS.high,
				thinking: "high",
			},
			routing: {
				status: "record",
				record: { question: "skill", choice: "review", confidence: 0.8, promptHash: "ph" },
			},
		});
	});

	test("disabled tools hold while the other capabilities still decide", () => {
		const outcome = decidePolicies({
			enabled: { tools: false, model: true, routing: true },
			toolsAnswer: choiceAnswer("bash", { bash: 0.9 }, 0.9),
			tierAnswer: choiceAnswer("medium", { medium: 0.9, low: 0.1, high: 0 }, 0.9),
			skillAnswer: undefined,
			catalogue: CATALOGUE,
			activeTools: [],
			currentModel: TIER_MODELS.high,
			tierModels: TIER_MODELS,
			upgradesLatched: false,
			promptHash: "ph",
		});
		expect(outcome.tools).toEqual({ status: "hold", reason: "capability-killed" });
		expect(outcome.tier).toEqual({ status: "hold", reason: "neutral-tier" });
		expect(outcome.routing.record.choice).toBe("none");
	});
});
