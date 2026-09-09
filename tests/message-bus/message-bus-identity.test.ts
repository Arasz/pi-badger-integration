import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, { FOREIGN_SESSION_ENVS, PI_SESSION_ENV, type BusStore } from "../../extensions/message-bus/index.ts";
import { formatIdentityHeader } from "../../extensions/message-bus/message-bus-core.ts";
import type { BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

const SID = "c64f540b-b36a-400a-883e-27d3f88e8be6";
const PID = "cfe47dab-0000-1111-2222-333344445555";
const SID8 = SID.slice(0, 8);
const PID8 = PID.slice(0, 8);

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: PID,
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

function makeStore(inbox: BusMessage[] = []) {
	const state = { inbox, cursor: 7 };
	return {
		send: () => 101,
		getMessage: () => null,
		listForSession: () => [...state.inbox],
		getCursor: () => state.cursor,
		deliverForSession: () => ({ messages: state.inbox.filter((m) => m.id > state.cursor), cursor: 99 }),
		deliverDirectForSession: () => ({ messages: [], cursor: 99 }),
	} as unknown as BusStore;
}

const toolCtx = (sid: string) => ({ sessionManager: { getSessionId: () => sid }, cwd: "/tmp/proj" });

async function callTool(pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>, sid: string = SID) {
	const tool = pi.tools.get("message-bus") as unknown as { execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
	return tool.execute("t1", params, undefined, undefined, toolCtx(sid));
}

describe("C-P2-1 formatIdentityHeader", () => {
	test("names truncated session + project ids", () => {
		const header = formatIdentityHeader(SID, PID);
		expect(header).toContain(SID8);
		expect(header).toContain(PID8);
		expect(header).toMatch(/you are .* in project /);
	});
	test("anti-tautology: full ids never echoed (truncation is real)", () => {
		const header = formatIdentityHeader(SID, PID);
		expect(header).not.toContain(SID);
		expect(header).not.toContain(PID);
	});
	test("null project states so without crashing", () => {
		expect(formatIdentityHeader(SID, null)).toContain(SID8);
	});
});

describe("E-P2-1 whoami resolves through deps seams", () => {
	test("sessionId + projectId + cursor (content echoes FULL ids — explicit pull)", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => SID, projectId: () => PID });
		const result = await callTool(pi, { action: "whoami" });
		expect(result.details).toMatchObject({ sessionId: SID, projectId: PID, cursor: 7 });
		const text = (result.content[0] as { text: string }).text;
		expect(text.split("\n")[0]).toContain(SID8); // first line stays the truncated header
		expect(text).toContain(SID); // explicit pull: full session echoed
		expect(text).toContain(PID); // explicit pull: full project echoed
	});
	test("null project states so without crashing (full-id lines intact)", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => SID, projectId: () => null });
		const result = await callTool(pi, { action: "whoami" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain(SID);
		expect(text).toContain("full project: (none)");
	});
	test("empty identity fail-open (result, never a throw)", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => "", projectId: () => PID });
		const result = await callTool(pi, { action: "whoami" }, "");
		expect((result.content[0] as { text: string }).text).toMatch(/unavailable|no session/i);
	});
	test("dep sessionId wins over ctx sid (seam proof: dep ≠ ctx), full id in content", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => SID, projectId: () => PID });
		const result = await callTool(pi, { action: "whoami" }, "s-ctx-other");
		expect(result.details).toMatchObject({ sessionId: SID });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain(SID8);
		expect(text).toContain(SID);
	});
});

describe("E-P0 session_start pins process identity (prose-beats-wire fix)", () => {
	const startCtx = { sessionManager: { getSessionId: () => SID }, cwd: "/tmp/proj" };
	test("PI_SESSION_ID pinned to live sid; stale foreign vars cleared", async () => {
		const pi = createFakePi();
		const env: Record<string, string | undefined> = {
			[PI_SESSION_ENV]: "stale-pi-id",
			CLAUDE_CODE_SESSION_ID: "stale-claude-id",
			HERMES_SESSION_ID: "stale-hermes-id",
		};
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => SID, projectId: () => PID, env });
		await fire(pi, "session_start", {}, startCtx);
		expect(env[PI_SESSION_ENV]).toBe(SID);
		for (const foreign of FOREIGN_SESSION_ENVS) expect(env[foreign]).toBeUndefined();
	});
	test("foreign var already equal to sid is kept (shared-id edge)", async () => {
		const pi = createFakePi();
		const env: Record<string, string | undefined> = { CLAUDE_CODE_SESSION_ID: SID };
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => SID, projectId: () => PID, env });
		await fire(pi, "session_start", {}, startCtx);
		expect(env[PI_SESSION_ENV]).toBe(SID);
		expect(env.CLAUDE_CODE_SESSION_ID).toBe(SID);
	});
	test("empty sid leaves env untouched (fail-open, never wipes identity)", async () => {
		const pi = createFakePi();
		const env: Record<string, string | undefined> = { [PI_SESSION_ENV]: "keep-me" };
		makeExtension(pi as never, { store: makeStore() as never, sessionId: () => "", projectId: () => PID, env });
		await fire(pi, "session_start", {}, { sessionManager: { getSessionId: () => "" }, cwd: "/tmp/proj" });
		expect(env[PI_SESSION_ENV]).toBe("keep-me");
	});
});

describe("E-P2 list/check carry the identity header", () => {
	test("list first line is the identity header", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: makeStore([msg({ id: 1, targetSession: SID })]) as never, projectId: () => PID });
		const result = await callTool(pi, { action: "list" });
		const text = (result.content[0] as { text: string }).text;
		const first = text.split("\n")[0]!;
		expect(first).toContain(SID8);
		expect(first).toContain(PID8);
		expect(first).not.toContain(SID); // truncated, not echoed
		expect(result.details).toMatchObject({ cursor: 7 });
	});
	test("check first line is the identity header + details.cursor", async () => {
		const pi = createFakePi();
		makeExtension(pi as never, { store: makeStore([]) as never, projectId: () => PID });
		const result = await callTool(pi, { action: "check" });
		const text = (result.content[0] as { text: string }).text;
		expect(text.split("\n")[0]!).toContain(SID8);
		expect(result.details).toHaveProperty("cursor");
	});
});
