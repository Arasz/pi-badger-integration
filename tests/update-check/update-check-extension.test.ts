/**
 * update-check wiring tests (TDD RED-first): session_start background check +
 * `/update-check` command, with stub fetch/scheduler/fs-tmp marker.
 *
 * The wiring owns every side effect the core refuses: fetch with timeout,
 * marker read, scheduling, notices. Env is read per call; notices fire at
 * most once per session; offline and fetch failures never error a session.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension from "../../extensions/update-check/index.ts";

function stubFetch(handler: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> }) {
	return async (url: string, _init?: unknown) => handler(url);
}

function okRelease(tag: string) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ tag_name: tag }),
	};
}

function markerInTmp(content: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "uc-"));
	if (content !== null) writeFileSync(join(dir, "installed.json"), content);
	return join(dir, "installed.json");
}

function immediateScheduler() {
	const scheduled: Array<() => void> = [];
	return {
		scheduled,
		scheduler: {
			setTimeout: (handler: () => void, _ms: number) => {
				scheduled.push(handler);
				return scheduled.length;
			},
			clearTimeout: (_h: unknown) => {},
		},
	};
}

async function flush(scheduled: Array<() => void>) {
	while (scheduled.length > 0) {
		const next = scheduled.splice(0);
		for (const handler of next) await handler();
	}
}

describe("session_start background check", () => {
	test("remote newer than marker posts one update notice", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.2.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		const notices = pi.sent.filter((s) => s.message.customType === "update-check-event");
		expect(notices.length).toBe(1);
		expect(notices[0].message.content as string).toContain("v1.2.0");
	});

	test("up to date posts nothing", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.0.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		expect(pi.sent.length).toBe(0);
	});

	test("offline posts nothing and never rejects", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => {
				throw new Error("fetch failed");
			}),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		expect(pi.sent.length).toBe(0);
	});

	test("kill-switch PI_BADGER_UPDATE_CHECK=0 skips the fetch entirely", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		let fetched = false;
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => {
				fetched = true;
				return okRelease("v9.9.9");
			}),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
			env: { PI_BADGER_UPDATE_CHECK: "0" },
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		expect(fetched).toBe(false);
		expect(pi.sent.length).toBe(0);
	});

	test("second session_start in one session does not re-notice", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v2.0.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		expect(pi.sent.length).toBe(1);
	});
});

describe("/update-check command", () => {
	test("status reports installed, remote, and last result", async () => {
		const pi = createFakePi();
		const { scheduler } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.0.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		const cmd = pi.commands.get("update-check") as {
			handler: (args: string, ctx: { ui: { notify: (m: string, t: string) => void } }) => Promise<void>;
		};
		let notified = "";
		await cmd.handler("status", { ui: { notify: (m) => (notified = m) } });
		expect(notified).toMatch(/v1\.0\.0/);
	});

	test("check reports fetch errors verbosely instead of staying silent", async () => {
		const pi = createFakePi();
		const { scheduler } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => {
				throw new Error("dns down");
			}),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		const cmd = pi.commands.get("update-check") as {
			handler: (args: string, ctx: { ui: { notify: (m: string, t: string) => void } }) => Promise<void>;
		};
		let notified = "";
		await cmd.handler("check", { ui: { notify: (m) => (notified = m) } });
		expect(notified).toMatch(/dns down/);
	});

	test("unknown subcommand answers usage", async () => {
		const pi = createFakePi();
		const { scheduler } = immediateScheduler();
		makeExtension(pi as never, { scheduler, markerPath: markerInTmp(null) });
		const cmd = pi.commands.get("update-check") as {
			handler: (args: string, ctx: { ui: { notify: (m: string, t: string) => void } }) => Promise<void>;
		};
		let notified = "";
		await cmd.handler("frobnicate", { ui: { notify: (m) => (notified = m) } });
		expect(notified).toMatch(/usage/);
	});
});
