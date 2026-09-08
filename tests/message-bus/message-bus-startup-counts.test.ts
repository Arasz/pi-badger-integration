import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, {
	MESSAGE_BUS_CUSTOM_TYPE,
	MESSAGE_BUS_START_ENTRY_TYPE,
	createSqliteStore,
	type BusStore,
	type MessageBusStartCardData,
} from "../../extensions/message-bus/index.ts";
import { composeDirectStartNotice, type BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

const TODAY_TEXT_1 = "message-bus: 1 private message (broadcasts skipped on startup)\n#5 [direct] private one\nsee /messages for the grouped list";

describe("C-P4-1 zero-drop text is byte-identical", () => {
	test("absent stats → today's text", () => {
		expect(composeDirectStartNotice([msg({ id: 5, targetSession: "s-me", content: "private one" })])).toBe(TODAY_TEXT_1);
	});
	test("zero stats → today's text", () => {
		expect(composeDirectStartNotice([msg({ id: 5, targetSession: "s-me", content: "private one" })], { droppedDirects: 0, droppedBroadcasts: 0 })).toBe(
			TODAY_TEXT_1,
		);
	});
});

describe("C-P4-2 drop counts named in the notice", () => {
	test("exact-count oracle: n older directs and m broadcasts", () => {
		const notice = composeDirectStartNotice([msg({ id: 5, targetSession: "s-me", content: "private one" })], {
			droppedDirects: 1,
			droppedBroadcasts: 3,
		});
		expect(notice).toContain("1 older directs and 3 broadcasts");
		expect(notice).toContain("private one");
	});
});

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "mbus-"));
	const path = join(dir, "ai-badger.db");
	writeFileSync(path, "");
	chmodSync(path, 0o644);
	return path;
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Seed helper with a moving clock: every send stamps the current t. */
function seed(path: string, plan: Array<{ at: number; to: string | null; project?: string | null; body: string }>) {
	let t = T0;
	const seeder = createSqliteStore(path, () => t);
	for (const row of plan) {
		t = row.at;
		seeder.send({ senderSession: "s-a", senderProject: "p1", content: row.body, targetSession: row.to, targetProject: row.project === undefined ? (row.to ? null : "p1") : row.project });
	}
}

const startCtx = (over: Record<string, unknown> = {}) => ({
	sessionManager: { getSessionId: () => "s-me" },
	cwd: "/tmp/proj",
	hasUI: false,
	ui: {},
	...over,
});

describe("S-P4 sqlite dropped counts (non-degenerate fixtures, clock-controlled)", () => {
	test("window-drop: old directs + old broadcasts counted, recent direct delivered", () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-1" },
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-2" },
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-3" },
			{ at: T0 - 60 * MIN, to: null, project: "p1", body: "old-bcast" },
			{ at: T0 - MIN, to: "s-me", body: "fresh" },
		]);
		const store = createSqliteStore(path, () => T0);
		const batch = store.deliverDirectForSession("s-me", "p1");
		expect(batch.messages.map((m) => m.content)).toEqual(["fresh"]);
		expect(batch.droppedDirects).toBe(3);
		expect(batch.droppedBroadcasts).toBe(1);
	});
	test("cap-drop: >16 recent directs deliver 16, drop the rest (mixed ages)", () => {
		const path = tempDb();
		const plan: Array<{ at: number; to: string | null; body: string }> = [];
		for (let i = 0; i < 5; i++) plan.push({ at: T0 - 60 * MIN, to: "s-me", body: `old-${i}` });
		for (let i = 0; i < 20; i++) plan.push({ at: T0 - MIN, to: "s-me", body: `fresh-${i}` });
		plan.push({ at: T0 - MIN, to: null, body: "machine-1" });
		plan.push({ at: T0 - 60 * MIN, to: null, body: "machine-0" });
		seed(path, plan);
		const store = createSqliteStore(path, () => T0);
		const batch = store.deliverDirectForSession("s-me", "p1");
		expect(batch.messages.length).toBe(16);
		expect(batch.droppedDirects).toBe(25 - 16);
		expect(batch.droppedBroadcasts).toBe(2);
	});
	test("subsequent read drops nothing new (cursor already past)", () => {
		const path = tempDb();
		seed(path, [{ at: T0 - MIN, to: "s-me", body: "fresh" }]);
		const store = createSqliteStore(path, () => T0);
		store.deliverDirectForSession("s-me", "p1");
		const second = store.deliverDirectForSession("s-me", "p1");
		expect(second.messages).toEqual([]);
		expect(second.droppedDirects).toBe(0);
		expect(second.droppedBroadcasts).toBe(0);
	});
});

describe("E-P4 wiring startup counts (clock-controlled sqlite backend)", () => {
	test("entry text carries the exact-count oracle; ids = delivered directs only", async () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-1" },
			{ at: T0 - 60 * MIN, to: null, project: "p1", body: "old-bcast-1" },
			{ at: T0 - 60 * MIN, to: null, project: null, body: "old-bcast-2" },
			{ at: T0 - MIN, to: "s-me", body: "fresh-1" },
			{ at: T0 - MIN, to: "s-me", body: "fresh-2" },
		]);
		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, projectId: () => "p1" });
		await fire(pi, "session_start", {}, startCtx());
		const entries = pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE);
		expect(entries.length).toBe(1);
		const data = entries[0]!.data as MessageBusStartCardData;
		expect(data.text).toContain("1 older directs and 2 broadcasts");
		expect(data.count).toBe(2);
		expect(data.ids.length).toBe(2); // delivered directs only — never broadcast ids
	});
	test("zero-drop entry is byte-identical (no drop line)", async () => {
		const path = tempDb();
		seed(path, [{ at: T0 - MIN, to: "s-me", body: "private one" }]);
		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, projectId: () => "p1" });
		await fire(pi, "session_start", {}, startCtx());
		const entries = pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE);
		expect(entries.length).toBe(1);
		expect((entries[0]!.data as MessageBusStartCardData).text).not.toContain("were marked read");
	});
	test("confirm-no with counts: user summary only, pi.sent empty", async () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-1" },
			{ at: T0 - MIN, to: "s-me", body: "fresh-1" },
		]);
		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, projectId: () => "p1" });
		await fire(pi, "session_start", {}, startCtx({ hasUI: true, ui: { notify: () => {}, confirm: async () => false } }));
		expect(pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE).length).toBe(1);
		expect(pi.sent.length).toBe(0);
	});
	test("broadcasts-only startup appends a user-only entry (no agent card)", async () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - MIN, to: null, project: "p1", body: "project noise" },
			{ at: T0 - MIN, to: null, project: null, body: "machine noise" },
		]);
		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, projectId: () => "p1" });
		await fire(pi, "session_start", {}, startCtx({ hasUI: true, ui: { notify: () => {}, confirm: async () => true } }));
		const entries = pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE);
		expect(entries.length).toBe(1);
		expect((entries[0]!.data as MessageBusStartCardData).text).toContain("0 older directs and 2 broadcasts");
		expect(pi.sent.filter((s) => s.message.customType === MESSAGE_BUS_CUSTOM_TYPE).length).toBe(0);
	});
	test("store without counts falls back to today's silence (old fake)", async () => {
		const pi = createFakePi();
		const oldFake = {
			send: () => 101,
			getMessage: () => null,
			listForSession: () => [],
			getCursor: () => 0,
			deliverForSession: () => ({ messages: [], cursor: 0 }),
			deliverDirectForSession: () => ({ messages: [], cursor: 0 }),
		};
		makeExtension(pi as never, { store: oldFake as unknown as BusStore, projectId: () => "p1" });
		await fire(pi, "session_start", {}, startCtx());
		expect(pi.entries.length).toBe(0);
		expect(pi.sent.length).toBe(0);
	});
});
