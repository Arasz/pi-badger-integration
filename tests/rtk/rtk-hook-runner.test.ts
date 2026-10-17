/** rtk-hook-runner tests: real child-process fixtures for stdin, cwd/env, kill escalation and fail-open paths. */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	POSTHOOK_FAST_TIMEOUT_MS,
	POSTHOOK_TIMEOUT_MS,
	killAllForExit,
	liveCount,
	runHook,
	type SpawnFn,
	timeoutFor,
} from "../../extensions/rtk/rtk-hook-runner.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtk-hook-runner-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Polls `process.kill(target, 0)` until ESRCH; false if the target is still alive after ~2 s. */
async function gone(target: number): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(target, 0);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
		}
		await Bun.sleep(20);
	}
	return false;
}

let pidSeq = 0;

/**
 * A spawn wrapper recording the child pid and blocking until the fixture has written `$$ $!` to PIDFILE,
 * so every kill path runs against a live grandchild.
 */
function tracked() {
	const pidfile = join(dir, `pids-${++pidSeq}`);
	const leaders: number[] = [];
	const spawnFn: SpawnFn = (c, a, o) => {
		const child = spawn(c, a, o);
		if (child.pid) leaders.push(child.pid);
		const tick = new Int32Array(new SharedArrayBuffer(4));
		for (let i = 0; i < 500 && !(existsSync(pidfile) && readFileSync(pidfile, "utf8").includes("\n")); i++) Atomics.wait(tick, 0, 0, 10);
		return child;
	};
	const recorded = (): number[] => (existsSync(pidfile) ? readFileSync(pidfile, "utf8").trim().split(/\s+/).map(Number) : []);
	return { pidfile, leaders, spawnFn, recorded, env: { ...process.env, PIDFILE: pidfile } };
}

/** Asserts the child's process group and every pid the fixture recorded are dead. */
async function expectAllDead(t: ReturnType<typeof tracked>): Promise<void> {
	expect(t.leaders).toHaveLength(1);
	const pids = t.recorded();
	expect(pids).toHaveLength(2);
	for (const pid of pids) expect({ pid, dead: await gone(pid) }).toEqual({ pid, dead: true });
	expect({ group: t.leaders[0], dead: await gone(-t.leaders[0]) }).toEqual({ group: t.leaders[0], dead: true });
}

const SLEEPER = 'sleep 30 &\necho "$$ $!" > "$PIDFILE"\nwait';

const base = { cwd: dir, timeoutMs: 2000, signal: new AbortController().signal, args: [] as string[] };

describe("runHook: stdin and stdout", () => {
	test("payload arrives byte-for-byte, stdin is ended, killed is false", async () => {
		const payload = { text: "héllo\n\"quoted\" ✓", n: 1 };
		const r = await runHook(payload, { ...base, command: script("cat.sh", "cat") });
		expect(r.stdout).toBe(JSON.stringify(payload));
		expect(r.code).toBe(0);
		expect(r.killed).toBe(false);
	});

	test("large chunked stdout is joined intact", async () => {
		const payload = { body: "x".repeat(200_000) };
		const r = await runHook(payload, { ...base, command: script("cat.sh", "cat") });
		expect(r.stdout).toBe(JSON.stringify(payload));
		expect(r.killed).toBe(false);
	});
});

describe("runHook: cwd and env", () => {
	test("child runs in the given cwd", async () => {
		const r = await runHook({}, { ...base, command: script("pwd.sh", "pwd") });
		expect(r.stdout.trim()).toBe(dir);
	});

	test("child sees the given env", async () => {
		const r = await runHook({}, { ...base, env: { ...process.env, RTK_PROBE: "yes" }, command: script("env.sh", 'printf %s "$RTK_PROBE"') });
		expect(r.stdout).toBe("yes");
	});
});

describe("runHook: kill paths", () => {
	test("timeout kills the child and its grandchildren", async () => {
		const t = tracked();
		const r = await runHook({}, { ...base, ...t, timeoutMs: 150, command: script("sleep.sh", SLEEPER) });
		expect(r.killed).toBe(true);
		await expectAllDead(t);
	});

	test("a TERM-ignoring child and grandchild are SIGKILLed", async () => {
		const t = tracked();
		const r = await runHook({}, { ...base, ...t, timeoutMs: 150, graceMs: 200, command: script("stubborn.sh", `trap '' TERM\n${SLEEPER}`) });
		expect(r.killed).toBe(true);
		await expectAllDead(t);
	});

	test("abort kills the child and its grandchildren", async () => {
		const t = tracked();
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await runHook({}, { ...base, ...t, signal: ac.signal, timeoutMs: 10_000, command: script("sleep.sh", SLEEPER) });
		expect(r.killed).toBe(true);
		await expectAllDead(t);
	});

	test("an already-aborted signal kills immediately", async () => {
		const t = tracked();
		const ac = new AbortController();
		ac.abort();
		const r = await runHook({}, { ...base, ...t, signal: ac.signal, timeoutMs: 10_000, command: script("sleep.sh", SLEEPER) });
		expect(r.killed).toBe(true);
		await expectAllDead(t);
	});

	test("stdout past the 64 KiB floor cap kills the child; only the cap can end it", async () => {
		const r = await runHook({}, { ...base, timeoutMs: 60_000, command: script("flood.sh", "head -c 50000000 /dev/zero") });
		expect(r.killed).toBe(true);
		expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(64 * 1024);
		expect(Buffer.byteLength(r.stdout)).toBeLessThan(1024 * 1024);
	});

	test("a large payload raises the cap to twice its size", async () => {
		const payload = { body: "z".repeat(300_000) };
		const cap = 2 * Buffer.byteLength(JSON.stringify(payload));
		const r = await runHook(payload, { ...base, timeoutMs: 60_000, command: script("drain-flood.sh", "cat >/dev/null\nhead -c 50000000 /dev/zero") });
		expect(r.killed).toBe(true);
		expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(cap);
		expect(Buffer.byteLength(r.stdout)).toBeLessThan(1024 * 1024);
	});
});

describe("runHook: children do not outlive the process", () => {
	test("live children are tracked until they settle", async () => {
		const before = liveCount();
		const r = runHook({}, { ...base, command: script("echo.sh", "echo hi") });
		expect(liveCount()).toBe(before + 1);
		expect(process.listeners("exit").filter((l) => l === killAllForExit)).toHaveLength(1);
		await r;
		expect(liveCount()).toBe(before);
	});

	test("the exit cleanup SIGKILLs every live child group", async () => {
		const t = tracked();
		const pending = runHook({}, { ...base, ...t, timeoutMs: 60_000, command: script("stubborn.sh", `trap '' TERM\n${SLEEPER}`) });
		expect(liveCount()).toBe(1);
		killAllForExit();
		await expectAllDead(t);
		const r = await pending;
		expect(r.code).toBe(-1);
		expect(liveCount()).toBe(0);
	});
});

describe("runHook: fail open", () => {
	test("missing binary resolves with code -1", async () => {
		const r = await runHook({}, { ...base, command: join(dir, "does-not-exist") });
		expect(r.code).toBe(-1);
		expect(r.stdout).toBe("");
	});

	test("a synchronously throwing spawn resolves with code -1", async () => {
		const spawnFn = (() => {
			throw new Error("boom");
		}) as never;
		const r = await runHook({}, { ...base, spawnFn });
		expect(r.code).toBe(-1);
	});

	test("a child that closes stdin early (EPIPE) still resolves", async () => {
		const r = await runHook({ body: "y".repeat(2_000_000) }, { ...base, command: script("closed.sh", "exec <&-\nexit 3") });
		expect(r.code).toBe(3);
	});

	test("a non-zero exit is reported, not thrown", async () => {
		const r = await runHook({}, { ...base, command: script("fail.sh", "echo out; exit 2") });
		expect(r).toEqual({ stdout: "out\n", code: 2, killed: false });
	});
});

describe("timeoutFor", () => {
	test("small bodies get the fast timeout, large ones the long one", () => {
		expect(POSTHOOK_FAST_TIMEOUT_MS).toBe(3_000);
		expect(POSTHOOK_TIMEOUT_MS).toBe(20_000);
		expect(timeoutFor(19_999)).toBe(3_000);
		expect(timeoutFor(20_000)).toBe(20_000);
	});
});
