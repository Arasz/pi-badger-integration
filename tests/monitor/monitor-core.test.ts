/**
 * Unit tests for the monitor pure core (plan v2 rows M-A1–M-A4, rulings R6/R7/R9).
 *
 * Everything here is hermetic by construction: the module under test imports nothing but
 * node:vm, spawns nothing, and never reads the wall clock — `now` is a parameter everywhere.
 * The single sanctioned real-cost row is the bun vm-timeout gate test (M-A2, ~250 ms, with an
 * explicit per-test timeout); no other row sleeps or waits.
 */

import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	type DelegationView,
	MONITOR_EVENT_CAP_CHARS,
	MONITOR_TIMEOUT_DEFAULT_MS,
	MONITOR_TIMEOUT_MAX_MS,
	PREDICATE_MAX_CHARS,
	PREDICATE_TIMEOUT_MS,
	clampMonitorCap,
	clampMonitorTimeoutMs,
	compilePredicate,
	composeMonitorEvent,
	evaluateMonitor,
	evaluatePredicate,
	normalizePredicate,
	type MonitorRecord,
	type MonitorSnapshot,
	type MonitorState,
	pollingDecision,
	type PollGuardConfig,
} from "../../extensions/monitor/monitor-core.ts";

/** Fixed epoch so nothing in this suite touches the clock. */
const NOW = 1_700_000_000_000;

/** A failed delegation view, the shape the wiring snapshots on a transition. */
function failedDelegation(id = "r1"): DelegationView {
	return { id, agent: "architect", state: "failed", exitCode: 1 };
}

/** A snapshot with the given parts, exactly the shape predicates evaluate against (R6). */
function snapshot(delegations: DelegationView[] = [], monitors: Array<{ name: string }> = []): MonitorSnapshot {
	return { delegations, monitors };
}

// ------------------------------------------------------------------ M-A1/M-A2/M-A3 predicate evaluation

describe("monitor predicate evaluation", () => {
	test("a predicate expression evaluates against the snapshot and returns its value", () => {
		const outcome = evaluatePredicate("delegations.length > 0", snapshot([failedDelegation()]));
		expect(outcome).toEqual({ kind: "value", value: true });
		expect(evaluatePredicate("1 + 1", snapshot())).toEqual({ kind: "value", value: 2 });
		expect(evaluatePredicate('"x"', snapshot())).toEqual({ kind: "value", value: "x" });
	});

	test("delegations and monitors are visible to the predicate as plain data", () => {
		const snap = snapshot([failedDelegation("r9")], [{ name: "wake-me" }]);
		expect(evaluatePredicate(`delegations[0].id === "r9"`, snap)).toEqual({ kind: "value", value: true });
		expect(evaluatePredicate(`monitors.some((m) => m.name === "wake-me")`, snap)).toEqual({
			kind: "value",
			value: true,
		});
	});

	test("statement garbage fails compilation as a typed syntax error", () => {
		const compiled = compilePredicate("const x = 1; x > 0");
		expect(compiled.kind).toBe("syntax-error");
		if (compiled.kind === "syntax-error") expect(compiled.reason.length).toBeGreaterThan(0);
		expect(evaluatePredicate("if (delegations.length) true", snapshot()).kind).toBe("syntax-error");
	});

	test("the registration-time compile check compiles without evaluating", () => {
		// If this ran instead of merely compiling, the infinite loop would trip the vm timeout
		// and the compile check would surface an eval-error — it must report ok, instantly.
		expect(compilePredicate("(() => { while(true){} })()")).toEqual({ kind: "ok" });
	});

	test("a predicate over the 4 KB cap is rejected as a typed syntax error", () => {
		const atCap = `"${"a".repeat(PREDICATE_MAX_CHARS - 2)}"`;
		expect(compilePredicate(atCap)).toEqual({ kind: "ok" });
		const overCap = `"${"a".repeat(PREDICATE_MAX_CHARS - 1)}"`;
		const compiled = compilePredicate(overCap);
		expect(compiled.kind).toBe("syntax-error");
		if (compiled.kind === "syntax-error") {
			expect(compiled.reason).toContain("4096");
			expect(compiled.reason).toContain(String(overCap.length));
		}
	});

	test("bun honors the node:vm timeout — an infinite-loop script throws instead of hanging", () => {
		expect(() => runInNewContext("while(true){}", {}, { timeout: PREDICATE_TIMEOUT_MS })).toThrow();
	}, 5_000);

	test("a looping predicate returns a typed eval-error through the evaluator, never an exception escape", () => {
		const outcome = evaluatePredicate("(() => { while(true){} })()", snapshot());
		expect(outcome.kind).toBe("eval-error");
		if (outcome.kind === "eval-error") expect(outcome.reason).toMatch(/timed out/i);
	}, 5_000);

	test("a predicate returning a promise maps to a typed eval-error", () => {
		// Async IIFEs are expressions and return instantly — the 250 ms timeout cannot bound
		// them, so the promise-escape policy intercepts the thenable at the realm boundary.
		const asyncIife = evaluatePredicate("(async () => delegations.length > 0)()", snapshot([failedDelegation()]));
		expect(asyncIife.kind).toBe("eval-error");
		expect(evaluatePredicate("Promise.resolve(true)", snapshot()).kind).toBe("eval-error");
	});

	test("a thenable or non-primitive result maps to a typed eval-error", () => {
		// A vm-realm Promise is not an instanceof the host Promise — detection is structural.
		expect(evaluatePredicate("({ then: () => {} })", snapshot()).kind).toBe("eval-error");
		expect(evaluatePredicate("[1, 2]", snapshot()).kind).toBe("eval-error");
		expect(evaluatePredicate("({ a: 1 })", snapshot()).kind).toBe("eval-error");
		expect(evaluatePredicate("(() => 1)", snapshot()).kind).toBe("eval-error");
	});

	test("after a wedged predicate errors, a healthy evaluation still succeeds", () => {
		expect(evaluatePredicate("(() => { while(true){} })()", snapshot()).kind).toBe("eval-error");
		expect(evaluatePredicate("1 + 1", snapshot())).toEqual({ kind: "value", value: 2 });
	}, 5_000);

	test("falsy primitive values evaluate as values, ready for the edge logic", () => {
		expect(evaluatePredicate("0", snapshot())).toEqual({ kind: "value", value: 0 });
		expect(evaluatePredicate('""', snapshot())).toEqual({ kind: "value", value: "" });
		expect(evaluatePredicate("false", snapshot())).toEqual({ kind: "value", value: false });
		expect(evaluatePredicate("null", snapshot())).toEqual({ kind: "value", value: null });
		expect(evaluatePredicate("undefined", snapshot())).toEqual({ kind: "value", value: undefined });
	});
});

// ------------------------------------------------------------------ leading-return recovery

describe("leading-return recovery (the predicate is a bare expression, not a statement)", () => {
	test("a `return …` predicate — the old schema phrasing copied literally — now compiles", () => {
		expect(compilePredicate("return (delegations.length > 0)")).toEqual({ kind: "ok" });
		expect(compilePredicate("return delegations.length > 0")).toEqual({ kind: "ok" });
	});

	test("normalizePredicate strips one leading return and touches nothing else", () => {
		expect(normalizePredicate("return (delegations.length > 0)")).toBe("delegations.length > 0");
		expect(normalizePredicate('return delegations.some((d) => d.state === "completed")')).toBe(
			'delegations.some((d) => d.state === "completed")',
		);
		// No word boundary (returnx), no leading return, empty remainder, smuggle-shaped tail:
		// all pass through unchanged for compile to judge.
		expect(normalizePredicate("returnx > 0")).toBe("returnx > 0");
		expect(normalizePredicate("delegations.length > 0")).toBe("delegations.length > 0");
		expect(normalizePredicate("return")).toBe("return");
		expect(normalizePredicate("return;")).toBe("return;");
		expect(normalizePredicate("return 1) } //x")).toBe("return 1) } //x");
	});

	test("a leading-return predicate that still fails rejects with guidance naming the mistake", () => {
		const compiled = compilePredicate("return const x");
		expect(compiled.kind).toBe("syntax-error");
		if (compiled.kind === "syntax-error") {
			expect(compiled.reason).toMatch(/do not write `return`/);
			expect(compiled.reason).toContain("delegations.some");
		}
	});

	test("the evaluator self-heals a stored `return …` predicate", () => {
		const snap = snapshot([failedDelegation()]);
		expect(evaluatePredicate("return (delegations.length > 0)", snap)).toEqual({ kind: "value", value: true });
		expect(evaluatePredicate("return false", snap)).toEqual({ kind: "value", value: false });
	});
});

// ------------------------------------------------------------------ one-shot edge logic (R7)

describe("one-shot monitor edge logic", () => {
	const armed = (predicate: string): MonitorState => ({ name: "wake", predicate, armed: true });

	test("an armed monitor fires exactly once on the first truthy evaluation and then disarms", () => {
		const fired = evaluateMonitor(armed("delegations.length > 0"), snapshot([failedDelegation()]));
		expect(fired.action).toBe("fire");
		expect(fired.state.armed).toBe(false);
		// The registration evaluation is the first evaluation — an immediately-true condition
		// fires on it, there is no "wait for the next transition" grace.
		const immediate = evaluateMonitor(armed("true"), snapshot());
		expect(immediate.action).toBe("fire");
		// Disarmed: a second truthy evaluation must not fire again.
		expect(evaluateMonitor(fired.state, snapshot([failedDelegation()])).action).toBe("disarmed");
	});

	test("an armed monitor stays idle and armed on falsy evaluations", () => {
		for (const falsy of ["0", '""', "false", "null", "undefined", "NaN"]) {
			const outcome = evaluateMonitor(armed(falsy), snapshot());
			expect(outcome.action).toBe("idle");
			expect(outcome.state.armed).toBe(true);
		}
		// Truthiness is plain JS Boolean() on the primitive value: a non-empty string fires.
		expect(evaluateMonitor(armed('"later"'), snapshot()).action).toBe("fire");
	});

	test("a monitor whose predicate errors disarms and reports the typed error", () => {
		const outcome = evaluateMonitor(armed("const x = 1"), snapshot());
		expect(outcome.action).toBe("error");
		if (outcome.action === "error") {
			expect(outcome.errorKind).toBe("syntax-error");
			expect(outcome.reason.length).toBeGreaterThan(0);
			expect(outcome.state.armed).toBe(false);
		}
		// Disarmed after the error: later transitions evaluate nothing and never re-error.
		expect(evaluateMonitor(outcome.state, snapshot()).action).toBe("disarmed");
		const thrown = evaluateMonitor(armed("delegations.missing.deb()"), snapshot());
		expect(thrown.action).toBe("error");
		if (thrown.action === "error") expect(thrown.errorKind).toBe("eval-error");
	});

	test("a disarmed monitor is a no-op even against a truthy snapshot", () => {
		const spent: MonitorState = { name: "wake", predicate: "true", armed: false };
		expect(evaluateMonitor(spent, snapshot([failedDelegation()]))).toEqual({
			action: "disarmed",
			state: spent,
		});
	});
});

// ------------------------------------------------------- monitor-event composition + clamps (R6/R7)

describe("monitor-event content composition", () => {
	/** A registered monitor record: 10-minute lifetime armed at the fixed epoch. */
	function record(name = "wake"): MonitorRecord {
		return { name, predicate: "delegations.some((d) => d.state === 'failed')", registeredAt: NOW, expiresAt: NOW + 600_000 };
	}

	test("a fired event names the monitor and carries a snapshot digest within the 8 KB budget", () => {
		const snap = snapshot([failedDelegation("r7")]);
		const event = composeMonitorEvent("fired", record(), { snapshot: snap });
		expect(event.content).toContain('Monitor "wake" fired');
		expect(event.content).toContain("r7");
		expect(event.content.length).toBeLessThanOrEqual(MONITOR_EVENT_CAP_CHARS);
		expect(event.details).toEqual({ kind: "fired", monitor: "wake", snapshot: snap });
	});

	test("an oversized snapshot digest is tail-capped so the whole content stays within 8 KB", () => {
		const big: DelegationView = { id: "x".repeat(20_000), agent: "a", state: "failed", exitCode: 1 };
		const event = composeMonitorEvent("fired", record(), { snapshot: snapshot([big]) });
		expect(event.content.length).toBeLessThanOrEqual(MONITOR_EVENT_CAP_CHARS);
		expect(event.content).toContain("earlier characters dropped");
		expect(event.content.endsWith("}")).toBe(true); // the tail (the answer) survives
	});

	test("an expired event names the monitor and its lifetime", () => {
		const event = composeMonitorEvent("expired", record(), { now: NOW + 600_000 });
		expect(event.content).toContain('Monitor "wake" expired');
		expect(event.content).toContain("10m");
		expect(event.details).toEqual({ kind: "expired", monitor: "wake", lifetimeMs: 600_000 });
	});

	test("an error event names the monitor and the typed reason", () => {
		const reason = "predicate returned a non-primitive (object, array, function or thenable/promise)";
		const event = composeMonitorEvent("error", record(), { reason });
		expect(event.content).toContain('Monitor "wake" error');
		expect(event.content).toContain(reason);
		expect(event.details).toEqual({ kind: "error", monitor: "wake", reason });
		const huge = composeMonitorEvent("error", record(), { reason: "y".repeat(20_000) });
		expect(huge.content.length).toBeLessThanOrEqual(MONITOR_EVENT_CAP_CHARS);
		expect(huge.content).toContain("earlier characters dropped");
	});

	test("content stays within 8 KB even for a pathological monitor name", () => {
		const event = composeMonitorEvent("fired", record("z".repeat(20_000)), { snapshot: snapshot() });
		expect(event.content.length).toBeLessThanOrEqual(MONITOR_EVENT_CAP_CHARS);
	});
});

describe("monitor clamps", () => {
	test("clampMonitorTimeoutMs applies the 10-minute default, the 60-minute max and the below-min default", () => {
		expect(clampMonitorTimeoutMs(undefined)).toBe(MONITOR_TIMEOUT_DEFAULT_MS);
		expect(clampMonitorTimeoutMs(Number.NaN)).toBe(MONITOR_TIMEOUT_DEFAULT_MS);
		expect(clampMonitorTimeoutMs(500)).toBe(MONITOR_TIMEOUT_DEFAULT_MS); // below the 1 s floor → default
		expect(clampMonitorTimeoutMs(65_000)).toBe(65_000);
		expect(clampMonitorTimeoutMs(MONITOR_TIMEOUT_DEFAULT_MS)).toBe(MONITOR_TIMEOUT_DEFAULT_MS);
		expect(clampMonitorTimeoutMs(MONITOR_TIMEOUT_MAX_MS)).toBe(MONITOR_TIMEOUT_MAX_MS);
		expect(clampMonitorTimeoutMs(MONITOR_TIMEOUT_MAX_MS + 1)).toBe(MONITOR_TIMEOUT_MAX_MS);
	});

	test("clampMonitorCap applies the default 8 and the floor of 1", () => {
		expect(clampMonitorCap(undefined)).toBe(8);
		expect(clampMonitorCap(Number.NaN)).toBe(8);
		expect(clampMonitorCap(0)).toBe(1);
		expect(clampMonitorCap(-3)).toBe(1);
		expect(clampMonitorCap(1)).toBe(1);
		expect(clampMonitorCap(5)).toBe(5);
	});
});

// ------------------------------------------------------------------ poll-guard decision (R9)

describe("poll-guard decision", () => {
	const cfg = (over: Partial<PollGuardConfig> = {}): PollGuardConfig => ({
		windowMs: 120_000,
		max: 3,
		enabled: true,
		...over,
	});

	test("the first three calls in the window are allowed and the 4th is blocked", () => {
		const timestamps: number[] = [];
		for (let call = 1; call <= 3; call++) {
			expect(pollingDecision(timestamps, NOW, cfg())).toEqual({ action: "allow" });
			timestamps.push(NOW - (4 - call) * 1000); // caller appends every counted call, allowed or not
		}
		const blocked = pollingDecision(timestamps, NOW, cfg());
		expect(blocked.action).toBe("block");
	});

	test("a block names the attempted count, the window and the wait/monitor/end-turn alternatives", () => {
		const blocked = pollingDecision([NOW - 1000, NOW - 2000, NOW - 3000], NOW, cfg());
		if (blocked.action !== "block") throw new Error("expected block");
		expect(blocked.reason).toContain("4"); // this would be the 4th counted call
		expect(blocked.reason).toContain("120"); // the window
		expect(blocked.reason).toContain("wait");
		expect(blocked.reason).toContain("monitor");
		expect(blocked.reason).toContain("end turn");
	});

	test("blocked attempts count toward the window", () => {
		const timestamps = [NOW - 1000, NOW - 2000, NOW - 3000];
		expect(pollingDecision(timestamps, NOW, cfg()).action).toBe("block");
		// The caller appends the blocked attempt too — the next call is the 5th, still blocked.
		timestamps.push(NOW);
		const again = pollingDecision(timestamps, NOW, cfg());
		expect(again.action).toBe("block");
		if (again.action === "block") expect(again.reason).toContain("5");
	});

	test("calls that slid out of the window stop counting", () => {
		expect(pollingDecision([NOW - 121_000, NOW - 500_000, NOW - 900_000], NOW, cfg())).toEqual({
			action: "allow",
		});
		// Two fresh + one slid-out call is the 3rd — still allowed.
		expect(pollingDecision([NOW - 121_000, NOW - 1000, NOW - 2000], NOW, cfg())).toEqual({
			action: "allow",
		});
	});

	test("a call exactly at the window edge has slid out", () => {
		expect(pollingDecision([NOW - 120_000], NOW, cfg())).toEqual({ action: "allow" });
	});

	test("enabled false always allows — the env 0 = off ruling", () => {
		const timestamps = [NOW - 1000, NOW - 1001, NOW - 1002, NOW - 1003, NOW - 1004];
		expect(pollingDecision(timestamps, NOW, cfg({ enabled: false }))).toEqual({ action: "allow" });
	});
});

describe("review folds — N1 smuggle gate and S2-safe compile", () => {
	test("a predicate that smuggles statements through the wrap is rejected at compile (N1)", () => {
		// "1) } //x" closes the function body and comments the tail: gate 1 (the wrap compiles)
		// accepts it, so the bare-expression gate must reject it
		const result = compilePredicate("1) } //x");
		expect(result.kind).toBe("syntax-error");
	});
});
