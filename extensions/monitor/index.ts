/**
 * ai-badger monitor extension for pi (plan v2 rulings R6/R7/R10, rows M-B1–M-B5): one-shot
 * predicate monitors over delegation transitions. The agent arms a monitor with a JS
 * predicate expression; on every `delegation-transition` event the predicate evaluates
 * against a snapshot of the delegation fleet, and the FIRST truthy evaluation sends one
 * `monitor-event` followUp (deliverAs "followUp", triggerTurn true — the same idle-wake
 * wire the delegation-result cards ride) and disarms the monitor. Expiry, evaluation errors
 * and cancellation each disarm too, with their own card kind.
 *
 * Fleet rebuild rule (the module-level contract predicates can rely on): the wiring keeps an
 * INCREMENTAL map keyed by delegation id, updated from each transition's record as it
 * arrives — a transition carries one delegation's snapshot, but a monitor watching "all
 * settled" must see the WHOLE fleet, so the map persists terminal records instead of
 * mirroring only the live set. The snapshot handed to predicates is therefore
 * `{delegations: <every delegation this session has seen, current state>, monitors: <armed
 * monitor names>}` — no `now`, no wall-clock input (R6: transitions are the only trigger).
 * A fresh session starts with an empty map.
 *
 * Delivery notes:
 *   - the fire card is composed by the pure core (`composeMonitorEvent`) and sent
 *     SYNCHRONOUSLY inside the transition dispatch (M-B1: immediate, unbatched, one wire);
 *   - fire/expiry/error all disarm via the same one-shot rule (core `evaluateMonitor`);
 *   - the expiry timer arms at register through the injectable scheduler and clears on
 *     fire/cancel/expire/shutdown (R7);
 *   - the tool is tui-only in full (register AND list/cancel — R10/N-1): outside tui every
 *     action rejects loudly, because a followUp has no idle session to wake there;
 *   - `interrupt` is accepted and recorded on the monitor (default false) but R7's fire
 *     contract has a single delivery wire — the flag does not branch delivery;
 *   - nothing arms before first use (A6/M-B1): the factory registers only passive surfaces
 *     (tool, renderer, shutdown handler); the transition subscription arms when the first
 *     monitor registers (P7: or a wait starts).
 */

import { Box, Text } from "@earendil-works/pi-tui";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TRANSITION_CHANNEL } from "../subagent/index.ts";
import { DEFAULT_POLL_MAX, DEFAULT_POLL_WINDOW_MS, MONITOR_TIMEOUT_DEFAULT_MS, clampMonitorCap, clampMonitorTimeoutMs, compilePredicate, composeMonitorEvent, evaluateMonitor, formatMonitorLifetime, manualWaitDecision, normalizePredicate, pollingDecision, type DelegationView, type MonitorSnapshot } from "./monitor-core.ts";
import { BASH_COMPILE_TIMEOUT_MS, BASH_PREDICATE_GRACE_MS, BASH_PREDICATE_TIMEOUT_MS, compileBashPredicate, serializeBashSnapshot, startBashPredicate, type BashHandle } from "./bash-predicate.ts";

// ------------------------------------------------------------------ contract constants

/** The monitor-event followUp's custom message type; the renderer below draws it. */
export const MONITOR_CUSTOM_TYPE = "monitor-event";

/** The LLM-facing tool names this extension registers (also on the child denylist, R5). */
export const MONITOR_TOOL_NAME = "monitor";

/** The human command (mirrors /delegations): armed-monitor panel; `cancel <id>` disarms. */
export const MONITOR_COMMAND_NAME = "monitors";

/** The idle-wait tool (R8): pending-tool idiom, resolves on the first wake source. */
export const WAIT_TOOL_NAME = "wait";

/** Default wait ceiling before the fleet snapshot resolves (R8, f: 2026-09-02: 5 min). */
export const WAIT_DEFAULT_MS = 300_000;

/** Reserved name of the idle-wait timer monitor (W-A7): visible in monitor list / /monitors. */
export const WAIT_TIMER_MONITOR_NAME = "wait-timer";

/** Upper bound of a wait (R8: 600 s, clamped not rejected). */
export const WAIT_MAX_MS = 600_000;

/** Custom entry type of the shutdown report (M-B4). */
export const SHUTDOWN_ENTRY_TYPE = "monitor-shutdown";

/** The delegations tool the poll guard counts (R9) — overridable via deps for tests. */
export const POLL_GUARD_TOOL_NAME = "delegations";

/** Env kill switch for the poll guard, read PER CALL (R9/N-4): 0 disables the guard. */
export const POLL_GUARD_ENV = "PI_BADGER_MONITOR_POLL_MAX";
export const WAIT_GUARD_ENV = "PI_BADGER_WAIT_GUARD";

/** Injectable timer seam so tests fire expiry synchronously (R7). */
export interface MonitorScheduler {
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Injectable seams: clock, scheduler, cap, the tui-mode resolver for tests, and the poll
 * guard configuration (the env kill switch and the counted tool name are per-call). */
export interface MonitorDeps {
	/** Injected clock for armedAt/expiry/waited math. Defaults to Date.now. */
	now?: () => number;
	/** Expiry timers (per monitor, R7). Defaults to the global setTimeout/clearTimeout. */
	scheduler?: MonitorScheduler;
	/** Active-monitor cap override (R7: default 8). */
	maxMonitors?: number;
	/** Test seam: resolve a tool context's mode; defaults to reading ctx.mode. */
	mode?: (ctx: unknown) => string | undefined;
	/** Poll-guard overrides (R9): window 120 s, max 3 allowed, counted tool "delegations". */
	pollGuard?: { windowMs?: number; max?: number; toolName?: string };
	/** Bash-predicate seams (bash-predicate.ts): one-evaluation budget (default 5000 ms),
	 * SIGTERM→SIGKILL grace (default 500 ms) and the `bash -n` gate budget (default 2000 ms).
	 * Tests run 50–100 ms evaluation budgets against real short-lived children (M7). */
	bashTimeoutMs?: number;
	bashGraceMs?: number;
	bashCompileTimeoutMs?: number;
}

/** Structural mirror of the subagent's transition payload — the monitor depends on the
 * CHANNEL constant, not on the registry module, so the shape is restated here and kept
 * tolerant: an unrecognizable payload is logged and skipped, never crashes the bus. */
interface TransitionPayload {
	id: string;
	agent: string;
	state: string;
	record: { id: string; agent: string; state: string; exitCode?: number | null };
}

function isTransitionPayload(payload: unknown): payload is TransitionPayload {
	if (typeof payload !== "object" || payload === null) return false;
	const candidate = payload as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.state === "string" &&
		typeof candidate.record === "object" &&
		candidate.record !== null &&
		typeof (candidate.record as Record<string, unknown>).id === "string" &&
		typeof (candidate.record as Record<string, unknown>).state === "string"
	);
}

/** One armed monitor as the wiring tracks it (R7: armed at register, lifetime clamped). */
interface ArmedMonitor {
	id: string;
	name?: string;
	predicate: string;
	/** Predicate kind: 'js' (vm expression, default) or 'bash' (unsandboxed script). */
	predicateKind: "js" | "bash";
	/** M1 per-monitor epoch, captured disarm-before-await: every disarm path (fire, error,
	 * expiry, cancel, shutdown) deletes the record AND bumps this, so a late bash completion
	 * can tell a stale evaluation from a live one. Kill alone is NOT the guard — SIGTERM
	 * delivery races the child's own exit, so completions re-check map membership + epoch. */
	epoch: number;
	/** True while a bash child for this monitor is in flight — concurrent drains skip it. */
	evaluating: boolean;
	/** SHOULD-1: a transition arrived while `evaluating` — the skipped drain must re-run once
	 * against the fresh snapshot after the in-flight child settles idle (coalesced, still one
	 * child at a time). Set in evaluateArmedMonitors, cleared on re-drain. */
	needsRedrain: boolean;
	interrupt: boolean;
	armedAt: number;
	timeoutMs: number;
	expiresAt: number;
	timer?: unknown;
}

/** One in-flight wait (R8): resolve-once; every source cleans up through `settle`. */
interface PendingWait {
	ids?: string[];
	startedAt: number;
	settled: boolean;
	/** W-A7: the idle fleet's auto-armed wait-timer monitor, disarmed silently with the wait. */
	timerMonitorId?: string;
	settle(observed: "delegation" | "monitor" | "input" | "timeout" | "empty" | "aborted", records?: DelegationView[]): void;
	unsubscribe: () => void;
	timer?: unknown;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** The tool result shape every action returns. */
interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details };
}

/**
 * Clamp a wait request (R8): undefined or non-finite → the 5 min default; anything above the
 * 600 s cap is clamped there; 0 and in-range values pass through. Clamped, never rejected.
 */
function clampWaitMs(timeoutMs: number | undefined): number {
	const value = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : WAIT_DEFAULT_MS;
	return Math.min(WAIT_MAX_MS, Math.max(0, value));
}

/** Terminal delegation states — the live/unlive line for waits (a live record never enters
 * `lost`/`stale`; those exist only on log-dir reconstruction, which never transitions here). */
function isTerminalState(state: string): boolean {
	return state === "completed" || state === "failed" || state === "aborted";
}

// ------------------------------------------------------------------ factory

export default function (pi: ExtensionAPI, deps: MonitorDeps = {}) {
	if (typeof pi?.registerTool !== "function") {
		console.error(
			"ai-badger: pi.registerTool is not a function — this pi build's extension API has moved; the monitor tool is not installed.",
		);
		return;
	}

	const now = deps.now ?? Date.now;
	const scheduler: MonitorScheduler = deps.scheduler ?? {
		setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const maxMonitors = clampMonitorCap(deps.maxMonitors);
	const positiveMs = (value: number | undefined, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	const bashTimeoutMs = positiveMs(deps.bashTimeoutMs, BASH_PREDICATE_TIMEOUT_MS);
	const bashGraceMs = positiveMs(deps.bashGraceMs, BASH_PREDICATE_GRACE_MS);
	const bashCompileTimeoutMs = positiveMs(deps.bashCompileTimeoutMs, BASH_COMPILE_TIMEOUT_MS);
	const resolveMode = (ctx: unknown): string | undefined =>
		deps.mode ? deps.mode(ctx) : (ctx as { mode?: string } | undefined)?.mode;

	// ---- session state: armed monitors + the incremental fleet view (see module header)
	const armed = new Map<string, ArmedMonitor>();
	const delegationViews = new Map<string, DelegationView>();
	const pendingWaits = new Set<PendingWait>();
	let monitorSeq = 0;
	let unsubscribeTransition: (() => void) | undefined;
	let inputArmed = false;

	// In-flight bash children by monitor id: expiry/cancel/shutdown kill through these
	// (SIGTERM→grace→SIGKILL); the helper's own in-flight set drains on child exit (S5).
	const bashHandles = new Map<string, Set<BashHandle>>();
	const trackBashHandle = (id: string, handle: BashHandle): void => {
		const set = bashHandles.get(id) ?? new Set<BashHandle>();
		set.add(handle);
		bashHandles.set(id, set);
	};
	const untrackBashHandle = (id: string, handle: BashHandle): void => {
		const set = bashHandles.get(id);
		if (!set) return;
		set.delete(handle);
		if (set.size === 0) bashHandles.delete(id);
	};
	const killBashHandles = (id: string): void => {
		const set = bashHandles.get(id);
		if (!set) return;
		for (const handle of set) handle.kill();
		bashHandles.delete(id);
	};
	const killAllBashHandles = (): void => {
		for (const id of [...bashHandles.keys()]) killBashHandles(id);
	};

	const displayName = (record: ArmedMonitor): string => record.name ?? record.id;

	const coreRecord = (record: ArmedMonitor) => ({
		name: displayName(record),
		predicate: record.predicate,
		registeredAt: record.armedAt,
		expiresAt: record.expiresAt,
	});

	/** The snapshot predicates evaluate against (R6): the whole fleet view + armed names.
	 * Copies, not live objects: the sandbox realm receives host objects by reference, so a
	 * predicate that mutates a delegation view would otherwise falsify the fleet map for every
	 * later monitor and wait (review S1). Frozen belt-and-braces on top of the copy. */
	const currentSnapshot = (): MonitorSnapshot => ({
		delegations: [...delegationViews.values()].map((view) => Object.freeze({ ...view })),
		monitors: [...armed.values()].map((record) => ({ name: displayName(record) })),
	});

	const clearTimer = (record: ArmedMonitor): void => {
		if (record.timer === undefined) return;
		scheduler.clearTimeout(record.timer);
		record.timer = undefined;
	};

	/** The one monitor-event wire: followUp + triggerTurn, unbatched (M-B1). Streaming-parent
	 * behavior is dist-verified (research d-227/d-238, agent-session.js:1103-1128): while the
	 * parent runs, the card queues via agent.followUp and is delivered when the run would
	 * otherwise stop; when idle, triggerTurn starts a run. The fake harness records both
	 * identically, so that distinction carries no row here by construction. */
	const sendMonitorEvent = (content: string, details: Record<string, unknown>): void => {
		pi.sendMessage(
			{ customType: MONITOR_CUSTOM_TYPE, content, display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	/** Disarm + one fired card. The snapshot is built once per evaluation drain. `value` is
	 * bash-only (stdout head-capped, or true) — JS fires omit it (M8, Option B). */
	const fireMonitor = (record: ArmedMonitor, snapshot: MonitorSnapshot, value?: unknown): void => {
		armed.delete(record.id);
		clearTimer(record);
		const event = composeMonitorEvent("fired", coreRecord(record), value === undefined ? { snapshot } : { snapshot, value });
		sendMonitorEvent(event.content, {
			kind: "fired",
			monitorId: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			predicate: record.predicate,
			predicateKind: record.predicateKind,
			...(value === undefined ? {} : { value }),
			firedAt: now(),
			snapshot,
		});
		notifyWaitsOfMonitorFire();
	};

	/** Disarm + one error card, never retried (M-B3). */
	const errorMonitor = (record: ArmedMonitor, reason: string): void => {
		armed.delete(record.id);
		clearTimer(record);
		const event = composeMonitorEvent("error", coreRecord(record), { reason });
		sendMonitorEvent(event.content, {
			kind: "error",
			monitorId: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			predicate: record.predicate,
			predicateKind: record.predicateKind,
			reason,
		});
	};

	/** What one bash evaluation settles to: a real outcome, or "suppressed" when expiry /
	 * shutdown / cancel (or a second fire) disarmed the monitor mid-flight (M1). */
	type BashSettlement =
		| { readonly settlement: "fired"; readonly value: string | true }
		| { readonly settlement: "error"; readonly reason: string }
		| { readonly settlement: "idle" }
		| { readonly settlement: "suppressed" };

	/**
	 * Settle one bash evaluation for an armed monitor: spawn on the per-drain snapshot JSON,
	 * await the mapped outcome, then fire/error/idle — or suppress when the epoch moved.
	 * `signal` (registration only) kills the child on turn abort. Never rejects: the helper's
	 * `done` never rejects and every line below is non-throwing by construction.
	 *
	 * SHOULD-1: an idle completion with `needsRedrain` set (a transition landed mid-flight and
	 * was skipped) re-drains this monitor ONCE against the fresh currentSnapshot() — still one
	 * child at a time (evaluating is false here, true again inside the recursive settle). The
	 * recursion terminates: the flag clears before re-draining, so a quiescent fleet settles
	 * idle with no further spawn.
	 */
	const settleBashEvaluation = async (
		record: ArmedMonitor,
		snapshotJson: string,
		snapshot: MonitorSnapshot,
		signal?: AbortSignal,
	): Promise<BashSettlement> => {
		record.evaluating = true;
		record.epoch += 1;
		const epoch = record.epoch;
		const handle = startBashPredicate(record.predicate, snapshotJson, {
			timeoutMs: bashTimeoutMs,
			graceMs: bashGraceMs,
			...(signal ? { signal } : {}),
		});
		trackBashHandle(record.id, handle);
		const outcome = await handle.done;
		untrackBashHandle(record.id, handle);
		if (armed.get(record.id) !== record || record.epoch !== epoch) return { settlement: "suppressed" };
		record.evaluating = false;
		if (outcome.kind === "fired") {
			fireMonitor(record, snapshot, outcome.value);
			return { settlement: "fired", value: outcome.value };
		}
		if (outcome.kind === "error") {
			errorMonitor(record, outcome.reason);
			return { settlement: "error", reason: outcome.reason };
		}
		if (record.needsRedrain) {
			record.needsRedrain = false;
			if (armed.get(record.id) === record) {
				const fresh = currentSnapshot();
				const reserialized = serializeBashSnapshot(fresh);
				if (reserialized.kind === "error") {
					errorMonitor(record, reserialized.reason);
					return { settlement: "error", reason: reserialized.reason };
				}
				return settleBashEvaluation(record, reserialized.json, fresh);
			}
		}
		return { settlement: "idle" }; // stays armed — the next transition drains again
	};

	/**
	 * One evaluation drain over every armed monitor against the current snapshot. JS runs
	 * FIRST and synchronously (M2: fire/error cards send in the same tick — JS latency never
	 * waits for a bash child); bash follows concurrently on ONE snapshot stringified once.
	 * The bash tail is fire-and-forget from the transition dispatch — every handle settles
	 * through settleBashEvaluation, whose promise never rejects. SHOULD-1: a bash monitor
	 * already evaluating skips this drain but marks needsRedrain, so its idle completion
	 * re-drains once against the fresh snapshot (coalesced, still one child at a time).
	 */
	const evaluateArmedMonitors = (): void => {
		if (armed.size === 0) return;
		const snapshot = currentSnapshot();
		for (const record of [...armed.values()]) {
			if (record.predicateKind !== "js") continue;
			const outcome = evaluateMonitor(
				{ name: displayName(record), predicate: record.predicate, armed: true },
				snapshot,
			);
			if (outcome.action === "fire") fireMonitor(record, snapshot);
			else if (outcome.action === "error") errorMonitor(record, outcome.reason);
			// idle / disarmed: nothing to do — the record stays armed
		}
		const pending = [...armed.values()].filter((record) => record.predicateKind === "bash" && !record.evaluating);
		for (const record of [...armed.values()]) {
			if (record.predicateKind === "bash" && record.evaluating) record.needsRedrain = true;
		}
		if (pending.length === 0) return;
		const serialized = serializeBashSnapshot(snapshot);
		if (serialized.kind === "error") {
			for (const record of pending) errorMonitor(record, serialized.reason); // M5: never throws
			return;
		}
		void Promise.all(pending.map((record) => settleBashEvaluation(record, serialized.json, snapshot)));
	};

	const onTransition = (payload: unknown): void => {
		if (!isTransitionPayload(payload)) {
			console.error("ai-badger monitor: unrecognized payload on the transition channel — skipped");
			return;
		}
		// Rebuild rule: upsert the delegation's view from the transition's record (module header).
		delegationViews.set(payload.record.id, {
			id: payload.record.id,
			agent: payload.record.agent,
			state: payload.record.state,
			exitCode: payload.record.exitCode ?? null,
		});
		evaluateArmedMonitors();
	};

	// ---------------------------------------------------------------- wait sources (R8)

	const viewOf = (record: TransitionPayload["record"]): DelegationView => ({
		id: record.id,
		agent: record.agent,
		state: record.state,
		exitCode: record.exitCode ?? null,
	});

	const fleetSnapshot = (): DelegationView[] => [...delegationViews.values()];

	/** Empty means NO source can ever fire: no live delegation in scope and no armed monitor.
	 * Input/timeout do not count — waiting just to time out is what "empty" exists to prevent.
	 * W-A7: in tui an idle wait arms a wait-timer monitor instead (sleeping IS the request);
	 * `empty` survives as the non-tui fallback (the cap floor is 1, so an idle fleet never
	 * hits it). */
	const nothingToWaitFor = (ids: string[] | undefined): boolean => {
		const views = fleetSnapshot();
		const inScope = ids ? views.filter((view) => ids.includes(view.id)) : views;
		if (inScope.some((view) => view.state === "queued" || view.state === "running")) return false;
		return armed.size === 0;
	};

	const cleanupWait = (wait: PendingWait): void => {
		wait.unsubscribe();
		if (wait.timer !== undefined) {
			scheduler.clearTimeout(wait.timer);
			wait.timer = undefined;
		}
		if (wait.signal && wait.onAbort) wait.signal.removeEventListener("abort", wait.onAbort);
		// W-A7: a still-armed wait-timer monitor disarms SILENTLY with the wait — its expiry
		// card must not arrive after the tool result it was backing (the wait's own timeout won
		// the race; an expired card now would wake a turn that already moved on).
		if (wait.timerMonitorId !== undefined) {
			const timerRecord = armed.get(wait.timerMonitorId);
			if (timerRecord) {
				armed.delete(timerRecord.id);
				clearTimer(timerRecord);
			}
			wait.timerMonitorId = undefined;
		}
		pendingWaits.delete(wait);
	};

	/** W-A7 (f: 2026-09-02): the default wait implementation for an idle fleet — arm a one-shot
	 * timer monitor (never-firing `false` predicate, lifetime = the wait's clamped timeout) so
	 * the wait has something to wait for: one scheduler timer, no polling, visible in monitor
	 * list and /monitors, cancellable like any monitor. The wait keeps blocking; its own
	 * timeout below resolves the tool and cleanupWait disarms the timer silently. Returns
	 * false — arming nothing — outside tui (R10: a followUp wire has no idle session to wake
	 * there); the caller falls back to the immediate `empty` resolve. (No cap check: this path
	 * only runs when armed.size === 0, and the cap floor is 1 — an armed monitor would already
	 * be something to wait for.) */
	const armWaitTimerMonitor = (wait: PendingWait, timeoutMs: number, ctx: unknown): boolean => {
		if (resolveMode(ctx) !== "tui") return false;
		const nowMs = now();
		const record: ArmedMonitor = {
			id: `m-${++monitorSeq}`,
			name: WAIT_TIMER_MONITOR_NAME,
			predicate: "false",
			predicateKind: "js", // the wait-timer monitor is always JS — never a bash child
			epoch: 0,
			evaluating: false,
			needsRedrain: false,
			interrupt: false,
			armedAt: nowMs,
			timeoutMs,
			expiresAt: nowMs + timeoutMs,
		};
		record.timer = scheduler.setTimeout(() => onExpiry(record.id), timeoutMs);
		armed.set(record.id, record);
		wait.timerMonitorId = record.id;
		return true;
	};

	/** The monitor fire path wakes every pending wait — AFTER the current synchronous dispatch
	 * (microtask), so a delegation settle in the same drain wins the tie-break (W-A3) while the
	 * card has already been sent. The payload is never duplicated into the wait result. */
	const notifyWaitsOfMonitorFire = (): void => {
		if (pendingWaits.size === 0) return;
		queueMicrotask(() => {
			for (const wait of [...pendingWaits]) wait.settle("monitor");
		});
	};

	/** The input source is armed ONCE (pi.on has no unsubscribe): a persistent observer that
	 * no-ops while nothing is pending and never consumes or transforms the input (S-1: shipped
	 * behind the Tier-1 emitInput passthrough probe, which passed on this pi build). */
	const ensureInputArmed = (): void => {
		if (inputArmed) return;
		inputArmed = true;
		pi.on("input", () => {
			if (pendingWaits.size === 0) return undefined;
			for (const wait of [...pendingWaits]) wait.settle("input");
			return undefined;
		});
	};

	function waitResult(
		observed: "delegation" | "monitor" | "input" | "timeout" | "empty" | "aborted",
		startedAt: number,
		records?: DelegationView[],
	): ToolResult {
		const waitedMs = Math.max(0, now() - startedAt);
		const first = records?.[0];
		const lines: Record<string, string> = {
			delegation: `Wait resolved: delegation ${first?.id ?? "?"} settled (${first?.state ?? "?"}) after ${formatMonitorLifetime(waitedMs)}.`,
			monitor: `Wait resolved: a monitor fired after ${formatMonitorLifetime(waitedMs)} — see the monitor-event card for the snapshot (not duplicated here).`,
			input: `Wait resolved: the user sent a message after ${formatMonitorLifetime(waitedMs)}.`,
			timeout: `Wait ended: timeout after ${formatMonitorLifetime(waitedMs)} — no watched delegation settled; fleet snapshot in details.`,
			empty:
				"Nothing to wait for — no live delegations and no armed monitors. Start a delegation (delegate) or arm a monitor (monitor register), then wait again.",
			aborted: `Wait ended: aborted (the turn was aborted or the session is shutting down) after ${formatMonitorLifetime(waitedMs)}.`,
		};
		return textResult(lines[observed]!, {
			observed,
			waitedMs,
			...(records !== undefined ? { records } : {}),
		});
	}

	const WaitParams = Type.Object({
		ids: Type.Optional(
			Type.Array(Type.String(), {
				description: "delegate run ids to watch; default: every delegation — the FIRST settle resolves the wait",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description: `give up after this long (default ${WAIT_DEFAULT_MS / 1000}s, max ${WAIT_MAX_MS / 1000}s, clamped) — resolves with a fleet snapshot, never an error`,
			}),
		),
	});
	type WaitParams = { ids?: string[]; timeoutMs?: number };

	async function executeWait(
		_toolCallId: string,
		params: WaitParams,
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: unknown,
	): Promise<ToolResult> {
		// Wait is allowed in EVERY mode (self-degrading) — no gate on purpose (R8); the mode is
		// read only to pick the idle timer arm (W-A7), never to reject.
		const ids = (params.ids ?? []).map((id) => String(id).trim()).filter((id) => id.length > 0);
		const timeoutMs = clampWaitMs(params.timeoutMs);
		const startedAt = now();
		ensureTransitionArmed(); // first use arms the subscription (A6/M-B1)
		ensureInputArmed();

		if (signal?.aborted) return waitResult("aborted", startedAt);

		return await new Promise<ToolResult>((resolve) => {
			const wait: PendingWait = {
				...(ids.length > 0 ? { ids } : {}),
				startedAt,
				settled: false,
				settle: () => {},
				unsubscribe: () => {},
			};
			const finish = (observed: "delegation" | "monitor" | "input" | "timeout" | "empty" | "aborted", records?: DelegationView[]): void => {
				if (wait.settled) return; // resolve-once (W-A3)
				wait.settled = true;
				cleanupWait(wait);
				resolve(waitResult(observed, startedAt, records));
			};
			wait.settle = finish;

			// Tie-break = listener registration order (delegation → monitor → input → timeout):
			// 1. the delegation source subscribes FIRST;
			wait.unsubscribe =
				pi.events?.on(TRANSITION_CHANNEL, (payload: unknown) => {
					if (!isTransitionPayload(payload)) return;
					if (wait.ids && !wait.ids.includes(payload.id)) return;
					if (!isTerminalState(payload.state)) return;
					finish("delegation", [viewOf(payload.record)]);
				}) ?? (() => {});
			// 2. the monitor source joins pendingWaits (fire path notifies);
			pendingWaits.add(wait);
			// 3. the input source is the persistent pi.on("input") observer;
			// 4. the timeout — resolves with a snapshot, never an error.
			wait.timer = scheduler.setTimeout(() => finish("timeout", fleetSnapshot()), timeoutMs);
			// W-A5: the turn's abort signal ends the wait without an unhandled rejection.
			if (signal) {
				const onAbort = (): void => finish("aborted");
				signal.addEventListener("abort", onAbort);
				wait.signal = signal;
				wait.onAbort = onAbort;
			}
			// W-A4: the liveness re-check runs AFTER subscribing — a settle landing between the
			// subscription and this check resolved above; only a truly empty fleet resolves empty.
			queueMicrotask(() => {
				if (wait.settled) return;
				// SHOULD-2: a named id that settled BEFORE the subscribe is still a settle the wait
				// must report (registry.wait(ids) parity) — resolve with its snapshot, never "empty".
				if (wait.ids) {
					const settledViews = fleetSnapshot().filter(
						(view) => wait.ids!.includes(view.id) && isTerminalState(view.state),
					);
					if (settledViews.length > 0) {
						finish("delegation", settledViews);
						return;
					}
				}
				// W-A7: an idle fleet no longer resolves empty in tui — arm the wait-timer monitor
				// and keep blocking. Non-tui (R10: no idle session for a followUp to wake) keeps the
				// immediate `empty` fallback.
				if (nothingToWaitFor(wait.ids) && !armWaitTimerMonitor(wait, timeoutMs, ctx)) {
					finish("empty");
				}
			});
		});
	}

	/** First use arms the subscription (A6/M-B1): never at factory load. session_start arms it
	 * too — the fleet view must accumulate from the session's FIRST transition, not from the
	 * first monitor/wait, or delegations settled before any use would be invisible to waits. */
	const ensureTransitionArmed = (): void => {
		if (unsubscribeTransition || !pi.events) return;
		unsubscribeTransition = pi.events.on(TRANSITION_CHANNEL, onTransition);
	};

	pi.on("session_start", () => {
		ensureTransitionArmed();
	});

	const onExpiry = (id: string): void => {
		const record = armed.get(id);
		if (!record) return;
		armed.delete(id); // the timer already fired — nothing left to clear
		record.epoch += 1; // M1: invalidate in-flight bash evaluations — kill alone is async
		// (SIGTERM delivery races the child's own exit), so completions re-check epoch + map.
		killBashHandles(id); // SIGTERM→grace→SIGKILL; grace timers clear on child exit (S5)
		const event = composeMonitorEvent("expired", coreRecord(record), { now: now() });
		sendMonitorEvent(event.content, {
			kind: "expired",
			monitorId: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			lifetimeMs: Math.max(0, now() - record.armedAt),
		});
		// W-A7: expiry is a monitor wake too — fired cards wake pending waits already, and the
		// idle wait's timer monitor relies on this when its expiry wins the race against the
		// wait's own timeout.
		notifyWaitsOfMonitorFire();
	};

	// ---------------------------------------------------------------- tool

	/** The turn's abort signal, structurally detected (fakes pass undefined). Registration
	 * threads it into the immediate bash eval so an abort kills the child (M3). */
	const asAbortSignal = (value: unknown): AbortSignal | undefined =>
		typeof value === "object" && value !== null && typeof (value as AbortSignal).addEventListener === "function"
			? (value as AbortSignal)
			: undefined;

	/** R10/N-1: the WHOLE tool is tui-only — one gate for every action (M-B5). */
	const requireTui = (ctx: unknown, action: string): void => {
		if (resolveMode(ctx) === "tui") return;
		throw new Error(
			`the monitor tool is tui-only (action "${action}") — it wakes an idle interactive session and there is none in this mode. ` +
				`A delegate call in this mode blocks this turn until the delegation settles (background degrades to blocking) — that is the way to wait here.`,
		);
	};

	const MonitorParams = Type.Object({
		action: Type.Union([Type.Literal("register"), Type.Literal("list"), Type.Literal("cancel")], {
			description: "register: arm a one-shot predicate monitor; list: show armed monitors; cancel: disarm one",
		}),
		predicate: Type.Optional(
			Type.String({
				description:
					"register: the condition. With predicateKind 'js' (default) a bare JS expression — NO `return` keyword, write the condition itself, e.g. `delegations.some(d => d.state === \"completed\")` — evaluated against { delegations, monitors } on every delegation transition. 4 KB cap; must evaluate to a primitive (a promise or object is an error and disarms the monitor). A leading `return` is stripped when the remainder compiles; anything else is rejected with guidance naming the mistake. " +
					"With predicateKind 'bash' a bash script instead (4 KB cap, `bash -n` gate at register): it reads the monitor snapshot JSON on stdin — { delegations, monitors } via stdin, e.g. `grep -q '\"state\":\"completed\"'` — and exit codes decide: 0 fires (trimmed stdout, ≤1 KB, is the fire value; empty means true), 1 is idle, any other exit / signal death / 5 s timeout / spawn failure is an error card and disarms.",
			}),
		),
		predicateKind: Type.Optional(
			Type.Union([Type.Literal("js"), Type.Literal("bash")], {
				description:
					"register: predicate kind — 'js' (default) evaluates the predicate as a JS expression in a vm sandbox; " +
					"'bash' runs it UNSANDBOXED as `bash -c` with your full user privileges (only register what your own agent wrote), " +
					"snapshot JSON on stdin, exit 0 fires / exit 1 idle / anything else error+disarms, 5 s kill, register can block up to 5 s",
			}),
		),
		name: Type.Optional(
			Type.String({
				description: "register: optional short name, echoed on the card and visible to predicates via snapshot.monitors",
			}),
		),
		interrupt: Type.Optional(
			Type.Boolean({ description: "register: recorded on the monitor (default false); delivery is the standard monitor-event wire" }),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description: `register: lifetime in ms — clamped to a default of ${MONITOR_TIMEOUT_DEFAULT_MS / 1000}s and a max of 60min; on expiry the monitor is removed and an expired card is delivered`,
			}),
		),
		id: Type.Optional(Type.String({ description: "cancel: the monitor id (m-N) from the register receipt or monitor list" })),
	});
	type MonitorParams = {
		action: "register" | "list" | "cancel";
		predicate?: string;
		predicateKind?: "js" | "bash";
		name?: string;
		interrupt?: boolean;
		timeoutMs?: number;
		id?: string;
	};

	async function execute(_toolCallId: string, params: MonitorParams, _signal: unknown, _onUpdate: unknown, ctx: unknown): Promise<ToolResult> {
		switch (params.action) {
			case "register":
				return registerMonitor(params, ctx, asAbortSignal(_signal));
			case "list":
				return listMonitors(ctx);
			case "cancel":
				return cancelMonitor(params, ctx);
			default:
				throw new Error(`monitor action must be one of register, list, cancel`);
		}
	}

	async function registerMonitor(params: MonitorParams, ctx: unknown, signal?: AbortSignal): Promise<ToolResult> {
		requireTui(ctx, "register");
		const raw = params.predicate;
		const predicateKind = params.predicateKind ?? "js";
		if (predicateKind !== "js" && predicateKind !== "bash") {
			throw new Error(`monitor register: predicateKind must be "js" or "bash" (got ${JSON.stringify(predicateKind)})`);
		}
		if (typeof raw !== "string" || !raw.trim()) {
			throw new Error(
				predicateKind === "bash"
					? "monitor register needs a predicate — a bash script reading the monitor snapshot JSON on stdin (exit 0 fires, exit 1 is idle)"
					: "monitor register needs a predicate — a bare JS expression (no `return`) evaluated against the snapshot on every delegation transition",
			);
		}
		// Gate BEFORE the cap check — an invalid predicate rejects free (M-B5, M3). M6: bash
		// skips normalizePredicate/compilePredicate entirely (`if...fi` and `return 0` are
		// scripts, not JS expressions, and must survive verbatim); the `bash -n` gate + the
		// shared 4 KB cap are the only registration checks.
		let predicate: string;
		if (predicateKind === "bash") {
			const gate = await compileBashPredicate(raw, { timeoutMs: bashCompileTimeoutMs });
			if (gate.kind === "syntax-error") {
				throw new Error(`monitor rejected — invalid bash predicate: ${gate.reason}`);
			}
			predicate = raw;
		} else {
			// Recover the one known authoring mistake (a leading `return`, the old schema's phrasing
			// copied literally) and store the CLEAN expression: list, cards and the receipt echo the
			// bare predicate the monitor actually evaluates. Compile-check FIRST — a syntax error or
			// an over-cap string rejects without consuming the cap (R6).
			predicate = normalizePredicate(raw);
			const compiled = compilePredicate(predicate);
			if (compiled.kind === "syntax-error") {
				throw new Error(`monitor rejected — invalid predicate: ${compiled.reason}`);
			}
		}
		if (armed.size >= maxMonitors) {
			throw new Error(
				`monitor cap reached — ${armed.size} active monitors: ${[...armed.keys()].join(", ")}. ` +
					`Cancel one with monitor cancel <id> first.`,
			);
		}

		ensureTransitionArmed(); // register is first use: arm the subscription here (M-B1)
		const nowMs = now();
		const timeoutMs = clampMonitorTimeoutMs(params.timeoutMs);
		const record: ArmedMonitor = {
			id: `m-${++monitorSeq}`,
			...(params.name !== undefined && params.name.trim() ? { name: params.name.trim() } : {}),
			predicate,
			predicateKind,
			epoch: 0,
			evaluating: false,
			needsRedrain: false,
			interrupt: params.interrupt === true,
			armedAt: nowMs,
			timeoutMs,
			expiresAt: nowMs + timeoutMs,
		};
		record.timer = scheduler.setTimeout(() => onExpiry(record.id), timeoutMs);
		armed.set(record.id, record);

		// R7: one-shot, edge-triggered, INCLUDING at registration — evaluate once against the
		// current snapshot; an already-true condition fires (or errors) immediately. armed.set
		// ran first, so the monitor's own name is visible in snapshot.monitors (M3).
		const snapshot = currentSnapshot();
		const echo = {
			id: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			predicate,
			predicateKind,
			interrupt: record.interrupt,
			armedAt: record.armedAt,
			timeoutMs: record.timeoutMs,
			expiresAt: record.expiresAt,
		};
		const armedMessage =
			`Monitor ${record.id} armed — evaluates on every delegation transition, fires once when the predicate first evaluates true. ` +
			`Expires in ${formatMonitorLifetime(record.timeoutMs)} (at ${record.expiresAt}).`;
		if (predicateKind === "bash") {
			// The immediate bash eval is AWAITED: register blocks up to the bash budget
			// (default 5 s — documented on the tool) so the receipt names the real outcome;
			// the turn's abort signal kills the child (M3).
			const serialized = serializeBashSnapshot(snapshot);
			if (serialized.kind === "error") {
				errorMonitor(record, serialized.reason);
				return textResult(`Monitor ${record.id} error at registration — disarmed: ${serialized.reason}`, {
					...echo,
					state: "error",
					reason: serialized.reason,
				});
			}
			const settled = await settleBashEvaluation(record, serialized.json, snapshot, signal);
			if (settled.settlement === "suppressed") {
				// Shutdown/cancel raced the immediate eval — the monitor is gone; loud, no phantom receipt.
				throw new Error(
					`monitor ${record.id} was disarmed while its registration evaluation was still running ` +
						`(session shutdown or cancel) — register again if still needed`,
				);
			}
			if (settled.settlement === "fired") {
				return textResult(
					`Monitor ${record.id} fired immediately — its condition was already true; the monitor-event card follows.`,
					{ ...echo, state: "fired", value: settled.value, firedAt: now() },
				);
			}
			if (settled.settlement === "error") {
				return textResult(`Monitor ${record.id} error at registration — disarmed: ${settled.reason}`, {
					...echo,
					state: "error",
					reason: settled.reason,
				});
			}
			return textResult(armedMessage, { ...echo, state: "armed" });
		}
		const outcome = evaluateMonitor({ name: displayName(record), predicate, armed: true }, snapshot);
		if (outcome.action === "fire") {
			fireMonitor(record, snapshot);
			return textResult(
				`Monitor ${record.id} fired immediately — its condition was already true; the monitor-event card follows.`,
				{ ...echo, state: "fired", firedAt: now() },
			);
		}
		if (outcome.action === "error") {
			errorMonitor(record, outcome.reason);
			return textResult(`Monitor ${record.id} error at registration — disarmed: ${outcome.reason}`, {
				...echo,
				state: "error",
				reason: outcome.reason,
			});
		}
		return textResult(armedMessage, { ...echo, state: "armed" });
	}

	function listMonitors(ctx: unknown): ToolResult {
		requireTui(ctx, "list");
		const views = armedList();
		if (views.length === 0) return textResult("no active monitors.", { monitors: [] });
		const nowMs = now();
		const lines = views.map(
			(view) =>
				`${view.id}${view.name !== undefined ? ` (${view.name})` : ""} [${view.predicateKind}] — ${view.predicate} — ` +
				`armed ${formatMonitorLifetime(nowMs - view.armedAt)} ago, expires in ${formatMonitorLifetime(view.expiresAt - nowMs)}` +
				`${view.interrupt ? ", interrupt" : ""}`,
		);
		return textResult(lines.join("\n"), {
			monitors: views.map(({ interrupt: _interrupt, ...rest }) => rest),
		});
	}

	function cancelMonitor(params: MonitorParams, ctx: unknown): ToolResult {
		requireTui(ctx, "cancel");
		const id = params.id?.trim();
		if (!id) throw new Error("monitor cancel needs an id — use monitor list for the active ids");
		const record = disarmMonitor(id);
		return textResult(`Monitor ${id} cancelled.`, {
			id,
			...(record.name !== undefined ? { name: record.name } : {}),
		});
	}

	pi.registerTool({
		name: MONITOR_TOOL_NAME,
		label: "Monitor",
		description: [
			"Arm one-shot predicate monitors over background delegations. Actions:",
			"register predicate — a bare JS expression (no `return`), evaluated against { delegations, monitors } on every delegation transition;",
			"the FIRST true evaluation sends one monitor-event followUp and removes the monitor — one-shot, edge-triggered,",
			"including at registration when the condition is already true),",
			"list (armed monitors), cancel id (disarm one).",
			"Optional name and timeoutMs (default 10 min, max 60 min — expiry delivers an expired card).",
			"A throwing or non-primitive predicate is an error card and disarms the monitor.",
			"With predicateKind 'bash' the predicate is a bash script, not a JS expression: it runs UNSANDBOXED as `bash -c` with your full user privileges — only register what your own agent wrote — reading the monitor snapshot JSON on stdin (never argv/env; env/cwd inherit), e.g. `grep -q '\"state\":\"completed\"'`. Exit 0 fires (trimmed stdout, ≤1 KB, is the fire value; empty means true), exit 1 is idle, any other exit / signal death / 5 s timeout / spawn failure is an error card and disarms.",
			"Registering or draining a bash monitor can block up to 5 s per evaluation; expiry, cancel and shutdown kill in-flight bash children. On Windows bash must be on PATH (Git Bash or WSL).",
			"Prefer monitors or wait over polling delegations list — repeated polling is blocked.",
		].join(" "),
		parameters: MonitorParams,
		execute,
	});

	// ---------------------------------------------------------------- wait tool (R8)

	pi.registerTool({
		name: WAIT_TOOL_NAME,
		label: "Wait",
		description: [
			"Spend idle time without polling: block this turn until the FIRST of — a watched delegation settles",
			"(ids filter; default any live delegation), an armed monitor fires, the user sends a message, or the timeout",
			"(default 5 min, max 600s, clamped — the timeout resolves with a fleet snapshot, never an error). With nothing",
			"live and nothing armed (tui) it arms a `wait-timer` monitor for the timeout and keeps blocking — pass the",
			"wait time as timeoutMs; outside tui it resolves immediately with observed 'empty'.",
			"Allowed in every mode. The result is a terse pointer: a monitor wake's payload rides the monitor-event card,",
			"never this result.",
		].join(" "),
		parameters: WaitParams,
		execute: executeWait,
	});

	// ---------------------------------------------------------------- command (mirrors /delegations)

	/** Head-cap an excerpt at 100 chars with `…` after whitespace collapse — the sibling
	 * /delegations panel's taskExcerpt discipline, applied to predicates here. */
	function excerpt(text: string): string {
		const oneLine = text.replace(/\s+/g, " ").trim();
		return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
	}

	/** The armed monitors as data, shared by the tool's list action and the /monitors command.
	 * Deliberately NO requireTui gate here: the gate belongs to the tool entry (R10). The
	 * command path calls this directly — commands are TUI by definition, and the command path
	 * must not depend on command-ctx `.mode` (folded-plan ruling; runtime presence unverified
	 * on this pi build — the installed types declare it, which is not a runtime guarantee). */
	function armedList(): Array<{
		id: string;
		name?: string;
		predicate: string;
		predicateKind: "js" | "bash";
		interrupt: boolean;
		armedAt: number;
		expiresAt: number;
	}> {
		return [...armed.values()].map((record) => ({
			id: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			predicate: record.predicate,
			predicateKind: record.predicateKind,
			interrupt: record.interrupt,
			armedAt: record.armedAt,
			expiresAt: record.expiresAt,
		}));
	}

	/** Internal disarm WITHOUT the requireTui gate — the /monitors command calls this directly
	 * (same ruling as armedList). Throws the tool's loud unknown-id error. */
	function disarmMonitor(id: string): ArmedMonitor {
		const record = armed.get(id);
		if (!record) throw new Error(`no monitor ${id} — use monitor list for the active ids`);
		armed.delete(id);
		record.epoch += 1; // M1: invalidate in-flight bash evaluations before the async kill lands
		killBashHandles(id);
		clearTimer(record);
		return record;
	}

	/** The /monitors panel: one line per armed monitor — id, name, predicate excerpt, age,
	 * time left. Same empty-state text as the tool's list. */
	function monitorsPanel(): string {
		const views = armedList();
		if (views.length === 0) return "no active monitors.";
		const nowMs = now();
		return views
			.map(
				(view) =>
					`${view.id}${view.name !== undefined ? ` (${view.name})` : ""} [${view.predicateKind}] — ${excerpt(view.predicate)} — ` +
					`armed ${formatMonitorLifetime(nowMs - view.armedAt)} ago, time left ${formatMonitorLifetime(view.expiresAt - nowMs)}`,
			)
			.join("\n");
	}

	/** The command surface's delivery wire (the /delegations precedent): notify with a tone
	 * when there is UI; headless is a SILENT no-op — no invented notify channel. */
	function commandResult(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, type);
	}

	const MONITORS_USAGE_LINE = "usage: /monitors [cancel <id>]";

	pi.registerCommand(MONITOR_COMMAND_NAME, {
		description: "Armed monitor status; `cancel <id>` disarms one.",
		getArgumentCompletions(argumentPrefix) {
			const idPosition = /^cancel\s+(\S*)$/.exec(argumentPrefix);
			if (idPosition) {
				const token = idPosition[1]!;
				const items = armedList()
					.filter((view) => view.id.startsWith(token))
					.map((view) => ({ value: view.id, label: `${view.id}${view.name !== undefined ? ` (${view.name})` : ""}` }));
				return items.length > 0 ? items : null;
			}
			const first = argumentPrefix.trim();
			const subcommands = ["cancel"]
				.filter((verb) => verb.startsWith(first))
				.map((verb) => ({ value: verb, label: verb, description: "disarm one monitor" }));
			return subcommands.length > 0 ? subcommands : null;
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			if (!trimmed) {
				commandResult(ctx, monitorsPanel(), "info");
				return;
			}
			const match = /^cancel\s+(\S+)\s*$/.exec(trimmed);
			if (!match) {
				commandResult(ctx, MONITORS_USAGE_LINE, "info");
				return;
			}
			try {
				const record = disarmMonitor(match[1]!);
				commandResult(ctx, `Monitor ${record.id} cancelled.`, "info");
			} catch (error) {
				commandResult(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// ---------------------------------------------------------------- renderer

	// T72-analog: the compact card the monitor-event followUp renders through. One Box, tone by
	// kind (M-B1 fired success, M-B2 expired warning, M-B3 error error) — the non-batched branch
	// of the delegation-result renderer, since monitor events are never batched.
	pi.registerMessageRenderer(MONITOR_CUSTOM_TYPE, (message, options, theme) => {
		const body = typeof message.content === "string" ? message.content : "";
		if (!body) return undefined;
		const details = message.details as { kind?: string } | undefined;
		const tone = details?.kind === "expired" ? "warning" : details?.kind === "error" ? "error" : "success";
		const box = new Box(options.outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
		const lines = body.split("\n");
		box.addChild(new Text([theme.fg(tone, lines[0] ?? ""), ...lines.slice(1)].join("\n"), 0, 0));
		return box;
	});

	// ---------------------------------------------------------------- poll enforcement (R9)

	// Passive registration at factory time (house precedent: the delegations status surface's
	// tool_call handler) — the STATE starts empty and resets at session_shutdown (E-A2).
	const pollTimestamps: number[] = [];
	const pollToolName = deps.pollGuard?.toolName ?? POLL_GUARD_TOOL_NAME;
	const pollWindowMs = deps.pollGuard?.windowMs ?? DEFAULT_POLL_WINDOW_MS;

	/** The kill switch reads PER CALL (R9/N-4): unset or invalid → the configured default;
	 * 0 → nothing counts while disabled, and earlier timestamps still count once re-enabled
	 * until they age out of the window (pinned by the E-A2 env row). */
	const waitGuardEnabled = (): boolean => {
		const raw = process.env[WAIT_GUARD_ENV];
		return raw === undefined || raw.trim() !== "0"; // "0" disables — the only kill switch
	};

	const shellCommandOf = (call: { toolName?: string; input?: { command?: unknown } } | undefined): string | undefined => {
		if (call?.toolName === undefined || !/^(bash|powershell)$/i.test(call.toolName)) return undefined;
		const command = call.input?.command;
		return typeof command === "string" ? command : undefined;
	};

	const envPollMax = (): { max: number; enabled: boolean } => {
		const fallback = deps.pollGuard?.max ?? DEFAULT_POLL_MAX;
		const raw = process.env[POLL_GUARD_ENV];
		if (raw === undefined || raw.trim() === "") return { max: fallback, enabled: true };
		const value = Number(raw.trim());
		if (!Number.isInteger(value) || value < 0) return { max: fallback, enabled: true };
		if (value === 0) return { max: 0, enabled: false };
		return { max: value, enabled: true };
	};

	pi.on("tool_call", (event) => {
		const call = event as { toolName?: string; input?: { action?: unknown; command?: unknown } } | undefined;
		// Manual-wait guard first (f: 2026-09-02 — "any manual attempt should be redirected on the
		// harness level"): a shell sleep parks the main loop, the exact cost the wait-tool rework
		// exists to avoid. Never counts into the poll-guard window (W-G7).
		if (waitGuardEnabled()) {
			const command = shellCommandOf(call);
			if (command !== undefined) {
				const waitDecision = manualWaitDecision(command);
				if (waitDecision.action === "block") return { block: true, reason: waitDecision.reason };
			}
		}
		if (call?.toolName !== pollToolName) return undefined;
		const action = call.input?.action;
		if (action !== "list" && action !== "log" && action !== "results") return undefined; // wait/abort never counted (E-A2); results is a polling surface too (lane B, B-G1)
		const { max, enabled } = envPollMax();
		if (!enabled) return undefined; // 0 disables — and does not count either
		const nowMs = now();
		const decision = pollingDecision(pollTimestamps, nowMs, { windowMs: pollWindowMs, max, enabled: true });
		pollTimestamps.push(nowMs); // blocked attempts count too (R9/M-3)
		if (decision.action === "block") return { block: true, reason: decision.reason };
		return undefined;
	});

	// ---------------------------------------------------------------- shutdown

	pi.on("session_shutdown", () => {
		const report = [...armed.values()].map((record) => ({
			id: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			ageMs: Math.max(0, now() - record.armedAt),
		}));
		for (const record of armed.values()) {
			clearTimer(record);
			record.epoch += 1; // M1/S5: suppress late bash completions — kill alone is insufficient
		}
		killAllBashHandles(); // SIGTERM→grace→SIGKILL per child; grace timers clear on exit
		armed.clear();
		if (unsubscribeTransition) {
			unsubscribeTransition();
			unsubscribeTransition = undefined;
		}
		// Pending waits resolve terminally (W-A5/S-9c): settle() only builds tool results —
		// nothing sends after shutdown.
		for (const wait of [...pendingWaits]) wait.settle("aborted");
		delegationViews.clear();
		pollTimestamps.length = 0; // the enforcement window is per-session (E-A2/S-9a)
		pi.appendEntry(SHUTDOWN_ENTRY_TYPE, { monitors: report });
	});

	// P7 (wait tool) and P8 (poll enforcement) wire here.
}
