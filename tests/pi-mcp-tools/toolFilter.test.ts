/**
 * Unit tests for pi-mcp-tools' pure tool filtering logic (toolFilter.ts).
 *
 * Out of unit scope, by design: McpClient, McpRegistry and index.ts are
 * integration-flavoured (they need a live MCP server or heavy stubbing) and are
 * deliberately NOT covered here — no faked coverage.
 *
 * F7 (fresh clones): extensions/pi-mcp-tools/node_modules is gitignored; run
 * `bun install` inside extensions/pi-mcp-tools/ before running this suite.
 */
import { describe, expect, test } from "bun:test";
import { countEnabledTools, enabledToolNames } from "../../extensions/pi-mcp-tools/toolFilter.ts";

describe("enabledToolNames", () => {
	test("non-MCP tools always survive, even when a same-named tool sits in the disabled set", () => {
		// Failure mode: filtering by the disabled set alone would hide built-in
		// tools that merely share a name with something once disabled.
		const out = enabledToolNames(["bash", "read"], new Set<string>(), new Set(["bash"]));
		expect(out).toEqual(["bash", "read"]);
	});

	test("an MCP tool survives when registered but not disabled", () => {
		const out = enabledToolNames(["github"], new Set(["github"]), new Set<string>());
		expect(out).toEqual(["github"]);
	});

	test("an MCP tool is dropped only when registered AND disabled — the intersection decides", () => {
		// One test walking several axes at once: registered+disabled drops,
		// registered-only survives, disabled-only survives.
		const out = enabledToolNames(
			["github", "gitlab", "bash"],
			new Set(["github", "gitlab"]),
			new Set(["github"]),
		);
		expect(out).toEqual(["gitlab", "bash"]);
	});

	test("both sets empty: every tool passes through, order preserved", () => {
		const names = ["c", "a", "b"];
		expect(enabledToolNames(names, new Set<string>(), new Set<string>())).toEqual(["c", "a", "b"]);
	});

	test("no tools at all yields an empty list even with populated sets", () => {
		expect(enabledToolNames([], new Set(["x"]), new Set(["x"]))).toEqual([]);
	});
});

describe("countEnabledTools", () => {
	test("counts registered tools that are not disabled", () => {
		expect(countEnabledTools(new Set(["a", "b", "c"]), new Set(["b"]))).toBe(2);
	});

	test("an empty disabled set leaves every registered tool counted", () => {
		expect(countEnabledTools(new Set(["a", "b"]), new Set<string>())).toBe(2);
	});

	test("disabling everything drives the count to zero", () => {
		expect(countEnabledTools(new Set(["a"]), new Set(["a"]))).toBe(0);
	});

	test("disabled names outside the registered set do not affect the count", () => {
		// Failure mode: counting from the disabled set (or diffing against it)
		// would let stale disabled entries corrupt the number.
		expect(countEnabledTools(new Set(["a", "x"]), new Set(["ghost", "phantom"]))).toBe(2);
	});

	test("nothing registered counts zero even with a populated disabled set", () => {
		expect(countEnabledTools(new Set<string>(), new Set(["x"]))).toBe(0);
	});
});
