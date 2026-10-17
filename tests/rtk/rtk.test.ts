/**
 * rtk extension tests: bash commands are rewritten through `rtk rewrite`, the exit-code
 * contract of that binary decides rewrite / pass / block, and every failure path passes the
 * command through untouched (a throwing tool_call handler would block the tool in pi).
 */

import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension from "../../extensions/rtk/index.ts";
import { decideRewrite, isRewriteCandidate, versionProblem } from "../../extensions/rtk/rtk-core.ts";

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type ExecCall = { command: string; args: string[]; options: Record<string, unknown> | undefined };

const ok = (stdout: string, code = 0): ExecResult => ({ stdout, stderr: "", code, killed: false });

function piWithExec(respond: (call: ExecCall) => ExecResult | Promise<ExecResult>) {
	const pi = createFakePi() as unknown as Record<string, unknown> & { handlers: Map<string, unknown[]> };
	const calls: ExecCall[] = [];
	pi.exec = async (command: string, args: string[], options?: Record<string, unknown>) => {
		const call = { command, args, options };
		calls.push(call);
		return respond(call);
	};
	return { pi: pi as unknown as Parameters<typeof makeExtension>[0], fake: pi, calls };
}

const rewriteCalls = (calls: ExecCall[]) => calls.filter((c) => c.args[0] === "rewrite");

function bashEvent(command: unknown) {
	return { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } };
}

const signal = new AbortController().signal;

describe("decideRewrite: the `rtk rewrite` exit-code contract", () => {
	test("exit 0 with a different command rewrites", () => {
		expect(decideRewrite("git status", ok("rtk git status\n"))).toEqual({ kind: "rewrite", command: "rtk git status" });
	});
	test("exit 3 (ask / no rule) is still a rewrite", () => {
		expect(decideRewrite("git status", ok("rtk git status", 3))).toEqual({ kind: "rewrite", command: "rtk git status" });
	});
	test("a rewrite equal to the original passes through", () => {
		expect(decideRewrite("rtk git status", ok("rtk git status", 3))).toEqual({ kind: "pass" });
	});
	test("exit 0 with empty stdout passes through", () => {
		expect(decideRewrite("git status", ok("  \n"))).toEqual({ kind: "pass" });
	});
	test("exit 1 (no RTK equivalent) passes through", () => {
		expect(decideRewrite("echo hi", ok("", 1))).toEqual({ kind: "pass" });
	});
	test("exit 2 with a message blocks with that message", () => {
		expect(decideRewrite("cat secrets", ok("use the vault reader instead\n", 2))).toEqual({
			kind: "block",
			reason: "use the vault reader instead",
		});
	});
	test("exit 2 with no message defers (passes through)", () => {
		expect(decideRewrite("rm -rf x", ok("", 2))).toEqual({ kind: "pass" });
	});
	test("a killed (timed-out) rewrite passes through even with stdout", () => {
		expect(decideRewrite("git status", { stdout: "rtk git status", code: 0, killed: true })).toEqual({
			kind: "pass",
		});
	});
	test("an unknown exit code passes through", () => {
		expect(decideRewrite("git status", ok("rtk git status", 101))).toEqual({ kind: "pass" });
	});
});

describe("versionProblem: rtk >= 0.23.0 required", () => {
	test("0.22.9 is too old", () => {
		expect(versionProblem("rtk 0.22.9")).toContain("too old");
	});
	test("0.23.0 is supported", () => {
		expect(versionProblem("rtk 0.23.0")).toBeUndefined();
	});
	test("1.0.1 is supported (major above 0)", () => {
		expect(versionProblem("rtk 1.0.1\n")).toBeUndefined();
	});
	test("unparseable output fails open", () => {
		expect(versionProblem("rtk dev-build")).toBeUndefined();
	});
});

describe("isRewriteCandidate", () => {
	test("a plain command is a candidate", () => {
		expect(isRewriteCandidate("git status", {})).toBe(true);
	});
	test("non-strings and blank commands are not", () => {
		expect(isRewriteCandidate(undefined, {})).toBe(false);
		expect(isRewriteCandidate("   ", {})).toBe(false);
	});
	test("commands already in rtk form are not, leading whitespace included", () => {
		expect(isRewriteCandidate("rtk git status", {})).toBe(false);
		expect(isRewriteCandidate("  rtk git status", {})).toBe(false);
		expect(isRewriteCandidate("rtk", {})).toBe(false);
	});
	test("a command merely starting with the letters rtk is a candidate", () => {
		expect(isRewriteCandidate("rtkfoo --x", {})).toBe(true);
	});
	test("RTK_DISABLED=1 turns rewriting off", () => {
		expect(isRewriteCandidate("git status", { RTK_DISABLED: "1" })).toBe(false);
	});
});

describe("rtk extension wiring", () => {
	const healthy = (call: ExecCall) =>
		call.args[0] === "--version" ? ok("rtk 1.0.1\n") : call.args[1] === "git status" ? ok("rtk git status", 3) : ok("", 1);

	test("load does not wait on the version probe", async () => {
		let release: (r: ExecResult) => void = () => {};
		const { pi } = piWithExec((call) =>
			call.args[0] === "--version" ? new Promise<ExecResult>((r) => (release = r)) : ok("", 1),
		);
		const loaded = await Promise.race([
			Promise.resolve(makeExtension(pi)).then(() => "loaded"),
			new Promise((r) => setTimeout(() => r("blocked"), 50)),
		]);
		release(ok("rtk 1.0.1"));
		expect(loaded).toBe("loaded");
	});

	test("a bash command is rewritten in place through `rtk rewrite` with timeout and signal", async () => {
		const { pi, fake, calls } = piWithExec(healthy);
		await makeExtension(pi);
		const event = bashEvent("git status");
		const results = await fire(fake as never, "tool_call", event, { signal });

		expect(event.input.command).toBe("rtk git status");
		expect(results).toEqual([undefined]);
		const [call] = rewriteCalls(calls);
		expect(call.command).toBe("rtk");
		expect(call.args).toEqual(["rewrite", "git status"]);
		expect(call.options?.timeout).toBe(2_000);
		expect(call.options?.signal).toBe(signal);
	});

	test("a command with no RTK equivalent is left unchanged", async () => {
		const { pi, fake } = piWithExec(healthy);
		await makeExtension(pi);
		const event = bashEvent("echo hi");
		await fire(fake as never, "tool_call", event, { signal });
		expect(event.input.command).toBe("echo hi");
	});

	test("non-bash tool calls never reach rtk", async () => {
		const { pi, fake, calls } = piWithExec(healthy);
		await makeExtension(pi);
		await fire(fake as never, "tool_call", { type: "tool_call", toolCallId: "t", toolName: "read", input: { path: "x" } }, {});
		expect(rewriteCalls(calls)).toEqual([]);
	});

	test("an rtk pipeline denial with a message blocks the call", async () => {
		const { pi, fake } = piWithExec((call) =>
			call.args[0] === "--version" ? ok("rtk 1.0.1") : ok("routed: use rtk read instead", 2),
		);
		await makeExtension(pi);
		const event = bashEvent("cat big.log");
		const results = await fire(fake as never, "tool_call", event, { signal });
		expect(results).toEqual([{ block: true, reason: "routed: use rtk read instead" }]);
		expect(event.input.command).toBe("cat big.log");
	});

	test("a throwing exec passes the command through instead of throwing", async () => {
		const { pi, fake } = piWithExec((call) => {
			if (call.args[0] === "--version") return ok("rtk 1.0.1");
			throw new Error("spawn failed");
		});
		await makeExtension(pi);
		const event = bashEvent("git status");
		const results = await fire(fake as never, "tool_call", event, { signal });
		expect(results).toEqual([undefined]);
		expect(event.input.command).toBe("git status");
	});

	for (const order of ["probe first", "session first"] as const) {
		test(`a missing rtk binary disables rewriting and sets a status (${order})`, async () => {
			let release: (r: ExecResult) => void = () => {};
			const probe = new Promise<ExecResult>((r) => (release = r));
			const { pi, fake, calls } = piWithExec((call) => (call.args[0] === "--version" ? probe : ok("rtk x", 0)));
			await makeExtension(pi);
			const statuses: Array<[string, string]> = [];
			const ctx = { ui: { setStatus: (key: string, text: string) => statuses.push([key, text]) } };

			if (order === "probe first") {
				release({ stdout: "", stderr: "ENOENT", code: 1, killed: false });
				await probe;
				await fire(fake as never, "session_start", { type: "session_start" }, ctx);
			} else {
				await fire(fake as never, "session_start", { type: "session_start" }, ctx);
				release({ stdout: "", stderr: "ENOENT", code: 1, killed: false });
			}
			const event = bashEvent("git status");
			await fire(fake as never, "tool_call", event, { signal });

			expect(statuses).toEqual([["rtk", "RTK disabled: rtk binary not found in PATH"]]);
			expect(rewriteCalls(calls)).toEqual([]);
			expect(event.input.command).toBe("git status");
		});
	}

	test("a too-old rtk disables rewriting", async () => {
		const { pi, fake, calls } = piWithExec((call) => (call.args[0] === "--version" ? ok("rtk 0.22.0") : ok("rtk git status")));
		await makeExtension(pi);
		const event = bashEvent("git status");
		await fire(fake as never, "tool_call", event, { signal });
		expect(rewriteCalls(calls)).toEqual([]);
		expect(event.input.command).toBe("git status");
	});
});
