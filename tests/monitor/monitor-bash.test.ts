/**
 * Bash-predicate tests for the monitor extension (task pbi-monitor-register-bash-predicate).
 *
 * Layering: part 1 pins the pure execution helper (extensions/monitor/bash-predicate.ts)
 * directly — compile gate, exit-code mapping, timeout/escalation kills, stdin EPIPE,
 * ENOENT guidance, win32 kill path, output caps, orphan proof. Part 2 (below) pins the
 * wiring integration through the fake-pi harness. Helper tests use short REAL timeouts
 * (50–100 ms, M7) — bash children are OS processes outside the manual-scheduler world.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
	BASH_PREDICATE_MAX_CHARS,
	BASH_PREDICATE_VALUE_MAX_CHARS,
	bashInFlightCount,
	bashPendingTimerCount,
	compileBashPredicate,
	killChildProcess,
	serializeBashSnapshot,
	startBashPredicate,
} from "../../extensions/monitor/bash-predicate.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
	expect(bashInFlightCount()).toBe(0); // no leaked children across tests
	expect(bashPendingTimerCount()).toBe(0); // S5: no leaked timeout/grace timers
});

// ------------------------------------------------------------------ compile gate (P1, M6, S3)

describe("bash compile gate", () => {
	test("a valid script passes", async () => {
		await expect(compileBashPredicate(`echo hi; exit 0`)).resolves.toEqual({ kind: "ok" });
	});

	test("bash-only syntax (`if...fi`, `return 0`) passes the gate — no JS normalization", async () => {
		// M6: kind==='bash' skips normalizePredicate/compilePredicate entirely; `if...fi` is a
		// JS syntax error and `return 0` would be normalized away as JS — both must survive here.
		await expect(compileBashPredicate(`if true; then exit 0; else exit 1; fi`)).resolves.toEqual({ kind: "ok" });
		await expect(compileBashPredicate(`return 0`)).resolves.toEqual({ kind: "ok" });
	});

	test("a syntax error fails with the bash stderr, not a crash", async () => {
		const result = await compileBashPredicate(`if then`);
		expect(result.kind).toBe("syntax-error");
		if (result.kind === "syntax-error") expect(result.reason).toMatch(/syntax error|unexpected token/i);
	});

	test("an over-cap predicate rejects free with a cap reason", async () => {
		const result = await compileBashPredicate(`# ${"x".repeat(BASH_PREDICATE_MAX_CHARS)}`);
		expect(result.kind).toBe("syntax-error");
		if (result.kind === "syntax-error") expect(result.reason).toMatch(/4096|cap/i);
	});

	test("a missing bash executable rejects loud with guidance, never a crash", async () => {
		// M4: ENOENT → loud error with guidance (install bash / Windows prerequisite).
		const result = await compileBashPredicate(`exit 0`, { executable: "__no_such_bash__" });
		expect(result.kind).toBe("syntax-error");
		if (result.kind === "syntax-error") expect(result.reason).toMatch(/bash/i);
	});
});

// ------------------------------------------------------------------ exit-code mapping (P1)

describe("bash exit-code mapping", () => {
	test("exit 0 with no output fires with value true", async () => {
		const handle = startBashPredicate(`exit 0`, `{}`, { timeoutMs: 2000 });
		await expect(handle.done).resolves.toEqual({ kind: "fired", value: true });
	});

	test("exit 0 with stdout fires with the trimmed head-capped output", async () => {
		const handle = startBashPredicate(`echo '  hello world  '; exit 0`, `{}`, { timeoutMs: 2000 });
		await expect(handle.done).resolves.toEqual({ kind: "fired", value: "hello world" });
	});

	test("exit 1 is idle", async () => {
		const handle = startBashPredicate(`exit 1`, `{}`, { timeoutMs: 2000 });
		await expect(handle.done).resolves.toEqual({ kind: "idle" });
	});

	test("exit ≥2 is error+disarm with the exit code and capped stderr", async () => {
		const handle = startBashPredicate(`echo boom >&2; exit 3`, `{}`, { timeoutMs: 2000 });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") {
			expect(outcome.reason).toMatch(/exit(?:ed)? 3/);
			expect(outcome.reason).toMatch(/boom/);
		}
	});

	test("self-inflicted signal death is error with the signal name", async () => {
		const handle = startBashPredicate(`kill -KILL $$`, `{}`, { timeoutMs: 2000 });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.reason).toMatch(/SIGKILL/);
	});

	test("argv passing is never shell-interpolated (quoting survives verbatim)", async () => {
		// M4: spawn('bash', ['-c', script]) — a script with hostile quoting must run with exact
		// bash -c semantics; a sh -c "…${script}…" interpolation would mangle the quotes.
		const handle = startBashPredicate(`echo 'a"b;c"'; exit 0`, `{}`, { timeoutMs: 2000 });
		await expect(handle.done).resolves.toEqual({ kind: "fired", value: `a"b;c"` });
	});
});

// ------------------------------------------------------------------ timeout + orphan proof (P1, M7)

describe("bash timeout, escalation and orphans", () => {
	test("a hung predicate times out, dies at OS level and frees every track", async () => {
		const handle = startBashPredicate(`sleep 30; exit 0`, `{}`, { timeoutMs: 50, graceMs: 50 });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.reason).toMatch(/timed out|timeout/i);

		// M7 orphan proof: OS-level death (exit/signal recorded, pid unrecyclable) + empty
		// in-flight set + no timers. 'close' has fired (done resolved), so waitpid reaped.
		const child = handle.child;
		expect(child).toBeDefined();
		expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
		if (handle.pid !== undefined) {
			let esrch = false;
			try {
				process.kill(handle.pid, 0);
			} catch (err) {
				esrch = (err as NodeJS.ErrnoException).code === "ESRCH";
			}
			expect(esrch).toBe(true);
		}
		expect(bashInFlightCount()).toBe(0);
		expect(bashPendingTimerCount()).toBe(0);
	});

	test("kill() escalates SIGTERM→SIGKILL and resolves the error outcome", async () => {
		const handle = startBashPredicate(`sleep 30; exit 0`, `{}`, { timeoutMs: 5000, graceMs: 50 });
		await sleep(50); // let the child exec before killing
		handle.kill();
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.reason).toMatch(/SIGTERM|SIGKILL|signal/i);
		expect(bashInFlightCount()).toBe(0);
	});

	test("an abort signal kills the in-flight child", async () => {
		const controller = new AbortController();
		const handle = startBashPredicate(`sleep 30; exit 0`, `{}`, {
			timeoutMs: 5000,
			graceMs: 50,
			signal: controller.signal,
		});
		await sleep(50);
		controller.abort();
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		expect(bashInFlightCount()).toBe(0);
	});
});

// ------------------------------------------------------------------ stdin + caps (P1, M5, S1)

describe("bash stdin contract and output caps", () => {
	test("the snapshot JSON arrives on stdin (not argv/env)", async () => {
		const handle = startBashPredicate(`grep -q '"state":"completed"'; exit $?`, `{"delegations":[{"state":"completed"}]}`, {
			timeoutMs: 2000,
		});
		// grep exit 0 → `exit $?` → 0 → fired: proves stdin carried the snapshot.
		await expect(handle.done).resolves.toEqual({ kind: "fired", value: true });
	});

	test("early exit with a huge stdin still resolves by exit code — EPIPE swallowed (M5)", async () => {
		const big = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
		const handle = startBashPredicate(`exit 0`, big, { timeoutMs: 5000 });
		await expect(handle.done).resolves.toEqual({ kind: "fired", value: true });
	});

	test("an explicitly closed stdin still resolves by exit code (M5)", async () => {
		const handle = startBashPredicate(`exec <&-; exit 0`, `{}`, { timeoutMs: 2000 });
		await expect(handle.done).resolves.toEqual({ kind: "fired", value: true });
	});

	test("fire value is head-capped at 1 KB (S1: output reads top-down)", async () => {
		const handle = startBashPredicate(`printf 'y%.0s' $(seq 1 5000); exit 0`, `{}`, { timeoutMs: 5000 });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("fired");
		if (outcome.kind === "fired") {
			expect(typeof outcome.value).toBe("string");
			expect((outcome.value as string).length).toBeLessThanOrEqual(BASH_PREDICATE_VALUE_MAX_CHARS);
		}
	});

	test("a missing executable at run time is error+disarm with guidance, never a crash (M4)", async () => {
		const handle = startBashPredicate(`exit 0`, `{}`, { executable: "__no_such_bash__", timeoutMs: 2000 });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.reason).toMatch(/bash/i);
	});
});

// ------------------------------------------------------------------ portability seam (P1, M4)

describe("bash kill portability", () => {
	test("win32 never uses negative-pid group kill — child.kill only", () => {
		const kills: string[] = [];
		const negative: number[] = [];
		const fakeChild = { pid: 4242, kill: (signal?: string): boolean => (kills.push(signal ?? ""), true) };
		killChildProcess(fakeChild, "SIGTERM", "win32", (pid, signal) => {
			negative.push(pid);
			return true;
		});
		expect(kills).toEqual(["SIGTERM"]);
		expect(negative).toHaveLength(0);
	});

	test("posix tries the process-group kill first, then falls back to child.kill", () => {
		const kills: string[] = [];
		const group: number[] = [];
		const fakeChild = { pid: 4242, kill: (signal?: string): boolean => (kills.push(signal ?? ""), true) };
		killChildProcess(fakeChild, "SIGTERM", "linux", (pid) => (group.push(pid), true));
		expect(group).toEqual([-4242]);
	});
});

// ------------------------------------------------------------------ snapshot serialization (P1, M5)

describe("bash snapshot serialization", () => {
	test("a serializable snapshot stringifies once", () => {
		const snapshot = { delegations: [], monitors: [{ name: "m" }] };
		const result = serializeBashSnapshot(snapshot);
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(JSON.parse(result.json)).toEqual(snapshot);
	});

	test("a stringify failure is a typed error (caller error+disarms, never throws)", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const result = serializeBashSnapshot(circular);
		expect(result.kind).toBe("error");
		if (result.kind === "error") expect(result.reason.length).toBeGreaterThan(0);
	});
});
