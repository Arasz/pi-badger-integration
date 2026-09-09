import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../extensions/message-bus/index.ts";
import {
	MAX_TICK_SESSIONS,
	REGISTRY_TTL_S,
	tickCoordinator,
	type CoordinatorStore,
	type RegistrySnapshot,
} from "../../extensions/message-bus/coordinator.ts";

const NOW = 1_780_000_000_000;

interface PeekState {
	inbox: Map<string, number[]>;
	peekCalls: string[];
	listCalls: string[];
	cursorCalls: string[];
	writeCalls: string[];
	current: number;
	maxConcurrency: number;
	failPeekFor: Set<string>;
	delayMs: number;
}

function trackingStore(state: PeekState, opts: { withPeek?: boolean; cursor?: number } = {}): CoordinatorStore & {
	state: PeekState;
} {
	const { withPeek = true, cursor = 0 } = opts;
	const track = async <T>(label: "peek" | "list" | "cursor", sessionId: string, fn: () => T | Promise<T>): Promise<T> => {
		state.current += 1;
		state.maxConcurrency = Math.max(state.maxConcurrency, state.current);
		try {
			if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
			return await fn();
		} finally {
			state.current -= 1;
		}
	};
	const api: CoordinatorStore & Record<string, unknown> = {
		async getCursor(sessionId: string) {
			state.cursorCalls.push(sessionId);
			return track("cursor", sessionId, () => cursor);
		},
		async listForSession(sessionId: string) {
			state.listCalls.push(sessionId);
			return track("list", sessionId, () => (state.inbox.get(sessionId) ?? []).map((id) => ({ id })));
		},
		deliverForSession: (sessionId: string) => {
			state.writeCalls.push(`deliverForSession:${sessionId}`);
			throw new Error("tick must never settle via deliverForSession");
		},
		deliverDirectForSession: (sessionId: string) => {
			state.writeCalls.push(`deliverDirectForSession:${sessionId}`);
			throw new Error("tick must never settle via deliverDirectForSession");
		},
		send: (sessionId: string) => {
			state.writeCalls.push(`send:${sessionId}`);
			throw new Error("tick must never write via send");
		},
	};
	if (withPeek) {
		api.peekForSession = async (sessionId: string) => {
			state.peekCalls.push(sessionId);
			return track("peek", sessionId, () => {
				if (state.failPeekFor.has(sessionId)) throw new Error(`peek boom for ${sessionId}`);
				return { messages: (state.inbox.get(sessionId) ?? []).map((id) => ({ id })), cursor: 0 };
			});
		};
	}
	return Object.assign(api, { state });
}

function newState(inbox: Record<string, number[]> = {}): PeekState {
	return {
		inbox: new Map(Object.entries(inbox)),
		peekCalls: [],
		listCalls: [],
		cursorCalls: [],
		writeCalls: [],
		current: 0,
		maxConcurrency: 0,
		failPeekFor: new Set(),
		delayMs: 0,
	};
}

// Convention: every test uses a UNIQUE snapshot version string — rotation state
// (lastVersion/roundRobinOffset) and the single-flight slot are module-global,
// so a reused version would resume another test's pass (or collapse onto its
// run) instead of starting fresh.
const snapshot = (ids: string[], version: string): RegistrySnapshot => ({
	version,
	entries: ids.map((sessionId) => ({ sessionId, projectId: "p1", lastSeenMs: NOW })),
});

describe("coordinator tick (wake-only, read-only)", () => {
	test("AC1 LOAD-BEARING: pending mail + tick → zero write calls, woke computed from the read", async () => {
		const state = newState({ A: [1] });
		const store = trackingStore(state);
		const result = await tickCoordinator(store, snapshot(["A"], "ac1"), { now: NOW, env: {} });
		expect(result.woke).toEqual(["A"]);
		expect(state.peekCalls).toEqual(["A"]);
		expect(state.writeCalls).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("AC1 static pin: coordinator source never names a write path", () => {
		const source = readFileSync(new URL("../../extensions/message-bus/coordinator.ts", import.meta.url), "utf8");
		for (const token of ["deliverForSession", "deliverDirectForSession", "sendMessage", "appendEntry", ".send("]) {
			expect(source, `forbidden write-path token: ${token}`).not.toContain(token);
		}
		expect(source, "coordinator.ts must import only from core, never from index.ts").not.toContain("./index");
		expect(source, "coordinator.ts shares TTL/types/version via core").toContain("message-bus-core");
	});

	test("AC2: per-target fail-open — B throws, A/C still decided, no throw", async () => {
		const state = newState({ A: [1], C: [3] });
		state.failPeekFor.add("B");
		const store = trackingStore(state);
		const result = await tickCoordinator(store, snapshot(["A", "B", "C"], "ac2"), { now: NOW, env: {} });
		expect(result.woke).toEqual(["A", "C"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.sessionId).toBe("B");
		expect(state.peekCalls).toEqual(["A", "B", "C"]);
	});

	test("AC3: single-flight — 3 concurrent ticks → store max-concurrency 1", async () => {
		const state = newState({ A: [1], B: [2] });
		state.delayMs = 15;
		const store = trackingStore(state);
		const snap = snapshot(["A", "B"], "ac3");
		const opts = { now: NOW, env: {} };
		const [r1, r2, r3] = await Promise.all([tickCoordinator(store, snap, opts), tickCoordinator(store, snap, opts), tickCoordinator(store, snap, opts)]);
		expect(state.maxConcurrency).toBe(1);
		expect(state.peekCalls).toEqual(["A", "B"]);
		expect(r2).toEqual(r1);
		expect(r3).toEqual(r1);
	});

	test("single-flight is keyed by snapshot version (+budget): concurrent different-version ticks do not alias", async () => {
		const state = newState({ A: [1], B: [2] });
		state.delayMs = 15;
		const store = trackingStore(state);
		const snapA: RegistrySnapshot = { version: "sf-v1", entries: [{ sessionId: "A", projectId: "p1", lastSeenMs: NOW }] };
		const snapB: RegistrySnapshot = { version: "sf-v2", entries: [{ sessionId: "B", projectId: "p1", lastSeenMs: NOW }] };
		const [r1, r2] = await Promise.all([
			tickCoordinator(store, snapA, { now: NOW, env: {} }),
			tickCoordinator(store, snapB, { now: NOW, env: {} }),
		]);
		expect(r1.woke).toEqual(["A"]);
		expect(r2.woke).toEqual(["B"]);
	});

	test("single-flight key includes budget: same version with different budgets does not collapse", async () => {
		const state = newState({ A: [1], B: [2] });
		state.delayMs = 15;
		const store = trackingStore(state);
		const snap = snapshot(["A", "B"], "sf-budget");
		const p1 = tickCoordinator(store, snap, { now: NOW, env: {}, budget: 1 });
		const p2 = tickCoordinator(store, snap, { now: NOW, env: {}, budget: 2 });
		const collapsed = (p2 as unknown) === (p1 as unknown);
		await Promise.all([p1, p2]);
		expect(collapsed, "same version with different budgets must not collapse onto one run").toBe(false);
	});

	test("AC4: kill-switch → disabled with zero store calls", async () => {
		const state = newState({ A: [1] });
		const store = trackingStore(state);
		const result = await tickCoordinator(store, snapshot(["A"], "ac4-kill"), { now: NOW, env: { PI_BADGER_MESSAGE_BUS: "0" } });
		expect(result.disabled).toBe(true);
		expect(result.woke).toEqual([]);
		expect(result.truncated).toBe(false);
		expect([...state.peekCalls, ...state.listCalls, ...state.cursorCalls, ...state.writeCalls]).toEqual([]);
	});

	test("AC4 idle-empty negative: zero pending → zero writes (read only)", async () => {
		const state = newState({});
		const store = trackingStore(state);
		const result = await tickCoordinator(store, snapshot(["A"], "ac4-idle"), { now: NOW, env: {} });
		expect(result.woke).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(state.writeCalls).toEqual([]);
		expect(state.peekCalls).toEqual(["A"]);
	});

	test("AC5: budget round-robin — 30 sessions, budget 10 → truncated true/true/false, each served once", async () => {
		const ids = Array.from({ length: 30 }, (_, i) => `s-${String(i).padStart(2, "0")}`);
		const inbox: Record<string, number[]> = Object.fromEntries(ids.map((id, i) => [id, [1000 + i]]));
		const state = newState(inbox);
		const store = trackingStore(state);
		const snap = snapshot(ids, "ac5");
		const r1 = await tickCoordinator(store, snap, { now: NOW, env: {}, budget: 10 });
		const r2 = await tickCoordinator(store, snap, { now: NOW, env: {}, budget: 10 });
		const r3 = await tickCoordinator(store, snap, { now: NOW, env: {}, budget: 10 });
		expect(r1.truncated).toBe(true);
		expect(r2.truncated).toBe(true);
		expect(r3.truncated).toBe(false);
		expect(r1.woke).toEqual(ids.slice(0, 10));
		expect(r2.woke).toEqual(ids.slice(10, 20));
		expect(r3.woke).toEqual(ids.slice(20, 30));
		expect([...r1.woke, ...r2.woke, ...r3.woke].sort()).toEqual([...ids].sort());
	});

	test("version bump mid-rotation restarts the pass: every session eventually served, none starved", async () => {
		const ids = Array.from({ length: 10 }, (_, i) => `rot-${i}`);
		const inbox: Record<string, number[]> = Object.fromEntries(ids.map((id, i) => [id, [2000 + i]]));
		const state = newState(inbox);
		const store = trackingStore(state);
		const opts = { now: NOW, env: {} };
		// First pass starts, then the registry is rewritten (new version) mid-rotation.
		const r1 = await tickCoordinator(store, snapshot(ids, "rot-a"), { ...opts, budget: 4 });
		expect(r1.woke).toEqual(ids.slice(0, 4));
		expect(r1.truncated).toBe(true);
		// The bump restarts from the head instead of resuming — head re-served,
		// nothing skipped; the new pass then drains to the tail.
		const r2 = await tickCoordinator(store, snapshot(ids, "rot-b"), { ...opts, budget: 4 });
		expect(r2.woke).toEqual(ids.slice(0, 4));
		expect(r2.truncated).toBe(true);
		const r3 = await tickCoordinator(store, snapshot(ids, "rot-b"), { ...opts, budget: 4 });
		expect(r3.woke).toEqual(ids.slice(4, 8));
		expect(r3.truncated).toBe(true);
		const r4 = await tickCoordinator(store, snapshot(ids, "rot-b"), { ...opts, budget: 4 });
		expect(r4.woke).toEqual(ids.slice(8, 10));
		expect(r4.truncated).toBe(false);
		expect([...r2.woke, ...r3.woke, ...r4.woke].sort()).toEqual([...ids].sort());
	});

	test("AC6: no-ack-write at ROW level after tick over mail-bearing temp-DB sqlite", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mbus-coord-"));
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, "");
		chmodSync(dbPath, 0o644);
		const store = createSqliteStore(dbPath, () => NOW);
		store.send({ senderSession: "s-other", senderProject: "p1", content: "hello victim", targetSession: "s-victim", targetProject: null });
		const before = store.getCursor("s-victim");
		const result = await tickCoordinator(store as unknown as CoordinatorStore, snapshot(["s-victim"], "ac6"), { now: NOW, env: {} });
		expect(result.woke).toEqual(["s-victim"]);
		const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => {
			prepare(sql: string): { get(...p: unknown[]): unknown };
			close(): void;
		} };
		const db = new DatabaseSync(dbPath);
		try {
			const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE 'ack:%'").get() as { n?: unknown };
			expect(Number(row?.n ?? -1)).toBe(0);
		} finally {
			db.close();
		}
		expect(store.getCursor("s-victim")).toBe(before);
	});

	test("fallback seam: no peek → getCursor+list pending check, still read-only", async () => {
		const state = newState({ A: [7] });
		const store = trackingStore(state, { withPeek: false, cursor: 0 });
		const result = await tickCoordinator(store, snapshot(["A", "B"], "fallback"), { now: NOW, env: {} });
		expect(result.woke).toEqual(["A"]);
		expect(state.peekCalls).toEqual([]);
		expect(state.writeCalls).toEqual([]);
	});

	test("stale registry entries (older than REGISTRY_TTL_S) are skipped, not truncated", async () => {
		const state = newState({ fresh: [1], stale: [2] });
		const store = trackingStore(state);
		const result = await tickCoordinator(
			store,
			{
				version: "ttl",
				entries: [
					{ sessionId: "fresh", projectId: "p1", lastSeenMs: NOW },
					{ sessionId: "stale", projectId: "p1", lastSeenMs: NOW - (REGISTRY_TTL_S + 1) * 1000 },
				],
			},
			{ now: NOW, env: {} },
		);
		expect(result.woke).toEqual(["fresh"]);
		expect(result.truncated).toBe(false);
		expect(state.peekCalls).toEqual(["fresh"]);
	});

	test("constants carry their measurement TODOs", () => {
		expect(REGISTRY_TTL_S).toBe(300);
		expect(MAX_TICK_SESSIONS).toBe(25);
	});
});
