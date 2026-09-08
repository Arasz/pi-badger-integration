/**
 * Bash-predicate execution for the monitor extension (task pbi-monitor-register-bash-predicate).
 *
 * TRUST MODEL (review-facing, mirrored in the tool description): a bash predicate runs
 * UNSANDBOXED as `bash -c <script>` with the full privileges of the user who runs pi — it
 * can read/write the filesystem, spawn processes and exfiltrate data. That is intentional:
 * the predicate author is the user's own agent (the same trust as the JS predicate's vm
 * escape note in monitor-core.ts), and bash predicates exist precisely for checks the JS
 * sandbox cannot express (jq-less JSON scans, file probes, CLI gates). Never register a
 * bash predicate from untrusted input.
 *
 * Kept OUT of monitor-core.ts on purpose: the core is pure (node:vm only, no processes,
 * no clocks). Everything here touches child processes and real timers, so it lives in
 * this helper and is injected into the wiring (index.ts) through MonitorDeps seams.
 *
 * Contract:
 *   - compile gate: size cap + `bash -n` syntax check (script on STDIN — a string argument
 *     to `bash -n` would be a FILE path). Rejects free, before the monitor-cap check.
 *   - run: snapshot JSON on stdin (never argv/env — snapshots can exceed ARG_MAX and argv
 *     leaks into process listings, S2), exit-code mapping 0→fired / 1→idle / ≥2, signal
 *     death, timeout or spawn failure → error+disarm.
 *   - budget (S1): the JS predicate cap is 4 KB; bash reuses the same 4096-char cap
 *     (BASH_PREDICATE_MAX_CHARS mirrors PREDICATE_MAX_CHARS — one rule for both predicate
 *     kinds, so the 8 KB card budget math stays 4 KB predicate + 1 KB stdout value +
 *     tail-capped snapshot digest ≤ 8 KB). Stdout/stderr keep the HEAD (command output
 *     reads top-down; the FIRST kilobyte names the failure), unlike the snapshot digest
 *     which keeps the TAIL (the answer lives at the end — see capTail in the core).
 */

import { spawn, type ChildProcess } from "node:child_process";

// ------------------------------------------------------------------ constants

/** Character cap on a bash predicate script — mirrors PREDICATE_MAX_CHARS (S1, M6). */
export const BASH_PREDICATE_MAX_CHARS = 4096;

/** Default wall-clock budget for one bash evaluation (kill follows, P1). */
export const BASH_PREDICATE_TIMEOUT_MS = 5000;

/** SIGTERM→SIGKILL grace between escalation steps (P1). */
export const BASH_PREDICATE_GRACE_MS = 500;

/** Default budget for the `bash -n` compile gate (S3: short, same seam family). */
export const BASH_COMPILE_TIMEOUT_MS = 2000;

/** Head cap on captured stdout (fire value) and on stderr quoted in error reasons. */
export const BASH_PREDICATE_VALUE_MAX_CHARS = 1024;
export const BASH_PREDICATE_STDERR_MAX_CHARS = 1024;

/** Retention guard while collecting output: a runaway `yes` must not OOM the host before
 * the timeout kill lands — chunks past this are dropped (the final head cap applies below). */
const OUTPUT_RETAIN_MAX_CHARS = 8192;

// ------------------------------------------------------------------ tracked sets (M7/S5)

/** Every live bash child, process-global: expiry/shutdown kill through handles, and the
 * quiescence tests assert this empties (no orphans). */
const inFlight = new Set<ChildProcess>();

/** Every pending helper-owned real timer (evaluation timeouts + kill-escalation grace).
 * The helper owns REAL timers, not the injected scheduler: bash children are OS processes
 * outside the manual-scheduler test world, so tests drive them with short real timeouts
 * (50–100 ms, M7). */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/** Number of live bash children right now (M7 orphan-proof surface). */
export function bashInFlightCount(): number {
	return inFlight.size;
}

/** Number of pending helper-owned timers right now (S5 surface). */
export function bashPendingTimerCount(): number {
	return pendingTimers.size;
}

function later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => {
		pendingTimers.delete(timer);
		fn();
	}, ms);
	pendingTimers.add(timer);
	return timer;
}

function clearLater(timer: ReturnType<typeof setTimeout> | undefined): void {
	if (timer === undefined) return;
	clearTimeout(timer);
	pendingTimers.delete(timer);
}

// ------------------------------------------------------------------ outcomes

/** Registration-time compile check: ok, or the typed syntax error to reject with. */
export type BashPredicateCompileResult = { readonly kind: "ok" } | { readonly kind: "syntax-error"; readonly reason: string };

/** The outcome of one bash evaluation: fired carries the value, idle stays armed, error disarms. */
export type BashPredicateOutcome =
	| { readonly kind: "fired"; readonly value: string | true }
	| { readonly kind: "idle" }
	| { readonly kind: "error"; readonly reason: string };

export interface BashCompileOptions {
	/** `bash -n` budget override (default BASH_COMPILE_TIMEOUT_MS). */
	timeoutMs?: number;
	/** Bash executable override — the ENOENT test seam (default "bash"). */
	executable?: string;
	/** Platform override — the win32 kill-path test seam (default process.platform). */
	platform?: NodeJS.Platform;
}

export interface BashRunOptions extends BashCompileOptions {
	/** Evaluation budget override (default BASH_PREDICATE_TIMEOUT_MS). */
	graceMs?: number;
	/** Abort kills the in-flight child (register threads the turn's signal through). */
	signal?: AbortSignal;
}

/** A started evaluation: `done` NEVER rejects (every failure maps to an outcome), `kill`
 * escalates SIGTERM→SIGKILL, `child`/`pid` are the orphan-proof surface (M7). */
export interface BashHandle {
	readonly done: Promise<BashPredicateOutcome>;
	kill(): void;
	readonly pid: number | undefined;
	readonly child: ChildProcess | undefined;
}

// ------------------------------------------------------------------ portable kill (M4)

/** Minimal surface killChildProcess needs — satisfied by ChildProcess and test fakes. */
export interface KillableChild {
	readonly pid?: number | undefined;
	kill(signal?: NodeJS.Signals): unknown;
}

export type KillFn = (pid: number, signal?: NodeJS.Signals) => unknown;

const defaultKill: KillFn = (pid, signal) => process.kill(pid, signal);

/**
 * Kill one child portably (M4). POSIX: signal the whole process GROUP (negative pid — the
 * child is spawned `detached` so grandchildren like `sleep` die too), falling back to
 * child.kill when the group kill throws. win32: NEVER a negative-pid kill (no such
 * semantic) — child.kill only. Never throws: kill paths run inside drains where a throw
 * would break the evaluation loop.
 */
export function killChildProcess(
	child: KillableChild,
	signal: NodeJS.Signals,
	platform: NodeJS.Platform = process.platform,
	killFn: KillFn = defaultKill,
): void {
	try {
		if (platform !== "win32" && child.pid !== undefined) {
			try {
				killFn(-child.pid, signal);
				return;
			} catch {
				// No such group (already reaped, or never detached) — fall through to child.kill.
			}
		}
		child.kill(signal);
	} catch {
		// The child is already gone — that is the desired end state, not an error.
	}
}

// ------------------------------------------------------------------ spawn core (S2)

interface InternalResult {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly spawnError: string | null;
}

interface StartedRun {
	readonly result: Promise<InternalResult>;
	readonly child: ChildProcess | undefined;
	kill(): void;
}

function describeSpawnError(err: unknown): string {
	if (err instanceof Error) {
		const code = (err as NodeJS.ErrnoException).code;
		return code ? `${code}: ${err.message}` : err.message;
	}
	return String(err);
}

/** Loud ENOENT guidance (M4): names the missing executable, the Windows prerequisite and the JS fallback. */
function bashUnavailableReason(detail: string): string {
	return (
		`bash is not available (${detail}) — bash predicates need a bash executable on PATH ` +
		`(on Windows: Git Bash or WSL bash on PATH; that prerequisite is documented on the monitor tool). ` +
		`Register a JS predicate instead, or install bash.`
	);
}

/**
 * Spawn contract (S2): `spawn(executable, args, { shell: false })` — the script travels as
 * ONE argv element to `bash -c` (or stdin for `bash -n`), NEVER interpolated into a shell
 * string. stdio is piped (snapshot on stdin, §runBashStdin); env/cwd INHERIT (nothing
 * passed, so the predicate sees the user's own environment — part of the unsandboxed
 * trust model above). POSIX spawns `detached` so the escalation can signal the group.
 */
function startRun(args: readonly string[], stdinText: string, opts: BashRunOptions): StartedRun {
	const executable = opts.executable ?? "bash";
	const platform = opts.platform ?? process.platform;
	const timeoutMs = opts.timeoutMs ?? BASH_PREDICATE_TIMEOUT_MS;
	const graceMs = opts.graceMs ?? BASH_PREDICATE_GRACE_MS;
	const signal = opts.signal;

	let child: ChildProcess | undefined;
	try {
		child = spawn(executable, [...args], {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			detached: platform !== "win32",
		});
	} catch (err) {
		return { result: Promise.resolve(finished(null, null, "", "", false, describeSpawnError(err))), child: undefined, kill: () => {} };
	}
	const started = child;
	inFlight.add(started);

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let killStarted = false;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;

	let resolveResult!: (result: InternalResult) => void;
	const result = new Promise<InternalResult>((resolve) => {
		resolveResult = resolve;
	});

	const finish = (): void => {
		clearLater(timeoutTimer);
		clearLater(graceTimer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		inFlight.delete(started);
		resolveResult(finished(started.exitCode, started.signalCode, stdout, stderr, timedOut, null));
	};
	let finishedOnce = false;
	const finishOnce = (): void => {
		if (finishedOnce) return;
		finishedOnce = true;
		finish();
	};

	/** SIGTERM now, SIGKILL after the grace — shared by timeout, abort and handle.kill(). */
	const escalate = (): void => {
		if (killStarted) return;
		killStarted = true;
		killChildProcess(started, "SIGTERM", platform);
		graceTimer = later(graceMs, () => killChildProcess(started, "SIGKILL", platform));
	};

	started.on("error", (err) => {
		// Spawn failure (ENOENT and friends): loud outcome, never a throw (M4).
		clearLater(timeoutTimer);
		clearLater(graceTimer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		inFlight.delete(started);
		resolveResult(finished(null, null, stdout, stderr, false, describeSpawnError(err)));
	});
	const retain = (current: string, chunk: unknown): string => {
		if (current.length >= OUTPUT_RETAIN_MAX_CHARS) return current;
		return current + chunk!.toString().slice(0, OUTPUT_RETAIN_MAX_CHARS - current.length);
	};
	started.stdout?.on("data", (chunk) => {
		stdout = retain(stdout, chunk);
	});
	started.stderr?.on("data", (chunk) => {
		stderr = retain(stderr, chunk);
	});
	started.on("close", () => finishOnce());

	// Stdin contract (M5): snapshot bytes via stdin.end in try/catch, 'error' swallowed — a
	// predicate that exits early (or closes stdin) EPIPEs the pipe, and that must not throw
	// or crash: the exit code below still decides the outcome.
	const stdin = started.stdin;
	if (stdin) {
		stdin.on("error", () => {});
		try {
			stdin.end(stdinText);
		} catch {
			// Already closed/destroyed — the close event still resolves the outcome.
		}
	}

	timeoutTimer = later(timeoutMs, () => {
		timedOut = true;
		escalate();
	});

	const onAbort = signal
		? () => {
				escalate();
			}
		: undefined;
	if (signal && onAbort) {
		if (signal.aborted) escalate();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	return { result, child: started, kill: escalate };
}

function finished(
	code: number | null,
	signal: string | null,
	stdout: string,
	stderr: string,
	timedOut: boolean,
	spawnError: string | null,
): InternalResult {
	return { code, signal, stdout, stderr, timedOut, spawnError };
}

// ------------------------------------------------------------------ compile gate (S3, M6)

/**
 * Compile gate: size cap, then `bash -n` with the script on STDIN and a short timeout
 * (~2 s, same seam family as the run budget). Registration calls this BEFORE consuming the
 * monitor cap: a syntax error (or an over-cap script) rejects free. NEVER throws — a
 * missing bash is a loud syntax-error with install guidance (M4), not a crash.
 */
export async function compileBashPredicate(predicate: string, opts: BashCompileOptions = {}): Promise<BashPredicateCompileResult> {
	if (predicate.length > BASH_PREDICATE_MAX_CHARS) {
		return {
			kind: "syntax-error",
			reason: `bash predicate is ${predicate.length} characters — over the ${BASH_PREDICATE_MAX_CHARS}-character cap (same cap as JS predicates)`,
		};
	}
	const { result } = startRun(["-n"], predicate, {
		timeoutMs: opts.timeoutMs ?? BASH_COMPILE_TIMEOUT_MS,
		executable: opts.executable,
		platform: opts.platform,
	});
	const checked = await result;
	if (checked.spawnError) return { kind: "syntax-error", reason: bashUnavailableReason(checked.spawnError) };
	if (checked.timedOut) return { kind: "syntax-error", reason: "bash syntax check timed out — the predicate could not be validated" };
	if (checked.code === 0) return { kind: "ok" };
	const stderr = checked.stderr.trim().slice(0, BASH_PREDICATE_STDERR_MAX_CHARS);
	return {
		kind: "syntax-error",
		reason: `invalid bash predicate (bash -n exit ${checked.code ?? "?"}): ${stderr || "no further detail"}`,
	};
}

// ------------------------------------------------------------------ run + exit mapping

function capHead(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function withStderr(base: string, stderr: string): string {
	const capped = capHead(stderr, BASH_PREDICATE_STDERR_MAX_CHARS);
	return capped ? `${base} stderr: ${capped}` : base;
}

/**
 * Start one bash evaluation: `bash -c <predicate>` with the snapshot JSON on stdin.
 * Returns immediately with a handle — `done` resolves to the mapped outcome (0→fired with
 * the trimmed head-capped stdout, empty→true; 1→idle; ≥2/signal/timeout/spawn→error).
 * NEVER throws and NEVER rejects: spawn failures, EPIPEs and kills all map to outcomes.
 */
export function startBashPredicate(predicate: string, snapshotJson: string, opts: BashRunOptions = {}): BashHandle {
	const timeoutMs = opts.timeoutMs ?? BASH_PREDICATE_TIMEOUT_MS;
	const graceMs = opts.graceMs ?? BASH_PREDICATE_GRACE_MS;
	const started = startRun(["-c", predicate], snapshotJson, opts);
	const done: Promise<BashPredicateOutcome> = started.result.then((result) => {
		if (result.spawnError) return { kind: "error", reason: bashUnavailableReason(result.spawnError) };
		if (result.timedOut) {
			return {
				kind: "error",
				reason: withStderr(
					`bash predicate timed out after ${timeoutMs} ms — killed (SIGTERM, then SIGKILL after ${graceMs} ms).`,
					result.stderr,
				),
			};
		}
		if (result.signal) {
			return {
				kind: "error",
				reason: withStderr(
					`bash predicate died on signal ${result.signal} — killed externally (monitor expiry, shutdown, cancel or abort).`,
					result.stderr,
				),
			};
		}
		if (result.code === 0) {
			const value = capHead(result.stdout, BASH_PREDICATE_VALUE_MAX_CHARS);
			return { kind: "fired", value: value === "" ? true : value };
		}
		if (result.code === 1) return { kind: "idle" };
		return {
			kind: "error",
			reason: withStderr(`bash predicate exited ${result.code ?? "?"} (0 fires, 1 is idle).`, result.stderr),
		};
	});
	return { done, kill: started.kill, pid: started.child?.pid, child: started.child };
}

// ------------------------------------------------------------------ snapshot serialization (M5)

/** Stringify the per-drain snapshot ONCE for all bash children; a failure is a typed error
 * so the caller error+disarms instead of throwing. */
export function serializeBashSnapshot(snapshot: unknown): { readonly kind: "ok"; readonly json: string } | { readonly kind: "error"; readonly reason: string } {
	try {
		const json = JSON.stringify(snapshot);
		if (typeof json !== "string") return { kind: "error", reason: "monitor snapshot serialized to a non-string — disarmed" };
		return { kind: "ok", json };
	} catch (err) {
		return {
			kind: "error",
			reason: `monitor snapshot could not be serialized for the bash predicate (${err instanceof Error ? err.message : String(err)}) — disarmed`,
		};
	}
}
