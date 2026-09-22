/**
 * Console capture helpers.
 *
 * Extensions write `console.*` directly to the terminal, and in TUI mode pi does not
 * reroute it, so extension output renders inside the input area. This module wraps the
 * five console levels pi's TUI owns and appends one `<iso> <level> <text>` line per call
 * to an injectable sink (the extension wires a rotating file sink), keeping the terminal
 * clean. Everything here is injectable — console, sink, env, clock — so tests need no TUI.
 *
 * Failure posture: the wrapper never throws into a caller. A throwing sink falls back to
 * the original method once; `fatal()` restores the exact captured references and refuses
 * to re-arm, so pi's `uncaughtExceptionMonitor` crash pair reaches the terminal. Because
 * `uninstall()` restores exactly what it captured, capture nests with the vertex filter in
 * `session-signals/silence-vertex-debug.ts` in either order.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";

/** The console methods capture owns. `info !== log` on modern Node, so both are wrapped. */
export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** The wrapped surface of `console`; injectable so tests never touch the real one. */
export interface ConsoleLike {
	log: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
}

/** Rotate before an append would push the live file past this size. */
export const DEFAULT_MAX_BYTES = 1024 * 1024;
/** How much captured output the pre-`session_start` exit flush can replay. */
export const DEFAULT_TAIL_BYTES = 64 * 1024;

export interface CaptureOptions {
	/** Appends one formatted line; a throw falls back to the original console method. */
	sink: (line: string) => void;
	/** Kill-switch source; defaults to `process.env` at install time. */
	env?: Record<string, string | undefined>;
	/** The console to wrap; defaults to the global console. */
	console?: ConsoleLike;
	/** Clock for the ISO timestamp; defaults to `Date.now`. */
	now?: () => number;
	/** Byte cap on the in-memory flush tail; defaults to {@link DEFAULT_TAIL_BYTES}. */
	tailBytes?: number;
}

/** `PI_BADGER_CONSOLE_CAPTURE` is `0|false|off` (case/space-insensitive) to disable. */
export function isCaptureDisabled(env: Record<string, string | undefined>): boolean {
	const raw = env.PI_BADGER_CONSOLE_CAPTURE?.trim().toLowerCase();
	return raw === "0" || raw === "false" || raw === "off";
}

/** `PI_BADGER_CONSOLE_CAPTURE_LOG` or `<agentDir>/badger-console.log`. */
export function defaultLogPath(env: Record<string, string | undefined>, agentDir: string): string {
	const override = env.PI_BADGER_CONSOLE_CAPTURE_LOG?.trim();
	return override ? override : join(agentDir, "badger-console.log");
}

/** One call is one line: the ISO timestamp, the level, then `util.format`ed args. */
export function formatLine(level: ConsoleLevel, args: unknown[], iso: string): string {
	const text = format(...args).replace(/\r?\n/g, "\\n");
	return `${iso} ${level} ${text}\n`;
}

/**
 * Move the live log to `<logPath>.1` when the incoming append would cross `maxBytes`,
 * overwriting any previous generation (exactly one is kept). Returns whether it rotated.
 */
export function rotateIfNeeded(logPath: string, incomingBytes: number, maxBytes: number): boolean {
	let size: number;
	try {
		size = statSync(logPath).size;
	} catch {
		return false;
	}
	if (size <= 0 || size + incomingBytes <= maxBytes) return false;
	const rotated = `${logPath}.1`;
	rmSync(rotated, { force: true });
	renameSync(logPath, rotated);
	return true;
}

/** A sink that appends to `logPath`, rotating at `maxBytes`. Throws on a real write
 * failure; the capture wrapper catches that and falls back to the original console. */
export function createFileSink(logPath: string, maxBytes: number = DEFAULT_MAX_BYTES): (line: string) => void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
	} catch {
		// Fail-open: the append below reports the real failure to the wrapper.
	}
	return (line: string) => {
		rotateIfNeeded(logPath, Buffer.byteLength(line, "utf8"), maxBytes);
		appendFileSync(logPath, line, "utf8");
	};
}

/** Write the captured tail to the original stderr; never throws from an exit handler. */
export function flushTail(stderr: (text: string) => void, tail: string): void {
	if (!tail) return;
	try {
		stderr(tail);
	} catch {
		// Exiting: a failed flush must not replace the real exit reason.
	}
}

/** A live wrap: toggles between capture and pass-through, restores exactly on uninstall. */
export class ConsoleCapture {
	private readonly target: ConsoleLike;
	private readonly originals: Record<ConsoleLevel, (...args: unknown[]) => void>;
	private readonly sink: (line: string) => void;
	private readonly now: () => number;
	private readonly tailBytes: number;
	private readonly tailLines: string[] = [];
	private tailSize = 0;
	private installed = false;
	private armedFlag = false;

	constructor(options: CaptureOptions) {
		this.target = options.console ?? (globalThis.console as unknown as ConsoleLike);
		this.sink = options.sink;
		this.now = options.now ?? Date.now;
		this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
		this.originals = {
			log: this.target.log,
			info: this.target.info,
			warn: this.target.warn,
			error: this.target.error,
			debug: this.target.debug,
		};
		for (const level of CONSOLE_LEVELS) {
			this.target[level] = this.wrap(level);
		}
		this.installed = true;
		this.armedFlag = true;
	}

	get armed(): boolean {
		return this.armedFlag;
	}

	get isInstalled(): boolean {
		return this.installed;
	}

	/** Re-arm after a temporary `disarm()`. A no-op after `fatal()` or `uninstall()`. */
	arm(): void {
		if (!this.installed) return;
		this.armedFlag = true;
	}

	/** Pass-through without restoring: non-TUI sessions keep their terminal output. */
	disarm(): void {
		this.armedFlag = false;
	}

	/** Fatal carve-out: restore console; this instance can never capture again. */
	fatal(): void {
		this.uninstall();
	}

	/** Restore exactly the functions captured at install; nests with other console patches. */
	uninstall(): void {
		if (!this.installed) return;
		for (const level of CONSOLE_LEVELS) {
			this.target[level] = this.originals[level];
		}
		this.installed = false;
		this.armedFlag = false;
	}

	/** Everything captured this session, bounded to the tail cap — the exit-flush source. */
	tail(): string {
		return this.tailLines.join("");
	}

	private wrap(level: ConsoleLevel): (...args: unknown[]) => void {
		return (...args: unknown[]) => {
			if (!this.armedFlag) {
				this.originals[level].apply(this.target, args);
				return;
			}
			try {
				const line = formatLine(level, args, new Date(this.now()).toISOString());
				this.sink(line);
				this.pushTail(line);
			} catch {
				this.originals[level].apply(this.target, args);
			}
		};
	}

	private pushTail(line: string): void {
		const bytes = Buffer.byteLength(line, "utf8");
		this.tailLines.push(line);
		this.tailSize += bytes;
		while (this.tailSize > this.tailBytes && this.tailLines.length > 1) {
			this.tailSize -= Buffer.byteLength(this.tailLines.shift()!, "utf8");
		}
	}
}

/**
 * Install capture unless `PI_BADGER_CONSOLE_CAPTURE` disables it; `undefined` means the
 * console was left untouched. The caller owns process-level wiring (exit flush, fatal).
 */
export function installConsoleCapture(options: CaptureOptions): ConsoleCapture | undefined {
	if (isCaptureDisabled(options.env ?? process.env)) return undefined;
	return new ConsoleCapture(options);
}
