import { homedir } from "os";
import type { LocalMcpServerConfig, McpServerConfig, RemoteMcpServerConfig } from "./types.js";

/**
 * Converter for claude-format `mcpServers` maps (as written by the ai-badger
 * scaffold into a project's `.mcp.json`) into the fork's McpServerConfig shape.
 *
 * Mechanisms (plan M1 / R2 / D5):
 * - `type:"stdio"` or absent `type` -> local; `type:"http"/"sse"` + url -> remote.
 * - `${HOME}` prefix expanded in command/args/cwd via os.homedir(); any other
 *   unexpanded `${VAR}` skips the entry (the fork spawning the literal string
 *   would fail silently with ENOENT).
 * - `tools:["*"]`/empty/absent -> no filtering (never filterPatterns: a literal
 *   pass-through would run `new RegExp("*")` per tool and kill every tool of
 *   every scaffolded server). Glob-ish patterns -> anchored regex; non-glob
 *   patterns pass through unchanged (fork regex semantics).
 *
 * The converter is pure: it never logs and never touches the filesystem.
 * Callers record skips in the merge ledger and log warnings.
 */

export type ClaudeSkipReason = "unsupported-shape" | "unexpanded-var";

export interface ClaudeSkippedEntry {
  name: string;
  reason: ClaudeSkipReason;
  detail: string;
}

export interface ClaudeConversion {
  servers: Array<{ name: string; config: McpServerConfig }>;
  skipped: ClaudeSkippedEntry[];
}

const HOME_TOKEN = "${HOME}";
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

/** Expand a leading ${HOME} prefix to the real home directory. */
function expandHome(value: string): string {
  if (!value.startsWith(HOME_TOKEN)) {
    return value;
  }
  return homedir() + value.slice(HOME_TOKEN.length);
}

/** Return the first unexpanded ${VAR} name in the string, if any. */
function findUnexpandedVar(value: string): string | null {
  const match = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value);
  return match ? match[1] : null;
}

function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** Translate a glob pattern into an anchored regex. Escapes everything that
 * is regex-special, so the output can never be a poison pattern. */
export function globToAnchoredRegex(glob: string): string {
  let body = "";
  for (const ch of glob) {
    if (ch === "*") {
      body += ".*";
    } else if (ch === "?") {
      body += ".";
    } else if (REGEX_SPECIAL.test(ch)) {
      body += "\\" + ch;
    } else {
      body += ch;
    }
  }
  return `^${body}$`;
}

/** Map a claude `tools` field to fork filterPatterns (or null = no filtering).
 * Fail-open by design: malformed input never becomes a tool filter. */
function convertToolsFilter(tools: unknown): string[] | null {
  if (tools === undefined || tools === null) {
    return null;
  }
  if (!Array.isArray(tools)) {
    return null;
  }
  if (tools.length === 0) {
    return null;
  }
  if (tools.includes("*")) {
    // match-all wins; combining "*" with concrete patterns is incoherent.
    return null;
  }
  const patterns: string[] = [];
  for (const entry of tools) {
    if (typeof entry !== "string" || entry === "") {
      continue;
    }
    patterns.push(isGlob(entry) ? globToAnchoredRegex(entry) : entry);
  }
  return patterns.length > 0 ? patterns : null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === "string");
}

type EntryResult = { kind: "ok"; config: McpServerConfig } | { kind: "skip"; reason: ClaudeSkipReason; detail: string };

function skip(reason: ClaudeSkipReason, detail: string): EntryResult {
  return { kind: "skip", reason, detail };
}

function convertLocalEntry(value: Record<string, unknown>): EntryResult {
  const command = value.command;
  if (typeof command !== "string" || command.trim() === "") {
    return skip("unsupported-shape", "local entry requires a string 'command'");
  }

  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    return skip("unsupported-shape", "'args' must be an array of strings");
  }

  const cwd = value.cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    return skip("unsupported-shape", "'cwd' must be a string");
  }

  const env = value.env;
  if (env !== undefined && !isStringRecord(env)) {
    return skip("unsupported-shape", "'env' must be an object of string values");
  }

  const stringArgs = args as string[];
  const commandParts = [expandHome(command), ...stringArgs.map(expandHome)];
  const expandedCwd = cwd === undefined ? undefined : expandHome(cwd);

  const scanned: Array<[string, string]> = commandParts.map((part, i) => [
    i === 0 ? "command" : `args[${i - 1}]`,
    part,
  ]);
  if (expandedCwd !== undefined) {
    scanned.push(["cwd", expandedCwd]);
  }
  for (const [where, text] of scanned) {
    const varName = findUnexpandedVar(text);
    if (varName) {
      return skip("unexpanded-var", `unexpanded \${${varName}} in ${where}`);
    }
  }

  const config: LocalMcpServerConfig = { type: "local", command: commandParts };
  if (env !== undefined) {
    config.env = env as Record<string, string>;
  }
  if (expandedCwd !== undefined) {
    config.cwd = expandedCwd;
  }
  const filterPatterns = convertToolsFilter(value.tools);
  if (filterPatterns) {
    config.filterPatterns = filterPatterns;
  }
  return { kind: "ok", config };
}

function convertRemoteEntry(value: Record<string, unknown>): EntryResult {
  const url = value.url;
  if (typeof url !== "string" || url.trim() === "") {
    return skip("unsupported-shape", "remote entry requires a string 'url'");
  }

  const headers = value.headers;
  if (headers !== undefined && !isStringRecord(headers)) {
    return skip("unsupported-shape", "'headers' must be an object of string values");
  }

  const config: RemoteMcpServerConfig = { type: "remote", url };
  if (headers !== undefined) {
    config.headers = headers as Record<string, string>;
  }
  const filterPatterns = convertToolsFilter(value.tools);
  if (filterPatterns) {
    config.filterPatterns = filterPatterns;
  }
  return { kind: "ok", config };
}

function convertEntry(value: unknown): EntryResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return skip("unsupported-shape", "entry is not an object");
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;

  if (type === undefined || type === "stdio") {
    return convertLocalEntry(record);
  }
  if (type === "http" || type === "sse") {
    return convertRemoteEntry(record);
  }
  return skip("unsupported-shape", `unknown type "${type}"`);
}

/** Convert a claude-format `mcpServers` map. Bad entries are skipped with a
 * reason; good entries still arm ("other entries still arm", plan M1). */
export function convertClaudeMcpServers(raw: unknown): ClaudeConversion {
  const result: ClaudeConversion = { servers: [], skipped: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const converted = convertEntry(value);
    if (converted.kind === "ok") {
      result.servers.push({ name, config: converted.config });
    } else {
      result.skipped.push({ name, reason: converted.reason, detail: converted.detail });
    }
  }
  return result;
}
