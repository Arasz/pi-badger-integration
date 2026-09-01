/**
 * Real-child integration smoke (rows 51–52 of docs/plans/2026-interactive-subagent-delegation.tests.md).
 *
 * Gated: PI_BADGER_SMOKE=1 — real `pi -p --mode json` children cost tokens and need a
 * configured provider, so the default suite never runs these. The skip must be LOUD
 * (qa finding 4): when the gate is unset the suite prints the reason; AC4 may not be
 * checked while row 52 reports skipped.
 *
 * Both rows drive the REAL DelegationRunner with the REAL spawn (defaultSpawn → PATH `pi`,
 * the production fallback) in a temp dir scaffolded with a minimal `.pi/agents` — which
 * makes the AC4 `git status --porcelain` clause structural: the children can never dirty
 * the repo. A 60 s watchdog escalates through the runner's own abort path; afterAll
 * asserts no survivor pids.
 *
 * Answers ride the DelegationNote (notifyComplete), not the record — the record carries
 * state/exitCode/usage/logFile; row 51 asserts both shapes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DelegationNote, DelegationRunner } from "../extensions/subagent/delegation-runner.ts";

const SMOKE = process.env.PI_BADGER_SMOKE === "1";
const describeSmoke = SMOKE ? describe : describe.skip;
if (!SMOKE) {
	// qa finding 4: the skip must never be silent.
	console.warn(
		"SKIPPED: PI_BADGER_SMOKE unset — H2/H4 unverified (run PI_BADGER_SMOKE=1 bun test tests/subagent-real-child.test.ts)",
	);
}

const SMOKE_TIMEOUT_MS = 150_000;
const WATCHDOG_MS = 120_000; // measured: a cold-start child from a fresh dir completes in ~62s (one retry cycle) — 60s was tighter than reality

/** Real child invocation for a delegation — the same argv shape the tool layer builds (row 1). */
function smokeInvocation(systemPrompt: string, task: string): { command: string; args: string[] } {
	return {
		command: "pi",
		args: [
			"-p", "--mode", "json", "--no-session", "--exclude-tools", "delegate,delegations,queue,monitor,wait",
			"--append-system-prompt", systemPrompt, "--", task,
		],
	};
}

function scaffoldProject(): { dir: string; logDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-badger-smoke-"));
	mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
	mkdirSync(join(dir, "smoke-logs"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "agents", "smoke.md"),
		"---\nname: smoke\ndescription: minimal persona for the real-child smoke\n---\nReply with exactly: ok\n",
	);
	return { dir, logDir: join(dir, "smoke-logs") };
}

/** The real log tee, wired exactly as index.ts wires it: raw JSONL, 0o600, per-run file. */
function makeLogSinkFactory(logDir: string) {
	return (init: { id: string }) => {
		const file = join(logDir, `${init.id}.jsonl`);
		return {
			logFile: file,
			appendLine(line: string) {
				appendFileSync(file, `${line}\n`, { mode: 0o600 });
			},
		};
	};
}

async function pidGone(pid: number, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			await Bun.sleep(100);
		} catch {
			return true;
		}
	}
	return false;
}

describeSmoke("rows 51–52 — real-child smoke (PI_BADGER_SMOKE=1)", () => {
	const { dir: projectDir, logDir } = scaffoldProject();
	const spawned: number[] = [];

	afterAll(() => {
		// No zombies: every pid this suite spawned must be gone; kill any survivor.
		for (const pid of spawned) {
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
			}
			if (alive) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* reaped between probe and kill */
				}
			}
			expect(alive).toBeFalse();
		}
		rmSync(projectDir, { recursive: true, force: true });
	});

	test(
		"row 51 — full real delegation: exit 0, usage > 0, answer in the note, log written",
		async () => {
			const notes: DelegationNote[] = [];
			const runner = new DelegationRunner({
				logSink: makeLogSinkFactory(logDir),
				notifyComplete: (note) => notes.push(note),
			});
			const invocation = smokeInvocation("Reply with exactly: ok", "Reply with exactly: ok");
			const handle = runner.run({
				id: "d-smoke-51",
				agent: "smoke",
				task: "Reply with exactly: ok",
				args: invocation.args,
				command: invocation.command,
				cwd: projectDir,
				startedAt: Date.now(),
			});
			if (handle.record.pid !== undefined) spawned.push(handle.record.pid);

			let watchdog: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<never>((_, reject) => {
				watchdog = setTimeout(() => {
					handle.abort();
					reject(new Error(`watchdog: smoke child did not settle within ${WATCHDOG_MS}ms — aborted`));
				}, WATCHDOG_MS);
			});
			let record;
			try {
				record = await Promise.race([handle.done, timedOut]);
			} finally {
				clearTimeout(watchdog);
			}

			expect(record.state).toBe("completed");
			expect(record.exitCode).toBe(0);
			expect(record.usage?.input ?? 0).toBeGreaterThan(0);

			expect(notes).toHaveLength(1);
			const note = notes[0]!;
			expect(note.state).toBe("completed");
			expect(note.exitCode).toBe(0);
			expect(note.usage?.input ?? 0).toBeGreaterThan(0);
			expect(note.answer.toLowerCase()).toContain("ok");
			expect(note.logFile).toBeTruthy();

			const log = Bun.file(note.logFile!).text();
			expect((await log).split("\n").filter(Boolean)[0]).toContain('"run"');
		},
		SMOKE_TIMEOUT_MS,
	);

	test(
		"row 52 — real SIGTERM kills a real child within the grace window; run settles aborted",
		async () => {
			const runner = new DelegationRunner({ escalateAfterMs: 3000 });
			const task =
				"Think as long as you can about the history of typography, then write 2000 words. Do not stop early.";
			const invocation = smokeInvocation("You are a slow, thorough writer.", task);
			const handle = runner.run({
				id: "d-smoke-52",
				agent: "smoke",
				task,
				args: invocation.args,
				command: invocation.command,
				cwd: projectDir,
				startedAt: Date.now(),
			});
			const pid = handle.record.pid;
			expect(pid).toBeDefined();
			spawned.push(pid!);

			// Alive before we abort — otherwise the test proves nothing.
			let wasAlive = true;
			try {
				process.kill(pid!, 0);
			} catch {
				wasAlive = false;
			}
			expect(wasAlive).toBeTrue();

			handle.abort();
			expect(await pidGone(pid!, 3_000 + 5_000)).toBeTrue(); // grace + slack
			const record = await handle.done;
			expect(record.state).toBe("aborted");
		},
		SMOKE_TIMEOUT_MS,
	);
});
