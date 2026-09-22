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
	fire(event: string, ...args: unknown[]): void;
}

function fakeProc(): FakeProc {
	const handlers = new Map<string, ProcListener[]>();
	return {
		on(event, listener) {
			const list = handlers.get(event) ?? [];
			list.push(listener);
			handlers.set(event, list);
		},
		fire(event, ...args) {
			for (const listener of handlers.get(event) ?? []) listener(...args);
		},
	};
}

async function fireSessionStart(pi: FakePi, mode: string): Promise<void> {
	for (const handler of pi.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, { mode });
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
});
