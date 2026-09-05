/**
 * Human card renderers for MCP tool results (pi-mcp-tools).
 *
 * Problem: every MCP tool result is an ApiEnvelope serialized as JSON text,
 * and without renderers pi shows the raw JSON dump. This module maps each
 * BARE MCP tool name to a one-line collapsed summary (zero JSON tokens) plus
 * an expanded view (key fields + trimmed JSON with a visible marker).
 *
 * Keying is on the BARE mcpTool.name — never the prefixed pi name, because
 * the prefix is configurable per server (M2). The adapter closes over the
 * bare name at registration time, so a custom toolPrefix cannot break
 * dispatch.
 *
 * Fail-open throughout: unparseable, truncated, null or missing content —
 * including the adapter's own non-envelope strings ("Tool call cancelled",
 * "not connected", "MCP Error: …", "No content returned",
 * "[image/resource content received]", "[Unserializable data]") — renders
 * the generic fallback and never throws (M4).
 *
 * Design (S1): shared extractor helpers by shape family (countOf, shortHash,
 * firstStr, firstNum, firstArr) with PER-TOOL path entries, not 29 bespoke
 * lambdas over raw JSON. The per-tool path lists keep the mutation test
 * sensitive: renaming one path (e.g. indexed -> indexedd) drops that tool to
 * the fallback and its collapsed test goes red.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Trimmed-JSON cap for the expanded view (~4KB, S5). */
export const EXPANDED_JSON_CAP = 4096;
/** Parse bound: slice before JSON.parse so pathological input stays cheap (S6). */
const PARSE_BOUND = 65536;

export const MCP_LIST_SERVERS_TOOL = "mcp_list_servers";

export const MCP_CARD_TOOL_NAMES: readonly string[] = [
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
];

type JsonRecord = Record<string, unknown>;

/** Case-insensitive field read: the wire may be camelCase or PascalCase (S2). */
function field(obj: unknown, ...names: string[]): unknown {
	if (typeof obj !== "object" || obj === null) {
		return undefined;
	}
	const rec = obj as JsonRecord;
	for (const name of names) {
		if (name in rec) {
			return rec[name];
		}
		const lower = name.toLowerCase();
		for (const key of Object.keys(rec)) {
			if (key.toLowerCase() === lower) {
				return rec[key];
			}
		}
	}
	return undefined;
}

function firstStr(obj: unknown, ...names: string[]): string | undefined {
	const value = field(obj, ...names);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstNum(obj: unknown, ...names: string[]): number | undefined {
	const value = field(obj, ...names);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstArr(obj: unknown, ...names: string[]): unknown[] | undefined {
	const value = field(obj, ...names);
	return Array.isArray(value) ? value : undefined;
}

/**
 * Tolerant count (S3): a numeric field, else an array length, else an object
 * key count. Returns undefined only when none of the paths yields anything.
 */
function countOf(obj: unknown, ...names: string[]): number | undefined {
	for (const name of names) {
		const value = field(obj, name);
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.length;
		}
		if (typeof value === "object" && value !== null) {
			return Object.keys(value as JsonRecord).length;
		}
	}
	return undefined;
}

function shortHash(hash: string | undefined): string | undefined {
	if (!hash) {
		return undefined;
	}
	return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

interface McpCardEntry {
	/** Bare MCP tool name this entry serves. */
	name: string;
	/** One-line collapsed summary, or null when the data shape is unrecognized. */
	summarize: (data: JsonRecord) => string | null;
	/** Optional bespoke call line; the harness falls back to scalar key=value pairs. */
	describeCall?: (args: JsonRecord) => string | null;
}

function writeEntry(): McpCardEntry {
	return {
		name: "memory_write",
		summarize: (data) => {
			const hash = shortHash(firstStr(data, "hash"));
			if (!hash) {
				return null;
			}
			if (field(data, "stored") === false) {
				const reason = firstStr(data, "reason");
				return reason ? `memory_write: refused — ${reason}` : "memory_write: refused";
			}
			const path = firstStr(data, "path");
			return path ? `memory_write: stored ${hash} — ${path}` : `memory_write: stored ${hash}`;
		},
		describeCall: (args) => {
			const content = firstStr(args, "content");
			return content ? `memory_write ${truncateInline(content, 60)}` : null;
		},
	};
}

function truncateInline(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const TABLE: Record<string, McpCardEntry> = {
	memory_write: writeEntry(),
	memory_get: {
		name: "memory_get",
		summarize: (data) => {
			const path = firstStr(data, "path");
			if (!path) {
				return null;
			}
			const value = firstStr(data, "value");
			return value !== undefined ? `memory_get ${path} — ${value.length} chars` : `memory_get ${path}`;
		},
		describeCall: (args) => {
			const hash = shortHash(firstStr(args, "hash"));
			return hash ? `memory_get ${hash}` : null;
		},
	},
	memory_search: {
		name: "memory_search",
		summarize: (data) => {
			// F1: missing keys (e.g. a data:null envelope) mean unknown, not empty —
			// fall back rather than claiming "no hits". Empty-but-present arrays
			// are the only true no-hits signal.
			const hasMemory = field(data, "results") !== undefined;
			const hasCode = field(data, "code") !== undefined;
			if (!hasMemory && !hasCode) {
				return null;
			}
			const memory = firstArr(data, "results") ?? [];
			const code = firstArr(data, "code") ?? [];
			const total = memory.length + code.length;
			if (total === 0) {
				return "memory_search: no hits";
			}
			return `memory_search: ${total} hits (${memory.length} memory, ${code.length} code)`;
		},
		describeCall: (args) => {
			const query = firstStr(args, "query");
			return query ? `memory_search ${truncateInline(query, 60)}` : null;
		},
	},
	memory_list: {
		name: "memory_list",
		summarize: (data) => {
			const count = countOf(data, "files");
			return count === undefined ? null : `memory_list: ${count} files`;
		},
	},
	memory_stats: {
		name: "memory_stats",
		summarize: (data) => {
			const entries = firstNum(data, "entries", "entryCount");
			if (entries === undefined) {
				return null;
			}
			const pending = firstNum(data, "pending", "pendingCount") ?? 0;
			return `memory_stats: ${entries} entries, ${pending} pending`;
		},
	},
	memory_delete: {
		name: "memory_delete",
		summarize: (data) => {
			const deleted = firstNum(data, "deleted");
			return deleted === undefined ? null : `memory_delete: deleted ${deleted}`;
		},
		describeCall: (args) => {
			const hash = shortHash(firstStr(args, "hash"));
			return hash ? `memory_delete ${hash}` : null;
		},
	},
	memory_delete_context: {
		name: "memory_delete_context",
		summarize: (data) => {
			const deleted = firstNum(data, "deleted");
			return deleted === undefined ? null : `memory_delete_context: deleted ${deleted}`;
		},
		describeCall: (args) => {
			const context = firstStr(args, "context");
			return context ? `memory_delete_context ${truncateInline(context, 40)}` : null;
		},
	},
	memory_ingest_file: {
		name: "memory_ingest_file",
		summarize: (data) => {
			// S3: tolerate either counter name.
			const indexed = firstNum(data, "indexed", "scanned");
			return indexed === undefined ? null : `memory_ingest_file: indexed ${indexed}`;
		},
		describeCall: (args) => {
			const path = firstStr(args, "path");
			return path ? `memory_ingest_file ${truncateInline(path, 60)}` : null;
		},
	},
	memory_ingest_directory: {
		name: "memory_ingest_directory",
		summarize: (data) => {
			const scanned = firstNum(data, "scanned", "indexed");
			return scanned === undefined ? null : `memory_ingest_directory: scanned ${scanned}`;
		},
		describeCall: (args) => {
			const path = firstStr(args, "path");
			return path ? `memory_ingest_directory ${truncateInline(path, 60)}` : null;
		},
	},
	memory_embed_pending: {
		name: "memory_embed_pending",
		summarize: (data) => {
			const processed = firstNum(data, "processed");
			if (processed === undefined) {
				return null;
			}
			const pending = firstNum(data, "pending") ?? 0;
			return `memory_embed_pending: processed ${processed}, ${pending} pending`;
		},
	},
	project_id_token_get: {
		name: "project_id_token_get",
		summarize: (data) => {
			const id = shortHash(firstStr(data, "projectId"));
			return id ? `project id ${id} minted — pass it as projectId from here on` : null;
		},
	},
	memory_workspace_begin: {
		name: "memory_workspace_begin",
		summarize: (data) => {
			const id = shortHash(firstStr(data, "workspaceId"));
			return id ? `workspace ${id} opened` : null;
		},
	},
	memory_workspace_status: {
		name: "memory_workspace_status",
		summarize: (data) => {
			const count = firstNum(data, "count") ?? firstArr(data, "entries")?.length;
			return count === undefined ? null : `memory_workspace_status: ${count} entries`;
		},
		describeCall: (args) => {
			const id = shortHash(firstStr(args, "workspaceId"));
			return id ? `memory_workspace_status ${id}` : null;
		},
	},
	memory_workspace_consolidate: {
		name: "memory_workspace_consolidate",
		summarize: (data) => {
			const promoted = firstNum(data, "promoted");
			const discarded = firstNum(data, "discarded");
			if (promoted === undefined || discarded === undefined) {
				return null;
			}
			return `memory_workspace_consolidate: promoted ${promoted}, discarded ${discarded}`;
		},
	},
	memory_workspace_discard: {
		name: "memory_workspace_discard",
		summarize: (data) => {
			const discarded = firstNum(data, "discarded");
			return discarded === undefined ? null : `memory_workspace_discard: discarded ${discarded}`;
		},
	},
	memory_share: {
		name: "memory_share",
		summarize: (data) => {
			const context = firstStr(data, "context");
			if (field(data, "shared") === true) {
				return context ? `memory_share: promoted to ${context}` : "memory_share: promoted";
			}
			return context ? `memory_share: kept in ${context}` : null;
		},
		describeCall: (args) => {
			const hash = shortHash(firstStr(args, "hash"));
			return hash ? `memory_share ${hash}` : null;
		},
	},
	memory_share_extract: {
		name: "memory_share_extract",
		summarize: (data) => {
			const candidates = firstArr(data, "candidates");
			const promoted = firstArr(data, "promotedHashes", "promoted")?.length ?? 0;
			if (!candidates) {
				return null;
			}
			return `memory_share_extract: ${candidates.length} candidates, promoted ${promoted}`;
		},
	},
	memory_watch_add: {
		name: "memory_watch_add",
		summarize: (data) => {
			const path = firstStr(data, "path");
			if (!path) {
				return null;
			}
			const absorbedBy = firstStr(data, "absorbedBy");
			if (absorbedBy) {
				return `watching ${path} — re-add absorbed`;
			}
			const pruned = firstArr(data, "pruned")?.length ?? 0;
			return pruned > 0 ? `watching ${path} — pruned ${pruned}` : `watching ${path}`;
		},
		describeCall: (args) => {
			const path = firstStr(args, "path");
			return path ? `memory_watch_add ${truncateInline(path, 60)}` : null;
		},
	},
	memory_watch_status: {
		name: "memory_watch_status",
		summarize: (data) => {
			const watches = firstArr(data, "watches");
			if (!watches) {
				return null;
			}
			if (watches.length === 0) {
				return "memory_watch_status: no watches";
			}
			const paths = watches
				.map((w) => firstStr(w, "path"))
				.filter((p): p is string => p !== undefined)
				.map((p) => truncateInline(p, 40));
			return paths.length > 0
				? `memory_watch_status: ${watches.length} watches — ${paths.join(", ")}`
				: `memory_watch_status: ${watches.length} watches`;
		},
	},
	memory_watch_remove: {
		name: "memory_watch_remove",
		summarize: (data) => {
			const path = firstStr(data, "path");
			return path ? `stopped watching ${path}` : null;
		},
		describeCall: (args) => {
			const path = firstStr(args, "path");
			return path ? `memory_watch_remove ${truncateInline(path, 60)}` : null;
		},
	},
	memory_sync: {
		name: "memory_sync",
		summarize: (data) => {
			const sent = firstNum(data, "sent");
			const received = firstNum(data, "received");
			const reindexed = firstNum(data, "reindexed");
			if (sent === undefined && received === undefined && reindexed === undefined) {
				return null;
			}
			return `memory_sync: sent ${sent ?? 0}, received ${received ?? 0}, reindexed ${reindexed ?? 0}`;
		},
	},
	memory_sweep: {
		name: "memory_sweep",
		summarize: (data) => {
			const candidates = firstArr(data, "candidates");
			const deleted = firstArr(data, "deleted", "deletedHashes") ?? [];
			if (!candidates && deleted.length === 0) {
				return null;
			}
			if (deleted.length > 0) {
				return `memory_sweep: deleted ${deleted.length}`;
			}
			return `memory_sweep: ${candidates?.length ?? 0} candidates — dry run`;
		},
	},
	memory_set_ttl: {
		name: "memory_set_ttl",
		summarize: (data) => {
			const hash = shortHash(firstStr(data, "hash"));
			if (!hash) {
				return null;
			}
			const days = firstNum(data, "ttlDays");
			return days === undefined || days === null
				? `memory_set_ttl: ${hash} ttl cleared`
				: `memory_set_ttl: ${hash} ttl ${days} days`;
		},
		describeCall: (args) => {
			const hash = shortHash(firstStr(args, "hash"));
			return hash ? `memory_set_ttl ${hash}` : null;
		},
	},
	memory_promotion_list: {
		name: "memory_promotion_list",
		summarize: (data) => {
			const rows = firstArr(data, "rows");
			return rows ? `promotion queue: ${rows.length} waiting` : null;
		},
	},
	memory_promotion_discard: {
		name: "memory_promotion_discard",
		summarize: (data) => {
			const discarded = firstNum(data, "discarded");
			return discarded === undefined ? null : `promotion queue: discarded ${discarded}`;
		},
	},
	memory_record_followthrough: {
		name: "memory_record_followthrough",
		summarize: (data) => {
			return field(data, "recorded") === true ? "follow-through recorded" : null;
		},
	},
	memory_record_grade: {
		name: "memory_record_grade",
		summarize: (data) => {
			return field(data, "recorded") === true ? "grade recorded" : null;
		},
	},
	memory_performance: {
		name: "memory_performance",
		summarize: (data) => {
			const series = firstArr(data, "series");
			return series ? `memory_performance: ${series.length} series` : null;
		},
	},
	code_get: {
		name: "code_get",
		summarize: (data) => {
			const path = firstStr(data, "path");
			if (!path) {
				return null;
			}
			const start = firstNum(data, "lineStart");
			const end = firstNum(data, "lineEnd");
			return start !== undefined && end !== undefined
				? `code_get ${path} lines ${start}-${end}`
				: `code_get ${path}`;
		},
		describeCall: (args) => {
			const hash = shortHash(firstStr(args, "hash"));
			return hash ? `code_get ${hash}` : null;
		},
	},
	[MCP_LIST_SERVERS_TOOL]: {
		name: MCP_LIST_SERVERS_TOOL,
		summarize: (data) => summarizeLedger(data),
	},
};

const FALLBACK_ENTRY: McpCardEntry = {
	name: "fallback",
	summarize: () => null,
};

/** All bare names the descriptor table serves (H5 exact-set pin seam). */
export function mcpCardTableNames(): readonly string[] {
	return Object.keys(TABLE);
}

export interface ResolvedMcpCard {
	/** The bare tool name this card serves (or the unknown name, for fallback). */
	bareName: string;
	/** True when no descriptor covers the name and the generic card applies. */
	isFallback: boolean;
}

/** Resolve a bare MCP tool name to its card (generic fallback for unknown names). */
export function resolveMcpCardDescriptor(bareName: string): ResolvedMcpCard {
	return { bareName, isFallback: TABLE[bareName] === undefined };
}

function entryFor(bareName: string): McpCardEntry {
	return TABLE[bareName] ?? FALLBACK_ENTRY;
}

/**
 * Pull the card data out of a tool-result text blob. Envelope payloads
 * ({data|Data, meta|Meta}) yield the data member; the mcp_list_servers
 * payload (no envelope) yields the whole object. Null when there is nothing
 * card-worthy: missing/empty text, unparseable JSON, or a null data member.
 */
function extractCardData(contentText: string | undefined): JsonRecord | null {
	if (!contentText) {
		return null;
	}
	const bounded = contentText.length > PARSE_BOUND ? contentText.slice(0, PARSE_BOUND) : contentText;
	let parsed: unknown;
	try {
		parsed = JSON.parse(bounded);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const data = field(parsed, "data");
	const cardData = data === undefined || data === null ? parsed : data;
	return typeof cardData === "object" && cardData !== null ? (cardData as JsonRecord) : null;
}

function fallbackCollapsed(bareName: string): string {
	return `${bareName}: finished — open for details`;
}

/**
 * Collapsed card: one human line, zero JSON tokens. Fail-open: any shape the
 * descriptor does not recognize falls back to the generic line, never throws.
 */
export function collapsedMcpCard(bareName: string, contentText: string | undefined): string {
	try {
		const data = extractCardData(contentText);
		if (data) {
			const summary = entryFor(bareName).summarize(data);
			if (summary) {
				return summary;
			}
		}
		return fallbackCollapsed(bareName);
	} catch {
		return fallbackCollapsed(bareName);
	}
}

/** Trim a raw blob for the expanded view, with a visible marker past the cap. */
function trimForExpanded(raw: string): string {
	if (raw.length <= EXPANDED_JSON_CAP) {
		return raw;
	}
	return `${raw.slice(0, EXPANDED_JSON_CAP)}… [+${raw.length - EXPANDED_JSON_CAP} chars trimmed]`;
}

/**
 * Expanded card: key fields (the collapsed line) plus the full JSON trimmed
 * to ~4KB with a visible marker. Fail-open like the collapsed card.
 */
export function expandedMcpCard(bareName: string, contentText: string | undefined): string {
	try {
		const collapsed = collapsedMcpCard(bareName, contentText);
		const raw = contentText ?? "";
		if (!raw) {
			return collapsed;
		}
		return `${collapsed}\n${trimForExpanded(raw)}`;
	} catch {
		return fallbackCollapsed(bareName);
	}
}

function sanitizeScalar(value: string): string {
	return value.replace(/[{}\"]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** One-line call summary for the tool-call row. Never JSON, never throws. */
export function renderMcpCallLine(bareName: string, args: unknown): string {
	try {
		const record = (typeof args === "object" && args !== null ? args : {}) as JsonRecord;
		const custom = entryFor(bareName).describeCall?.(record);
		if (custom) {
			return custom;
		}
		const pairs = Object.entries(record)
			.filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
			.slice(0, 4)
			.map(([key, value]) => `${key}=${sanitizeScalar(String(value))}`)
			.filter((pair) => pair.length > 2);
		return pairs.length > 0 ? `${bareName} ${pairs.join(" ")}` : bareName;
	} catch {
		return bareName;
	}
}

function summarizeLedger(data: JsonRecord): string | null {
	const servers = firstArr(data, "servers");
	if (!servers) {
		return null;
	}
	const up = servers.filter((s) => field(s, "connected") === true).length;
	const parts = servers.map((server) => {
		const name = firstStr(server, "name") ?? "?";
		const source = firstStr(server, "source") ?? "unknown source";
		return field(server, "connected") === true ? `✓ ${name} — ${source}` : `✗ ${name} — ${source}`;
	});
	if (parts.length === 0) {
		return "MCP: no servers armed";
	}
	return `MCP ${up}/${servers.length} connected: ${parts.join(" · ")}`;
}

interface McpResultLike {
	content?: Array<{ type: string; text?: string }>;
}

interface McpRenderOptionsLike {
	expanded: boolean;
}

function firstTextOf(result: McpResultLike | undefined): string | undefined {
	try {
		return result?.content?.find((part) => part?.type === "text" && typeof part.text === "string")?.text;
	} catch {
		return undefined;
	}
}

/**
 * Thin component wrappers for a ToolDefinition: renderCall shows the call
 * line, renderResult shows the collapsed or expanded card. Pure string logic
 * above stays directly unit-testable; these only wrap it in Text.
 */
export function mcpCardRenderers(
	bareName: string,
): Pick<ToolDefinition<any, any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall: (args: any) => new Text(renderMcpCallLine(bareName, args), 0, 0),
		renderResult: (result: any, options: any) => {
			const text = firstTextOf(result as McpResultLike);
			const expanded = (options as McpRenderOptionsLike | undefined)?.expanded === true;
			return new Text(expanded ? expandedMcpCard(bareName, text) : collapsedMcpCard(bareName, text), 0, 0);
		},
	};
}
