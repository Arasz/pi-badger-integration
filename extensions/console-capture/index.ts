/**
 * Console capture extension: keeps extension console output out of the TUI.
 *
 * Factories load before the TUI starts, so capture arms at factory time and every later
 * `console.*` from any extension is appended to `PI_BADGER_CONSOLE_CAPTURE_LOG` or
 * `<getAgentDir()>/badger-console.log` (rotated at 1 MiB to `.1`) instead of rendering in
 * the input area. A `session_start` with `ctx.mode !== "tui"` disarms the wrapper so
 * headless modes keep their terminal output; `session_shutdown` uninstalls it. If pi exits
 * before a TUI session_start confirms — the extension-load-failure diagnostics path — the
 * captured tail is flushed to the original stderr on `process.on("exit")`. A permanent
 * `uncaughtExceptionMonitor` disarm keeps pi's crash pair visible.
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	createFileSink,
	defaultLogPath,
	flushTail,
	installConsoleCapture,
	type ConsoleLike,
} from "./console-capture.ts";

/** The process surface the factory touches; injectable so tests never exit a real process. */
export interface ProcessLike {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ConsoleCaptureDeps {
	/** Kill-switch + log-path env; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Log file path; defaults to the env override or `<getAgentDir()>/badger-console.log`. */
	logPath?: string;
	/** Rotation threshold; defaults to 1 MiB. */
	maxBytes?: number;
	/** Appends one formatted line; defaults to the rotating file sink. */
	sink?: (line: string) => void;
	/** Clock for the ISO timestamp; defaults to `Date.now`. */
	now?: () => number;
	/** The console to wrap; defaults to the global console. */
	console?: ConsoleLike;
	/** Exit-flush target; defaults to `process.stderr.write`. */
	stderr?: (text: string) => void;
	/** Process-like event source; defaults to `process`. */
	proc?: ProcessLike;
}

export default function consoleCapture(pi: ExtensionAPI, deps: ConsoleCaptureDeps = {}): void {
	const env = deps.env ?? process.env;
	const logPath = deps.logPath ?? defaultLogPath(env, getAgentDir());
	const sink = deps.sink ?? createFileSink(logPath, deps.maxBytes);
	const capture = installConsoleCapture({ sink, env, console: deps.console, now: deps.now });
	if (!capture) return; // kill-switch: the console is untouched and no handler is registered

	const proc: ProcessLike = deps.proc ?? process;
	const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
	let tuiConfirmed = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			tuiConfirmed = true;
			capture.arm();
			return;
		}
		capture.disarm();
	});

	pi.on("session_shutdown", () => {
		capture.uninstall();
	});

	proc.on("exit", () => {
		// Startup diagnostics were captured before a TUI ever confirmed; hand them back to
		// the terminal. Once the TUI owns the screen, the log file is the only destination.
		if (!tuiConfirmed) flushTail(stderr, capture.tail());
	});

	proc.on("uncaughtExceptionMonitor", () => {
		capture.fatal();
	});
}
