import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, {
	BUS_BUSY_TIMEOUT_MS,
	createSqliteStore,
	openBusDb,
	type BusStore,
} from "../../extensions/message-bus/index.ts";
import { tickCoordinator, type CoordinatorStore } from "../../extensions/message-bus/coordinator.ts";
import { unknownTargetWarning, type BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

/**
 * PKG-4A wire-in + PKG-INT join gates (PKG-1..3 composed in production).
 *
 * The wire-in is ONE new `turn_start` block in extensions/message-bus/index.ts
 * (delimited by the PKG-4A markers — hook region bodies untouched) which runs
 * readRegistrySnapshot → groupByScope/buildChannelCache → tickCoordinator
 * read-only and console.debug-logs the wake set: zero sends, zero cursor
 * writes, fail-open per-tick catch.
 *
 * Shared temp-DB real store, 2+ sessions, non-degenerate fixtures throughout
 * (multi-message inboxes, mixed ages, decoy rows the id-based paths ignore).
 */

const T0 = 1_780_000_000_000;
const MIN = 60_000;

/** Block delimiters the composition pin slices on (must match index.ts). */
const BLOCK_START = "// ---- coordinator tick wire-in (PKG-4A";
const BLOCK_END = "// ---- end coordinator tick wire-in (PKG-4A)";

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "mbus-4a-"));
	const path = join(dir, "ai-badger.db");
	writeFileSync(path, "");
	chmodSync(path, 0o644);
	return path;
}

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: new Date(T0).toISOString(),
	...over,
});

/** Seed rows with per-row send timestamps (INT-5 pattern). */
function seed(path: string, plan: Array<{ at: number; from?: string; to: string | null; project?: string | null; body: string }>): void {
	let t = T0;
	const seeder = createSqliteStore(path, () => t);
	for (const row of plan) {
		t = row.at;
		seeder.send({
			senderSession: row.from ?? "s-seed",
			senderProject: "p1",
			content: row.body,
			targetSession: row.to,
			targetProject: row.project === undefined ? (row.to ? null : "p1") : row.project,
		});
	}
}

function recordLive(path: string, ids: string[]): void {
	const store = createSqliteStore(path, () => T0);
	for (const id of ids) store.recordIdentity!({ sessionId: id, projectId: "p1" });
}

const turnCtx = (sid: string, over: Record<string, unknown> = {}) => ({
	sessionManager: { getSessionId: () => sid },
	cwd: "/tmp/proj",
	hasUI: false,
	ui: {},
	...over,
});

const callTool = async (pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>, sid: string) => {
	const tool = pi.tools.get("message-bus") as unknown as {
		execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	};
	return tool.execute("t1", params, undefined, undefined, { sessionManager: { getSessionId: () => sid }, cwd: "/tmp/proj" });
};

function captureDebug(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const orig = console.debug;
	console.debug = (...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	};
	return { lines, restore: () => { console.debug = orig; } };
}

/** Delegating wrapper with a per-method call counter (kill-switch + failure gates). */
function countingStore(inner: BusStore): { store: BusStore; calls: Map<string, number> } {
	const calls = new Map<string, number>();
	const count = (k: string): void => { calls.set(k, (calls.get(k) ?? 0) + 1); };
	const store: BusStore = {
		send: (a) => { count("send"); return inner.send(a); },
		getMessage: (id) => { count("getMessage"); return inner.getMessage(id); },
		listForSession: (s, p) => { count("listForSession"); return inner.listForSession(s, p); },
		deliverForSession: (s, p) => { count("deliverForSession"); return inner.deliverForSession(s, p); },
		deliverDirectForSession: (s, p) => { count("deliverDirectForSession"); return inner.deliverDirectForSession(s, p); },
		getCursor: (s) => { count("getCursor"); return inner.getCursor(s); },
		peekForSession: (s, p) => { count("peekForSession"); return inner.peekForSession!(s, p); },
		peekDirectForSession: (s, p) => { count("peekDirectForSession"); return inner.peekDirectForSession!(s, p); },
		recordIdentity: (a) => { count("recordIdentity"); return inner.recordIdentity!(a); },
		hasIdentity: (s) => { count("hasIdentity"); return inner.hasIdentity!(s); },
		listIdentities: () => { count("listIdentities"); return inner.listIdentities!(); },
	};
	return { store, calls };
}

const totalCalls = (calls: Map<string, number>): number => [...calls.values()].reduce((a, b) => a + b, 0);

async function withBusyRetry<T>(fn: () => T, tries = 30): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return fn();
		} catch (error) {
			if (i + 1 >= tries || !/locked|busy/i.test(String(error))) throw error;
			await new Promise((r) => setTimeout(r, 5));
		}
	}
}

describe("PKG-4A composition pin (block exists, read-only, all three modules named)", () => {
	test("wire-in block present between markers; names PKG-1..3 seams + debug; no write path inside", () => {
		const source = readFileSync(new URL("../../extensions/message-bus/index.ts", import.meta.url), "utf8");
		const start = source.indexOf(BLOCK_START);
		expect(start, "PKG-4A wire-in block missing — composition not wired").toBeGreaterThanOrEqual(0);
		const end = source.indexOf(BLOCK_END, start);
		expect(end, "PKG-4A end marker missing").toBeGreaterThan(start);
		const block = source.slice(start, end);
		for (const token of ["readRegistrySnapshot", "groupByScope", "buildChannelCache", "tickCoordinator", "console.debug"]) {
			expect(block, `composition must name ${token}`).toContain(token);
		}
		for (const token of ["sendCard", "sendMessage", "deliverForSession", "deliverDirectForSession", "recordIdentity", "appendEntry", ".send("]) {
			expect(block, `forbidden write-path token in wire-in block: ${token}`).not.toContain(token);
		}
	});
});

describe("AC2 turn fires with pending mail for a second session (wire-in runs, read-only)", () => {
	test("coordinator debug names s-b; s-b cursor held with mail still queued; zero coordinator sends", async () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - 60 * MIN, to: "s-a", body: "old-direct-a (decoy age)" },
			{ at: T0 - MIN, to: "s-a", body: "fresh-direct-a" },
			{ at: T0 - MIN, to: "s-b", body: "fresh-direct-b1" },
			{ at: T0 - MIN, to: "s-b", body: "fresh-direct-b2" },
			{ at: T0 - MIN, to: null, project: "p1", body: "fresh-bcast-project (decoy scope)" },
			{ at: T0 - MIN, to: "s-z", body: "other-session direct (decoy target)" },
		]);
		recordLive(path, ["s-a", "s-b"]);
		const probe = createSqliteStore(path, () => T0);
		const cursorBBefore = probe.getCursor("s-b");

		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, sessionId: () => "s-a", projectId: () => "p1" });
		const cap = captureDebug();
		try {
			await fire(pi, "turn_start", {}, turnCtx("s-a"));
		} finally {
			cap.restore();
		}

		// coordinator path ran: the wake set names the mail-bearing second session.
		const debug = cap.lines.join("\n");
		expect(debug, "coordinator tick must console.debug-log the wake set").toContain("coordinator tick");
		expect(debug).toContain("s-b");
		// s-b untouched: cursor held AND its mail still queued (peek, never deliver).
		// The in-scope project broadcast rides along (addressed to s-b's project)
		// while the other-session direct never does — scope-correct wake.
		const after = createSqliteStore(path, () => T0);
		expect(after.getCursor("s-b")).toBe(cursorBBefore);
		expect(after.peekForSession!("s-b", "p1").messages.map((m) => m.content)).toEqual([
			"fresh-direct-b1",
			"fresh-direct-b2",
			"fresh-bcast-project (decoy scope)",
		]);
		// provenance: zero sends from the coordinator block — the only card is
		// s-a's own delivery card (kind "delivery", never "coordinator-tick").
		expect(pi.sent.filter((s) => (s.message.details as { kind?: string } | undefined)?.kind === "coordinator-tick")).toEqual([]);
		expect(pi.sent.length).toBe(1);
		expect((pi.sent[0]!.message.details as { kind?: string }).kind).toBe("delivery");
	});
});

describe("AC3 kill-switch no-ops the coordinator block (tools stay)", () => {
	test('"0" → zero store calls across session_start + turn_start; check/list still answer', async () => {
		const path = tempDb();
		seed(path, [{ at: T0 - MIN, to: "s-a", body: "queued-mail" }]);
		const inner = createSqliteStore(path, () => T0);
		const { store, calls } = countingStore(inner);
		const pi = createFakePi();
		makeExtension(pi as never, { store: store as never, env: { PI_BADGER_MESSAGE_BUS: "0" }, now: () => T0, sessionId: () => "s-a", projectId: () => "p1" });

		await fire(pi, "session_start", {}, turnCtx("s-a"));
		await fire(pi, "turn_start", {}, turnCtx("s-a"));
		expect(totalCalls(calls)).toBe(0);
		expect(pi.sent.length).toBe(0);
		expect(pi.entries.length).toBe(0);

		const checked = await callTool(pi, { action: "check" }, "s-a");
		expect((checked.content[0] as { text: string }).text).toContain("queued-mail");
		const listed = await callTool(pi, { action: "list" }, "s-a");
		expect((listed.content[0] as { text: string }).text).toContain("queued-mail");
	});
});

describe("INT-(i) cursor never passes undelivered mail", () => {
	test("deliver tracks the last delivered id; interleaved sends are never skipped", () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - 60 * MIN, to: "s-v", body: "old-v0" },
			{ at: T0 - 60 * MIN, to: "s-v", body: "old-v1" },
			{ at: T0 - MIN, to: "s-v", body: "fresh-v2" },
			{ at: T0 - MIN, to: "s-v", body: "fresh-v3" },
			{ at: T0 - MIN, to: null, project: "p1", body: "project-news (in-scope decoy)" },
			{ at: T0 - MIN, to: "s-other", body: "not-mine (target decoy)" },
		]);
		const store = createSqliteStore(path, () => T0);
		// first-read gate: the two old-window directs are outside the 30-minute
		// window (documented deliver_for_session parity); the cursor still lands
		// past MAX(id) so they are consumed silently, never re-delivered.
		const first = store.deliverForSession("s-v", "p1");
		expect(first.messages.map((m) => m.id)).toEqual([3, 4, 5]);
		expect(first.cursor).toBe(6);
		expect(store.getCursor("s-v")).toBe(6);
		// nothing new → empty batch, cursor held (never advanced past mail).
		const second = store.deliverForSession("s-v", "p1");
		expect(second.messages).toEqual([]);
		expect(second.cursor).toBe(6);
		// interleaved send lands above the cursor and is returned whole.
		const late = store.send({ senderSession: "s-late", senderProject: "p1", content: "late-direct", targetSession: "s-v", targetProject: null });
		const third = store.deliverForSession("s-v", "p1");
		expect(third.messages.map((m) => m.id)).toEqual([late]);
		expect(third.cursor).toBe(late);
		expect(store.getCursor("s-v")).toBe(late);
	});
});

describe("INT-(ii) one target's failure never blocks another", () => {
	test("tick over the real store with a sick target: A/C decided, sick reported, no throw", async () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - MIN, to: "s-a", body: "mail-a" },
			{ at: T0 - MIN, to: "s-sick", body: "mail-sick" },
			{ at: T0 - MIN, to: "s-c", body: "mail-c1" },
			{ at: T0 - MIN, to: "s-c", body: "mail-c2" },
		]);
		recordLive(path, ["s-a", "s-sick", "s-c"]);
		const inner = createSqliteStore(path, () => T0);
		const peeked: string[] = [];
		const flaky: BusStore = {
			send: (a) => inner.send(a),
			getMessage: (id) => inner.getMessage(id),
			listForSession: (s, p) => inner.listForSession(s, p),
			getCursor: (s) => inner.getCursor(s),
			deliverForSession: (s, p) => inner.deliverForSession(s, p),
			deliverDirectForSession: (s, p) => inner.deliverDirectForSession(s, p),
			listIdentities: () => inner.listIdentities!(),
			peekForSession: (s, p) => {
				peeked.push(s);
				if (s === "s-sick") throw new Error("peek boom (injected)");
				return inner.peekForSession!(s, p);
			},
		};
		const snapshot = {
			version: "ii-tick",
			entries: ["s-a", "s-sick", "s-c"].map((sessionId) => ({ sessionId, projectId: "p1" as string | null, lastSeenMs: T0 })),
		};
		const result = await tickCoordinator(flaky as unknown as CoordinatorStore, snapshot, { now: T0, env: {} });
		expect(result.woke).toEqual(["s-a", "s-c"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({ sessionId: "s-sick" });
		expect(peeked).toEqual(["s-a", "s-sick", "s-c"]);
	});

	test("composition stays fail-open: turn_start with a sick registry target never throws", async () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - MIN, to: "s-a", body: "mail-a" },
			{ at: T0 - MIN, to: "s-sick", body: "mail-sick" },
			{ at: T0 - MIN, to: "s-c", body: "mail-c1" },
		]);
		recordLive(path, ["s-a", "s-sick", "s-c"]);
		const inner = createSqliteStore(path, () => T0);
		const flaky: BusStore = {
			send: (a) => inner.send(a),
			getMessage: (id) => inner.getMessage(id),
			listForSession: (s, p) => inner.listForSession(s, p),
			getCursor: (s) => inner.getCursor(s),
			deliverForSession: (s, p) => inner.deliverForSession(s, p),
			deliverDirectForSession: (s, p) => inner.deliverDirectForSession(s, p),
			recordIdentity: (a) => inner.recordIdentity!(a),
			hasIdentity: (s) => inner.hasIdentity!(s),
			listIdentities: () => inner.listIdentities!(),
			peekForSession: (s, p) => {
				if (s === "s-sick") throw new Error("peek boom (injected)");
				return inner.peekForSession!(s, p);
			},
		};
		const pi = createFakePi();
		makeExtension(pi as never, { store: flaky as never, now: () => T0, sessionId: () => "s-a", projectId: () => "p1" });
		const cap = captureDebug();
		try {
			await fire(pi, "turn_start", {}, turnCtx("s-a")); // must not throw
		} finally {
			cap.restore();
		}
		const debug = cap.lines.join("\n");
		expect(debug).toContain("s-c");
		// s-sick's mail is still queued behind the held cursor (fail-open, never lost).
		expect(inner.peekForSession!("s-sick", "p1").messages.map((m) => m.content)).toEqual(["mail-sick"]);
	});
});

describe("INT-(iii) no ack row is a receipt for any other row; no retry literal drives delivery", () => {
	test("ack broadcast lands as one more row; every non-ack row still delivered; cursor tracks MAX", () => {
		const path = tempDb();
		seed(path, [
			{ at: T0 - MIN, to: "s-b", body: "job-1" },
			{ at: T0 - MIN, to: "s-b", body: "job-2" },
		]);
		const store = createSqliteStore(path, () => T0);
		const ackId = store.send({ senderSession: "s-a", senderProject: "p1", content: "ack: #1 — terminal, no reply expected", targetSession: null, targetProject: "p1" });
		const batch = store.deliverForSession("s-b", "p1");
		expect(batch.messages.map((m) => m.id)).toEqual([1, 2, ackId]);
		expect(batch.messages.filter((m) => !m.content.startsWith("ack:")).map((m) => m.content)).toEqual(["job-1", "job-2"]);
		expect(batch.cursor).toBe(ackId);
	});

	test("no setTimeout/setInterval/retry literal drives delivery (grep pin over the composition sources)", () => {
		for (const file of ["../../extensions/message-bus/coordinator.ts", "../../extensions/message-bus/coordinator-group.ts", "../../extensions/message-bus/index.ts"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			for (const token of ["setTimeout", "setInterval"]) expect(source, `${file} must not schedule delivery`).not.toContain(token);
			expect(source, `${file} must not carry a retry literal`).not.toMatch(/retry/i);
		}
	});
});

describe("INT-(iv) unknown-target sends warn-but-land", () => {
	test("tool send to a never-seen session succeeds with warning and the row is delivered", async () => {
		const path = tempDb();
		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, sessionId: () => "s-a", projectId: () => "p1" });
		const sent = await callTool(pi, { action: "send", content: "hello ghost", sessionId: "s-ghost" }, "s-a");
		const text = (sent.content[0] as { text: string }).text;
		expect(text).toContain("sent");
		expect(text).toContain("warning");
		expect(text).toContain(unknownTargetWarning("s-ghost"));
		expect(sent.details).toMatchObject({ targetSession: "s-ghost", warning: unknownTargetWarning("s-ghost") });

		const store = createSqliteStore(path, () => T0);
		const batch = store.deliverForSession("s-ghost", "p1");
		expect(batch.messages.map((m) => m.content)).toEqual(["hello ghost"]);
		expect(batch.cursor).toBe(batch.messages[0]!.id);
	});
});

describe("INT-(v) kill-switch stops the loop, never the tools", () => {
	test('"0" → repeated starts/turns touch nothing; send/ack/check/list still work', async () => {
		const path = tempDb();
		seed(path, [{ at: T0 - MIN, to: "s-a", body: "ackable-job" }]);
		const inner = createSqliteStore(path, () => T0);
		const { store, calls } = countingStore(inner);
		const pi = createFakePi();
		makeExtension(pi as never, { store: store as never, env: { PI_BADGER_MESSAGE_BUS: "0" }, now: () => T0, sessionId: () => "s-a", projectId: () => "p1" });

		await fire(pi, "session_start", {}, turnCtx("s-a"));
		await fire(pi, "turn_start", {}, turnCtx("s-a"));
		await fire(pi, "turn_start", {}, turnCtx("s-a"));
		expect(totalCalls(calls)).toBe(0);

		const sent = await callTool(pi, { action: "send", content: "still-works", sessionId: "s-b" }, "s-a");
		expect((sent.content[0] as { text: string }).text).toContain("sent");
		const acked = await callTool(pi, { action: "ack", id: 1 }, "s-a");
		expect((acked.content[0] as { text: string }).text).toContain("ack sent");
		const checked = await callTool(pi, { action: "check" }, "s-a");
		expect((checked.content[0] as { text: string }).text).toContain("ackable-job");
		const listed = await callTool(pi, { action: "list" }, "s-a");
		expect((listed.content[0] as { text: string }).text).toContain("s-a".slice(0, 8));
	});
});

describe("INT-(vi) failures fail-open with a held cursor", () => {
	test("throwing read path: turn_start never throws, no card, cursor held; check reports queued", async () => {
		const inbox = [msg({ id: 6, targetSession: "s-fragile", content: "fragile-1" }), msg({ id: 7, targetSession: "s-fragile", content: "fragile-2" })];
		let cursor = 5;
		const failing: BusStore = {
			send: () => { throw new Error("db gone (injected)"); },
			getMessage: (id) => inbox.find((m) => m.id === id) ?? null,
			listForSession: () => [...inbox],
			getCursor: () => cursor,
			deliverForSession: () => { throw new Error("db gone (injected)"); },
			deliverDirectForSession: () => { throw new Error("db gone (injected)"); },
			recordIdentity: () => {},
			hasIdentity: () => true,
			listIdentities: () => [{ sessionId: "s-fragile", projectId: "p1", lastSeenMs: T0 }],
			peekForSession: () => { throw new Error("db gone (injected)"); },
		};
		const pi = createFakePi();
		makeExtension(pi as never, { store: failing as never, now: () => T0, sessionId: () => "s-fragile", projectId: () => "p1" });
		await fire(pi, "turn_start", {}, turnCtx("s-fragile")); // must not throw
		expect(pi.sent.length).toBe(0);
		expect(cursor).toBe(5);

		const checked = await callTool(pi, { action: "check" }, "s-fragile");
		expect(((checked.content[0] as { text: string }).text as string)).toMatch(/failed|queued/);
		expect(cursor).toBe(5);
	});
});

describe("INT-(vii) contention smoke (heartbeat writes included, pragma pinned)", () => {
	test("busy_timeout pinned at 5000 via openBusDb", () => {
		expect(BUS_BUSY_TIMEOUT_MS).toBe(5000);
		const path = tempDb();
		const db = openBusDb(path);
		try {
			const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
			expect(Object.values(row)).toContain(5000);
		} finally {
			db.close();
		}
	});

	test("concurrent sends + heartbeat writes complete; every session's mail + cursor exact", async () => {
		const path = tempDb();
		const ids = ["s-0", "s-1", "s-2", "s-3"];
		const N = 5;
		const writers = ids.map(() => createSqliteStore(path, () => T0));
		const jobs: Array<Promise<unknown>> = [];
		for (let round = 0; round < N; round++) {
			ids.forEach((sid, i) => {
				const store = writers[i]!;
				const next = ids[(i + 1) % ids.length]!;
				jobs.push(withBusyRetry(() => store.send({ senderSession: sid, senderProject: "p1", content: `r${round}-to-${next}`, targetSession: next, targetProject: null })));
				jobs.push(withBusyRetry(() => store.recordIdentity!({ sessionId: sid, projectId: "p1" })));
			});
		}
		await Promise.all(jobs);
		// completion + cursor correctness (smoke-with-retry: lock errors retried above, never asserted absent).
		const reader = createSqliteStore(path, () => T0);
		// first-read lands past MAX(id) over the whole table (documented
		// deliver_for_session parity): every session's cursor settles at the
		// global max while its own batch holds exactly its mail.
		const globalMax = N * ids.length;
		for (const sid of ids) {
			const batch = await withBusyRetry(() => reader.deliverForSession(sid, "p1"));
			expect(batch.messages).toHaveLength(N);
			expect(batch.messages.every((m) => m.targetSession === sid)).toBe(true);
			expect(batch.cursor).toBe(globalMax);
			expect(reader.getCursor(sid)).toBe(globalMax);
			const again = await withBusyRetry(() => reader.deliverForSession(sid, "p1"));
			expect(again.messages).toEqual([]);
		}
		expect(reader.listIdentities!().map((e) => e.sessionId).sort()).toEqual([...ids].sort());
	});
});
