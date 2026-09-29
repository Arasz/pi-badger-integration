/**
 * Unit tests for pi-mcp-tools' pi-level tool-name composition (McpToolAdapter).
 *
 * Contract (pbi-mcp-id-safe-names): the composed pi tool name is identifier-safe —
 * dashes are normalized to underscores. Two pi surfaces otherwise name the same
 * tool differently: the tool declarations keep the raw registration spelling while
 * codemode exposes tools as normalized JavaScript identifiers (`-` cannot appear in
 * an identifier), and pi's dispatch resolves tool calls by exact name match. A
 * dashed registration name therefore works from the declaration but 404s as
 * "Tool not found" the moment a normalized spelling is used. Registering the
 * normalized spelling makes every surface agree.
 *
 * The BARE mcpTool.name still drives MCP dispatch and labels — the pi-level name
 * never crosses the wire (see McpToolAdapter's renderer comment).
 */
import { describe, expect, test } from "bun:test";
import { McpToolAdapter } from "../../extensions/pi-mcp-tools/McpToolAdapter.ts";

function mcpTool(name: string) {
	return { name, description: "d", inputSchema: { type: "object" } };
}

describe("McpToolAdapter: identifier-safe pi tool names", () => {
	test("a dashed server name composes to an underscored pi tool name", () => {
		const out = McpToolAdapter.convertToPiTool(mcpTool("plan_get"), "task-graph", () => undefined);
		expect(out!.name).toBe("mcp_task_graph_plan_get");
	});

	test("dashes in the bare MCP tool name are normalized too", () => {
		const out = McpToolAdapter.convertToPiTool(mcpTool("list-projects"), "srv", () => undefined);
		expect(out!.name).toBe("mcp_srv_list_projects");
	});

	test("a custom toolPrefix is normalized the same way; underscored names are stable", () => {
		const dashed = McpToolAdapter.convertToPiTool(mcpTool("my_tool"), "test-server", () => undefined, "custom-pfx");
		expect(dashed!.name).toBe("custom_pfx_my_tool");
		const clean = McpToolAdapter.convertToPiTool(mcpTool("my_tool"), "test-server", () => undefined, "custom_pfx");
		expect(clean!.name).toBe("custom_pfx_my_tool");
	});

	test("the bare MCP name still drives label and wire dispatch, not the pi name", async () => {
		const calls: string[] = [];
		const client = {
			callTool: async (name: string) => {
				calls.push(name);
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const out = McpToolAdapter.convertToPiTool(mcpTool("plan_get"), "task-graph", () => client as never);
		expect(out!.name).toBe("mcp_task_graph_plan_get");
		expect(out!.label).toBe("task-graph: plan_get");
		await (out as never as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
			"call-1",
			{},
			undefined,
			undefined,
			undefined,
		);
		expect(calls).toEqual(["plan_get"]);
	});
});
