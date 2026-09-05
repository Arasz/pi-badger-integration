/**
 * Provider/config registry for the router-failure fallback extension (PKG-C).
 *
 * Everything the wiring (Lane B/E: eligibility filter, scope read, `setModel`,
 * thinking reclamp, notices) needs that can be decided without a process, a clock
 * or pi itself lives here: the config schema + frozen defaults, auth eligibility,
 * scope-preferring target resolution, and the ordered-failover selector.
 *
 * Purity rules (house convention, copied from `router-fallback-core.ts`):
 *   - no pi imports — pi arrives as minimal structural views (`FallbackRegistryView`,
 *     `FallbackAuthView`, `ScopedModelRef`) that Lane E maps from `modelRegistry`,
 *     `getProviderAuthStatus` and `ctx.scopedModels`; the only imports are
 *     type-only plus `clampCooldownMs` from the sibling core;
 *   - no wall-clock reads — `now` arrives per event (`FallbackFailureEvent.now`);
 *   - no fs/net — environment arrives as an injected readonly record, read per call;
 *   - every side effect (setModel, timers, notices, registration) belongs to wiring.
 *
 * Kind→action table (normative, review folds F2/S3; kinds from `classifyFailure`):
 *   - billing-exhaustion → advance past the serving entry + try the next target;
 *   - auth → advance past the serving entry (targets are pre-filtered to configured
 *     providers, so exhaustion reads as "no other configured fallback" + notice);
 *   - throttle → wait (cooldown-only, NEVER a model switch);
 *   - model-unavailable → rotate to the next model in the serving entry's chain,
 *     then advance past the entry once its `maxRetries` budget is spent;
 *   - not-fallback → hold (no provider action at all).
 *
 * S-cut (BINDING, folds F5): v1 ships the PINNED chain below + a `find` filter with
 * degrade-on-stale. There is deliberately NO live `/models` re-fetch and NO keyless
 * registration here — custom/keyless entries exist as schema + validation only, and
 * the follow-up's contract is specified in comments (never implemented):
 *   - FETCH (follow-up): refresh the `:free` pool off the hot path (background tick
 *     only, e.g. ≥15 min interval); per-attempt timeout 30 s then keep serving pinned;
 *     offline/fetch failure → pinned chain as-is, degraded + logged; NEVER block a
 *     failure event on network; intersect fetched ids with `modelRegistry.find`
 *     exactly like `resolveTargets` does today.
 *   - TIMEOUT (follow-up): enforce `timeoutMs` per attempt in the wiring with an
 *     abort/timeout race, then feed the selector a synthetic failure event for the
 *     serving target; the selector only CARRIES the value, it never runs timers.
 *   - OFFLINE (v1 = follow-up): failure events decide from pinned + `find` only;
 *     no cached pool, no last-known-good overlay.
 *   - CUSTOM OVERLAY (follow-up): `validateProviderEntry` admits the shape and
 *     `baseUrl`/`extraHeaders` are carried for the pi `ProviderConfigInput` mapping
 *     (`baseUrl`→`baseUrl`, `extraHeaders`→`headers`, `apiKeyEnv`→`apiKey: "$NAME"`);
 *     the actual `registerProvider` call + H11 keyless probe belong to Lane E.
 *
 * Wiring protocol (folds F2/N2 — Lane E composes, tests inject state directly):
 *   1. `filterEligible(entries, env, authByProvider)` → configured entries only;
 *   2. `resolveTargets(eligible, registry, scopedModels)` → flat priority targets;
 *   3. `initialSelectorState(targets)` once per episode (fresh state re-arms);
 *   4. per failure event: `decideNextTarget(state, event)` → serve `{entry, model}`
 *      (then `setModel` + `requiredThinking`→`setThinkingLevel`, Lane B) or hold/wait/
 *      exhausted `{none, reason}` (then notice, Lane B). The returned `state` already
 *      carries cooldowns/attempts/serving — feed it to the next call.
 * NO `registerProvider` for defaults (folds F1-J1 — groq/google/openrouter are pi
 * built-ins; registering a built-in id risks full model-list replacement).
 *
 * Secrets discipline: entries carry env-var NAMES only (`apiKeyEnv`); values are read
 * per call via `env[name]`, never logged, persisted or rendered — reasons and notices
 * name the VARIABLE (`GROQ_API_KEY`), never its content (I3 guards this by scan).
 *
 * TypeBox verdict: REJECTED for this schema. The schema is one flat object with ten
 * fields and three cross-field rules (custom⇒baseUrl, built-in⇒apiKeyEnv, built-in
 * ⇏ baseUrl/extraHeaders); TypeBox would add a runtime dependency to the shipped
 * extension for a check that is ~40 lines hand-rolled. Static shape is covered by
 * `tsc` (`FallbackProviderEntry`); runtime ingestion of custom entries is covered by
 * `validateProviderEntry` + the C15 tests. Revisit only if a second schema appears.
 */

import type { FailureKind, RouterFallbackEnv } from "./router-fallback-core.ts";
import { clampCooldownMs, ROUTER_FALLBACK_COOLDOWN_MAX_MS } from "./router-fallback-core.ts";

// ------------------------------------------------------------------ schema

/** Per-entry rate-limit tuning. All fields optional — H10 defaults apply. */
export interface FallbackRateLimit {
	/** Optional client-side cap (requests/min). Absent = drive off server 429 + cooldown. */
	readonly maxRpm?: number;
	/** Cooldown after a failure before the entry is re-admitted (default 60_000, H10). */
	readonly cooldownMs?: number;
	/** Model-unavailable rotations served per entry before advancing (default 1, H10). */
	readonly maxRetries?: number;
}

/**
 * One fallback provider. Failover priority = array order in `DEFAULT_PROVIDERS`
 * (or the user's order-preserving override — `enabled:false` never reorders).
 */
export interface FallbackProviderEntry {
	/** Failover id: "groq" | "gemini" | "openrouter" | custom slug. */
	readonly id: string;
	/** pi provider id: built-in ("groq"|"google"|"openrouter") or a registered custom id. */
	readonly piProvider: string;
	/** Status-notice display name. */
	readonly label: string;
	/** Env-var NAME only (never a value); absent/empty = keyless custom (never a built-in). */
	readonly apiKeyEnv?: string;
	/** Primary target model id (pi catalog id). */
	readonly model: string;
	/** Ordered intra-provider chain (OpenRouter `:free` rotation; Gemini escalation). */
	readonly models?: readonly string[];
	readonly enabled: boolean;
	/** Custom entries only → pi `ProviderConfig.baseUrl` (follow-up overlay). */
	readonly baseUrl?: string;
	/** Custom entries only → pi `ProviderConfig.headers` (follow-up overlay). */
	readonly extraHeaders?: Readonly<Record<string, string>>;
	/** Per-attempt ceiling, then advance. Carried for the follow-up; v1 never times. */
	readonly timeoutMs?: number;
	readonly rateLimit: FallbackRateLimit;
}

/** Default cooldown (H10): 60 s. Matches Lane A's `clampCooldownMs` default. */
export const FALLBACK_COOLDOWN_MS_DEFAULT = 60_000;

/** Default per-entry retry budget (H10): rotate once, then advance. */
export const FALLBACK_MAX_RETRIES_DEFAULT = 1;

/** Default per-attempt ceiling (H10): 30 s. Carried, enforced by the follow-up. */
export const FALLBACK_TIMEOUT_MS_DEFAULT = 30_000;

/** pi built-in provider ids serving as defaults (folds F1-J1 — never registered). */
export const BUILT_IN_FALLBACK_PROVIDERS = ["groq", "google", "openrouter"] as const;

/** Auth env-var names (values never appear here — I3). */
export const FALLBACK_AUTH_ENV_NAMES = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"] as const;

function frozenEntry(entry: FallbackProviderEntry): FallbackProviderEntry {
	return Object.freeze({
		...entry,
		models: entry.models === undefined ? undefined : Object.freeze([...entry.models]),
		extraHeaders:
			entry.extraHeaders === undefined ? undefined : Object.freeze({ ...entry.extraHeaders }),
		rateLimit: Object.freeze({ ...entry.rateLimit }),
	});
}

/**
 * Frozen default chain (folds F1-J3 corrected IDs — C1/C2 stale IDs appear ONLY as
 * C15 regression fixtures): Groq workhorse → Gemini native (+pro escalation as chain
 * position 2) → OpenRouter `:free` breadth last (50 RPD burst-only).
 */
export const DEFAULT_PROVIDERS: readonly FallbackProviderEntry[] = Object.freeze([
	frozenEntry({
		id: "groq",
		piProvider: "groq",
		label: "Groq",
		apiKeyEnv: "GROQ_API_KEY",
		model: "llama-3.3-70b-versatile",
		enabled: true,
		timeoutMs: FALLBACK_TIMEOUT_MS_DEFAULT,
		rateLimit: { cooldownMs: FALLBACK_COOLDOWN_MS_DEFAULT, maxRetries: 1 },
	}),
	frozenEntry({
		id: "gemini",
		piProvider: "google",
		label: "Gemini",
		apiKeyEnv: "GEMINI_API_KEY",
		model: "gemini-3.1-flash-lite",
		models: ["gemini-3.1-flash-lite", "gemini-3.1-pro-preview"],
		enabled: true,
		timeoutMs: FALLBACK_TIMEOUT_MS_DEFAULT,
		rateLimit: { cooldownMs: FALLBACK_COOLDOWN_MS_DEFAULT, maxRetries: 1 },
	}),
	frozenEntry({
		id: "openrouter",
		piProvider: "openrouter",
		label: "OpenRouter",
		apiKeyEnv: "OPENROUTER_API_KEY",
		model: "z-ai/glm-5.2:free",
		models: [
			"z-ai/glm-5.2:free",
			"poolside/laguna-s-2.1:free",
			"minimax/minimax-m3:free",
			"thinkingmachines/inkling-small:free",
		],
		enabled: true,
		timeoutMs: FALLBACK_TIMEOUT_MS_DEFAULT,
		rateLimit: { cooldownMs: FALLBACK_COOLDOWN_MS_DEFAULT, maxRetries: 1 },
	}),
]);

// ------------------------------------------------------------------ injected views (no pi imports)

/** Minimal auth view Lane E maps from `getProviderAuthStatus(piProvider)`. */
export interface FallbackAuthView {
	readonly configured: boolean;
}

/**
 * Minimal catalog view Lane E maps from `modelRegistry`:
 * `find: (provider, modelId) => { reasoning: model.reasoning } | undefined`.
 */
export interface FallbackRegistryView {
	find(provider: string, modelId: string): { readonly reasoning: boolean } | undefined;
}

/**
 * Minimal scope view Lane E maps from `ctx.scopedModels`:
 * `scopedModels.map((s) => ({ provider: s.model.provider, modelId: s.model.id }))`.
 */
export interface ScopedModelRef {
	readonly provider: string;
	readonly modelId: string;
}

// ------------------------------------------------------------------ eligibility (P2 pure half)

/**
 * Pure eligibility: disabled never serves; an `apiKeyEnv` entry needs a non-blank
 * value in `env` (per-call read) plus `configured !== false` when an auth view is
 * passed; keyless custom (absent/empty name) is eligible on `enabled` alone — while
 * a built-in WITHOUT a key name is a schema violation and never eligible (S2).
 */
export function isEligible(
	entry: FallbackProviderEntry,
	env: RouterFallbackEnv,
	authStatus?: FallbackAuthView,
): boolean {
	if (entry.enabled !== true) return false;
	if (entry.apiKeyEnv === undefined || entry.apiKeyEnv === "") {
		return !(
			BUILT_IN_FALLBACK_PROVIDERS as readonly string[]
		).includes(entry.piProvider);
	}
	const raw = env[entry.apiKeyEnv];
	if (raw === undefined || raw.trim() === "") return false;
	if (authStatus !== undefined && authStatus.configured !== true) return false;
	return true;
}

/** Lane E pre-filter: keep configured entries, preserving priority order. */
export function filterEligible(
	entries: readonly FallbackProviderEntry[],
	env: RouterFallbackEnv,
	authStatusByProvider?: Readonly<Record<string, FallbackAuthView>>,
): FallbackProviderEntry[] {
	return entries.filter((entry) =>
		isEligible(entry, env, authStatusByProvider?.[entry.piProvider]),
	);
}

// ------------------------------------------------------------------ target resolution (P3)

/** One servable (entry, model) pair — the selector decides over this flat list. */
export interface ResolvedTarget {
	readonly entry: FallbackProviderEntry;
	readonly model: string;
	/** Catalog `reasoning` flag, for `requiredThinking`. */
	readonly reasoning: boolean;
}

/** `find` that degrades to `undefined` on stale ids AND on throwing registries. */
function safeFind(
	registry: FallbackRegistryView,
	provider: string,
	modelId: string,
): { readonly reasoning: boolean } | undefined {
	try {
		return registry.find(provider, modelId) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve eligible entries to a flat, priority-ordered target list (one element per
 * chain model, catalog-verified). Non-empty `scopedModels` restricts every entry to
 * its first in-scope + in-catalog candidate — an entry with no in-scope candidate
 * is SKIPPED (an explicit `--models` scope is never violated; HYPOTHESIS-PKG-C-S1,
 * conservative reading of an unspecified corner). Stale ids resolve-or-skip, never
 * throw. Never persists anything (there is no persist knob anywhere in this module).
 */
export function resolveTargets(
	entries: readonly FallbackProviderEntry[],
	registry: FallbackRegistryView,
	scopedModels?: readonly ScopedModelRef[],
): ResolvedTarget[] {
	const scope = scopedModels ?? [];
	const out: ResolvedTarget[] = [];
	for (const entry of entries) {
		try {
			if (entry.enabled !== true) continue;
			const chain =
				entry.models !== undefined && entry.models.length > 0
					? entry.models
					: [entry.model];
			if (scope.length > 0) {
				const inScope = chain.find((modelId) =>
					scope.some((ref) => ref.provider === entry.piProvider && ref.modelId === modelId),
				);
				if (inScope === undefined) continue;
				const found = safeFind(registry, entry.piProvider, inScope);
				if (found === undefined) continue;
				out.push({ entry, model: inScope, reasoning: found.reasoning });
				continue;
			}
			for (const modelId of chain) {
				const found = safeFind(registry, entry.piProvider, modelId);
				if (found === undefined) continue;
				out.push({ entry, model: modelId, reasoning: found.reasoning });
			}
		} catch {
			continue;
		}
	}
	return out;
}

// ------------------------------------------------------------------ thinking (S2)

/**
 * Thinking-level-only union (mirrors pi-agent-core `ThinkingLevel` minus `"off"` —
 * the extension `setThinkingLevel` excludes `"off"`, so non-reasoning targets yield
 * `undefined`: skip the call, the session auto-clamp already landed on off).
 */
export type FallbackThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Explicit level for reasoning targets (HYPOTHESIS-PKG-C-T1: `"low"` is the cheapest
 * level satisfying "explicit level required" for `off:null` catalog maps; the session
 * clamps up per model, and the H7 live probe may revise this default), `undefined`
 * for non-reasoning targets.
 */
export function requiredThinking(reasoning: boolean): FallbackThinkingLevel | undefined {
	return reasoning ? "low" : undefined;
}

// ------------------------------------------------------------------ tuning accessors (H10, Lane A clamp review)

/**
 * Sanitized cooldown for an entry via Lane A's `clampCooldownMs` (reviewed: absent /
 * garbage / negative → 60 s default; above 1 h → capped). Custom entries inherit the
 * same sanitizer as the core helper, so the two can never disagree.
 */
export function entryCooldownMs(entry: FallbackProviderEntry): number {
	return clampCooldownMs(entry.rateLimit?.cooldownMs);
}

/** Sanitized retry budget: positive integers only, anything else → default 1. */
export function entryMaxRetries(entry: FallbackProviderEntry): number {
	const raw = entry.rateLimit?.maxRetries;
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 1
		? raw
		: FALLBACK_MAX_RETRIES_DEFAULT;
}

/**
 * Pure `Retry-After` parse (folds F2/M4 — owned by the selector): delay-seconds
 * (`"120"` → 120_000 ms, header name case-insensitive) or an HTTP-date
 * (date − now, floored at 0, capped at the 1 h backstop). Garbage/missing/negative
 * → `undefined` (caller falls back to `cooldownMs`).
 */
export function parseRetryAfterMs(
	headers: Readonly<Record<string, string>> | undefined,
	now: number,
): number | undefined {
	if (headers === undefined) return undefined;
	let raw: string | undefined;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "retry-after") {
			raw = value;
			break;
		}
	}
	if (raw === undefined) return undefined;
	const text = raw.trim();
	if (/^\d+$/.test(text)) {
		return Math.min(Number(text) * 1000, ROUTER_FALLBACK_COOLDOWN_MAX_MS);
	}
	// A bare (possibly signed) integer that is not delay-seconds is garbage, not a
	// date — `Date.parse("-5")` would otherwise accept it as a year and yield 0,
	// collapsing the wait instead of falling back to `cooldownMs`.
	if (/^-?\d+$/.test(text)) return undefined;
	const at = Date.parse(text);
	if (Number.isNaN(at)) return undefined;
	return Math.min(Math.max(0, at - now), ROUTER_FALLBACK_COOLDOWN_MAX_MS);
}

// ------------------------------------------------------------------ selector state

/** One served target, oldest-first — feeds the `servedBy[]` bus payload (folds F1-J8). */
export interface ServingRecord {
	readonly id: string;
	readonly model: string;
}

/** What `getServingProvider` reports (powers `/fallback status` + bus transitions). */
export interface ServingProvider {
	readonly id: string;
	readonly label: string;
	readonly model: string;
}

/**
 * Selector state. `targets` is the resolved flat list; `cooldownUntilMs`/`attemptsUsed`
 * are keyed by entry id; `servingIndex` points at the serving target; `servedBy`
 * records every serve decision in order. Fresh state per episode re-arms everything.
 */
export interface SelectorState {
	readonly targets: readonly ResolvedTarget[];
	readonly cooldownUntilMs: Readonly<Record<string, number>>;
	readonly attemptsUsed: Readonly<Record<string, number>>;
	readonly servingIndex?: number;
	readonly servedBy: readonly ServingRecord[];
}

/** Failure event feeding the selector (latch/headers mapped by Lane B per M4/B1). */
export interface FallbackFailureEvent {
	readonly kind: FailureKind;
	readonly now: number;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	/** Pre-parsed `Retry-After` (ms); parsed from `responseHeaders` when absent. */
	readonly retryAfterMs?: number;
}

export type DecideNextTargetResult =
	| {
			readonly entry: FallbackProviderEntry;
			readonly model: string;
			readonly state: SelectorState;
	  }
	| {
			readonly none: true;
			readonly reason: string;
			readonly retryAfterMs?: number;
			readonly state: SelectorState;
	  };

/** Fresh per-episode state (defensive copy of the target list). */
export function initialSelectorState(targets: readonly ResolvedTarget[]): SelectorState {
	return { targets: [...targets], cooldownUntilMs: {}, attemptsUsed: {}, servedBy: [] };
}

/** Currently serving provider, if any (feeds status/bus — no separate tracking). */
export function getServingProvider(state: SelectorState): ServingProvider | undefined {
	if (state.servingIndex === undefined) return undefined;
	const target = state.targets[state.servingIndex];
	if (target === undefined) return undefined;
	return { id: target.entry.id, label: target.entry.label, model: target.model };
}

function isCooling(state: SelectorState, entryId: string, now: number): boolean {
	return now < (state.cooldownUntilMs[entryId] ?? 0);
}

/**
 * Effective attempt count: a cooldown that has EXPIRED restores the budget
 * (AC-P4.1 re-admit) — attempts only gate rotation within one cooling epoch.
 */
function effectiveAttempts(state: SelectorState, entryId: string, now: number): number {
	const until = state.cooldownUntilMs[entryId] ?? 0;
	if (until > 0 && now >= until) return 0;
	return state.attemptsUsed[entryId] ?? 0;
}

function cooled(state: SelectorState, entryId: string, untilMs: number): SelectorState {
	return {
		...state,
		cooldownUntilMs: {
			...state.cooldownUntilMs,
			[entryId]: Math.max(state.cooldownUntilMs[entryId] ?? 0, untilMs),
		},
	};
}

function bumped(state: SelectorState, entryId: string): SelectorState {
	return {
		...state,
		attemptsUsed: { ...state.attemptsUsed, [entryId]: (state.attemptsUsed[entryId] ?? 0) + 1 },
	};
}

function serving(state: SelectorState, index: number): SelectorState {
	const target = state.targets[index];
	if (target === undefined) return state;
	return {
		...state,
		servingIndex: index,
		servedBy: [...state.servedBy, { id: target.entry.id, model: target.model }],
	};
}

/** First priority-order target whose entry is not cooling (and not excluded). */
function firstEligible(
	state: SelectorState,
	now: number,
	excludeEntryId?: string,
): { target: ResolvedTarget; index: number } | undefined {
	for (let index = 0; index < state.targets.length; index += 1) {
		const target = state.targets[index];
		if (target.entry.id === excludeEntryId) continue;
		if (isCooling(state, target.entry.id, now)) continue;
		return { target, index };
	}
	return undefined;
}

// ------------------------------------------------------------------ failover policy (P4)

/**
 * Ordered failover over the resolved targets. Returns the serve/hold/wait/exhausted
 * result PLUS the next state (cooldowns/attempts/serving already applied — the
 * wiring feeds `result.state` into the next call). Never throws on any input.
 */
export function decideNextTarget(
	state: SelectorState,
	event: FallbackFailureEvent,
): DecideNextTargetResult {
	const now = event.now;

	if (event.kind === "not-fallback") {
		return { none: true, reason: "hold: not a fallback-class failure — no provider action", state };
	}

	if (state.targets.length === 0) {
		return {
			none: true,
			reason: `no fallback auth: no eligible providers (set ${FALLBACK_AUTH_ENV_NAMES.join(", ")})`,
			state,
		};
	}

	const servingIndex = state.servingIndex;
	const servingTarget =
		servingIndex === undefined ? undefined : state.targets[servingIndex];

	if (event.kind === "throttle") {
		const entry = servingTarget?.entry;
		const cooldown = entry === undefined ? FALLBACK_COOLDOWN_MS_DEFAULT : entryCooldownMs(entry);
		const retryAfter = event.retryAfterMs ?? parseRetryAfterMs(event.responseHeaders, now) ?? 0;
		const waitMs = Math.max(retryAfter, cooldown);
		const next =
			servingTarget === undefined ? state : cooled(state, servingTarget.entry.id, now + waitMs);
		return {
			none: true,
			reason:
				`wait: throttle on ${entry?.id ?? "no serving provider yet"} — ` +
				`retry after ${waitMs}ms (cooldown-only; never switches models)`,
			retryAfterMs: waitMs,
			state: next,
		};
	}

	if (servingTarget === undefined || servingIndex === undefined) {
		const first = firstEligible(state, now);
		if (first === undefined) {
			return {
				none: true,
				reason: "exhausted: every fallback provider is cooling or unconfigured",
				state,
			};
		}
		return { entry: first.target.entry, model: first.target.model, state: serving(state, first.index) };
	}

	const entryId = servingTarget.entry.id;

	if (event.kind === "billing-exhaustion" || event.kind === "auth") {
		const parked = cooled(bumped(state, entryId), entryId, now + entryCooldownMs(servingTarget.entry));
		const next = firstEligible(parked, now, entryId);
		if (next === undefined) {
			return {
				none: true,
				reason:
					event.kind === "auth"
						? `notice: auth failure on ${entryId} with no other configured fallback (set ${FALLBACK_AUTH_ENV_NAMES.join(", ")})`
						: `exhausted: billing failure on ${entryId}; every fallback is cooling or unconfigured`,
				state: parked,
			};
		}
		return { entry: next.target.entry, model: next.target.model, state: serving(parked, next.index) };
	}

	// model-unavailable: rotate within the entry while budget remains, then advance.
	if (effectiveAttempts(state, entryId, now) >= entryMaxRetries(servingTarget.entry)) {
		const parked = cooled(bumped(state, entryId), entryId, now + entryCooldownMs(servingTarget.entry));
		const next = firstEligible(parked, now, entryId);
		if (next === undefined) {
			return {
				none: true,
				reason: `exhausted: ${entryId} retry budget spent; no further target`,
				state: parked,
			};
		}
		return { entry: next.target.entry, model: next.target.model, state: serving(parked, next.index) };
	}
	const spent = bumped(state, entryId);
	for (let index = servingIndex + 1; index < spent.targets.length; index += 1) {
		const candidate = spent.targets[index];
		if (candidate.entry.id !== entryId) break;
		if (isCooling(spent, candidate.entry.id, now)) continue;
		return { entry: candidate.entry, model: candidate.model, state: serving(spent, index) };
	}
	const parked = cooled(spent, entryId, now + entryCooldownMs(servingTarget.entry));
	const next = firstEligible(parked, now, entryId);
	if (next === undefined) {
		return {
			none: true,
			reason: `exhausted: ${entryId} chain spent; no further target`,
			state: parked,
		};
	}
	return { entry: next.target.entry, model: next.target.model, state: serving(parked, next.index) };
}

// ------------------------------------------------------------------ custom-entry schema (C15, docs/schema-only per S2)

export interface ProviderValidation {
	readonly ok: boolean;
	readonly errors: readonly string[];
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runtime gate for user-supplied custom/keyless entries (built-ins are frozen and
 * trusted). Rejects unknown-`piProvider`-without-`baseUrl`, built-ins without
 * `apiKeyEnv`, built-ins carrying `baseUrl`/`extraHeaders` (pi owns those), and bad
 * shapes — with name-only reasons (never values). Never throws, even on garbage.
 */
export function validateProviderEntry(candidate: unknown): ProviderValidation {
	try {
		const errors: string[] = [];
		if (!isRecord(candidate)) return { ok: false, errors: ["entry must be an object"] };
		const { id, piProvider, label, apiKeyEnv, model, models, enabled, baseUrl, extraHeaders, timeoutMs, rateLimit } =
			candidate;
		if (typeof id !== "string" || id.trim() === "") errors.push("id must be a non-empty string");
		if (typeof piProvider !== "string" || piProvider.trim() === "") {
			errors.push("piProvider must be a non-empty string");
		}
		if (typeof label !== "string" || label.trim() === "") {
			errors.push("label must be a non-empty string");
		}
		const isBuiltIn =
			typeof piProvider === "string" &&
			(BUILT_IN_FALLBACK_PROVIDERS as readonly string[]).includes(piProvider);
		if (apiKeyEnv !== undefined && apiKeyEnv !== "") {
			if (typeof apiKeyEnv !== "string" || !ENV_NAME.test(apiKeyEnv)) {
				errors.push("apiKeyEnv must be an env-var NAME (e.g. GROQ_API_KEY), never a value");
			}
		} else if (isBuiltIn) {
			errors.push("built-in entries require apiKeyEnv (absent names are keyless-custom only)");
		}
		if (typeof model !== "string" || model.trim() === "") {
			errors.push("model must be a non-empty string");
		}
		if (models !== undefined) {
			if (
				!Array.isArray(models) ||
				models.length === 0 ||
				models.some((m) => typeof m !== "string" || (m as string).trim() === "")
			) {
				errors.push("models must be a non-empty array of non-empty strings when present");
			}
		}
		if (enabled !== true && enabled !== false) errors.push("enabled must be a boolean");
		if (baseUrl !== undefined) {
			if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
				errors.push("baseUrl must be a non-empty string when present");
			} else if (isBuiltIn) {
				errors.push("built-in entries must omit baseUrl (pi owns built-in routing)");
			}
		} else if (!isBuiltIn && typeof piProvider === "string" && piProvider.trim() !== "") {
			errors.push("custom piProvider entries require baseUrl (unknown provider routing)");
		}
		if (extraHeaders !== undefined) {
			if (
				!isRecord(extraHeaders) ||
				Object.values(extraHeaders).some((v) => typeof v !== "string")
			) {
				errors.push("extraHeaders must be a record of strings when present");
			} else if (isBuiltIn) {
				errors.push("built-in entries must omit extraHeaders (pi owns built-in headers)");
			}
		}
		if (timeoutMs !== undefined) {
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				errors.push("timeoutMs must be a positive finite number when present");
			}
		}
		if (!isRecord(rateLimit)) {
			errors.push("rateLimit must be an object");
		} else {
			const { maxRpm, cooldownMs, maxRetries } = rateLimit;
			if (maxRpm !== undefined && (typeof maxRpm !== "number" || !Number.isFinite(maxRpm) || maxRpm <= 0)) {
				errors.push("rateLimit.maxRpm must be a positive finite number when present");
			}
			if (
				cooldownMs !== undefined &&
				(typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0)
			) {
				errors.push("rateLimit.cooldownMs must be a finite number >= 0 when present");
			}
			if (
				maxRetries !== undefined &&
				(typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 1)
			) {
				errors.push("rateLimit.maxRetries must be an integer >= 1 when present");
			}
		}
		return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
	} catch {
		return { ok: false, errors: ["entry failed validation (unreadable shape)"] };
	}
}
