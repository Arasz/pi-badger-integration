/**
 * The `queue` tool (plan v2 R4): ordered group admission over the delegation registry.
 *
 * Actions `add | add-parallel | clear | list`. add/add-parallel enqueue ONE group of tasks
 * through the registry's wave-1 `enqueueGroup` (all-or-nothing at the admission layer, per-task
 * receipts sharing the group's `groupId`, the idle system draining immediately); clear flushes
 * every QUEUED member through the registry's `clearQueue` (running members untouched, exactly
 * one aborted notification per member riding the existing batcher); list renders the groups the
 * queue tool enqueued with their LIVE recomputed positions.
 *
 * The WHOLE tool is tui-only (one mode rule): headless modes have no interactive session for
 * followUp delivery, so every action is rejected with guidance pointing at blocking delegate —
 * the queue is permanently empty there.
 *
 * This module never imports index.ts (no cycle, R4/S6): everything it shares with the delegate
 * tool — the persona scan, the unknown-persona message, cwd validation, the child argv — arrives
 * through the `DelegationQueueOpts` the factory receives as its `opts` parameter. index.ts calls
 * `registerDelegationQueue(pi, registry, opts)` against the one registry instance the session
 * constructed.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampRunTimeoutMs, type GroupMode } from "./delegation-core.ts";
import type { DelegationRegistry, StartRequest } from "./delegation-registry.ts";

/** The tool name as registered (R9's drift guard reads this, not a hardcoded string). */
export const QUEUE_TOOL_NAME = "queue";

/** Structural view of a resolved persona (index.ts's Persona) — what the argv builder and the
 * persona list both need. */
export interface QueuePersona {
  name: string;
  description: string;
  systemPrompt: string;
  /** The persona's `model:` pin, when the file pinned one (f: 2026-09-02 — buildInvocation
   * derives the model-fallback argv from it). index.ts's full Persona scan satisfies this
   * structurally. */
  model?: string;
}

/** Structural view of the persona scan (index.ts's PersonaScan). */
export interface QueuePersonaScan {
  personas: QueuePersona[];
  errors: string[];
  duplicates?: string[];
  missingDir?: string;
}

/**
 * What the queue tool shares with the delegate tool, injected so this module never imports
 * index.ts (R4/S6). Every member is resolved to (persona, task) with the SAME persona scan the
 * delegate tool runs, and an unknown persona is answered with the delegate tool's message
 * byte-for-byte (Q-C1).
 */
export interface DelegationQueueOpts {
  /** Scan `<cwd>/.pi/agents/*.md` (index.ts's scanPersonas). */
  scanPersonas(cwd: string): QueuePersonaScan;
  /** The agents directory a cwd scans (`scan.missingDir ?? join(cwd, ...AGENTS_DIR)`). */
  agentsDirFor(cwd: string): string;
  /** The delegate tool's unknown-persona message, byte-identical (Q-C1). */
  unknownPersonaMessage(agent: string, agentsDir: string, personas: QueuePersona[]): string;
  /** validateChildCwd: the failure reason, or undefined when the cwd is a usable directory (T74). */
  validateChildCwd(cwd: string): string | undefined;
  /** The child invocation for one member; `model` is the resolved model string (the group-level
   * override, else the session model — the delegate default). `fallbackArgs` (f: 2026-09-02)
   * is the model-pin retry argv — derived beside `args`, passed through to the runner. */
  buildInvocation(
    persona: QueuePersona,
    task: string,
    model: string | undefined,
  ): { command: string; args: string[]; fallbackArgs?: string[] };
}

/** The slice of pi's execute context the queue tool reads. */
interface QueueToolContext {
  cwd: string;
  mode: string;
  model?: { provider: string; id: string } | undefined;
  sessionManager?: { getSessionId(): string };
  ui: { notify(message: string, level?: string): void };
}

/** Per-task receipt (Q-C1): one row per enqueued task, sharing the group's groupId. */
export interface QueueTaskReceipt {
  id: string;
  state: string;
  queuePosition?: number;
}

/** The add/add-parallel result details. */
export interface QueueReceiptDetails {
  groupId: string;
  mode: GroupMode;
  tasks: QueueTaskReceipt[];
}

/** The list result details: one row per tracked group with live running/pending counts. */
export interface QueueGroupView {
  groupId: string;
  mode: GroupMode;
  running: number;
  pending: number;
  members: QueueTaskReceipt[];
}

interface TrackedGroup {
  groupId: string;
  mode: GroupMode;
  memberIds: string[];
}

const QUEUE_ACTIONS = "add, add-parallel, clear, list";

const QueueParams = Type.Object({
  action: Type.Union(
    [Type.Literal("add"), Type.Literal("add-parallel"), Type.Literal("clear"), Type.Literal("list")],
    {
      description:
        "add: queue a serial group (members run one at a time, in order); add-parallel: queue a parallel group (members run concurrently once they all fit); clear: cancel every queued task (running ones untouched); list: the queued groups with live positions",
    },
  ),
  tasks: Type.Optional(
    Type.Array(
      Type.Union([
        Type.String({ description: "The task text — runs as the group's agent" }),
        Type.Object({
          agent: Type.String({ description: "Per-task persona override" }),
          task: Type.String({ description: "The task text" }),
        }),
      ]),
      { description: 'add/add-parallel only: the group\'s tasks, e.g. ["task one", {agent: "tester", task: "task two"}]' },
    ),
  ),
  agent: Type.Optional(
    Type.String({ description: "add/add-parallel only: the persona plain-string tasks run as; use {agent, task} entries to override per task" }),
  ),
  model: Type.Optional(
    Type.String({ description: "add/add-parallel only: model override for the whole group (default: this session's model, like delegate)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "add/add-parallel only: absolute working directory for the group's children. Personas are still read from this project's .pi/agents. Validated with stat; must be an existing directory.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "add/add-parallel only: optional per-run timeout in ms for every member, clamped like delegate's (1 s floor, 24 h cap; the clock starts when a member spawns — queue wait does not count). 0 or omitted means no timeout.",
    }),
  ),
});

function textResult(text: string, details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details };
}

/**
 * Register the `queue` tool on `pi` over `registry` (plan v2 R4).
 *
 * `opts` carries everything the tool shares with the delegate tool (persona scan, the
 * byte-identical unknown-persona message, cwd validation, the argv builder) — index.ts supplies
 * it; this module never imports index.ts.
 */
export function registerDelegationQueue(
	pi: ExtensionAPI,
	registry: DelegationRegistry,
	opts: DelegationQueueOpts,
): void {
	/** The groups this tool enqueued this session (groupId → members), for `list`. Run-now
	 * delegates are implicit one-element serial groups inside the registry and are not the
	 * queue tool's bookkeeping. */
	const tracked = new Map<string, TrackedGroup>();

	/** LIVE flat 1-based position of every queued record: the snapshot `queuePosition` each
	 * record carries is its flat index at enqueue time, and the flat queue only ever appends
	 * (monotone snapshots) and removes (order-preserving), so ranking the still-queued records
	 * by snapshot reproduces the live flat order — the recomputed index after any admission,
	 * member abort or clear (plan v2 R2, S-10). */
	/** Live queue positions for rendering. SEMANTIC DEFINITION: delegation-core's
	 * liveQueuePosition (flat 1-based index over pending members, plan v2 R2) — this module
	 * cannot import the core's admission state, so it re-derives over registry snapshots.
	 * The S-1 agreement row in tests/subagent-queue-tool.test.ts pins the two together:
	 * positions renumber densely 1..n after admissions, member aborts and clears. If a
	 * change here can disagree with liveQueuePosition, change the core instead. */
	function livePositions(): Map<string, number> {
		const queued = registry
			.list()
			.filter((record) => record.state === "queued")
			.sort((a, b) => (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER));
		return new Map(queued.map((record, index) => [record.id, index + 1]));
	}

	/** Drop groups whose members are all settled (completed/failed/aborted/gone). */
	function pruneTracked(): void {
		for (const [groupId, group] of tracked) {
			const live = group.memberIds.some((id) => {
				const record = registry.get(id);
				return record !== undefined && (record.state === "running" || record.state === "queued");
			});
			if (!live) tracked.delete(groupId);
		}
	}

	function sessionModelOf(toolCtx: QueueToolContext): string | undefined {
		return toolCtx.model ? `${toolCtx.model.provider}/${toolCtx.model.id}` : undefined;
	}

	async function addTasks(params: { tasks?: unknown; agent?: unknown; model?: unknown; cwd?: unknown; timeoutMs?: unknown }, toolCtx: QueueToolContext, mode: GroupMode, toolCallId: string) {
		const tasks = params.tasks;
		if (!Array.isArray(tasks) || tasks.length === 0) {
			throw new Error(
				`queue ${mode === "serial" ? "add" : "add-parallel"} needs a non-empty tasks array — e.g. queue {action: "${mode === "serial" ? "add" : "add-parallel"}", agent: "architect", tasks: ["task one", "task two"]}`,
			);
		}
		const groupAgent = typeof params.agent === "string" && params.agent.trim() ? params.agent.trim() : undefined;

		// Resolve EVERY task's persona before enqueueing anything — all-or-nothing at the tool
		// layer too (Q-C1: an unknown persona enqueues nothing).
		const scan = opts.scanPersonas(toolCtx.cwd);
		const agentsDir = scan.missingDir ?? opts.agentsDirFor(toolCtx.cwd);
		for (const error of scan.errors) {
			toolCtx.ui.notify(`ai-badger: persona skipped — ${error}`, "warning");
		}
		for (const duplicate of scan.duplicates ?? []) {
			toolCtx.ui.notify(`ai-badger: duplicate persona — ${duplicate}`, "warning");
		}

		const resolved: Array<{ persona: QueuePersona; task: string }> = [];
		for (const [index, entry] of tasks.entries()) {
			const object = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as { agent?: unknown; task?: unknown }) : undefined;
			const agentName = object ? (typeof object.agent === "string" && object.agent.trim() ? object.agent.trim() : undefined) : groupAgent;
			const taskText = object ? object.task : entry;
			if (!agentName) {
				throw new Error(
					`queue tasks[${index}] is a plain string but no group agent was given — pass agent (e.g. agent: "${scan.personas[0]?.name ?? "architect"}") or use {agent, task} entries`,
				);
			}
			if (typeof taskText !== "string" || !taskText.trim()) {
				throw new Error(`queue tasks[${index}] needs a non-empty task string`);
			}
			const persona = scan.personas.find((p) => p.name === agentName);
			if (!persona) {
				// Q-C1: the delegate tool's unknown-persona message, byte-for-byte; nothing enqueued.
				const message = opts.unknownPersonaMessage(agentName, agentsDir, scan.personas);
				toolCtx.ui.notify(message, "warning");
				return textResult(message, { agent: agentName, agentsDir, errors: scan.errors });
			}
			resolved.push({ persona, task: taskText });
		}

		// T74 semantics: personas always scanned from ctx.cwd; the children run in params.cwd,
		// validated loudly before anything is enqueued.
		let childCwd = toolCtx.cwd;
		if (typeof params.cwd === "string" && params.cwd.trim()) {
			const problem = opts.validateChildCwd(params.cwd);
			if (problem) {
				const message = `ai-badger: invalid cwd "${params.cwd}" — ${problem}`;
				toolCtx.ui.notify(message, "warning");
				return textResult(message, { agent: groupAgent, agentsDir, errors: scan.errors });
			}
			childCwd = params.cwd;
		}

		const model = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
		const timeoutMs = clampRunTimeoutMs(typeof params.timeoutMs === "number" ? params.timeoutMs : undefined);
		let sessionId: string | undefined;
		try {
			sessionId = toolCtx.sessionManager?.getSessionId();
		} catch {
			sessionId = undefined;
		}

		const requests: StartRequest[] = resolved.map(({ persona, task }) => {
			const invocation = opts.buildInvocation(persona, task, model ?? sessionModelOf(toolCtx));
			return {
				agent: persona.name,
				task,
				args: invocation.args,
				...(invocation.fallbackArgs !== undefined ? { fallbackArgs: invocation.fallbackArgs } : {}),
				command: invocation.command,
				cwd: childCwd,
				toolCallId,
				...(sessionId !== undefined ? { sessionId } : {}),
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			};
		});

		const outcomes = await registry.enqueueGroup(requests, mode);
		if (outcomes.length > 0 && !outcomes[0]!.ok) {
			// All-or-nothing admission rejection: every member carries the same reason.
			const reason = outcomes[0]!.reason;
			const message = `ai-badger: queue rejected — ${reason}`;
			toolCtx.ui.notify(message, "warning");
			return textResult(message, { reason });
		}

		const groupId = outcomes[0]!.ok ? outcomes[0]!.groupId : "";
		const receiptMode = outcomes[0]!.ok ? outcomes[0]!.mode : mode;
		const taskReceipts: QueueTaskReceipt[] = outcomes.map((outcome) => {
			if (!outcome.ok) return { id: "?", state: "rejected" };
			return {
				id: outcome.id,
				state: outcome.record.state,
				...(outcome.record.queuePosition !== undefined ? { queuePosition: outcome.record.queuePosition } : {}),
			};
		});
		tracked.set(groupId, { groupId, mode: receiptMode, memberIds: taskReceipts.map((t) => t.id) });

		const summary = taskReceipts.map((t) => (t.queuePosition !== undefined ? `${t.id} ${t.state} (position ${t.queuePosition})` : `${t.id} ${t.state}`)).join(", ");
		const content = `Queued ${taskReceipts.length} task${taskReceipts.length === 1 ? "" : "s"} as group ${groupId} (${receiptMode}): ${summary} — each result arrives as a followUp message on its own.`;
		return textResult(content, { groupId, mode: receiptMode, tasks: taskReceipts } satisfies QueueReceiptDetails);
	}

	function clearAction() {
		const { cancelled, stillRunning } = registry.clearQueue();
		pruneTracked();
		const lines: string[] = [];
		if (cancelled.length === 0 && stillRunning.length === 0) {
			lines.push("queue clear: nothing to cancel — the queue was already empty (0 queued, 0 running).");
		} else {
			lines.push(
				cancelled.length > 0
					? `queue clear: cancelled ${cancelled.length} queued delegation${cancelled.length === 1 ? "" : "s"} (${cancelled.join(", ")}).`
					: "queue clear: nothing was queued.",
			);
			if (stillRunning.length > 0) lines.push(`Still running (untouched): ${stillRunning.join(", ")}.`);
		}
		return textResult(lines.join("\n"), { cancelled, stillRunning });
	}

	function listAction() {
		pruneTracked();
		if (tracked.size === 0) {
			return textResult("queue empty (0 groups)", { groups: [] });
		}
		const positions = livePositions();
		const views: QueueGroupView[] = [];
		const lines: string[] = [];
		for (const group of tracked.values()) {
			const members: QueueTaskReceipt[] = [];
			let running = 0;
			let pending = 0;
			for (const id of group.memberIds) {
				const record = registry.get(id);
				if (!record) continue;
				if (record.state === "queued") {
					pending += 1;
					members.push({ id, state: "queued", queuePosition: positions.get(id) });
				} else if (record.state === "running") {
					running += 1;
					members.push({ id, state: "running" });
				}
			}
			views.push({ groupId: group.groupId, mode: group.mode, running, pending, members });
			lines.push(`${group.groupId} (${group.mode}) — ${running} running, ${pending} pending`);
			for (const member of members) {
				lines.push(member.queuePosition !== undefined ? `  ${member.id} queued (live position ${member.queuePosition})` : `  ${member.id} ${member.state}`);
			}
		}
		return textResult(lines.join("\n"), { groups: views });
	}

	pi.registerTool({
		name: QUEUE_TOOL_NAME,
		label: "Queue",
		description: [
			"Queue ordered delegation groups for this project's ai-badger personas. Actions:",
			'add (a serial group: members run one at a time, in order), add-parallel (members run concurrently once they all fit),',
			'clear (cancel every queued task — running ones are untouched), list (the queued groups with live positions).',
			"Every task runs as a separate pi process like delegate; results arrive as followUp messages on their own — never poll.",
			"In the TUI the queue is how work keeps a strict order without blocking; headless runs have no queue (delegate blocks there instead).",
		].join(" "),
		parameters: QueueParams,

		async execute(toolCallId, params, _signal, _onUpdate, rawCtx) {
			const toolCtx = rawCtx as QueueToolContext;
			// ★R4/S5 — one mode rule for the WHOLE tool: headless modes have no interactive session
			// for followUp delivery, so the queue is permanently empty there; every action rejects
			// with guidance pointing at blocking delegate (Q-C4).
			if (toolCtx.mode !== "tui") {
				const message =
					`ai-badger: the queue tool only works in an interactive TUI session — mode "${toolCtx.mode}" has no background delivery, so there is nothing to queue into. ` +
					"In headless runs delegate blocks and returns its result inline; call delegate directly.";
				toolCtx.ui.notify(message, "warning");
				return textResult(message, { reason: "tui-only", action: params.action });
			}
			switch (params.action) {
				case "add":
					return addTasks(params, toolCtx, "serial", toolCallId);
				case "add-parallel":
					return addTasks(params, toolCtx, "parallel", toolCallId);
				case "clear":
					return clearAction();
				case "list":
					return listAction();
				default:
					throw new Error(`queue action must be one of ${QUEUE_ACTIONS}`);
			}
		},
	});
}
