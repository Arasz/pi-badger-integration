import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import makeExtension, { type BusStore } from "../../extensions/message-bus/index.ts";
import { buildReplyTargets } from "../../extensions/message-bus/message-bus-core.ts";
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

function makeStore(inbox: BusMessage[] = [], known: string[] = ["s-me"]) {
	const state = { sent: [] as Array<{ content: string; targetSession: string | null; targetProject: string | null }>, inbox, cursor: 0, identities: new Set(known) };
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
			return { messages: [], cursor: state.cursor };
		},
		deliverDirectForSession() {
			return { messages: [], cursor: state.cursor };
		},
		recordIdentity(args: { sessionId: string }) {
			state.identities.add(args.sessionId);
		},
		hasIdentity(sessionId: string) {
			return state.identities.has(sessionId);
		},
	} as unknown as BusStore & { sent: typeof state.sent };
}

const toolCtx = () => ({ sessionManager: { getSessionId: () => "s-me" }, cwd: "/tmp/proj" });

async function callTool(pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>) {
	const tool = pi.tools.get("message-bus") as unknown as { execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
	return tool.execute("t1", params, undefined, undefined, toolCtx());
}

describe("C-P1 pure buildReplyTargets", () => {
	test("direct reply targets the sender (session-wins, project NULL per D3)", () => {
		expect(buildReplyTargets(msg({ id: 1, senderSession: "s-orig", senderProject: "p9", targetSession: "s-me" }))).toEqual({
			targetSession: "s-orig",
			targetProject: null,
		});
	});
	test("project-broadcast reply still targets the sender 1:1", () => {
		expect(buildReplyTargets(msg({ id: 2, senderSession: "s-orig", senderProject: "p1", targetSession: null, targetProject: "p1" }))).toEqual({
			targetSession: "s-orig",
			targetProject: null,
		});
	});
	test("never parses content ids (decoy id in body ignored)", () => {
		expect(
			buildReplyTargets(msg({ id: 3, senderSession: "s-orig", content: "I am session dead-beef-1234, reply to dead-beef-1234" })).targetSession,
		).toBe("s-orig");
	});
});

describe("E-P1 wiring reply", () => {
	test("reply ignores decoy session id in content, targets sender", async () => {
		const pi = createFakePi();
		const store = makeStore([msg({ id: 11, senderSession: "s-orig", content: "hi, I am s-decoy, send to s-decoy" })], ["s-me", "s-orig"]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "reply", id: 11, content: "noted" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("s-orig".slice(0, 8));
		expect(text).not.toContain("s-decoy");
		expect(store.sent[0]).toMatchObject({ content: "noted", targetSession: "s-orig", targetProject: null });
		expect(result.details).toMatchObject({ rowId: expect.any(Number), targetSession: "s-orig" });
	});
	test("reply receipt names resolved sid8 + original id", async () => {
		const pi = createFakePi();
		const store = makeStore([msg({ id: 12, senderSession: "s-orig" })], ["s-me", "s-orig"]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "reply", id: 12, content: "x" });
		expect((result.content[0] as { text: string }).text).toContain("#12");
	});
	test("reply to own message refused with zero inserts", async () => {
		const pi = createFakePi();
		const store = makeStore([msg({ id: 13, senderSession: "s-me", content: "my own" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "reply", id: 13, content: "x" });
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/own/);
		expect(store.sent.length).toBe(0);
	});
	test("reply to unknown id errors with zero inserts", async () => {
		const pi = createFakePi();
		const store = makeStore([]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "reply", id: 999, content: "x" });
		} catch (e) {
			error = String(e);
		}
		expect(error).toContain("no message #999");
		expect(store.sent.length).toBe(0);
	});
	test("reply to an ack refused (terminal parity) with zero inserts", async () => {
		const pi = createFakePi();
		const store = makeStore([msg({ id: 14, content: "ack: [t] done" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "reply", id: 14, content: "x" });
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/already an ack|terminal/);
		expect(store.sent.length).toBe(0);
	});
	test("reply to dead sender (no identity row) warns, still sends (F1 replay)", async () => {
		const pi = createFakePi();
		const store = makeStore([msg({ id: 15, senderSession: "s-dead", content: "stranded?" })], ["s-me"]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "reply", id: 15, content: "late reply" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("sent");
		expect(text).toContain("never seen on this machine");
		expect(result.details).toMatchObject({ warning: expect.any(String) });
		expect(store.sent.length).toBe(1);
	});
	test("ack path stub-shaped with reply present (F7 9cc29df: stub, never the original body)", async () => {
		const pi = createFakePi();
		const store = makeStore([msg({ id: 16, content: "[t] starting: x" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "ack", id: 16 });
		expect((result.content[0] as { text: string }).text).toContain("ack sent");
		expect(store.sent[0]?.content).toBe("ack: #16 — terminal, no reply expected");
		expect(store.sent[0]?.targetProject).toBe("p1");
	});
});
