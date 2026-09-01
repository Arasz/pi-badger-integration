/**
 * Pure core for the background monitor extension (plan v2 rulings R6/R7/R9, rows M-A1–M-A4).
 *
 * Everything the wiring (wave 2: tools, transition subscription, expiry timers, enforcement)
 * needs that can be decided without a process, a clock or pi itself lives here: predicate
 * compilation and evaluation, the one-shot edge transition, monitor-event content
 * composition, the lifetime/cap clamps and the poll-guard decision.
 *
 * Purity rules (house convention, mirroring the delegation core):
 *   - the only import is node:vm, for the predicate sandbox — nothing touches the filesystem,
 *     the network, child processes or pi;
 *   - no wall-clock reads — lifetimes and windows are computed from injected `now` values;
 *   - every side effect (sendMessage, timers, registry mutation) belongs to the wiring.
 *
 * Why the promise-escape policy exists (R6/M-5): an async IIFE is an *expression* —
 * `(async () => …)()` returns a promise instantly and the 250 ms vm timeout cannot bound
 * what it schedules; a predicate that "waits" inside the sandbox would never fire or would
 * fire on a promise object's truthiness. So any thenable/promise — structurally detected,
 * because a vm-realm Promise is not an `instanceof` the host Promise — and any non-primitive
 * crossing the realm boundary maps to a typed eval-error and disarms the monitor. The
 * sandbox is rebuilt fresh for every evaluation, so a wedged evaluation cannot poison the
 * evaluator: the next healthy predicate still runs.
 */

import { createContext, runInContext, Script } from "node:vm";

// ------------------------------------------------------------------ snapshot shape

/** One live delegation as the wiring snapshots it for predicate evaluation (R6). */
export interface DelegationView {
	readonly id: string;
	readonly agent: string;
	readonly state: string;
	readonly exitCode?: number | null;
}

/**
 * What a predicate evaluates against, rebuilt on every `delegation-transition` event.
 * Deliberately has no `now` and no wall-clock input: predicates evaluate on transitions
 * ONLY (R6) — time-based re-evaluation was rejected by the plan (d-238 S1).
 */
export interface MonitorSnapshot {
	readonly delegations: readonly DelegationView[];
	readonly monitors: readonly { readonly name: string }[];
}

// ------------------------------------------------------------------ predicate evaluation (R6)

/** Character cap on a predicate expression string (4 KB, R6). */
export const PREDICATE_MAX_CHARS = 4096;

/** vm execution timeout for one predicate evaluation (R6). */
export const PREDICATE_TIMEOUT_MS = 250;

/** The outcome of one predicate evaluation: a primitive value or a typed error (R6). */
export type PredicateOutcome =
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "syntax-error"; readonly reason: string }
	| { readonly kind: "eval-error"; readonly reason: string };

/** The registration-time compile check: ok, or the typed syntax error to reject with. */
export type PredicateCompileResult = { readonly kind: "ok" } | { readonly kind: "syntax-error"; readonly reason: string };

/** Why a non-primitive result is an eval-error, not a value (see module header, R6/M-5). */
const NON_PRIMITIVE_REASON =
	"predicate returned a non-primitive (object, array, function or thenable/promise) — " +
	"a monitor predicate must evaluate to a primitive: async IIFEs return a promise instantly " +
	"and the 250 ms timeout cannot bound what they schedule";

/**
 * Wrap the expression so the vm script's completion value is the predicate's value. The plan
 * (R6) specifies `return (${expr})`; a vm Script rejects a top-level return on every runtime
 * (verified: bun 1.4.0 "Return statements are only valid inside functions", node "Illegal
 * return statement"), so the wrap sits inside a function body whose synchronous call is the
 * script — `E` is an expression iff `return (E)` compiles here, preserving the plan's
 * statement-garbage-fails-at-compile contract exactly.
 */
function wrapExpression(predicate: string): string {
	return `(function(){ return (${predicate}) })()`;
}

/**
 * Compile `return (${predicate})` without running it. Registration calls this BEFORE
 * consuming the active-monitor cap: a statement (or an over-cap string) fails here with the
 * typed syntax error, so the caller can reject the registration for free.
 */
export function compilePredicate(predicate: string): PredicateCompileResult {
	if (predicate.length > PREDICATE_MAX_CHARS) {
		return {
			kind: "syntax-error",
			reason: `predicate is ${predicate.length} characters — over the ${PREDICATE_MAX_CHARS}-character cap`,
		};
	}
	try {
		new Script(wrapExpression(predicate), { filename: "monitor-predicate" });
		return { kind: "ok" };
	} catch (err) {
		return { kind: "syntax-error", reason: err instanceof Error ? err.message : String(err) };
	}
}

/** True for anything the promise-escape policy refuses at the realm boundary (M-5). */
function isNonPrimitive(value: unknown): boolean {
	if (typeof value !== "object" && typeof value !== "function") return false;
	if (value === null) return false;
	return true;
}

/**
 * Evaluate one predicate expression against the snapshot (R6). The expression is wrapped as
 * `return (${predicate})` and run in a FRESH vm context per call — the sandbox carries only
 * the snapshot fields (`delegations`, `monitors`), so there is no process/require, no
 * cross-evaluation state and no shadowing machinery. Compile failure → syntax-error; a
 * runtime throw or vm timeout → eval-error; a thenable/non-primitive result → eval-error;
 * otherwise the primitive value.
 */
export function evaluatePredicate(predicate: string, snapshot: MonitorSnapshot): PredicateOutcome {
	const compiled = compilePredicate(predicate);
	if (compiled.kind === "syntax-error") return compiled;

	const context = createContext({ delegations: snapshot.delegations, monitors: snapshot.monitors });
	let value: unknown;
	try {
		value = runInContext(wrapExpression(predicate), context, {
			timeout: PREDICATE_TIMEOUT_MS,
			displayErrors: true,
		});
	} catch (err) {
		return { kind: "eval-error", reason: err instanceof Error ? err.message : String(err) };
	}
	if (isNonPrimitive(value)) return { kind: "eval-error", reason: NON_PRIMITIVE_REASON };
	return { kind: "value", value };
}

// ------------------------------------------------------------------ one-shot edge logic (R7)

/** The transition state of one monitor the registry tracks: name, predicate and armed flag. */
export interface MonitorState {
	readonly name: string;
	readonly predicate: string;
	readonly armed: boolean;
}

/**
 * One edge-transition step (R7): one-shot, edge-triggered. A fire or an error returns the
 * monitor DISARMED (the registry drops it); an idle outcome returns it still armed; a
 * disarmed monitor is a no-op — later transitions evaluate nothing.
 */
export type MonitorEvaluation =
	| { readonly action: "fire"; readonly value: unknown; readonly state: MonitorState }
	| {
			readonly action: "error";
			readonly errorKind: "syntax-error" | "eval-error";
			readonly reason: string;
			readonly state: MonitorState;
	  }
	| { readonly action: "idle"; readonly state: MonitorState }
	| { readonly action: "disarmed"; readonly state: MonitorState };

/**
 * Advance one monitor by one evaluation: armed → fires exactly once on the first truthy
 * evaluation (including the immediately-true registration evaluation), then disarms. A
 * typed predicate error disarms too (M-5). Truthiness is plain JS `Boolean()` on the
 * primitive value — a predicate can only deliver primitives (the promise-escape policy
 * intercepts anything else first, which is precisely why: a vm-realm array or object would
 * otherwise be truthy per JS and fire the monitor spuriously).
 */
export function evaluateMonitor(state: MonitorState, snapshot: MonitorSnapshot): MonitorEvaluation {
	if (!state.armed) return { action: "disarmed", state };
	const outcome = evaluatePredicate(state.predicate, snapshot);
	if (outcome.kind !== "value") {
		return {
			action: "error",
			errorKind: outcome.kind,
			reason: outcome.reason,
			state: { ...state, armed: false },
		};
	}
	if (Boolean(outcome.value)) return { action: "fire", value: outcome.value, state: { ...state, armed: false } };
	return { action: "idle", state };
}

// ------------------------------------------------------- monitor-event composition (R6, ≤ 8 KB)

/** Whole-card cap for one monitor-event message (R6: per-kind content, ≤ 8 KB). */
export const MONITOR_EVENT_CAP_CHARS = 8 * 1024;

/** A registered monitor as the wiring tracks it (R7: armed at register, lifetime clamped). */
export interface MonitorRecord {
	readonly name: string;
	readonly predicate: string;
	readonly registeredAt: number;
	readonly expiresAt: number;
}

export type MonitorEventKind = "fired" | "expired" | "error";

/** The structured payload carried next to the content on the monitor-event wire. */
export type MonitorEventDetails =
	| { readonly kind: "fired"; readonly monitor: string; readonly snapshot: MonitorSnapshot }
	| { readonly kind: "expired"; readonly monitor: string; readonly lifetimeMs: number }
	| { readonly kind: "error"; readonly monitor: string; readonly reason: string };

/** What `pi.sendMessage({customType: "monitor-event", …})` needs: content + details. */
export interface ComposedMonitorEvent {
	readonly content: string;
	readonly details: MonitorEventDetails;
}

/**
 * Cap `text` into what remains of `budget` after `used` characters. Truncation keeps the
 * TAIL (the answer lives at the end) and marks the drop capTail-style, so marker + tail
 * together fit the room exactly and the whole card stays ≤ budget. Local re-derivation of
 * the subagent's capIntoBudget discipline — deliberately not imported from it (module
 * purity: zero extension imports).
 */
function capTail(text: string, used: number, budget: number): string {
	const room = budget - used;
	if (text.length <= room) return text;
	const marker = (dropped: number) => `[...${dropped} earlier characters dropped]\n`;
	let tailLength = room - marker(text.length).length;
	if (tailLength <= 0) {
		// Budget-honest degenerate fallback: never append beyond the caller's remaining room.
		if (room <= 0) return "";
		return `(over the ${Math.max(1, Math.floor(budget / 1024))} KB budget)`.slice(0, room);
	}
	let head = marker(text.length - tailLength);
	if (head.length + tailLength > room) {
		tailLength = room - head.length;
		head = marker(text.length - tailLength);
	}
	return head + text.slice(text.length - tailLength);
}

/** Humanize a monitor lifetime (≤ 60 min by construction): "45s", "1m 30s", "10m". */
function formatMonitorLifetime(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Compose one monitor-event message per kind (R6): a verdict line naming the monitor plus
 * the kind's evidence — a capped snapshot digest for `fired`, the clamped lifetime for
 * `expired`, the typed reason for `error`. The WHOLE content stays ≤ 8 KB (cap-tail
 * discipline above); `details` carries the same facts structured for programmatic readers.
 */
export function composeMonitorEvent(
	kind: "fired",
	record: MonitorRecord,
	detail: { readonly snapshot: MonitorSnapshot },
): ComposedMonitorEvent;
export function composeMonitorEvent(
	kind: "expired",
	record: MonitorRecord,
	detail: { readonly now: number },
): ComposedMonitorEvent;
export function composeMonitorEvent(
	kind: "error",
	record: MonitorRecord,
	detail: { readonly reason: string },
): ComposedMonitorEvent;
export function composeMonitorEvent(
	kind: MonitorEventKind,
	record: MonitorRecord,
	detail: { readonly snapshot: MonitorSnapshot } | { readonly now: number } | { readonly reason: string },
): ComposedMonitorEvent {
	const budget = MONITOR_EVENT_CAP_CHARS;
	let details: MonitorEventDetails;
	let body: string;
	if ("snapshot" in detail) {
		const snap = detail.snapshot;
		let digest: string;
		try {
			digest = JSON.stringify(snap);
		} catch {
			digest = "[unserializable snapshot]"; // never let one circular field kill the fire wire
		}
		const verdict = `Monitor "${record.name}" fired — its condition evaluated true.`;
		const head = `${verdict}\n\nSnapshot: `;
		body = head + capTail(digest, head.length, budget);
		details = { kind: "fired", monitor: record.name, snapshot: snap };
	} else if ("now" in detail) {
		const lifetimeMs = Math.max(0, detail.now - record.registeredAt);
		body = `Monitor "${record.name}" expired after ${formatMonitorLifetime(lifetimeMs)} without its condition evaluating true.`;
		details = { kind: "expired", monitor: record.name, lifetimeMs };
	} else {
		const verdict = `Monitor "${record.name}" error — `;
		body = verdict + capTail(detail.reason, verdict.length, budget);
		details = { kind: "error", monitor: record.name, reason: detail.reason };
	}
	// Belt-and-braces: cap-tail the WHOLE card if anything outside the tracked pieces (e.g. a
	// pathological monitor name) pushed it past the budget. Never fires for sane records.
	if (body.length > budget) body = capTail(body, 0, budget);
	return { content: body, details };
}

// ------------------------------------------------------------------ clamps (R7)

/** Default monitor lifetime: 10 minutes (R7). */
export const MONITOR_TIMEOUT_DEFAULT_MS = 600_000;

/** Upper bound of a monitor lifetime: 60 minutes (R7). */
export const MONITOR_TIMEOUT_MAX_MS = 3_600_000;

/** Floor of a monitor lifetime: 1 s — below it (or absent) the request gets the default. */
export const MONITOR_TIMEOUT_MIN_MS = 1_000;

/** Default active-monitor cap (R7: 8 active, injectable). */
export const MONITOR_CAP_DEFAULT = 8;

/**
 * Clamp a monitor lifetime request (R7): undefined, non-finite or below the 1 s floor means
 * "no real intent" → the 10-minute default; anything above 60 minutes is capped there;
 * in-range values pass through. Clamped, never rejected.
 */
export function clampMonitorTimeoutMs(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < MONITOR_TIMEOUT_MIN_MS) {
		return MONITOR_TIMEOUT_DEFAULT_MS;
	}
	return Math.min(MONITOR_TIMEOUT_MAX_MS, timeoutMs);
}

/**
 * Clamp the active-monitor cap request (R7): undefined or non-finite → the default 8;
 * anything below 1 floors at 1; otherwise the value passes through.
 */
export function clampMonitorCap(cap: number | undefined): number {
	if (typeof cap !== "number" || !Number.isFinite(cap)) return MONITOR_CAP_DEFAULT;
	return Math.max(1, cap);
}

// ------------------------------------------------------------------ poll-guard decision (R9)

/** Default sliding window for manual-polling enforcement: 120 s (R9). */
export const DEFAULT_POLL_WINDOW_MS = 120_000;

/** Default counted-call limit per window: 3 allowed, the 4th is blocked (R9). */
export const DEFAULT_POLL_MAX = 3;

/** The enforcement configuration, injected by the wiring (env-backed, read per call). */
export interface PollGuardConfig {
	readonly windowMs: number;
	readonly max: number;
	readonly enabled: boolean;
}

/** Pure decision for one `delegations list|log` call: allow it, or block it with guidance. */
export type PollingDecision = { readonly action: "allow" } | { readonly action: "block"; readonly reason: string };

/**
 * Decide whether one more manual-polling call is allowed (R9): a sliding window over the
 * timestamps of COUNTED calls — allowed ones and blocked attempts alike, both appended by
 * the caller — and the call being made is blocked iff it would be the (max+1)th in the
 * window. `enabled: false` (env value 0) always allows. A call exactly `windowMs` old has
 * slid out. The reason is composed HERE, so the wiring cannot drift the guidance: it names
 * the attempted count, the window and the alternatives (wait / monitor / end turn).
 */
export function pollingDecision(callTimestamps: readonly number[], now: number, cfg: PollGuardConfig): PollingDecision {
	if (!cfg.enabled) return { action: "allow" };
	const counted = callTimestamps.filter((ts) => now - ts < cfg.windowMs).length;
	if (counted < cfg.max) return { action: "allow" };
	const attempted = counted + 1;
	const windowSeconds = Math.round(cfg.windowMs / 1000);
	const reason =
		`Manual polling blocked: this would be delegations list/log call #${attempted} within the last ${windowSeconds} s (limit ${cfg.max}). ` +
		`Stop polling — use wait to spend idle time, register a monitor to wake on a condition, or end turn and let a monitor-event wake you.`;
	return { action: "block", reason };
}
