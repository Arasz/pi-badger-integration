/**
 * Delegation status surface (plan §2 R11 module map: "the delegations tool, /delegations
 * command, widget — owns its own files so P3/P4 can parallelise").
 *
 * Three surfaces over one injected registry (this module never spawns, kills or reads child
 * streams — the registry and the runner own all of that):
 *
 *   - the LLM tool `delegations` (R6): list / log / abort — NO wait verb (f: 2026-09-02, the
 *     queue-model ruling: the only waiting surface is the monitor extension's `wait` tool,
 *     which user input interrupts; the removed verb blocked the loop and ignored input).
 *     Unknown ids are loud errors; abort without an id is a usage error; `log` answers with
 *     a bounded tail of the run's log file plus the full path pointer, and "log unavailable"
 *     when there is no healthy log (R4 review CR6).
 *   - the human twin `/delegations [log <id>] [abort <id|all>]` with argument completions —
 *     every mutation goes through the same registry calls the tool uses (T78), so the tool
 *     and the command can never disagree about a transition.
 *   - the background widget (R9): one line per live BACKGROUND run (id, agent, elapsed,
 *     activity, full usage (↑ ↓ CR% ctx%)) plus a queued count, 5 s tick while anything is live, cleared
 *     when nothing live remains. Blocking delegations are session-signals' footer business
 *     (review CR17) and never render here.
 *
 * How this module sees the registry: `registry.list()`/`get()` are the state, and registry
 * transitions arrive through the shared pi.events channel (P3's T60 emit wire publishes one
 * serializable `DelegationTransition` per state change). Every transition re-renders the
 * widget — no test and no code path ever waits for the 5 s tick to observe a state change.
 *
 * Background vs blocking is derived from pi's own tool events: a `delegate` tool call whose
 * result has not landed yet is a blocking delegation in flight; once the receipt (tool
 * result) lands and the run is still live, the run is background. This module is the only
 * place that needs the distinction, so it owns the derivation instead of widening the
 * frozen registry record with a flag.
 */

import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatUsage, renderDelegationStatus, type DelegationRecord, type LogRunSummary } from "./delegation-core.ts";
import type { DelegationRegistry } from "./delegation-registry.ts";

// ------------------------------------------------------------------ contract constants

/** The LLM tool name. Frozen: the child denylist is `--exclude-tools delegate,delegations,queue,monitor,wait` (plan v2 R5, final). */
export const DELEGATIONS_TOOL_NAME = "delegations";

/** The human command name (pi slash command). */
export const DELEGATIONS_COMMAND_NAME = "delegations";

/** The delegate tool this surface watches to classify background vs blocking runs. */
export const DELEGATE_TOOL_NAME = "delegate";

/** Widget slot key — deliberately NOT session-signals' footer status key "pi-badger" (row 50). */
export const DEFAULT_WIDGET_KEY = "pi-badger-delegations";

/**
 * The pi.events channel registry transitions ride (T60). P3's registry `emit` wire publishes
 * every `DelegationTransition` here; this surface subscribes to re-render the widget.
 */
export const DELEGATION_EVENTS_CHANNEL = "delegation-transition";

/** `delegations log` tail size: clamp range and default (R6). */
export const MIN_LOG_TAIL_BYTES = 512;
export const MAX_LOG_TAIL_BYTES = 49152;
export const DEFAULT_LOG_TAIL_BYTES = 8192;

/** Widget refresh cadence. Rendering happens on transitions and tool events; the tick only
 * refreshes elapsed clocks and usage while a background run is live. */
const TICK_MS = 5000;

// ------------------------------------------------------------------ pure helpers

function isLive(record: DelegationRecord): boolean {
	return record.state === "running" || record.state === "queued";
}

/** The three-way pid liveness result (RR3): report-only — never settles a run. */
export type PidLiveness = "alive" | "dead" | "unknown";

/**
 * kill(pid, 0) three-way probe (RR3): ESRCH → dead, EPERM → unknown (the process exists but
 * is not ours — never rendered as dead), a successful signal-0 kill → alive. Distinct from
 * and coexisting with index.ts's boolean `pidAlive` (EPERM → alive) that feeds log-dir
 * classification (S3) — that predicate is pinned and unchanged; this one only reports.
 */
export function probePid(pid: number): PidLiveness {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
		return "unknown";
	}
}

export function clampLogTailBytes(bytes: number): number {
	const value = typeof bytes === "number" && Number.isFinite(bytes) ? Math.round(bytes) : DEFAULT_LOG_TAIL_BYTES;
	return Math.min(MAX_LOG_TAIL_BYTES, Math.max(MIN_LOG_TAIL_BYTES, value));
}

/**
 * The last `bytes` of `content`, snapped forward to the next line boundary so every kept
 * line is whole — the same tail discipline the log tee's elision marker uses (P1's
 * `elideTeeStream`). Within the bound the content is verbatim.
 */
export function formatLogTail(content: string, bytes: number): { text: string; droppedBytes: number } {
	if (content.length <= bytes) return { text: content, droppedBytes: 0 };
	let tail = content.slice(-bytes);
	const newline = tail.indexOf("\n");
	if (newline >= 0) tail = tail.slice(newline + 1);
	return { text: tail, droppedBytes: content.length - tail.length };
}

function taskExcerpt(task: string): string {
	const oneLine = task.replace(/\s+/g, " ").trim();
	return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

/** One line per record for the LLM tool's list output — phase plus the task it maps to.
 * When `probe` is given, RUNNING records with a pid gain a liveness segment (RR3): `alive`,
 * `unknown`, or `lost (dead pid)` for a dead-but-unsettled run; settled and queued records
 * skip the probe (N4). `contextWindow` (when known) renders `ctx:` as a share of the window. */
export function describeRecord(record: DelegationRecord, now: number, probe?: (pid: number) => PidLiveness, contextWindow?: number): string {
	const parts: string[] = [`${record.id} ${record.agent}`];
	switch (record.state) {
		case "queued":
			parts.push(record.queuePosition !== undefined ? `queued (position ${record.queuePosition})` : "queued");
			break;
		case "running":
			parts.push(formatDuration(now - record.startedAt));
			if (record.activity) parts.push(record.activity);
			{
				const usage = formatUsage(record.usage, contextWindow);
				if (usage) parts.push(usage);
			}
			if (probe && record.pid !== undefined) {
				const liveness = probe(record.pid);
				parts.push(liveness === "dead" ? "lost (dead pid)" : liveness);
			}
			break;
		case "completed":
			parts.push(record.exitCode != null && record.exitCode !== 0 ? `exited ${record.exitCode}` : "done");
			break;
		case "failed":
			parts.push(record.spawnError ? `failed (${record.spawnError})` : "failed");
			break;
		case "aborted":
			parts.push(
				record.abortReason === "timeout"
					? "aborted (timeout)"
					: record.abortReason === "lost"
						? "aborted (lost)"
						: "aborted",
			);
			break;
		case "lost":
			parts.push("lost");
			break;
		case "stale":
			parts.push("stale");
			if (record.logFile) parts.push(`log: ${record.logFile}`);
			break;
	}
	parts.push(`task: ${taskExcerpt(record.task)}`);
	return parts.join(" — ");
}

/**
 * The widget panel (R9): one line per live background RUNNING run — id, agent, elapsed,
 * activity, full usage (↑input ↓output CR cache-hit% ctx window% $cost) — plus one `N queued`
 * count line when background runs are queued. `undefined` when nothing live and background
 * remains → the caller clears the widget.
 *
 * `pendingToolCallIds` holds the delegate tool calls whose result has not landed (blocking
 * delegations in flight); their runs are invisible here — the footer owns them (CR17).
 */
export function widgetLines(
	records: DelegationRecord[],
	pendingToolCallIds: Set<string>,
	now: number,
	contextWindow?: number,
): string[] | undefined {
	const background = records.filter((record) => isLive(record) && !pendingToolCallIds.has(record.toolCallId));
	if (background.length === 0) return undefined;
	const lines: string[] = [];
	for (const record of background.filter((r) => r.state === "running").sort((a, b) => a.startedAt - b.startedAt)) {
		const parts = [`${record.id} ${record.agent}`, formatDuration(now - record.startedAt)];
		if (record.activity) parts.push(record.activity);
		const usage = formatUsage(record.usage, contextWindow);
		if (usage) parts.push(usage);
		lines.push(parts.join(" — "));
	}
	const queued = background.filter((r) => r.state === "queued").length;
	if (queued > 0) lines.push(`${queued} queued`);
	return lines;
}

const USAGE_LINE = "usage: /delegations [log <id>] [abort <id|all>]";

function unknownIdError(id: string): Error {
	// Same wording the registry's abort throws — one loud unknown-id message everywhere.
	return new Error(`ai-badger: unknown delegation id "${id}" — use delegations list for current ids`);
}

// ------------------------------------------------------------------ the frozen factory

/**
 * Register the delegation status surfaces on `pi` over `registry`.
 *
 * Frozen signature (plan §4 freeze point; the orchestrator wires this after constructing the
 * registry — the registry's `emit` dep must publish `DelegationTransition`s on
 * `DELEGATION_EVENTS_CHANNEL` for transition-driven widget rendering). The parameters stay
 * frozen; the return amends additively: a read-only `contextWindow()` accessor so the card
 * renderer can render `ctx:` as a window share without a second source of model truth.
 *
 * ```ts
 * registerDelegationStatus(pi, registry, opts?: { widgetKey?: string; bytes?: number;
 *   now?: () => number; probePid?: (pid: number) => PidLiveness }): void
 * ```
 *
 * `opts.widgetKey` — the ctx.ui.setWidget key (default "pi-badger-delegations").
 * `opts.bytes` — the default `delegations log` tail size, clamped to 512–49152 (default 8192);
 * the tool's per-call `bytes` parameter overrides it per call.
 * `opts.now` — the elapsed-time clock; MUST be the same injected clock the registry was built
 * with, because records carry that clock's `startedAt` (defaults to Date.now()).
 * `opts.probePid` — the three-way liveness probe the list action runs per running record
 * (RR3); defaults to the real kill(pid, 0) probe.
 */
export function registerDelegationStatus(
	pi: ExtensionAPI,
	registry: DelegationRegistry,
	opts?: {
		widgetKey?: string;
		bytes?: number;
		now?: () => number;
		/** Three-way pid liveness probe for the list action (RR3); defaults to the real
		 * `probePid`. Injectable so tests can stub EPERM-class outcomes. */
		probePid?: (pid: number) => PidLiveness;
		/** Reconstructed log-dir summaries (RR4), consulted when the registry is empty: `stale`
		 * runs are listed with their log paths — the safety net that works even when the runner
		 * instance is gone. Defaults to none. */
		staleRuns?: () => LogRunSummary[];
	},
): { contextWindow(): number | undefined } {
	const widgetKey = opts?.widgetKey ?? DEFAULT_WIDGET_KEY;
	const configuredLogBytes = clampLogTailBytes(opts?.bytes ?? DEFAULT_LOG_TAIL_BYTES);
	const probePidFn = opts?.probePid ?? probePid;
	// The elapsed clock: registries are built with an injected `now` (flake conventions), so the
	// surfaces that render elapsed time must read the SAME clock, not their own Date.now().
	const nowFn = opts?.now ?? (() => Date.now());

	/** Delegate tool calls whose result has not landed = blocking delegations in flight. */
	const pendingResult = new Set<string>();
	/** pi hands out contexts per event; every surface renders through the latest one. */
	let currentCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	/** The delegating session model's context window — the denominator for `ctx:` percent
	 * renders; undefined → formatUsage falls back to absolute tokens. An approximation when a
	 * run overrides the model. */
	function contextWindowOf(): number | undefined {
		return currentCtx?.model?.contextWindow;
	}

	function renderWidget(): void {
		const ctx = currentCtx;
		if (!ctx || !ctx.hasUI) return;
		ctx.ui.setWidget(widgetKey, widgetLines(registry.list(), pendingResult, elapsedNow(), contextWindowOf()));
	}

	function hasLiveBackgroundRun(): boolean {
		return registry.list().some((record) => isLive(record) && !pendingResult.has(record.toolCallId));
	}

	function stopTicker(): void {
		if (ticker === undefined) return;
		clearInterval(ticker);
		ticker = undefined;
	}

	function ensureWidgetTicker(): void {
		if (ticker || !hasLiveBackgroundRun()) return;
		ticker = setInterval(() => {
			renderWidget(); // also the clear when the last live run settled between ticks
			if (!hasLiveBackgroundRun()) stopTicker();
		}, TICK_MS);
	}

	function requireRecord(id: string): DelegationRecord {
		const record = registry.get(id);
		if (!record) throw unknownIdError(id);
		return record;
	}

	function statusPanel(now: number): string {
		return renderDelegationStatus(registry.list(), now, contextWindowOf()) ?? "registry empty (0 records)";
	}

	function elapsedNow(): number {
		return nowFn();
	}

	function abortDelegation(id: string): string {
		requireRecord(id);
		registry.abort(id);
		const state = registry.get(id)?.state ?? "lost";
		return `delegation ${id} — abort requested (state: ${state})`;
	}

	function abortEverything(): string {
		const live = registry.list().filter(isLive);
		if (live.length === 0) return "no live delegations to abort";
		registry.abortAll();
		return `abort requested for ${live.length} live delegation${live.length === 1 ? "" : "s"}`;
	}

	function logTailResult(id: string, perCallBytes?: number): { ok: boolean; message: string; logFile?: string } {
		const record = requireRecord(id);
		if (!record.logFile) {
			return {
				ok: false,
				message: `delegation ${id}: log unavailable — no log file was written for this run (the sink was disabled or failed); the delegation itself is unaffected`,
			};
		}
		const bytes = clampLogTailBytes(perCallBytes ?? configuredLogBytes);
		let content: string;
		try {
			content = readFileSync(record.logFile, "utf8");
		} catch (error) {
			return {
				ok: false,
				message: `delegation ${id}: log unavailable (${error instanceof Error ? error.message : String(error)})`,
				logFile: record.logFile,
			};
		}
		const { text, droppedBytes } = formatLogTail(content, bytes);
		const parts: string[] = [];
		if (droppedBytes > 0) parts.push(`[...${droppedBytes} earlier bytes dropped — showing the tail]`);
		if (text.trim().length > 0) parts.push(text.trimEnd());
		parts.push(`full log: ${record.logFile}`);
		return { ok: true, message: parts.join("\n"), logFile: record.logFile };
	}

	// ---------------------------------------------------------------- tool

	const DelegationsParams = Type.Object({
		action: Type.Union(
			[Type.Literal("list"), Type.Literal("log"), Type.Literal("abort")],
			{ description: "list: every delegation with its state; log: tail one run's log; abort: stop one run or all" },
		),
		id: Type.Optional(Type.String({ description: 'Run id for log/abort (abort also accepts "all")' })),
		bytes: Type.Optional(Type.Number({ description: `log: tail size in bytes (${MIN_LOG_TAIL_BYTES}–${MAX_LOG_TAIL_BYTES}, default ${DEFAULT_LOG_TAIL_BYTES})` })),
	});
	type DelegationsParams = Static<typeof DelegationsParams>;

	function textResult(text: string, details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
		return { content: [{ type: "text", text }], details };
	}

	async function runAction(params: DelegationsParams): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
		switch (params.action) {
			case "list": {
				const records = [...registry.list()].sort((a, b) => a.startedAt - b.startedAt);
				if (records.length === 0) {
					// RR4: an empty registry is not the end of the story — reconstructed stale runs
					// (pid-dead, terminal-line-less, frozen logs) surface here with their log paths.
					const stale = (opts?.staleRuns?.() ?? []).filter((summary) => summary.state === "stale");
					if (stale.length === 0) return textResult("registry empty (0 records)", { records: [] });
					const staleRecords = stale.map((summary) => ({
						id: summary.id,
						agent: summary.agent ?? "?",
						task: summary.task ?? "",
						toolCallId: "",
						state: "stale" as const,
						// describeRecord's stale branch never renders the clock; the record shape requires the field.
						startedAt: summary.startedAt ?? 0,
						...(summary.logFile !== undefined ? { logFile: summary.logFile } : {}),
					}));
					const lines = staleRecords.map((record) => describeRecord(record, elapsedNow()));
					return textResult([`registry empty (0 records) — reconstructed from logs:`, ...lines].join("\n"), {
						records: [],
						stale: staleRecords,
					});
				}
				const now = elapsedNow();
				return textResult(records.map((record) => describeRecord(record, now, probePidFn, contextWindowOf())).join("\n"), { records });
			}
			case "log": {
				if (typeof params.id !== "string" || !params.id.trim()) {
					throw new Error(`delegations log needs a run id — use delegations list for current ids; ${USAGE_LINE}`);
				}
				const result = logTailResult(params.id.trim(), typeof params.bytes === "number" ? params.bytes : undefined);
				return textResult(result.message, { id: params.id, logFile: result.logFile, ok: result.ok });
			}
			case "abort": {
				if (typeof params.id !== "string" || !params.id.trim()) {
					throw new Error(`delegations abort needs a run id, or "all" — e.g. delegations abort d-3 or delegations abort all`);
				}
				const target = params.id.trim();
				if (target === "all") return textResult(abortEverything(), { all: true });
				return textResult(abortDelegation(target), { id: target });
			}
			default:
				throw new Error(`delegations action must be one of list, log, abort`);
		}
	}

	pi.registerTool({
		name: DELEGATIONS_TOOL_NAME,
		label: "Delegations",
		description: [
			"Query and manage background subagent delegations. Actions:",
			"list (every delegation with its state),",
			"log id (bounded tail of a run's log file plus the full log path),",
			'abort id|"all" (stop one delegation or every live one).',
			"Results arrive as followUp messages on their own — never poll with list/log (repeated polling is blocked). There is NO wait verb (removed f: 2026-09-02 — it blocked the main loop and ignored user input): to spend waiting time use the monitor extension's wait tool (user input interrupts it) or register a monitor, or simply end your turn and let the followUps wake you.",
			'A run is unbounded unless the delegate call passes timeoutMs: on expiry the run is aborted through the normal kill path and settles aborted (timeout) — use abort to stop one yourself.',
		].join(" "),
		parameters: DelegationsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentCtx = ctx;
			return runAction(params);
		},
	});

	// ---------------------------------------------------------------- command

	function commandResult(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, type);
	}

	pi.registerCommand(DELEGATIONS_COMMAND_NAME, {
		description: "Delegation status; `log <id>` tails a run's log; `abort <id|all>` stops runs.",
		getArgumentCompletions(argumentPrefix) {
			const idPosition = /^(?:log|abort)\s+(\S*)$/.exec(argumentPrefix);
			if (idPosition) {
				const token = idPosition[1]!;
				const items = registry
					.list()
					.filter(isLive)
					.filter((record) => record.id.startsWith(token))
					.map((record) => ({ value: record.id, label: `${record.id} ${record.agent} (${record.state})` }));
				return items.length > 0 ? items : null;
			}
			const first = argumentPrefix.trim();
			const subcommands = ["log", "abort"]
				.filter((verb) => verb.startsWith(first))
				.map((verb) => ({ value: verb, label: verb, description: verb === "log" ? "tail a run's log" : "stop a run or all" }));
			return subcommands.length > 0 ? subcommands : null;
		},
		async handler(args, ctx) {
			currentCtx = ctx;
			const trimmed = args.trim();
			if (!trimmed) {
				commandResult(ctx, statusPanel(elapsedNow()), "info");
				return;
			}
			const match = /^(log|abort)\s+(\S+)\s*$/.exec(trimmed);
			if (!match) {
				commandResult(ctx, USAGE_LINE, "info");
				return;
			}
			const [, verb, target] = match;
			try {
				if (verb === "log") {
					const result = logTailResult(target!);
					commandResult(ctx, result.message, result.ok ? "info" : "warning");
					return;
				}
				commandResult(ctx, target === "all" ? abortEverything() : abortDelegation(target!), "info");
			} catch (error) {
				commandResult(ctx, error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// ---------------------------------------------------------------- wiring

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== DELEGATE_TOOL_NAME) return undefined;
		currentCtx = ctx;
		pendingResult.add(event.toolCallId); // result not landed → blocking delegation in flight
		renderWidget();
		ensureWidgetTicker();
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== DELEGATE_TOOL_NAME) return undefined;
		currentCtx = ctx;
		if (!pendingResult.delete(event.toolCallId)) return undefined;
		// The receipt landed while the run may still go — whatever is still live is background.
		renderWidget();
		ensureWidgetTicker();
		return undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		currentCtx = ctx;
		stopTicker();
		// The session is over — delegations do not outlive it (R8). Force-clear regardless of
		// handler order: P3's registry shutdown (and its transitions) may run before or after us.
		if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
		return undefined;
	});

	// Registry transitions (T60 wire): every state change re-renders the widget immediately —
	// nothing ever waits for the tick to observe a transition.
	pi.events?.on(DELEGATION_EVENTS_CHANNEL, () => {
		renderWidget();
		ensureWidgetTicker();
	});

	return {
		/** The delegating session model's context window (undefined when unknown) — the card
		 * renderer reads it at delivery time so completion cards render `ctx:` as a window
		 * share, matching the widget/list surfaces instead of absolute tokens. */
		contextWindow: () => contextWindowOf(),
	};
}

export default registerDelegationStatus;
