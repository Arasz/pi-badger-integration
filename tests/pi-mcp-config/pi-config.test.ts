/**
 * Conversion contract for `.mcp.json` → `.pi/mcp.json` (ADR Decision 3, the
 * native-MCP retirement task).
 *
 * pi 0.99.1's built-in MCP applies `~` expansion only to command/args/cwd
 * (`dist/extensions/mcp/runtime.js` `createDefaultTransport`); `${NAME}` and
 * `!command` resolve in env/headers values only. These tests pin the five
 * converted servers so a hand-edit cannot quietly reintroduce a fork-only
 * `tools` array or a `${…}` reference pi would pass through verbatim.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface McpServer {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	tools?: unknown;
}

interface McpConfig {
	mcpServers: Record<string, McpServer>;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readConfig(relativePath: string): McpConfig {
	return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as McpConfig;
}

const claude = readConfig(".mcp.json");

function piServers(): Record<string, McpServer> {
	return readConfig(".pi/mcp.json").mcpServers;
}

describe("pi MCP config (.pi/mcp.json)", () => {
	test("defines every server from .mcp.json under mcpServers", () => {
		expect(Object.keys(piServers()).sort()).toEqual(Object.keys(claude.mcpServers).sort());
	});

	test("no fork-only tools arrays survive the conversion", () => {
		const servers = piServers();
		expect(Object.keys(servers).length).toBeGreaterThan(0);
		for (const [name, server] of Object.entries(servers)) {
			expect("tools" in server, `${name} carries a fork-only tools array`).toBe(false);
		}
	});

	test("command, args and cwd carry no ${…} references", () => {
		const servers = piServers();
		for (const [name, server] of Object.entries(servers)) {
			const text = JSON.stringify([server.command, server.args, server.cwd]);
			expect(text, `${name} command/args/cwd`).not.toMatch(/\$\{[^}]+\}/);
		}
		expect(servers["ai-raccoon"].command).toBe("~/.dotnet/tools/ai-raccoon");
		expect(servers["semantica"].command).toBe("~/.local/bin/semantica-mcp");
	});

	test("task-graph runs the repo script by relative path", () => {
		const taskGraph = piServers()["task-graph"];
		expect(taskGraph.command).toBe("~/.local/bin/uv");
		expect(taskGraph.args).toEqual([
			"run",
			"--script",
			".ai-badger/skills/task-decomposition/scripts/task_graph_server.py",
		]);
		const scriptPath = taskGraph.args?.[2];
		expect(scriptPath).toBeDefined();
		expect(existsSync(join(root, scriptPath as string)), `the pinned script exists: ${scriptPath}`).toBe(true);
	});

	test("env values pass through unchanged (SEMANTICA_DISABLE_PROGRESS=1)", () => {
		expect(piServers()["semantica"].env).toEqual({
			SEMANTICA_DISABLE_PROGRESS: "1",
		});
	});

	test("code-review-graph and playwright keep command/args verbatim", () => {
		const servers = piServers();
		expect(servers["code-review-graph"]).toMatchObject({
			command: "code-review-graph",
			args: ["serve"],
		});
		expect(servers["playwright"]).toMatchObject({
			command: "npx",
			args: ["-y", "@playwright/mcp@latest"],
		});
	});
});
