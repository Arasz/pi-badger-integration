/** Pure decisions for the rtk extension; index.ts does the I/O. */

export const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED = [0, 23, 0] as const;

export type ExecOutcome = { stdout: string; code: number; killed: boolean };

export type RewriteDecision =
	| { kind: "pass" }
	| { kind: "rewrite"; command: string }
	| { kind: "block"; reason: string };

/** Maps one `rtk rewrite` run to an action, per the exit codes `rtk rewrite --help` documents:
 * 0/3 + stdout rewrite, 1 pass, 2 + message block (2 without one defers), anything else pass. */
export function decideRewrite(original: string, result: ExecOutcome): RewriteDecision {
	if (result.killed) return { kind: "pass" };
	const out = result.stdout.trim();
	if (result.code === 2) return out ? { kind: "block", reason: out } : { kind: "pass" };
	if (result.code !== 0 && result.code !== 3) return { kind: "pass" };
	if (!out || out === original) return { kind: "pass" };
	return { kind: "rewrite", command: out };
}

/** Why `rtk --version` output rules the binary out, or undefined when it is usable.
 * Unparseable output fails open: a broken rewrite later just passes commands through. */
export function versionProblem(versionOutput: string): string | undefined {
	const m = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return undefined;
	const version = [Number(m[1]), Number(m[2]), Number(m[3])];
	for (let i = 0; i < 3; i++) {
		if (version[i] > MIN_SUPPORTED[i]) return undefined;
		if (version[i] < MIN_SUPPORTED[i]) return `rtk ${version.join(".")} is too old (need >= ${MIN_SUPPORTED.join(".")})`;
	}
	return undefined;
}

/** True when a bash command should be offered to `rtk rewrite`. */
export function isRewriteCandidate(command: unknown, env: Record<string, string | undefined>): command is string {
	if (typeof command !== "string") return false;
	const trimmed = command.trimStart();
	if (trimmed === "") return false;
	if (trimmed === "rtk" || trimmed.startsWith("rtk ")) return false;
	return env.RTK_DISABLED !== "1";
}
