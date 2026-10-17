/** rtk-status: pure formatting and read-only readers for the rtk statusline. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatStatus,
	isRouted,
	parseGain,
	parseProxyStatus,
	proxyBind,
	proxyDbPath,
	proxyHeaders,
	proxyUrl,
	readProxyUsage,
	shouldRefresh,
} from "../../extensions/rtk/rtk-status.ts";

const gainJson = (s: Record<string, unknown>) => JSON.stringify({ summary: s });

describe("parseGain", () => {
	test("real rtk 1.0.1 fixture is weighted by saved/input", () => {
		const out = gainJson({ total_commands: 3, total_input: 499, total_output: 301, total_saved: 198, avg_savings_pct: 39.67935871743487 });
		expect(parseGain(out)).toEqual({ pct: (198 / 499) * 100, commands: 3 });
	});
	test("weighted, not avg_savings_pct (900/1000 with avg 50 -> 90)", () => {
		expect(parseGain(gainJson({ total_commands: 2, total_input: 1000, total_saved: 900, avg_savings_pct: 50 }))?.pct).toBe(90);
	});
	test("0 commands or 0 input -> pct undefined", () => {
		expect(parseGain(gainJson({ total_commands: 0, total_input: 0, total_saved: 0 }))).toEqual({ pct: undefined, commands: 0 });
		expect(parseGain(gainJson({ total_commands: 2, total_input: 0, total_saved: 0 }))?.pct).toBeUndefined();
	});
	test.each(["", "not json", "null", "[]", "{}", '{"summary":5}', '{"summary":{"total_commands":"x"}}'])("malformed %p -> undefined", (raw) => {
		expect(parseGain(raw)).toBeUndefined();
	});
});

describe("parseProxyStatus", () => {
	test("real up fixture", () => {
		expect(parseProxyStatus("running at 127.0.0.1:8080 (edition local, v1.0.1)\n", 0)).toBe("up");
	});
	test("real down fixture (exit 1)", () => {
		expect(parseProxyStatus("not running (no proxy reachable at 127.0.0.1:59999)\n", 1)).toBe("down");
	});
	test("exit 0 without 'running' text, nonzero with it, and garbage are down", () => {
		expect(parseProxyStatus("", 0)).toBe("down");
		expect(parseProxyStatus("running at x", 1)).toBe("down");
		expect(parseProxyStatus(undefined as unknown as string, 0)).toBe("down");
	});
});

describe("readProxyUsage", () => {
	async function seed(rows: Array<[string | null, number, number]>) {
		const { DatabaseSync } = await import("node:sqlite");
		const path = join(mkdtempSync(join(tmpdir(), "rtk-status-")), "p.db");
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
		const path = join(mkdtempSync(join(tmpdir(), "rtk-status-")), "absent.db");
		expect(readProxyUsage(path, "/x")).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});
	test("db without the table/column or not a db -> undefined", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const path = join(mkdtempSync(join(tmpdir(), "rtk-status-")), "o.db");
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

describe("formatStatus", () => {
	test("routed", () => {
		expect(formatStatus({ proxy: "routed", cmdPct: 62.2, proxyPct: 17.6, post: { compressed: 3, sent: 5 } })).toBe("rtk ⇄proxy · cmd 62% · proxy 18% · post 3/5");
	});
	test("routed-down", () => {
		expect(formatStatus({ proxy: "routed-down", cmdPct: 62 })).toBe("rtk proxy down! · cmd 62%");
	});
	test("up", () => {
		expect(formatStatus({ proxy: "up", cmdPct: 62 })).toBe("rtk proxy up · pi direct · cmd 62%");
	});
	test("off", () => {
		expect(formatStatus({ proxy: "off", cmdPct: 62 })).toBe("rtk proxy off · cmd 62%");
	});
	test("routed with unknown proxy pct shows a dash; post omitted when sent is 0", () => {
		expect(formatStatus({ proxy: "routed", cmdPct: 62, post: { compressed: 0, sent: 0 } })).toBe("rtk ⇄proxy · cmd 62% · proxy –");
	});
	test("unknown cmdPct and NaN never leak", () => {
		const s = formatStatus({ proxy: "off", cmdPct: Number.NaN });
		expect(s).toBe("rtk proxy off · cmd –");
		for (const state of ["routed", "routed-down", "up", "off"] as const) {
			const out = formatStatus({ proxy: state, proxyPct: Number.NaN, post: { compressed: 0, sent: 2 } });
			expect(out).not.toMatch(/NaN|undefined/);
		}
	});
});

describe("shouldRefresh and proxyHeaders", () => {
	test("throttle", () => {
		expect(shouldRefresh(1000, undefined)).toBe(true);
		expect(shouldRefresh(5000, 1000)).toBe(false);
		expect(shouldRefresh(11_000, 1000)).toBe(true);
		expect(shouldRefresh(1500, 1000, 400)).toBe(true);
	});
	test("headers omit session when absent", () => {
		expect(proxyHeaders("/p", "s1")).toEqual({ "x-rtk-project": "/p", "x-rtk-session": "s1" });
		expect(proxyHeaders("/p", undefined)).toEqual({ "x-rtk-project": "/p" });
		expect(proxyHeaders("/p", "")).toEqual({ "x-rtk-project": "/p" });
	});
});
