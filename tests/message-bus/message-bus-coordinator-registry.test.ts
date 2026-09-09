import { describe, expect, test } from "bun:test";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import makeExtension, {
	REGISTRY_TOUCH_INTERVAL_MS,
	REGISTRY_TTL_S,
	readRegistrySnapshot,
	type BusStore,
} from "../../extensions/message-bus/index.ts";

const SID = "s-live-local";
const PID = "p-local";

type ToolResult = { content: Array<{ text: string }>; details: Record<string, unknown> };
async function callTool(pi: ReturnType<typeof createFakePi>, params: Record<string, unknown>, sid: string = SID): Promise<ToolResult> {
	const tool = pi.tools.get("message-bus") as unknown as {
		execute: (toolCallId: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<ToolResult>;
	};
	return tool.execute("t1", params, undefined, undefined, { sessionManager: { getSessionId: () => sid }, cwd: "/tmp/proj" });
}

const hookCtx = (sid: string = SID) => ({ sessionManager: { getSessionId: () => sid }, cwd: "/tmp/proj", hasUI: false, ui: {} });

/** Fake registry-backed store: recordIdentity stamps the fake clock, listIdentities reads it back. */
function makeRegistryStore(clock: () => number) {
	const rows = new Map<string, { projectId: string | null; lastSeenMs: number }>();
	const state = { sent: 0, writes: 0 };
	const store = {
		get writes() {
			return state.writes;
		},
		send: () => {
			state.sent += 1;
			return 100 + state.sent;
		},
		getMessage: () => null,
		listForSession: () => [],
		getCursor: () => 0,
		deliverForSession: () => ({ messages: [], cursor: 0 }),
		deliverDirectForSession: () => ({ messages: [], cursor: 0 }),
		peekForSession: () => ({ messages: [], cursor: 0 }),
		peekDirectForSession: () => ({ messages: [], cursor: 0 }),
		recordIdentity: (args: { sessionId: string; projectId: string | null }) => {
			state.writes += 1;
			rows.set(args.sessionId, { projectId: args.projectId, lastSeenMs: clock() });
		},
		hasIdentity: (id: string) => rows.has(id),
		listIdentities: () => [...rows.entries()].map(([sessionId, v]) => ({ sessionId, projectId: v.projectId, lastSeenMs: v.lastSeenMs })),
	};
	return store as unknown as BusStore & { writes: number };
}

describe("PKG-1 registry heartbeat", () => {
	test("AC1: live session appears in snapshot after session_start (fake store + fake clock)", async () => {
		const pi = createFakePi();
		const now = () => pi.clock.now;
		const store = makeRegistryStore(now);
		makeExtension(pi as never, { store: store as never, now, projectId: () => PID });
		await fire(pi, "session_start", {}, hookCtx());
		const snap = readRegistrySnapshot(store, now);
		expect(snap.entries).toHaveLength(1);
		expect(snap.entries[0]).toMatchObject({ sessionId: SID, projectId: PID, lastSeenMs: pi.clock.now });
		expect(snap.version).toContain(":1:");
	});

	test("AC2: entries older than REGISTRY_TTL_S are excluded (value from the constant, no DDL change)", async () => {
		expect(REGISTRY_TTL_S).toBe(300); // MEASUREMENT-TODO placeholder — cited here, never duplicated
		const pi = createFakePi();
		const now = () => pi.clock.now;
		const store = makeRegistryStore(now);
		makeExtension(pi as never, { store: store as never, now, projectId: () => PID });
		await fire(pi, "session_start", {}, hookCtx());
		expect(readRegistrySnapshot(store, now).entries).toHaveLength(1);
		pi.clock.advance(REGISTRY_TTL_S * 1000 + 1);
		const snap = readRegistrySnapshot(store, now);
		expect(snap.entries).toHaveLength(0);
		expect(snap.version).toMatch(/^0:0:/);
	});

	test("AC3: recordIdentity throwing never blocks a send (send stands + single console line)", async () => {
		const pi = createFakePi();
		const now = () => pi.clock.now;
		const throwing = {
			send: () => 101,
			getMessage: () => null,
			listForSession: () => [],
			getCursor: () => 0,
			deliverForSession: () => ({ messages: [], cursor: 0 }),
			deliverDirectForSession: () => ({ messages: [], cursor: 0 }),
			recordIdentity: () => {
				throw new Error("registry locked");
			},
			hasIdentity: () => true,
		};
		makeExtension(pi as never, { store: throwing as never, now, projectId: () => PID });
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => {
			errors.push(a);
		};
		try {
			await fire(pi, "session_start", {}, hookCtx());
			const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-other" });
			expect((result.content[0] as { text: string }).text).toContain("sent");
		} finally {
			console.error = orig;
		}
		expect(errors.length).toBe(1);
	});

	test("AC4: old store without recordIdentity/hasIdentity still sends (characterization)", async () => {
		const pi = createFakePi();
		const sent: unknown[] = [];
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
		makeExtension(pi as never, { store: oldFake as never, projectId: () => PID });
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => {
			errors.push(a);
		};
		try {
			const result = await callTool(pi, { action: "send", content: "hi", sessionId: "s-anyone" });
			expect((result.content[0] as { text: string }).text).toContain("sent");
			expect(result.details).not.toHaveProperty("warning");
			expect(sent.length).toBe(1);
		} finally {
			console.error = orig;
		}
		expect(errors.length).toBe(0); // old store: silent, not even the fail-open log line
	});

	test("AC6: 10 rapid turn_starts cause at most 2 registry writes", async () => {
		expect(REGISTRY_TOUCH_INTERVAL_MS).toBe((REGISTRY_TTL_S * 1000) / 4);
		const pi = createFakePi();
		const now = () => pi.clock.now;
		const store = makeRegistryStore(now);
		makeExtension(pi as never, { store: store as never, now, projectId: () => PID });
		await fire(pi, "session_start", {}, hookCtx());
		for (let i = 0; i < 10; i++) await fire(pi, "turn_start", {}, hookCtx());
		expect(store.writes).toBeLessThanOrEqual(2);
	});

	test("AC6b: touch refreshes after the throttle interval passes", async () => {
		const pi = createFakePi();
		const now = () => pi.clock.now;
		const store = makeRegistryStore(now);
		makeExtension(pi as never, { store: store as never, now, projectId: () => PID });
		await fire(pi, "session_start", {}, hookCtx());
		const before = store.writes;
		pi.clock.advance(REGISTRY_TOUCH_INTERVAL_MS + 1);
		await fire(pi, "turn_start", {}, hookCtx());
		expect(store.writes).toBe(before + 1);
		expect(readRegistrySnapshot(store, now).entries).toHaveLength(1);
	});
});
