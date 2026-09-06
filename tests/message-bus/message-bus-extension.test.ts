import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, { MESSAGE_BUS_CUSTOM_TYPE, MESSAGE_BUS_START_ENTRY_TYPE } from "../../extensions/message-bus/index.ts";
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

interface FakeStore {
	sent: Array<{ content: string; targetSession: string | null; targetProject: string | null }>;
	inbox: BusMessage[];
	cursor: number;
	fail?: string;
}

function fakeStore(inbox: BusMessage[] = [], cursor = 0): FakeStore & import("../../extensions/message-bus/index.ts").BusStore {
	const state: FakeStore = { sent: [], inbox, cursor };
	const api = {
		get sent() {
			return state.sent;
		},
		get fail() {
			return state.fail;
		},
		set fail(value: string | undefined) {
			state.fail = value;
		},
		send(args: { senderSession: string; senderProject: string; content: string; targetSession: string | null; targetProject: string | null }) {
			if (state.fail) throw new Error(state.fail);
			state.sent.push({ content: args.content, targetSession: args.targetSession, targetProject: args.targetProject });
			return 100 + state.sent.length;
		},
		getMessage(id: number) {
			return state.inbox.find((m) => m.id === id) ?? null;
		},
		listForSession() {
			if (state.fail) throw new Error(state.fail);
			return [...state.inbox];
		},
		getCursor() {
			return state.cursor;
		},
		deliverForSession() {
			if (state.fail) throw new Error(state.fail);
			const fresh = state.inbox.filter((m) => m.id > state.cursor);
			state.cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.id : state.cursor;
			return { messages: fresh, cursor: state.cursor };
		},
		deliverDirectForSession() {
			if (state.fail) throw new Error(state.fail);
			const fresh = state.inbox.filter((m) => m.id > state.cursor && m.targetSession !== null);
			// real store lands past MAX(id): broadcasts consumed silently on start
			const maxId = state.inbox.length > 0 ? Math.max(...state.inbox.map((m) => m.id)) : state.cursor;
			state.cursor = Math.max(state.cursor, maxId);
			return { messages: fresh, cursor: state.cursor };
		},
	};
	return api as never;
}

const ctx = (over: Record<string, unknown> = {}) => ({
	sessionManager: { getSessionId: () => "s-me" },
	cwd: "/tmp/proj",
	hasUI: true,
	ui: { notify: () => {} },
	...over,
});

const toolCtx = () => ({ sessionManager: { getSessionId: () => "s-me" }, cwd: "/tmp/proj" });

async function callTool(pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>) {
	const tool = pi.tools.get("message-bus") as unknown as { execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
	return tool.execute("t1", params, undefined, undefined, toolCtx());
}

describe("tool send", () => {
	test("1:1 send normalizes session-wins", async () => {
		const pi = createFakePi();
		const store = fakeStore();
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-you", projectId: "p1" });
		expect((result.content[0] as { text: string }).text).toContain("sent");
		expect(store.sent[0]).toEqual({ content: "hi", targetSession: "s-you", targetProject: null });
	});

	test("send without content rejects", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore() as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "send" });
		} catch (e) {
			error = String(e);
		}
		expect(error).toContain("content");
	});

	test("backend failure is an error result path (check) / throw with reason (send)", async () => {
		const pi = createFakePi();
		const store = fakeStore();
		store.fail = "db locked";
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const check = await callTool(pi, { action: "check" });
		expect((check.content[0] as { text: string }).text).toMatch(/failed|unavailable/i);
	});
});

describe("tool list", () => {
	test("grouped text, no raw JSON", async () => {
		const pi = createFakePi();
		const store = fakeStore([msg({ id: 1, targetSession: "s-me", content: "one" }), msg({ id: 2, targetSession: null, targetProject: "p1", content: "two" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "list" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("direct");
		expect(text).toContain("project broadcast");
		expect(text).not.toContain("target_session");
	});
});

describe("tool ack", () => {
	test("acks once as project broadcast", async () => {
		const pi = createFakePi();
		const store = fakeStore([msg({ id: 7, content: "[t] starting: x" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		const result = await callTool(pi, { action: "ack", id: 7 });
		expect((result.content[0] as { text: string }).text).toContain("ack sent");
		expect(store.sent[0]?.content).toBe("ack: [t] starting: x");
		expect(store.sent[0]?.targetProject).toBe("p1");
	});

	test("acking an ack refuses", async () => {
		const pi = createFakePi();
		const store = fakeStore([msg({ id: 8, content: "ack: [t] x" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "ack", id: 8 });
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/already an ack|terminal/);
		expect(store.sent.length).toBe(0);
	});

	test("acking a message outside your inbox refuses", async () => {
		const pi = createFakePi();
		const store = fakeStore([]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		let error = "";
		try {
			await callTool(pi, { action: "ack", id: 9 });
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/inbox/);
		expect(store.sent.length).toBe(0);
	});
});

describe("hooks", () => {
	test("session_start with new mail posts user summary + fallback card (no confirm surface)", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore([msg({ id: 5, targetSession: "s-me" })]) as never, projectId: () => "p1" });
		await fire(pi, "session_start", {}, ctx());
		const cards = pi.sent.filter((s) => s.message.customType === MESSAGE_BUS_CUSTOM_TYPE);
		expect(cards.length).toBe(1);
		expect(pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE).length).toBe(1);
	});

	test("turn_start with empty inbox posts nothing", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore([], 9) as never, projectId: () => "p1" });
		await fire(pi, "turn_start", {}, ctx());
		expect(pi.sent.length).toBe(0);
	});

	test("kill-switch disables hooks but tool still lists", async () => {
		const pi = createFakePi();
		const store = fakeStore([msg({ id: 5, targetSession: "s-me" })]);
		makeExtension(pi as never, { store: store as never, projectId: () => "p1", env: { PI_BADGER_MESSAGE_BUS: "0" } });
		await fire(pi, "session_start", {}, ctx());
		expect(pi.sent.length).toBe(0);
		const result = await callTool(pi, { action: "list" });
		expect((result.content[0] as { text: string }).text).toContain("direct");
	});

	test("broken bus never breaks the hook", async () => {
		const pi = createFakePi();
		const store = fakeStore();
		store.fail = "db gone";
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		await fire(pi, "session_start", {}, ctx()); // must not throw
		expect(pi.sent.length).toBe(0);
	});
});

describe("startup direct gate", () => {
	const mixedInbox = () => [
		msg({ id: 5, targetSession: "s-me", content: "private one" }),
		msg({ id: 6, targetSession: null, targetProject: "p1", content: "project noise" }),
		msg({ id: 7, targetSession: null, targetProject: null, content: "machine noise" }),
	];
	const confirmCtx = (answer: boolean) => ({
		...ctx(),
		ui: { notify: () => {}, confirm: async () => answer },
	});

	test("confirm-yes: user summary + agent card with triggerTurn, direct-only", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore(mixedInbox()) as never, projectId: () => "p1" });
		await fire(pi, "session_start", {}, confirmCtx(true));
		const summaries = pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE);
		expect(summaries.length).toBe(1);
		expect(String((summaries[0]!.data as { text: string }).text)).toMatch(/1 private/);
		const cards = pi.sent.filter((s) => s.message.customType === MESSAGE_BUS_CUSTOM_TYPE);
		expect(cards.length).toBe(1);
		expect(cards[0]!.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
		const body = String(cards[0]!.message.content);
		expect(body).toContain("private one");
		expect(body).not.toContain("project noise");
		expect(body).not.toContain("machine noise");
	});

	test("confirm-no: user summary only, nothing enters agent context (marked read)", async () => {
		const pi = createFakePi();
		const store = fakeStore(mixedInbox());
		makeExtension(pi as never, { store: store as never, projectId: () => "p1" });
		await fire(pi, "session_start", {}, confirmCtx(false));
		expect(pi.entries.filter((e) => e.customType === MESSAGE_BUS_START_ENTRY_TYPE).length).toBe(1);
		expect(pi.sent.length).toBe(0);
		// cursor advanced past broadcasts too: a following turn_start stays silent
		await fire(pi, "turn_start", {}, ctx());
		expect(pi.sent.length).toBe(0);
	});

	test("broadcasts only: silent, no summary and no card", async () => {
		const pi = createFakePi();
		makeExtension(
			pi as never,
			{
				store: fakeStore([
					msg({ id: 6, targetSession: null, targetProject: "p1", content: "project noise" }),
					msg({ id: 7, targetSession: null, targetProject: null, content: "machine noise" }),
				]) as never,
				projectId: () => "p1",
			},
		);
		await fire(pi, "session_start", {}, confirmCtx(true));
		expect(pi.entries.length).toBe(0);
		expect(pi.sent.length).toBe(0);
	});
});

describe("command", () => {
	test("/messages list notifies grouped text", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore([msg({ id: 1, targetSession: "s-me" })]) as never, projectId: () => "p1" });
		const cmd = pi.commands.get("messages") as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		let notified = "";
		await cmd.handler("list", { ...ctx(), ui: { notify: (m: string) => { notified = m; } } });
		expect(notified).toContain("direct");
	});

	test("unknown subcommand shows usage", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore() as never, projectId: () => "p1" });
		const cmd = pi.commands.get("messages") as unknown as { handler: (args: string, ctx: unknown) => Promise<void> };
		let notified = "";
		await cmd.handler("bogus", { ...ctx(), ui: { notify: (m: string) => { notified = m; } } });
		expect(notified).toMatch(/usage/);
	});
});

describe("renderer", () => {
	test("registered for the card type and renders text", () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: fakeStore() as never });
		const render = pi.renderers.get(MESSAGE_BUS_CUSTOM_TYPE);
		expect(render).toBeDefined();
		const out = (render as (m: unknown, o: unknown, t: unknown) => unknown)(
			{ content: "message-bus: 1 new\n#1 hello" },
			{ outputPad: 0 },
			{ bg: (_s: string, l: string) => l, fg: (_t: string, l: string) => l },
		);
		expect(out).toBeDefined();
	});
});
