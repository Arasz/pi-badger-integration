/**
 * Unit tests for the session-signals extension: the marker grammar (meaning + importance
 * split), the interrupt decision, the delegation tracker/status rendering, and the real
 * factory wiring driven through a fake pi. Each test names the failure mode it targets.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	DelegationTracker,
	default as sessionSignals,
	parseMarker,
	parseToolNames,
	renderStatus,
	shouldInterrupt,
	type MarkerName,
} from "../../extensions/session-signals/index.ts";

describe("marker grammar: meaning and importance are split", () => {
	test("every base marker parses with its long and short alias", () => {
		const cases: Array<[string, MarkerName]> = [
			["h:", "hint"], ["hint:", "hint"],
			["f:", "feedback"], ["feedback:", "feedback"],
			["e:", "extension"], ["extension:", "extension"],
			["q:", "queue"], ["queue:", "queue"],
			["i:", "important"], ["important:", "important"],
		];
		for (const [text, marker] of cases) {
			expect(parseMarker(text)).toEqual({ marker, bang: false });
		}
	});

	test("the importance token is a ! between alias and colon, for EVERY marker", () => {
		const cases: Array<[string, MarkerName]> = [
			["h!:", "hint"], ["hint!:", "hint"],
			["f!:", "feedback"], ["feedback!:", "feedback"],
			["e!:", "extension"], ["extension!:", "extension"],
			["q!:", "queue"], ["queue!:", "queue"],
			["i!:", "important"], ["important!:", "important"],
		];
		for (const [text, marker] of cases) {
			expect(parseMarker(text)).toEqual({ marker, bang: true });
		}
	});

	test("legacy spellings are unchanged: i!: and important!: keep interrupting", () => {
		expect(parseMarker("i!: stop everything")).toEqual({ marker: "important", bang: true });
	});

	test("leading whitespace is allowed; a marker mid-line is not a marker", () => {
		expect(parseMarker("  f!: do this instead")).toEqual({ marker: "feedback", bang: true });
		expect(parseMarker("please f!: look")).toBeUndefined();
	});

	test("non-markers stay non-markers (anchored, no substring drift)", () => {
		for (const text of ["hello", "ff: x", "::", "h ! : x", "h !:", "a hint: no", "", "f", "f! x"]) {
			expect(parseMarker(text)).toBeUndefined();
		}
	});

	test("case-insensitive, and the rest of the line is not our business", () => {
		expect(parseMarker("F!: stop")).toEqual({ marker: "feedback", bang: true });
		expect(parseMarker("Queue: do after")).toEqual({ marker: "queue", bang: false });
	});

	test("non-string input never throws", () => {
		expect(parseMarker(undefined as unknown as string)).toBeUndefined();
		expect(parseMarker(42 as unknown as string)).toBeUndefined();
	});
});

describe("interrupt decision: bang only matters while there is a run to break", () => {
	test("a !-marker aborts when busy — steer and followUp alike", () => {
		expect(shouldInterrupt(true, "steer")).toBe(true);
		expect(shouldInterrupt(true, "followUp")).toBe(true);
	});

	test("a !-marker while idle has nothing to break", () => {
		expect(shouldInterrupt(true, undefined)).toBe(false);
	});

	test("without the ! token behavior is exactly as before, busy or not", () => {
		expect(shouldInterrupt(false, "followUp")).toBe(false);
		expect(shouldInterrupt(false, undefined)).toBe(false);
	});
});

describe("delegation tracker: pure state for in-flight delegations", () => {
	test("onCall then onResult tracks and clears one delegation", () => {
		const t = new DelegationTracker();
		t.onCall("c1", "architect", 1000);
		expect(t.activeEntries()).toEqual([{ toolCallId: "c1", label: "architect", startedAt: 1000 }]);
		expect(t.onResult("c1")).toBe(true);
		expect(t.activeEntries()).toEqual([]);
	});

	test("parallel delegations coexist and sort by start time", () => {
		const t = new DelegationTracker();
		t.onCall("b", "second", 2000);
		t.onCall("a", "first", 1000);
		expect(t.activeEntries().map((e) => e.label)).toEqual(["first", "second"]);
		expect(t.onResult("b")).toBe(true);
		expect(t.activeEntries().map((e) => e.label)).toEqual(["first"]);
	});

	test("a result for an unknown call id is ignored, and results are not double-counted", () => {
		const t = new DelegationTracker();
		expect(t.onResult("nope")).toBe(false);
		t.onCall("c1", "qa", 0);
		expect(t.onResult("c1")).toBe(true);
		expect(t.onResult("c1")).toBe(false);
	});
});

describe("status rendering: footer text or an explicit clear", () => {
	test("no active delegations clears the status line (undefined, not empty string)", () => {
		expect(renderStatus([], Date.now())).toBeUndefined();
	});

	test("one delegation renders label + human elapsed", () => {
		expect(renderStatus([{ toolCallId: "c1", label: "architect", startedAt: 0 }], 92_000))
			.toBe("⏳ delegate architect — 1m32s");
		expect(renderStatus([{ toolCallId: "c1", label: "qa", startedAt: 0 }], 7_000))
			.toBe("⏳ delegate qa — 7s");
	});

	test("parallel delegations join; a negative elapsed clamps to zero", () => {
		const text = renderStatus(
			[
				{ toolCallId: "a", label: "first", startedAt: 0 },
				{ toolCallId: "b", label: "second", startedAt: 1000 },
			],
			61_000,
		);
		expect(text).toBe("⏳ delegate first — 1m01s · delegate second — 1m00s");
	});
});

describe("tool-name source: env override or the default delegate tool", () => {
	test("default is the ai-badger subagent extension's delegate tool", () => {
		expect(parseToolNames({})).toEqual(["delegate"]);
		expect(parseToolNames({ PI_BADGER_DELEGATION_TOOLS: "  " })).toEqual(["delegate"]);
	});

	test("override is a comma-separated list; empty entries drop out; a fully empty value falls back", () => {
		expect(parseToolNames({ PI_BADGER_DELEGATION_TOOLS: "delegate, spawn , task" }))
			.toEqual(["delegate", "spawn", "task"]);
		expect(parseToolNames({ PI_BADGER_DELEGATION_TOOLS: ",," })).toEqual(["delegate"]);
	});
});

// ---------------------------------------------------------------- factory wiring

interface Harness {
	handlers: Map<string, (event: never, ctx: never) => unknown>;
	pi: never;
	fire: (event: Record<string, unknown>, ctx: unknown) => unknown;
	fireNamed: (name: string, event: Record<string, unknown>, ctx: unknown) => unknown;
}

function makePi(): Harness {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const pi = { on: (name: string, fn: never) => handlers.set(name, fn) } as never;
	const fireNamed = (name: string, event: Record<string, unknown>, ctx: unknown) =>
		handlers.get(name)?.(event as never, ctx as never);
	const fire = (event: Record<string, unknown>, ctx: unknown) => fireNamed("input", event, ctx);
	return { handlers, pi, fire, fireNamed };
}

function makeCtx(): { ctx: Record<string, unknown>; aborts: { count: number }; notifications: string[]; statuses: Array<[string, string | undefined]> } {
	const aborts = { count: 0 };
	const notifications: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		abort: () => {
			aborts.count += 1;
		},
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push([key, text]);
			},
		},
	};
	return { ctx, aborts, notifications, statuses };
}

describe("factory wiring: the input handler aborts on interrupt-grade markers", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makePi();
		sessionSignals(harness.pi);
	});

	test("registers the three handlers it needs", () => {
		expect([...harness.handlers.keys()].sort()).toEqual(["input", "tool_call", "tool_result"]);
	});

	test("a !-marker while busy (followUp) aborts the run, notifies, and still lets the message flow", async () => {
		const { ctx, aborts, notifications } = makeCtx();
		const result = await harness.fire({ text: "f!: stop and do X instead", streamingBehavior: "followUp" }, ctx as never);
		expect(aborts.count).toBe(1);
		expect(notifications.join("\n")).toContain("feedback!");
		expect(result).toEqual({ action: "continue" });
	});

	test("a !-marker mid-stream (steer) aborts too", async () => {
		const { ctx, aborts } = makeCtx();
		await harness.fire({ text: "q!: switch tasks", streamingBehavior: "steer" }, ctx as never);
		expect(aborts.count).toBe(1);
	});

	test("a !-marker while idle does not abort — there is nothing to break", async () => {
		const { ctx, aborts, notifications } = makeCtx();
		await harness.fire({ text: "i!: begin, carefully", streamingBehavior: undefined }, ctx as never);
		expect(aborts.count).toBe(0);
		expect(notifications).toEqual([]);
	});

	test("a marker without ! never aborts, even mid-run — old behavior intact", async () => {
		const { ctx, aborts } = makeCtx();
		await harness.fire({ text: "q: do this later", streamingBehavior: "followUp" }, ctx as never);
		expect(aborts.count).toBe(0);
	});

	test("non-marker input is passed through untouched", async () => {
		const { ctx, aborts } = makeCtx();
		const result = await harness.fire({ text: "just a normal prompt", streamingBehavior: "followUp" }, ctx as never);
		expect(aborts.count).toBe(0);
		expect(result).toEqual({ action: "continue" });
	});
});

describe("factory wiring: delegation status rides the delegate tool events", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makePi();
		sessionSignals(harness.pi);
	});

	function fireToolCall(ctx: unknown, toolCallId = "c1"): unknown {
		return harness.fireNamed("tool_call", { toolName: "delegate", toolCallId, input: { agent: "architect", task: "x" } }, ctx);
	}

	function fireToolResult(ctx: unknown, toolCallId = "c1"): unknown {
		return harness.fireNamed("tool_result", { toolName: "delegate", toolCallId }, ctx);
	}

	test("a delegate tool_call shows the running delegation in the footer", async () => {
		const { ctx, statuses } = makeCtx();
		await fireToolCall(ctx);
		const [key, text] = statuses[statuses.length - 1];
		expect(key).toBe("pi-badger");
		expect(text).toContain("delegate architect —");
	});

	test("the tool_result clears the footer", async () => {
		const { ctx, statuses } = makeCtx();
		await fireToolCall(ctx);
		await fireToolResult(ctx);
		expect(statuses[statuses.length - 1]).toEqual(["pi-badger", undefined]);
	});

	test("non-delegation tools never touch the footer; an unknown result id is a no-op", async () => {
		const { ctx, statuses } = makeCtx();
		await harness.fireNamed("tool_call", { toolName: "bash", toolCallId: "x", input: {} }, ctx);
		await harness.fireNamed("tool_result", { toolName: "bash", toolCallId: "x" }, ctx);
		await fireToolResult(ctx, "unknown-id");
		expect(statuses).toEqual([]);
	});

	test("parallel delegations both render; clearing one keeps the other", async () => {
		const { ctx, statuses } = makeCtx();
		await fireToolCall(ctx, "c1");
		await fireToolCall(ctx, "c2");
		await fireToolResult(ctx, "c1");
		const last = statuses[statuses.length - 1][1];
		expect(last).toContain("delegate architect");
		expect(last).not.toContain("c1");
	});

	test("without a UI nothing renders or aborts-noise is emitted, but abort still fires", async () => {
		const { ctx, statuses, aborts } = makeCtx();
		(ctx as { hasUI: boolean }).hasUI = false;
		await fireToolCall(ctx);
		await harness.fire({ text: "f!: stop", streamingBehavior: "followUp" }, ctx as never);
		expect(statuses).toEqual([]);
		expect(aborts.count).toBe(1);
	});
});
