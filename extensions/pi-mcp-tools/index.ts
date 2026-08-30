import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { McpRegistry } from "./McpRegistry.js";
import { McpToolAdapter } from "./McpToolAdapter.js";
import { ConfigLoader } from "./ConfigLoader.js";
import type { McpLedger, McpServerSource } from "./ConfigLoader.js";
import { countEnabledTools, enabledToolNames } from "./toolFilter.js";
import type { McpConfig, McpServerConfig } from "./types.js";
import { Type } from "@sinclair/typebox";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

// Per-session MCP state. Everything here is re-derived inside session_start
// from ctx.cwd — never cached across sessions (cwd can change via /resume,
// and pi re-invokes the extension factory per session replacement).
let registry: McpRegistry | null = null;
let mcpConfig: McpConfig | null = null;
let enabledServers: Array<{ name: string; config: McpServerConfig }> = [];
let initError: string | null = null;
let initStats: { servers: number; tools: number; failed: string[] } | null = null;
let ledger: McpLedger = { entries: [], warnings: [], skippedCount: 0, untrustedCount: 0 };
const toolToServer = new Map<string, string>();
const registeredTools = new Set<string>();
let disabledTools = new Set<string>();
let armGeneration = 0;

function clearSessionState(): void {
  registry = null;
  mcpConfig = null;
  enabledServers = [];
  initError = null;
  initStats = null;
  ledger = { entries: [], warnings: [], skippedCount: 0, untrustedCount: 0 };
  toolToServer.clear();
  registeredTools.clear();
  disabledTools.clear();
}

const ARMED_SOURCES: ReadonlySet<McpServerSource> = new Set(["project:.mcp.json", "global settings"]);

function isArmedSource(source: McpServerSource): boolean {
  return ARMED_SOURCES.has(source);
}

function ledgerSummary(led: McpLedger): string {
  const project = led.entries.filter((e) => e.source === "project:.mcp.json").length;
  const global = led.entries.filter((e) => e.source === "global settings").length;
  const parts: string[] = [];
  if (project > 0) parts.push(`${project} project:.mcp.json`);
  if (global > 0) parts.push(`${global} global settings`);
  if (led.skippedCount > 0) parts.push(`${led.skippedCount} skipped`);
  if (led.untrustedCount > 0) parts.push(`${led.untrustedCount} untrusted`);
  return parts.join(", ");
}

/** Read the project config defensively: a converter error must log-and-degrade
 * to global-only, never propagate out of session_start. */
function safeLoadProjectMcpJson(ctx: ExtensionContext): ReturnType<typeof ConfigLoader.loadProjectMcpJson> {
  try {
    return ConfigLoader.loadProjectMcpJson(ctx.cwd);
  } catch (error) {
    console.error("[pi-mcp-tools] reading project .mcp.json failed; using global settings:", error);
    return { servers: [], skipped: [], exists: false, parseError: null };
  }
}

function safeIsProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted() === true;
  } catch (error) {
    console.error("[pi-mcp-tools] isProjectTrusted() failed; treating project as untrusted:", error);
    return false;
  }
}

export default async function (pi: ExtensionAPI) {
  try {
    registerExtensionSurface(pi);
  } catch (error) {
    // A throw out of this factory exits headless pi with code 1 — log and
    // degrade to a no-MCP session instead.
    console.error("[pi-mcp-tools] extension registration failed (MCP degraded):", error);
  }
}

function registerExtensionSurface(pi: ExtensionAPI): void {
  pi.registerFlag("mcp-debug", {
    description: "Enable MCP debug logging",
    type: "boolean",
    default: false,
  });
  const isDebugEnabled = () => pi.getFlag("mcp-debug") === true;

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++armGeneration;
    await armSession(pi, ctx, generation, isDebugEnabled);
  });

  pi.on("session_shutdown", async () => {
    await teardownSession();
  });

  pi.registerCommand("mcp-status", {
    description: "Show MCP config ledger and connection status",
    handler: async (_args, ctx) => {
      renderMcpStatus(ctx, isDebugEnabled);
    },
  });

  pi.registerCommand("mcp-reconnect", {
    description: "Reconnect to all MCP servers",
    handler: async (_args, ctx) => {
      if (!registry || !mcpConfig) {
        ctx.ui.notify("MCP: Not initialized", "warning");
        return;
      }
      ctx.ui.setStatus("mcp", "Reconnecting...");
      try {
        await registry.shutdown();
        const servers = ConfigLoader.getEnabledServers(mcpConfig);
        registry = new McpRegistry(servers);
        await registry.initialize();
        const connectedCount = registry.getConnectedCount();
        ctx.ui.setStatus("mcp", `MCP: ${connectedCount} servers`);
        ctx.ui.notify(`MCP reconnected: ${connectedCount} servers`, "info");
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        ctx.ui.setStatus("mcp", `Error: ${errorMessage}`);
        ctx.ui.notify(`MCP reconnect failed: ${errorMessage}`, "error");
      }
    },
  });

  pi.registerCommand("mcp-toggle", {
    description: "Toggle MCP server on/off",
    handler: async (args, ctx) => {
      if (!registry || !mcpConfig) {
        ctx.ui.notify("MCP: Not initialized", "warning");
        return;
      }
      const serverName = args?.trim();
      if (!serverName) {
        ctx.ui.notify("Usage: /mcp-toggle <server-name>", "warning");
        return;
      }
      const clients = registry.getClients();
      const client = clients.get(serverName);
      if (!client) {
        ctx.ui.notify(`Server '${serverName}' not found`, "error");
        return;
      }
      try {
        if (client.isConnected()) {
          await client.disconnect();
          ctx.ui.setStatus("mcp", `${serverName}: off`);
          ctx.ui.notify(`Server '${serverName}' disconnected`, "info");
        } else {
          await client.reconnect();
          ctx.ui.setStatus("mcp", `${serverName}: on`);
          ctx.ui.notify(`Server '${serverName}' connected`, "info");
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        ctx.ui.notify(`Toggle failed: ${errorMessage}`, "error");
      }
    },
  });

  pi.registerCommand("mcp-list", {
    description: "List all available MCP tools",
    handler: async (_args, ctx) => {
      if (!registry) {
        ctx.ui.notify("MCP: Not initialized", "warning");
        return;
      }
      const clients = registry.getClients();
      const toolList: string[] = [];
      for (const [serverName, client] of clients) {
        try {
          const tools = await client.listTools();
          toolList.push(`\n${serverName}:`);
          tools.forEach((tool) => {
            toolList.push(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
          });
        } catch {
          toolList.push(`\n${serverName}: [unable to list tools]`);
        }
      }
      ctx.ui.notify(`MCP Tools:${toolList.join("\n")}`, "info");
    },
  });

  pi.registerCommand("mcp-tools", {
    description: "Toggle MCP tools per server",
    handler: async (_args, ctx) => {
      if (registeredTools.size === 0) {
        ctx.ui.notify("MCP: No tools registered", "warning");
        return;
      }

      const toolsByServer = new Map<string, string[]>();
      for (const toolName of registeredTools) {
        const serverName = toolToServer.get(toolName) || "unknown";
        if (!toolsByServer.has(serverName)) {
          toolsByServer.set(serverName, []);
        }
        toolsByServer.get(serverName)!.push(toolName);
      }

      const items: SettingItem[] = [];
      const sortedServers = Array.from(toolsByServer.keys()).sort();

      for (const serverName of sortedServers) {
        const tools = toolsByServer.get(serverName)!.sort();
        for (const toolName of tools) {
          items.push({
            id: toolName,
            label: `${serverName}: ${toolName}`,
            currentValue: disabledTools.has(toolName) ? "disabled" : "enabled",
            values: ["enabled", "disabled"],
          });
        }
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("MCP Tools Configuration")), 1, 0));
        container.addChild(new Text("", 0, 0));

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 20),
          getSettingsListTheme(),
          (id, newValue) => {
            if (newValue === "enabled") {
              disabledTools.delete(id);
            } else {
              disabledTools.add(id);
            }
            ConfigLoader.saveDisabledTools(disabledTools);
            applyToolFilter(pi);
          },
          () => done(undefined),
        );

        container.addChild(settingsList);

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "mcp_list_servers",
    label: "List MCP Servers",
    description: "List all configured MCP servers with their config source (merge ledger) and connection status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate) {
      return buildLedgerReport();
    },
  });
}

/** Arm MCP for a session: load + merge config from ctx.cwd, connect, register
 * tools. Fully defensive — any error logs and degrades, never throws out of
 * the handler (a factory-level throw would exit headless pi). */
async function armSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  generation: number,
  isDebugEnabled: () => boolean,
): Promise<void> {
  try {
    // Defensive teardown of a previous arm (reload / repeated session_start
    // without an intervening session_shutdown).
    if (registry) {
      try {
        await registry.shutdown();
      } catch {
        // degraded teardown — the fresh arm below replaces all state anyway
      }
    }
    clearSessionState();

    disabledTools = ConfigLoader.loadDisabledTools();
    const globalConfig = ConfigLoader.loadFromSettingsJson();
    const project = safeLoadProjectMcpJson(ctx);
    const projectTrusted = safeIsProjectTrusted(ctx);
    const resolved = ConfigLoader.mergeMcpConfigs(globalConfig, project, projectTrusted);
    mcpConfig = resolved.config;
    ledger = resolved.ledger;

    if (generation !== armGeneration) {
      return; // superseded by a newer session_start
    }

    if (!mcpConfig) {
      const summary = ledgerSummary(ledger);
      ctx.ui.notify(summary ? `MCP: no servers armed (${summary})` : "MCP: no MCP servers configured", "info");
      return;
    }

    enabledServers = ConfigLoader.getEnabledServers(mcpConfig);
    if (enabledServers.length === 0) {
      ctx.ui.notify("MCP: no servers enabled", "info");
      return;
    }

    registry = new McpRegistry(enabledServers);
    await initRegistryAndRegisterTools(pi, generation);

    if (generation !== armGeneration) {
      return; // superseded while connecting
    }

    reportArmStatus(ctx, isDebugEnabled);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    initError = message;
    console.error("[pi-mcp-tools] session init failed (MCP degraded):", error);
    try {
      ctx.ui.setStatus("mcp", `Error: ${message}`);
      ctx.ui.notify(`MCP init failed: ${message}`, "error");
    } catch {
      // UI unavailable — the console error above is the record
    }
  } finally {
    applyToolFilter(pi);
  }
}

async function initRegistryAndRegisterTools(pi: ExtensionAPI, generation: number): Promise<void> {
  if (!registry) {
    return;
  }

  let initTimeoutTimer: NodeJS.Timeout | undefined;
  const initTimeout = new Promise<void>((_, reject) => {
    initTimeoutTimer = setTimeout(() => reject(new Error("Connection timeout (>30s)")), 30000);
    initTimeoutTimer.unref();
  });

  try {
    await Promise.race([registry.initialize(), initTimeout]);
  } catch (error: unknown) {
    initError = error instanceof Error ? error.message : "Unknown error";
    return;
  } finally {
    clearTimeout(initTimeoutTimer);
  }

  if (generation !== armGeneration) {
    return;
  }

  const clients = registry.getClients();
  let totalTools = 0;
  const failedServers: string[] = [];

  for (const server of enabledServers) {
    const client = clients.get(server.name);
    if (!client) {
      // Per-server connect failure — visible in the ledger report and the
      // arm notification without --mcp-debug (plan M3).
      failedServers.push(`${server.name}: failed to connect`);
      continue;
    }

    try {
      const tools = await client.listTools();
      for (const tool of tools) {
        try {
          const piTool = McpToolAdapter.convertToPiTool(
            tool,
            server.name,
            () => registry?.getClient(server.name),
            server.config.toolPrefix,
            server.config.filterPatterns,
          );
          if (piTool) {
            toolToServer.set(piTool.name, server.name);
            registeredTools.add(piTool.name);
            pi.registerTool(piTool);
            totalTools++;
          }
        } catch (err: unknown) {
          // Any per-tool failure (e.g. a poison filter pattern) skips the TOOL
          // only — never the server's remaining tools (plan M1).
          const detail = err instanceof Error ? err.message : "Unknown error";
          console.warn(`[pi-mcp-tools] tool '${String(tool?.name)}' of server '${server.name}' skipped: ${detail}`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      failedServers.push(`${server.name}: ${message}`);
    }
  }

  initStats = { servers: clients.size, tools: totalTools, failed: failedServers };
}

function reportArmStatus(ctx: ExtensionContext, isDebugEnabled: () => boolean): void {
  const connectedCount = registry?.getConnectedCount() ?? 0;
  const toolCount = initStats?.tools ?? 0;
  const enabledCount = countEnabledTools(registeredTools, disabledTools);

  if (initError) {
    ctx.ui.setStatus("mcp", `Error: ${initError}`);
    ctx.ui.notify(`MCP init failed: ${initError}`, "error");
    return;
  }

  ctx.ui.setStatus(
    "mcp",
    `MCP: ${connectedCount}/${enabledServers.length} servers, ${enabledCount}/${toolCount} tools`,
  );

  // The notification names the merged source (plan M3); failures are reported
  // unconditionally — not only under --mcp-debug.
  const summary = ledgerSummary(ledger);
  ctx.ui.notify(`MCP: ${enabledServers.length} servers armed (${summary})`, "info");
  if (initStats && initStats.failed.length > 0) {
    ctx.ui.notify(`MCP failed: ${initStats.failed.join(", ")}`, "warning");
  }

  if (isDebugEnabled() && initStats) {
    ctx.ui.notify(`MCP: ${initStats.servers} servers, ${initStats.tools} tools loaded`, "info");
  }
}

async function teardownSession(): Promise<void> {
  if (registry) {
    try {
      await registry.shutdown();
    } catch {
      // best-effort teardown
    }
  }
  clearSessionState();
}

interface LedgerServerRecord {
  name: string;
  source: McpServerSource;
  detail?: string;
  connected?: boolean;
  error?: string;
}

/** Build the mcp_list_servers payload from the merge ledger (plan M3/R3):
 * rendered from the ledger, not registry.getClients(), so skipped and
 * untrusted servers — which have no client — are visible too. */
function buildLedgerReport(): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const clients = registry?.getClients();
  const armedNames = new Set(enabledServers.map((s) => s.name));

  const servers: LedgerServerRecord[] = ledger.entries.map((entry) => {
    const record: LedgerServerRecord = { name: entry.name, source: entry.source };
    if (entry.detail) {
      record.detail = entry.detail;
    }
    if (isArmedSource(entry.source) && armedNames.has(entry.name)) {
      const client = clients?.get(entry.name);
      record.connected = client ? client.isConnected() : false;
      if (!client) {
        record.error = "failed to connect";
      } else if (!client.isConnected()) {
        record.error = "disconnected";
      }
    }
    return record;
  });

  const payload: Record<string, unknown> = {
    initialized: registry !== null,
    servers,
    skippedCount: ledger.skippedCount,
    untrustedCount: ledger.untrustedCount,
  };
  if (ledger.warnings.length > 0) {
    payload.warnings = [...ledger.warnings];
  }
  const failures: string[] = [];
  if (initError) {
    failures.push(`init: ${initError}`);
  }
  if (initStats) {
    failures.push(...initStats.failed);
  }
  if (failures.length > 0) {
    payload.failures = failures;
  }

  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function renderMcpStatus(ctx: ExtensionContext, isDebugEnabled: () => boolean): void {
  const lines: string[] = ["MCP config ledger:"];
  for (const warning of ledger.warnings) {
    lines.push(`  ⚠ ${warning}`);
  }
  if (ledger.entries.length === 0) {
    lines.push("  (no MCP servers configured)");
  }
  const armedNames = new Set(enabledServers.map((s) => s.name));
  for (const entry of ledger.entries) {
    if (isArmedSource(entry.source) && armedNames.has(entry.name)) {
      const client = registry?.getClient(entry.name);
      const connected = client ? client.isConnected() : false;
      const note = !client ? " (failed to connect)" : "";
      lines.push(`  ${connected ? "✓" : "✗"} ${entry.name} — ${entry.source}${note}`);
    } else {
      const detail = entry.detail ? ` (${entry.detail})` : "";
      lines.push(`  • ${entry.name} — ${entry.source}${detail}`);
    }
  }
  lines.push(`  summary: ${ledgerSummary(ledger) || "none"}`);

  const failures: string[] = [];
  if (initError) {
    failures.push(`init: ${initError}`);
  }
  if (initStats) {
    failures.push(...initStats.failed);
  }
  if (failures.length > 0) {
    lines.push("  failures:");
    for (const failure of failures) {
      lines.push(`    ${failure}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");

  if (registry && enabledServers.length > 0) {
    ctx.ui.setStatus("mcp", "Checking...");
    registry
      .healthCheck()
      .then((results) => {
        let healthyCount = 0;
        const status: string[] = [];
        for (const [name, healthy] of results) {
          if (healthy) {
            healthyCount++;
          }
          status.push(healthy ? `✓ ${name}` : `✗ ${name}`);
        }
        ctx.ui.setStatus("mcp", `Status: ${healthyCount}/${results.size} servers`);
        if (status.length > 0) {
          ctx.ui.notify(`MCP Status:\n${status.join("\n")}`, "info");
        }
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        ctx.ui.notify(`Status check failed: ${errorMessage}`, "error");
      });
  } else {
    ctx.ui.setStatus("mcp", "MCP: not armed");
    if (isDebugEnabled() && !registry) {
      ctx.ui.notify("MCP: Not initialized", "warning");
    }
  }
}

function applyToolFilter(pi: ExtensionAPI): void {
  const allTools = pi.getAllTools();
  const enabled = enabledToolNames(
    allTools.map((t) => t.name),
    registeredTools,
    disabledTools,
  );
  pi.setActiveTools(enabled);
}
