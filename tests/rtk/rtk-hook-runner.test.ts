/** rtk-hook-runner tests: real child-process fixtures for stdin, cwd/env, kill escalation and fail-open paths. */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	POSTHOOK_FAST_TIMEOUT_MS,
	POSTHOOK_TIMEOUT_MS,
	runHook,
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
	test("timeout kills a sleeping child", async () => {
		const r = await runHook({}, { ...base, timeoutMs: 150, command: script("sleep.sh", "sleep 30") });
		expect(r.killed).toBe(true);
	});

	test("a TERM-ignoring child is SIGKILLed within timeout + grace", async () => {
		const t0 = Date.now();
		const r = await runHook({}, { ...base, timeoutMs: 150, graceMs: 200, command: script("stubborn.sh", "trap '' TERM\nsleep 30") });
		expect(r.killed).toBe(true);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	test("abort kills the child", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await runHook({}, { ...base, signal: ac.signal, timeoutMs: 10_000, command: script("sleep.sh", "sleep 30") });
		expect(r.killed).toBe(true);
	});

	test("an already-aborted signal kills immediately", async () => {
		const ac = new AbortController();
		ac.abort();
		const r = await runHook({}, { ...base, signal: ac.signal, timeoutMs: 10_000, command: script("sleep.sh", "sleep 30") });
		expect(r.killed).toBe(true);
	});

	test("stdout past the cap kills the child", async () => {
		const r = await runHook({}, { ...base, command: script("flood.sh", "yes") });
		expect(r.killed).toBe(true);
		expect(r.stdout.length).toBeGreaterThan(0);
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
