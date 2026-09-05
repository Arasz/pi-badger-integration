/**
 * update-check core tests (TDD RED-first): pure version compare + check decision.
 *
 * The matrix this pins (every cell must hold — "all should work"):
 *   network {up, down} x installed {known, unknown, corrupt} x remote
 *   {newer, same, older, none-yet, malformed, fetch-failed}
 * Session-start checks stay silent unless there is an action; the verbose
 * report (including errors) belongs to `/update-check check`.
 */

import { describe, expect, test } from "bun:test";
import {
	UPDATE_CHECK_NOTICE_CAP_CHARS,
	capCheckText,
	compareVersions,
	decideCheck,
	parseVersion,
} from "../../extensions/update-check/update-check-core.ts";

describe("parseVersion", () => {
	test("accepts v-prefixed and bare semver", () => {
		expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
		expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
		expect(parseVersion("v10.20.30")).toEqual([10, 20, 30]);
		expect(parseVersion("v0.0.0")).toEqual([0, 0, 0]);
	});
	test("trims surrounding whitespace", () => {
		expect(parseVersion("  v1.2.3\n")).toEqual([1, 2, 3]);
	});
	test("rejects non-semver tags", () => {
		for (const bad of ["", "v1.2", "1.2", "v1.2.3.4", "latest", "v1.2.x", "release-1.2.3", "v01.2.3", "1.2.3-beta"]) {
			expect(parseVersion(bad), bad).toBeUndefined();
		}
	});
});

describe("compareVersions", () => {
	test("orders by major, then minor, then patch", () => {
		expect(compareVersions([1, 0, 0], [2, 0, 0])).toBe(-1);
		expect(compareVersions([2, 0, 0], [1, 0, 0])).toBe(1);
		expect(compareVersions([1, 9, 0], [1, 10, 0])).toBe(-1);
		expect(compareVersions([1, 2, 3], [1, 2, 4])).toBe(-1);
		expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
	});
});

describe("decideCheck matrix", () => {
	test("offline is always silent, no matter what else is set", () => {
		for (const input of [
			{ networkUp: false, installed: "v1.0.0", remoteTag: "v9.9.9" },
			{ networkUp: false, installed: null, remoteTag: null },
			{ networkUp: false, installed: "garbage", remoteTag: "also-garbage", remoteError: "boom" },
		] as const) {
			const r = decideCheck({ ...input });
			expect(r.action, JSON.stringify(input)).toBe("silent");
		}
	});
	test("fetch failure with network up stays silent at session start (verbose under /update-check check)", () => {
		const r = decideCheck({ networkUp: true, installed: "v1.0.0", remoteTag: null, remoteError: "HTTP 500" });
		expect(r.action).toBe("silent");
		expect(r.reason).toMatch(/fetch/i);
	});
	test("no releases published yet is silent", () => {
		const r = decideCheck({ networkUp: true, installed: "v1.0.0", remoteTag: null });
		expect(r.action).toBe("silent");
	});
	test("unknown installed version notices once with guidance, never an update", () => {
		const r = decideCheck({ networkUp: true, installed: null, remoteTag: "v1.2.0" });
		expect(r.action).toBe("notice");
		if (r.action !== "notice") throw new Error("unreachable");
		expect(r.kind).toBe("guidance");
		expect(r.text).toMatch(/publish/i);
		expect(r.text).not.toMatch(/v1\.2\.0.*available|update available/i);
	});
	test("corrupt installed marker notices guidance, not update", () => {
		const r = decideCheck({ networkUp: true, installed: "not-a-version", remoteTag: "v1.2.0" });
		expect(r.action).toBe("notice");
		if (r.action !== "notice") throw new Error("unreachable");
		expect(r.kind).toBe("guidance");
	});
	test("malformed remote tag is silent (maintainer's problem, not the session's)", () => {
		const r = decideCheck({ networkUp: true, installed: "v1.0.0", remoteTag: "nightly-thing" });
		expect(r.action).toBe("silent");
	});
	test("remote newer notices an update naming both versions and the commands", () => {
		const r = decideCheck({ networkUp: true, installed: "v1.0.0", remoteTag: "v1.2.0" });
		expect(r.action).toBe("notice");
		if (r.action !== "notice") throw new Error("unreachable");
		expect(r.kind).toBe("update");
		expect(r.text).toContain("v1.0.0");
		expect(r.text).toContain("v1.2.0");
		expect(r.text).toMatch(/git pull/);
		expect(r.text).toMatch(/bun run publish/);
	});
	test("same version is silent", () => {
		expect(decideCheck({ networkUp: true, installed: "v1.2.0", remoteTag: "v1.2.0" }).action).toBe("silent");
		expect(decideCheck({ networkUp: true, installed: "1.2.0", remoteTag: "v1.2.0" }).action).toBe("silent");
	});
	test("installed newer than remote (dev checkout ahead) is silent", () => {
		expect(decideCheck({ networkUp: true, installed: "v2.0.0", remoteTag: "v1.9.9" }).action).toBe("silent");
	});
});

describe("capCheckText", () => {
	test("short text passes through, long text keeps the tail and fits the cap", () => {
		expect(capCheckText("hello").length).toBeLessThanOrEqual(UPDATE_CHECK_NOTICE_CAP_CHARS);
		const long = `head-${"x".repeat(UPDATE_CHECK_NOTICE_CAP_CHARS)}-tail-MARKER`;
		const capped = capCheckText(long);
		expect(capped.length).toBeLessThanOrEqual(UPDATE_CHECK_NOTICE_CAP_CHARS);
		expect(capped).toContain("tail-MARKER");
	});
});
