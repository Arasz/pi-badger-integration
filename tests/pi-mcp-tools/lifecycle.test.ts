/**
 * Mirrored port of the fork's tests/lifecycle.test.ts (plan rev 3 §2 P2, AC 4):
 * the session_start lifecycle (M2), merge-ledger reporting via the
 * mcp_list_servers tool (M3/R3/R4) and the defensive-init contract, run against
 * the canonical flat copy with bun:test.
 *
 * R6 hermeticity: the os.homedir mock is installed via mock.module BEFORE the
 * extension modules are dynamically imported (ConfigLoader derives the global
 * settings path from it at import time), and the SDK Client/transport modules
 * are mocked so no test can reach the real SDK or spawn a real server. Nothing
 * in this file may touch the real ~/.pi.
 *
 * NOTE: fakeHome is IDENTICAL across the three pi-mcp-tools test files that
 * mock os (claude-mcp-config, config-loader-project, lifecycle): bun's module
 * mock registry is process-wide for dynamically imported modules and the
 * FIRST registration wins, so every file must agree on the fake home or
 * ConfigLoader's import-time GLOBAL_SETTINGS_PATH capture diverges.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as osActual from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigLoader as ConfigLoaderType } from "../../extensions/pi-mcp-tools/ConfigLoader.ts";

/** The REAL home: bun's mock.module mutates the captured os namespace in
 * place, so osActual.homedir() is NOT trustworthy in these files (an earlier
 * file's registration in the same worker already rewrote it) — $HOME is the
 * one homedir source a module mock cannot touch. */
const realHome = process.env.HOME ?? osActual.homedir();
const fakeHome = `/tmp/pi-mcp-test-home-${process.pid}`;

mock.module("node:os", () => ({ ...osActual, homedir: () => fakeHome }));
mock.module("os", () => ({ ...osActual, homedir: () => fakeHome }));

const sdk = {
	clients: [] as Array<Record<string, unknown>>,
	tools: [] as Array<{ name: string; description?: string; inputSchema?: unknown }>,
	failConnect: false,
};
const stdioCtorCalls: unknown[] = [];

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		constructor() {
			const instance = {
				connect: async () => {
					if (sdk.failConnect) throw new Error("spawn failed");
				},
				close: async () => undefined,
				listTools: async () => ({ tools: sdk.tools }),
				callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
				setNotificationHandler: () => undefined,
				onclose: null,
				onerror: null,
			};
			sdk.clients.push(instance);
			return instance;
		}
	},
}));

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: function (options: unknown) {
		stdioCtorCalls.push(options);
		return { _fake: true };
	},
}));

const { default: piMcpToolsFactory } = await import("../../extensions/pi-mcp-tools/index.ts");
const { ConfigLoader } = await import("../../extensions/pi-mcp-tools/ConfigLoader.ts");
const loader = ConfigLoader as typeof ConfigLoaderType;

/** Insurance against bun's worker-wide module-registry leak: if a later file in
 * this worker loads tests/setup.ts while an os mock is active, setup.ts resolves
 * its jiti loader under homedir(). Mirror the real global pi package into the
 * fake home so that resolution keeps working. Called again after every fake-home
 * reset below (the reset removes the mirror with the rest of the tree). */
function insureFakeHomeSetupCompat(): void {
	try {
		// Mirror at the node_modules LEVEL: createRequire does not follow
		// symlinks when walking parent directories, so a package-level mirror
		// cannot resolve hoisted deps (jiti) — a node_modules-level one can,
		// because each walk step stats through the link.
		const realGlobalNm = join(realHome, ".bun", "install", "global", "node_modules");
		const mirrorGlobalNm = join(fakeHome, ".bun", "install", "global", "node_modules");
		mkdirSync(dirname(mirrorGlobalNm), { recursive: true });
		rmSync(mirrorGlobalNm, { force: true, recursive: true });
		symlinkSync(realGlobalNm, mirrorGlobalNm, "dir");
	} catch {
		// best-effort: a leaked mock without the mirror degrades loudly, never dangerously
	}
}
insureFakeHomeSetupCompat();

function resetFakeHome(): void {
	rmSync(fakeHome, { recursive: true, force: true });
	insureFakeHomeSetupCompat();
}

/** Capture a console method without a spy framework: manual override + restore. */
function captureConsoleMethod(method: "error" | "warn"): { calls: unknown[][]; restore(): void } {
	const original = console[method];
	const calls: unknown[][] = [];
	console[method] = (...args: unknown[]) => {
		calls.push(args);
	};
	return { calls, restore: () => (console[method] = original) };
}

function createMockPi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const tools: Array<{ name: string; [k: string]: unknown }> = [];
	const commands = new Map<string, { description: string; handler: (args: unknown, ctx: ExtensionContext) => Promise<void> | void }>();
	const flags: Array<{ name: string; options: unknown }> = [];
	const getFlagCalls: string[] = [];
	let registerToolImpl: ((tool: { name: string }) => void) | null = null;

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: { name: string }) => {
			if (registerToolImpl) registerToolImpl(tool);
			else tools.push(tool);
		},
		registerCommand: (
			name: string,
			options: { description: string; handler: (args: unknown, ctx: ExtensionContext) => Promise<void> | void },
		) => {
			commands.set(name, options);
		},
		registerFlag: (name: string, options: unknown) => {
			flags.push({ name, options });
		},
		getFlag: (name: string) => {
			getFlagCalls.push(name);
			return false;
		},
		getAllTools: () => [] as Array<{ name: string }>,
		setActiveTools: () => undefined,
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		raw: pi,
		handlers,
		tools,
		commands,
		flags,
		getFlagCalls,
		set registerToolImpl(impl: (tool: { name: string }) => void) {
			registerToolImpl = impl;
		},
	};
}

function createMockCtx(cwd: string, trusted = true): ExtensionContext {
	const notifyCalls: unknown[][] = [];
	const setStatusCalls: unknown[][] = [];
	const ctx = {
		cwd,
		mode: "print",
		hasUI: false,
		isProjectTrusted: () => trusted,
		ui: {
			notify: (...args: unknown[]) => {
				notifyCalls.push(args);
			},
			setStatus: (...args: unknown[]) => {
				setStatusCalls.push(args);
			},
		},
		notifyCalls,
		setStatusCalls,
	};
	return ctx as unknown as ExtensionContext;
}

const startEvent = { type: "session_start", reason: "startup" };
const shutdownEvent = { type: "session_shutdown", reason: "quit" };

async function startSession(harness: ReturnType<typeof createMockPi>, cwd: string, trusted = true) {
	const ctx = createMockCtx(cwd, trusted);
	await harness.handlers.get("session_start")!(startEvent, ctx);
	return ctx;
}

function listServersTool(harness: ReturnType<typeof createMockPi>): { name: string; execute: Function } {
	const tool = harness.tools.find((t) => t.name === "mcp_list_servers");
	if (!tool) throw new Error("mcp_list_servers tool not registered");
	return tool as { name: string; execute: Function };
}

async function listServersReport(harness: ReturnType<typeof createMockPi>): Promise<any> {
	const result = await listServersTool(harness).execute("call-1", {}, undefined, undefined);
	return (result as { details: unknown }).details;
}

function notifyMessages(ctx: ExtensionContext): string[] {
	return (ctx as unknown as { notifyCalls: unknown[][] }).notifyCalls.map((c) => String(c[0]));
}

function setStatusCalls(ctx: ExtensionContext): unknown[][] {
	return (ctx as unknown as { setStatusCalls: unknown[][] }).setStatusCalls;
}

describe("pi-mcp-tools lifecycle", () => {
	let harness: ReturnType<typeof createMockPi>;

	beforeEach(() => {
		resetFakeHome();
		sdk.clients.length = 0;
		sdk.tools = [];
		sdk.failConnect = false;
		stdioCtorCalls.length = 0;
		harness = createMockPi();
	});

	afterEach(() => {
		resetFakeHome();
	});

	test("arms project .mcp.json servers from ctx.cwd at session_start", async () => {
		const cwd = join(fakeHome, "proj-a");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { hermes: { command: "node", args: ["hermes.js"], tools: ["*"] } } }));
		sdk.tools = [{ name: "ping", description: "ping", inputSchema: { type: "object" } }];

		await piMcpToolsFactory(harness.pi);
		const ctx = await startSession(harness, cwd, true);

		const report = await listServersReport(harness);
		expect(report.initialized).toBe(true);
		expect(report.servers).toHaveLength(1);
		expect(report.servers[0]).toMatchObject({ name: "hermes", source: "project:.mcp.json", connected: true });
		expect(report.skippedCount).toBe(0);

		// The registered pi tool uses the default mcp_<server> prefix.
		expect(harness.tools.some((t) => t.name === "mcp_hermes_ping")).toBe(true);
		// Exactly one SDK client was constructed — no real server spawn.
		expect(sdk.clients.length).toBe(1);
		// session_start status names the merged source.
		expect(notifyMessages(ctx).some((m) => m.includes("project:.mcp.json"))).toBe(true);
		expect(
			setStatusCalls(ctx).some((c) => c[0] === "mcp" && String(c[1]).includes("1/1")),
		).toBe(true);
	});

	test("falls back to global settings when no project file exists", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } }));
		const cwd = join(fakeHome, "proj-empty");
		mkdirSync(cwd, { recursive: true });

		await piMcpToolsFactory(harness.pi);
		await startSession(harness, cwd, true);

		const report = await listServersReport(harness);
		expect(report.servers).toHaveLength(1);
		expect(report.servers[0]).toMatchObject({ name: "globalsrv", source: "global settings", connected: true });
	});

	test("falls back to global-only when the project is not trusted, with untrusted-project ledger rows", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } }));
		const cwd = join(fakeHome, "proj-untrusted");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { projsrv: { command: "node", args: ["p.js"] } } }));
		const captured = captureConsoleMethod("warn");

		try {
			await piMcpToolsFactory(harness.pi);
			await startSession(harness, cwd, false);

			const report = await listServersReport(harness);
			const projEntry = report.servers.find((s: any) => s.name === "projsrv");
			expect(projEntry).toMatchObject({ name: "projsrv", source: "untrusted-project" });
			expect(projEntry.connected).toBeUndefined();
			expect(report.servers.find((s: any) => s.name === "globalsrv")).toMatchObject({
				source: "global settings",
				connected: true,
			});
			expect(report.untrustedCount).toBe(1);
			// Only the global server actually connected.
			expect(sdk.clients.length).toBe(1);
		} finally {
			captured.restore();
		}
	});

	test("project config wins over global for the same server name", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ mcp: { hermes: { type: "local", command: ["global-hermes"] } } }),
		);
		const cwd = join(fakeHome, "proj-precedence");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { hermes: { command: "project-hermes", args: ["--flag"] } } }));

		await piMcpToolsFactory(harness.pi);
		await startSession(harness, cwd, true);

		expect(stdioCtorCalls.at(-1)).toMatchObject({ command: "project-hermes", args: ["--flag"] });

		const report = await listServersReport(harness);
		expect(report.servers[0]).toMatchObject({ name: "hermes", source: "project:.mcp.json" });
	});

	test("an unparseable project file yields global-only fallback plus a warning, never a partial arm", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } }));
		const cwd = join(fakeHome, "proj-broken");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), "{ not json at all", "utf-8");

		await piMcpToolsFactory(harness.pi);
		const ctx = await startSession(harness, cwd, true);

		const report = await listServersReport(harness);
		expect(report.servers).toHaveLength(1);
		expect(report.servers[0].name).toBe("globalsrv");
		expect(report.warnings.some((w: string) => w.includes("unparseable"))).toBe(true);
		expect(notifyMessages(ctx).some((m) => m.includes("global settings"))).toBe(true);
	});

	test("skipped project entries are recorded in the ledger while good entries still arm", async () => {
		const cwd = join(fakeHome, "proj-mixed");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					good: { command: "node", args: ["g.js"] },
					broken: { type: "mystery" },
				},
			}),
		);

		await piMcpToolsFactory(harness.pi);
		await startSession(harness, cwd, true);

		const report = await listServersReport(harness);
		expect(report.servers.find((s: any) => s.name === "good")).toMatchObject({
			source: "project:.mcp.json",
			connected: true,
		});
		expect(report.servers.find((s: any) => s.name === "broken")).toMatchObject({ source: "skipped:unsupported-shape" });
		expect(report.skippedCount).toBe(1);
		expect(sdk.clients.length).toBe(1);
	});

	test("re-derives config from ctx.cwd every session — never cached", async () => {
		const cwdA = join(fakeHome, "proj-a");
		const cwdB = join(fakeHome, "proj-b");
		mkdirSync(cwdA, { recursive: true });
		mkdirSync(cwdB, { recursive: true });
		writeFileSync(join(cwdA, ".mcp.json"), JSON.stringify({ mcpServers: { srvA: { command: "node", args: ["a.js"] } } }));
		writeFileSync(join(cwdB, ".mcp.json"), JSON.stringify({ mcpServers: { srvB: { command: "node", args: ["b.js"] } } }));

		await piMcpToolsFactory(harness.pi);
		await startSession(harness, cwdA, true);
		expect(listServersTool(harness)).toBeDefined();

		await harness.handlers.get("session_shutdown")!(shutdownEvent, createMockCtx(cwdA));
		await startSession(harness, cwdB, true);

		const report = await listServersReport(harness);
		const names = report.servers.map((s: any) => s.name);
		expect(names).toContain("srvB");
		expect(names).not.toContain("srvA");
		expect(report.servers.find((s: any) => s.name === "srvB")).toMatchObject({
			source: "project:.mcp.json",
			connected: true,
		});
	});

	test("session_shutdown tears down; a second session_start re-arms", async () => {
		const cwd = join(fakeHome, "proj-teardown");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "node", args: ["s.js"] } } }));

		await piMcpToolsFactory(harness.pi);
		await startSession(harness, cwd, true);
		expect((await listServersReport(harness)).initialized).toBe(true);

		await harness.handlers.get("session_shutdown")!(shutdownEvent, createMockCtx(cwd));
		const afterShutdown = await listServersReport(harness);
		expect(afterShutdown.initialized).toBe(false);
		expect(afterShutdown.servers).toHaveLength(0);

		// Second session_start re-arms (same cwd, new session).
		await startSession(harness, cwd, true);
		const reArmed = await listServersReport(harness);
		expect(reArmed.initialized).toBe(true);
		expect(reArmed.servers).toHaveLength(1);
		expect(reArmed.servers[0].connected).toBe(true);
	});

	test("a second session_start without shutdown re-arms defensively", async () => {
		const cwd = join(fakeHome, "proj-rearm");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "node", args: ["s.js"] } } }));

		await piMcpToolsFactory(harness.pi);
		await startSession(harness, cwd, true);
		await startSession(harness, cwd, true);

		const report = await listServersReport(harness);
		expect(report.initialized).toBe(true);
		expect(report.servers).toHaveLength(1);
		expect(report.servers[0].connected).toBe(true);
	});

	test("a converter error is logged and degrades to global-only, never thrown out of session_start", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } }));
		const cwd = join(fakeHome, "proj-boom");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { projsrv: { command: "node", args: ["p.js"] } } }));

		const originalLoad = loader.loadProjectMcpJson;
		(loader as unknown as Record<string, unknown>).loadProjectMcpJson = () => {
			throw new Error("converter exploded");
		};
		const captured = captureConsoleMethod("error");

		try {
			await piMcpToolsFactory(harness.pi);
			await expect(startSession(harness, cwd, true)).resolves.toBeDefined();

			const report = await listServersReport(harness);
			const degradeCall = captured.calls.find((c) => String(c[0]).includes("reading project .mcp.json failed"));
			expect(degradeCall).toBeTruthy();
			expect((degradeCall![1] as Error).message).toBe("converter exploded");
			// Degraded, not dead: the global server still arms.
			expect(report.servers.find((s: any) => s.name === "globalsrv")).toMatchObject({
				source: "global settings",
				connected: true,
			});
			expect(report.servers.find((s: any) => s.name === "projsrv")).toBeUndefined();
		} finally {
			(loader as unknown as Record<string, unknown>).loadProjectMcpJson = originalLoad;
			captured.restore();
		}
	});

	test("a factory error is swallowed (headless pi must not exit on a factory throw)", async () => {
		const cwd = join(fakeHome, "proj-factory");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "node", args: ["s.js"] } } }));
		const captured = captureConsoleMethod("error");

		const brokenHarness = createMockPi();
		brokenHarness.registerToolImpl = () => {
			throw new Error("registerTool exploded");
		};

		try {
			await expect(piMcpToolsFactory(brokenHarness.pi)).resolves.toBeUndefined();
			expect(captured.calls.length).toBeGreaterThan(0);
		} finally {
			captured.restore();
		}
	});

	test("a poison filter regex never kills the server (tools survive, warning logged)", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ mcp: { globbler: { type: "local", command: ["node", "x.js"], filterPatterns: ["(("] } } }),
		);
		sdk.tools = [
			{ name: "tool_one", description: "one", inputSchema: { type: "object" } },
			{ name: "tool_two", description: "two", inputSchema: { type: "object" } },
		];
		const captured = captureConsoleMethod("warn");

		try {
			await piMcpToolsFactory(harness.pi);
			await startSession(harness, join(fakeHome, "no-project"), true);

			const report = await listServersReport(harness);
			expect(report.servers[0]).toMatchObject({ name: "globbler", connected: true });
			expect(report.servers[0].error).toBeUndefined();
			// Fail-open: with no compilable pattern the tools are not hidden.
			expect(harness.tools.some((t) => t.name === "mcp_globbler_tool_one")).toBe(true);
			expect(harness.tools.some((t) => t.name === "mcp_globbler_tool_two")).toBe(true);
			expect(captured.calls.some((c) => String(c[0]).includes("(("))).toBe(true);
		} finally {
			captured.restore();
		}
	});

	test("a per-server connect failure is visible in the report and notify without --mcp-debug", async () => {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcp: {
					deadsrv: { type: "local", command: ["node", "dead.js"] },
					alivesrv: { type: "local", command: ["node", "alive.js"] },
				},
			}),
		);
		sdk.failConnect = true; // every connect fails in this test

		await piMcpToolsFactory(harness.pi);
		const ctx = await startSession(harness, join(fakeHome, "no-project"), true);

		const report = await listServersReport(harness);
		const dead = report.servers.find((s: any) => s.name === "deadsrv");
		expect(dead).toMatchObject({ name: "deadsrv", source: "global settings", connected: false });
		expect(dead.error).toBeTruthy();

		// Failure surfaces without the debug flag.
		expect(harness.getFlagCalls).toContain("mcp-debug");
		expect(notifyMessages(ctx).some((m) => m.includes("deadsrv"))).toBe(true);
	});

	test("/mcp-status renders the same ledger", async () => {
		const cwd = join(fakeHome, "proj-status");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					good: { command: "node", args: ["g.js"] },
					broken: { type: "mystery" },
				},
			}),
		);

		await piMcpToolsFactory(harness.pi);
		const ctx = await startSession(harness, cwd, true);

		const status = harness.commands.get("mcp-status");
		expect(status).toBeDefined();
		await status!.handler(null, ctx);

		const ledgerRender = notifyMessages(ctx).find((m) => m.includes("ledger"));
		expect(ledgerRender).toBeTruthy();
		expect(ledgerRender).toContain("good");
		expect(ledgerRender).toContain("project:.mcp.json");
		expect(ledgerRender).toContain("skipped:unsupported-shape");
	});
});
