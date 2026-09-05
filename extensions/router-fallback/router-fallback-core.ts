/**
 * Pure failure-matcher core for the router-fallback extension (PKG-A).
 *
 * Everything the wiring (Lane B: observers, switch execution, `/fallback` command)
 * needs that can be decided without a process, a clock or pi itself lives here:
 * failure classification, retryability recomputation, the one-shot switch edge,
 * and the kill-switch/clamp/cap helpers.
 *
 * Purity rules (house convention, copied from `extensions/monitor/monitor-core.ts`):
 *   - zero imports — matching is regex/prefix only, no `node:vm` needed;
 *   - no wall-clock reads — `now` is injected (reserved for future cooldown edges);
 *   - no fs/net/pi — environment arrives as an injected readonly record, read per call;
 *   - every side effect (setModel, timers, notices, registry) belongs to the wiring.
 *
 * Matching discipline (architect §2, review folds F1–F6):
 *   - substring + status-prefix matching, NEVER exact JSON — folded bodies truncate
 *     at 4000 chars and SDKs re-prefix (`"<status>: <body>"`,
 *     `"<prefix> (<status>): <body>"`), so exact shapes are brittle by construction;
 *   - non-retryable billing signals are checked BEFORE retryable/throttle ones,
 *     pinning `isRetryableAssistantError`'s order in pi-ai `utils/retry.js`
 *     (NON_RETRYABLE test before RETRYABLE test);
 *   - the overflow pre-check runs FIRST — never fallback on context overflow,
 *     mirroring `_isRetryableError` (`agent-session.js`), even when billing text
 *     or a 402 latch is also present.
 *
 * Episode semantics (frozen for Lane B): an episode is an opaque string the WIRING
 * mints. `agent_settled` closes the current episode and `/fallback reset` opens a
 * new one — both by passing a FRESH `episodeId` (any per-episode unique string:
 * counter, uuid). The core spends at most `maxSwitchesPerEpisode` switches per
 * episode and re-arms automatically on a never-before-seen `episodeId`, so a
 * wiring that forgets to reset `switchCount` still cannot switch-loop; the
 * contract is still "new episode ⇒ switchCount 0", enforced cheaply on both sides.
 *
 * Pattern provenance: billing/non-retryable + retryable sets are inline copies of
 * pi-ai `utils/retry.js` (installed 0.84.4) plus the OpenRouter-documented typed
 * codes (`payment_required`, `insufficient credits`, `authentication`) from the
 * d-487 research record §4. Overflow sets are inline copies of pi-ai
 * `utils/overflow.js` OVERFLOW_PATTERNS + NON_OVERFLOW_PATTERNS (quirks included:
 * mirroring must agree with pi, not improve on it). If pi-ai is upgraded, diff
 * these two files (drift flag H-pi84).
 */

export type FailureKind =
	| "billing-exhaustion"
	| "throttle"
	| "auth"
	| "model-unavailable"
	| "not-fallback";

/** What `classifyFailure` decided, plus the human-readable evidence trail. */
export interface FailureClassification {
	readonly kind: FailureKind;
	/** Names the matched signal (pattern source, prefix or latch) — never the raw body. */
	readonly reason: string;
}

/** Input to `classifyFailure`: the folded message plus the last sync status latch. */
export interface ClassifyInput {
	/** Folded `AssistantMessage.errorMessage` (already capped/truncated upstream). No `body` — deleted per F3. */
	readonly errorMessage?: string;
	/** Last `after_provider_response` status the wiring latched (stale by design). */
	readonly afterProviderStatus?: number;
}

// ------------------------------------------------------------------ signal sets
// Inline copies — see module header for provenance. Case-insensitive by construction.

/** Non-retryable billing substrings: retry.js 8 in order, then OpenRouter typed codes. */
const BILLING_PATTERNS = [
	/GoUsageLimitError/i,
	/FreeUsageLimitError/i,
	/Monthly usage limit reached/i,
	/available balance/i,
	/insufficient_quota/i,
	/out of budget/i,
	/quota exceeded/i,
	/billing/i,
	/payment_required/i,
	/insufficient credits/i,
] as const;

/** Auth substrings for prefix-less (mid-stream-folded) 401 texts. */
const AUTH_PATTERNS = [/authentication/i, /invalid credentials/i] as const;

/** No-provider phrase for prefix-less 503 texts. */
const NO_PROVIDER_PATTERNS = [/no available model provider/i] as const;

/**
 * Retryable transient signals. Deliberately narrower than retry.js: transport-level
 * phrases (`ended without`, `network error`, bare `error`) and the generic folded
 * markers must stay `not-fallback` (F1-J5: matching them would also catch
 * `content_filter`), so only status-shaped or unambiguous load signals qualify.
 */
const THROTTLE_PATTERNS = [
	/rate.?limit/i,
	/too many requests/i,
	/429/i,
	/50[024]/i,
	/524/i,
	/overloaded/i,
	/service.?unavailable/i,
	/server.?error/i,
	/internal.?error/i,
] as const;

/** Full retry.js RETRYABLE set — used ONLY by `recomputeRetryability`, never for kinds. */
const RETRYABLE_PATTERNS = [
	/overloaded/i,
	/rate.?limit/i,
	/too many requests/i,
	/429/i,
	/500/i,
	/502/i,
	/503/i,
	/504/i,
	/524/i,
	/service.?unavailable/i,
	/server.?error/i,
	/internal.?error/i,
	/provider.?returned.?error/i,
	/exceeded request buffer limit while retrying upstream/i,
	/network.?error/i,
	/connection.?error/i,
	/connection.?refused/i,
	/connection.?lost/i,
	/other side closed/i,
	/fetch failed/i,
	/getaddrinfo/i,
	/ENOTFOUND/i,
	/EAI_AGAIN/i,
	/upstream.?connect/i,
	/reset before headers/i,
	/socket hang up/i,
	/socket connection was closed/i,
	/timed? out/i,
	/timeout/i,
	/terminated/i,
	/websocket.?closed/i,
	/websocket.?error/i,
	/ended without/i,
	/stream ended before message_stop/i,
	/stream ended before a terminal response event/i,
	/http2 request did not get a response/i,
	/retry delay/i,
	/you can retry your request/i,
	/try your request again/i,
	/please retry your request/i,
	/ResourceExhausted/i,
] as const;

/** Inline copy of pi-ai OVERFLOW_PATTERNS (see module header). */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/range of input length should be/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
] as const;

/** Inline copy of pi-ai NON_OVERFLOW_PATTERNS (exclusions win over overflow). */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i,
	/too many requests/i,
] as const;

/** `"<status>: <body>"` — the `formatProviderError` no-prefix shape. */
const STATUS_PREFIX = /^\s*(\d{3})\s*:/;

/** `"<provider> (<status>): <body>"` — the `formatProviderError` prefixed shape. */
const PROVIDER_STATUS_PREFIX = /^\s*[A-Za-z][\w+.~-]*(?:\s+[A-Za-z][\w+.~-]*)*\s*\((\d{3})\)\s*:/;

/** First status-prefix hit wins: provider-prefixed, then bare. */
function parseStatusPrefix(text: string): number | undefined {
	const provider = PROVIDER_STATUS_PREFIX.exec(text);
	if (provider) return Number(provider[1]);
	const bare = STATUS_PREFIX.exec(text);
	return bare ? Number(bare[1]) : undefined;
}

/** First matching pattern source, for reasons. */
function firstMatch(patterns: readonly RegExp[], text: string): string | undefined {
	for (const pattern of patterns) {
		if (pattern.test(text)) return String(pattern);
	}
	return undefined;
}

/** Text-only overflow check (case 1 of `isContextOverflow`): exclusions win. */
function isOverflowText(text: string): string | undefined {
	if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return undefined;
	return firstMatch(OVERFLOW_PATTERNS, text);
}

/**
 * Classify one folded failure into the 5-kind vocabulary. Order: overflow first,
 * then request-side statuses (400/403/404 always win), then billing (non-retryable
 * before anything retryable), auth, model-unavailable, throttle, the 402 latch
 * OR-input, and finally `not-fallback`.
 */
export function classifyFailure(input: ClassifyInput): FailureClassification {
	const text = input.errorMessage ?? "";
	const statusPrefix = parseStatusPrefix(text);

	const overflow = text !== "" ? isOverflowText(text) : undefined;
	if (overflow !== undefined) {
		return {
			kind: "not-fallback",
			reason: `not-fallback: context-overflow pre-check matched (${overflow}) — never fallback on overflow`,
		};
	}

	if (statusPrefix === 400 || statusPrefix === 403 || statusPrefix === 404) {
		return {
			kind: "not-fallback",
			reason: `not-fallback: HTTP ${statusPrefix} is request-side (never fallback per d-487 §5)`,
		};
	}

	const billing = text !== "" ? firstMatch(BILLING_PATTERNS, text) : undefined;
	if (billing !== undefined) {
		return { kind: "billing-exhaustion", reason: `billing-exhaustion: matched billing signal ${billing}` };
	}
	if (statusPrefix === 402) {
		return { kind: "billing-exhaustion", reason: "billing-exhaustion: status-prefix 402" };
	}

	if (statusPrefix === 401) {
		return { kind: "auth", reason: "auth: status-prefix 401" };
	}
	const auth = text !== "" ? firstMatch(AUTH_PATTERNS, text) : undefined;
	if (auth !== undefined) {
		return { kind: "auth", reason: `auth: matched auth signal ${auth}` };
	}

	if (statusPrefix === 503 || (text !== "" && /503/.test(text))) {
		return { kind: "model-unavailable", reason: "model-unavailable: status 503" };
	}
	const noProvider = text !== "" ? firstMatch(NO_PROVIDER_PATTERNS, text) : undefined;
	if (noProvider !== undefined) {
		return { kind: "model-unavailable", reason: `model-unavailable: matched no-provider signal ${noProvider}` };
	}

	if (
		statusPrefix === 429 ||
		statusPrefix === 500 ||
		statusPrefix === 502 ||
		statusPrefix === 504 ||
		statusPrefix === 524
	) {
		return { kind: "throttle", reason: `throttle: status-prefix ${statusPrefix} (cooldown-only; never switches models)` };
	}
	const throttle = text !== "" ? firstMatch(THROTTLE_PATTERNS, text) : undefined;
	if (throttle !== undefined) {
		return {
			kind: "throttle",
			reason: `throttle: matched retryable signal ${throttle} (cooldown-only; never switches models)`,
		};
	}

	if (input.afterProviderStatus === 402) {
		return { kind: "billing-exhaustion", reason: "billing-exhaustion: after_provider_status 402 latch" };
	}

	return { kind: "not-fallback", reason: "not-fallback: no fallback signal matched" };
}

// ------------------------------------------------------------------ recomputeRetryability (F1-J4)

/** Minimal structural view of the last assistant message — no pi-ai import. */
export interface LastAssistantView {
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly usage?: {
		readonly input?: number;
		readonly cacheRead?: number;
		readonly output?: number;
	};
	/** Model context window for the silent-overflow cases (0/undefined disables them). */
	readonly contextWindow?: number;
}

/** Full `isContextOverflow` mirror (all three cases) over the structural view. */
function isOverflowMessage(message: LastAssistantView): boolean {
	if (
		message.stopReason === "error" &&
		message.errorMessage !== undefined &&
		message.errorMessage !== "" &&
		isOverflowText(message.errorMessage) !== undefined
	) {
		return true;
	}
	const contextWindow = message.contextWindow ?? 0;
	const inputTokens = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
	if (contextWindow > 0 && message.stopReason === "stop" && inputTokens > contextWindow) {
		return true;
	}
	if (
		contextWindow > 0 &&
		message.stopReason === "length" &&
		(message.usage?.output ?? 0) === 0 &&
		inputTokens >= contextWindow * 0.99
	) {
		return true;
	}
	return false;
}

/**
 * Recompute pi's retry verdict for Lane B's `agent_end` guard: overflow pre-check,
 * then the retry.js order (non-retryable first). Lets the wiring hold the switch
 * while pi still has retry budget, without reading pi's session-bus payload.
 */
export function recomputeRetryability(lastAssistant: LastAssistantView): boolean {
	if (isOverflowMessage(lastAssistant)) return false;
	if (lastAssistant.stopReason !== "error" || !lastAssistant.errorMessage) return false;
	if (BILLING_PATTERNS.some((pattern) => pattern.test(lastAssistant.errorMessage as string))) return false;
	return RETRYABLE_PATTERNS.some((pattern) => pattern.test(lastAssistant.errorMessage as string));
}

// ------------------------------------------------------------------ shouldSwitch (one-shot + kill-switch)

/** Environment record the wiring injects per call (usually a `process.env` slice). */
export type RouterFallbackEnv = { readonly [name: string]: string | undefined };

/** Master kill-switch: the literal string `"0"` disables, unset/empty means on. */
export const ROUTER_FALLBACK_ENV = "PI_BADGER_ROUTER_FALLBACK";

/** Per-episode switch budget knob (default 1). */
export const ROUTER_FALLBACK_MAX_SWITCHES_ENV = "PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES";

/** One-shot edge state for one episode. `episodeId` is opaque — see module header. */
export interface RouterFallbackSwitchState {
	/** Opaque episode id minted by the wiring; a new id re-arms the one-shot. */
	readonly episodeId: string;
	/** Switches executed in `switchEpisodeId` (0 with a fresh episode). */
	readonly switchCount: number;
	/** Episode `switchCount` belongs to (undefined = nothing spent yet). */
	readonly switchEpisodeId?: string;
	/** Injected env slice, read per call. */
	readonly env?: RouterFallbackEnv;
}

/** Switch edge decision: advance models exactly once, or hold with a reason. */
export type SwitchDecision =
	| { readonly action: "switch"; readonly reason: string }
	| { readonly action: "hold"; readonly reason: string };

/** True iff the master kill-switch is set to the literal `"0"`. */
export function isDisabled(env: RouterFallbackEnv = {}): boolean {
	return env[ROUTER_FALLBACK_ENV] === "0";
}

/** Per-episode switch budget: unset/empty/garbage → 1; negatives floor at 0 (off). */
export function maxSwitchesPerEpisode(env: RouterFallbackEnv = {}): number {
	const raw = env[ROUTER_FALLBACK_MAX_SWITCHES_ENV];
	if (raw === undefined || raw.trim() === "") return 1;
	const parsed = Math.floor(Number(raw));
	if (!Number.isFinite(parsed)) return 1;
	return Math.max(0, parsed);
}

/**
 * One-shot switch edge: episode budget + kill-switch ONLY (F2/M2 — the `cooldown`
 * action was removed; `throttle` holds here and the PKG-C selector owns the wait).
 * `now` is reserved for future time edges and currently unused.
 */
export function shouldSwitch(
	state: RouterFallbackSwitchState,
	classification: FailureClassification,
	now: number,
): SwitchDecision {
	void now;
	const env = state.env ?? {};
	if (isDisabled(env)) {
		return {
			action: "hold",
			reason: `hold: router fallback disabled via ${ROUTER_FALLBACK_ENV}=0`,
		};
	}
	if (classification.kind === "not-fallback") {
		return { action: "hold", reason: `hold: ${classification.reason}` };
	}
	if (classification.kind === "throttle") {
		return {
			action: "hold",
			reason: "hold: throttle is cooldown-only (PKG-C selector owns the wait); never switches models",
		};
	}
	const budget = maxSwitchesPerEpisode(env);
	const spent = state.switchEpisodeId === state.episodeId ? state.switchCount : 0;
	if (spent >= budget) {
		return {
			action: "hold",
			reason:
				`hold: already switched ${spent}/${budget} this episode (${state.episodeId}; ` +
				`budget via ${ROUTER_FALLBACK_MAX_SWITCHES_ENV})`,
		};
	}
	return {
		action: "switch",
		reason: `switch: ${classification.kind} in episode ${state.episodeId} (${classification.reason})`,
	};
}

// ------------------------------------------------------------------ clamp + cap helpers

/** Default cooldown sanitizer value (PKG-C owns the policy; this only clamps). */
export const ROUTER_FALLBACK_COOLDOWN_DEFAULT_MS = 60_000;

/** Upper bound for a cooldown clamp (mirrors the monitor lifetime max). */
export const ROUTER_FALLBACK_COOLDOWN_MAX_MS = 3_600_000;

/** Clamp a cooldown request: missing/garbage/negative → default; above max → max. */
export function clampCooldownMs(cooldownMs: number | undefined): number {
	if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
		return ROUTER_FALLBACK_COOLDOWN_DEFAULT_MS;
	}
	return Math.min(ROUTER_FALLBACK_COOLDOWN_MAX_MS, cooldownMs);
}

/** Whole-notice cap for one fallback notice card (8 KB, monitor `capTail` precedent). */
export const ROUTER_FALLBACK_NOTICE_CAP_CHARS = 8 * 1024;

/**
 * Cap a notice card into budget, keeping the TAIL (the verdict lives at the end)
 * and marking the drop, so marker + tail together fit exactly.
 */
export function capNoticeText(text: string): string {
	const budget = ROUTER_FALLBACK_NOTICE_CAP_CHARS;
	if (text.length <= budget) return text;
	const marker = (dropped: number) => `[...${dropped} earlier characters dropped]\n`;
	let tailLength = budget - marker(text.length).length;
	if (tailLength <= 0) return `(over the ${Math.max(1, Math.floor(budget / 1024))} KB budget)`.slice(0, budget);
	let head = marker(text.length - tailLength);
	if (head.length + tailLength > budget) {
		tailLength = budget - head.length;
		head = marker(text.length - tailLength);
	}
	return head + text.slice(text.length - tailLength);
}
