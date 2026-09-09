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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import monitor from "../../extensions/monitor/index.ts";
import { TRANSITION_CHANNEL } from "../../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

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

	test("exactly-at-cap input passes the gate (cap is >, not >=)", async () => {
		// Minor-6: `# ` is 2 chars, so MAX-2 filler lands exactly on BASH_PREDICATE_MAX_CHARS.
		await expect(compileBashPredicate(`# ${"x".repeat(BASH_PREDICATE_MAX_CHARS - 2)}`)).resolves.toEqual({
			kind: "ok",
		});
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

	test("timeout kill reaps the whole process group — no orphaned grandchildren (major-3)", async () => {
		// The sleep GRANDCHILD shares bash's group: own-pid ESRCH alone cannot prove it died
		// (a child.kill-only fallback kills bash while sleep leaks reparented). Track the
		// grandchild via a pid file and assert IT is unrecyclable after the kill.
		//
		// Flake autopsy (CI 2026-09-09, 52 ms duration): the old shape raced a 50 ms
		// timeout against bash's fork of `sleep` — under load SIGTERM won before
		// `echo $! > pidfile` ran, so the pid file never existed. The kill under
		// test is now driven explicitly AFTER the grandchild provably exists: poll
		// for the pid file (generous deadline), then handle.kill(). The timeout leg
		// keeps a budget it can never hit first. Group-kill intent unchanged — a
		// child.kill-only fallback would still leak the reparented sleeper.
		if (process.platform === "win32") return; // POSIX process groups only
		const dir = mkdtempSync(join(tmpdir(), "monitor-orphan-"));
		const pidFile = join(dir, "sleeper.pid");
		try {
			const handle = startBashPredicate(`sleep 30 & echo $! > '${pidFile}'; wait`, `{}`, {
				timeoutMs: 15000,
				graceMs: 50,
			});
			// Prove the grandchild is born before killing: without this, the kill
			// races the fork and the test asserts on a never-existing pid.
			const deadline = Date.now() + 10000;
			for (;;) {
				try {
					const probe = Number(readFileSync(pidFile, "utf8").trim());
					if (Number.isInteger(probe) && probe > 0) break;
				} catch {
					// not written yet — keep polling
				}
				if (Date.now() > deadline) throw new Error("timed out waiting for the sleeper pid file");
				await sleep(10);
			}
			handle.kill();
			const outcome = await handle.done;
			expect(outcome.kind).toBe("error");
			const sleeperPid = Number(readFileSync(pidFile, "utf8").trim());
			expect(Number.isInteger(sleeperPid) && sleeperPid > 0).toBe(true);
			let esrch = false;
			try {
				process.kill(sleeperPid, 0);
			} catch (err) {
				esrch = (err as NodeJS.ErrnoException).code === "ESRCH";
			}
			expect(esrch).toBe(true); // grandchild reaped by the group kill
		} finally {
			rmSync(dir, { recursive: true, force: true });
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

	test("a TERM-ignoring child is escalated to SIGKILL (grace leg executes)", async () => {
		// Blocker-1: `sleep 30` dies on SIGTERM, so the plain kill test above never exercises
		// the grace timer. `trap '' TERM` is inherited across exec — the whole group ignores
		// TERM — so only the SIGKILL escalation can reap it. Deleting the grace leg turns this
		// into a timeout error instead of SIGKILL.
		const handle = startBashPredicate(`trap '' TERM; sleep 30; exit 0`, `{}`, {
			timeoutMs: 5000,
			graceMs: 50,
		});
		await sleep(50); // let the child exec (and install the trap) before killing
		handle.kill();
		const outcome = await handle.done;
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.reason).toMatch(/SIGKILL/);
		const child = handle.child;
		expect(child).toBeDefined();
		expect(child!.signalCode).toBe("SIGKILL");
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

	test("a throwing group kill falls back to child.kill (minor-7)", () => {
		const kills: string[] = [];
		const fakeChild = { pid: 4242, kill: (signal?: string): boolean => (kills.push(signal ?? ""), true) };
		killChildProcess(
			fakeChild,
			"SIGTERM",
			"linux",
			() => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
		);
		expect(kills).toEqual(["SIGTERM"]);
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

// ------------------------------------------------------------------ part 2: wiring integration
// Harness mirrors tests/monitor/monitor-extension.test.ts (manualScheduler, FakeClock via
// pi.clock, hermetic fake-pi); bash legs use short REAL pauses — children are OS processes.

function manualScheduler() {
	let seq = 0;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		setTimeout: (fn: () => void, ms: number) => {
			const handle = ++seq;
			timers.set(handle, { fn, ms });
			return handle;
		},
		clearTimeout: (handle: unknown) => {
			timers.delete(handle as number);
		},
		timers,
		fire(handle: number) {
			const timer = timers.get(handle);
			if (!timer) throw new Error(`no timer ${handle} armed`);
			timers.delete(handle);
			timer.fn();
		},
	};
}

type Scheduler = ReturnType<typeof manualScheduler>;

function transition(id: string, state: string) {
	const at = 1_700_000_000_000;
	return {
		id,
		agent: "architect",
		task: "do the thing",
		state,
		at,
		record: { id, agent: "architect", task: "do the thing", toolCallId: `tc-${id}`, state, startedAt: at },
	};
}

interface Harness {
	pi: FakePi;
	scheduler: Scheduler;
}

const bashNotifications: Array<{ message: string; type?: string }> = [];

function makeBashHarness(deps: Record<string, unknown> = {}): Harness {
	bashNotifications.length = 0;
	const pi = createFakePi();
	const scheduler = manualScheduler();
	monitor(pi as never, { now: () => pi.clock.now, scheduler, ...deps });
	return { pi, scheduler };
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}
type Execute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<ToolResult>;

function monitorTool(pi: FakePi): Execute {
	const tool = pi.tools.get("monitor");
	if (!tool) throw new Error("the monitor extension did not register a `monitor` tool");
	return tool.execute as unknown as Execute;
}

function waitTool(pi: FakePi): Execute {
	const tool = pi.tools.get("wait");
	if (!tool) throw new Error("the monitor extension did not register a `wait` tool");
	return tool.execute as unknown as Execute;
}

function makeCtx(mode = "tui"): unknown {
	return {
		ui: { notify: (message: string, type?: string) => bashNotifications.push({ message, type }), setWidget: () => {}, setStatus: () => {} },
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/p",
	};
}

async function bashRegister(
	pi: FakePi,
	params: { predicate: string; predicateKind?: string; name?: string; timeoutMs?: number },
	opts: { mode?: string; signal?: AbortSignal } = {},
): Promise<ToolResult> {
	return monitorTool(pi)("tc-register", { action: "register", ...params }, opts.signal, undefined, makeCtx(opts.mode ?? "tui"));
}

function sentMonitorEvents(pi: FakePi): Array<{ message: Record<string, unknown>; options: unknown }> {
	return pi.sent
		.filter((s) => s.message.customType === "monitor-event")
		.map((s) => ({ message: s.message as Record<string, unknown>, options: s.options }));
}

function shutdown(pi: FakePi): void {
	for (const handler of pi.handlers.get("session_shutdown") ?? []) handler({}, makeCtx());
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Slow-in-drain, fast-at-registration bash predicate: instant idle while no delegation has
// completed, a 30 s sleeper once one has — lets tests park a child in-flight, then kill it.
const PARKED_PREDICATE = `snapshot=$(cat); case "$snapshot" in *completed*) sleep 30;; *) exit 1;; esac`;

// ------------------------------------------------------------------ M6: gate split

describe("M6: bash skips the JS gates entirely", () => {
	test("`if...fi` registers verbatim and fires", async () => {
		const { pi } = makeBashHarness();
		const predicate = `if true; then exit 0; else exit 1; fi`;
		const receipt = await bashRegister(pi, { predicate, predicateKind: "bash", name: "branchy" });
		expect(receipt.details.state).toBe("fired");
		expect(receipt.details.predicate).toBe(predicate); // verbatim — no JS normalization
		expect(receipt.details.predicateKind).toBe("bash");
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.message.details).toMatchObject({ kind: "fired", predicateKind: "bash", predicate });
	});

	test("`return 0` survives registration verbatim (no JS return-strip)", async () => {
		// Portability note: `return` outside a function has no portable runtime exit status
		// (bash 3.2 exits 1, bash 5 exits >=2), so this test asserts REGISTRATION-time facts
		// only — resolves (not rejected) with the predicate echoed verbatim. The runtime
		// exit-1→idle mapping is pinned separately with the stable `exit 1` probe above.
		const { pi } = makeBashHarness();
		const receipt = await bashRegister(pi, { predicate: "return 0", predicateKind: "bash" });
		expect(receipt.details.predicate).toBe("return 0"); // verbatim — a JS gate would have stripped it to `0`
	});

	test("an unknown predicateKind rejects loudly", async () => {
		const { pi } = makeBashHarness();
		await expect(bashRegister(pi, { predicate: "exit 0", predicateKind: "zsh" })).rejects.toThrow(/predicateKind/);
	});

	test("an unknown predicateKind rejects before the cap check, even at full cap (minor-5)", async () => {
		const { pi } = makeBashHarness();
		for (let i = 1; i <= 8; i++) await bashRegister(pi, { predicate: "false", name: `wake-${i}` });
		await expect(bashRegister(pi, { predicate: "exit 0", predicateKind: "zsh" })).rejects.toThrow(/predicateKind/);
		await expect(bashRegister(pi, { predicate: "exit 0", predicateKind: "zsh" })).rejects.not.toThrow(/cap/);
	});
});

// ------------------------------------------------------------------ M3: register async

describe("M3: async register — gate order, self-visibility, abort", () => {
	test("the bash -n gate runs BEFORE the monitor-cap check (rejects free)", async () => {
		const { pi } = makeBashHarness();
		for (let i = 1; i <= 8; i++) await bashRegister(pi, { predicate: "false", name: `wake-${i}` });
		await expect(bashRegister(pi, { predicate: "if then", predicateKind: "bash" })).rejects.toThrow(/invalid bash predicate/);
		await expect(bashRegister(pi, { predicate: "if then", predicateKind: "bash" })).rejects.not.toThrow(/cap/);
		// …while a VALID bash register still hits the full cap:
		await expect(bashRegister(pi, { predicate: "exit 1", predicateKind: "bash" })).rejects.toThrow(/8 active monitors/);
	});

	test("immediate eval runs after armed.set — self is visible in snapshot.monitors", async () => {
		const { pi } = makeBashHarness();
		await bashRegister(pi, { predicate: "exit 0", predicateKind: "bash", name: "self-seer" });
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1);
		const snapshot = (cards[0]!.message.details as Record<string, unknown>).snapshot as { monitors: Array<{ name: string }> };
		expect(snapshot.monitors.map((m) => m.name)).toContain("self-seer");
	});

	test("an abort signal kills the immediate child — error receipt, one error card, nothing in flight", async () => {
		const { pi } = makeBashHarness();
		const controller = new AbortController();
		const pending = bashRegister(pi, { predicate: "sleep 30; exit 0", predicateKind: "bash" }, { signal: controller.signal });
		await pause(100);
		controller.abort();
		const receipt = await pending;
		expect(receipt.details.state).toBe("error");
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.message.details).toMatchObject({ kind: "error" });
		expect(bashInFlightCount()).toBe(0);
	});

	test("the tool description documents the stdin contract, the exit mapping, the 5 s block and the trust model (S2/S4)", () => {
		const { pi } = makeBashHarness();
		const tool = pi.tools.get("monitor") as unknown as { description: string; parameters: object };
		expect(tool.description).toMatch(/stdin/i);
		expect(tool.description).toMatch(/exit 0/i);
		expect(tool.description).toMatch(/5 ?s/);
		expect(tool.description).toMatch(/unsandboxed/i);
		const params = JSON.parse(JSON.stringify(tool.parameters)) as {
			properties: { predicateKind: { description: string }; predicate: { description: string } };
		};
		expect(params.properties.predicateKind.description).toMatch(/bash/);
		expect(params.properties.predicate.description).toMatch(/stdin/);
	});
});

// ------------------------------------------------------------------ M8: value plumbing + kind echo

describe("M8: bash value plumbing and predicateKind echo", () => {
	test("stdout becomes the fire value in details and on the card; empty stdout becomes true", async () => {
		const { pi } = makeBashHarness();
		const receipt = await bashRegister(pi, { predicate: "echo hello; exit 0", predicateKind: "bash", name: "v" });
		expect(receipt.details.state).toBe("fired");
		expect(receipt.details.value).toBe("hello");
		const cards = sentMonitorEvents(pi);
		expect(cards[0]!.message.content).toContain("hello");
		expect(cards[0]!.message.details).toMatchObject({ kind: "fired", value: "hello" });
		expect((cards[0]!.message.details as Record<string, unknown>).snapshot).toBeDefined();

		const second = makeBashHarness();
		const receipt2 = await bashRegister(second.pi, { predicate: "exit 0", predicateKind: "bash" });
		expect(receipt2.details.value).toBe(true);
	});

	test("long stdout is head-capped at 1 KB", async () => {
		const { pi } = makeBashHarness();
		const receipt = await bashRegister(pi, { predicate: "printf 'y%.0s' $(seq 1 5000); exit 0", predicateKind: "bash" });
		expect((receipt.details.value as string).length).toBeLessThanOrEqual(1024);
	});

	test("bash errors carry exit code + stderr on the card and the receipt", async () => {
		const { pi } = makeBashHarness();
		const receipt = await bashRegister(pi, { predicate: "echo kaboom >&2; exit 4", predicateKind: "bash" });
		expect(receipt.details.state).toBe("error");
		expect(String(receipt.details.reason)).toMatch(/kaboom/);
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1);
		expect(String(cards[0]!.message.content)).toMatch(/kaboom/);
		expect(String((cards[0]!.message.details as Record<string, unknown>).reason)).toMatch(/4/);
	});

	test("an errored monitor stays disarmed — a follow-up transition sends nothing (blocker-2)", async () => {
		// Fire-disarm is pinned elsewhere; error-disarm was not: without it an errored monitor
		// would re-drain (error-card spam per transition). One error card, then silence.
		const { pi } = makeBashHarness();
		const receipt = await bashRegister(pi, { predicate: "echo kaboom >&2; exit 4", predicateKind: "bash", name: "err" });
		expect(receipt.details.state).toBe("error");
		expect(sentMonitorEvents(pi)).toHaveLength(1); // the error card
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-9", "completed"));
		await pause(300); // a re-drain would settle a fast child by now
		expect(sentMonitorEvents(pi)).toHaveLength(1); // still just the error card
		expect(bashInFlightCount()).toBe(0);
	});

	test("receipt, list and /monitors echo predicateKind; JS defaults to 'js'", async () => {
		const { pi } = makeBashHarness();
		const jsReceipt = await bashRegister(pi, { predicate: "false", name: "js-one" });
		expect(jsReceipt.details.predicateKind).toBe("js");
		await bashRegister(pi, { predicate: "exit 1", predicateKind: "bash", name: "bash-one" });

		const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
		const monitors = (listed.details as { monitors: Array<{ id: string; predicateKind: string }> }).monitors;
		expect(monitors.find((m) => m.id === "m-1")!.predicateKind).toBe("js");
		expect(monitors.find((m) => m.id === "m-2")!.predicateKind).toBe("bash");
		expect(listed.content[0]!.text).toContain("[bash]");

		const command = pi.commands.get("monitors") as unknown as { handler(args: string, ctx: unknown): Promise<void> };
		await command.handler("", makeCtx());
		expect(bashNotifications).toHaveLength(1);
		expect(bashNotifications[0]!.message).toContain("[bash]");
		expect(bashNotifications[0]!.message).toContain("[js]");
	});
});

// ------------------------------------------------------------------ M2: JS fast path

describe("M2: JS cards send synchronously — never behind a bash await", () => {
	test("a JS fire and a slow bash share one drain: the JS card is already sent, the bash card follows", async () => {
		const { pi } = makeBashHarness();
		const jsPredicate = `delegations.some((d) => d.state === "completed")`;
		await bashRegister(pi, { predicate: jsPredicate, name: "js-fast" });
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		await bashRegister(pi, { predicate: "sleep 0.2; grep -q completed", predicateKind: "bash", name: "bash-slow" });

		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));

		// Same tick, no await: the JS card is already on the wire, the bash child still sleeping.
		const syncCards = sentMonitorEvents(pi);
		expect(syncCards).toHaveLength(1);
		expect(syncCards[0]!.message.details).toMatchObject({ kind: "fired", predicate: jsPredicate });

		await pause(600);
		const lateCards = sentMonitorEvents(pi);
		expect(lateCards).toHaveLength(2);
		expect(lateCards[1]!.message.details).toMatchObject({ kind: "fired", predicateKind: "bash" });
	});
});

// ------------------------------------------------------------------ M1: one-shot across the async seam

describe("M1: one-shot holds across the async seam", () => {
	test("two rapid transitions fire a bash monitor exactly once", async () => {
		const { pi } = makeBashHarness();
		await bashRegister(pi, { predicate: "grep -q completed", predicateKind: "bash", name: "once" });
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "completed"));
		await pause(400);
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.message.details).toMatchObject({ kind: "fired", monitorId: "m-1" });
		expect(bashInFlightCount()).toBe(0);
	});

	test("a completion resolving after shutdown sends nothing", async () => {
		const { pi, scheduler } = makeBashHarness();
		await bashRegister(pi, { predicate: PARKED_PREDICATE, predicateKind: "bash", name: "parked" });
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		await pause(100); // the instant-idle drain child settles first — deterministic below
		expect(sentMonitorEvents(pi)).toHaveLength(0);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
		expect(bashInFlightCount()).toBe(1); // the sleeper is parked in-flight, synchronously
		shutdown(pi);
		await pause(300);
		expect(sentMonitorEvents(pi)).toHaveLength(0); // suppressed — kill alone would still exit 0/143
		expect(bashInFlightCount()).toBe(0);
		expect(scheduler.timers.size).toBe(0);
		const entry = pi.entries.find((e) => e.customType === "monitor-shutdown");
		expect(entry).toBeDefined();
	});
});

// ------------------------------------------------------------------ M7/S5: expiry kills the in-flight child

describe("expiry and shutdown lifecycle for bash children", () => {
	test("expiry kills the parked child: one expired card, never a fire, nothing in flight", async () => {
		const { pi, scheduler } = makeBashHarness();
		await bashRegister(pi, { predicate: PARKED_PREDICATE, predicateKind: "bash", name: "parked", timeoutMs: 60_000 });
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
		expect(bashInFlightCount()).toBe(1);

		const [handle] = [...scheduler.timers.keys()];
		scheduler.fire(handle!); // manual expiry while the child sleeps
		await pause(300);

		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1); // the expired card only — the late completion is suppressed
		expect(cards[0]!.message.details).toMatchObject({ kind: "expired", monitorId: "m-1" });
		expect(bashInFlightCount()).toBe(0);
		expect(bashPendingTimerCount()).toBe(0);
		expect(scheduler.timers.size).toBe(0);
	});
});

// ------------------------------------------------------------------ review fixes (SHOULD-1/2/3, MUST-2)

describe("MUST-2: the wait-timer monitor is always JS — never a bash child", () => {
	test("an idle-fleet wait arms a [js] wait-timer (never a bash child)", async () => {
		const { pi, scheduler } = makeBashHarness();
		expect(bashInFlightCount()).toBe(0);
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
		await pause(50); // let the W-A7 microtask arm the timer monitor
		expect(bashInFlightCount()).toBe(0);
		const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
		expect(listed.content[0]!.text).toMatch(/wait-timer/);
		expect(listed.content[0]!.text).toContain("[js]");
		expect(listed.content[0]!.text).not.toContain("[bash]");
		expect(bashInFlightCount()).toBe(0);
		// Cleanup: fire the wait's own timeout (armed first); the timer monitor disarms silently.
		scheduler.fire([...scheduler.timers.keys()][0]!);
		const result = await pending;
		expect(result.details.observed).toBe("timeout");
		expect(bashInFlightCount()).toBe(0);
		expect(sentMonitorEvents(pi)).toHaveLength(0);
	});
});

describe("SHOULD-1: idle completion re-drains once against the fresh snapshot", () => {
	test("a firing transition landing mid-flight still fires with no further transitions", async () => {
		const { pi } = makeBashHarness();
		// Slow predicate: 0.3 s per evaluation, then grep the stdin snapshot for a completion.
		await bashRegister(pi, { predicate: "sleep 0.3; grep -q completed", predicateKind: "bash", name: "coalesce" });
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		expect(bashInFlightCount()).toBe(1); // first drain parked in-flight
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed")); // lands mid-flight — coalesced, not lost
		await pause(1200); // first idle (0.3 s) + re-drain fire (0.3 s) + overhead
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1); // eventual fire with NO further transitions
		expect(cards[0]!.message.details).toMatchObject({ kind: "fired", monitorId: "m-1" });
		expect(bashInFlightCount()).toBe(0);
		expect(bashPendingTimerCount()).toBe(0);
	});
});

describe("SHOULD-2: wiring timeout seams", () => {
	test("a 50 ms budget times out the immediate eval — error receipt + one timed-out card, nothing leaked", async () => {
		const { pi } = makeBashHarness({ bashTimeoutMs: 50, bashGraceMs: 50 });
		const receipt = await bashRegister(pi, { predicate: "sleep 30; exit 0", predicateKind: "bash" });
		expect(receipt.details.state).toBe("error");
		expect(String(receipt.details.reason)).toMatch(/timed out/);
		const cards = sentMonitorEvents(pi);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.message.details).toMatchObject({ kind: "error" });
		expect(String((cards[0]!.message.details as Record<string, unknown>).reason)).toMatch(/timed out/);
		expect(bashInFlightCount()).toBe(0);
		expect(bashPendingTimerCount()).toBe(0);
	});
});

describe("SHOULD-3: cancel during flight", () => {
	test("cancel mid-flight kills the parked child: cancel receipt, no cards after, nothing in flight", async () => {
		const { pi, scheduler } = makeBashHarness();
		await bashRegister(pi, { predicate: PARKED_PREDICATE, predicateKind: "bash", name: "parked", timeoutMs: 60_000 });
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
		expect(bashInFlightCount()).toBe(1); // the sleeper is parked in-flight, synchronously
		const receipt = await monitorTool(pi)(
			"tc-cancel",
			{ action: "cancel", id: "m-1" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(receipt.content[0]!.text).toMatch(/cancelled/);
		await pause(300); // let the SIGTERM→SIGKILL escalation and the suppressed completion land
		expect(sentMonitorEvents(pi)).toHaveLength(0); // cancel is silent — no fire, no error, no expiry
		expect(bashInFlightCount()).toBe(0);
		expect(bashPendingTimerCount()).toBe(0);
		expect(scheduler.timers.size).toBe(0);
	});
});
