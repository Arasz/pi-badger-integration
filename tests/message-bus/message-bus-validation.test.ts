import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi } from "../helpers/fake-pi.ts";
import makeExtension, { createSqliteStore, type BusStore } from "../../extensions/message-bus/index.ts";
import { isValidBusId, unknownTargetWarning, selfSendWarning } from "../../extensions/message-bus/message-bus-core.ts";
import type { BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

/** S0 shared helper: fake store with identity rows + whoami seam (getCursor). */
export function makeIdentityStore(inbox: BusMessage[] = [], known: string[] = []) {
	const state = { sent: [] as Array<{ content: string; targetSession: string | null; targetProject: string | null }>, inbox, cursor: 0, identities: new Set(known) };
	return {
		get sent() {
			return state.sent;
		},
		get identities() {
			return state.identities;
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
		recordIdentity(args: { sessionId: string; projectId: string | null }) {
			state.identities.add(args.sessionId);
		},
		hasIdentity(sessionId: string) {
			return state.identities.has(sessionId);
		},
	} as unknown as BusStore & { sent: typeof state.sent; identities: Set<string>; recordIdentity: (a: { sessionId: string; projectId: string | null }) => void };
}

const toolCtx = () => ({ sessionManager: { getSessionId: () => "s-me" }, cwd: "/tmp/proj" });

async function callTool(pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>) {
	const tool = pi.tools.get("message-bus") as unknown as { execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
	return tool.execute("t1", params, undefined, undefined, toolCtx());
}

describe("C-P3-1 isValidBusId shape table", () => {
	test("accepts uuid + short ids", () => {
		expect(isValidBusId("c64f540b-b36a-400a-883e-27d3f88e8be6")).toBe(true);
		expect(isValidBusId("s-me")).toBe(true);
		expect(isValidBusId("01a08098")).toBe(true);
	});
	test("rejects whitespace / $() / backtick / newline (#672 regression)", () => {
		expect(isValidBusId("$(cat /tmp/x)")).toBe(false);
		expect(isValidBusId("$(x)")).toBe(false); // no-whitespace: pins the $( leg alone
		expect(isValidBusId("a b")).toBe(false);
		expect(isValidBusId("a`b")).toBe(false);
		expect(isValidBusId("a\nb")).toBe(false);
		expect(isValidBusId("a\tb")).toBe(false);
		expect(isValidBusId("")).toBe(false);
	});
});

describe("E-P3-1 unknown direct target: success + warning triple", () => {
	test("unknown sessionId warns, still sends", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore([], ["s-me"]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-dead" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("sent");
		expect(text).toContain(unknownTargetWarning("s-dead").slice(0, 20));
		expect(text).toContain("never seen on this machine");
		expect(result.details).toMatchObject({ rowId: expect.any(Number), warning: expect.any(String) });
		expect(store.sent.length).toBe(1);
	});
	test("known sessionId is silent (no warning key)", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore([], ["s-me", "s-you"]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-you" });
		expect((result.content[0] as { text: string }).text).toContain("sent");
		expect(result.details).not.toHaveProperty("warning");
		expect(store.sent.length).toBe(1);
	});
});

describe("E-P3-2 shape rejection pre-insert, both directions", () => {
	test("bad sessionId rejects with zero inserts", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore();
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "send", content: "hi", sessionId: "$(cat /tmp/x)" });
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/invalid|shape|reject/i);
		expect(store.sent.length).toBe(0);
	});
	test("bad projectId rejects with zero inserts", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore();
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "send", content: "hi", projectId: "a`b" });
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/invalid|shape|reject/i);
		expect(store.sent.length).toBe(0);
	});
	test("blank reads as unset (machine broadcast, no error)", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore();
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "send", content: "hi", sessionId: "  " });
		expect((result.content[0] as { text: string }).text).toContain("machine broadcast");
		expect(store.sent[0]).toMatchObject({ targetSession: null, targetProject: null });
	});
});

describe("E-P3-3 self-send: success + warning triple", () => {
	test("direct to self warns (sender-exclusion filter)", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore([], ["s-me"]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-me" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("sent");
		expect(text).toContain(selfSendWarning("s-me").slice(0, 20));
		expect(text).toContain("never deliverable");
		expect(result.details).toMatchObject({ rowId: expect.any(Number), warning: expect.any(String) });
		expect(store.sent.length).toBe(1);
	});
});

describe("E-P3-4 fallback: store without identity methods still sends", () => {
	test("old fake (no recordIdentity/hasIdentity) sends with no warning", async () => {
		const pi = createFakePi();
		const sent: Array<unknown> = [];
		const oldFake = {
			send: (a: unknown) => {
				sent.push(a);
				return 101;
			},
			getMessage: () => null,
			listForSession: () => [],
			getCursor: () => 0,
			deliverForSession: () => ({ messages: [], cursor: 0 }),
			deliverDirectForSession: () => ({ messages: [], cursor: 0 }),
		};
		makeExtension(pi as never, { store: oldFake as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-anyone" });
		expect((result.content[0] as { text: string }).text).toContain("sent");
		expect(result.details).not.toHaveProperty("warning");
		expect(sent.length).toBe(1);
	});
});

describe("E-P3-5 session_start upsert: idempotent + fail-open", () => {
	test("start records own identity (idempotent across two starts)", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore();
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const { fire } = await import("../router-fallback/helpers.ts");
		const ctx = { sessionManager: { getSessionId: () => "s-me" }, cwd: "/tmp/proj", hasUI: false, ui: {} };
		await fire(pi, "session_start", {}, ctx);
		await fire(pi, "session_start", {}, ctx);
		expect(store.identities.has("s-me")).toBe(true);
		expect(store.identities.size).toBe(1);
	});
	test("upsert throw still delivers startup mail (fail-open)", async () => {
		const pi = createFakePi();
		const store = makeIdentityStore([msg({ id: 5, targetSession: "s-me", content: "private one" })]);
		(store as unknown as { recordIdentity: () => void }).recordIdentity = () => {
			throw new Error("registry locked");
		};
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const { fire } = await import("../router-fallback/helpers.ts");
		const ctx = { sessionManager: { getSessionId: () => "s-me" }, cwd: "/tmp/proj", hasUI: false, ui: {} };
		await fire(pi, "session_start", {}, ctx); // must not throw
		expect(pi.sent.length).toBe(1);
		expect(String(pi.sent[0]!.message.content)).toContain("private one");
	});
});

describe("S-P3 sqlite identity round-trip", () => {
	function tempDb(): string {
		const dir = mkdtempSync(join(tmpdir(), "mbus-"));
		const path = join(dir, "ai-badger.db");
		writeFileSync(path, "");
		chmodSync(path, 0o644);
		return path;
	}
	test("recordIdentity → hasIdentity round-trip via DDL", () => {
		const store = createSqliteStore(tempDb(), () => 1_700_000_000_000);
		expect(store.hasIdentity!("s-new")).toBe(false);
		store.recordIdentity!({ sessionId: "s-new", projectId: "p1" });
		expect(store.hasIdentity!("s-new")).toBe(true);
		store.recordIdentity!({ sessionId: "s-new", projectId: "p1" }); // idempotent
		expect(store.hasIdentity!("s-new")).toBe(true);
	});
	test("broadcast send does not hit the registry (no row created)", () => {
		const dbPath = tempDb();
		const store = createSqliteStore(dbPath, () => 1_700_000_000_000);
		store.send({ senderSession: "s-a", senderProject: "p1", content: "bcast", targetSession: null, targetProject: null });
		expect(store.hasIdentity!("s-a")).toBe(false);
	});
});
