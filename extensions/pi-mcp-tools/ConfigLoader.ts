import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { convertClaudeMcpServers } from "./claudeMcpConfig.js";
import type { ClaudeConversion } from "./claudeMcpConfig.js";
import type { McpConfig, McpServerConfig, LocalMcpServerConfig, RemoteMcpServerConfig } from "./types.js";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Where a server's config came from, as recorded in the merge ledger (plan M3). */
export type McpServerSource =
  | "project:.mcp.json"
  | "global settings"
  | "skipped:unsupported-shape"
  | "skipped:unexpanded-var"
  | "untrusted-project";

export interface McpLedgerEntry {
  name: string;
  source: McpServerSource;
  detail?: string;
}

export interface McpLedger {
  entries: McpLedgerEntry[];
  /** Non-fatal notes (unparseable project file, untrusted project). */
  warnings: string[];
  /** Entries whose source starts with "skipped:". */
  skippedCount: number;
  /** Entries gated out by pi project trust. */
  untrustedCount: number;
}

export interface ProjectMcpJsonResult extends ClaudeConversion {
  /** True when <cwd>/.mcp.json exists (even if empty or unparseable). */
  exists: boolean;
  /** Set when the file exists but is not valid JSON; servers is then empty. */
  parseError: string | null;
}

function summarizeLedger(entries: McpLedgerEntry[], warnings: string[]): McpLedger {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.name));
  return {
    entries: sorted,
    warnings,
    skippedCount: sorted.filter((e) => e.source.startsWith("skipped:")).length,
    untrustedCount: sorted.filter((e) => e.source === "untrusted-project").length,
  };
}

export class ConfigLoader {
  /** Load MCP config from user-global settings.json only.
   *
   * Project config comes from `<cwd>/.mcp.json` via loadProjectMcpJson and is
   * merged project-over-global by mergeMcpConfigs at session_start, gated by
   * pi project trust. Project-local .pi/settings.json is still deliberately
   * NOT read: user scope remains the always-trusted fallback.
   */
  static loadFromSettingsJson(): McpConfig | null {
    return this.loadFromFile(GLOBAL_SETTINGS_PATH);
  }

  static loadFromFile(path: string): McpConfig | null {
    if (!existsSync(path)) {
      return null;
    }

    try {
      const content = readFileSync(path, "utf-8");
      const settings = JSON.parse(content);
      return settings.mcp ?? null;
    } catch {
      return null;
    }
  }

  /** Load and convert the claude-format `.mcp.json` in the given directory.
   *
   * - No file -> exists:false, nothing armed from project scope.
   * - Unparseable file -> parseError set, servers empty: the caller must fall
   *   back to global-only (never a partial arm, plan M1).
   * - Malformed entries -> recorded in `skipped`; the good entries still arm.
   */
  static loadProjectMcpJson(cwd: string): ProjectMcpJsonResult {
    const path = join(cwd, ".mcp.json");
    if (!existsSync(path)) {
      return { servers: [], skipped: [], exists: false, parseError: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pi-mcp-tools] project .mcp.json at ${path} is unparseable (${message}); using global settings only`,
      );
      return { servers: [], skipped: [], exists: true, parseError: message };
    }

    const mcpServers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (mcpServers === undefined || mcpServers === null) {
      // A .mcp.json without mcpServers declares nothing: inert.
      return { servers: [], skipped: [], exists: true, parseError: null };
    }

    return { ...convertClaudeMcpServers(mcpServers), exists: true, parseError: null };
  }

  /** Project-over-global merge with the trust gate, producing the armed config
   * plus the merge ledger (plan M1/M2/M3).
   *
   * - project null or not existing -> global-only.
   * - project present but untrusted -> global-only; every project-declared
   *   name is recorded as `untrusted-project`.
   * - project present, trusted, unparseable -> global-only + warning (never a
   *   partial arm).
   * - project present, trusted, parsed -> project entries win per name; a
   *   skipped project entry shadows the same-named global entry (the project
   *   claimed that name and it is broken — arming a stale global instead would
   *   hide the failure), recorded as `skipped:*`.
   */
  static mergeMcpConfigs(
    globalConfig: McpConfig | null,
    project: ProjectMcpJsonResult | null,
    projectTrusted: boolean,
  ): { config: McpConfig | null; ledger: McpLedger } {
    const globalEntries = Object.entries(globalConfig ?? {});
    const warnings: string[] = [];

    if (!project || !project.exists) {
      const entries: McpLedgerEntry[] = globalEntries.map(([name]) => ({ name, source: "global settings" }));
      return { config: globalConfig ?? null, ledger: summarizeLedger(entries, warnings) };
    }

    if (!projectTrusted) {
      warnings.push("project is not trusted; project .mcp.json ignored, using global settings");
      console.warn("[pi-mcp-tools] project is not trusted; project .mcp.json ignored, using global settings");
      const entries: McpLedgerEntry[] = globalEntries.map(([name]) => ({ name, source: "global settings" }));
      // Additive, not shadowing: a same-named global entry genuinely armed
      // (global-only fallback) and the gated project declaration must stay
      // visible too (the headless MCP-vanish signal, premortem MUST-2).
      for (const server of project.servers) {
        entries.push({ name: server.name, source: "untrusted-project" });
      }
      for (const skipped of project.skipped) {
        entries.push({ name: skipped.name, source: "untrusted-project" });
      }
      return { config: globalConfig ?? null, ledger: summarizeLedger(entries, warnings) };
    }

    if (project.parseError) {
      warnings.push(`project .mcp.json unparseable (${project.parseError}); using global settings only`);
      const entries: McpLedgerEntry[] = globalEntries.map(([name]) => ({ name, source: "global settings" }));
      return { config: globalConfig ?? null, ledger: summarizeLedger(entries, warnings) };
    }

    const entries: McpLedgerEntry[] = [];
    const projectNames = new Set<string>();
    const merged: McpConfig = { ...(globalConfig ?? {}) };

    for (const server of project.servers) {
      projectNames.add(server.name);
      merged[server.name] = server.config;
      entries.push({ name: server.name, source: "project:.mcp.json" });
    }
    for (const skippedEntry of project.skipped) {
      projectNames.add(skippedEntry.name);
      delete merged[skippedEntry.name];
      const source: McpServerSource =
        skippedEntry.reason === "unexpanded-var" ? "skipped:unexpanded-var" : "skipped:unsupported-shape";
      entries.push({ name: skippedEntry.name, source, detail: skippedEntry.detail });
      console.warn(
        `[pi-mcp-tools] server '${skippedEntry.name}' from project .mcp.json skipped (${skippedEntry.reason}): ${skippedEntry.detail}`,
      );
    }
    for (const [name] of globalEntries) {
      if (!projectNames.has(name)) {
        entries.push({ name, source: "global settings" });
      }
    }

    const config = Object.keys(merged).length > 0 ? merged : null;
    return { config, ledger: summarizeLedger(entries, warnings) };
  }

  static loadDisabledTools(): Set<string> {
    if (!existsSync(GLOBAL_SETTINGS_PATH)) {
      return new Set();
    }

    try {
      const content = readFileSync(GLOBAL_SETTINGS_PATH, "utf-8");
      const settings = JSON.parse(content);
      const disabled = settings.mcpDisabledTools;
      if (Array.isArray(disabled)) {
        return new Set(disabled);
      }
      return new Set();
    } catch {
      return new Set();
    }
  }

  /** Persist mcpDisabledTools atomically (plan M6/D4): write a unique temp
   * file in the same directory, then rename over settings.json. A crash or a
   * racing scaffold os.replace can never leave a truncated settings.json. */
  static saveDisabledTools(disabledTools: Set<string>): void {
    if (!existsSync(GLOBAL_SETTINGS_PATH)) {
      console.error(`[pi-mcp-tools] Cannot save disabled tools: ${GLOBAL_SETTINGS_PATH} not found`);
      return;
    }

    let tempPath: string | null = null;
    try {
      const content = readFileSync(GLOBAL_SETTINGS_PATH, "utf-8");
      const settings = JSON.parse(content);
      settings.mcpDisabledTools = Array.from(disabledTools);
      tempPath = join(dirname(GLOBAL_SETTINGS_PATH), `.pi-settings-${process.pid}-${randomUUID()}.tmp`);
      writeFileSync(tempPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      renameSync(tempPath, GLOBAL_SETTINGS_PATH);
      tempPath = null;
    } catch (error) {
      console.error(`[pi-mcp-tools] Failed to save disabled tools to ${GLOBAL_SETTINGS_PATH}:`, error);
    } finally {
      if (tempPath) {
        try {
          unlinkSync(tempPath);
        } catch {
          // temp file already gone — nothing to clean up
        }
      }
    }
  }

  static validateConfig(config: McpConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config || typeof config !== "object" || Object.keys(config).length === 0) {
      errors.push("MCP config must be a non-empty object");
      return { valid: false, errors };
    }

    for (const [name, server] of Object.entries(config)) {
      if (!server.type || !["local", "remote"].includes(server.type)) {
        errors.push(`Server '${name}' has invalid or missing 'type'`);
        continue;
      }

      if (server.type === "local") {
        const localServer = server as LocalMcpServerConfig;
        if (!localServer.command || !Array.isArray(localServer.command)) {
          errors.push(`Local server '${name}' missing or invalid 'command' array`);
        }
      }

      if (server.type === "remote") {
        const remoteServer = server as RemoteMcpServerConfig;
        if (!remoteServer.url) {
          errors.push(`Remote server '${name}' missing 'url'`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  static getEnabledServers(config: McpConfig): Array<{ name: string; config: McpServerConfig }> {
    return Object.entries(config)
      .filter(([_, server]) => server.enabled !== false)
      .map(([name, cfg]) => ({ name, config: cfg }));
  }
}
