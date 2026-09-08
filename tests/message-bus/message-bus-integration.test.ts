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
import { unknownTargetWarning, type BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

/**
 * PKG-6 integration (cross-package proof, read-only over PKG-1..5).
 *
 * Each row names the packages it composes and fails if that composition
 * breaks (proven by break-then-restore, see task report — never by reasoning).
 * Fixtures are non-degenerate throughout: multi-message inboxes, mixed ages,
 * decoy rows the id-based paths must ignore.
 */

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

/** Identity-aware fake: registry rows + inbox + sent log (S0 shape, PKG-3). */
function makeIdentityStore(inbox: BusMessage[] = [], known: string[] = []) {
	const state = {
		sent: [] as Array<{ content: string; targetSession: string | null; targetProject: string | null }>,
		inbox,
		cursor: 0,
		identities: new Set(known),
	};
	return {
		get sent() {
			return state.sent;
		},
		send(args: { senderSession: string; senderProject: string; content: string; targetSession: string | null; targetProject: string | null }) {
			state.sent.push({ content: args.content, targetSession: args.targetSession, targetProject: args.targetProject });
			return 100 + state.sent.length;
		},
		getMessage(id: number) {
			return state.inbox.find((m) => m.id === id) ?? null;
		},
		listForSession() {
			return [...state.inbox];
		},
		getCursor() {
			return state.cursor;
		},
		deliverForSession() {
			const fresh = state.inbox.filter((m) => m.id > state.cursor);
			state.cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.id : state.cursor;
			return { messages: fresh, cursor: state.cursor };
		},
		deliverDirectForSession() {
			const fresh = state.inbox.filter((m) => m.id > state.cursor && m.targetSession !== null);
			const maxId = state.inbox.length > 0 ? Math.max(...state.inbox.map((m) => m.id)) : state.cursor;
			state.cursor = Math.max(state.cursor, maxId);
			return { messages: fresh, cursor: state.cursor };
		},
		recordIdentity(args: { sessionId: string }) {
			state.identities.add(args.sessionId);
		},
		hasIdentity(sessionId: string) {
			return state.identities.has(sessionId);
		},
	} as unknown as BusStore & { sent: typeof state.sent };
}

type ToolCaller = (pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>, sid: string) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
const callTool: ToolCaller = async (pi, params, sid) => {
	const tool = pi.tools.get("message-bus") as unknown as {
		execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	};
	return tool.execute("t1", params, undefined, undefined, { sessionManager: { getSessionId: () => sid }, cwd: "/tmp/proj" });
};

const startCtx = (over: Record<string, unknown> = {}) => ({
	sessionManager: { getSessionId: () => "s-me" },
	cwd: "/tmp/proj",
	hasUI: false,
	ui: {},
	...over,
});

describe("INT-1 happy-path triangle (PKG-1 reply × PKG-2 header × PKG-3 known-silence)", () => {
	test("send→reply→whoami/list: reply targets sender, header present, no warning for known id", async () => {
		// one shared store, two sessions (alice sends, bob receives + replies).
		const planted: BusMessage[] = [
			msg({ id: 50, senderSession: "s-carol", targetSession: null, targetProject: "p1", content: "project news" }),
		];
		const store = makeIdentityStore(planted, ["s-alice", "s-bob", "s-carol"]);
		const piAlice = createFakePi();
		const piBob = createFakePi();
		makeExtension(piAlice as never, { store: store as never, sessionId: () => "s-alice", projectId: () => "p1" });
		makeExtension(piBob as never, { store: store as never, sessionId: () => "s-bob", projectId: () => "p1" });

		// send: alice → bob 1:1, known target stays silent (PKG-3).
		const sent = await callTool(piAlice, { action: "send", content: "deploy at dawn", sessionId: "s-bob" }, "s-alice");
		expect((sent.content[0] as { text: string }).text).toContain("sent");
		expect(sent.details).toMatchObject({ rowId: 101, targetSession: "s-bob", targetProject: null });
		expect(sent.details).not.toHaveProperty("warning");

		// deliver: the row lands in bob's inbox beside the decoy broadcast
		// (PKG-1 answers by id, never prose).
		planted.push(msg({ id: 101, senderSession: "s-alice", targetSession: "s-bob", targetProject: null, content: "deploy at dawn" }));

		// reply: targets the sender 1:1 (PKG-1 session-wins), silent for known id (PKG-3).
		const replied = await callTool(piBob, { action: "reply", id: 101, content: "dawn ok" }, "s-bob");
		const replyText = (replied.content[0] as { text: string }).text;
		expect(replyText).toContain("sent");
		expect(replyText).toContain("replied to #101");
		expect(replyText).toContain("s-alice".slice(0, 8));
		expect(replyText).not.toContain("s-carol"); // decoy ignored
		expect(replyText).not.toContain("warning");
		expect(replied.details).toMatchObject({ rowId: 102, repliedTo: 101, targetSession: "s-alice", targetProject: null });
		expect(replied.details).not.toHaveProperty("warning");
		expect(store.sent[1]).toMatchObject({ content: "dawn ok", targetSession: "s-alice", targetProject: null });

		// whoami + list: identity header present (PKG-2) on top of the reply-composed state.
		const who = await callTool(piBob, { action: "whoami" }, "s-bob");
		expect((who.content[0] as { text: string }).text).toContain("s-bob".slice(0, 8));
		expect(who.details).toMatchObject({ sessionId: "s-bob", projectId: "p1" });
		const listed = await callTool(piBob, { action: "list" }, "s-bob");
		const listText = (listed.content[0] as { text: string }).text;
		expect(listText.split("\n")[0]!).toContain("s-bob".slice(0, 8));
		expect(listText).toContain("deploy at dawn");
		// secondary: both sends landed, reply body preserved verbatim.
		expect(store.sent.length).toBe(2);
	});
});

describe("INT-2 warn+header co-present (PKG-1 × PKG-2 × PKG-3)", () => {
	test("reply to dead sender succeeds + unknown warning, header-first order pinned, no collision", async () => {
		const store = makeIdentityStore(
			[
				msg({ id: 14, senderSession: "s-carol", targetSession: null, targetProject: "p1", content: "project news" }),
				msg({ id: 15, senderSession: "s-dead", targetSession: "s-me", targetProject: null, content: "stranded after restart?" }),
			],
			["s-me", "s-carol"], // s-dead has no identity row (F1 replay)
		);
		const pi = createFakePi();
		makeExtension(pi as never, { store: store as never, sessionId: () => "s-me", projectId: () => "p1" });

		// reply reuses the P3 warning helper: success + warning, never a block.
		const replied = await callTool(pi, { action: "reply", id: 15, content: "late reply, still valid" }, "s-me");
		const text = (replied.content[0] as { text: string }).text;
		expect(text).toContain("sent");
		expect(text).toContain("replied to #15");
		expect(text).toContain("s-dead".slice(0, 8));
		expect(text).toContain(unknownTargetWarning("s-dead"));
		// body order pinned: receipt first, warning marker second, warning body third.
		const iReceipt = text.indexOf("replied to #15");
		const iWarn = text.indexOf("warning:");
		const iBody = text.indexOf(unknownTargetWarning("s-dead"));
		expect(iReceipt).toBeGreaterThanOrEqual(0);
		expect(iWarn).toBeGreaterThan(iReceipt);
		expect(iBody).toBeGreaterThan(iWarn);
		// details additive-only: PKG-1 keys (rowId/repliedTo/targets) + PKG-3 key (warning) coexist.
		expect(replied.details).toMatchObject({
			rowId: expect.any(Number),
			repliedTo: 15,
			targetSession: "s-dead",
			targetProject: null,
			warning: unknownTargetWarning("s-dead"),
		});
		expect(store.sent[0]).toMatchObject({ content: "late reply, still valid", targetSession: "s-dead", targetProject: null });

		// header co-present with no collision: check opens with the identity
		// header (PKG-2) and carries no warning line of its own.
		const checked = await callTool(pi, { action: "check" }, "s-me");
		const checkText = (checked.content[0] as { text: string }).text;
		expect(checkText.split("\n")[0]!).toContain("s-me".slice(0, 8));
		expect(checkText).not.toContain(unknownTargetWarning("s-dead"));
	});
});

describe("INT-3 fail-open under broken DB (PKG-3 + D31)", () => {
	function brokenStore(): BusStore {
		const fail = () => {
			throw new Error("db gone");
		};
		return { send: fail, getMessage: fail, listForSession: fail, getCursor: fail, deliverForSession: fail, deliverDirectForSession: fail } as unknown as BusStore;
	}
	test("send/check/whoami/reply all fail-open; hooks never throw; registry-write-failure still delivers", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: brokenStore() as never, sessionId: () => "s-me", projectId: () => "p1" });

		// check: error VALUE (never a session break), no card posted.
		const checked = await callTool(pi, { action: "check" }, "s-me");
		expect(((checked.content[0] as { text: string }).text as string)).toMatch(/failed|unavailable|queued/i);
		expect(pi.sent.length).toBe(0);
		// whoami: identity answers even with the cursor unreadable.
		const who = await callTool(pi, { action: "whoami" }, "s-me");
		expect((who.content[0] as { text: string }).text).toContain("s-me".slice(0, 8));
		expect(who.details).toMatchObject({ cursor: 0 });
		// send + reply: error results, and the session survives both.
		for (const params of [{ action: "send", content: "hi", sessionId: "s-you" }, { action: "reply", id: 1, content: "hi" }]) {
			let error = "";
			try {
				await callTool(pi, params, "s-me");
			} catch (e) {
				error = String(e);
			}
			expect(error).toContain("db gone");
		}
		const stillAlive = await callTool(pi, { action: "whoami" }, "s-me");
		expect((stillAlive.content[0] as { text: string }).text).toContain("s-me".slice(0, 8));
		// hooks: broken backend never breaks the session.
		await fire(pi, "session_start", {}, startCtx());
		await fire(pi, "turn_start", {}, startCtx());
		expect(pi.sent.length).toBe(0);
		expect(pi.entries.length).toBe(0);

		// registry-write-failure still delivers (upsert best-effort, never blocking).
		const delivering = makeIdentityStore([msg({ id: 5, targetSession: "s-me", content: "private one" }), msg({ id: 6, targetSession: "s-me", content: "private two" })], ["s-me"]);
		(delivering as unknown as { recordIdentity: () => void }).recordIdentity = () => {
			throw new Error("registry locked");
		};
		const pi2 = createFakePi();
		makeExtension(pi2 as never, { store: delivering as never, sessionId: () => "s-me", projectId: () => "p1" });
		await fire(pi2, "session_start", {}, startCtx()); // must not throw
		expect(pi2.sent.length).toBe(1);
		expect(String(pi2.sent[0]!.message.content)).toContain("private one");
		expect(pi2.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE).length).toBe(1);
	});
});

describe("INT-4 ack-terminal unchanged with reply present (PKG-1 guards × ack baseline)", () => {
	test("ack works, reply-to-ack refuses, ack-of-ack refuses, ack broadcast vs reply direct", async () => {
		const store = makeIdentityStore(
			[msg({ id: 21, senderSession: "s-orig", targetSession: "s-me", targetProject: null, content: "[t1] starting: x" }), msg({ id: 22, senderSession: "s-orig", targetSession: "s-me", targetProject: null, content: "ack: [t1] done" })],
			["s-me", "s-orig"],
		);
		const pi = createFakePi();
		makeExtension(pi as never, { store: store as never, sessionId: () => "s-me", projectId: () => "p1" });

		// ack works, stays a project broadcast (targetSession NULL, targetProject set).
		// F7 (owner addendum 9cc29df): ack is a metadata-only stub, never the original body.
		const acked = await callTool(pi, { action: "ack", id: 21 }, "s-me");
		expect((acked.content[0] as { text: string }).text).toContain("ack sent");
		expect(acked.details).toMatchObject({ rowId: expect.any(Number), ackedId: 21 });
		expect(store.sent[0]).toMatchObject({ content: "ack: #21 — terminal, no reply expected", targetSession: null, targetProject: "p1" });
		// terminal: reply-to-ack and ack-of-ack both refuse with zero new inserts.
		for (const params of [{ action: "reply", id: 22, content: "x" }, { action: "ack", id: 22 }]) {
			let error = "";
			try {
				await callTool(pi, params, "s-me");
			} catch (e) {
				error = String(e);
			}
			expect(error).toMatch(/already an ack|terminal/);
		}
		expect(store.sent.length).toBe(1);
		// reply to the live message is direct (targetSession set, targetProject NULL) — never broadcast-shaped.
		const replied = await callTool(pi, { action: "reply", id: 21, content: "on it" }, "s-me");
		expect(replied.details).toMatchObject({ repliedTo: 21, targetSession: "s-orig", targetProject: null });
		expect(store.sent[1]).toMatchObject({ content: "on it", targetSession: "s-orig", targetProject: null });
		// secondary: exactly [ack, reply] landed, shapes distinct.
		expect(store.sent.length).toBe(2);
		expect(store.sent[0]!.targetSession).toBeNull();
		expect(store.sent[1]!.targetSession).toBe("s-orig");
	});
});

describe("INT-5 same-start composition (PKG-3 upsert × PKG-4 counts)", () => {
	const T0 = 1_700_000_000_000;
	const MIN = 60_000;
	function tempDb(): string {
		const dir = mkdtempSync(join(tmpdir(), "mbus-"));
		const path = join(dir, "ai-badger.db");
		writeFileSync(path, "");
		chmodSync(path, 0o644);
		return path;
	}
	function seed(path: string, plan: Array<{ at: number; to: string | null; project?: string | null; body: string }>) {
		let t = T0;
		const seeder = createSqliteStore(path, () => t);
		for (const row of plan) {
			t = row.at;
			seeder.send({
				senderSession: "s-a",
				senderProject: "p1",
				content: row.body,
				targetSession: row.to,
				targetProject: row.project === undefined ? (row.to ? null : "p1") : row.project,
			});
		}
	}
	test("one start upserts identity + delivers directs + counts window/cap/broadcast drops + lands past MAX; old store stays silent", async () => {
		const plan: Array<{ at: number; to: string | null; project?: string | null; body: string }> = [
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-0" },
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-1" },
			{ at: T0 - 60 * MIN, to: "s-me", body: "old-2" },
			...Array.from({ length: 20 }, (_, i) => ({ at: T0 - MIN, to: "s-me" as string | null, body: `fresh-${String(i).padStart(2, "0")}` })),
			{ at: T0 - 60 * MIN, to: null, project: "p1", body: "old-bcast-project" },
			{ at: T0 - 60 * MIN, to: null, project: null, body: "old-bcast-machine" },
			{ at: T0 - MIN, to: null, project: "p1", body: "fresh-bcast-project" },
		];
		const path = tempDb();
		seed(path, plan);
		const pi = createFakePi();
		makeExtension(pi as never, { dbPath: path, now: () => T0, sessionId: () => "s-me", projectId: () => "p1" });
		await fire(pi, "session_start", {}, startCtx());

		// counts: 23 directs − 16 delivered = 7 window/cap drops; 3 broadcasts swept.
		const entries = pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE);
		expect(entries.length).toBe(1);
		const data = entries[0]!.data as MessageBusStartCardData;
		expect(data.text).toContain("7 older directs and 3 broadcasts");
		expect(data.count).toBe(16);
		// ids = delivered directs only (ids 4..19: the first 16 fresh directs).
		expect(data.ids).toEqual(Array.from({ length: 16 }, (_, i) => 4 + i));
		expect(data.text).toContain("fresh-00");
		expect(data.text).not.toContain("old-0");
		// upsert rode along on the same start (PKG-3 registry-lite).
		expect(createSqliteStore(path, () => T0).hasIdentity!("s-me")).toBe(true);
		// cursor past MAX: a following read finds nothing new and drops nothing.
		const second = createSqliteStore(path, () => T0).deliverDirectForSession("s-me", "p1");
		expect(second.messages).toEqual([]);
		expect(second.droppedDirects).toBe(0);
		expect(second.droppedBroadcasts).toBe(0);

		// fallback: a count-less store reports unknown (never zero) — broadcasts-only stays silent.
		const piOld = createFakePi();
		const oldFake = {
			send: () => 101,
			getMessage: () => null,
			listForSession: () => [],
			getCursor: () => 0,
			deliverForSession: () => ({ messages: [], cursor: 0 }),
			deliverDirectForSession: () => ({ messages: [], cursor: 7 }),
		};
		makeExtension(piOld as never, { store: oldFake as unknown as BusStore, sessionId: () => "s-me", projectId: () => "p1" });
		await fire(piOld, "session_start", {}, startCtx());
		expect(piOld.entries.length).toBe(0);
		expect(piOld.sent.filter((s) => s.message.customType === MESSAGE_BUS_CUSTOM_TYPE).length).toBe(0);
	});
});
