/**
 * PKG-A tests: pure failure-matcher core for the router-failure fallback.
 *
 * Plan: docs/plans/2026-router-failure-free-model-fallback.plan-architect.md §2 (PKG-A),
 * as overridden by docs/plans/2026-router-failure-free-model-fallback.plan-review-folds.md
 * (F1–F6 normative). Row IDs below are the post-fold rows (C1–C14; C15 is Lane C).
 *
 * Fixture provenance (F1-J5 probe, no live key, stub fetch through the worktree-installed
 * pi-ai@0.84.4 streamSimple — see task report for the full capture log):
 *   A1  SSE 429-error chunk over HTTP 200 (d-487 §4 verbatim) → "Rate limit exceeded"
 *   A2  SSE 402-error chunk over HTTP 200 (same envelope shape) → "Your account … insufficient credits. …"
 *   B   HTTP 200 with 402 error envelope → "Stream ended without finish_reason" (generic marker)
 *   C   HTTP 429 + 429 JSON body → '429: {"code":429,…"error_type":"rate_limit_exceeded"}'
 *   D   HTTP 402 + 402 JSON body → '402: {…,"error_type":"payment_required"}'
 *   E   HTTP 401 + 401 JSON body → '401: {…,"error_type":"authentication"}'
 *   F   HTTP 503 + 503 JSON body → '503: {"code":503,…}'
 *   G   HTTP 404 + 404 JSON body → '404: {"code":404,…}'
 * Minimal hand-built fixtures are used ONLY where a row's split-mutation demands a
 * single-signal string (C2′ split, C8′ prefix-only); each is marked HAND-MINIMAL.
 *
 * The `match` helper takes the message string (and optional latch) ONLY — the matcher
 * input carries no `body` field (F3 C8′ forbid; the @ts-expect-error row pins it).
 */

import { describe, expect, test } from "bun:test";
import {
	ROUTER_FALLBACK_ENV,
	ROUTER_FALLBACK_MAX_SWITCHES_ENV,
	ROUTER_FALLBACK_NOTICE_CAP_CHARS,
	capNoticeText,
	classifyFailure,
	clampCooldownMs,
	isDisabled,
	maxSwitchesPerEpisode,
	recomputeRetryability,
	shouldSwitch,
	type RouterFallbackSwitchState,
} from "../../extensions/router-fallback/router-fallback-core.ts";

/** Fixed epoch so nothing in this suite touches the clock. */
const NOW = 1_700_000_000_000;

/**
 * Thin wrapper over the frozen PKG-A input: a message string plus the optional
 * after_provider_response latch. No body param exists by design (C8′ forbid).
 */
function match(errorMessage: string | undefined, afterProviderStatus?: number) {
	return classifyFailure({ errorMessage, afterProviderStatus });
}

/** Fresh one-shot state for one episode: nothing spent yet. */
function freshEpisode(episodeId = "ep-1", env: Record<string, string | undefined> = {}): RouterFallbackSwitchState {
	return { episodeId, switchCount: 0, switchEpisodeId: undefined, env };
}

// Probe captures (verbatim — see header).
const SSE_429_FOLD = "Rate limit exceeded";
const SSE_402_FOLD =
	"Your account or API key has insufficient credits. Add more credits and retry the request.";
const ENVELOPE_200_FOLD = "Stream ended without finish_reason";
const HTTP_429_FOLD =
	'429: {"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}}';
const HTTP_402_FOLD =
	'402: {"code":402,"message":"Your account or API key has insufficient credits. Add more credits and retry the request.","metadata":{"error_type":"payment_required"}}';
const HTTP_401_FOLD =
	'401: {"code":401,"message":"Invalid credentials (disabled API key)","metadata":{"error_type":"authentication"}}';
const HTTP_503_FOLD =
	'503: {"code":503,"message":"There is no available model provider that meets your routing requirements"}';
const HTTP_404_FOLD = '404: {"code":404,"message":"Model not found: no-such-model"}';

// ------------------------------------------------------------------ C1 throttle

describe("C1: 429 without billing text → throttle (cooldown-only, never a model switch)", () => {
	test("HTTP 429 fold classifies as throttle", () => {
		expect(match(HTTP_429_FOLD, 429).kind).toBe("throttle");
	});

	test("throttle never switches models: shouldSwitch holds (cooldown lives in PKG-C)", () => {
		const classification = match(HTTP_429_FOLD, 429);
		const decision = shouldSwitch(freshEpisode(), classification, NOW);
		expect(decision.action).toBe("hold");
		expect(decision.reason).toMatch(/throttle/i);
	});
});

// ------------------------------------------------------------------ C2′ billing-exhaustion

describe("C2′: folded 402 → billing-exhaustion (split single-signal fixtures)", () => {
	test("probe HTTP 402 fold with 402 latch → billing-exhaustion", () => {
		expect(match(HTTP_402_FOLD, 402).kind).toBe("billing-exhaustion");
	});

	test("payment_required alone suffices (HAND-MINIMAL: no other billing signal)", () => {
		expect(match("402: payment_required: quota depleted for this key", 402).kind).toBe(
			"billing-exhaustion",
		);
	});

	test("insufficient credits alone suffices (HAND-MINIMAL: no payment_required)", () => {
		expect(
			match("402: Your account has insufficient credits. Top up to continue.", 402).kind,
		).toBe("billing-exhaustion");
	});
});

// ------------------------------------------------------------------ C3 auth

describe("C3: 401 / authentication → auth", () => {
	test("probe HTTP 401 fold → auth", () => {
		expect(match(HTTP_401_FOLD, 401).kind).toBe("auth");
	});

	test("bare mid-stream-style 401 text without prefix → auth", () => {
		expect(match("Invalid credentials (OAuth session expired)", undefined).kind).toBe("auth");
	});
});

// ------------------------------------------------------------------ C4′ streaming 429 fold

describe("C4′: folded SSE 429 (probe A1) with a 200 latch → throttle", () => {
	test("probe capture classifies as throttle despite the benign latch", () => {
		const result = match(SSE_429_FOLD, 200);
		expect(result.kind).toBe("throttle");
	});

	test("throttle holds the switch (cooldown-only)", () => {
		const decision = shouldSwitch(freshEpisode(), match(SSE_429_FOLD, 200), NOW);
		expect(decision.action).toBe("hold");
	});
});

// ------------------------------------------------------------------ C5′ streaming 402 fold

describe("C5′: folded SSE 402 (probe A2) with a 200 latch → billing-exhaustion", () => {
	test("probe capture classifies as billing-exhaustion despite the 200 latch", () => {
		expect(match(SSE_402_FOLD, 200).kind).toBe("billing-exhaustion");
	});

	test("fresh-episode billing switches", () => {
		const decision = shouldSwitch(freshEpisode(), match(SSE_402_FOLD, 200), NOW);
		expect(decision.action).toBe("switch");
	});
});

// ------------------------------------------------------------------ C6/C9 never-fallback statuses

describe("C6/C9: 400/403/404 → not-fallback", () => {
	test("400 → not-fallback", () => {
		expect(match("400: Invalid request: provenance field is required", 400).kind).toBe(
			"not-fallback",
		);
	});

	test("probe HTTP 404 fold → not-fallback", () => {
		expect(match(HTTP_404_FOLD, 404).kind).toBe("not-fallback");
	});

	test("403 → not-fallback", () => {
		expect(match("403: Forbidden: key lacks access to this model", 403).kind).toBe("not-fallback");
	});

	test("400/403/404 prefix wins even when billing text is present (d-487 §5: always)", () => {
		expect(match("403: billing account suspended, contact support", 403).kind).toBe(
			"not-fallback",
		);
	});
});

// ------------------------------------------------------------------ C7 model-unavailable

describe("C7: 503 / no-provider → model-unavailable", () => {
	test("probe HTTP 503 fold → model-unavailable", () => {
		expect(match(HTTP_503_FOLD, 503).kind).toBe("model-unavailable");
	});

	test("fresh-episode model-unavailable switches", () => {
		expect(shouldSwitch(freshEpisode(), match(HTTP_503_FOLD, 503), NOW).action).toBe("switch");
	});
});

// ------------------------------------------------------------------ C8′ prefix/substring twins + forbid

describe("C8′: prefix twin, substring twin, body-arg forbid", () => {
	test("prefix twin: bare 402 prefix with neutral text → billing-exhaustion via prefix (HAND-MINIMAL)", () => {
		const result = match("402: request denied, top up required to continue", 402);
		expect(result.kind).toBe("billing-exhaustion");
		expect(result.reason).toMatch(/prefix 402/);
	});

	test("substring twin: billing keyword deep in a 4000-char body with a 429 prefix → billing-exhaustion", () => {
		const body = (`429: ${"y".repeat(3975)}insufficient_quota`).slice(0, 4000);
		expect(match(body, 429).kind).toBe("billing-exhaustion");
	});

	test("matcher input carries no body field", () => {
		// @ts-expect-error — body was deleted from the matcher input (F3 C8′ forbid)
		classifyFailure({ errorMessage: "402: x", body: { code: 402 } });
	});
});

// ------------------------------------------------------------------ C10 order pin

describe("C10: non-retryable checked before retryable (order pin)", () => {
	test("429 text carrying insufficient_quota → billing-exhaustion, not throttle", () => {
		expect(match("429: insufficient_quota: quota exceeded for project proj-9", 429).kind).toBe(
			"billing-exhaustion",
		);
	});
});

// ------------------------------------------------------------------ C11 reason twins

describe("C11: reasons name the matched signal", () => {
	test("billing reason names the billing signal", () => {
		const result = match("429: insufficient_quota: quota exceeded for project proj-9", 429);
		expect(result.reason).toContain("insufficient_quota");
	});

	test("throttle reason names the throttle signal (substring path)", () => {
		const result = match(SSE_429_FOLD, 200);
		expect(result.kind).toBe("throttle");
		expect(result.reason).toContain("rate.?limit");
	});
});

// ------------------------------------------------------------------ C12 provider prefix

describe("C12: provider-prefixed status shape → billing-exhaustion", () => {
	test("OpenRouter (402) with billing text → billing-exhaustion", () => {
		expect(
			match(
				"OpenRouter (402): Your account or API key has insufficient credits. Add more credits and retry the request.",
				402,
			).kind,
		).toBe("billing-exhaustion");
	});
});

// ------------------------------------------------------------------ C13 metadata tolerance

describe("C13: substring matching tolerates injected whitespace/metadata", () => {
	test("402 fold with injected newlines and an extra field still → billing-exhaustion", () => {
		const injected = HTTP_402_FOLD.replace(
			'"metadata"',
		 '"request_id": "req-abc-123",\n  "metadata"',
		).replaceAll(",", ",\n ");
		expect(match(injected, 402).kind).toBe("billing-exhaustion");
	});
});

// ------------------------------------------------------------------ C14 overflow pre-check

describe("C14: overflow + billing → not-fallback (overflow pre-check runs first)", () => {
	const OVERFLOW_BILLING =
		"402: payment_required: This endpoint's maximum context length is 200000 tokens. However, you requested about 265330 tokens";

	test("overflow text with billing signal → not-fallback", () => {
		const result = match(OVERFLOW_BILLING, 402);
		expect(result.kind).toBe("not-fallback");
		expect(result.reason).toMatch(/overflow/i);
	});

	test("overflow beats even a 402 latch", () => {
		expect(match(OVERFLOW_BILLING, 402).kind).toBe("not-fallback");
	});

	test("pure overflow without billing → not-fallback", () => {
		expect(
			match(
				"This endpoint's maximum context length is 200000 tokens. However, you requested about 265330 tokens",
				200,
			).kind,
		).toBe("not-fallback");
	});
});

// ------------------------------------------------------------------ generic markers (J5 hold+notice)

describe("generic folded markers carry no signal → not-fallback", () => {
	test("probe 200-envelope fold → not-fallback", () => {
		expect(match(ENVELOPE_200_FOLD, 200).kind).toBe("not-fallback");
	});

	test("content_filter fold → not-fallback (never billing)", () => {
		expect(match("Provider finish_reason: content_filter", 200).kind).toBe("not-fallback");
	});

	test("missing message and latch → not-fallback", () => {
		expect(match(undefined, undefined).kind).toBe("not-fallback");
		expect(match("", undefined).kind).toBe("not-fallback");
	});
});

// ------------------------------------------------------------------ 402-latch OR-input

describe("402 latch is an OR-input for billing", () => {
	test("402 latch alone (no message) → billing-exhaustion", () => {
		expect(match(undefined, 402).kind).toBe("billing-exhaustion");
	});

	test("non-402 latches never force a kind", () => {
		expect(match(SSE_429_FOLD, 429).kind).toBe("throttle");
		expect(match("boom", 500).kind).toBe("not-fallback");
	});
});

// ------------------------------------------------------------------ shouldSwitch one-shot + kill-switch

describe("shouldSwitch: one switch per episode + kill-switch", () => {
	test("first billing failure in an episode → switch", () => {
		const decision = shouldSwitch(freshEpisode(), match(SSE_402_FOLD, 200), NOW);
		expect(decision.action).toBe("switch");
		expect(decision.reason).toMatch(/ep-1/);
	});

	test("second billing failure in the same episode → hold (no switch loop)", () => {
		const spent: RouterFallbackSwitchState = {
			episodeId: "ep-1",
			switchCount: 1,
			switchEpisodeId: "ep-1",
			env: {},
		};
		const decision = shouldSwitch(spent, match(SSE_402_FOLD, 200), NOW);
		expect(decision.action).toBe("hold");
	});

	test("a new episodeId re-arms the one-shot even with a stale count", () => {
		const stale: RouterFallbackSwitchState = {
			episodeId: "ep-2",
			switchCount: 1,
			switchEpisodeId: "ep-1",
			env: {},
		};
		expect(shouldSwitch(stale, match(SSE_402_FOLD, 200), NOW).action).toBe("switch");
	});

	test("master kill-switch =0 → hold naming PI_BADGER_ROUTER_FALLBACK", () => {
		const decision = shouldSwitch(
			freshEpisode("ep-1", { [ROUTER_FALLBACK_ENV]: "0" }),
			match(SSE_402_FOLD, 200),
			NOW,
		);
		expect(decision.action).toBe("hold");
		expect(decision.reason).toContain(ROUTER_FALLBACK_ENV);
	});

	test("max-switches =0 → hold naming PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES", () => {
		const decision = shouldSwitch(
			freshEpisode("ep-1", { [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "0" }),
			match(SSE_402_FOLD, 200),
			NOW,
		);
		expect(decision.action).toBe("hold");
		expect(decision.reason).toContain(ROUTER_FALLBACK_MAX_SWITCHES_ENV);
	});

	test("auth switches on a fresh episode", () => {
		expect(shouldSwitch(freshEpisode(), match(HTTP_401_FOLD, 401), NOW).action).toBe("switch");
	});
});

// ------------------------------------------------------------------ recomputeRetryability (F1-J4)

describe("recomputeRetryability mirrors _isRetryableError (overflow first, retry.js order)", () => {
	test("retryable 500 text → true", () => {
		expect(
			recomputeRetryability({ stopReason: "error", errorMessage: "500 Service Unavailable" }),
		).toBe(true);
	});

	test("throttle-shaped 429 text without billing → true", () => {
		expect(recomputeRetryability({ stopReason: "error", errorMessage: HTTP_429_FOLD })).toBe(true);
	});

	test("billing-shaped 402 text → false", () => {
		expect(recomputeRetryability({ stopReason: "error", errorMessage: HTTP_402_FOLD })).toBe(false);
	});

	test("429 text carrying insufficient_quota → false (non-retryable first)", () => {
		expect(
			recomputeRetryability({
				stopReason: "error",
				errorMessage: "429: insufficient_quota: quota exceeded",
			}),
		).toBe(false);
	});

	test("overflow text → false even with retryable wording nearby", () => {
		expect(
			recomputeRetryability({
				stopReason: "error",
				errorMessage:
					"This endpoint's maximum context length is 200000 tokens. However, you requested about 265330 tokens",
			}),
		).toBe(false);
	});

	test("non-error stopReasons and missing messages → false", () => {
		expect(recomputeRetryability({ stopReason: "stop" })).toBe(false);
		expect(recomputeRetryability({ stopReason: "error" })).toBe(false);
		expect(recomputeRetryability({})).toBe(false);
	});
});

// ------------------------------------------------------------------ kill / clamp / cap helpers

describe("kill-switch, clamp and cap helpers", () => {
	test("isDisabled is a literal \"0\" check, unset/empty means on", () => {
		expect(isDisabled({ [ROUTER_FALLBACK_ENV]: "0" })).toBe(true);
		expect(isDisabled({})).toBe(false);
		expect(isDisabled({ [ROUTER_FALLBACK_ENV]: "" })).toBe(false);
		expect(isDisabled({ [ROUTER_FALLBACK_ENV]: "1" })).toBe(false);
	});

	test("maxSwitchesPerEpisode defaults to 1 and tolerates garbage", () => {
		expect(maxSwitchesPerEpisode({})).toBe(1);
		expect(maxSwitchesPerEpisode({ [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "3" })).toBe(3);
		expect(maxSwitchesPerEpisode({ [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "lots" })).toBe(1);
		expect(maxSwitchesPerEpisode({ [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "0" })).toBe(0);
	});

	test("clampCooldownMs defaults, floors and caps", () => {
		expect(clampCooldownMs(undefined)).toBe(60_000);
		expect(clampCooldownMs(Number.NaN)).toBe(60_000);
		expect(clampCooldownMs(-5)).toBe(60_000);
		expect(clampCooldownMs(5_000)).toBe(5_000);
		expect(clampCooldownMs(99 * 3_600_000)).toBe(3_600_000);
	});

	test("notice cap keeps the whole card within 8 KB, tail-first", () => {
		expect(ROUTER_FALLBACK_NOTICE_CAP_CHARS).toBe(8 * 1024);
		const long = `head-marker ${"x".repeat(20_000)} tail-marker`;
		const capped = capNoticeText(long);
		expect(capped.length).toBeLessThanOrEqual(8 * 1024);
		expect(capped).toContain("tail-marker");
		expect(capNoticeText("short")).toBe("short");
	});
});
