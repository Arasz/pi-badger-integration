/**
 * PKG-C tests: provider/config registry for the router-failure fallback.
 *
 * Plan: docs/plans/2026-router-failure-free-model-fallback.plan-providers.md §1 (P1–P5),
 * as overridden by docs/plans/2026-router-failure-free-model-fallback.plan-review-folds.md
 * (F0–F6 normative). Row IDs: F1–F6 from the test-engineer lane table
 * (plan-tests.md §F-rows), F4′/F7/F8/F9/F10/C15/I3 from the folds (F3–F4).
 *
 * Purity halves (F2 factory-deps mapping N2): the selector never touches pi — tests inject
 * selector state directly, with a stub registry (find/auth views) and injected env/now.
 * The zero-`setModel` halves of F7/F9 belong to Lane B/E wiring (this module never calls
 * setModel by construction); the pure halves asserted here are the `{none, reason}` results
 * the wiring switches on. Placeholder key VALUES below are inert ("test-…") — see I3.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	DEFAULT_PROVIDERS,
	FALLBACK_COOLDOWN_MS_DEFAULT,
	entryCooldownMs,
	filterEligible,
	getServingProvider,
	initialSelectorState,
	isEligible,
	parseRetryAfterMs,
	requiredThinking,
	resolveTargets,
	decideNextTarget,
	validateProviderEntry,
	type FallbackProviderEntry,
	type FallbackRegistryView,
	type ScopedModelRef,
	type SelectorState,
} from "../../extensions/router-fallback/fallback-providers.ts";

/** Fixed epoch so nothing in this suite touches the clock. */
const NOW = 1_700_000_000_000;

/** Inert placeholder credentials — values only, never real secrets (see I3). */
const FULL_ENV = {
	GROQ_API_KEY: "test-groq-key",
	GEMINI_API_KEY: "test-gemini-key",
	OPENROUTER_API_KEY: "test-openrouter-key",
};

/** Reasoning flags mirror the pi catalog notes in the providers plan (C1: off→false). */
const REASONING: Record<string, boolean> = {
	"groq/llama-3.3-70b-versatile": false,
	"google/gemini-3.1-flash-lite": true,
	"google/gemini-3.1-pro-preview": true,
	"openrouter/z-ai/glm-5.2:free": true,
	"openrouter/poolside/laguna-s-2.1:free": false,
	"openrouter/minimax/minimax-m3:free": false,
	"openrouter/thinkingmachines/inkling-small:free": false,
};

/** Stub registry: `present` lists "provider/model" pairs the catalog still carries. */
function makeRegistry(present: Set<string>): FallbackRegistryView {
	return {
		find: (provider, modelId) => {
			const key = `${provider}/${modelId}`;
			if (!present.has(key)) return undefined;
			return { reasoning: REASONING[key] ?? false };
		},
	};
}

const ALL_PRESENT = new Set(Object.keys(REASONING));

/** Eligible defaults → resolved flat targets (the Lane E composition, in test form). */
function resolvedTargets(
	env: Record<string, string | undefined> = FULL_ENV,
	registry: FallbackRegistryView = makeRegistry(ALL_PRESENT),
	scope?: readonly ScopedModelRef[],
) {
	return resolveTargets(filterEligible(DEFAULT_PROVIDERS, env), registry, scope);
}

function stateWithServing(targets: ReturnType<typeof resolveTargets>, index: number): SelectorState {
	return { ...initialSelectorState(targets), servingIndex: index };
}

// ------------------------------------------------------------------ defaults snapshot (P1)

describe("defaults: frozen pinned chain (J3 IDs, H10 tuning)", () => {
	test("shipped defaults equal the normative provider table", () => {
		expect(DEFAULT_PROVIDERS.map((entry) => entry.id)).toEqual(["openrouter", "groq", "gemini"]);
		expect(DEFAULT_PROVIDERS.map((entry) => entry.piProvider)).toEqual([
			"openrouter",
			"groq",
			"google",
		]);
		expect(DEFAULT_PROVIDERS.map((entry) => entry.model)).toEqual([
			"z-ai/glm-5.2:free",
			"llama-3.3-70b-versatile",
			"gemini-3.1-flash-lite",
		]);
		expect(DEFAULT_PROVIDERS.map((entry) => entry.apiKeyEnv)).toEqual([
			"OPENROUTER_API_KEY",
			"GROQ_API_KEY",
			"GEMINI_API_KEY",
		]);
		expect(DEFAULT_PROVIDERS.find((entry) => entry.id === "gemini")?.models).toEqual([
			"gemini-3.1-flash-lite",
			"gemini-3.1-pro-preview",
		]);
		expect(DEFAULT_PROVIDERS.find((entry) => entry.id === "openrouter")?.models).toEqual([
			"z-ai/glm-5.2:free",
			"poolside/laguna-s-2.1:free",
			"minimax/minimax-m3:free",
			"thinkingmachines/inkling-small:free",
		]);
		for (const entry of DEFAULT_PROVIDERS) {
			expect(entry.enabled).toBe(true);
			expect(entry.baseUrl).toBeUndefined();
			expect(entry.extraHeaders).toBeUndefined();
			expect(entry.rateLimit.cooldownMs).toBe(60_000);
			expect(entry.rateLimit.maxRetries).toBe(1);
		}
	});

	test("defaults are frozen (order/priority cannot be mutated by consumers)", () => {
		expect(Object.isFrozen(DEFAULT_PROVIDERS)).toBe(true);
	});
});

// ------------------------------------------------------------------ F1 cooldown, not disable

describe("F1: cooldown, not disable — expiry re-admits the head", () => {
	test("billing on openrouter advances to groq; after cooldownMs the head serves again", () => {
		const targets = resolvedTargets();
		expect(targets.length).toBe(7);
		let state = initialSelectorState(targets);

		const first = decideNextTarget(state, { kind: "billing-exhaustion", now: NOW });
		if (!("entry" in first)) throw new Error(`expected first serve, got ${first.reason}`);
		expect(first.entry.id).toBe("openrouter");
		expect(first.model).toBe("z-ai/glm-5.2:free");

		const second = decideNextTarget(first.state, { kind: "billing-exhaustion", now: NOW + 1 });
		if (!("entry" in second)) throw new Error(`expected advance, got ${second.reason}`);
		expect(second.entry.id).toBe("groq");
		expect(second.model).toBe("llama-3.3-70b-versatile");

		const recovered = decideNextTarget(second.state, {
			kind: "billing-exhaustion",
			now: NOW + 1 + FALLBACK_COOLDOWN_MS_DEFAULT,
		});
		if (!("entry" in recovered)) throw new Error(`expected re-admit, got ${recovered.reason}`);
		expect(recovered.entry.id).toBe("openrouter");
		expect(recovered.model).toBe("z-ai/glm-5.2:free");
	});
});

// ------------------------------------------------------------------ F2 skip unset keys, keyless custom stays

describe("F2: unset-key providers are skipped; keyless custom stays eligible", () => {
	const keylessCustom: FallbackProviderEntry = {
		id: "cerebras-proxy",
		piProvider: "cerebras-proxy",
		label: "Cerebras (custom)",
		model: "qwen-3-235b-a22b",
		enabled: true,
		baseUrl: "https://api.cerebras.ai/v1",
		rateLimit: { cooldownMs: 60_000, maxRetries: 1 },
	};

	test("missing GROQ_API_KEY removes groq from the eligible set", () => {
		const env = { GEMINI_API_KEY: "test-gemini-key", OPENROUTER_API_KEY: "test-or-key" };
		const eligible = filterEligible(DEFAULT_PROVIDERS, env);
		expect(eligible.map((entry) => entry.id)).toEqual(["openrouter", "gemini"]);
		expect(resolvedTargets(env)[0]?.entry.id).toBe("openrouter");
	});

	test("keyless custom (absent or empty apiKeyEnv) is eligible only when enabled", () => {
		expect(isEligible(keylessCustom, {})).toBe(true);
		expect(isEligible({ ...keylessCustom, apiKeyEnv: "" }, {})).toBe(true);
		expect(isEligible({ ...keylessCustom, enabled: false }, {})).toBe(false);
	});

	test("a built-in without apiKeyEnv is never eligible (schema violation, not keyless)", () => {
		const groq = DEFAULT_PROVIDERS.find((entry) => entry.id === "groq")!;
		expect(isEligible({ ...groq, apiKeyEnv: undefined }, FULL_ENV)).toBe(false);
	});

	test("auth-status view refines env presence (configured:false skips, absent map is env-only)", () => {
		const groq = DEFAULT_PROVIDERS.find((entry) => entry.id === "groq")!;
		expect(isEligible(groq, FULL_ENV, { configured: false })).toBe(false);
		expect(isEligible(groq, FULL_ENV, { configured: true })).toBe(true);
		expect(isEligible(groq, FULL_ENV)).toBe(true);
		expect(isEligible(groq, {})).toBe(false);
	});
});

// ------------------------------------------------------------------ F3 maxRetries advances, exhaustion is terminal

describe("F3: maxRetries attempts per entry, then advance", () => {
	test("503 on openrouter head rotates once (default maxRetries 1), next 503 advances", () => {
		const targets = resolvedTargets();
		const glmIndex = targets.findIndex((t) => t.model === "z-ai/glm-5.2:free");
		expect(glmIndex).toBe(0); // openrouter-first: the :free head is targets[0]
		const state = stateWithServing(targets, glmIndex);

		const rotated = decideNextTarget(state, { kind: "model-unavailable", now: NOW });
		if (!("entry" in rotated)) throw new Error(`expected rotate, got ${rotated.reason}`);
		expect(rotated.entry.id).toBe("openrouter");
		expect(rotated.model).toBe("poolside/laguna-s-2.1:free");

		const advanced = decideNextTarget(rotated.state, { kind: "model-unavailable", now: NOW + 1 });
		if (!("entry" in advanced)) throw new Error(`expected advance, got ${advanced.reason}`);
		expect(advanced.entry.id).toBe("groq");
		expect(advanced.model).toBe("llama-3.3-70b-versatile");
	});
});

// ------------------------------------------------------------------ F4 Retry-After honored (+ F4′ twin)

describe("F4: wait = max(retryAfter, cooldownMs), exact ms", () => {
	const quickEntry: FallbackProviderEntry = {
		id: "quick",
		piProvider: "groq",
		label: "Quick",
		apiKeyEnv: "GROQ_API_KEY",
		model: "llama-3.3-70b-versatile",
		enabled: true,
		rateLimit: { cooldownMs: 1000, maxRetries: 1 },
	};

	function quickState() {
		const targets = resolveTargets([quickEntry], makeRegistry(ALL_PRESENT));
		return stateWithServing(targets, 0);
	}

	test("Retry-After:120 + cooldownMs:1000 → retryAfterMs 120000", () => {
		const result = decideNextTarget(quickState(), {
			kind: "throttle",
			now: NOW,
			responseHeaders: { "Retry-After": "120" },
		});
		if (!("none" in result)) throw new Error("expected wait");
		expect(result.retryAfterMs).toBe(120_000);
	});

	test("F4′ twin: Retry-After:1 + cooldownMs:60000 → 60000 (cooldown dominates)", () => {
		const targets = resolvedTargets();
		const result = decideNextTarget(stateWithServing(targets, 0), {
			kind: "throttle",
			now: NOW,
			responseHeaders: { "retry-after": "1" },
		});
		if (!("none" in result)) throw new Error("expected wait");
		expect(result.retryAfterMs).toBe(60_000);
	});

	test("parseRetryAfterMs: delay-seconds, HTTP-date, garbage, missing", () => {
		expect(parseRetryAfterMs({ "Retry-After": "120" }, NOW)).toBe(120_000);
		expect(parseRetryAfterMs({ "retry-after": "1" }, NOW)).toBe(1_000);
		expect(parseRetryAfterMs({ "Retry-After": new Date(NOW + 90_000).toUTCString() }, NOW)).toBe(
			90_000,
		);
		expect(parseRetryAfterMs({ "Retry-After": "soon" }, NOW)).toBeUndefined();
		expect(parseRetryAfterMs({ "Retry-After": "-5" }, NOW)).toBeUndefined();
		expect(parseRetryAfterMs({}, NOW)).toBeUndefined();
		expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
	});
});

// ------------------------------------------------------------------ F5 enabled:false skipped without reorder

describe("F5: enabled:false skipped, order preserved", () => {
		test("disabled head is skipped and the input order is untouched", () => {
		const entries = [DEFAULT_PROVIDERS[0], DEFAULT_PROVIDERS[1], DEFAULT_PROVIDERS[2]].map(
			(entry) => ({ ...entry }),
		);
		entries[0] = { ...entries[0], enabled: false };
		const before = entries.map((entry) => entry.id);
		const targets = resolveTargets(filterEligible(entries, FULL_ENV), makeRegistry(ALL_PRESENT));
		expect(targets[0]?.entry.id).toBe("groq");
		expect(targets.some((target) => target.entry.id === "openrouter")).toBe(false);
		expect(entries.map((entry) => entry.id)).toEqual(before);
	});
});

// ------------------------------------------------------------------ F6 full exhaustion is terminal + serving record

describe("F6: all cooling → exhausted (terminal) with a servedBy record", () => {
	test("three billing advances then a terminal exhausted (never wait-forever)", () => {
		let state = initialSelectorState(resolvedTargets());
		const seen: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			const result = decideNextTarget(state, { kind: "billing-exhaustion", now: NOW + i });
			if (!("entry" in result)) throw new Error(`expected serve #${i}, got ${result.reason}`);
			seen.push(`${result.entry.id}/${result.model}`);
			state = result.state;
		}
		expect(seen).toEqual([
			"openrouter/z-ai/glm-5.2:free",
			"groq/llama-3.3-70b-versatile",
			"gemini/gemini-3.1-flash-lite",
		]);
		const exhausted = decideNextTarget(state, { kind: "billing-exhaustion", now: NOW + 3 });
		if (!("none" in exhausted)) throw new Error("expected terminal exhausted");
		expect(exhausted.none).toBe(true);
		expect(exhausted.reason).toMatch(/exhausted/i);
		expect("retryAfterMs" in exhausted ? exhausted.retryAfterMs : undefined).toBeUndefined();
	});

	test("getServingProvider tracks the advance chain (powers status/bus, no separate tracking)", () => {
		let state = initialSelectorState(resolvedTargets());
		expect(getServingProvider(state)).toBeUndefined();
		const first = decideNextTarget(state, { kind: "billing-exhaustion", now: NOW });
		if (!("entry" in first)) throw new Error("expected serve");
		expect(getServingProvider(first.state)).toEqual({
			id: "openrouter",
			label: "OpenRouter",
			model: "z-ai/glm-5.2:free",
		});
		const second = decideNextTarget(first.state, { kind: "billing-exhaustion", now: NOW + 1 });
		if (!("entry" in second)) throw new Error("expected advance");
		expect(getServingProvider(second.state)?.id).toBe("groq");
		expect(second.state.servedBy.length).toBe(2);
	});
});

// ------------------------------------------------------------------ F7 throttle → wait (pure half)

describe("F7: throttle is cooldown-only — decide returns wait, never a target", () => {
	test("throttle yields {none, retryAfterMs} with no entry (zero-setModel half lives in Lane B/E wiring)", () => {
		const targets = resolvedTargets();
		const result = decideNextTarget(stateWithServing(targets, 0), {
			kind: "throttle",
			now: NOW,
		});
		if (!("none" in result)) throw new Error("throttle must never switch models");
		expect(result.none).toBe(true);
		expect("entry" in result).toBe(false);
		expect(result.reason).toMatch(/throttle|wait|cooldown/i);
		expect(result.retryAfterMs).toBe(60_000);
		// The serving provider is unchanged: the head stays on cooldown, nothing advances.
		expect(getServingProvider(result.state)?.id).toBe("openrouter");
	});
});

// ------------------------------------------------------------------ F8 503 → same-provider next model

describe("F8: model-unavailable rotates within the provider before advancing", () => {
	test("503 on z-ai/glm-5.2:free serves laguna-s-2.1 (same entry, next model)", () => {
		const targets = resolvedTargets();
		const glmIndex = targets.findIndex((t) => t.model === "z-ai/glm-5.2:free");
		const result = decideNextTarget(stateWithServing(targets, glmIndex), {
			kind: "model-unavailable",
			now: NOW,
		});
		if (!("entry" in result)) throw new Error(`expected rotate, got ${result.reason}`);
		expect(result.entry.id).toBe("openrouter");
		expect(result.model).toBe("poolside/laguna-s-2.1:free");
	});

	test("503 on the last chain model advances to the next provider", () => {
		const targets = resolvedTargets();
		const lastIndex = targets.findIndex((t) => t.model === "thinkingmachines/inkling-small:free");
		const result = decideNextTarget(stateWithServing(targets, lastIndex), {
			kind: "model-unavailable",
			now: NOW,
		});
		if (!("entry" in result)) throw new Error(`expected advance, got ${result.reason}`);
		expect(result.entry.id).toBe("groq");
	});
});

// ------------------------------------------------------------------ F9 all keys unset (pure halves)

describe("F9: all keys unset → no eligible providers, no fallback auth", () => {
	test("eligible [] and decide reports no fallback auth (zero-setModel half lives in Lane B/E)", () => {
		expect(filterEligible(DEFAULT_PROVIDERS, {})).toEqual([]);
		const result = decideNextTarget(initialSelectorState([]), {
			kind: "billing-exhaustion",
			now: NOW,
		});
		if (!("none" in result)) throw new Error("empty chain must never serve");
		expect(result.none).toBe(true);
		expect(result.reason).toMatch(/no fallback auth/i);
	});
});

// ------------------------------------------------------------------ F10 rotated head degrades

describe("F10: stale head model degrades to the next entry (resolve-or-skip, never throw)", () => {
	test("groq rotated out of the catalog → openrouter head serves (entry order, not id)", () => {
		const withoutGroq = new Set([...ALL_PRESENT]);
		withoutGroq.delete("groq/llama-3.3-70b-versatile");
		const targets = resolvedTargets(FULL_ENV, makeRegistry(withoutGroq));
		expect(targets.length).toBeGreaterThan(0);
		expect(targets[0]?.entry.id).toBe("openrouter");
		expect(targets[0]?.model).toBe("z-ai/glm-5.2:free");
	});

	test("stale openrouter head degrades within the chain (laguna-s-2.1 next)", () => {
		const withoutHead = new Set([...ALL_PRESENT]);
		withoutHead.delete("openrouter/z-ai/glm-5.2:free");
		const targets = resolvedTargets(FULL_ENV, makeRegistry(withoutHead));
		const orTargets = targets.filter((target) => target.entry.id === "openrouter");
		expect(orTargets[0]?.model).toBe("poolside/laguna-s-2.1:free");
	});
});

// ------------------------------------------------------------------ scope preference (P3)

describe("resolveTargets: scoped sessions prefer in-scope models, never persist", () => {
	test("in-scope gemini target resolves when available", () => {
		const scope: ScopedModelRef[] = [
			{ provider: "google", modelId: "gemini-3.1-flash-lite" },
		];
		const targets = resolvedTargets(FULL_ENV, makeRegistry(ALL_PRESENT), scope);
		expect(targets.map((target) => `${target.entry.id}/${target.model}`)).toEqual([
			"gemini/gemini-3.1-flash-lite",
		]);
	});

	test("entries with no in-scope candidate are skipped (an explicit scope is never violated)", () => {
		const scope: ScopedModelRef[] = [{ provider: "groq", modelId: "llama-3.3-70b-versatile" }];
		const targets = resolvedTargets(FULL_ENV, makeRegistry(ALL_PRESENT), scope);
		expect(targets.map((target) => `${target.entry.id}/${target.model}`)).toEqual([
			"groq/llama-3.3-70b-versatile",
		]);
	});

	test("empty scope resolves the full catalog-verified chain (flat, priority order)", () => {
		const targets = resolvedTargets();
		expect(targets.map((target) => target.model)).toEqual([
			"z-ai/glm-5.2:free",
			"poolside/laguna-s-2.1:free",
			"minimax/minimax-m3:free",
			"thinkingmachines/inkling-small:free",
			"llama-3.3-70b-versatile",
			"gemini-3.1-flash-lite",
			"gemini-3.1-pro-preview",
		]);
	});
});

// ------------------------------------------------------------------ requiredThinking (S2)

describe("requiredThinking: ThinkingLevel-only for reasoning targets, undefined otherwise", () => {
	test("non-reasoning groq target → undefined (skip the call; session auto-clamp landed on off)", () => {
		expect(requiredThinking(false)).toBeUndefined();
	});

	test("reasoning gemini/openrouter targets → an explicit non-off level", () => {
		expect(requiredThinking(true)).toBe("low");
	});

	test("resolved targets carry the catalog reasoning flag through", () => {
		const targets = resolvedTargets();
		// OpenRouter-first: targets[0] is the reasoning glm head → explicit level …
		expect(requiredThinking(targets[0]?.reasoning ?? false)).toBe("low");
		// … while the non-reasoning groq target still skips the call.
		const groq = targets.find((target) => target.entry.id === "groq")!;
		expect(requiredThinking(groq.reasoning)).toBeUndefined();
	});
});

// ------------------------------------------------------------------ entry tuning helpers (H10)

describe("entry tuning: cooldown/maxRetries sanitize like Lane A clamps", () => {
	test("entryCooldownMs defaults, floors and caps", () => {
		expect(entryCooldownMs(DEFAULT_PROVIDERS[0])).toBe(60_000);
		expect(
			entryCooldownMs({ ...DEFAULT_PROVIDERS[0], rateLimit: { cooldownMs: 5_000, maxRetries: 1 } }),
		).toBe(5_000);
		expect(
			entryCooldownMs({
				...DEFAULT_PROVIDERS[0],
				rateLimit: { cooldownMs: -5, maxRetries: 1 },
			}),
		).toBe(60_000);
		expect(
			entryCooldownMs({
				...DEFAULT_PROVIDERS[0],
				rateLimit: { cooldownMs: 99 * 3_600_000, maxRetries: 1 },
			}),
		).toBe(3_600_000);
	});
});

// ------------------------------------------------------------------ C15 schema rejects bad custom

describe("C15: custom-entry schema rejects bad customs; stale IDs never throw", () => {
	const goodCustom: FallbackProviderEntry = {
		id: "cerebras-proxy",
		piProvider: "cerebras-proxy",
		label: "Cerebras (custom)",
		apiKeyEnv: "CEREBRAS_API_KEY",
		model: "qwen-3-235b-a22b",
		enabled: true,
		baseUrl: "https://api.cerebras.ai/v1",
		extraHeaders: { "X-Title": "pi-fallback" },
		rateLimit: { cooldownMs: 60_000, maxRetries: 1 },
	};

	test("unknown piProvider without baseUrl is rejected (names the missing baseUrl)", () => {
		const { baseUrl: _dropped, ...noUrl } = goodCustom;
		const result = validateProviderEntry(noUrl);
		expect(result.ok).toBe(false);
		expect(result.errors.join("; ")).toMatch(/baseUrl/i);
	});

	test("built-in without apiKeyEnv, built-in with baseUrl, and bad shapes are rejected", () => {
		expect(validateProviderEntry({ ...DEFAULT_PROVIDERS[0], apiKeyEnv: undefined }).ok).toBe(
			false,
		);
		expect(
			validateProviderEntry({ ...DEFAULT_PROVIDERS[0], baseUrl: "https://x.example" }).ok,
		).toBe(false);
		expect(validateProviderEntry({ ...goodCustom, id: "" }).ok).toBe(false);
		expect(validateProviderEntry({ ...goodCustom, models: [] }).ok).toBe(false);
		expect(
			validateProviderEntry({ ...goodCustom, rateLimit: { cooldownMs: -1, maxRetries: 1 } }).ok,
		).toBe(false);
		expect(validateProviderEntry(null).ok).toBe(false);
		expect(validateProviderEntry("groq").ok).toBe(false);
	});

	test("good custom validates; stale IDs resolve-or-skip without throwing", () => {
		expect(validateProviderEntry(goodCustom).ok).toBe(true);
		expect(validateProviderEntry(DEFAULT_PROVIDERS[1]).ok).toBe(true);
		expect(resolveTargets(filterEligible(DEFAULT_PROVIDERS, FULL_ENV), makeRegistry(new Set()))).toEqual(
			[],
		);
		const throwing: FallbackRegistryView = {
			find: () => {
				throw new Error("catalog exploded");
			},
		};
		expect(() => resolveTargets(filterEligible(DEFAULT_PROVIDERS, FULL_ENV), throwing)).not.toThrow();
		expect(resolveTargets(filterEligible(DEFAULT_PROVIDERS, FULL_ENV), throwing)).toEqual([]);
	});
});

// ------------------------------------------------------------------ I3 secret hygiene

describe("I3: no secret values in the lane (key names only, values never rendered)", () => {
	test("extension + lane test sources carry no secret-value prefixes (see I3 needle list)", () => {
		const needles = ["s" + "k-", "gs" + "k_", "s" + "k-or-", "AI" + "za", "xo" + "xb"];
		const files = [
			"../../extensions/router-fallback/fallback-providers.ts",
			"../../extensions/router-fallback/router-fallback-core.ts",
			"./fallback-providers.test.ts",
		];
		for (const file of files) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			for (const needle of needles) {
				expect(source.includes(needle)).toBe(false);
			}
		}
	});
});
