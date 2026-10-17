/**
 * rtk extension tests: bash commands are rewritten through `rtk rewrite`, the exit-code
 * contract of that binary decides rewrite / pass / block, and every failure path passes the
 * command through untouched (a throwing tool_call handler would block the tool in pi).
 */

import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, { createRtkExtension } from "../../extensions/rtk/index.ts";
import { timeoutFor } from "../../extensions/rtk/rtk-hook-runner.ts";
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
				await new Promise((r) => setTimeout(r, 0)); // let the probe's .then record the reason first
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

type HookCall = { payload: Record<string, any>; opts: Record<string, any> };
type HookReply = { stdout: string; code: number; killed: boolean };

/** Fake `runHook` that records each call and answers with `reply` (a throw is honoured). */
function fakeRunHook(reply: (call: HookCall) => HookReply | Promise<HookReply>) {
	const calls: HookCall[] = [];
	const runHook = async (payload: unknown, opts: unknown) => {
		const call = { payload: payload as Record<string, any>, opts: opts as Record<string, any> };
		calls.push(call);
		return reply(call);
	};
	return { runHook, calls };
}

const hookReply = (updatedToolOutput: unknown): HookReply => ({
	stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } }),
	code: 0,
	killed: false,
});

function resultEvent(toolName: string, input: Record<string, unknown>, text: string, extra: Record<string, unknown> = {}) {
	return { type: "tool_result", toolCallId: "t1", toolName, input, content: [{ type: "text", text }], isError: false, details: undefined, ...extra };
}

/** pi's tool_result merge (extensions/runner.js emitToolResult): content without structuredContent drops it. */
function applyPiMerge(event: Record<string, any>, result: Record<string, any> | undefined) {
	const current = { ...event };
	if (!result) return current;
	if (result.content !== undefined) {
		current.content = result.content;
		if (result.structuredContent === undefined) delete current.structuredContent;
	}
	if (result.details !== undefined) current.details = result.details;
	if (result.structuredContent !== undefined) current.structuredContent = result.structuredContent;
	return current;
}

const sessionCtx = (extra: Record<string, unknown> = {}) => ({
	cwd: "/work/proj",
	signal,
	sessionManager: { getSessionId: () => "sess-1" },
	...extra,
});

const bigText = (n: number) => "line of output\n".repeat(Math.ceil(n / 15)).slice(0, n);

describe("rtk after-tool pipeline wiring", () => {
	const healthy = (call: ExecCall) =>
		call.args[0] === "--version" ? ok("rtk 1.0.1\n") : call.args[1] === "git log" ? ok("rtk git log", 3) : ok("", 1);

	async function setup(
		reply: (call: HookCall) => HookReply | Promise<HookReply>,
		opts: { env?: Record<string, string | undefined>; exec?: (call: ExecCall) => ExecResult | Promise<ExecResult> } = {},
	) {
		const { pi, fake, calls: execCalls } = piWithExec(opts.exec ?? healthy);
		const hook = fakeRunHook(reply);
		await createRtkExtension({ runHook: hook.runHook as never, env: opts.env ?? {} })(pi);
		return { fake, execCalls, hook };
	}

	test("a large bash result is replaced; the runner sees the rewritten command, cwd, signal and session", async () => {
		const { fake, hook } = await setup(() => hookReply({ stdout: "compressed log", stderr: "", interrupted: false }));
		const call = bashEvent("git log");
		await fire(fake as never, "tool_call", call, { signal });
		expect(call.input.command).toBe("rtk git log");

		const body = bigText(25_000);
		const event = resultEvent("bash", call.input, `${body}\n\nCommand exited with code 1`);
		const [result] = await fire(fake as never, "tool_result", event, sessionCtx());

		expect(result).toMatchObject({ content: [{ type: "text", text: "compressed log\n\nCommand exited with code 1" }] });
		const [h] = hook.calls;
		expect(h.payload.tool_name).toBe("Bash");
		expect(h.payload.tool_input).toEqual({ command: "rtk git log" });
		expect(h.payload.session_id).toBe("sess-1");
		expect(h.payload.cwd).toBe("/work/proj");
		expect(h.opts.cwd).toBe("/work/proj");
		expect(h.opts.signal).toBe(signal);
		expect(h.opts.timeoutMs).toBe(timeoutFor(body.length));
	});

	test("a large grep result is replaced with the runner's output", async () => {
		const { fake, hook } = await setup(() => hookReply({ mode: "content", content: "3 matches" }));
		const event = resultEvent("grep", { pattern: "foo" }, bigText(2_000));
		const [result] = await fire(fake as never, "tool_result", event, sessionCtx());
		expect(result).toMatchObject({ content: [{ type: "text", text: "3 matches" }] });
		expect(hook.calls[0].payload.tool_input).toEqual({ pattern: "foo", path: "." });
		expect(hook.calls[0].opts.timeoutMs).toBe(timeoutFor(2_000));
	});

	const failures: Array<[string, (call: HookCall) => HookReply | Promise<HookReply>]> = [
		["throws", () => Promise.reject(new Error("boom"))],
		["is killed", () => ({ ...hookReply({ mode: "content", content: "x" }), killed: true })],
		["exits non-zero", () => ({ ...hookReply({ mode: "content", content: "x" }), code: 1 })],
		["prints garbage", () => ({ stdout: "not json{", code: 0, killed: false })],
	];
	for (const [name, reply] of failures) {
		test(`a runner that ${name} leaves the result untouched and the event unmutated`, async () => {
			const { fake, hook } = await setup(reply);
			const event = resultEvent("grep", { pattern: "foo" }, bigText(2_000));
			const before = structuredClone(event);
			const results = await fire(fake as never, "tool_result", event, sessionCtx());
			expect(hook.calls.length).toBe(1);
			expect(results).toEqual([undefined]);
			expect(event).toEqual(before);
		});
	}

	test("a successful replacement does not mutate the event", async () => {
		const { fake } = await setup(() => hookReply({ mode: "content", content: "3 matches" }));
		const event = resultEvent("grep", { pattern: "foo" }, bigText(2_000));
		const before = structuredClone(event);
		await fire(fake as never, "tool_result", event, sessionCtx());
		expect(event).toEqual(before);
	});

	test("structuredContent survives pi's merge of the replacement", async () => {
		const { fake } = await setup(() => hookReply({ content: [{ type: "text", text: "short" }] }));
		const structured = { rows: [1, 2, 3] };
		const event = resultEvent("mcp__db__query", { q: "select" }, bigText(2_000), { structuredContent: structured });
		const [result] = await fire(fake as never, "tool_result", event, sessionCtx());
		const merged = applyPiMerge(event, result as Record<string, any>);
		expect(merged.content).toEqual([{ type: "text", text: "short" }]);
		expect(merged.structuredContent).toEqual(structured);
	});

	test("RTK_DISABLED=1 never reaches the runner", async () => {
		const { fake, hook } = await setup(() => hookReply({ mode: "content", content: "x" }), { env: { RTK_DISABLED: "1" } });
		const results = await fire(fake as never, "tool_result", resultEvent("grep", { pattern: "foo" }, bigText(2_000)), sessionCtx());
		expect(results).toEqual([undefined]);
		expect(hook.calls).toEqual([]);
	});

	for (const order of ["probe first", "result first"] as const) {
		test(`a missing rtk binary never reaches the runner (${order})`, async () => {
			let release: (r: ExecResult) => void = () => {};
			const probe = new Promise<ExecResult>((r) => (release = r));
			const { fake, hook } = await setup(() => hookReply({ mode: "content", content: "x" }), {
				exec: (call) => (call.args[0] === "--version" ? probe : ok("", 1)),
			});
			const event = resultEvent("grep", { pattern: "foo" }, bigText(2_000));
			let results: unknown[];
			if (order === "probe first") {
				release({ stdout: "", stderr: "ENOENT", code: 1, killed: false });
				results = await fire(fake as never, "tool_result", event, sessionCtx());
			} else {
				const pending = fire(fake as never, "tool_result", event, sessionCtx());
				release({ stdout: "", stderr: "ENOENT", code: 1, killed: false });
				results = await pending;
			}
			expect(results).toEqual([undefined]);
			expect(hook.calls).toEqual([]);
		});
	}

	for (const toolName of ["find", "ls", "edit", "write"]) {
		test(`${toolName} results never reach the runner`, async () => {
			const { fake, hook } = await setup(() => hookReply({ content: "x" }));
			await fire(fake as never, "tool_result", resultEvent(toolName, { path: "src", pattern: "*" }, bigText(2_000)), sessionCtx());
			expect(hook.calls).toEqual([]);
		});
	}

	test("nested calls (parentToolCallId) never reach the runner", async () => {
		const { fake, hook } = await setup(() => hookReply({ mode: "content", content: "x" }));
		const event = resultEvent("grep", { pattern: "foo" }, bigText(2_000), { parentToolCallId: "p1" });
		await fire(fake as never, "tool_result", event, sessionCtx());
		expect(hook.calls).toEqual([]);
	});

	test("a ctx without sessionManager still runs the hook with an empty session id", async () => {
		const { fake, hook } = await setup(() => hookReply({ mode: "content", content: "x" }));
		await fire(fake as never, "tool_result", resultEvent("grep", { pattern: "foo" }, bigText(2_000)), { cwd: "/w", signal });
		expect(hook.calls[0].payload.session_id).toBe("");
	});
});
