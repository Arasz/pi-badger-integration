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
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLoader } from "../../extensions/pi-mcp-tools/ConfigLoader.ts";
import type { McpConfig } from "../../extensions/pi-mcp-tools/types.ts";

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
		expect(ConfigLoader.loadFromFile(join(dir, "absent.json"))).toBeNull();
	});

	test("a settings file with an mcp key returns that config object", () => {
		const path = writeSettings("settings.json", JSON.stringify({ mcp: VALID_CONFIG }));
		expect(ConfigLoader.loadFromFile(path)).toEqual(VALID_CONFIG);
	});

	test("a settings file without an mcp key is null", () => {
		const path = writeSettings("settings.json", JSON.stringify({ theme: "dark" }));
		expect(ConfigLoader.loadFromFile(path)).toBeNull();
	});

	test("an mcp key explicitly set to null is null", () => {
		const path = writeSettings("settings.json", JSON.stringify({ mcp: null }));
		expect(ConfigLoader.loadFromFile(path)).toBeNull();
	});

	test("malformed JSON is caught and reported as null", () => {
		const path = writeSettings("settings.json", "{ not json at all");
		expect(ConfigLoader.loadFromFile(path)).toBeNull();
	});
});

describe("validateConfig", () => {
	test("an empty config is invalid and says it must be a non-empty object", () => {
		const result = ConfigLoader.validateConfig({});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["MCP config must be a non-empty object"]);
	});

	test("a null config hits the same defensive path", () => {
		const result = ConfigLoader.validateConfig(null as unknown as McpConfig);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["MCP config must be a non-empty object"]);
	});

	test("a well-formed local server validates cleanly", () => {
		const result = ConfigLoader.validateConfig({
			fs: { type: "local", command: ["bun", "x", "fs-server"] },
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("a well-formed remote server validates cleanly", () => {
		const result = ConfigLoader.validateConfig({
			search: { type: "remote", url: "https://mcp.example.com/sse" },
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("a local server without a command array is named in an error", () => {
		const result = ConfigLoader.validateConfig({
			broken: { type: "local" } as never,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["Local server 'broken' missing or invalid 'command' array"]);
	});

	test("a local server whose command is not an array hits the same error", () => {
		const result = ConfigLoader.validateConfig({
			broken: { type: "local", command: "bun x fs" } as never,
		});
		expect(result.errors).toEqual(["Local server 'broken' missing or invalid 'command' array"]);
	});

	test("a remote server without a url is named in an error", () => {
		const result = ConfigLoader.validateConfig({
			broken: { type: "remote" } as never,
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["Remote server 'broken' missing 'url'"]);
	});

	test("a server with an invalid or missing type gets the type error and nothing else", () => {
		// `continue` after the type error means no follow-up local/remote checks
		// fire for the same server — one bad type, exactly one error.
		const invalid = ConfigLoader.validateConfig({ weird: { type: "teleport" } as never });
		expect(invalid.errors).toEqual(["Server 'weird' has invalid or missing 'type'"]);

		const missing = ConfigLoader.validateConfig({ weird: {} as never });
		expect(missing.errors).toEqual(["Server 'weird' has invalid or missing 'type'"]);
	});

	test("mixed configs report only the bad servers, in insertion order", () => {
		const result = ConfigLoader.validateConfig({
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
		const result = ConfigLoader.getEnabledServers({
			explicitOn: { type: "local", command: ["a"], enabled: true },
			disabled: { type: "local", command: ["b"], enabled: false },
			silentOn: { type: "local", command: ["c"] },
		});
		expect(result.map((s) => s.name)).toEqual(["explicitOn", "silentOn"]);
	});

	test("each entry carries its name alongside its untouched config", () => {
		const result = ConfigLoader.getEnabledServers({
			fs: { type: "local", command: ["bun", "x"] },
		});
		expect(result).toEqual([{ name: "fs", config: { type: "local", command: ["bun", "x"] } }]);
	});

	test("all servers disabled yields an empty list", () => {
		const result = ConfigLoader.getEnabledServers({
			a: { type: "local", command: ["a"], enabled: false },
			b: { type: "remote", url: "https://x", enabled: false },
		});
		expect(result).toEqual([]);
	});

	test("an empty config yields an empty list", () => {
		expect(ConfigLoader.getEnabledServers({})).toEqual([]);
	});
});
