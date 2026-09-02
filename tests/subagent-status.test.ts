/**
 * P4 suite — delegation status surface (rows 49–50, T75–T78 of
 * docs/plans/2026-interactive-subagent-delegation.tests.md) plus the session-signals
 * tick-defer (T77).
 *
 * Harness discipline (tests doc flake conventions): the fake-pi handlers-map harness from
 * tests/session-signals drives a REAL P2 registry with FakeChild-driven runs — nothing is
 * mocked beyond the fake pi itself. Registry transitions reach the status surface exactly the
 * way production wires them (P3's T60 emit hook → pi.events bus); NO test awaits the widget's
 * 5 s tick — widget rows assert setWidget calls on registry transitions. The one real-time
 * wait in the file is T77's session-signals footer tick (the row explicitly asserts rendering
 * AT the tick), bounded by an explicit generous timeout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChild } from "./helpers/fake-child.ts";
import { spawnSync } from "node:child_process";
import {
  DelegationRegistry,
  type DelegationDeps,
  type DelegationReceipt,
  type DelegationTransition,
  type StartOutcome,
  type StartRequest,
} from "../extensions/subagent/delegation-registry.ts";
import {
  clampLogTailBytes,
  DEFAULT_LOG_TAIL_BYTES,
  DEFAULT_WIDGET_KEY,
  DELEGATION_EVENTS_CHANNEL,
  DELEGATIONS_TOOL_NAME,
  formatLogTail,
  MAX_LOG_TAIL_BYTES,
  MIN_LOG_TAIL_BYTES,
  probePid,
  registerDelegationStatus,
  widgetLines,
  type PidLiveness,
} from "../extensions/subagent/delegation-status.ts";
import { DelegationResultCache, type DelegationResultEntry } from "../extensions/subagent/result-cache.ts";
import {
  default as sessionSignals,
  parseToolNames,
  TICK_MS,
} from "../extensions/session-signals/index.ts";

const NOW = 1_700_000_000_000;

// ------------------------------------------------------------------ fake pi harness

interface UiCapture {
	widgets: Array<[string, string[] | undefined]>;
	statuses: Array<[string, string | undefined]>;
	notifications: Array<{ message: string; type: string }>;
}

interface CommandRegistration {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

/** The slice of a registered tool the suite drives. */
interface ToolRecord {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

interface StatusHarness {
	pi: never;
	handlers: Map<string, (event: never, ctx: never) => unknown>;
	tools: Map<string, ToolRecord>;
	commands: Map<string, CommandRegistration>;
	bus: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
	busLog: Array<[string, unknown]>;
	fire: (name: string, event: Record<string, unknown>, ctx: unknown) => unknown;
}

function makePi(): StatusHarness {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const tools = new Map<string, ToolRecord>();
	const commands = new Map<string, CommandRegistration>();
	const busLog: Array<[string, unknown]> = [];
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		emit(channel: string, data: unknown): void {
			busLog.push([channel, data]);
			listeners.get(channel)?.forEach((handler) => handler(data));
		},
		on(channel: string, handler: (data: unknown) => void): () => void {
			const set = listeners.get(channel) ?? new Set();
			set.add(handler);
			listeners.set(channel, set);
			return () => set.delete(handler);
		},
	};
	const pi = {
		on: (name: string, fn: never) => handlers.set(name, fn),
		registerTool: (tool: ToolRecord) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: CommandRegistration) => commands.set(name, options),
		events: bus,
	} as never;
	const fire = (name: string, event: Record<string, unknown>, ctx: unknown) =>
		handlers.get(name)?.(event as never, ctx as never);
	return { pi, handlers, tools, commands, bus, busLog, fire };
}

function makeCtx(sessionId = "sess-test"): { ctx: Record<string, unknown>; ui: UiCapture } {
	const ui: UiCapture = { widgets: [], statuses: [], notifications: [] };
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/p",
		// M7: the no-id `results` action groups by the CURRENT session id — the tool context
		// carries the session manager the same way the real pi context does.
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (message: string, type = "info") => ui.notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => ui.statuses.push([key, text]),
			setWidget: (key: string, content: string[] | undefined) => ui.widgets.push([key, content]),
		},
	};
	return { ctx, ui };
}

// ------------------------------------------------------------------ fixtures

interface Fixture {
	registry: DelegationRegistry;
	harness: StatusHarness;
	ui: UiCapture;
	ctx: Record<string, unknown>;
	children: FakeChild[];
	transitions: () => DelegationTransition[];
	setClock: (n: number) => void;
	widgetKey: string;
	/** The result cache the status surface reads — rows seed it through `put`. */
	cache: DelegationResultCache;
}

function makeFixture(
	overrides: Partial<DelegationDeps> = {},
	opts: { widgetKey?: string; probePid?: (pid: number) => PidLiveness } = {},
): Fixture {
	let clock = NOW;
	const children: FakeChild[] = [];
	const harness = makePi();
	const { ctx, ui } = makeCtx();
	const registry = new DelegationRegistry({
		escalateAfterMs: 0,
		now: () => clock,
		spawnFn: () => {
			const child = new FakeChild();
			children.push(child);
			return child;
		},
		// Production wire (P3, T60): one serializable snapshot per registry transition,
		// published on the shared pi.events channel the status surface subscribes to.
		emit: (transition) => harness.bus.emit(DELEGATION_EVENTS_CHANNEL, transition),
		...overrides,
	});
	const cache = new DelegationResultCache();
	registerDelegationStatus(harness.pi, registry, {
		...(opts.widgetKey ? { widgetKey: opts.widgetKey } : {}),
		...(opts.probePid ? { probePid: opts.probePid } : {}),
		// Same injected clock the registry was built with — records carry its startedAt.
		now: () => clock,
		// M6: the cache→tool seam rides the established opts pattern (like staleRuns); the
		// cache is constructed here, beside the surface, and exposed for row seeding.
		resultCache: cache,
	});
	return {
		registry,
		harness,
		ui,
		ctx,
		children,
		transitions: () => harness.busLog.filter(([channel]) => channel === DELEGATION_EVENTS_CHANNEL).map(([, data]) => data as DelegationTransition),
		setClock: (n: number) => {
			clock = n;
		},
		widgetKey: opts.widgetKey ?? DEFAULT_WIDGET_KEY,
		cache,
	};
}

function startRequest(overrides: Partial<StartRequest> = {}): StartRequest {
	return { agent: "architect", task: "do the thing", args: ["--", "do the thing"], cwd: "/p", ...overrides };
}

/** Assert a start was admitted and narrow the outcome for the assertions that follow. */
function expectStarted(outcome: StartOutcome): DelegationReceipt {
	expect(outcome.ok).toBe(true);
	if (!outcome.ok) throw new Error(`expected an admitted start, got: ${outcome.reason}`);
	return outcome;
}

/**
 * A blocking delegation: the delegate tool call is in flight (tool_call fired, no
 * tool_result yet) while the run lives — the widget must not show it (T75).
 */
async function startBlocking(fx: Fixture, id: string, overrides: Partial<StartRequest> = {}): Promise<DelegationReceipt> {
	fx.harness.fire("tool_call", { toolName: "delegate", toolCallId: `tc-${id}`, input: { agent: "architect", task: "do the thing" } }, fx.ctx);
	const receipt = expectStarted(await fx.registry.start(startRequest({ id, toolCallId: `tc-${id}`, ...overrides })));
	return receipt;
}

/** A background delegation: the receipt (tool_result) landed while the run keeps going. */
async function startBackground(fx: Fixture, id: string, overrides: Partial<StartRequest> = {}): Promise<DelegationReceipt> {
	const receipt = await startBlocking(fx, id, overrides);
	fx.harness.fire("tool_result", { toolName: "delegate", toolCallId: `tc-${id}` }, fx.ctx);
	return receipt;
}

function lastWidget(fx: Fixture): [string, string[] | undefined] | undefined {
	const widgets = fx.ui.widgets;
	return widgets[widgets.length - 1];
}

/** The captured delegations tool (typed loosely; the suite only exercises its execute). */
function delegationsTool(fx: Fixture, ctxOverride?: Record<string, unknown>): { execute: (params: Record<string, unknown>) => ReturnType<ToolRecord["execute"]> } {
	const tool = fx.harness.tools.get(DELEGATIONS_TOOL_NAME);
	if (!tool) throw new Error("delegations tool not registered");
	return {
		execute: (params) => tool.execute("tool-call-id", params as never, undefined as never, undefined as never, (ctxOverride ?? fx.ctx) as never),
	};
}

function lastNotification(fx: Fixture): { message: string; type: string } {
	const notifications = fx.ui.notifications;
	const last = notifications[notifications.length - 1];
	if (!last) throw new Error("expected a notification, none was sent");
	return last;
}

// ------------------------------------------------------------------ row 49: /delegations status with a mixed fleet

describe("row 49: /delegations status command with a mixed fleet", () => {
	test("1 running + 1 queued + 1 exited → three correctly-phased lines, start order", async () => {
		const fx = makeFixture({ cap: 1, queueCap: 16 }, { widgetKey: "row49" });

		// d-3 starts and exits first (oldest startedAt); then d-1 runs while d-2 queues (cap 1).
		await fx.registry.start(startRequest({ id: "d-3", toolCallId: "tc-d-3" }));
		fx.children[0]!.exit(0);
		fx.setClock(NOW + 1000);
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-d-1" }));
		fx.setClock(NOW + 2000);
		await fx.registry.start(startRequest({ id: "d-2", toolCallId: "tc-d-2" }));

		const command = fx.harness.commands.get("delegations");
		expect(command).toBeDefined();
		await command!.handler("", fx.ctx);

		const { message } = lastNotification(fx);
		const lines = message.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("d-3 architect — done");
		expect(lines[1]).toBe("d-1 architect — 1s");
		expect(lines[2]).toBe("d-2 architect — queued (position 1)");
	});

	test("an empty fleet answers plainly, not with an empty panel (T114 wording: emptiness is identified)", async () => {
		const fx = makeFixture();
		await fx.harness.commands.get("delegations")!.handler("", fx.ctx);
		expect(lastNotification(fx).message).toBe("registry empty (0 records)");
	});
});

// ------------------------------------------------------------------ row 50: widget key distinct from session-signals status key

describe("row 50: the widget key is distinct from session-signals' status key", () => {
	test("default widget key is not the footer's 'pi-badger'", () => {
		expect(DEFAULT_WIDGET_KEY).not.toBe("pi-badger");
		expect(DEFAULT_WIDGET_KEY).toBe("pi-badger-delegations");
	});

	test("a live background run sets the widget under the default key", async () => {
		const fx = makeFixture();
		await startBackground(fx, "d-1");

		const widget = lastWidget(fx);
		expect(widget).toBeDefined();
		expect(widget![0]).toBe(DEFAULT_WIDGET_KEY);
		expect(widget![1]?.join("\n")).toContain("d-1 architect");
	});

	test("opts.widgetKey overrides the key", async () => {
		const fx = makeFixture({}, { widgetKey: "custom-key" });
		await startBackground(fx, "d-1");
		expect(lastWidget(fx)![0]).toBe("custom-key");
	});
});

// ------------------------------------------------------------------ T75: widget renders background/queued runs only

describe("T75: the widget renders background/queued runs only (review CR17)", () => {
	test("a blocking-mode delegation produces no widget line", async () => {
		const fx = makeFixture();
		await startBlocking(fx, "d-1"); // tool_call fired, receipt not landed — blocking

		const widget = lastWidget(fx);
		expect(widget).toBeDefined(); // transitions still re-render the widget
		expect(widget![1]).toBeUndefined(); // but a blocking run is invisible to it
	});

	test("a background delegation gets a line: id, agent, elapsed, activity, ↓tokens", async () => {
		const fx = makeFixture();
		const receipt = await startBlocking(fx, "d-1");
		expect(receipt.record.state).toBe("running");

		// Live progress lands while the receipt is out: activity + output tokens.
		fx.children[0]!.emitEvent({
			type: "tool_execution_start",
			toolName: "bash",
		});
		fx.children[0]!.emitEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "working" }], usage: { input: 10, output: 1234, totalTokens: 1244 } },
		});

		// The receipt lands while the run is still going → the run becomes background.
		fx.harness.fire("tool_result", { toolName: "delegate", toolCallId: "tc-d-1" }, fx.ctx);

		const widget = lastWidget(fx)!;
		expect(widget[0]).toBe(DEFAULT_WIDGET_KEY);
		const content = widget[1]!.join("\n");
		expect(content).toContain("d-1 architect");
		expect(content).toContain("running…"); // R9: bash maps to a stable verb label
		expect(content).toContain("↓1.2k");
	});

	test("queued background runs render as a count line, not per-run lines", async () => {
		const fx = makeFixture({ cap: 1, queueCap: 16 });
		await startBackground(fx, "d-1");
		fx.harness.fire("tool_call", { toolName: "delegate", toolCallId: "tc-d-2", input: {} }, fx.ctx);
		const queued = expectStarted(await fx.registry.start(startRequest({ id: "d-2", toolCallId: "tc-d-2" })));
		expect(queued.record.state).toBe("queued");
		fx.harness.fire("tool_result", { toolName: "delegate", toolCallId: "tc-d-2" }, fx.ctx);

		const content = lastWidget(fx)![1]!.join("\n");
		expect(content).toContain("1 queued");
		expect(content).not.toContain("d-2"); // queued runs are summarized by the count
		expect(content).toContain("d-1 architect"); // the running one keeps its line
	});

	test("when the last live run settles the widget is cleared", async () => {
		const fx = makeFixture();
		await startBackground(fx, "d-1");
		expect(lastWidget(fx)![1]).toBeDefined();

		fx.children[0]!.exit(0); // terminal transition → re-render → nothing live

		expect(lastWidget(fx)![1]).toBeUndefined();
	});

	test("session_shutdown clears the widget and stops the tick", async () => {
		const fx = makeFixture();
		await startBackground(fx, "d-1");
		expect(lastWidget(fx)![1]).toBeDefined();

		fx.harness.fire("session_shutdown", { type: "session_shutdown" }, fx.ctx);
		expect(lastWidget(fx)![1]).toBeUndefined();
	});

	test("the pure panel: nothing live is undefined; blocking runs are filtered by the caller's set", () => {
		const live = { id: "d-1", agent: "architect", task: "t", toolCallId: "tc-1", state: "running" as const, startedAt: NOW, usage: { input: 1, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		const queued = { id: "d-2", agent: "qa", task: "t", toolCallId: "tc-2", state: "queued" as const, startedAt: NOW, queuePosition: 1 };
		expect(widgetLines([], new Set(), NOW)).toBeUndefined();
		expect(widgetLines([live], new Set(), NOW)).toEqual(["d-1 architect — 0s — ↑1 ↓7"]);
		expect(widgetLines([live], new Set(["tc-1"]), NOW)).toBeUndefined(); // blocking → hidden
		expect(widgetLines([live, queued], new Set(), NOW)).toEqual(["d-1 architect — 0s — ↑1 ↓7", "1 queued"]);
	});

	test("the widget line carries the full usage string: ↑ ↓ CR% ctx% $ (contextWindow renders ctx as a share)", () => {
		const rich = { id: "d-1", agent: "architect", task: "t", toolCallId: "tc-1", state: "running" as const, startedAt: NOW, usage: { input: 100, output: 7, cacheRead: 300, cacheWrite: 0, cost: 0.5, contextTokens: 500, turns: 1 } };
		expect(widgetLines([rich], new Set(), NOW, 1000)).toEqual([
			"d-1 architect — 0s — ↑100 ↓7 CR75% ctx:50% $0.5000",
		]);
		// no window → absolute ctx fallback
		expect(widgetLines([rich], new Set(), NOW)).toEqual([
			"d-1 architect — 0s — ↑100 ↓7 CR75% ctx:500 $0.5000",
		]);
	});
});

// ------------------------------------------------------------------ T76: delegations tool contract details

describe("T76: delegations tool contract details (review CR10)", () => {
	test("the tool is registered under the exact name the child denylist names", () => {
		const fx = makeFixture();
		expect(DELEGATIONS_TOOL_NAME).toBe("delegations");
		expect(fx.harness.tools.has("delegations")).toBe(true);
	});

	test("abort without an id is a usage error", async () => {
		const fx = makeFixture();
		await expect(delegationsTool(fx).execute({ action: "abort" })).rejects.toThrow(/abort needs a run id/);
	});

	test("abort with an id goes through the registry kill path", async () => {
		const fx = makeFixture();
		await startBackground(fx, "d-1");

		const result = await delegationsTool(fx).execute({ action: "abort", id: "d-1" });

		expect(fx.children[0]!.signals).toEqual(["SIGTERM"]);
		expect(fx.registry.get("d-1")?.state).toBe("aborted");
		expect(result.content[0]!.text).toContain("d-1");
	});

	test("log on an unknown id is a loud error", async () => {
		const fx = makeFixture();
		await expect(delegationsTool(fx).execute({ action: "log", id: "d-nope" })).rejects.toThrow(/unknown delegation id "d-nope"/);
	});

	test("log without a log file answers 'log unavailable' (R4 review CR6)", async () => {
		const fx = makeFixture(); // no logSink → the record carries no logFile
		await startBackground(fx, "d-1");

		const result = await delegationsTool(fx).execute({ action: "log", id: "d-1" });
		expect(result.content[0]!.text).toContain("log unavailable");
	});

	test("log tails the run's log file, bounded, with the full path pointer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delegation-log-"));
		try {
			const fx = makeFixture({
				logSink: ({ id }) => ({
					logFile: join(dir, `${id}.jsonl`),
					appendLine: (line) => appendFileSync(join(dir, `${id}.jsonl`), `${line}\n`),
				}),
			});
			await startBackground(fx, "d-1");
			fx.children[0]!.emitEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(12_000) }], usage: { input: 1, output: 1 } },
			});
			fx.children[0]!.exit(0);

			const result = await delegationsTool(fx).execute({ action: "log", id: "d-1" });
			const text = result.content[0]!.text;
			expect(text).toContain("earlier bytes dropped"); // bounded tail marker
			expect(text).toContain("full log:"); // the pointer to the complete file
			expect(text).toContain(join(dir, "d-1.jsonl"));
			expect(text).toContain('"exitCode":0'); // the tail keeps the end of the stream
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("log tail bounds and clamping (512–49152, default 8192)", () => {
		expect(DEFAULT_LOG_TAIL_BYTES).toBe(8192);
		expect(MIN_LOG_TAIL_BYTES).toBe(512);
		expect(MAX_LOG_TAIL_BYTES).toBe(49152);
		expect(clampLogTailBytes(1)).toBe(512);
		expect(clampLogTailBytes(999_999)).toBe(49152);
		expect(clampLogTailBytes(4096)).toBe(4096);

		const { text, droppedBytes } = formatLogTail("a\nb\nc", 2);
		expect(text).toBe("c"); // snapped forward to a whole line
		expect(droppedBytes).toBe(4);
		const whole = formatLogTail("short", 8192);
		expect(whole.text).toBe("short");
		expect(whole.droppedBytes).toBe(0);
	});
});

// ------------------------------------------------------------------ M6/M7: the results action over the in-memory cache

/** Seed one cache entry the honest way: through the cache's own put (what production does). */
function seedResult(fx: Fixture, id: string, sessionId: string | undefined, at: number): DelegationResultEntry {
	return fx.cache.put(
		{ id, agent: "architect", task: `task for ${id}`, answer: `answer of ${id}`, ...(sessionId !== undefined ? { sessionId } : {}) },
		{ now: () => at },
	);
}

describe("M6/M7 — the delegations results action over the in-memory cache (f: 2026-09-02, option c)", () => {
	test("results without an id returns only this session's entries (parent_id grouping, insertion order)", async () => {
		const fx = makeFixture();
		seedResult(fx, "d-1", "sess-test", NOW + 1);
		seedResult(fx, "d-2", "sess-test", NOW + 2);
		seedResult(fx, "d-3", "sess-other", NOW + 3);

		const result = await delegationsTool(fx).execute({ action: "results" });

		const details = result.details as { parentId: string; results: DelegationResultEntry[] };
		expect(details.parentId).toBe("sess-test");
		expect(details.results.map((entry) => entry.delegation_id)).toEqual(["d-1", "d-2"]);
		expect(result.content[0]!.text).toContain("d-1 (architect)");
		expect(result.content[0]!.text).toContain("answer of d-2");
		expect(result.content[0]!.text).not.toContain("d-3");
	});

	test("the no-id group key derives from the ctx's sessionManager — a sess-Z ctx never sees sess-test decoys seeded first", async () => {
		const fx = makeFixture();
		seedResult(fx, "d-1", "sess-test", NOW + 1); // decoys FIRST: a data-derived grouping would return these
		seedResult(fx, "d-2", "sess-Z", NOW + 2);

		const { ctx } = makeCtx("sess-Z");
		const result = await delegationsTool(fx, ctx).execute({ action: "results" });

		const details = result.details as { parentId: string; results: DelegationResultEntry[] };
		expect(details.parentId).toBe("sess-Z"); // from the ctx, not from cache.all()[0]
		expect(details.results.map((entry) => entry.delegation_id)).toEqual(["d-2"]);
		expect(result.content[0]!.text).not.toContain("d-1");
	});

	test("results without an id and no sessionManager on the context → an empty group, not a throw", async () => {
		const fx = makeFixture();
		seedResult(fx, "d-1", "sess-test", NOW + 1);
		const { ctx } = makeCtx();
		delete (ctx as Record<string, unknown>).sessionManager;
		const tool = fx.harness.tools.get(DELEGATIONS_TOOL_NAME)!;

		const result = await (tool.execute as ToolRecord["execute"])("tc", { action: "results" }, undefined as never, undefined as never, ctx as never);

		const details = result.details as { parentId: string | undefined; results: DelegationResultEntry[] };
		expect(details.parentId).toBeUndefined();
		expect(details.results).toEqual([]); // empty group — never a throw
		expect(String(result.content[0]!.text)).toContain("no cached results");
	});

	test("results without an id when getSessionId throws is LOUD — 'cannot determine the current session', byte-distinct from the registry's unknown-id error", async () => {
		const fx = makeFixture();
		const throwingCtx = {
			...fx.ctx,
			sessionManager: {
				getSessionId: () => {
					throw new Error("boom");
				},
			},
		};
		const tool = fx.harness.tools.get(DELEGATIONS_TOOL_NAME)!;
		const error = await (tool.execute as ToolRecord["execute"])("tc", { action: "results" }, undefined as never, undefined as never, throwingCtx as never).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("cannot determine the current session — pass an id");
		expect((error as Error).message).not.toContain("unknown delegation id"); // the registry was never consulted
	});

	test("results with an id returns that delegation's cached entry (details.result, like the cards)", async () => {
		const fx = makeFixture();
		const seeded = seedResult(fx, "d-7", "sess-test", NOW + 7);

		const result = await delegationsTool(fx).execute({ action: "results", id: "d-7" });

		expect((result.details as { result: DelegationResultEntry }).result).toEqual(seeded);
		expect(result.content[0]!.text).toContain("d-7");
		expect(result.content[0]!.text).toContain("answer of d-7");
	});

	test("a surface registered without the resultCache seam answers loudly and never crashes on the missing reads", async () => {
		const fx = makeFixture();
		// The seam is optional by design (staleRuns pattern) — re-register without it; the fake
		// harness keys tools by name, so this row's surface replaces the fixture's.
		registerDelegationStatus(fx.harness.pi as never, fx.registry, { now: () => NOW });

		const noId = await delegationsTool(fx).execute({ action: "results" });
		expect(String(noId.content[0]!.text)).toContain("no cached results");

		const unknown = await delegationsTool(fx).execute({ action: "results", id: "d-9" });
		expect(String(unknown.content[0]!.text)).toContain("not in the cache (last 8)");
	});

	test("results with a live-but-uncached id → 'no cached result yet (state: running)'; a queued id states 'queued'", async () => {
		const fx = makeFixture({ cap: 1, queueCap: 16 });
		await startBackground(fx, "d-1");
		await startBackground(fx, "d-2");

		const running = await delegationsTool(fx).execute({ action: "results", id: "d-1" });
		expect(running.content[0]!.text).toBe("delegation d-1: no cached result yet (state: running)");
		const queued = await delegationsTool(fx).execute({ action: "results", id: "d-2" });
		expect(queued.content[0]!.text).toBe("delegation d-2: no cached result yet (state: queued)");
	});

	test("results with an id that settled outside the cache window → 'not in the cache (last 8) — the run may predate the window; use delegations list'", async () => {
		const fx = makeFixture();
		await startBackground(fx, "d-1");
		fx.children[0]!.exit(0);

		const result = await delegationsTool(fx).execute({ action: "results", id: "d-1" });
		expect(result.content[0]!.text).toBe(
			"delegation d-1: not in the cache (last 8) — the run may predate the window; use delegations list",
		);
	});

	test("an unknown action is a usage error naming the full set: list, log, abort, results", async () => {
		const fx = makeFixture();
		await expect(delegationsTool(fx).execute({ action: "wait" } as never)).rejects.toThrow(
			"delegations action must be one of list, log, abort, results",
		);
	});

	test("the delegations description documents the results action and the last-8 window", () => {
		const fx = makeFixture();
		const description = String((fx.harness.tools.get(DELEGATIONS_TOOL_NAME) as unknown as { description: string }).description);
		expect(description).toContain("results");
		expect(description).toContain("last 8");
	});
});

// ------------------------------------------------------------------ T77: session-signals tick-defer (review A3/Q2i)

describe("T77: session-signals tick-defer and the delegations watch-list entry", () => {
	test("delegations is in the default watch list so `wait` is footer-visible", () => {
		expect(parseToolNames({})).toEqual(["delegate", "delegations"]);
		expect(parseToolNames({ PI_BADGER_DELEGATION_TOOLS: "  " })).toEqual(["delegate", "delegations"]);
	});

	test("a background receipt landing before the first tick never renders the footer", async () => {
		const harness = makePi();
		const { ctx, ui } = makeCtx();
		sessionSignals(harness.pi as never);

		harness.fire("tool_call", { toolName: "delegate", toolCallId: "c1", input: { agent: "architect", task: "x" } }, ctx);
		harness.fire("tool_result", { toolName: "delegate", toolCallId: "c1" }, ctx);

		// The receipt landed sub-second: no tick has fired, and no footer text was ever set.
		expect(ui.statuses.filter(([, text]) => text !== undefined)).toEqual([]);
	});

	test("a blocking delegation still renders at the first tick", async () => {
		const harness = makePi();
		const { ctx, ui } = makeCtx();
		sessionSignals(harness.pi as never);

		harness.fire("tool_call", { toolName: "delegate", toolCallId: "c1", input: { agent: "architect", task: "x" } }, ctx);
		expect(ui.statuses).toEqual([]); // nothing immediate — the flash is gone (R9)

		await new Promise((resolve) => setTimeout(resolve, TICK_MS + 300));

		const rendered = ui.statuses.filter(([, text]) => text !== undefined);
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered[rendered.length - 1]![1]).toContain("delegate architect —");

		harness.fire("tool_result", { toolName: "delegate", toolCallId: "c1" }, ctx); // let the ticker wind down
	}, 15_000);
});

// ------------------------------------------------------------------ T78: /delegations shares the registry path with the tool

describe("T78: the /delegations command shares the registry path with the tool", () => {
	test("command abort d-3 produces the same registry transition as the tool abort", async () => {
		// Command path.
		const viaCommand = makeFixture();
		await viaCommand.registry.start(startRequest({ id: "d-3", toolCallId: "tc-d-3" }));
		await viaCommand.harness.commands.get("delegations")!.handler("abort d-3", viaCommand.ctx);

		expect(viaCommand.children[0]!.signals).toEqual(["SIGTERM"]);
		expect(viaCommand.registry.get("d-3")?.state).toBe("aborted");
		const commandStates = viaCommand.transitions().map((t) => t.state);
		expect(commandStates).toEqual(["running", "aborted"]);

		// Tool path — identical transition sequence through the same registry.
		const viaTool = makeFixture();
		await viaTool.registry.start(startRequest({ id: "d-3", toolCallId: "tc-d-3" }));
		await delegationsTool(viaTool).execute({ action: "abort", id: "d-3" });

		const toolStates = viaTool.transitions().map((t) => t.state);
		expect(toolStates).toEqual(commandStates);
	});

	test("command abort all aborts every live run", async () => {
		const fx = makeFixture({ cap: 2 });
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-d-1" }));
		await fx.registry.start(startRequest({ id: "d-2", toolCallId: "tc-d-2" }));

		await fx.harness.commands.get("delegations")!.handler("abort all", fx.ctx);

		expect(fx.registry.get("d-1")?.state).toBe("aborted");
		expect(fx.registry.get("d-2")?.state).toBe("aborted");
		expect(lastNotification(fx).message).toContain("abort requested");
	});

	test("command log goes through the same log path as the tool", async () => {
		const fx = makeFixture(); // no sink → log unavailable, same as the tool
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-d-1" }));

		await fx.harness.commands.get("delegations")!.handler("log d-1", fx.ctx);
		expect(lastNotification(fx).message).toContain("log unavailable");
	});

	test("an unknown subcommand answers with usage", async () => {
		const fx = makeFixture();
		await fx.harness.commands.get("delegations")!.handler("frobnicate", fx.ctx);
		expect(lastNotification(fx).message).toContain("usage: /delegations");
	});

	test("getArgumentCompletions offers the subcommands and live registry ids", async () => {
		const fx = makeFixture({ cap: 2, queueCap: 16 });
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-d-1" })); // running
		await fx.registry.start(startRequest({ id: "d-2", toolCallId: "tc-d-2" })); // running
		await fx.registry.start(startRequest({ id: "d-0", toolCallId: "tc-d-0" })); // queued — live
		fx.children[0]!.exit(0); // d-1 settles terminal; the queue head (d-0) is admitted running

		const completions = fx.harness.commands.get("delegations")!.getArgumentCompletions!;
		const first = completions("") as Array<{ value: string }>;
		expect(first.map((item) => item.value)).toEqual(["log", "abort"]);

		const ids = completions("abort d") as Array<{ value: string }>;
		expect(ids.map((item) => item.value)).toEqual(["d-2", "d-0"]); // live ids only — terminal d-1 excluded

		expect(completions("bogus")).toBeNull();
	});
});

// ------------------------------------------------------------------ T89/T91: timeout surfaces (deferral pkg P2)

describe("T89/T91 — timeout surfaces on the delegations tool (deferral pkg P2)", () => {
	test("T89: list renders a timed-out run as 'aborted (timeout)'", async () => {
		const fx = makeFixture();
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-1", timeoutMs: 5 }));
		await drainRegistryTimers();

		// drive the expiry through the real registry (fake-pi style: no awaits on ticks)
		const list = await delegationsTool(fx).execute({ action: "list" });
		expect(String(list.content[0]!.text)).toContain("d-1 architect — aborted (timeout) —");
	});

	test("T89: a user-aborted run still renders plain 'aborted'", async () => {
		const fx = makeFixture();
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-1" }));
		fx.registry.abort("d-1");

		const list = await delegationsTool(fx).execute({ action: "list" });
		expect(String(list.content[0]!.text)).toContain("d-1 architect — aborted —");
		expect(String(list.content[0]!.text)).not.toContain("(timeout)");
	});

	test("T91 (delegations side): the description drops the no-automatic-timeout claim and names timeoutMs", () => {
		const fx = makeFixture();
		const tool = fx.harness.tools.get(DELEGATIONS_TOOL_NAME)!;
		const description = String((tool as unknown as { description: string }).description);

		expect(description).not.toContain("no automatic per-run timeout");
		expect(description).toContain("timeoutMs");
	});
});

/** Drain past the 1 s floored timeout used by the fixtures above. */
function drainRegistryTimers(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 1100));
}

// ------------------------------------------------------------------ T115/T116: lost rendering + liveness probe (pkg P2)

/** A genuinely dead pid: a real short-lived process that has already been reaped. */
function deadPid(): number {
	const proc = spawnSync(process.execPath, ["-e", ""]);
	return proc.pid ?? 999_999;
}

describe("T115 — list renders a watchdog-lost run (pkg P2)", () => {
	test("a real lost settle renders 'aborted (lost)' through the tool", async () => {
		const fx = makeFixture({ runWatchdogMs: 1000 });
		await fx.registry.start(startRequest({ id: "d-1", toolCallId: "tc-1" }));
		await drainRegistryTimers(); // the watchdog fires through the real registry

		const list = await delegationsTool(fx).execute({ action: "list" });
		expect(String(list.content[0]!.text)).toContain("d-1 architect — aborted (lost) —");
	}, 20_000);
});

describe("T116 — liveness probe on the delegations list (RR3, pkg P2)", () => {
	test("probePid: a live pid is alive; a reaped pid is dead", () => {
		expect(probePid(process.pid)).toBe("alive");
		expect(probePid(deadPid())).toBe("dead");
	});

	test("a running record carries the liveness line; EPERM-style unknown never renders as dead", async () => {
		const fx = makeFixture({}, { probePid: () => "unknown" });
		await startBackground(fx, "d-1");

		const text = String((await delegationsTool(fx).execute({ action: "list" })).content[0]!.text);
		expect(text).toContain("d-1 architect — 0s — unknown — task:");
		expect(text).not.toContain("dead"); // unknown is never rendered as dead (RR3)
		expect(text).not.toContain("alive");
	});

	test("a dead-but-unsettled pid renders 'lost (dead pid)'; a live pid renders 'alive'", async () => {
		const dead = makeFixture({}, { probePid: () => "dead" });
		await startBackground(dead, "d-1");
		const deadText = String((await delegationsTool(dead).execute({ action: "list" })).content[0]!.text);
		expect(deadText).toContain("d-1 architect — 0s — lost (dead pid) — task:");

		const live = makeFixture({}, { probePid: () => "alive" });
		await startBackground(live, "d-1");
		const liveText = String((await delegationsTool(live).execute({ action: "list" })).content[0]!.text);
		expect(liveText).toContain("d-1 architect — 0s — alive — task:");
	});

	test("settled records skip the probe (N4)", async () => {
		const probed: number[] = [];
		const fx = makeFixture({}, { probePid: (pid) => (probed.push(pid), "alive" as PidLiveness) });
		await startBackground(fx, "d-1");
		expect(probed).toHaveLength(0); // starts never probe — only list does

		await delegationsTool(fx).execute({ action: "list" });
		expect(probed).toHaveLength(1); // the running record was probed

		fx.children[0]!.exit(0);
		const text = String((await delegationsTool(fx).execute({ action: "list" })).content[0]!.text);
		expect(probed).toHaveLength(1); // the settled record was not probed again
		expect(text).toContain("done");
		expect(text).not.toContain("alive");
	});

	test("queued records skip the probe (N4)", async () => {
		const probed: number[] = [];
		const fx = makeFixture({ cap: 1, queueCap: 16 }, { probePid: (pid) => (probed.push(pid), "alive" as PidLiveness) });
		await startBackground(fx, "d-1");
		await startBackground(fx, "d-2");

		const text = String((await delegationsTool(fx).execute({ action: "list" })).content[0]!.text);
		expect(probed).toHaveLength(1); // only the running record; the queued one has no pid
		const queuedLine = text.split("\n").find((line) => line.startsWith("d-2"))!;
		expect(queuedLine).toContain("queued");
		expect(queuedLine).not.toContain("alive");
	});
});

describe("T123 — probePid's EPERM branch witnessed directly (d-52 NIT-3)", () => {
  test("a process.kill EPERM failure reports 'unknown' — never 'dead'", () => {
    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error("Operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;
    try {
      expect(probePid(12345)).toBe("unknown");
    } finally {
      process.kill = originalKill;
    }
  });
});


