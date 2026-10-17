/**
 * rtk posthook mapping tests: pi tool_result events become rtk's Claude-shaped PostToolUse
 * payload, and rtk's reply maps back to a tool_result patch. Both directions are pure; every
 * "cannot map" path returns undefined so the original result stays in place.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { fromHookOutput, MIN_POSTHOOK_CHARS, RTK_COMMAND_MIN_CHARS, toHookPayload } from "../../extensions/rtk/rtk-posthook.ts";

type Ev = Parameters<typeof toHookPayload>[0];

const CWD = "/work/proj";
const body = (n: number, ch = "x") => ch.repeat(n);
const text = (t: string) => ({ type: "text" as const, text: t });

function ev(over: Record<string, unknown>): Ev {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command: "git log" },
		content: [text(body(2000))],
		isError: false,
		...over,
	} as unknown as Ev;
}

const sent = (e: Ev, env: Record<string, string | undefined> = {}) => toHookPayload(e, CWD, env);

describe("toHookPayload: tool mapping (Claude shapes)", () => {
	test("bash maps to Bash with the rewritten command and a stdout-only response", () => {
		const r = sent(ev({ input: { command: "git log -5" } }), {});
		expect(r?.payload).toEqual({
			hook_event_name: "PostToolUse",
			session_id: "",
			tool_use_id: "call-1",
			cwd: CWD,
			tool_name: "Bash",
			tool_input: { command: "git log -5" },
			tool_response: { stdout: body(2000), stderr: "", interrupted: false },
		});
		expect(r?.trailer).toBe("");
		expect(r?.bodyChars).toBe(2000);
	});

	test("powershell maps to Bash too", () => {
		const r = sent(ev({ toolName: "powershell", input: { command: "Get-Content x" } }));
		expect(r?.payload.tool_name).toBe("Bash");
		expect(r?.payload.tool_input).toEqual({ command: "Get-Content x" });
	});

	test("multiple text blocks are joined with a newline", () => {
		const r = sent(ev({ input: { command: "git log" }, content: [text(body(300, "a")), text(body(300, "b"))] }));
		expect((r?.payload.tool_response as { stdout: string }).stdout).toBe(`${body(300, "a")}\n${body(300, "b")}`);
	});

	test("read maps to Read with an absolute path (relative is resolved against cwd)", () => {
		const r = sent(ev({ toolName: "read", input: { path: "src/a.ts" } }));
		expect(r?.payload.tool_name).toBe("Read");
		expect(r?.payload.tool_input).toEqual({ file_path: "/work/proj/src/a.ts" });
		expect(r?.payload.tool_response).toEqual({
			type: "text",
			file: { filePath: "/work/proj/src/a.ts", content: body(2000) },
		});
	});

	test("read strips a leading '@' like pi does, so rtk sees the real basename", () => {
		const r = sent(ev({ toolName: "read", input: { path: "@package-lock.json" } }));
		expect(r?.payload.tool_input).toEqual({ file_path: "/work/proj/package-lock.json" });
	});

	test("read expands a leading '~/' to the home directory", () => {
		const r = sent(ev({ toolName: "read", input: { path: "~/x.lock" } }));
		expect(r?.payload.tool_input).toEqual({ file_path: `${homedir()}/x.lock` });
	});

	test("read expands '~' after stripping '@', and leaves 'a~b' alone", () => {
		expect(sent(ev({ toolName: "read", input: { path: "@~/x.lock" } }))?.payload.tool_input).toEqual({ file_path: `${homedir()}/x.lock` });
		expect(sent(ev({ toolName: "read", input: { path: "~" } }))?.payload.tool_input).toEqual({ file_path: homedir() });
		expect(sent(ev({ toolName: "read", input: { path: "a~b" } }))?.payload.tool_input).toEqual({ file_path: "/work/proj/a~b" });
	});

	test("read expands '~' against an explicit home", () => {
		const r = toHookPayload(ev({ toolName: "read", input: { path: "~/a/b.lock" } }), CWD, {}, "/h");
		expect(r?.payload.tool_input).toEqual({ file_path: "/h/a/b.lock" });
	});

	test("read keeps an absolute path as is", () => {
		const r = sent(ev({ toolName: "read", input: { path: "/etc/hosts" } }));
		expect(r?.payload.tool_input).toEqual({ file_path: "/etc/hosts" });
	});

	test("grep maps to Grep, path defaults to '.'", () => {
		const r = sent(ev({ toolName: "grep", input: { pattern: "const" } }));
		expect(r?.payload.tool_name).toBe("Grep");
		expect(r?.payload.tool_input).toEqual({ pattern: "const", path: "." });
		expect(r?.payload.tool_response).toEqual({ mode: "content", content: body(2000) });
	});

	test("grep forwards an explicit path", () => {
		const r = sent(ev({ toolName: "grep", input: { pattern: "x", path: "src" } }));
		expect(r?.payload.tool_input).toEqual({ pattern: "x", path: "src" });
	});

	test("mcp tools keep their name and send one text part per block", () => {
		const r = sent(ev({ toolName: "mcp__x__search", input: { q: "a" }, content: [text(body(300, "a")), text(body(300, "b"))] }));
		expect(r?.payload.tool_name).toBe("mcp__x__search");
		expect(r?.payload.tool_input).toEqual({ q: "a" });
		expect(r?.payload.tool_response).toEqual({ content: [text(body(300, "a")), text(body(300, "b"))] });
	});
});

describe("toHookPayload: skips", () => {
	test("the default event is a send, so a test that forgets to override input still exercises one", () => {
		expect(sent(ev({}))?.bodyChars).toBe(2000);
	});
	test("nested calls (parentToolCallId) are skipped", () => {
		expect(sent(ev({ parentToolCallId: "p1" }))).toBeUndefined();
	});
	test.each(["find", "ls", "edit", "write", "something_else"])("%s is skipped", (toolName) => {
		expect(sent(ev({ toolName, input: { path: "a" } }))).toBeUndefined();
	});
	test("an image block skips the result", () => {
		const content = [text(body(2000)), { type: "image", data: "AAAA", mimeType: "image/png" }];
		expect(sent(ev({ toolName: "read", input: { path: "a.png" }, content }))).toBeUndefined();
	});
	test("body of 511 chars is skipped, 512 is sent", () => {
		expect(MIN_POSTHOOK_CHARS).toBe(512);
		expect(sent(ev({ input: { command: "git log" }, content: [text(body(511))] }))).toBeUndefined();
		expect(sent(ev({ input: { command: "git log" }, content: [text(body(512))] }))?.bodyChars).toBe(512);
	});
	test("the size gate counts the body, not the trailer", () => {
		const t = `${body(300)}\n\nCommand exited with code 1`;
		expect(sent(ev({ input: { command: "git log" }, content: [text(t)], isError: true, structuredContent: { exit_code: 1 } }))).toBeUndefined();
	});
	test("RTK_DISABLED=1 skips", () => {
		expect(sent(ev({ input: { command: "git log" } }), { RTK_DISABLED: "1" })).toBeUndefined();
		expect(sent(ev({ input: { command: "git log" } }), { RTK_DISABLED: "0" })).toBeDefined();
	});
	test("bash isError without structuredContent (aborted / timed out) is skipped", () => {
		expect(sent(ev({ input: { command: "git log" }, isError: true }))).toBeUndefined();
	});
	test("bash isError with structuredContent is sent", () => {
		const e = ev({
			input: { command: "git log" },
			isError: true,
			structuredContent: { output: "o", exit_code: 1 },
			content: [text(`${body(2000)}\n\nCommand exited with code 1`)],
		});
		expect(sent(e)?.bodyChars).toBe(2000);
	});
	test("'rtk ' commands are skipped below 20_000 chars and sent at or above", () => {
		expect(RTK_COMMAND_MIN_CHARS).toBe(20_000);
		expect(sent(ev({ input: { command: "rtk git log" }, content: [text(body(19_999))] }))).toBeUndefined();
		expect(sent(ev({ input: { command: "rtk git log" }, content: [text(body(20_000))] }))?.bodyChars).toBe(20_000);
	});
	test.each([
		"cd /tmp && rtk git diff",
		"FOO=1 rtk git diff",
		"a | rtk grep x",
		"false || rtk git diff",
		"true; rtk git diff",
		"  rtk git diff",
	])("rewritten compound command '%s' follows the 20_000-char rule", (command) => {
		expect(sent(ev({ input: { command }, content: [text(body(19_999))] }))).toBeUndefined();
		expect(sent(ev({ input: { command }, content: [text(body(20_000))] }))?.bodyChars).toBe(20_000);
	});
	test.each(["echo rtk", "echo rtk is great", "grep rtk src", "myrtk git diff", "rtkctl status", "cd /tmp && echo rtk x"])(
		"'%s' merely contains 'rtk' and is not exempt",
		(command) => {
			expect(sent(ev({ input: { command } }))?.bodyChars).toBe(2000);
		},
	);
	test("a missing command skips a bash result", () => {
		expect(sent(ev({ input: {} }))).toBeUndefined();
	});
});

describe("toHookPayload: trailer table (pi 1.3.0 strings)", () => {
	const cases: { name: string; toolName: string; input: Record<string, unknown>; trailer: string; extra?: Record<string, unknown> }[] = [
		{ name: "bash exit code", toolName: "bash", input: { command: "make" }, trailer: "\n\nCommand exited with code 2", extra: { isError: true, structuredContent: { exit_code: 2 } } },
		{ name: "bash line truncation", toolName: "bash", input: { command: "make" }, trailer: "\n\n[Showing lines 1801-2000 of 5000. Full output: /tmp/pi-bash-ab.log]" },
		{ name: "bash byte truncation", toolName: "bash", input: { command: "make" }, trailer: "\n\n[Showing lines 10-20 of 90 (50.0KB limit). Full output: /tmp/pi-bash-ab.log]" },
		{ name: "bash partial last line", toolName: "bash", input: { command: "make" }, trailer: "\n\n[Showing last 50.0KB of line 7 (line is 2.0MB). Full output: /tmp/pi-bash-ab.log]" },
		{
			name: "bash truncation then exit code",
			toolName: "bash",
			input: { command: "make" },
			trailer: "\n\n[Showing lines 1801-2000 of 5000. Full output: /tmp/pi-bash-ab.log]\n\nCommand exited with code 1",
			extra: { isError: true, structuredContent: { exit_code: 1 } },
		},
		{ name: "read line truncation", toolName: "read", input: { path: "a.ts" }, trailer: "\n\n[Showing lines 1-2000 of 9000. Use offset=2001 to continue.]" },
		{ name: "read user limit", toolName: "read", input: { path: "a.ts" }, trailer: "\n\n[40 more lines in file. Use offset=61 to continue.]" },
		{ name: "grep match limit", toolName: "grep", input: { pattern: "x" }, trailer: "\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]" },
		{ name: "grep combined notices", toolName: "grep", input: { pattern: "x" }, trailer: "\n\n[50.0KB limit reached. Some lines truncated to 500 chars. Use read tool to see full lines]" },
		{ name: "grep lines truncated", toolName: "grep", input: { pattern: "x" }, trailer: "\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]" },
	];
	test.each(cases)("$name: stripped from the payload, kept verbatim as the trailer", (c) => {
		const e = ev({ toolName: c.toolName, input: c.input, content: [text(body(1500) + c.trailer)], ...c.extra });
		const r = sent(e);
		expect(r?.trailer).toBe(c.trailer);
		expect(r?.bodyChars).toBe(1500);
		const wire = JSON.stringify(r?.payload.tool_response);
		expect(wire).not.toContain("Command exited with code");
		expect(wire).not.toContain("Full output:");
		expect(wire).not.toContain("Use offset=");
		expect(wire).not.toContain("limit reached");
		expect(wire).not.toContain("Some lines truncated");
		// the reply path re-appends it
		const out = fromHookOutput(reply(c.toolName, body(1000)), 0, false, e, r?.trailer ?? "");
		expect((out?.content?.[0] as { text: string }).text.endsWith(c.trailer)).toBe(true);
	});
	test("a bracketed line in the body that is not a pi notice stays in the body", () => {
		const t = `${body(1500)}\n\n[note: keep me]`;
		expect(sent(ev({ input: { command: "git log" }, content: [text(t)] }))?.trailer).toBe("");
	});
});

/** rtk's reply envelope for a replaced field, per tool. */
function reply(toolName: string, newBody: string): string {
	const updatedToolOutput: Record<string, unknown> =
		toolName === "bash" || toolName === "powershell"
			? { stdout: newBody, stderr: "", interrupted: false }
			: toolName === "read"
				? { type: "text", file: { filePath: "/work/proj/a.ts", content: newBody } }
				: toolName === "grep"
					? { mode: "content", content: newBody }
					: { content: [{ type: "text", text: newBody }] };
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } });
}

describe("fromHookOutput", () => {
	const original = body(2000);
	const e = ev({ input: { command: "git log" }, details: { truncation: { x: 1 } } });

	test("a valid reply replaces content, keeps details, tags rtk sizes, never sets isError", () => {
		const out = fromHookOutput(reply("bash", body(900, "z")), 0, false, e, "");
		expect(out).toEqual({
			content: [{ type: "text", text: body(900, "z") }],
			details: { truncation: { x: 1 }, rtk: { from: 2000, to: 900 } },
		});
		expect(out && "isError" in out).toBe(false);
	});

	test("details are created when the event had none", () => {
		const out = fromHookOutput(reply("bash", body(900, "z")), 0, false, ev({ input: { command: "git log" } }), "");
		expect(out?.details).toEqual({ rtk: { from: 2000, to: 900 } });
	});

	test.each([
		["killed", () => fromHookOutput(reply("bash", "short"), 0, true, e, "")],
		["non-zero exit", () => fromHookOutput(reply("bash", "short"), 1, false, e, "")],
		["empty stdout", () => fromHookOutput("", 0, false, e, "")],
		["whitespace stdout", () => fromHookOutput("  \n", 0, false, e, "")],
		["garbage", () => fromHookOutput("not json {", 0, false, e, "")],
		["JSON null", () => fromHookOutput("null", 0, false, e, "")],
		["no hookSpecificOutput", () => fromHookOutput("{}", 0, false, e, "")],
		["no updatedToolOutput", () => fromHookOutput('{"hookSpecificOutput":{}}', 0, false, e, "")],
		["wrong-type stdout", () => fromHookOutput('{"hookSpecificOutput":{"updatedToolOutput":{"stdout":5}}}', 0, false, e, "")],
		["identical text", () => fromHookOutput(reply("bash", original), 0, false, e, "")],
		["grown text", () => fromHookOutput(reply("bash", body(2500)), 0, false, e, "")],
		["empty replaced text", () => fromHookOutput(reply("bash", ""), 0, false, e, "")],
	])("%s passes (undefined)", (_name, run) => {
		expect(run()).toBeUndefined();
	});

	test("a reply exactly 1 char longer than the original is rejected as growth", () => {
		expect(fromHookOutput(reply("bash", body(2001, "z")), 0, false, e, "")).toBeUndefined();
	});

	test("an equal-length reply with different text is accepted as a replacement", () => {
		const out = fromHookOutput(reply("bash", body(2000, "z")), 0, false, e, "");
		expect(out?.content).toEqual([{ type: "text", text: body(2000, "z") }]);
		expect(out?.details).toEqual({ truncation: { x: 1 }, rtk: { from: 2000, to: 2000 } });
	});

	test("the trailer counts toward the grown check", () => {
		const trailer = body(100, "t");
		const withTrailer = ev({ input: { command: "git log" }, content: [text(original + trailer)] });
		expect(fromHookOutput(reply("bash", body(2050)), 0, false, withTrailer, trailer)).toBeUndefined();
		expect(fromHookOutput(reply("bash", body(1990)), 0, false, withTrailer, trailer)).toBeDefined();
	});

	test("read, grep, powershell and mcp replies read the right field", () => {
		const read = fromHookOutput(reply("read", body(100, "r")), 0, false, ev({ toolName: "read", input: { path: "a.ts" } }), "");
		expect((read?.content?.[0] as { text: string }).text).toBe(body(100, "r"));
		const grep = fromHookOutput(reply("grep", body(100, "g")), 0, false, ev({ toolName: "grep", input: { pattern: "x" } }), "");
		expect((grep?.content?.[0] as { text: string }).text).toBe(body(100, "g"));
		const ps = fromHookOutput(reply("powershell", body(100, "p")), 0, false, ev({ toolName: "powershell", input: { command: "x" } }), "");
		expect((ps?.content?.[0] as { text: string }).text).toBe(body(100, "p"));
		const mcp = fromHookOutput(reply("mcp__x__y", body(100, "m")), 0, false, ev({ toolName: "mcp__x__y", input: {} }), "");
		expect((mcp?.content?.[0] as { text: string }).text).toBe(body(100, "m"));
	});

	test("an mcp reply with a malformed content array passes", () => {
		const bad = '{"hookSpecificOutput":{"updatedToolOutput":{"content":[{"type":"text"}]}}}';
		expect(fromHookOutput(bad, 0, false, ev({ toolName: "mcp__x__y", input: {} }), "")).toBeUndefined();
	});

	test("a reply for an unmapped tool passes", () => {
		expect(fromHookOutput(reply("bash", "short"), 0, false, ev({ toolName: "find", input: {} }), "")).toBeUndefined();
	});
});

describe("structuredContent is echoed unchanged when content is replaced", () => {
	const structured = { output: body(2000), truncated: false, exit_code: 1, wall_time_seconds: 0.4 };
	test("bash", () => {
		const e = ev({
			input: { command: "make" },
			isError: true,
			structuredContent: structured,
			content: [text(`${body(2000)}\n\nCommand exited with code 1`)],
		});
		const r = sent(e);
		const out = fromHookOutput(reply("bash", body(800)), 0, false, e, r?.trailer ?? "");
		expect(out?.structuredContent).toEqual(structured);
		expect(out?.isError).toBeUndefined();
	});
	test("read", () => {
		const sc = { path: "/a", total_lines: 9 };
		const e = ev({ toolName: "read", input: { path: "a" }, structuredContent: sc });
		expect(fromHookOutput(reply("read", body(800)), 0, false, e, "")?.structuredContent).toEqual(sc);
	});
	test("mcp", () => {
		const sc = { rows: [1, 2, { a: null }] };
		const e = ev({ toolName: "mcp__x__y", input: {}, structuredContent: sc });
		expect(fromHookOutput(reply("mcp__x__y", body(800)), 0, false, e, "")?.structuredContent).toEqual(sc);
	});
	test("absent structuredContent stays absent", () => {
		const out = fromHookOutput(reply("bash", body(800)), 0, false, ev({ input: { command: "git log" } }), "");
		expect(out && "structuredContent" in out).toBe(false);
	});
});

describe("golden: real `rtk hook claude` probe (rtk 1.0.1, Grep)", () => {
	const lines = Array.from({ length: 60 }, (_, i) => `src/a.ts:${i}: const value${i} = compute(${i});`);
	const raw = lines.join("\n");
	const compressed = `60 matches in 1F:\n\n[file] src/a.ts (60):\n${lines.map((_l, i) => `    ${i}: const value${i} = compute(${i});`).join("\n")}\n[full output: rtk recall be9bf612d268]`;
	test("the probe payload shape round-trips through the mapping", () => {
		const e = ev({ toolName: "grep", input: { pattern: "const", path: "." }, content: [text(raw)] });
		const r = sent(e);
		expect(JSON.stringify(r?.payload.tool_response)).toBe(JSON.stringify({ mode: "content", content: raw }));
		const out = fromHookOutput(reply("grep", compressed), 0, false, e, r?.trailer ?? "");
		expect(out?.content).toEqual([{ type: "text", text: compressed }]);
		expect(out?.details).toEqual({ rtk: { from: raw.length, to: compressed.length } });
	});
});
