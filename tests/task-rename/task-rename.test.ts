/**
 * task-rename tests: `/rename <name>` command + auto-rename on task_tracker output.
 *
 * The task skill ends Phase 1 with "ask the user to run `/rename {taskId}`".
 * pi has no `/rename` (its builtin is `/name`), so the reminder rots into a
 * manual step. This extension registers `/rename` as a thin alias over
 * `pi.setSessionName` and auto-applies the task_tracker's REMINDER line when
 * it lands in a tool result, so the session label matches the task without
 * anyone typing anything.
 */

import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension from "../../extensions/task-rename/index.ts";
import {
	extractTaskIdFromText,
	extractTextFromContent,
	parseRenameArg,
} from "../../extensions/task-rename/task-rename-core.ts";

const REMINDER =
	'REMINDER (SKILL.md Phase 1 step 3): ask the user to run `/rename aib-default-loop` now, ' +
	"so this session's label matches the task. Do not skip this silently.";

function piWithSessionName() {
	const pi = createFakePi() as unknown as Record<string, unknown>;
	let name: string | undefined;
	(pi as { setSessionName: (n: string) => void }).setSessionName = (n: string) => {
		name = n;
	};
	(pi as { getSessionName: () => string | undefined }).getSessionName = () => name;
	return { pi: pi as unknown as Parameters<typeof makeExtension>[0], getName: () => name };
}

function ctxWithNotify() {
	const notices: Array<{ message: string; type?: string }> = [];
	return {
		notices,
		ctx: { hasUI: true, ui: { notify: (message: string, type?: string) => notices.push({ message, type }) } },
	};
}

describe("parseRenameArg", () => {
	test("trims surrounding whitespace", () => {
		expect(parseRenameArg("  aib-default-loop  ")).toBe("aib-default-loop");
	});
	test("keeps multi-word display names (parity with /name)", () => {
		expect(parseRenameArg("Refactor auth module")).toBe("Refactor auth module");
	});
	test("empty or blank args are usage, not a name", () => {
		expect(parseRenameArg("")).toBeUndefined();
		expect(parseRenameArg("   ")).toBeUndefined();
	});
});

describe("extractTaskIdFromText", () => {
	test("finds the task id in the tracker REMINDER line", () => {
		expect(extractTaskIdFromText(REMINDER)).toBe("aib-default-loop");
	});
	test("finds a bare /rename mention without backticks", () => {
		expect(extractTaskIdFromText("please run /rename pbi-foo-bar-baz-qux now")).toBe("pbi-foo-bar-baz-qux");
	});
	test("no /rename mention yields nothing", () => {
		expect(extractTaskIdFromText("all done, no reminder here")).toBeUndefined();
	});
	test("a bare /rename with no id yields nothing", () => {
		expect(extractTaskIdFromText("run /rename now please")).toBeUndefined();
	});
});

describe("extractTextFromContent", () => {
	test("joins text parts, skips image parts", () => {
		expect(
			extractTextFromContent([
				{ type: "text", text: "hello " },
				{ type: "image", data: "x" },
				{ type: "text", text: "world" },
			]),
		).toBe("hello world");
	});
	test("non-array content is empty", () => {
		expect(extractTextFromContent(undefined)).toBe("");
		expect(extractTextFromContent("just a string")).toBe("");
	});
});

describe("/rename command", () => {
	test("sets the session name and notifies", async () => {
		const { pi, getName } = piWithSessionName();
		makeExtension(pi);
		const { ctx, notices } = ctxWithNotify();
		const cmd = (pi as unknown as { commands: Map<string, { handler: (a: string, c: unknown) => Promise<void> }> }).commands.get(
			"rename",
		);
		expect(cmd).toBeDefined();
		await cmd!.handler("aib-default-loop", ctx);
		expect(getName()).toBe("aib-default-loop");
		expect(notices.some((n) => n.message.includes("aib-default-loop"))).toBe(true);
	});
	test("blank args notify usage and leave the name alone", async () => {
		const { pi, getName } = piWithSessionName();
		makeExtension(pi);
		const { ctx, notices } = ctxWithNotify();
		const cmd = (pi as unknown as { commands: Map<string, { handler: (a: string, c: unknown) => Promise<void> }> }).commands.get(
			"rename",
		);
		await cmd!.handler("   ", ctx);
		expect(getName()).toBeUndefined();
		expect(notices.some((n) => n.message.toLowerCase().includes("usage"))).toBe(true);
	});
});

describe("auto-rename on tool_result", () => {
	test("tracker REMINDER output renames the session without typing", async () => {
		const { pi, getName } = piWithSessionName();
		makeExtension(pi);
		const { ctx, notices } = ctxWithNotify();
		await fire(
			pi as never,
			"tool_result",
			{ toolName: "bash", content: [{ type: "text", text: REMINDER }] },
			ctx,
		);
		expect(getName()).toBe("aib-default-loop");
		expect(notices.some((n) => n.message.includes("aib-default-loop"))).toBe(true);
	});
	test("unrelated tool output leaves the name alone", async () => {
		const { pi, getName } = piWithSessionName();
		makeExtension(pi);
		const { ctx } = ctxWithNotify();
		await fire(pi as never, "tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }, ctx);
		expect(getName()).toBeUndefined();
	});
	test("already-correct name does not re-notify", async () => {
		const { pi, getName } = piWithSessionName();
		(pi as unknown as { setSessionName: (n: string) => void }).setSessionName("aib-default-loop");
		makeExtension(pi);
		const { ctx, notices } = ctxWithNotify();
		await fire(
			pi as never,
			"tool_result",
			{ toolName: "bash", content: [{ type: "text", text: REMINDER }] },
			ctx,
		);
		expect(getName()).toBe("aib-default-loop");
		expect(notices.length).toBe(0);
	});
});
