/**
 * Unit tests for pi-mcp-tools' ConfigLoader — scoped to `loadFromFile`,
 * `validateConfig` and `getEnabledServers` ONLY (review finding F12).
 *
 * NEVER import-exercise `loadDisabledTools`, `saveDisabledTools` or
 * `loadFromSettingsJson` here: they hardcode the developer's real
 * ~/.pi/agent/settings.json at import time, and a misfiring test could rewrite
 * the live user scope. Every fixture below lives in a mkdtemp directory.
 *
 * Out of unit scope, by design: McpClient, McpRegistry and index.ts are
 * integration-flavoured (they need a live MCP server or heavy stubbing) and are
 * deliberately NOT covered here — no faked coverage.
 *
 * F7 (fresh clones): extensions/pi-mcp-tools/node_modules is gitignored; run
 * `bun install` inside extensions/pi-mcp-tools/ before running this suite.
 *
 * Import mechanics (P2): ConfigLoader is imported DYNAMICALLY after the same
 * os.homedir mock the other pi-mcp-tools test files register (identical fake
 * home). ConfigLoader captures its global settings path at import time, and
 * bun's worker-wide module cache serves the FIRST instance created in the
 * worker to every later importer — so this file's import must not race in an
 * unmocked capture that would poison the sibling lifecycle/merge suites (and
 * conversely, a mocked capture is inert here: this file only calls the
 * explicit-path/pure functions F12 scoped it to.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as osActual from "node:os";
import type { McpConfig } from "../../extensions/pi-mcp-tools/types.ts";
import type { ConfigLoader as ConfigLoaderType } from "../../extensions/pi-mcp-tools/ConfigLoader.ts";

/** Same fake home string as claude-mcp-config / config-loader-project / lifecycle:
 * bun's module-mock registry is worker-wide and the first registration wins, so
 * every pi-mcp-tools file must agree on the fake home. */
const realHome = process.env.HOME ?? osActual.homedir();
const fakeHome = `/tmp/pi-mcp-test-home-${process.pid}`;

mock.module("node:os", () => ({ ...osActual, homedir: () => fakeHome }));
mock.module("os", () => ({ ...osActual, homedir: () => fakeHome }));

/** Mirror the real global bun node_modules into the fake home (node_modules
 * LEVEL, not package level — createRequire does not follow symlinks when
 * walking parents): if a later file in this worker loads tests/setup.ts while
 * the os mock is active, its jiti resolution keeps working. */
try {
	const realGlobalNm = join(realHome, ".bun", "install", "global", "node_modules");
	const mirrorGlobalNm = join(fakeHome, ".bun", "install", "global", "node_modules");
	mkdirSync(dirname(mirrorGlobalNm), { recursive: true });
	rmSync(mirrorGlobalNm, { force: true, recursive: true });
	symlinkSync(realGlobalNm, mirrorGlobalNm, "dir");
} catch {
	// best-effort
}

const { ConfigLoader: _C } = await import("../../extensions/pi-mcp-tools/ConfigLoader.ts");
const loader = _C as typeof ConfigLoaderType;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeSettings(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content, "utf-8");
	return path;
}

const VALID_CONFIG: McpConfig = {
	filesystem: { type: "local", command: ["bun", "run", "server.ts"] },
	search: { type: "remote", url: "https://mcp.example.com/sse" },
};

describe("loadFromFile", () => {
	test("a missing file is null, not a thrown error", () => {
		expect(loader.loadFromFile(join(dir, "absent.json"))).toBeNull();
	});

	test("a settings file with an mcp key returns that config object", () => {
		const path = writeSettings("settings.json", JSON.stringify({ mcp: VALID_CONFIG }));
		expect(loader.loadFromFile(path)).toEqual(VALID_CONFIG);
	});

	test("a settings file without an mcp key is null", () => {
		const path = writeSettings("settings.json", JSON.stringify({ theme: "dark" }));
		expect(loader.loadFromFile(path)).toBeNull();
	});

	test("an mcp key explicitly set to null is null", () => {
		const path = writeSettings("settings.json", JSON.stringify({ mcp: null }));
		expect(loader.loadFromFile(path)).toBeNull();
	});

	test("malformed JSON is caught and reported as null", () => {
		const path = writeSettings("settings.json", "{ not json at all");
		expect(loader.loadFromFile(path)).toBeNull();
	});
});

describe("validateConfig", () => {
	test("an empty config is invalid and says it must be a non-empty object", () => {
		const result = loader.validateConfig({});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["MCP config must be a non-empty object"]);
	});

	test("a null config hits the same defensive path", () => {
		const result = loader.validateConfig(null as unknown as McpConfig);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["MCP config must be a non-empty object"]);
	});

	test("a well-formed local server validates cleanly", () => {
		const result = loader.validateConfig({
			fs: { type: "local", command: ["bun", "x", "fs-server"] },
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("a well-formed remote server validates cleanly", () => {
		const result = loader.validateConfig({
			search: { type: "remote", url: "https://mcp.example.com/sse" },
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("a local server without a command array is named in an error", () => {
		const result = loader.validateConfig({
			broken: { type: "local" } as never,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["Local server 'broken' missing or invalid 'command' array"]);
	});

	test("a local server whose command is not an array hits the same error", () => {
		const result = loader.validateConfig({
			broken: { type: "local", command: "bun x fs" } as never,
		});
		expect(result.errors).toEqual(["Local server 'broken' missing or invalid 'command' array"]);
	});

	test("a remote server without a url is named in an error", () => {
		const result = loader.validateConfig({
			broken: { type: "remote" } as never,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["Remote server 'broken' missing 'url'"]);
	});

	test("a server with an invalid or missing type gets the type error and nothing else", () => {
		// `continue` after the type error means no follow-up local/remote checks
		// fire for the same server — one bad type, exactly one error.
		const invalid = loader.validateConfig({ weird: { type: "teleport" } as never });
		expect(invalid.errors).toEqual(["Server 'weird' has invalid or missing 'type'"]);

		const missing = loader.validateConfig({ weird: {} as never });
		expect(missing.errors).toEqual(["Server 'weird' has invalid or missing 'type'"]);
	});

	test("mixed configs report only the bad servers, in insertion order", () => {
		const result = loader.validateConfig({
			badRemote: { type: "remote" } as never,
			goodLocal: { type: "local", command: ["bun", "x"] },
			badType: { type: "carrier-pigeon" } as never,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			"Remote server 'badRemote' missing 'url'",
			"Server 'badType' has invalid or missing 'type'",
		]);
	});
});

describe("getEnabledServers", () => {
	test("keeps servers whose enabled flag is true or absent, drops only explicit false", () => {
		// `enabled !== false` is the rule: absence means on.
		const result = loader.getEnabledServers({
			explicitOn: { type: "local", command: ["a"], enabled: true },
			disabled: { type: "local", command: ["b"], enabled: false },
			silentOn: { type: "local", command: ["c"] },
		});
		expect(result.map((s) => s.name)).toEqual(["explicitOn", "silentOn"]);
	});

	test("each entry carries its name alongside its untouched config", () => {
		const result = loader.getEnabledServers({
			fs: { type: "local", command: ["bun", "x"] },
		});
		expect(result).toEqual([{ name: "fs", config: { type: "local", command: ["bun", "x"] } }]);
	});

	test("all servers disabled yields an empty list", () => {
		const result = loader.getEnabledServers({
			a: { type: "local", command: ["a"], enabled: false },
			b: { type: "remote", url: "https://x", enabled: false },
		});
		expect(result).toEqual([]);
	});

	test("an empty config yields an empty list", () => {
		expect(loader.getEnabledServers({})).toEqual([]);
	});
});
