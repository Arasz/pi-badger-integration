/**
 * update-check wiring tests (TDD RED-first): session_start background check +
 * `/update-check` command, with stub fetch/scheduler/fs-tmp marker.
 *
 * The wiring owns every side effect the core refuses: fetch with timeout,
 * marker read, scheduling, notices. Env is read per call; notices fire at
 * most once per session; offline and fetch failures never error a session.
 *
 * Notices are user-only: they land via `appendEntry` (never `sendMessage`), so
 * they render in the TUI without entering LLM context or triggering a turn.
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

function cardText(entry: { customType: string; data: unknown }): string {
	return (entry.data as { text?: unknown }).text as string;
}

describe("session_start background check", () => {
	test("remote newer than marker posts one user-only update card", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.2.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		const notices = pi.entries.filter((e) => e.customType === "update-check-event");
		expect(notices.length).toBe(1);
		expect(cardText(notices[0])).toContain("v1.2.0");
		// User-only: nothing enters LLM context, no turn is triggered.
		expect(pi.sent.length).toBe(0);
	});

	test("notice card renders via the entry renderer, not a message renderer", async () => {
		const pi = createFakePi();
		const { scheduler } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.0.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: "v1.0.0" })),
		});
		expect(pi.entryRenderers.has("update-check-event")).toBe(true);
		expect(pi.renderers.has("update-check-event")).toBe(false);
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
		expect(pi.entries.length).toBe(0);
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
		expect(pi.entries.length).toBe(0);
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
		expect(pi.entries.length).toBe(0);
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
		expect(pi.entries.length).toBe(1);
		expect(pi.sent.length).toBe(0);
	});

	test("dev checkout at the latest tag line (describe, null version) posts nothing", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.0.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: null, sha: "abc1234", describe: "v1.0.0-2-gabc1234" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		expect(pi.entries.length).toBe(0);
		expect(pi.sent.length).toBe(0);
	});

	test("dev checkout behind the latest release (describe base older) posts one user-only update card", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.1.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: null, sha: "abc1234", describe: "v1.0.0-2-gabc1234" })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		const notices = pi.entries.filter((e) => e.customType === "update-check-event");
		expect(notices.length).toBe(1);
		expect(cardText(notices[0])).toContain("v1.1.0");
		expect(pi.sent.length).toBe(0);
	});

	test("tagless marker (present, no version info) guides to fetch --tags", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.1.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: null, sha: "abc1234", describe: null })),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		const notices = pi.entries.filter((e) => e.customType === "update-check-event");
		expect(notices.length).toBe(1);
		expect(cardText(notices[0])).toMatch(/fetch --tags/);
		expect(pi.sent.length).toBe(0);
	});

	test("missing marker file guides to publish once", async () => {
		const pi = createFakePi();
		const { scheduler, scheduled } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.1.0")),
			scheduler,
			markerPath: markerInTmp(null),
		});
		await fire(pi, "session_start", {}, undefined);
		await flush(scheduled);
		const notices = pi.entries.filter((e) => e.customType === "update-check-event");
		expect(notices.length).toBe(1);
		expect(cardText(notices[0])).toMatch(/bun run publish/);
		expect(pi.sent.length).toBe(0);
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

	test("status names the describe base and ahead count when no exact version is recorded", async () => {
		const pi = createFakePi();
		const { scheduler } = immediateScheduler();
		makeExtension(pi as never, {
			fetchFn: stubFetch(() => okRelease("v1.0.0")),
			scheduler,
			markerPath: markerInTmp(JSON.stringify({ version: null, sha: "abc1234", describe: "v1.0.0-2-gabc1234" })),
		});
		const cmd = pi.commands.get("update-check") as {
			handler: (args: string, ctx: { ui: { notify: (m: string, t: string) => void } }) => Promise<void>;
		};
		let notified = "";
		await cmd.handler("status", { ui: { notify: (m) => (notified = m) } });
		expect(notified).toMatch(/v1\.0\.0/);
		expect(notified).toMatch(/\+ ?2/);
	});
});
