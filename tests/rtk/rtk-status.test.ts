/** rtk-status: pure parsing and formatting for the rtk statusline. */

import { describe, expect, test } from "bun:test";
import { formatStatus, parseGain, parseProxyStatus, shouldRefresh } from "../../extensions/rtk/rtk-status.ts";

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

describe("formatStatus", () => {
	test("routed", () => {
		expect(formatStatus({ proxy: "routed", cmdPct: 62.2, proxyPct: 17.6, post: { compressed: 3, sent: 5 } })).toBe("[rtk ⇄proxy · cmd 62% · proxy 18% · compressed 3/5]");
	});
	test("routed-down", () => {
		expect(formatStatus({ proxy: "routed-down", cmdPct: 62 })).toBe("[rtk proxy down! · cmd 62%]");
	});
	test("up", () => {
		expect(formatStatus({ proxy: "up", cmdPct: 62 })).toBe("[rtk proxy up · pi direct · cmd 62%]");
	});
	test("off", () => {
		expect(formatStatus({ proxy: "off", cmdPct: 62 })).toBe("[rtk proxy off · cmd 62%]");
	});
	test("routed with unknown proxy pct shows a dash; the counter is omitted when sent is 0", () => {
		expect(formatStatus({ proxy: "routed", cmdPct: 62, post: { compressed: 0, sent: 0 } })).toBe("[rtk ⇄proxy · cmd 62% · proxy –]");
	});
	test("the compression counter shows in every proxy state, not only when routed", () => {
		const post = { compressed: 2, sent: 4 };
		expect(formatStatus({ proxy: "routed-down", cmdPct: 62, post })).toBe("[rtk proxy down! · cmd 62% · compressed 2/4]");
		expect(formatStatus({ proxy: "up", cmdPct: 62, post })).toBe("[rtk proxy up · pi direct · cmd 62% · compressed 2/4]");
		expect(formatStatus({ proxy: "off", cmdPct: 62, post })).toBe("[rtk proxy off · cmd 62% · compressed 2/4]");
	});
	test("a known project proxy pct shows when pi is not routed; unknown stays hidden", () => {
		expect(formatStatus({ proxy: "up", cmdPct: 62, proxyPct: 4.4 })).toBe("[rtk proxy up · pi direct · cmd 62% · proxy 4%]");
		expect(formatStatus({ proxy: "off", cmdPct: 62 })).toBe("[rtk proxy off · cmd 62%]");
	});
	test("unknown cmdPct and NaN never leak", () => {
		const s = formatStatus({ proxy: "off", cmdPct: Number.NaN });
		expect(s).toBe("[rtk proxy off · cmd –]");
		for (const state of ["routed", "routed-down", "up", "off"] as const) {
			const out = formatStatus({ proxy: state, proxyPct: Number.NaN, post: { compressed: 0, sent: 2 } });
			expect(out).not.toMatch(/NaN|undefined/);
		}
	});
});

describe("shouldRefresh", () => {
	test("throttle", () => {
		expect(shouldRefresh(1000, undefined)).toBe(true);
		expect(shouldRefresh(5000, 1000)).toBe(false);
		expect(shouldRefresh(11_000, 1000)).toBe(true);
		expect(shouldRefresh(1500, 1000, 400)).toBe(true);
	});
});
