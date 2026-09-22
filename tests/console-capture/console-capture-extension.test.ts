/**
 * Factory wiring tests for the console-capture extension.
 *
 * The factory is driven through the shared fake-pi plus an injected console, sink,
 * stderr and process, so no TUI and no real exit path is exercised. Each test names the
 * failure mode it targets:
 *  - a factory that never wraps on load leaves load-time chatter leaking;
 *  - a non-TUI session that stays armed swallows headless output;
 *  - a startup failure that exits before `session_start` loses pi's diagnostics.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import consoleCapture from "../../extensions/console-capture/index.ts";
import type { ConsoleLevel, ConsoleLike } from "../../extensions/console-capture/console-capture.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

interface TerminalCall {
	level: ConsoleLevel;
	args: unknown[];
}

function fakeConsole(): ConsoleLike & { calls: TerminalCall[] } {
	const calls: TerminalCall[] = [];
	return {
		calls,
		log: (...args: unknown[]) => calls.push({ level: "log", args }),
		info: (...args: unknown[]) => calls.push({ level: "info", args }),
		warn: (...args: unknown[]) => calls.push({ level: "warn", args }),
		error: (...args: unknown[]) => calls.push({ level: "error", args }),
		debug: (...args: unknown[]) => calls.push({ level: "debug", args }),
	};
}

type ProcListener = (...args: unknown[]) => void;

interface FakeProc {
	on(event: string, listener: ProcListener): void;
	off(event: string, listener: ProcListener): void;
	fire(event: string, ...args: unknown[]): void;
	listenerCount(event: string): number;
}

function fakeProc(): FakeProc {
	const handlers = new Map<string, ProcListener[]>();
	return {
		on(event, listener) {
			const list = handlers.get(event) ?? [];
			list.push(listener);
			handlers.set(event, list);
		},
		off(event, listener) {
			const list = handlers.get(event) ?? [];
			handlers.set(
				event,
				list.filter((entry) => entry !== listener),
			);
		},
		fire(event, ...args) {
			for (const listener of handlers.get(event) ?? []) listener(...args);
		},
		listenerCount(event) {
			return (handlers.get(event) ?? []).length;
		},
	};
}

async function fireSessionStart(pi: FakePi, mode: string): Promise<void> {
	for (const handler of pi.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, { mode });
	}
}

async function fireSessionShutdown(pi: FakePi): Promise<void> {
	for (const handler of pi.handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, { mode: "tui" });
	}
}

describe("console-capture factory wiring", () => {
	test("extension: installs on load and stays armed in tui", async () => {
		const terminal = fakeConsole();
		const lines: string[] = [];
		const pi = createFakePi();
		consoleCapture(pi as never, {
			env: {},
			console: terminal,
			sink: (line) => lines.push(line),
			proc: fakeProc(),
		});

		expect([...pi.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start"]);

		await fireSessionStart(pi, "tui");
		terminal.error("tui diagnostic");

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("error tui diagnostic");
		expect(terminal.calls).toHaveLength(0);
	});

	test("extension: disarms at session_start when the mode is not tui", async () => {
		const terminal = fakeConsole();
		const lines: string[] = [];
		const pi = createFakePi();
		consoleCapture(pi as never, {
			env: {},
			console: terminal,
			sink: (line) => lines.push(line),
			proc: fakeProc(),
		});

		await fireSessionStart(pi, "print");
		terminal.error("headless diagnostic");

		expect(lines).toHaveLength(0);
		expect(terminal.calls).toEqual([{ level: "error", args: ["headless diagnostic"] }]);
	});

	test("extension: a failure exit before session_start flushes captured diagnostics to the original stderr", () => {
		const dir = mkdtempSync(join(tmpdir(), "aib-console-capture-ext-"));
		try {
			const logPath = join(dir, "badger-console.log");
			const terminal = fakeConsole();
			const proc = fakeProc();
			const stderr: string[] = [];
			const pi = createFakePi();
			consoleCapture(pi as never, {
				env: {},
				console: terminal,
				logPath,
				proc,
				stderr: (text) => stderr.push(text),
			});

			// pi's extension-load-failure diagnostics print here, then process.exit(1).
			terminal.error("extension load failed: boom");
			expect(terminal.calls).toHaveLength(0);
			expect(existsSync(logPath)).toBe(true);

			proc.fire("exit");
			expect(stderr.join("")).toContain("extension load failed: boom");
			expect(readFileSync(logPath, "utf8")).toContain("extension load failed: boom");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("extension: a confirmed tui session never flushes the tail at exit", async () => {
		const terminal = fakeConsole();
		const proc = fakeProc();
		const stderr: string[] = [];
		const pi = createFakePi();
		consoleCapture(pi as never, {
			env: {},
			console: terminal,
			sink: () => {},
			proc,
			stderr: (text) => stderr.push(text),
		});

		await fireSessionStart(pi, "tui");
		terminal.error("captured for the log only");
		proc.fire("exit");
		expect(stderr).toHaveLength(0);
	});

	test("extension: session_shutdown removes both process listeners — no per-session accumulation", async () => {
		// pi re-runs extension factories per session; leaking a listener per factory run hits
		// Node's 11-listener MaxListenersExceededWarning, which prints into the TUI.
		const proc = fakeProc();
		for (let session = 0; session < 3; session++) {
			const pi = createFakePi();
			consoleCapture(pi as never, { env: {}, console: fakeConsole(), sink: () => {}, proc });
			expect(proc.listenerCount("exit")).toBe(1);
			expect(proc.listenerCount("uncaughtExceptionMonitor")).toBe(1);
			await fireSessionShutdown(pi);
			expect(proc.listenerCount("exit")).toBe(0);
			expect(proc.listenerCount("uncaughtExceptionMonitor")).toBe(0);
		}
		expect(proc.listenerCount("exit")).toBe(0);
		expect(proc.listenerCount("uncaughtExceptionMonitor")).toBe(0);
	});

	test("extension: the kill-switch registers no listener and creates no log file", () => {
		const dir = mkdtempSync(join(tmpdir(), "aib-console-capture-off-"));
		try {
			const logPath = join(dir, "nested", "badger-console.log");
			const terminal = fakeConsole();
			const proc = fakeProc();
			const pi = createFakePi();
			consoleCapture(pi as never, {
				env: { PI_BADGER_CONSOLE_CAPTURE: "0" },
				console: terminal,
				logPath,
				proc,
			});

			expect(proc.listenerCount("exit")).toBe(0);
			expect(proc.listenerCount("uncaughtExceptionMonitor")).toBe(0);
			expect(existsSync(join(dir, "nested"))).toBe(false);
			terminal.error("still goes to the terminal");
			expect(terminal.calls).toEqual([{ level: "error", args: ["still goes to the terminal"] }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
