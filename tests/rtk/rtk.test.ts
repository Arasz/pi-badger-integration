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
import { formatStatus } from "../../extensions/rtk/rtk-status.ts";
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
		await createRtkExtension({ runHook: hook.runHook as never, env: opts.env ?? {}, now: () => 0, readProxyUsage: () => undefined, proxyDb: "" })(pi);
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

const PROXY_URL = "http://127.0.0.1:8080";
const STOCK_URL = "https://api.anthropic.com";
const gainJson = (input: number, saved: number) =>
	JSON.stringify({ summary: { total_commands: 4, total_input: input, total_saved: saved, total_output: input - saved } });

/** Lets fire-and-forget refreshes settle: fake execs resolve on microtasks. */
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

type StatusOpts = {
	version?: () => ExecResult | Promise<ExecResult>;
	gain?: () => ExecResult | Promise<ExecResult>;
	status?: () => ExecResult | Promise<ExecResult>;
	usage?: () => { pct: number | undefined } | undefined;
	env?: Record<string, string | undefined>;
	hook?: (call: HookCall) => HookReply | Promise<HookReply>;
};

async function statusSetup(opts: StatusOpts = {}) {
	const { pi, fake, calls } = piWithExec((call) => {
		if (call.args[0] === "--version") return opts.version ? opts.version() : ok("rtk 1.0.1\n");
		if (call.args[0] === "gain") return opts.gain ? opts.gain() : ok(gainJson(1000, 750));
		if (call.args[0] === "llm-proxy") return opts.status ? opts.status() : ok("running at 127.0.0.1:8080\n");
		return ok("", 1);
	});
	const usageCalls: Array<[string, string]> = [];
	const hook = fakeRunHook(opts.hook ?? (() => hookReply({ mode: "content", content: "3 matches" })));
	const clock = (fake as unknown as { clock: { now: number; advance(ms: number): void } }).clock;
	await createRtkExtension({
		runHook: hook.runHook as never,
		env: opts.env ?? {},
		now: () => clock.now,
		readProxyUsage: (db: string, project: string) => {
			usageCalls.push([db, project]);
			return opts.usage ? opts.usage() : { pct: 40 };
		},
		proxyDb: "/db/rtk-proxy.db",
	})(pi);
	const statuses: Array<[string, string]> = [];
	const ctx: Record<string, any> = {
		...sessionCtx(),
		model: { provider: "anthropic", id: "claude", baseUrl: STOCK_URL },
		ui: { setStatus: (key: string, text: string) => statuses.push([key, text]) },
	};
	const gainCalls = () => calls.filter((c) => c.args[0] === "gain");
	const statusCalls = () => calls.filter((c) => c.args[0] === "llm-proxy");
	return { fake, calls, ctx, statuses, usageCalls, clock, gainCalls, statusCalls, hook };
}

describe("rtk footer status", () => {
	test("session_start sets one status from project gain, proxy state, proxy pct and the post counter", async () => {
		const s = await statusSetup({ hook: (call) => (call.payload.tool_input.pattern === "a" ? hookReply({ mode: "content", content: "x" }) : { stdout: "", code: 1, killed: false }) });
		s.ctx.model.baseUrl = PROXY_URL;
		await fire(s.fake as never, "tool_result", resultEvent("grep", { pattern: "a" }, bigText(2_000)), s.ctx);
		await fire(s.fake as never, "tool_result", resultEvent("grep", { pattern: "b" }, bigText(2_000)), s.ctx);
		await fire(s.fake as never, "session_start", { type: "session_start" }, s.ctx);
		await flush();

		expect(s.statuses).toEqual([["rtk", formatStatus({ proxy: "routed", cmdPct: 75, proxyPct: 40, post: { compressed: 1, sent: 2 } })]]);
		expect(s.statuses[0][1]).toBe("rtk ⇄proxy · cmd 75% · proxy 40% · post 1/2");
		const [gain] = s.gainCalls();
		expect(gain.args).toEqual(["gain", "-p", "-f", "json"]);
		expect(gain.options?.cwd).toBe("/work/proj");
		expect(gain.options?.timeout).toBe(2_000);
		expect(s.statusCalls()[0].args).toEqual(["llm-proxy", "status"]);
		expect(s.usageCalls).toEqual([["/db/rtk-proxy.db", "/work/proj"]]);
	});

	const states: Array<[string, string, boolean, "routed" | "routed-down" | "up" | "off"]> = [
		["routed and up", PROXY_URL, true, "routed"],
		["routed but down", PROXY_URL, false, "routed-down"],
		["direct and up", "https://gateway.example.com", true, "up"],
		["direct and down", STOCK_URL, false, "off"],
	];
	for (const [name, baseUrl, up, proxy] of states) {
		test(`proxy state: ${name} -> ${proxy}`, async () => {
			const s = await statusSetup({ status: () => (up ? ok("running at 127.0.0.1:8080\n") : ok("not running\n", 1)), env: { RTK_PI_PROXY: "0" } });
			s.ctx.model.baseUrl = baseUrl;
			await fire(s.fake as never, "session_start", { type: "session_start" }, s.ctx);
			await flush();
			expect(s.statuses).toEqual([["rtk", formatStatus({ proxy, cmdPct: 75, proxyPct: 40, post: { compressed: 0, sent: 0 } })]]);
		});
	}

	test("turn_end refreshes at most once per 10 s; model_select refreshes at once with the new baseUrl", async () => {
		const s = await statusSetup({ status: () => ok("running at 127.0.0.1:8080\n"), env: { RTK_PI_PROXY: "0" } });
		await fire(s.fake as never, "turn_end", { type: "turn_end" }, s.ctx);
		await fire(s.fake as never, "turn_end", { type: "turn_end" }, s.ctx);
		await flush();
		expect(s.gainCalls().length).toBe(1);

		s.clock.advance(10_001);
		await fire(s.fake as never, "turn_end", { type: "turn_end" }, s.ctx);
		await flush();
		expect(s.gainCalls().length).toBe(2);

		s.ctx.model = { provider: "anthropic", id: "claude", baseUrl: PROXY_URL };
		await fire(s.fake as never, "model_select", { type: "model_select", model: s.ctx.model, source: "set" }, s.ctx);
		await flush();
		expect(s.gainCalls().length).toBe(3);
		expect(s.statuses.at(-1)).toEqual(["rtk", formatStatus({ proxy: "routed", cmdPct: 75, proxyPct: 40, post: { compressed: 0, sent: 0 } })]);
	});

	test("tool results never trigger a refresh", async () => {
		const s = await statusSetup();
		await fire(s.fake as never, "tool_result", resultEvent("grep", { pattern: "a" }, bigText(2_000)), s.ctx);
		await flush();
		expect(s.gainCalls()).toEqual([]);
		expect(s.statuses).toEqual([]);
	});

	const broken: Array<[string, (version: string) => ExecResult]> = [
		["missing", () => ({ stdout: "", stderr: "ENOENT", code: 1, killed: false })],
		["too old", () => ok("rtk 0.22.0\n")],
	];
	for (const [kind, versionReply] of broken) {
		for (const order of ["probe first", "session first"] as const) {
			test(`a ${kind} rtk shows only the disabled reason and runs no gain/status (${order})`, async () => {
				let release: (r: ExecResult) => void = () => {};
				const probe = new Promise<ExecResult>((r) => (release = r));
				const s = await statusSetup({ version: () => probe });
				if (order === "probe first") {
					release(versionReply(""));
					await flush();
					await fire(s.fake as never, "session_start", { type: "session_start" }, s.ctx);
				} else {
					await fire(s.fake as never, "session_start", { type: "session_start" }, s.ctx);
					release(versionReply(""));
				}
				await flush();
				await fire(s.fake as never, "turn_end", { type: "turn_end" }, s.ctx);
				await fire(s.fake as never, "model_select", { type: "model_select", model: s.ctx.model, source: "set" }, s.ctx);
				await flush();

				const reason = kind === "missing" ? "rtk binary not found in PATH" : "rtk 0.22.0 is too old (need >= 0.23.0)";
				expect(s.statuses).toEqual([["rtk", `RTK disabled: ${reason}`]]);
				expect(s.gainCalls()).toEqual([]);
				expect(s.statusCalls()).toEqual([]);
				expect(s.usageCalls).toEqual([]);
			});
		}
	}

	const failing: Array<[string, StatusOpts, Parameters<typeof formatStatus>[0]]> = [
		["gain throws", { gain: () => Promise.reject(new Error("x")) }, { proxy: "off", proxyPct: 40 }],
		["gain prints garbage", { gain: () => ok("nope") }, { proxy: "off", proxyPct: 40 }],
		["status throws", { status: () => Promise.reject(new Error("x")) }, { proxy: "off", cmdPct: 75, proxyPct: 40 }],
		["the db read throws", { usage: () => { throw new Error("locked"); } }, { proxy: "off", cmdPct: 75 }],
		["the db read is empty", { usage: () => undefined }, { proxy: "off", cmdPct: 75 }],
	];
	for (const [name, opts, expected] of failing) {
		test(`when ${name} only that segment drops`, async () => {
			const s = await statusSetup({ status: () => ok("not running\n", 1), ...opts, env: { RTK_PI_PROXY: "0" } });
			await fire(s.fake as never, "session_start", { type: "session_start" }, s.ctx);
			await flush();
			expect(s.statuses).toEqual([["rtk", formatStatus({ ...expected, post: { compressed: 0, sent: 0 } })]]);
		});
	}

	test("a missing ui, a missing model or a throwing setStatus never throws", async () => {
		const s = await statusSetup();
		const bare = { cwd: "/work/proj", signal };
		await expect(fire(s.fake as never, "session_start", { type: "session_start" }, bare)).resolves.toBeDefined();
		await expect(
			fire(s.fake as never, "model_select", { type: "model_select" }, { ...bare, ui: { setStatus: () => { throw new Error("tui gone"); } } }),
		).resolves.toBeDefined();
		await flush();
		expect(s.gainCalls().length).toBe(2);
	});
});

/** statusSetup plus provider stubs that act like pi: registering refreshes ctx.model.baseUrl, unregistering restores it. */
async function proxySetup(opts: StatusOpts & { registerThrows?: boolean; model?: Record<string, any> } = {}) {
	const s = await statusSetup(opts);
	if (opts.model) s.ctx.model = { ...opts.model };
	const registered: Array<[string, Record<string, unknown>]> = [];
	const unregistered: string[] = [];
	const original = s.ctx.model?.baseUrl;
	Object.assign(s.fake as object, {
		registerProvider: (name: string, config: Record<string, unknown>) => {
			registered.push([name, config]);
			if (opts.registerThrows) throw new Error("bad provider config");
			if (s.ctx.model?.provider === name) s.ctx.model.baseUrl = config.baseUrl;
		},
		unregisterProvider: (name: string) => {
			unregistered.push(name);
			if (s.ctx.model?.provider === name) s.ctx.model.baseUrl = original;
		},
	});
	const start = async () => {
		await fire(s.fake as never, "session_start", { type: "session_start" }, s.ctx);
		await flush();
	};
	const headers = async (initial: Record<string, string> = { "x-api-key": "k" }) => {
		const event = { type: "before_provider_headers", headers: initial };
		const results = await fire(s.fake as never, "before_provider_headers", event, s.ctx);
		return { event, results };
	};
	return { ...s, registered, unregistered, start, headers };
}

const status0 = { post: { compressed: 0, sent: 0 }, cmdPct: 75, proxyPct: 40 };
const down = () => ok("not running\n", 1);

describe("rtk proxy routing", () => {
	test("RTK_PI_PROXY=0 never registers and never touches headers", async () => {
		const p = await proxySetup({ env: { RTK_PI_PROXY: "0" } });
		await p.start();
		expect(p.registered).toEqual([]);
		p.ctx.model.baseUrl = PROXY_URL;
		const { event } = await p.headers();
		expect(event.headers).toEqual({ "x-api-key": "k" });
	});

	test("proxy up + stock anthropic registers exactly {baseUrl}, once, and the footer shows routed", async () => {
		const p = await proxySetup();
		await p.start();
		expect(p.registered).toEqual([["anthropic", { baseUrl: PROXY_URL }]]);
		expect(Object.keys(p.registered[0][1])).toEqual(["baseUrl"]);
		expect(p.statuses).toEqual([["rtk", formatStatus({ proxy: "routed", ...status0 })]]);

		await fire(p.fake as never, "model_select", { type: "model_select" }, p.ctx);
		await flush();
		expect(p.registered.length).toBe(1);
	});

	test("RTK_PROXY_BIND moves the registered baseUrl", async () => {
		const p = await proxySetup({ env: { RTK_PROXY_BIND: "127.0.0.1:9999" }, status: () => ok("running at 127.0.0.1:9999\n") });
		await p.start();
		expect(p.registered).toEqual([["anthropic", { baseUrl: "http://127.0.0.1:9999" }]]);
		expect(p.statuses.at(-1)?.[1]).toBe(formatStatus({ proxy: "routed", ...status0 }));
	});

	const never: Array<[string, Parameters<typeof proxySetup>[0]]> = [
		["the proxy is down", { status: down }],
		["the version probe throws", { version: () => Promise.reject(new Error("spawn")) }],
		["RTK_DISABLED=1", { env: { RTK_DISABLED: "1" } }],
		["the model is not anthropic", { model: { provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1" } }],
		["another provider uses api.anthropic.com", { model: { provider: "team-claude", id: "claude", baseUrl: STOCK_URL } }],
		["the anthropic baseUrl is a custom gateway", { model: { provider: "anthropic", id: "claude", baseUrl: "https://gateway.corp.example/anthropic" } }],
		["there is no model", { model: undefined }],
	];
	for (const [name, opts] of never) {
		test(`no registration when ${name}`, async () => {
			const p = await proxySetup(opts);
			if (opts && "model" in opts && opts.model === undefined) p.ctx.model = undefined;
			await p.start();
			expect(p.registered).toEqual([]);
		});
	}

	test("a fresh extension instance registers again", async () => {
		const a = await proxySetup();
		await a.start();
		const b = await proxySetup();
		await b.start();
		expect(a.registered.length).toBe(1);
		expect(b.registered.length).toBe(1);
	});

	test("a throwing registerProvider leaves the session working", async () => {
		const p = await proxySetup({ registerThrows: true });
		await p.start();
		expect(p.registered.length).toBe(1);
		expect(p.statuses).toEqual([["rtk", formatStatus({ proxy: "up", ...status0 })]]);
		const call = bashEvent("git status");
		await expect(fire(p.fake as never, "tool_call", call, { signal })).resolves.toEqual([undefined]);
	});

	test("headers are added in place only while the anthropic model points at the proxy", async () => {
		const p = await proxySetup();
		const direct = await p.headers();
		expect(direct.event.headers).toEqual({ "x-api-key": "k" });

		await p.start();
		const initial: Record<string, string> = { "x-api-key": "k" };
		const routed = await p.headers(initial);
		expect(routed.results).toEqual([undefined]);
		expect(routed.event.headers).toBe(initial);
		expect(initial).toEqual({ "x-api-key": "k", "x-rtk-project": "/work/proj", "x-rtk-session": "sess-1" });

		p.ctx.model = { provider: "openai", id: "gpt", baseUrl: PROXY_URL };
		await fire(p.fake as never, "model_select", { type: "model_select" }, p.ctx);
		await flush();
		expect((await p.headers()).event.headers).toEqual({ "x-api-key": "k" });
	});

	for (const cwd of ["/tmp/łódź", "/Users/a/项目"]) {
		test(`a routed request from a non-ASCII cwd (${cwd}) leaves the headers unchanged and sendable`, async () => {
			const p = await proxySetup();
			await p.start();
			p.ctx.cwd = cwd;
			delete p.ctx.sessionManager;
			const { event } = await p.headers();
			expect(event.headers).toEqual({ "x-api-key": "k" });
			expect(() => new Headers(event.headers)).not.toThrow();
		});
	}

	test("a header handler with a broken ctx never throws", async () => {
		const p = await proxySetup();
		const event = { type: "before_provider_headers", headers: { a: "b" } };
		const ctx = { cwd: "/w", model: { provider: "anthropic", baseUrl: PROXY_URL }, sessionManager: { getSessionId: () => { throw new Error("x"); } } };
		await expect(fire(p.fake as never, "before_provider_headers", event, ctx)).resolves.toEqual([undefined]);
	});

	test("a refresh that finds the proxy down unregisters once and the footer shows proxy off", async () => {
		let up = true;
		const p = await proxySetup({ status: () => (up ? ok("running at 127.0.0.1:8080\n") : down()) });
		await p.start();
		expect(p.registered.length).toBe(1);

		up = false;
		p.clock.advance(10_001);
		await fire(p.fake as never, "turn_end", { type: "turn_end" }, p.ctx);
		await flush();
		expect(p.unregistered).toEqual(["anthropic"]);
		expect(p.statuses.at(-1)).toEqual(["rtk", formatStatus({ proxy: "off", ...status0 })]);

		await fire(p.fake as never, "model_select", { type: "model_select" }, p.ctx);
		await flush();
		expect(p.unregistered).toEqual(["anthropic"]);
	});
});
