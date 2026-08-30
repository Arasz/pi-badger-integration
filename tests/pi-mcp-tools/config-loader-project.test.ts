/**
 * Mirrored port of the fork's P1 ConfigLoader additions (plan rev 3 §2 P2, AC 4):
 * `loadProjectMcpJson`, `mergeMcpConfigs` (M1/M2/M3) and the atomic
 * `saveDisabledTools` (M6/D4). Repo A runs bun:test against the canonical flat
 * copy, so the vitest file is ported, not imported.
 *
 * The P1 functions that take explicit arguments (loadProjectMcpJson,
 * mergeMcpConfigs) are pure; the saveDisabledTests need the import-time
 * GLOBAL_SETTINGS_PATH capture, so the os.homedir mock is installed via
 * mock.module BEFORE ConfigLoader is dynamically imported (R6: no test may
 * touch the real ~/.pi).
 *
 * validateConfig/getEnabledServers/loadFromFile stay in config-loader.test.ts
 * (review F12's scoping) — this file only covers the P1 surface.
 *
 * NOTE: fakeHome is IDENTICAL across the three pi-mcp-tools test files that
 * mock os (claude-mcp-config, config-loader-project, lifecycle): bun's module
 * mock registry is process-wide for dynamically imported modules and the
 * FIRST registration wins, so every file must agree on the fake home or
 * ConfigLoader's import-time GLOBAL_SETTINGS_PATH capture diverges.
 */
import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as osActual from "node:os";
import type { ConfigLoader as ConfigLoaderType } from "../../extensions/pi-mcp-tools/ConfigLoader.ts";

/** The REAL home: bun's mock.module mutates the captured os namespace in
 * place, so osActual.homedir() is NOT trustworthy in these files (an earlier
 * file's registration in the same worker already rewrote it) — $HOME is the
 * one homedir source a module mock cannot touch. */
const realHome = process.env.HOME ?? osActual.homedir();
const fakeHome = `/tmp/pi-mcp-test-home-${process.pid}`;

mock.module("node:os", () => ({ ...osActual, homedir: () => fakeHome }));
mock.module("os", () => ({ ...osActual, homedir: () => fakeHome }));

const { ConfigLoader } = await import("../../extensions/pi-mcp-tools/ConfigLoader.ts");
const loader = ConfigLoader as typeof ConfigLoaderType;

/** Insurance against bun's worker-wide module-registry leak: if a later file in
 * this worker loads tests/setup.ts while an os mock is active, setup.ts resolves
 * its jiti loader under homedir(). Mirror the real global pi package into the
 * fake home so that resolution keeps working. */
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

/** Canary gate: ConfigLoader captures its settings path at import time, and bun's
 * worker module cache can serve an instance captured under a DIFFERENT home (real
 * or another mock) depending on which file imported it first in the worker. The
 * mutating saveDisabledTools tests may only run when the captured path provably
 * IS the fake home — otherwise they would write the real user scope (the exact
 * hazard repo A's config-loader.test.ts F12 scoping warns about). */
function capturedPathIsFakeHome(): boolean {
	try {
		const agentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ canary: "pi-mcp-test" }), "utf-8");
		const loaded = loader.loadFromSettingsJson();
		return loaded !== null && typeof loaded === "object" && "canary" in loaded;
	} catch {
		return false;
	}
}
const captureVerified = capturedPathIsFakeHome();
if (!captureVerified) {
	console.warn(
		`[config-loader-project] LOUD SKIP: ConfigLoader's import-time settings path is NOT this file's fake home ` +
			`(bun worker module-cache served an instance captured elsewhere) — the mutating saveDisabledTools tests ` +
			`are skipped rather than risk the real user scope.`,
	);
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

describe("ConfigLoader P1: loadProjectMcpJson (M1)", () => {
	const projectDir = join(fakeHome, "proj");

	function writeProjectFile(content: string): void {
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, ".mcp.json"), content, "utf-8");
	}

	test("returns an empty non-error result when no .mcp.json exists", () => {
		const result = loader.loadProjectMcpJson(join(fakeHome, "no-such-project"));
		expect(result).toEqual({ servers: [], skipped: [], parseError: null, exists: false });
	});

	test("reads and converts a project .mcp.json (claude -> fork format)", () => {
		writeProjectFile(
			JSON.stringify({
				mcpServers: {
					hermes: { command: "${HOME}/.local/bin/hermes", args: ["mcp", "serve"], tools: ["*"] },
				},
			}),
		);
		const result = loader.loadProjectMcpJson(projectDir);
		expect(result.exists).toBe(true);
		expect(result.parseError).toBeNull();
		expect(result.skipped).toHaveLength(0);
		expect(result.servers[0].name).toBe("hermes");
		expect(result.servers[0].config).toEqual({
			type: "local",
			command: [`${fakeHome}/.local/bin/hermes`, "mcp", "serve"],
		});
	});

	test("reports a parseError and arms nothing for an unparseable file (no partial merge)", () => {
		const captured = captureConsoleMethod("warn");
		try {
			writeProjectFile("{ this is not json");
			const result = loader.loadProjectMcpJson(projectDir);
			expect(result.exists).toBe(true);
			expect(result.parseError).toBeTruthy();
			expect(result.servers).toHaveLength(0);
		} finally {
			captured.restore();
		}
	});

	test("keeps parseError null but records skips for malformed entries", () => {
		writeProjectFile(JSON.stringify({ mcpServers: { good: { command: "node" }, bad: { type: "unknown" } } }));
		const result = loader.loadProjectMcpJson(projectDir);
		expect(result.parseError).toBeNull();
		expect(result.servers.map((s) => s.name)).toEqual(["good"]);
		expect(result.skipped[0]).toMatchObject({ name: "bad", reason: "unsupported-shape" });
	});

	test("treats a file without mcpServers as inert", () => {
		writeProjectFile(JSON.stringify({ something: "else" }));
		const result = loader.loadProjectMcpJson(projectDir);
		expect(result.exists).toBe(true);
		expect(result.servers).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
		expect(result.parseError).toBeNull();
	});
});

describe("ConfigLoader P1: mergeMcpConfigs (M1/M2/M3)", () => {
	const globalCfg = {
		alpha: { type: "local" as const, command: ["global-alpha"] },
		beta: { type: "local" as const, command: ["global-beta"] },
	};

	test("gives project entries precedence over global entries with the same name", () => {
		const project = {
			servers: [{ name: "alpha", config: { type: "local" as const, command: ["project-alpha"] } }],
			skipped: [],
			parseError: null as string | null,
			exists: true,
		};
		const { config, ledger } = loader.mergeMcpConfigs(globalCfg, project, true);
		expect(config!.alpha).toEqual({ type: "local", command: ["project-alpha"] });
		expect(config!.beta).toEqual({ type: "local", command: ["global-beta"] });
		expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("project:.mcp.json");
		expect(ledger.entries.find((e) => e.name === "beta")!.source).toBe("global settings");
	});

	test("keeps global-only names armed when the project declares other names", () => {
		const project = {
			servers: [{ name: "gamma", config: { type: "local" as const, command: ["project-gamma"] } }],
			skipped: [],
			parseError: null as string | null,
			exists: true,
		};
		const { config, ledger } = loader.mergeMcpConfigs(globalCfg, project, true);
		expect(config!.alpha).toEqual({ type: "local", command: ["global-alpha"] });
		expect(config!.gamma).toEqual({ type: "local", command: ["project-gamma"] });
		expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("global settings");
	});

	test("a skipped project entry shadows the same-named global entry", () => {
		const project = {
			servers: [],
			skipped: [{ name: "alpha", reason: "unexpanded-var" as const, detail: "unexpanded ${TOOLS} in command" }],
			parseError: null as string | null,
			exists: true,
		};
		const { config, ledger } = loader.mergeMcpConfigs(globalCfg, project, true);
		expect(config!.alpha).toBeUndefined();
		expect(config!.beta).toEqual({ type: "local", command: ["global-beta"] });
		expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("skipped:unexpanded-var");
	});

	test("falls back to global-only for an untrusted project and records untrusted-project rows", () => {
		const project = {
			servers: [{ name: "alpha", config: { type: "local" as const, command: ["project-alpha"] } }],
			skipped: [],
			parseError: null as string | null,
			exists: true,
		};
		const captured = captureConsoleMethod("warn");
		try {
			const { config, ledger } = loader.mergeMcpConfigs(globalCfg, project, false);
			expect(config!.alpha).toEqual({ type: "local", command: ["global-alpha"] });
			expect(config!.gamma).toBeUndefined();
			// Additive rows: the global same-named entry armed AND the project's
			// gated declaration is visible.
			const alphaRows = ledger.entries.filter((e) => e.name === "alpha").map((e) => e.source);
			expect(alphaRows).toContain("global settings");
			expect(alphaRows).toContain("untrusted-project");
			expect(ledger.entries.find((e) => e.name === "beta")!.source).toBe("global settings");
			expect(ledger.untrustedCount).toBe(1);
		} finally {
			captured.restore();
		}
	});

	test("treats a missing project file as no project at all (all-global ledger)", () => {
		const { config, ledger } = loader.mergeMcpConfigs(globalCfg, null, true);
		expect(config).toEqual(globalCfg);
		expect(ledger.entries.map((e) => e.source)).toEqual(["global settings", "global settings"]);
		expect(ledger.untrustedCount).toBe(0);
	});

	test("treats a not-existing project result as no project", () => {
		const project = { servers: [], skipped: [], parseError: null as string | null, exists: false };
		const { config, ledger } = loader.mergeMcpConfigs(globalCfg, project, false);
		expect(config).toEqual(globalCfg);
		expect(ledger.untrustedCount).toBe(0);
	});

	test("an unparseable project file yields global-only plus a warning, never a partial arm", () => {
		const project = {
			servers: [{ name: "alpha", config: { type: "local" as const, command: ["should-not-arm"] } }],
			skipped: [],
			parseError: "Unexpected token" as string,
			exists: true,
		};
		const { config, ledger } = loader.mergeMcpConfigs(globalCfg, project, true);
		expect(config).toEqual(globalCfg);
		expect(ledger.warnings.some((w) => w.includes("unparseable"))).toBe(true);
		expect(JSON.stringify(config)).not.toContain("should-not-arm");
	});

	test("counts only skipped:* sources in skippedCount", () => {
		const project = {
			servers: [{ name: "gamma", config: { type: "local" as const, command: ["project-gamma"] } }],
			skipped: [
				{ name: "alpha", reason: "unexpanded-var" as const, detail: "x" },
				{ name: "delta", reason: "unsupported-shape" as const, detail: "y" },
			],
			parseError: null as string | null,
			exists: true,
		};
		const { ledger } = loader.mergeMcpConfigs(globalCfg, project, true);
		expect(ledger.skippedCount).toBe(2);
		expect(ledger.untrustedCount).toBe(0);
	});
});

describe.skipIf(!captureVerified)("ConfigLoader P1: saveDisabledTools atomicity (M6/D4)", () => {
	const agentDir = join(fakeHome, ".pi", "agent");
	const settingsPath = join(agentDir, "settings.json");

	test("writes through a temp file and leaves no temp files behind (user keys preserved)", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", mcp: {} }), "utf-8");

		loader.saveDisabledTools(new Set(["mcp_srv_tool"]));

		const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(saved.theme).toBe("dark");
		expect(saved.mcpDisabledTools).toEqual(["mcp_srv_tool"]);
		const leftovers = readdirSync(agentDir).filter((f) => f !== "settings.json");
		expect(leftovers).toEqual([]);
	});

	test("a failed write leaves settings.json untouched, cleans up, and does not throw", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			return; // chmod-based failure injection does not bite for root
		}
		mkdirSync(agentDir, { recursive: true });
		const original = JSON.stringify({ theme: "dark" }, null, 2) + "\n";
		writeFileSync(settingsPath, original, "utf-8");
		chmodSync(agentDir, 0o555);
		const captured = captureConsoleMethod("error");

		try {
			expect(() => loader.saveDisabledTools(new Set(["mcp_srv_tool"]))).not.toThrow();
			expect(readFileSync(settingsPath, "utf-8")).toBe(original);
			expect(captured.calls.length).toBeGreaterThan(0);
			const leftovers = readdirSync(agentDir).filter((f) => f !== "settings.json");
			expect(leftovers).toEqual([]);
		} finally {
			chmodSync(agentDir, 0o755);
			captured.restore();
		}
	});

	test("warns when settings.json is missing instead of failing silently", () => {
		rmSync(join(fakeHome, ".pi"), { recursive: true, force: true });
		const captured = captureConsoleMethod("error");

		expect(() => loader.saveDisabledTools(new Set(["mcp_x_y"]))).not.toThrow();
		const first = String(captured.calls[0]?.[0]);
		expect(first).toContain("Cannot save disabled tools");
		expect(first).toContain(".pi");

		captured.restore();
	});
});
