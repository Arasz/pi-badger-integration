/**
 * Card renderers for pi-mcp-tools (P1): every ai-raccoon MCP tool result plus
 * mcp_list_servers renders a human one-line collapsed card (never raw JSON)
 * and an expanded card (key fields + trimmed JSON with a visible marker).
 *
 * TDD note: this file was written BEFORE McpCardRenderers.ts existed and was
 * seen RED (Cannot find module) before the implementation turned it green.
 */
import { describe, expect, test } from "bun:test";
import {
	MCP_CARD_TOOL_NAMES,
	MCP_LIST_SERVERS_TOOL,
	collapsedMcpCard,
	expandedMcpCard,
	mcpCardRenderers,
	mcpCardTableNames,
	resolveMcpCardDescriptor,
} from "../../extensions/pi-mcp-tools/McpCardRenderers.ts";
import { McpToolAdapter } from "../../extensions/pi-mcp-tools/McpToolAdapter.ts";

const ALL_29 = [
	"code_get",
	"memory_delete",
	"memory_delete_context",
	"memory_embed_pending",
	"memory_get",
	"memory_ingest_directory",
	"memory_ingest_file",
	"memory_list",
	"memory_performance",
	"memory_promotion_discard",
	"memory_promotion_list",
	"memory_record_followthrough",
	"memory_record_grade",
	"memory_search",
	"memory_share",
	"memory_share_extract",
	"memory_stats",
	"memory_sweep",
	"memory_sync",
	"memory_watch_add",
	"memory_watch_remove",
	"memory_watch_status",
	"memory_workspace_begin",
	"memory_workspace_consolidate",
	"memory_workspace_discard",
	"memory_workspace_status",
	"memory_write",
	"memory_set_ttl",
	"project_id_token_get",
] as const;

function envelope(data: unknown): string {
	return JSON.stringify({ data, meta: {} });
}

/** Collapsed cards must never leak JSON: no quoted envelope keys, no braces. */
function expectNoJson(collapsed: string): void {
	expect(collapsed).not.toContain('"data"');
	expect(collapsed).not.toContain('"meta"');
	expect(collapsed).not.toContain("{");
	expect(collapsed).not.toContain("}");
}

function expectTokens(collapsed: string, tokens: string[]): void {
	for (const token of tokens) {
		expect(collapsed).toContain(token);
	}
}

/** [bareName, data payload, summary tokens the collapsed card must carry] */
const COLLAPSED_CASES: Array<[string, unknown, string[]]> = [
	["memory_write", { hash: "abc123def456", stored: true, path: "project/file.md" }, ["stored", "abc123"]],
	["memory_get", { hash: "abc123", value: "hello world content here", path: "notes.md" }, ["notes.md"]],
	[
		"memory_search",
		{ results: [{ hash: "h1" }, { hash: "h2" }, { hash: "h3" }], code: [{ hash: "c1" }, { hash: "c2" }] },
		["5 hits", "3 memory", "2 code"],
	],
	["memory_list", { files: { "a.md": {}, "b.md": {} } }, ["2 files"]],
	["memory_stats", { entries: 42, pending: 3, contexts: ["a", "b"] }, ["42 entries", "3 pending"]],
	["memory_delete", { deleted: 1 }, ["deleted 1"]],
	["memory_delete_context", { deleted: 7 }, ["deleted 7"]],
	["memory_ingest_file", { indexed: 4 }, ["indexed 4"]],
	["memory_ingest_directory", { scanned: 12 }, ["scanned 12"]],
	["memory_embed_pending", { processed: 8, pending: 2 }, ["processed 8", "2 pending"]],
	["project_id_token_get", { projectId: "0193abcd-0001-7000-8000-000000000000" }, ["project", "0193abcd"]],
	["memory_workspace_begin", { workspaceId: "ws-1", context: "ws-ctx" }, ["workspace", "ws-1"]],
	["memory_workspace_status", { entries: [{}, {}, {}], count: 3 }, ["3 entries"]],
	["memory_workspace_consolidate", { promoted: 3, discarded: 1 }, ["promoted 3", "discarded 1"]],
	["memory_workspace_discard", { discarded: 4 }, ["discarded 4"]],
	["memory_share", { shared: true, context: "shared" }, ["shared"]],
	[
		"memory_share_extract",
		{ candidates: [{}, {}, {}, {}, {}], promotedHashes: ["a", "b"] },
		["5 candidates", "promoted 2"],
	],
	[
		"memory_watch_add",
		{ projectId: "p", path: "/docs", pruned: ["/docs/a", "/docs/b"], absorbedBy: null },
		["/docs", "pruned 2"],
	],
	["memory_watch_status", { watches: [{ path: "/a" }, { path: "/b" }] }, ["2 watches"]],
	["memory_watch_remove", { projectId: "p", path: "/docs" }, ["/docs"]],
	["memory_sync", { sent: 3, received: 1, reindexed: 5 }, ["sent 3", "received 1", "reindexed 5"]],
	["memory_sweep", { candidates: [{}, {}, {}, {}], deleted: [] }, ["4 candidates", "dry run"]],
	["memory_set_ttl", { hash: "abc123", ttlDays: 7, rating: 0.5 }, ["ttl", "abc123"]],
	["memory_promotion_list", { rows: [{}, {}, {}, {}, {}, {}] }, ["6 waiting"]],
	["memory_promotion_discard", { discarded: 2 }, ["discarded 2"]],
	["memory_record_followthrough", { recorded: true }, ["follow-through recorded"]],
	["memory_record_grade", { recorded: true }, ["grade recorded"]],
	["memory_performance", { series: new Array(29).fill({}) }, ["29 series"]],
	["code_get", { hash: "c1", value: "let x = 1;", path: "src/a.cs", lineStart: 10, lineEnd: 20 }, ["src/a.cs", "10-20"]],
];

const LIST_SERVERS_PAYLOAD = {
	initialized: true,
	servers: [
		{ name: "hermes", source: "project:.mcp.json", connected: true },
		{ name: "dead", source: "global settings", connected: false, error: "failed to connect" },
	],
	skippedCount: 0,
	untrustedCount: 0,
};

describe("mcp card renderers: coverage pin (M5)", () => {
	test("all 29 ai-raccoon bare names are pinned", () => {
		expect([...MCP_CARD_TOOL_NAMES].sort()).toEqual([...ALL_29].sort());
		expect(MCP_CARD_TOOL_NAMES).toHaveLength(29);
	});

	test("every pinned name resolves non-fallback", () => {
		for (const name of ALL_29) {
			expect(resolveMcpCardDescriptor(name).isFallback, name).toBe(false);
		}
	});

	test("a 30th unknown tool trips the fallback", () => {
		const resolved = resolveMcpCardDescriptor("mcp_unknown_tool_xyz");
		expect(resolved.isFallback).toBe(true);
		const collapsed = collapsedMcpCard("mcp_unknown_tool_xyz", envelope({ ok: true }));
		expect(collapsed.length).toBeGreaterThan(0);
		expectNoJson(collapsed);
	});

	test("H5: descriptor table keys equal the pinned names plus list_servers (no silent mirror drift)", () => {
		expect([...mcpCardTableNames()].sort()).toEqual([...MCP_CARD_TOOL_NAMES, MCP_LIST_SERVERS_TOOL].sort());
	});

	test("F1: memory_search with absent results/code (data:null envelope) falls back, not 'no hits'", () => {
		const collapsed = collapsedMcpCard("memory_search", JSON.stringify({ data: null, meta: {} }));
		expect(collapsed).toContain("finished — open for details");
		expect(collapsed).not.toContain("no hits");
		expectNoJson(collapsed);
	});

	test("F1: memory_search with present-but-empty results still reports no hits", () => {
		const collapsed = collapsedMcpCard("memory_search", envelope({ results: [], code: [] }));
		expect(collapsed).toContain("no hits");
		expectNoJson(collapsed);
	});

	test("H1: a >64KB valid envelope collapses to fallback without throwing (parse bound)", () => {
		const big = envelope({ value: "v".repeat(70000), path: "notes.md" });
		expect(big.length).toBeGreaterThan(65536);
		let collapsed = "";
		expect(() => {
			collapsed = collapsedMcpCard("memory_get", big);
		}).not.toThrow();
		expect(collapsed).toContain("finished — open for details");
		expectNoJson(collapsed);
	});
});

describe("mcp card renderers: prefixed dispatch (M2)", () => {
	test("mcp_ai-raccoon_memory_search renders the memory_search card", () => {
		const tool = McpToolAdapter.convertToPiTool(
			{ name: "memory_search", description: "search", inputSchema: { type: "object" } },
			"ai-raccoon",
			() => undefined,
			"mcp_ai-raccoon",
		);
		expect(tool).not.toBeNull();
		expect(tool!.name).toBe("mcp_ai-raccoon_memory_search");
		expect(typeof tool!.renderResult).toBe("function");
		expect(typeof tool!.renderCall).toBe("function");
		const component = tool!.renderResult!(
			{ content: [{ type: "text", text: envelope({ results: [{ hash: "h1" }] }) }], details: {} } as never,
			{ expanded: false, isPartial: false } as never,
			{} as never,
			{ args: {} } as never,
		);
		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("1 hits");
		expectNoJson(rendered);
	});

	test("QA: custom toolPrefix still dispatches the bare card (M2 claim)", () => {
		const tool = McpToolAdapter.convertToPiTool(
			{ name: "memory_get", description: "get", inputSchema: { type: "object" } },
			"ai-raccoon",
			() => undefined,
			"custom_pfx",
		);
		expect(tool).not.toBeNull();
		expect(tool!.name).toBe("custom_pfx_memory_get");
		const component = tool!.renderResult!(
			{ content: [{ type: "text", text: envelope({ hash: "abc123", path: "notes.md", value: "hi" }) }], details: {} } as never,
			{ expanded: false, isPartial: false } as never,
			{} as never,
			{ args: {} } as never,
		);
		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("notes.md");
		expectNoJson(rendered);
	});

	test("QA: renderResult with expanded:true shows key fields plus trimmed JSON", () => {
		const tool = McpToolAdapter.convertToPiTool(
			{ name: "memory_get", description: "get", inputSchema: { type: "object" } },
			"ai-raccoon",
			() => undefined,
			"mcp_ai-raccoon",
		);
		const text = envelope({ hash: "abc123", path: "notes.md", value: "hi" });
		const component = tool!.renderResult!(
			{ content: [{ type: "text", text }], details: {} } as never,
			{ expanded: true, isPartial: false } as never,
			{} as never,
			{ args: {} } as never,
		);
		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("notes.md");
		expect(rendered).toContain(text.slice(0, 32));
	});
});

describe("mcp card renderers: collapsed cards (AC2)", () => {
	for (const [name, data, tokens] of COLLAPSED_CASES) {
		test(`${name} collapsed carries summary tokens and zero JSON`, () => {
			const collapsed = collapsedMcpCard(name, envelope(data));
			expect(collapsed.length).toBeGreaterThan(0);
			expectTokens(collapsed, tokens);
			expectNoJson(collapsed);
		});
	}

	test("mcp_list_servers collapsed shows ✓/✗ name — source, not JSON", () => {
		const collapsed = collapsedMcpCard("mcp_list_servers", JSON.stringify(LIST_SERVERS_PAYLOAD));
		expect(collapsed).toContain("✓ hermes");
		expect(collapsed).toContain("project:.mcp.json");
		expect(collapsed).toContain("✗ dead");
		expectNoJson(collapsed);
	});

	test("QA: memory_sweep deleted-branch pins 'deleted N' (secondary display variant)", () => {
		const collapsed = collapsedMcpCard("memory_sweep", envelope({ candidates: [{ a: 1 }], deleted: ["h1", "h2"] }));
		expect(collapsed).toContain("deleted 2");
		expectNoJson(collapsed);
	});

	test("QA: memory_watch_add absorbedBy + plain variants pin their lines", () => {
		const absorbed = collapsedMcpCard("memory_watch_add", envelope({ path: "/docs", absorbedBy: "/docs", pruned: [] }));
		expect(absorbed).toContain("re-add absorbed");
		expectNoJson(absorbed);
		const plain = collapsedMcpCard("memory_watch_add", envelope({ path: "/docs", pruned: [] }));
		expect(plain).toContain("watching /docs");
		expectNoJson(plain);
	});

	test("QA: memory_write refused pins reason line", () => {
		const collapsed = collapsedMcpCard("memory_write", envelope({ hash: "abc123def456", stored: false, reason: "noise" }));
		expect(collapsed).toContain("refused — noise");
		expectNoJson(collapsed);
	});

	test("QA: ledger with no servers states it plainly", () => {
		const collapsed = collapsedMcpCard("mcp_list_servers", JSON.stringify({ servers: [] }));
		expect(collapsed).toContain("no servers armed");
		expectNoJson(collapsed);
	});
});

describe("mcp card renderers: envelope casing tolerance (S2)", () => {
	test("memory_write reads PascalCase Data/Hash/Stored", () => {
		const collapsed = collapsedMcpCard(
			"memory_write",
			JSON.stringify({ Data: { Hash: "abc123def456", Stored: true }, Meta: {} }),
		);
		expectTokens(collapsed, ["stored", "abc123"]);
		expectNoJson(collapsed);
	});

	test("memory_search reads PascalCase Results/Code", () => {
		const collapsed = collapsedMcpCard(
			"memory_search",
			JSON.stringify({ Data: { Results: [{ Hash: "h1" }], Code: [{ Hash: "c1" }, { Hash: "c2" }] }, Meta: {} }),
		);
		expectTokens(collapsed, ["3 hits", "1 memory", "2 code"]);
		expectNoJson(collapsed);
	});
});

describe("mcp card renderers: fail-open (AC3/M4)", () => {
	const NON_ENVELOPE_STRINGS = [
		"Tool call cancelled",
		"MCP server 'x' is not connected",
		"MCP Error: boom",
		"No content returned",
		"[image content received]",
		"[resource content received]",
		"[Unserializable data]",
	];

	for (const input of NON_ENVELOPE_STRINGS) {
		test(`adapter string renders fallback without throwing: ${input.slice(0, 32)}`, () => {
			let collapsed = "";
			let expanded = "";
			expect(() => {
				collapsed = collapsedMcpCard("memory_search", input);
				expanded = expandedMcpCard("memory_search", input);
			}).not.toThrow();
			expect(collapsed.length).toBeGreaterThan(0);
			expect(expanded.length).toBeGreaterThan(0);
			expectNoJson(collapsed);
		});
	}

	test("garbage, truncated JSON, data:null, missing and empty content all fall back", () => {
		const inputs: Array<string | undefined> = [
			"not json {{{",
			'{"data": {"Hash": "ab',
			JSON.stringify({ data: null, meta: {} }),
			undefined,
			"",
		];
		for (const input of inputs) {
			let collapsed = "";
			let expanded = "";
			expect(() => {
				collapsed = collapsedMcpCard("memory_get", input);
				expanded = expandedMcpCard("memory_get", input);
			}).not.toThrow();
			expect(collapsed.length).toBeGreaterThan(0);
			expect(expanded.length).toBeGreaterThan(0);
			// QA: oracle pins the fallback TEXT, not just crash-freedom — a
			// wrong-but-plausible summary must go red here.
			expect(collapsed).toContain("finished — open for details");
			expectNoJson(collapsed);
		}
	});
});

describe("mcp card renderers: expanded cap (S5)", () => {
	test("expanded trims JSON past ~4KB with a visible marker", () => {
		const big = envelope({ results: new Array(500).fill({ hash: "h".repeat(40), value: "v".repeat(40) }) });
		expect(big.length).toBeGreaterThan(8192);
		const expanded = expandedMcpCard("memory_search", big);
		expect(expanded).toContain("trimmed");
		const jsonStart = expanded.indexOf("[");
		const jsonPart = expanded.slice(jsonStart);
		expect(jsonPart.length).toBeLessThanOrEqual(4096 + 128);
	});

	test("small payloads carry no trim marker", () => {
		const expanded = expandedMcpCard("memory_get", envelope({ hash: "abc123", path: "notes.md" }));
		expect(expanded).not.toContain("trimmed");
		expect(expanded).toContain("notes.md");
	});
});

describe("mcp card renderers: execute stays byte-identical (M3)", () => {
	test("attaching renderers does not change execute content/details", async () => {
		const envelopeText = envelope({ results: [{ hash: "h1" }] });
		const fakeClient = {
			callTool: async () => ({ content: [{ type: "text", text: envelopeText }] }),
		};
		const tool = McpToolAdapter.convertToPiTool(
			{ name: "memory_search", description: "search", inputSchema: { type: "object" } },
			"ai-raccoon",
			() => fakeClient as never,
		);
		const result = (await tool!.execute("call-1", {}, undefined, undefined, {} as never)) as {
			content: unknown;
			details: unknown;
		};
		expect(result.content).toEqual([{ type: "text", text: envelopeText }]);
		expect(result.details).toEqual({ server: "ai-raccoon", tool: "memory_search" });
	});
});

type CallRenderer = (args: unknown) => { render(width: number): string[] };

describe("mcp card renderers: renderCall", () => {
	test("every pinned name plus list_servers renders a call line without throwing", () => {
		for (const name of [...ALL_29, "mcp_list_servers"]) {
			const { renderCall } = mcpCardRenderers(name);
			let line = "";
			expect(() => {
				line = (renderCall as unknown as CallRenderer)({ query: "hello" }).render(100).join("\n");
			}).not.toThrow();
			expect(line.length).toBeGreaterThan(0);
			expectNoJson(line);
		}
	});

	test("memory_search call line names the query", () => {
		const { renderCall } = mcpCardRenderers("memory_search");
		const line = (renderCall as unknown as CallRenderer)({ query: "hello world" }).render(100).join("\n");
		expect(line).toContain("hello world");
	});
});
