/**
 * Pure policy (part 2) for the decision-router extension: the pre-fetch skip
 * chain, the per-capability decision rules (tools, tier, shadow routing), the
 * session cache keys, and the frozen `decidePolicies` entry point P3 wires up.
 *
 * Purity rules (house convention): one import (the P1 client contract for
 * types and frozen consts); no fetch, no pi import, no ambient env — the env
 * record, clock, marker predicate and cache set arrive injected, so every row
 * is deterministic under stubs. Nothing in this file throws.
 *
 * Frozen contract (plan v2): R10 skip order
 * kill → key → cooldown → slash → marker → short → in-flight → cache; F10 kill
 * precedence (per-capability env, then master env, then the `/decisions off`
 * session override; only the literal `"0"` disables and `on` never lifts an
 * env kill); R7 additive tools (`active ∪ {p ≥ 0.2}` gated on confidence ≥ 0.7,
 * unknown winner rejects the whole question); R8 tier asymmetry (high ≥ 0.6
 * upgrades, low ≥ 0.85 demotes, medium holds, already-on-target holds, the
 * fallback `switched` latch blocks upgrades only); R9 shadow-only routing
 * (record `{question, choice, confidence, promptHash}`, never actuate).
 */

import {
	DEMOTE_CONFIDENCE_GATE,
	JEV_API_KEY_ENV,
	MIN_PROMPT_CHARS,
	TOOL_CONFIDENCE_GATE,
	TOOL_PROB_FLOOR,
	UPGRADE_CONFIDENCE_GATE,
	type AnswerParse,
	type JevChoiceAnswer,
} from "./decision-router-client.ts";

// ------------------------------------------------------------------ env surface (plan v2 R6)

/** Master kill-switch: only the literal "0" disables. */
export const DECISION_ROUTER_ENV = "PI_BADGER_DECISION_ROUTER";
/** Per-capability kill-switches: only the literal "0" disables. */
export const DECISION_ROUTER_TOOLS_ENV = "PI_BADGER_DECISION_ROUTER_TOOLS";
export const DECISION_ROUTER_MODEL_ENV = "PI_BADGER_DECISION_ROUTER_MODEL";
export const DECISION_ROUTER_ROUTING_ENV = "PI_BADGER_DECISION_ROUTER_ROUTING";

/** Injected environment record (never the ambient env). */
export type PolicyEnv = Record<string, string | undefined>;

// ------------------------------------------------------------------ capabilities

export type PolicyCapability = "tools" | "model" | "routing";

export interface CapabilityEnablement {
	readonly tools: boolean;
	readonly model: boolean;
	readonly routing: boolean;
}

function killEnvFor(capability: PolicyCapability): string {
	switch (capability) {
		case "tools":
			return DECISION_ROUTER_TOOLS_ENV;
		case "model":
			return DECISION_ROUTER_MODEL_ENV;
		case "routing":
			return DECISION_ROUTER_ROUTING_ENV;
	}
}

/**
 * Effective enablement for one capability (F10): per-capability env, then the
 * master env, then the `/decisions off` session override. Only the literal
 * "0" disables; a session "on" never lifts an env kill.
 */
export function isCapabilityEnabled(
	env: PolicyEnv,
	sessionDecisionsOn: boolean,
	capability: PolicyCapability,
): boolean {
	if (env[killEnvFor(capability)] === "0") return false;
	if (env[DECISION_ROUTER_ENV] === "0") return false;
	return sessionDecisionsOn;
}

function enablementOf(env: PolicyEnv, sessionDecisionsOn: boolean): CapabilityEnablement {
	return {
		tools: isCapabilityEnabled(env, sessionDecisionsOn, "tools"),
		model: isCapabilityEnabled(env, sessionDecisionsOn, "model"),
		routing: isCapabilityEnabled(env, sessionDecisionsOn, "routing"),
	};
}

// ------------------------------------------------------------------ skip chain (R10 order)

/** Named skip reasons, in R10 chain order. */
export type SkipReason =
	| "tools-kill"
	| "model-kill"
	| "routing-kill"
	| "master-kill"
	| "session-off"
	| "missing-key"
	| "cooldown"
	| "slash-prefixed"
	| "marker-prefixed"
	| "short-prompt"
	| "in-flight"
	| "cache-hit";

/** Defensive F3 predicate: any remaining slash-prefixed prompt never decides. */
export function isSlashPrefixed(prompt: string): boolean {
	return prompt.startsWith("/");
}

/** Short-prompt gate: fewer than MIN_PROMPT_CHARS non-whitespace characters. */
export function isShortPrompt(prompt: string): boolean {
	return prompt.replace(/\s/g, "").length < MIN_PROMPT_CHARS;
}

/** Cooldown gate: the injected now is still inside the armed window. */
export function isCoolingDown(nowMs: number, cooldownUntilMs: number): boolean {
	return nowMs < cooldownUntilMs;
}

function hasApiKey(env: PolicyEnv): boolean {
	const key = env[JEV_API_KEY_ENV];
	return key !== undefined && key.trim() !== "";
}

/** Session cache key: names every dependency (prompt, catalogue, model). No TTL per R5. */
export function keyOf(input: { readonly promptHash: string; readonly catalogueHash: string; readonly modelId: string }): string {
	return `${input.promptHash}\n${input.catalogueHash}\n${input.modelId}`;
}

export interface TurnContext {
	readonly prompt: string;
	readonly promptHash: string;
	readonly catalogueHash: string;
	readonly modelId: string;
	readonly env: PolicyEnv;
	readonly sessionDecisionsOn: boolean;
	readonly cooldownUntilMs: number;
	readonly nowMs: number;
	readonly inFlight: boolean;
	readonly cacheKeys: ReadonlySet<string>;
	readonly isMarkerPrefixed: (prompt: string) => boolean;
}

export type TurnDecision =
	| { readonly status: "skip"; readonly reason: SkipReason }
	| { readonly status: "proceed"; readonly key: string; readonly enabled: CapabilityEnablement };

/**
 * Pre-fetch gate in R10 order. Kill switches resolve to per-capability
 * enablement first (a partial kill narrows the fan-out, it does not skip the
 * turn); every later gate is turn-wide with its named reason.
 */
export function evaluateTurn(ctx: TurnContext): TurnDecision {
	// Kill reasons resolve against the env alone (session assumed on): a
	// session-off turn reports session-off, never a phantom env kill.
	const killState = enablementOf(ctx.env, true);
	if (!killState.tools && !killState.model && !killState.routing) {
		if (ctx.env[DECISION_ROUTER_TOOLS_ENV] === "0") return { status: "skip", reason: "tools-kill" };
		if (ctx.env[DECISION_ROUTER_MODEL_ENV] === "0") return { status: "skip", reason: "model-kill" };
		if (ctx.env[DECISION_ROUTER_ROUTING_ENV] === "0") return { status: "skip", reason: "routing-kill" };
		return { status: "skip", reason: "master-kill" };
	}
	if (!ctx.sessionDecisionsOn) return { status: "skip", reason: "session-off" };
	if (!hasApiKey(ctx.env)) return { status: "skip", reason: "missing-key" };
	if (isCoolingDown(ctx.nowMs, ctx.cooldownUntilMs)) return { status: "skip", reason: "cooldown" };
	if (isSlashPrefixed(ctx.prompt)) return { status: "skip", reason: "slash-prefixed" };
	if (ctx.isMarkerPrefixed(ctx.prompt)) return { status: "skip", reason: "marker-prefixed" };
	if (isShortPrompt(ctx.prompt)) return { status: "skip", reason: "short-prompt" };
	if (ctx.inFlight) return { status: "skip", reason: "in-flight" };
	const key = keyOf({ promptHash: ctx.promptHash, catalogueHash: ctx.catalogueHash, modelId: ctx.modelId });
	if (ctx.cacheKeys.has(key)) return { status: "skip", reason: "cache-hit" };
	return { status: "proceed", key, enabled: enablementOf(ctx.env, ctx.sessionDecisionsOn) };
}

// ------------------------------------------------------------------ shared answer guard

/** Unwrap a choice answer; rejects, missing questions and noul answers hold. */
function asChoice(answer: AnswerParse | undefined): JevChoiceAnswer | undefined {
	if (answer === undefined || answer.status !== "ok") return undefined;
	if (answer.answer.type !== "choice") return undefined;
	return answer.answer;
}

// ------------------------------------------------------------------ tool policy (R7)

/** Hold reasons for the tool question. */
export type ToolHoldReason =
	| "capability-killed"
	| "answer-reject"
	| "unknown-choice"
	| "low-confidence"
	| "empty-subset"
	| "already-enabled";

/** Tool action: actuate the additive enable set, or hold with a named reason. */
export type ToolPolicyAction =
	| { readonly status: "actuate"; readonly enable: string[] }
	| { readonly status: "hold"; readonly reason: ToolHoldReason };

export interface ToolPolicyInput {
	readonly answer: AnswerParse | undefined;
	readonly catalogue: readonly string[];
	readonly activeTools: readonly string[];
	readonly enabled?: boolean;
}

/**
 * Additive tool subset (strict R7): `active ∪ ({p ≥ floor} ∩ catalogue)`,
 * gated on top confidence ≥ gate. The winner is validated against the live
 * catalogue but is NOT force-included — only its probability entry decides,
 * exactly like every other option. An unknown winner rejects the whole
 * question; ghost non-winner probabilities are filtered, never actuated.
 */
export function decideTools(input: ToolPolicyInput): ToolPolicyAction {
	if (input.enabled === false) return { status: "hold", reason: "capability-killed" };
	const answer = asChoice(input.answer);
	if (answer === undefined) return { status: "hold", reason: "answer-reject" };
	if (!input.catalogue.includes(answer.choice)) return { status: "hold", reason: "unknown-choice" };
	if (answer.confidence < TOOL_CONFIDENCE_GATE) return { status: "hold", reason: "low-confidence" };
	const live = new Set(input.catalogue);
	const subset = [...live]
		.filter((name) => (answer.probabilities[name] ?? 0) >= TOOL_PROB_FLOOR)
		.sort();
	if (subset.length === 0) return { status: "hold", reason: "empty-subset" };
	const active = new Set(input.activeTools);
	if (subset.every((name) => active.has(name))) return { status: "hold", reason: "already-enabled" };
	return { status: "actuate", enable: subset };
}

// ------------------------------------------------------------------ tier policy (R8)

export type TierChoice = "low" | "medium" | "high";
export type TierThinking = "low" | "medium" | "high";

/** Frozen tier→thinking map (F16): every other level is unreachable from tier answers. */
export const TIER_TO_THINKING: Record<TierChoice, TierThinking> = {
	low: "low",
	medium: "medium",
	high: "high",
};

/** Hold reasons for the tier question. */
export type TierHoldReason =
	| "capability-killed"
	| "answer-reject"
	| "neutral-tier"
	| "below-gate"
	| "already-on-target"
	| "upgrade-latched";

/** Tier action: move one step with target model + thinking level, or hold. */
export type TierPolicyAction =
	| {
			readonly status: "actuate";
			readonly direction: "upgrade" | "demote";
			readonly targetModel: string;
			readonly thinking: TierThinking;
	  }
	| { readonly status: "hold"; readonly reason: TierHoldReason };

export interface TierPolicyInput {
	readonly answer: AnswerParse | undefined;
	readonly currentModel: string;
	readonly tierModels: { readonly low: string; readonly medium: string; readonly high: string };
	readonly upgradesLatched: boolean;
	readonly enabled?: boolean;
}

/**
 * Asymmetric tier gates: `high` + conf ≥ upgrade gate upgrades, `low` + conf ≥
 * demote gate demotes (BOTH the cheap-tier choice AND the gate are required),
 * `medium` and every off-rubric choice hold. The fallback `switched` latch
 * (F14) blocks upgrades only — demotes always pass it.
 */
export function decideTier(input: TierPolicyInput): TierPolicyAction {
	if (input.enabled === false) return { status: "hold", reason: "capability-killed" };
	const answer = asChoice(input.answer);
	if (answer === undefined) return { status: "hold", reason: "answer-reject" };
	if (answer.choice === "high") {
		if (answer.confidence < UPGRADE_CONFIDENCE_GATE) return { status: "hold", reason: "below-gate" };
		if (input.tierModels.high === input.currentModel) return { status: "hold", reason: "already-on-target" };
		if (input.upgradesLatched) return { status: "hold", reason: "upgrade-latched" };
		return {
			status: "actuate",
			direction: "upgrade",
			targetModel: input.tierModels.high,
			thinking: TIER_TO_THINKING.high,
		};
	}
	if (answer.choice === "low") {
		if (answer.confidence < DEMOTE_CONFIDENCE_GATE) return { status: "hold", reason: "below-gate" };
		if (input.tierModels.low === input.currentModel) return { status: "hold", reason: "already-on-target" };
		return {
			status: "actuate",
			direction: "demote",
			targetModel: input.tierModels.low,
			thinking: TIER_TO_THINKING.low,
		};
	}
	return { status: "hold", reason: "neutral-tier" };
}

// ------------------------------------------------------------------ shadow routing (R9)

/** Shadow log record: the exact shape stored per routing question. */
export interface RoutingRecord {
	readonly question: string;
	readonly choice: string;
	readonly confidence: number;
	readonly promptHash: string;
}

/** Routing action: shadow-only, always a record, never an actuation. */
export type RoutingPolicyAction = { readonly status: "record"; readonly record: RoutingRecord };

export interface RoutingPolicyInput {
	readonly answer: AnswerParse | undefined;
	readonly promptHash: string;
	readonly enabled?: boolean;
}

/**
 * Shadow routing: record the skill verdict (or `none` at confidence 0 when
 * the question is disabled, missing or rejected) and return. There is no
 * enforce path — the action surface has no actuation variant by construction.
 */
export function decideRouting(input: RoutingPolicyInput): RoutingPolicyAction {
	const answer = input.enabled === false ? undefined : asChoice(input.answer);
	if (answer === undefined) {
		return {
			status: "record",
			record: { question: "skill", choice: "none", confidence: 0, promptHash: input.promptHash },
		};
	}
	return {
		status: "record",
		record: {
			question: "skill",
			choice: answer.choice,
			confidence: answer.confidence,
			promptHash: input.promptHash,
		},
	};
}

// ------------------------------------------------------------------ frozen entry point (P3 contract)

/** Per-capability actions for one decided turn. */
export interface PolicyOutcome {
	readonly tools: ToolPolicyAction;
	readonly tier: TierPolicyAction;
	readonly routing: RoutingPolicyAction;
}

export interface PolicyInput {
	readonly enabled: CapabilityEnablement;
	readonly toolsAnswer: AnswerParse | undefined;
	readonly tierAnswer: AnswerParse | undefined;
	readonly skillAnswer: AnswerParse | undefined;
	readonly catalogue: readonly string[];
	readonly activeTools: readonly string[];
	readonly currentModel: string;
	readonly tierModels: { readonly low: string; readonly medium: string; readonly high: string };
	readonly upgradesLatched: boolean;
	readonly promptHash: string;
}

/**
 * Frozen P3 entry point: typed answers + resolved context map to typed
 * per-capability actions. Disabled capabilities hold as `capability-killed`
 * while the rest still decide — the fan-out narrows, it never half-fires.
 */
export function decidePolicies(input: PolicyInput): PolicyOutcome {
	return {
		tools: decideTools({
			answer: input.toolsAnswer,
			catalogue: input.catalogue,
			activeTools: input.activeTools,
			enabled: input.enabled.tools,
		}),
		tier: decideTier({
			answer: input.tierAnswer,
			currentModel: input.currentModel,
			tierModels: input.tierModels,
			upgradesLatched: input.upgradesLatched,
			enabled: input.enabled.model,
		}),
		routing: decideRouting({
			answer: input.skillAnswer,
			promptHash: input.promptHash,
			enabled: input.enabled.routing,
		}),
	};
}
