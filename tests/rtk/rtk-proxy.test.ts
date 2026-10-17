/** rtk-proxy: bind address, routing detection, attribution headers and the read-only proxy database reader. */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRouted, proxyBind, proxyDbPath, proxyHeaders, proxyUrl, readProxyUsage } from "../../extensions/rtk/rtk-proxy.ts";

const dirs: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rtk-proxy-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("readProxyUsage", () => {
	async function seed(rows: Array<[string | null, number, number]>) {
		const { DatabaseSync } = await import("node:sqlite");
		const path = join(tempDir(), "p.db");
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE usage_records (id INTEGER PRIMARY KEY, tokens_in INTEGER, tokens_saved INTEGER, project TEXT)");
		const ins = db.prepare("INSERT INTO usage_records (tokens_in, tokens_saved, project) VALUES (?, ?, ?)");
		for (const [p, i, s] of rows) ins.run(i, s, p);
		db.close();
		return path;
	}
	test("sums rows equal to cwd or under cwd/, excluding other, NULL and sibling-prefix", async () => {
		const cwd = "/work/app";
		const path = await seed([
			[cwd, 100, 10],
			[`${cwd}/sub`, 100, 30],
			[`${cwd}x`, 1000, 900],
			["/other", 1000, 900],
			[null, 1000, 900],
		]);
		expect(readProxyUsage(path, cwd)).toEqual({ pct: 20 });
	});
	test("no matching rows -> {pct: undefined}", async () => {
		const path = await seed([["/other", 10, 5]]);
		expect(readProxyUsage(path, "/work/app")).toEqual({ pct: undefined });
	});
	test("zero tokens_in -> pct undefined", async () => {
		const path = await seed([["/work/app", 0, 0]]);
		expect(readProxyUsage(path, "/work/app")).toEqual({ pct: undefined });
	});
	test("missing file -> undefined and is never created", () => {
		const path = join(tempDir(), "absent.db");
		expect(readProxyUsage(path, "/x")).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});
	test("db without the table/column or not a db -> undefined", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const path = join(tempDir(), "o.db");
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE usage_records (tokens_in INTEGER)");
		db.close();
		expect(readProxyUsage(path, "/x")).toBeUndefined();
		expect(readProxyUsage(tmpdir(), "/x")).toBeUndefined();
	});
});

describe("proxy location", () => {
	test("proxyDbPath order", () => {
		expect(proxyDbPath({ RTK_PROXY_DB: "/abs/p.db" }, "/h", "darwin")).toBe("/abs/p.db");
		expect(proxyDbPath({ RTK_PROXY_DB: "rel.db" }, "/h", "darwin")).toBe("/h/Library/Application Support/rtk/llm-proxy/rtk-proxy.db");
		expect(proxyDbPath({}, "/h", "darwin")).toBe("/h/Library/Application Support/rtk/llm-proxy/rtk-proxy.db");
		expect(proxyDbPath({ XDG_DATA_HOME: "/xdg" }, "/h", "linux")).toBe("/xdg/rtk/llm-proxy/rtk-proxy.db");
		expect(proxyDbPath({}, "/h", "linux")).toBe("/h/.local/share/rtk/llm-proxy/rtk-proxy.db");
	});
	test("bind and url", () => {
		expect(proxyBind({})).toBe("127.0.0.1:8080");
		expect(proxyBind({ RTK_PROXY_BIND: "0.0.0.0:9000" })).toBe("0.0.0.0:9000");
		expect(proxyUrl({})).toBe("http://127.0.0.1:8080");
	});
	test.each<[string | undefined, boolean]>([
		["http://127.0.0.1:8080", true],
		["http://127.0.0.1:8080/v1/", true],
		["http://localhost:8080", true],
		["http://127.0.0.1:80801", false],
		["http://127.0.0.1:80", false],
		["http://127.0.0.1:9090", false],
		["https://api.anthropic.com", false],
		["not a url", false],
		["", false],
		[undefined, false],
	])("isRouted(%p) = %p", (url, want) => {
		expect(isRouted(url, "127.0.0.1:8080")).toBe(want);
	});
	test("isRouted default port and bind variants", () => {
		expect(isRouted("http://127.0.0.1", "127.0.0.1:80")).toBe(true);
		expect(isRouted("http://[::1]:8080", "[::1]:8080")).toBe(true);
	});
});

describe("proxyHeaders", () => {
	test("headers omit session when absent", () => {
		expect(proxyHeaders("/p", "s1")).toEqual({ "x-rtk-project": "/p", "x-rtk-session": "s1" });
		expect(proxyHeaders("/p", undefined)).toEqual({ "x-rtk-project": "/p" });
		expect(proxyHeaders("/p", "")).toEqual({ "x-rtk-project": "/p" });
	});
});
