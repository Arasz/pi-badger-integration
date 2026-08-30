/**
 * Session signals for pi: marker importance (`!`) handling + delegation working status.
 *
 * **Marker importance** — the ai-badger prompt markers (h/hint, f/feedback, e/extension,
 * q/queue, i/important) gain an importance token: a `!` between the alias and the colon
 * (`f!:`, `q!:` …). Meaning and importance are orthogonal now — every marker can be
 * interrupt-grade. When a `!`-marked message arrives while the agent is busy
 * (`event.streamingBehavior` is `"steer"` or `"followUp"`), the current run is aborted
 * immediately and the message drives the next turn. Without the token, behavior is
 * unchanged: the marker reaches the model when the current turn ends. This is the pi
 * enforcement arm of the marker contract — the legacy hooks fire at turn start and can
 * never see a mid-turn message; this handler can, because pi's `input` event fires on
 * receipt even while busy.
 *
 * **Delegation status** — while a delegation tool (default: `delegate`, the ai-badger
 * subagent extension's tool) runs, the footer shows what is working and for how long;
 * the status clears when the tool result lands.
 *
 * Everything decision-shaped is exported pure and unit-tested in
 * tests/session-signals.test.ts; the factory only wires.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The ai-badger marker catalog's aliases, meaning-first. `!` between alias and colon
 * marks interrupt-grade importance. Order matters for the long forms (longest match). */
const MARKER_ALIASES: Array<{ alias: string; marker: MarkerName }> = [
	{ alias: "hint", marker: "hint" },
	{ alias: "h", marker: "hint" },
	{ alias: "feedback", marker: "feedback" },
	{ alias: "f", marker: "feedback" },
	{ alias: "extension", marker: "extension" },
	{ alias: "e", marker: "extension" },
	{ alias: "queue", marker: "queue" },
	{ alias: "q", marker: "queue" },
	{ alias: "important", marker: "important" },
	{ alias: "i", marker: "important" },
];

export type MarkerName = "hint" | "feedback" | "extension" | "queue" | "important";

export interface ParsedMarker {
	marker: MarkerName;
	/** Interrupt-grade importance: the `!` token between alias and colon. */
	bang: boolean;
}

/** Parse a marker prefix (with optional `!`) off the very start of an input line.
 * Leading whitespace is allowed (the prompt-markers contract strips it); anything else
 * before the marker means it is not a marker. */
export function parseMarker(text: string): ParsedMarker | undefined {
	if (typeof text !== "string") return undefined;
	const trimmed = text.replace(/^\s+/, "");
	for (const { alias, marker } of MARKER_ALIASES) {
		const pattern = new RegExp(`^${alias}(!)?:`, "i");
		const match = pattern.exec(trimmed);
		if (match) return { marker, bang: match[1] === "!" };
	}
	return undefined;
}

/** An interrupt-grade marker aborts the current run only when there IS a run — busy is
 * `streamingBehavior` being set ("steer" mid-stream, "followUp" queued); undefined is idle. */
export function shouldInterrupt(bang: boolean, streamingBehavior: string | undefined): boolean {
	return bang && streamingBehavior !== undefined;
}

// ---------------------------------------------------------------- delegation status

export interface DelegationEntry {
	toolCallId: string;
	label: string;
	startedAt: number;
}

/** Tracks in-flight delegation tool calls. Pure state: call onCall on the tool_call
 * event, onResult on tool_result, and render from activeEntries() whenever the UI
 * should update. */
export class DelegationTracker {
	private readonly active = new Map<string, DelegationEntry>();

	onCall(toolCallId: string, label: string, startedAt = Date.now()): void {
		this.active.set(toolCallId, { toolCallId, label, startedAt });
	}

	/** Removes the entry; false for an unknown id (non-delegation results, duplicates). */
	onResult(toolCallId: string): boolean {
		return this.active.delete(toolCallId);
	}

	activeEntries(): DelegationEntry[] {
		return [...this.active.values()].sort((a, b) => a.startedAt - b.startedAt);
	}
}

/** Footer text for the current delegations; undefined clears the status line. */
export function renderStatus(entries: DelegationEntry[], now: number): string | undefined {
	if (entries.length === 0) return undefined;
	const parts = entries.map((entry) => {
		const seconds = Math.max(0, Math.round((now - entry.startedAt) / 1000));
		const minutes = Math.floor(seconds / 60);
		const rest = seconds % 60;
		const clock = minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
		return `delegate ${entry.label} — ${clock}`;
	});
	return `⏳ ${parts.join(" · ")}`;
}

/** The delegation tool names to watch, from the env override or the default. Both ai-badger
 * delegation tools are watched by default: `delegate` (blocking runs) and `delegations`
 * (whose `wait` action can hold a turn for minutes — R9 keeps it footer-visible). */
export function parseToolNames(env: Record<string, string | undefined>): string[] {
	const raw = env.PI_BADGER_DELEGATION_TOOLS?.trim();
	if (!raw) return ["delegate", "delegations"];
	const names = raw.split(",").map((n) => n.trim()).filter(Boolean);
	return names.length > 0 ? names : ["delegate", "delegations"];
}

// ---------------------------------------------------------------- wiring

/** Footer tick cadence. Exported so tests can wait out the first render honestly. */
export const TICK_MS = 5000;

const STATUS_KEY = "pi-badger";

export default function (pi: ExtensionAPI) {
	const toolNames = new Set(parseToolNames(process.env));
	const tracker = new DelegationTracker();
	let ticker: ReturnType<typeof setInterval> | undefined;

	function render(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const text = renderStatus(tracker.activeEntries(), Date.now());
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function ensureTicker(ctx: ExtensionContext): void {
		if (ticker || tracker.activeEntries().length === 0) return;
		ticker = setInterval(() => {
			if (tracker.activeEntries().length === 0) {
				clearInterval(ticker);
				ticker = undefined;
				return;
			}
			render(ctx);
		}, TICK_MS);
	}

	pi.on("input", async (event, ctx) => {
		const parsed = parseMarker(event.text);
		if (!parsed) return { action: "continue" };
		if (shouldInterrupt(parsed.bang, event.streamingBehavior)) {
			ctx.abort();
			if (ctx.hasUI) {
				ctx.ui.notify(
					`⏹ ${parsed.marker}! while busy — current run aborted; your message drives the next turn`,
					"warning",
				);
			}
		}
		return { action: "continue" };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!toolNames.has(event.toolName)) return undefined;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const label = typeof input.agent === "string" && input.agent ? input.agent : "task";
		tracker.onCall(event.toolCallId, label);
		// R9 tick-defer: no immediate render here. A background delegation's receipt lands
		// sub-second and would flash the footer for a moment; the first render is deferred to
		// the tick below, so only delegations that actually keep running (blocking ones) are
		// ever shown. The tool_result handler still clears immediately.
		ensureTicker(ctx);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!toolNames.has(event.toolName)) return undefined;
		if (tracker.onResult(event.toolCallId)) render(ctx);
		return undefined;
	});
}
