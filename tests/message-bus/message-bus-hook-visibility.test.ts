import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, type FakePiSentMessage } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, {
	MESSAGE_BUS_CUSTOM_TYPE,
	createSqliteStore,
	type BusStore,
} from "../../extensions/message-bus/index.ts";
import type { BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

// A1 hook-visibility: hook-path delivery must be agent-visible BEFORE the
// cursor passes it. runCheck advances the cursor in-DB synchronously and only
// then posts the card as an async followUp — under rapid back-to-back turns
// the followUp lands late, so a same-turn `check` reports `no new messages`
// at the advanced cursor with the mail in neither tool result nor transcript.

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: "s-me",
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
	sessionManager: { getSessionId: () => "s-me" },
	cwd: "/tmp/proj",
	hasUI: true,
	ui: { notify: () => {} },
	...over,
});

/** Fake pi whose followUp cards are ACCEPTED synchronously but FLUSHED only on
 * demand — the live ~2min followUp delay. The shared `order` log records
 * card-accept vs cursor-write so the test pins which passed first. */
function deferredPi() {
	const pi = createFakePi();
	const order: string[] = [];
	const queued: FakePiSentMessage[] = [];
	let rejectCards = false;
	const inner = pi.sendMessage.bind(pi);
	pi.sendMessage = (message, options) => {
		if (message.customType === MESSAGE_BUS_CUSTOM_TYPE && options?.deliverAs === "followUp") {
			if (rejectCards) throw new Error("followUp queue full (injected)");
			order.push("card-accepted");
			queued.push({ message, options });
			return;
		}
		inner(message, options);
	};
	const flush = (): void => {
		for (const q of queued.splice(0)) pi.sent.push(q);
	};
	return {
		pi,
		order,
		queued,
		flush,
		setRejectCards: (value: boolean): void => {
			rejectCards = value;
		},
	};
}

interface TrackingStore extends BusStore {
	cursor: number;
}

/** Fake store with the peek seam + a cursor-write spy on the shared order log. */
function trackingStore(order: string[], inbox: BusMessage[]): TrackingStore {
	let cursor = 0;
	const api: TrackingStore = {
		get cursor() {
			return cursor;
		},
		send(args) {
			return 100;
		},
		getMessage(id) {
			return inbox.find((m) => m.id === id) ?? null;
		},
		listForSession() {
			return [...inbox];
		},
		getCursor() {
			return cursor;
		},
		peekForSession() {
			const fresh = inbox.filter((m) => m.id > cursor);
			return { messages: fresh, cursor: fresh.length > 0 ? fresh[fresh.length - 1]!.id : cursor };
		},
		deliverForSession() {
			const fresh = inbox.filter((m) => m.id > cursor);
			cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.id : cursor;
			order.push("cursor-write");
			return { messages: fresh, cursor };
		},
		peekDirectForSession() {
			const fresh = inbox.filter((m) => m.id > cursor && m.targetSession !== null);
			const maxId = inbox.length > 0 ? Math.max(...inbox.map((m) => m.id)) : cursor;
			return { messages: fresh, cursor: Math.max(cursor, maxId), droppedDirects: 0, droppedBroadcasts: 0 };
		},
		deliverDirectForSession() {
			const fresh = inbox.filter((m) => m.id > cursor && m.targetSession !== null);
			const maxId = inbox.length > 0 ? Math.max(...inbox.map((m) => m.id)) : cursor;
			cursor = Math.max(cursor, maxId);
			order.push("cursor-write");
			return { messages: fresh, cursor, droppedDirects: 0, droppedBroadcasts: 0 };
		},
	};
	return api;
}

describe("A1 hook-visibility (agent-visible before the cursor passes it)", () => {
	test("hook-path delivery is agent-visible before the cursor passes it", async () => {
		const { pi, order, queued, flush } = deferredPi();
		const store = trackingStore(order, [msg({ id: 5, content: "private one" })]);
		makeExtension(pi as never, { store, projectId: () => "p1" });
		await fire(pi, "turn_start", {}, ctx());
		// The hook resolved with the card accepted but NOT yet flushed — and
		// the cursor must still have been behind it at accept time.
		expect(queued.length).toBe(1);
		expect(order).toEqual(["card-accepted", "cursor-write"]);
		flush();
		expect(pi.sent.length).toBe(1);
		expect(String(pi.sent[0]!.message.content)).toContain("private one");
	});

	test("headless session_start carries the same guarantee", async () => {
		const { pi, order, queued, flush } = deferredPi();
		const store = trackingStore(order, [msg({ id: 5, content: "private one" })]);
		makeExtension(pi as never, { store, projectId: () => "p1" });
		// No confirm surface (headless): mail must surface to the agent, card
		// accepted before the cursor passes it.
		await fire(pi, "session_start", {}, ctx());
		expect(queued.length).toBe(1);
		expect(order).toEqual(["card-accepted", "cursor-write"]);
		flush();
		expect(pi.sent.length).toBe(1);
	});

	test("a rejected card holds the cursor so the next turn redelivers (hook-path at-least-once)", async () => {
		const { pi, order, queued, setRejectCards } = deferredPi();
		const store = trackingStore(order, [msg({ id: 5, content: "private one" })]);
		makeExtension(pi as never, { store, projectId: () => "p1" });
		setRejectCards(true);
		await fire(pi, "turn_start", {}, ctx()); // fail-open: must not throw
		expect(queued.length).toBe(0);
		expect(order).toEqual([]); // cursor held — mail stays queued
		setRejectCards(false);
		await fire(pi, "turn_start", {}, ctx());
		expect(queued.length).toBe(1);
		expect(order).toEqual(["card-accepted", "cursor-write"]);
	});

	test("sqlite peek reads the deliver selection without writing the cursor", () => {
		const dir = mkdtempSync(join(tmpdir(), "mbus-"));
		const path = join(dir, "ai-badger.db");
		writeFileSync(path, "");
		const store = createSqliteStore(path, () => 1_700_000_000_000);
		store.send({ senderSession: "s-a", senderProject: "p1", content: "private one", targetSession: "s-me", targetProject: null });
		const peeked = store.peekForSession!("s-me", "p1");
		expect(peeked.messages.map((m) => m.content)).toEqual(["private one"]);
		expect(store.getCursor("s-me")).toBe(0); // no write happened
		const delivered = store.deliverForSession("s-me", "p1");
		expect(delivered.messages.map((m) => m.id)).toEqual(peeked.messages.map((m) => m.id));
		expect(store.getCursor("s-me")).toBeGreaterThan(0);
	});

	test("startup reject holds the cursor so the next start redelivers", async () => {
		const { pi, order, queued, setRejectCards } = deferredPi();
		const store = trackingStore(order, [msg({ id: 5, content: "private one" })]);
		makeExtension(pi as never, { store, projectId: () => "p1" });
		setRejectCards(true);
		await fire(pi, "session_start", {}, ctx()); // headless ctx (no confirm surface); fail-open: must not throw
		expect(queued.length).toBe(0);
		expect(order).toEqual([]); // cursor held — mail stays queued
		setRejectCards(false);
		await fire(pi, "session_start", {}, ctx());
		expect(queued.length).toBe(1);
		expect(order).toEqual(["card-accepted", "cursor-write"]);
	});

	test("old store without peek keeps deliver-then-post order", async () => {
		const { pi, order, queued } = deferredPi();
		const inbox = [msg({ id: 5, content: "private one" })];
		let cursor = 0;
		const oldStore = {
			send: () => 100,
			getMessage: (id: number) => inbox.find((m) => m.id === id) ?? null,
			listForSession: () => [...inbox],
			getCursor: () => cursor,
			deliverForSession: () => {
				const fresh = inbox.filter((m) => m.id > cursor);
				cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.id : cursor;
				order.push("cursor-write");
				return { messages: fresh, cursor };
			},
		};
		makeExtension(pi as never, { store: oldStore as unknown as BusStore, projectId: () => "p1" });
		await fire(pi, "turn_start", {}, ctx());
		expect(queued.length).toBe(1);
		expect(order).toEqual(["cursor-write", "card-accepted"]);
	});
});
