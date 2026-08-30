/**
 * Mirrored port of the fork's tests/claudeMcpConfig.test.ts (plan rev 3 §2 P2,
 * AC 4): repo A's layout runs bun:test against the canonical flat copy at
 * extensions/pi-mcp-tools/, so the vitest file is ported, not imported.
 *
 * R6 hermeticity: the hoisted-style os.homedir mock is installed via
 * mock.module BEFORE the converter is dynamically imported, so ${HOME}
 * expansion resolves to a fake home (never the real one). The converter is
 * pure — no SDK modules in its import graph — so no SDK mocks are needed here
 * (the fork mocked them defensively; bun's mock.module can't reach across a
 * graph that never imports them, and there is nothing to keep hermetic).
 *
 * NOTE: fakeHome is IDENTICAL across the three pi-mcp-tools test files that
 * mock os (claude-mcp-config, config-loader-project, lifecycle): bun's module
 * mock registry is process-wide for dynamically imported modules and the
 * FIRST registration wins, so every file must agree on the fake home or
 * ConfigLoader's import-time GLOBAL_SETTINGS_PATH capture diverges.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import * as osActual from "node:os";
import type { ClaudeConversion } from "../../extensions/pi-mcp-tools/claudeMcpConfig.ts";

/** The REAL home: bun's mock.module mutates the captured os namespace in
 * place, so osActual.homedir() is NOT trustworthy in these files (an earlier
 * file's registration in the same worker already rewrote it) — $HOME is the
 * one homedir source a module mock cannot touch. */
const realHome = process.env.HOME ?? osActual.homedir();
const fakeHome = `/tmp/pi-mcp-test-home-${process.pid}`;

mock.module("node:os", () => ({ ...osActual, homedir: () => fakeHome }));
mock.module("os", () => ({ ...osActual, homedir: () => fakeHome }));

const { convertClaudeMcpServers, globToAnchoredRegex } = await import(
	"../../extensions/pi-mcp-tools/claudeMcpConfig.ts"
);

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

function convert(raw: unknown): ClaudeConversion {
	return convertClaudeMcpServers(raw);
}

describe("convertClaudeMcpServers", () => {
	describe("local entries (M1: stdio/absent-type -> local)", () => {
		test("converts an entry with absent type to a local server", () => {
			const result = convert({ myserver: { command: "node", args: ["server.js"] } });
			expect(result.skipped).toHaveLength(0);
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0].name).toBe("myserver");
			expect(result.servers[0].config).toEqual({ type: "local", command: ["node", "server.js"] });
		});

		test("converts an explicit stdio type to a local server", () => {
			const result = convert({ myserver: { type: "stdio", command: "node" } });
			expect(result.skipped).toHaveLength(0);
			expect(result.servers[0].config).toEqual({ type: "local", command: ["node"] });
		});

		test("concatenates command and args in order", () => {
			const result = convert({
				s: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
			});
			expect(result.servers[0].config).toMatchObject({
				type: "local",
				command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			});
		});

		test("passes env and cwd through", () => {
			const result = convert({ s: { command: "node", env: { KEY: "value" }, cwd: "/work" } });
			expect(result.servers[0].config).toMatchObject({ env: { KEY: "value" }, cwd: "/work" });
		});

		test("skips a local entry without a command", () => {
			const result = convert({ s: { args: ["-x"] } });
			expect(result.servers).toHaveLength(0);
			expect(result.skipped[0]).toMatchObject({ name: "s", reason: "unsupported-shape" });
		});

		test("skips a local entry with a non-array args", () => {
			const result = convert({ s: { command: "node", args: "not-an-array" } });
			expect(result.servers).toHaveLength(0);
			expect(result.skipped[0].reason).toBe("unsupported-shape");
		});
	});

	describe("${HOME} expansion and ${VAR} skips (M1/R2)", () => {
		test("expands the ${HOME} prefix in command using os.homedir()", () => {
			const result = convert({ hermes: { command: "${HOME}/.local/bin/hermes", args: ["mcp", "serve"] } });
			expect(result.skipped).toHaveLength(0);
			expect(result.servers[0].config).toMatchObject({
				type: "local",
				command: [`${fakeHome}/.local/bin/hermes`, "mcp", "serve"],
			});
		});

		test("expands ${HOME} in args and cwd too", () => {
			const result = convert({
				s: { command: "node", args: ["--config", "${HOME}/conf.json"], cwd: "${HOME}/work" },
			});
			expect(result.servers[0].config).toMatchObject({
				command: ["node", "--config", `${fakeHome}/conf.json`],
				cwd: `${fakeHome}/work`,
			});
		});

		test("skips the entry when command carries another unexpanded ${VAR}", () => {
			const result = convert({ s: { command: "${TOOLS}/bin/tool", args: ["serve"] } });
			expect(result.servers).toHaveLength(0);
			expect(result.skipped[0]).toMatchObject({ name: "s", reason: "unexpanded-var" });
			expect(result.skipped[0].detail).toContain("TOOLS");
		});

		test("skips the entry when an arg or cwd carries an unexpanded ${VAR}", () => {
			const withArg = convert({ s: { command: "node", args: ["${MYVAR}"] } });
			expect(withArg.skipped[0].reason).toBe("unexpanded-var");
			const withCwd = convert({ s: { command: "node", cwd: "${OTHER}/x" } });
			expect(withCwd.skipped[0].reason).toBe("unexpanded-var");
		});
	});

	describe("tools filtering (M1: never pass tools:['*'] through)", () => {
		test('maps tools ["*"] to no filtering (no filterPatterns)', () => {
			const result = convert({ s: { command: "node", tools: ["*"] } });
			expect(result.servers[0].config).not.toHaveProperty("filterPatterns");
		});

		test("maps empty or absent tools to no filtering", () => {
			const empty = convert({ s: { command: "node", tools: [] } });
			expect(empty.servers[0].config).not.toHaveProperty("filterPatterns");
			const absent = convert({ s: { command: "node" } });
			expect(absent.servers[0].config).not.toHaveProperty("filterPatterns");
		});

		test('treats a list containing "*" as no filtering (match-all wins)', () => {
			const result = convert({ s: { command: "node", tools: ["*", "srv_x"] } });
			expect(result.servers[0].config).not.toHaveProperty("filterPatterns");
		});

		test("converts a glob pattern to an anchored regex", () => {
			const result = convert({ s: { command: "node", tools: ["srv_*"] } });
			expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^srv_.*$"] });
		});

		test("escapes regex metacharacters when translating a glob (poison input defused)", () => {
			const result = convert({ s: { command: "node", tools: ["a*b("] } });
			expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^a.*b\\($"] });
		});

		test("passes non-glob patterns through unchanged (fork regex semantics)", () => {
			const result = convert({ s: { command: "node", tools: ["^tool_"] } });
			expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^tool_"] });
		});

		test("passes an uncompilable non-glob pattern through for the runtime try/catch to handle", () => {
			const result = convert({ s: { command: "node", tools: ["(("] } });
			expect(result.servers[0].config).toMatchObject({ filterPatterns: ["(("] });
		});

		test("drops malformed tools elements instead of failing the entry", () => {
			const result = convert({ s: { command: "node", tools: [42, "srv_*"] } });
			expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^srv_.*$"] });
		});
	});

	describe("remote entries (M1/D5: http/sse -> remote)", () => {
		test("maps type http with url to a remote server", () => {
			const result = convert({ rider: { type: "http", url: "http://127.0.0.1:64482/stream" } });
			expect(result.skipped).toHaveLength(0);
			expect(result.servers[0].config).toEqual({ type: "remote", url: "http://127.0.0.1:64482/stream" });
		});

		test("maps type sse with url to a remote server", () => {
			const result = convert({ sse_srv: { type: "sse", url: "http://example.com/sse" } });
			expect(result.servers[0].config).toEqual({ type: "remote", url: "http://example.com/sse" });
		});

		test("skips a remote entry without url", () => {
			const result = convert({ rider: { type: "http" } });
			expect(result.servers).toHaveLength(0);
			expect(result.skipped[0]).toMatchObject({ name: "rider", reason: "unsupported-shape" });
		});
	});

	describe("skip semantics (M1: skip entry, still arm the others)", () => {
		test("skips an unknown type with a warning reason", () => {
			const result = convert({ weird: { type: "websocketish", url: "ws://x" } });
			expect(result.servers).toHaveLength(0);
			expect(result.skipped[0]).toMatchObject({ name: "weird", reason: "unsupported-shape" });
		});

		test("skips a non-object entry", () => {
			const result = convert({ bad: "just-a-string", worse: 42, nullish: null });
			expect(result.servers).toHaveLength(0);
			expect(result.skipped).toHaveLength(3);
			expect(result.skipped.every((s) => s.reason === "unsupported-shape")).toBe(true);
		});

		test("still arms the good entries when others are skipped", () => {
			const result = convert({
				good: { command: "node", args: ["a.js"] },
				bad: { type: "unknown" },
				remote: { type: "http", url: "http://127.0.0.1:1/stream" },
			});
			expect(result.servers.map((s) => s.name).sort()).toEqual(["good", "remote"]);
			expect(result.skipped.map((s) => s.name)).toEqual(["bad"]);
		});

		test("returns empty conversion for a non-object mcpServers map", () => {
			expect(convert(null)).toEqual({ servers: [], skipped: [] });
			expect(convert("nope")).toEqual({ servers: [], skipped: [] });
		});
	});
});

describe("globToAnchoredRegex", () => {
	test("translates * to .* and anchors both ends", () => {
		expect(globToAnchoredRegex("srv_*")).toBe("^srv_.*$");
	});

	test("translates ? to a single-character wildcard", () => {
		expect(globToAnchoredRegex("tool-?")).toBe("^tool-.$");
	});

	test("escapes regex metacharacters", () => {
		expect(globToAnchoredRegex("a.b")).toBe("^a\\.b$");
		expect(globToAnchoredRegex("(x)+")).toBe("^\\(x\\)\\+$");
	});

	test("never produces a poison regex from glob input", () => {
		for (const poison of ["*", "**", "a*b(", "${HOME}(*", "?|?"]) {
			expect(() => new RegExp(globToAnchoredRegex(poison))).not.toThrow();
		}
	});
});
