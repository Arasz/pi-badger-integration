/**
 * Unit tests for the console-capture helpers.
 *
 * Everything runs against an injected console and sink, so no TUI, terminal or real
 * `~/.pi` file is touched. Each test names the failure mode it targets:
 *  - A4.1 a level silently still writes to the terminal (or is dropped);
 *  - A4.2 the kill-switch fails to gate the wrap;
 *  - A4.4 rotation grows beyond one generation or loses the live file;
 *  - A4.5 the fatal guard leaves the wrapper armed (pi's crash pair then disappears);
 *  - A4.6 capture and the vertex filter clobber each other's restore;
 *  - A4.7 a throwing sink throws into the extension or swallows the line.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ConsoleCapture,
	createFileSink,
	defaultLogPath,
	flushTail,
	installConsoleCapture,
	isCaptureDisabled,
	rotateIfNeeded,
	type ConsoleLevel,
	type ConsoleLike,
} from "../../extensions/console-capture/console-capture.ts";
import { installVertexDebugFilter } from "../../extensions/session-signals/silence-vertex-debug.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** The levels capture owns, in the order the plan names them. */
const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];

interface TerminalCall {
	level: ConsoleLevel;
	args: unknown[];
}

/** A stand-in for the real console that records every call that reaches it. */
function fakeConsole(): ConsoleLike & { calls: TerminalCall[] } {
	const calls: TerminalCall[] = [];
	const target = {
		calls,
		log: (...args: unknown[]) => calls.push({ level: "log", args }),
		info: (...args: unknown[]) => calls.push({ level: "info", args }),
		warn: (...args: unknown[]) => calls.push({ level: "warn", args }),
		error: (...args: unknown[]) => calls.push({ level: "error", args }),
		debug: (...args: unknown[]) => calls.push({ level: "debug", args }),
	};
	return target;
}

function tempLogPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "aib-console-capture-"));
	tempDirs.push(dir);
	return join(dir, "badger-console.log");
}

test("capture: routes console levels to the log and not the terminal", () => {
	const terminal = fakeConsole();
	const lines: string[] = [];
	const capture = installConsoleCapture({
		env: {},
		console: terminal,
		sink: (line) => lines.push(line),
		now: () => Date.parse("2026-09-22T10:00:00.000Z"),
	});
	expect(capture).toBeDefined();

	terminal.log("hello", 42);
	terminal.info("info line");
	terminal.warn("warn line");
	terminal.error("error line");
	terminal.debug("debug line");

	expect(terminal.calls).toHaveLength(0);
	expect(lines).toEqual([
		"2026-09-22T10:00:00.000Z log hello 42\n",
		"2026-09-22T10:00:00.000Z info info line\n",
		"2026-09-22T10:00:00.000Z warn warn line\n",
		"2026-09-22T10:00:00.000Z error error line\n",
		"2026-09-22T10:00:00.000Z debug debug line\n",
	]);

	capture!.uninstall();
});

test("capture: the env kill-switch leaves console untouched", () => {
	for (const value of ["0", "false", "off", "FALSE", " Off "]) {
		expect(isCaptureDisabled({ PI_BADGER_CONSOLE_CAPTURE: value })).toBe(true);
	}
	expect(isCaptureDisabled({})).toBe(false);
	expect(isCaptureDisabled({ PI_BADGER_CONSOLE_CAPTURE: "1" })).toBe(false);

	const terminal = fakeConsole();
	const lines: string[] = [];
	const capture = installConsoleCapture({
		env: { PI_BADGER_CONSOLE_CAPTURE: "off" },
		console: terminal,
		sink: (line) => lines.push(line),
	});
	expect(capture).toBeUndefined();

	terminal.error("startup diagnostic");
	expect(lines).toHaveLength(0);
	expect(terminal.calls).toEqual([{ level: "error", args: ["startup diagnostic"] }]);
});

test("capture: uninstall restores exactly the captured functions", () => {
	const terminal = fakeConsole();
	const before = {} as Record<ConsoleLevel, (...args: unknown[]) => void>;
	for (const level of LEVELS) before[level] = terminal[level];

	const capture = installConsoleCapture({
		env: {},
		console: terminal,
		sink: () => {},
	});
	expect(capture).toBeDefined();
	for (const level of LEVELS) {
		expect(terminal[level]).not.toBe(before[level]);
	}

	capture!.uninstall();
	for (const level of LEVELS) {
		expect(terminal[level]).toBe(before[level]);
	}
});

test("capture: rotation at the byte cap keeps one generation", () => {
	const logPath = tempLogPath();
	const line = "0123456789\n"; // 11 bytes
	const sink = createFileSink(logPath, 30);

	sink(line); // 11
	sink(line); // 22
	sink(line); // would be 33 > 30 -> rotate, live file restarts at 11
	expect(existsSync(`${logPath}.1`)).toBe(true);
	expect(readFileSync(`${logPath}.1`, "utf8")).toBe(line + line);
	expect(readFileSync(logPath, "utf8")).toBe(line);

	sink(line); // live 22
	sink(line); // would be 33 > 30 -> rotate again; the old .1 is replaced
	expect(readFileSync(`${logPath}.1`, "utf8")).toBe(line + line);
	expect(readFileSync(logPath, "utf8")).toBe(line);
	expect(existsSync(`${logPath}.2`)).toBe(false);

	// The helper reports the same decision the sink acted on.
	expect(rotateIfNeeded(logPath, 0, 1000)).toBe(false);
	expect(rotateIfNeeded(logPath, 1000, 30)).toBe(true);
});

test("capture: the fatal guard restores console and never re-arms", () => {
	const terminal = fakeConsole();
	const before = {} as Record<ConsoleLevel, (...args: unknown[]) => void>;
	for (const level of LEVELS) before[level] = terminal[level];
	const lines: string[] = [];
	const capture = installConsoleCapture({
		env: {},
		console: terminal,
		sink: (line) => lines.push(line),
	});
	expect(capture).toBeDefined();

	capture!.fatal();
	expect(capture!.armed).toBe(false);
	for (const level of LEVELS) {
		expect(terminal[level]).toBe(before[level]);
	}

	terminal.error("after fatal");
	expect(lines).toHaveLength(0);
	expect(terminal.calls).toEqual([{ level: "error", args: ["after fatal"] }]);

	capture!.arm();
	expect(capture!.armed).toBe(false);
	terminal.error("still direct");
	expect(terminal.calls).toHaveLength(2);
});

test("capture: a throwing sink falls back to the original console and does not throw", () => {
	const terminal = fakeConsole();
	let sinkCalls = 0;
	const capture = installConsoleCapture({
		env: {},
		console: terminal,
		sink: () => {
			sinkCalls += 1;
			throw new Error("disk full");
		},
	});
	expect(capture).toBeDefined();

	expect(() => terminal.error("boom")).not.toThrow();
	expect(sinkCalls).toBe(1);
	expect(terminal.calls).toEqual([{ level: "error", args: ["boom"] }]);

	capture!.uninstall();
});

test("capture: composed with the vertex filter in either order, neither writes to the terminal", () => {
	const vertexMessage =
		"The user provided project/location will take precedence over the API key from the environment variables.";

	for (const order of ["capture-first", "filter-first"] as const) {
		const terminal = fakeConsole();
		const lines: string[] = [];
		const saved = { debug: console.debug, warn: console.warn, error: console.error };
		console.debug = terminal.debug;
		console.warn = terminal.warn;
		console.error = terminal.error;

		let capture: ConsoleCapture | undefined;
		let uninstallFilter: (() => void) | undefined;
		try {
			if (order === "capture-first") {
				capture = installConsoleCapture({ env: {}, console, sink: (line) => lines.push(line) })!;
				uninstallFilter = installVertexDebugFilter();
			} else {
				uninstallFilter = installVertexDebugFilter();
				capture = installConsoleCapture({ env: {}, console, sink: (line) => lines.push(line) })!;
			}

			console.debug(vertexMessage);
			console.warn(vertexMessage);
			console.error(vertexMessage);

			expect(terminal.calls).toHaveLength(0);
		} finally {
			// Reverse install order restores each layer's exact captured reference.
			if (order === "capture-first") {
				uninstallFilter?.();
				capture?.uninstall();
			} else {
				capture?.uninstall();
				uninstallFilter?.();
			}
			console.debug = saved.debug;
			console.warn = saved.warn;
			console.error = saved.error;
		}
	}
});

describe("capture helpers", () => {
	test("defaultLogPath prefers the env override and falls back to the agent dir", () => {
		expect(defaultLogPath({ PI_BADGER_CONSOLE_CAPTURE_LOG: "/tmp/custom.log" }, "/home/u/.pi/agent"))
			.toBe("/tmp/custom.log");
		expect(defaultLogPath({}, "/home/u/.pi/agent"))
			.toBe(join("/home/u/.pi/agent", "badger-console.log"));
	});

	test("flushTail writes the tail and is silent on an empty tail", () => {
		const written: string[] = [];
		flushTail((text) => written.push(text), "line one\nline two\n");
		flushTail((text) => written.push(text), "");
		expect(written).toEqual(["line one\nline two\n"]);
	});
});
