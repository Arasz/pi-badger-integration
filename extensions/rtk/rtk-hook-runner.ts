/**
 * Fail-open wrapper around `rtk hook claude`: pipes a JSON payload to stdin and returns stdout.
 * Never rejects; timeout, abort and an oversized reply kill the child (SIGTERM, then SIGKILL).
 * Children still running when this process exits are SIGKILLed.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Timeout for bodies of {@link LARGE_BODY_CHARS} or more (the slow summarising route can fire). */
export const POSTHOOK_TIMEOUT_MS = 20_000;
/** Timeout for smaller bodies. */
export const POSTHOOK_FAST_TIMEOUT_MS = 3_000;
const LARGE_BODY_CHARS = 20_000;
const POST_KILL_SETTLE_MS = 100;
const MIN_OUTPUT_CAP_BYTES = 64 * 1024;

export type HookResult = { stdout: string; code: number; killed: boolean };

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type HookOptions = {
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	graceMs?: number;
	spawnFn?: SpawnFn;
	command?: string;
	args?: string[];
};

const live = new Set<ChildProcess>();

/** Sends `sig` to the child's process group (it leads its own on POSIX), falling back to the child alone. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
		else child.kill(sig);
	} catch {
		try {
			child.kill(sig);
		} catch {}
	}
}

/** Number of hook children spawned and not yet settled. */
export function liveCount(): number {
	return live.size;
}

/** SIGKILLs every live hook child group; runs on process exit. */
export function killAllForExit(): void {
	for (const child of live) signalGroup(child, "SIGKILL");
}

process.once("exit", killAllForExit);

/** Timeout to use for a tool result body of the given length. */
export function timeoutFor(bodyChars: number): number {
	return bodyChars >= LARGE_BODY_CHARS ? POSTHOOK_TIMEOUT_MS : POSTHOOK_FAST_TIMEOUT_MS;
}

/** Runs the hook with `payload` on stdin; resolves `{code: -1}` when the process cannot be spawned. */
export function runHook(payload: unknown, opts: HookOptions): Promise<HookResult> {
	const { cwd, timeoutMs, signal, env, graceMs = 500, spawnFn = nodeSpawn as SpawnFn, command = "rtk", args = ["hook", "claude"] } = opts;
	return new Promise<HookResult>((resolve) => {
		const input = JSON.stringify(payload);
		const cap = Math.max(MIN_OUTPUT_CAP_BYTES, 2 * Buffer.byteLength(input));
		const chunks: Buffer[] = [];
		let size = 0;
		let killed = false;
		let settled = false;
		let termTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess | undefined;

		const settle = (code: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(termTimer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", kill);
			if (child) live.delete(child);
			resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code, killed });
		};

		function kill(): void {
			if (killed || settled || !child) return;
			killed = true;
			signalGroup(child, "SIGTERM");
			killTimer = setTimeout(() => {
				if (child) signalGroup(child, "SIGKILL");
				setTimeout(() => settle(-1), POST_KILL_SETTLE_MS).unref();
			}, graceMs);
		}

		try {
			child = spawnFn(command, args, { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			settle(-1);
			return;
		}
		const proc = child;
		live.add(proc);
		proc.on("error", () => settle(-1));
		proc.on("close", (code) => settle(code ?? -1));
		proc.stdout?.on("data", (chunk: Buffer) => {
			if (killed) return;
			chunks.push(chunk);
			size += chunk.length;
			if (size > cap) kill();
		});
		proc.stdin?.on("error", () => {});
		try {
			proc.stdin?.end(input);
		} catch {}

		termTimer = setTimeout(kill, timeoutMs);
		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
	});
}
