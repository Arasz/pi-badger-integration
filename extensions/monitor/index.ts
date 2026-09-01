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
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TRANSITION_CHANNEL } from "../subagent/index.ts";
import {
	type DelegationView,
	clampMonitorCap,
	clampMonitorTimeoutMs,
	compilePredicate,
	composeMonitorEvent,
	evaluateMonitor,
	MONITOR_TIMEOUT_DEFAULT_MS,
	type MonitorSnapshot,
} from "./monitor-core.ts";

// ------------------------------------------------------------------ contract constants

/** The monitor-event followUp's custom message type; the renderer below draws it. */
export const MONITOR_CUSTOM_TYPE = "monitor-event";

/** The LLM-facing tool names this extension registers (also on the child denylist, R5). */
export const MONITOR_TOOL_NAME = "monitor";

/** Custom entry type of the shutdown report (M-B4). */
export const SHUTDOWN_ENTRY_TYPE = "monitor-shutdown";

/** Injectable timer seam so tests fire expiry synchronously (R7). */
export interface MonitorScheduler {
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Injectable seams: clock, scheduler, cap, and the tui-mode resolver for tests. */
export interface MonitorDeps {
	/** Injected clock for armedAt/expiry/waited math. Defaults to Date.now. */
	now?: () => number;
	/** Expiry timers (per monitor, R7). Defaults to the global setTimeout/clearTimeout. */
	scheduler?: MonitorScheduler;
	/** Active-monitor cap override (R7: default 8). */
	maxMonitors?: number;
	/** Test seam: resolve a tool context's mode; defaults to reading ctx.mode. */
	mode?: (ctx: unknown) => string | undefined;
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

/** Humanize a remaining/elapsed monitor lifetime: "45s", "1m30s", "10m". */
function humanizeMs(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** One armed monitor as the wiring tracks it (R7: armed at register, lifetime clamped). */
interface ArmedMonitor {
	id: string;
	name?: string;
	predicate: string;
	interrupt: boolean;
	armedAt: number;
	timeoutMs: number;
	expiresAt: number;
	timer?: unknown;
}

/** The tool result shape every action returns. */
interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details };
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
	const resolveMode = (ctx: unknown): string | undefined =>
		deps.mode ? deps.mode(ctx) : (ctx as { mode?: string } | undefined)?.mode;

	// ---- session state: armed monitors + the incremental fleet view (see module header)
	const armed = new Map<string, ArmedMonitor>();
	const delegationViews = new Map<string, DelegationView>();
	let monitorSeq = 0;
	let unsubscribeTransition: (() => void) | undefined;

	const displayName = (record: ArmedMonitor): string => record.name ?? record.id;

	const coreRecord = (record: ArmedMonitor) => ({
		name: displayName(record),
		predicate: record.predicate,
		registeredAt: record.armedAt,
		expiresAt: record.expiresAt,
	});

	/** The snapshot predicates evaluate against (R6): the whole fleet view + armed names. */
	const currentSnapshot = (): MonitorSnapshot => ({
		delegations: [...delegationViews.values()],
		monitors: [...armed.values()].map((record) => ({ name: displayName(record) })),
	});

	const clearTimer = (record: ArmedMonitor): void => {
		if (record.timer === undefined) return;
		scheduler.clearTimeout(record.timer);
		record.timer = undefined;
	};

	/** The one monitor-event wire: followUp + triggerTurn, unbatched (M-B1). */
	const sendMonitorEvent = (content: string, details: Record<string, unknown>): void => {
		pi.sendMessage(
			{ customType: MONITOR_CUSTOM_TYPE, content, display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	/** Disarm + one fired card. The snapshot is built once per evaluation drain. */
	const fireMonitor = (record: ArmedMonitor, snapshot: MonitorSnapshot): void => {
		armed.delete(record.id);
		clearTimer(record);
		const event = composeMonitorEvent("fired", coreRecord(record), { snapshot });
		sendMonitorEvent(event.content, {
			kind: "fired",
			monitorId: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			predicate: record.predicate,
			firedAt: now(),
			snapshot,
		});
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
			reason,
		});
	};

	/** One evaluation drain over every armed monitor against the current snapshot. */
	const evaluateArmedMonitors = (): void => {
		if (armed.size === 0) return;
		const snapshot = currentSnapshot();
		for (const record of [...armed.values()]) {
			const outcome = evaluateMonitor(
				{ name: displayName(record), predicate: record.predicate, armed: true },
				snapshot,
			);
			if (outcome.action === "fire") fireMonitor(record, snapshot);
			else if (outcome.action === "error") errorMonitor(record, outcome.reason);
			// idle / disarmed: nothing to do — the record stays armed
		}
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

	/** First use arms the subscription (A6/M-B1): never at factory load. */
	const ensureTransitionArmed = (): void => {
		if (unsubscribeTransition || !pi.events) return;
		unsubscribeTransition = pi.events.on(TRANSITION_CHANNEL, onTransition);
	};

	const onExpiry = (id: string): void => {
		const record = armed.get(id);
		if (!record) return;
		armed.delete(id); // the timer already fired — nothing left to clear
		const event = composeMonitorEvent("expired", coreRecord(record), { now: now() });
		sendMonitorEvent(event.content, {
			kind: "expired",
			monitorId: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			lifetimeMs: Math.max(0, now() - record.armedAt),
		});
	};

	// ---------------------------------------------------------------- tool

	/** R10/N-1: the WHOLE tool is tui-only — one gate for every action (M-B5). */
	const requireTui = (ctx: unknown, action: string): void => {
		if (resolveMode(ctx) === "tui") return;
		throw new Error(
			`the monitor tool is tui-only (action "${action}") — it wakes an idle interactive session and there is none in this mode. ` +
				`Use delegations wait to block on a settle instead.`,
		);
	};

	const MonitorParams = Type.Object({
		action: Type.Union([Type.Literal("register"), Type.Literal("list"), Type.Literal("cancel")], {
			description: "register: arm a one-shot predicate monitor; list: show armed monitors; cancel: disarm one",
		}),
		predicate: Type.Optional(
			Type.String({
				description:
					"register: a JS expression evaluated as `return (expr)` against { delegations, monitors } in a fresh sandbox on every delegation transition. 4 KB cap; must evaluate to a primitive (a promise or object is an error and disarms the monitor).",
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
		name?: string;
		interrupt?: boolean;
		timeoutMs?: number;
		id?: string;
	};

	async function execute(_toolCallId: string, params: MonitorParams, _signal: unknown, _onUpdate: unknown, ctx: unknown): Promise<ToolResult> {
		switch (params.action) {
			case "register":
				return registerMonitor(params, ctx);
			case "list":
				return listMonitors(ctx);
			case "cancel":
				return cancelMonitor(params, ctx);
			default:
				throw new Error(`monitor action must be one of register, list, cancel`);
		}
	}

	function registerMonitor(params: MonitorParams, ctx: unknown): ToolResult {
		requireTui(ctx, "register");
		const predicate = params.predicate;
		if (typeof predicate !== "string" || !predicate.trim()) {
			throw new Error("monitor register needs a predicate — a JS expression evaluated against the snapshot on every delegation transition");
		}
		// Compile-check FIRST: a syntax error or an over-cap string rejects without consuming the cap (R6).
		const compiled = compilePredicate(predicate);
		if (compiled.kind === "syntax-error") {
			throw new Error(`monitor rejected — invalid predicate: ${compiled.reason}`);
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
			interrupt: params.interrupt === true,
			armedAt: nowMs,
			timeoutMs,
			expiresAt: nowMs + timeoutMs,
		};
		record.timer = scheduler.setTimeout(() => onExpiry(record.id), timeoutMs);
		armed.set(record.id, record);

		// R7: one-shot, edge-triggered, INCLUDING at registration — evaluate once against the
		// current snapshot; an already-true condition fires (or errors) immediately.
		const snapshot = currentSnapshot();
		const outcome = evaluateMonitor({ name: displayName(record), predicate, armed: true }, snapshot);
		const echo = {
			id: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			predicate,
			interrupt: record.interrupt,
			armedAt: record.armedAt,
			timeoutMs: record.timeoutMs,
			expiresAt: record.expiresAt,
		};
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
		return textResult(
			`Monitor ${record.id} armed — evaluates on every delegation transition, fires once when the predicate first evaluates true. ` +
				`Expires in ${humanizeMs(record.timeoutMs)} (at ${record.expiresAt}).`,
			{ ...echo, state: "armed" },
		);
	}

	function listMonitors(ctx: unknown): ToolResult {
		requireTui(ctx, "list");
		if (armed.size === 0) return textResult("no active monitors.", { monitors: [] });
		const nowMs = now();
		const lines = [...armed.values()].map(
			(record) =>
				`${record.id}${record.name !== undefined ? ` (${record.name})` : ""} — ${record.predicate} — ` +
				`armed ${humanizeMs(nowMs - record.armedAt)} ago, expires in ${humanizeMs(record.expiresAt - nowMs)}` +
				`${record.interrupt ? ", interrupt" : ""}`,
		);
		return textResult(lines.join("\n"), {
			monitors: [...armed.values()].map((record) => ({
				id: record.id,
				...(record.name !== undefined ? { name: record.name } : {}),
				predicate: record.predicate,
				armedAt: record.armedAt,
				expiresAt: record.expiresAt,
			})),
		});
	}

	function cancelMonitor(params: MonitorParams, ctx: unknown): ToolResult {
		requireTui(ctx, "cancel");
		const id = params.id?.trim();
		if (!id) throw new Error("monitor cancel needs an id — use monitor list for the active ids");
		const record = armed.get(id);
		if (!record) throw new Error(`no monitor ${id} — use monitor list for the active ids`);
		armed.delete(id);
		clearTimer(record);
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
			"register predicate (evaluate a JS expression against { delegations, monitors } on every delegation transition;",
			"the FIRST true evaluation sends one monitor-event followUp and removes the monitor — one-shot, edge-triggered,",
			"including at registration when the condition is already true),",
			"list (armed monitors), cancel id (disarm one).",
			"Optional name and timeoutMs (default 10 min, max 60 min — expiry delivers an expired card).",
			"A throwing or non-primitive predicate is an error card and disarms the monitor.",
			"Prefer monitors or wait over polling delegations list — repeated polling is blocked.",
		].join(" "),
		parameters: MonitorParams,
		execute,
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

	// ---------------------------------------------------------------- shutdown

	pi.on("session_shutdown", () => {
		const report = [...armed.values()].map((record) => ({
			id: record.id,
			...(record.name !== undefined ? { name: record.name } : {}),
			ageMs: Math.max(0, now() - record.armedAt),
		}));
		for (const record of armed.values()) clearTimer(record);
		armed.clear();
		if (unsubscribeTransition) {
			unsubscribeTransition();
			unsubscribeTransition = undefined;
		}
		delegationViews.clear();
		pi.appendEntry(SHUTDOWN_ENTRY_TYPE, { monitors: report });
	});

	// P7 (wait tool) and P8 (poll enforcement) wire here.
}
