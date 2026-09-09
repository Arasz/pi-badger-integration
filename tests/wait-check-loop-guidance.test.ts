/**
 * Wait wakes on message-bus mail via an internal 1 s tick (task pbi-wait-check-loop-bus-mail).
 *
 * Research docs/work/2026-09-09-pi-wait-wake-message-bus.md F1–F5 proved no push path
 * reaches a wait-held turn cross-process; the loop therefore lives INSIDE the wait tool —
 * from the agent's perspective `wait` just works. These pins cover: the tool-description
 * pointers, the tick mechanics (fixed 1 s cadence, resolve-once, fail-open probe,
 * disarm-with-last-wait), the private high-water mark (race-free vs the adapter's shared
 * cursor — live-test R1 repro), and the default SQLite mark/since probe (never throws).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import monitor, { BUS_MAIL_TICK_MS, defaultBusMailSince, readMailMark } from "../extensions/monitor/index.ts";
import makeMessageBus, { createSqliteStore } from "../extensions/message-bus/index.ts";
import { TRANSITION_CHANNEL } from "../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "./helpers/fake-pi.ts";

// ------------------------------------------------------------------ harness (wait-tool.test.ts idiom)

function manualScheduler() {
	let seq = 0;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		setTimeout: (fn: () => void, ms: number) => {
			const handle = ++seq;
			timers.set(handle, { fn, ms });
			return handle;
		},
		clearTimeout: (handle: unknown) => {
			timers.delete(handle as number);
		},
		timers,
		fire(handle: number) {
			const timer = timers.get(handle);
			if (!timer) throw new Error(`no timer ${handle} armed`);
			timers.delete(handle);
			timer.fn();
		},
	};
}

type Scheduler = ReturnType<typeof manualScheduler>;

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeHarness(
	busProbe?: (ctx: unknown, sinceId: number | null) => boolean,
	mark: number | null | (() => number | null) = 0,
): { pi: FakePi; scheduler: Scheduler } {
	const pi = createFakePi();
	const scheduler = manualScheduler();
	monitor(pi as never, {
		now: () => pi.clock.now,
		scheduler,
		...(busProbe ? { busProbe } : {}),
		readMailMark: typeof mark === "function" ? mark : () => mark,
	});
	return { pi, scheduler };
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}
type Execute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<ToolResult>;

function waitTool(pi: FakePi): Execute {
	const tool = pi.tools.get("wait");
	if (!tool) throw new Error("the monitor extension did not register a `wait` tool");
	return tool.execute as unknown as Execute;
}

function makeCtx(mode = "tui"): Record<string, unknown> {
	return {
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/p",
	};
}

/** A short real sleep so pending-state assertions cannot race the microtask queue. */
const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function startSession(pi: FakePi): void {
	for (const handler of pi.handlers.get("session_start") ?? []) handler({}, makeCtx());
}

function fireTick(scheduler: Scheduler): void {
	for (const [handle, timer] of scheduler.timers) {
		if (timer.ms === BUS_MAIL_TICK_MS) {
			scheduler.fire(handle);
			return;
		}
	}
	throw new Error("no bus-mail tick timer armed");
}

function transition(id: string, state: string) {
	const at = 1_700_000_000_000;
	return {
		id,
		agent: "architect",
		task: "do the thing",
		state,
		at,
		record: {
			id,
			agent: "architect",
			task: "do the thing",
			toolCallId: `tc-${id}`,
			state,
			startedAt: at,
			...(state === "completed" ? { exitCode: 0, endedAt: at } : {}),
		},
	};
}

// ------------------------------------------------------------------ description + doc pins

const HOWTO_URL = new URL("../docs/howto/wait-check-loop.md", import.meta.url);

function toolDescriptions(): Map<string, string> {
	const pi = createFakePi();
	monitor(pi as never);
	makeMessageBus(pi as never, {});
	const out = new Map<string, string>();
	for (const [name, tool] of pi.tools) {
		out.set(name, String((tool as { description?: unknown }).description ?? ""));
	}
	return out;
}

describe("wait + message-bus mail guidance", () => {
	test("wait description names the internal mail check", () => {
		const wait = toolDescriptions().get("wait") ?? "";
		expect(wait).toContain("message-bus mail");
		expect(wait).toContain("every second");
	});

	test("message-bus description states a wait-blocked turn wakes on mail", () => {
		const bus = toolDescriptions().get("message-bus") ?? "";
		expect(bus).toContain("wait");
		expect(bus).toContain("every second");
	});

	test("howto documents the internal tick, timeouts, and kill switch", () => {
		const howto = readFileSync(HOWTO_URL, "utf8");
		expect(howto).toContain("every second");
		expect(howto).toContain("timeoutMs");
		expect(howto).toContain("PI_BADGER_MESSAGE_BUS");
	});
});

// ------------------------------------------------------------------ internal mail tick

describe("wait internal mail tick", () => {
	test("the tick cadence is a fixed 1 second — no ms knob", async () => {
		expect(BUS_MAIL_TICK_MS).toBe(1000);
		const { pi, scheduler } = makeHarness(() => false);
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		// An unknown tickMs param is ignored — the cadence still comes from the const.
		const pending = waitTool(pi)("tc-wait", { tickMs: 5, timeoutMs: 5000 }, undefined, undefined, makeCtx());
		await tick();
		expect([...scheduler.timers.values()].filter((t) => t.ms === BUS_MAIL_TICK_MS)).toHaveLength(1);
		for (const [handle, timer] of scheduler.timers) {
			if (timer.ms !== BUS_MAIL_TICK_MS) scheduler.fire(handle);
		}
		await pending;
	});

	test("mail already waiting resolves observed mail, beating the empty fleet", async () => {
		const { pi, scheduler } = makeHarness(() => true);
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "mail" });
		expect(result.content[0]!.text).toMatch(/mail/i); // the mail line exists, not just the observed flag
		expect(result.content[0]!.text).toMatch(/list/i); // names list: check can read empty when the adapter won the race
		expect(scheduler.timers.size).toBe(0); // tick disarmed with the last wait
	});

	test("the tick re-arms: an empty tick followed by a mail tick wakes", async () => {
		let mail = false;
		const { pi, scheduler } = makeHarness(() => mail);
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		fireTick(scheduler); // empty tick — still waiting, the tick must re-arm
		await tick();
		expect(settled).toBe(false);
		expect(scheduler.timers.size).toBe(2); // timeout plus the re-armed tick
		mail = true;
		fireTick(scheduler);
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "mail" });
		expect(result.content[0]!.text).toMatch(/mail/i);
		expect(result.content[0]!.text).toMatch(/list/i);
	});

	test("a positive probe settles only its own ctx's waits", async () => {
		const ctxA = { ...makeCtx(), cwd: "/a" };
		const ctxB = { ...makeCtx(), cwd: "/b" };
		const { pi, scheduler } = makeHarness((ctx) => ctx === ctxA);
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settledA = false;
		let settledB = false;
		const pendingA = waitTool(pi)("tc-a", {}, undefined, undefined, ctxA).then((r) => {
			settledA = true;
			return r;
		});
		const pendingB = waitTool(pi)("tc-b", {}, undefined, undefined, ctxB).then((r) => {
			settledB = true;
			return r;
		});
		await tick();
		// ctxA's wait resolved via the start-up check; ctxB's keeps waiting.
		expect(settledA).toBe(true);
		expect(settledB).toBe(false);
		expect((await pendingA).details).toMatchObject({ observed: "mail" });
		for (const [handle, timer] of scheduler.timers) {
			if (timer.ms !== BUS_MAIL_TICK_MS) scheduler.fire(handle); // ctxB's own timeout
		}
		expect((await pendingB).details).toMatchObject({ observed: "timeout" });
		void settledB;
	});

	test("mail landing mid-wait wakes the wait on the next tick", async () => {
		let mail = false;
		let probeCalls = 0;
		const { pi, scheduler } = makeHarness(() => {
			probeCalls += 1;
			return mail;
		});
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		expect(settled).toBe(false);
		expect(probeCalls).toBeGreaterThan(0); // the start-up check already probed
		mail = true;
		fireTick(scheduler);
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "mail" });
		expect(scheduler.timers.size).toBe(0); // tick disarmed with the last wait
	});

	test("no mail keeps waiting until the timeout", async () => {
		const { pi, scheduler } = makeHarness(() => false);
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		fireTick(scheduler); // a mail tick with nothing waiting changes nothing
		await tick();
		expect(settled).toBe(false);
		for (const [handle, timer] of scheduler.timers) {
			if (timer.ms !== BUS_MAIL_TICK_MS) scheduler.fire(handle); // the wait's own timeout
		}
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "timeout" });
	});

	test("a throwing probe never resolves or breaks the wait", async () => {
		const { pi, scheduler } = makeHarness(() => {
			throw new Error("bus locked (injected)");
		});
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		fireTick(scheduler);
		await tick();
		expect(settled).toBe(false);
		for (const [handle, timer] of scheduler.timers) {
			if (timer.ms !== BUS_MAIL_TICK_MS) scheduler.fire(handle);
		}
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "timeout" });
	});
});

// ------------------------------------------------------------------ shared-cursor race (live-test R1 repro)

describe("shared-cursor race with the adapter", () => {
	test("mail landing between mark-read and subscribe still wakes", async () => {
		const dir = tempDir("aib-bus-race-window-");
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, "");
		const waiterStore = createSqliteStore(dbPath);
		const adapterStore = createSqliteStore(dbPath);
		const env = { AI_BADGER_USER_ROOT: "." };
		const ctx = { ...makeCtx(), cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		const m1 = waiterStore.send({ senderSession: "s-other", senderProject: "p1", content: "before", targetSession: "s-me", targetProject: null });
		adapterStore.deliverForSession("s-me", null);
		// The WAKE lands inside the mark-read itself (the production comment's window):
		// the wait must still wake, via the liveness re-check or the first tick.
		const { pi, scheduler } = makeHarness(
			(c, sinceId) => defaultBusMailSince(c, env, sinceId),
			() => {
				waiterStore.send({ senderSession: "s-other", senderProject: "p1", content: "WAKE", targetSession: "s-me", targetProject: null });
				return m1;
			},
		);
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, ctx);
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "mail" });
		expect(scheduler.timers.size).toBe(0);
	});

	test("a throwing mark stub degrades to mail-off, wait still works", async () => {
		const { pi, scheduler } = makeHarness(() => true, () => {
			throw new Error("mark unreadable (injected)");
		});
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		fireTick(scheduler);
		await tick();
		expect(settled).toBe(false); // guarded read: null mark, probe never consulted
		for (const [handle, timer] of scheduler.timers) {
			if (timer.ms !== BUS_MAIL_TICK_MS) scheduler.fire(handle);
		}
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "timeout" });
	});

	test("a null mark disables mail wake but nothing else", async () => {
		const { pi, scheduler } = makeHarness(() => true, null); // probe true, mark unreadable
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		fireTick(scheduler);
		await tick();
		expect(settled).toBe(false); // the null-mark wait skips the probe entirely
		for (const [handle, timer] of scheduler.timers) {
			if (timer.ms !== BUS_MAIL_TICK_MS) scheduler.fire(handle);
		}
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "timeout" }); // other sources intact
	});

	test("mail consumed out-of-band mid-wait still wakes the tick", async () => {
		const dir = tempDir("aib-bus-race-");
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, ""); // an existing file lets the store run its DDL
		const waiterStore = createSqliteStore(dbPath);
		const adapterStore = createSqliteStore(dbPath); // second handle: the adapter's poll
		const env = { AI_BADGER_USER_ROOT: "." };
		const ctx = { ...makeCtx(), cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		const m1 = waiterStore.send({ senderSession: "s-other", senderProject: "p1", content: "before", targetSession: "s-me", targetProject: null });
		adapterStore.deliverForSession("s-me", null); // consumed before the wait starts
		// The wait's mark is m1: only strictly-newer mail may wake it, whatever the cursor does.
		const { pi, scheduler } = makeHarness((c, sinceId) => defaultBusMailSince(c, env, sinceId), m1);
		startSession(pi);
		pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
		let settled = false;
		const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, ctx).then((r) => {
			settled = true;
			return r;
		});
		await tick();
		expect(settled).toBe(false);
		// the WAKE lands mid-wait and the adapter's poll consumes it out-of-band
		// (cursor advance now, display at the turn boundary — invisible to the waiter)
		waiterStore.send({ senderSession: "s-other", senderProject: "p1", content: "WAKE", targetSession: "s-me", targetProject: null });
		adapterStore.deliverForSession("s-me", null);
		fireTick(scheduler);
		await tick();
		expect(settled).toBe(true); // the tick saw the WAKE despite the moved cursor
		const result = await pending;
		expect(result.details).toMatchObject({ observed: "mail" });
	});
});

describe("readMailMark", () => {
	test("null with no session identity or cwd (fail-open, never throws)", () => {
		expect(readMailMark({})).toBeNull();
		expect(readMailMark({ cwd: "/p" })).toBeNull();
	});

	test("null when the user DB is missing (fail-open, never throws)", () => {
		const dir = tempDir("aib-bus-probe-missing-");
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		expect(readMailMark(ctx, { AI_BADGER_USER_ROOT: "." })).toBeNull();
	});

	test("0 on an empty inbox, max addressed id otherwise", () => {
		const dir = tempDir("aib-bus-probe-mark-");
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, "");
		const store = createSqliteStore(dbPath);
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		const env = { AI_BADGER_USER_ROOT: "." };
		expect(readMailMark(ctx, env)).toBe(0);
		const m1 = store.send({ senderSession: "s-other", senderProject: "p1", content: "hi", targetSession: "s-me", targetProject: null });
		store.send({ senderSession: "s-other", senderProject: "p1", content: "not mine", targetSession: "s-stranger", targetProject: null });
		expect(readMailMark(ctx, env)).toBe(m1); // stranger mail does not move my mark
	});
});

describe("defaultBusMailSince", () => {
	test("false on a null mark, with no identity, with no cwd, or when the bus is disabled", () => {
		const ctx = { cwd: "/p", sessionManager: { getSessionId: () => "s-me" } };
		expect(defaultBusMailSince(ctx, {}, null)).toBe(false);
		expect(defaultBusMailSince({}, {}, 0)).toBe(false);
		expect(defaultBusMailSince({ cwd: "/p" }, {}, 0)).toBe(false);
		expect(defaultBusMailSince(ctx, { PI_BADGER_MESSAGE_BUS: "0" }, 0)).toBe(false);
	});

	test("false when the user DB is missing (fail-open, never throws)", () => {
		const dir = tempDir("aib-bus-probe-missing-");
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		expect(defaultBusMailSince(ctx, { AI_BADGER_USER_ROOT: "." }, 0)).toBe(false);
	});

	test("true only for ids strictly above the mark", () => {
		const dir = tempDir("aib-bus-probe-mail-");
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, "");
		const store = createSqliteStore(dbPath);
		const m1 = store.send({ senderSession: "s-other", senderProject: "p1", content: "hello", targetSession: "s-me", targetProject: null });
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		const env = { AI_BADGER_USER_ROOT: "." };
		expect(defaultBusMailSince(ctx, env, 0)).toBe(true);
		expect(defaultBusMailSince(ctx, env, m1)).toBe(false); // at-or-below the mark: silent
	});

	test("the kill switch wins even with mail waiting", () => {
		const dir = tempDir("aib-bus-probe-kill-");
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, "");
		const store = createSqliteStore(dbPath);
		store.send({ senderSession: "s-other", senderProject: "p1", content: "hello", targetSession: "s-me", targetProject: null });
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		expect(defaultBusMailSince(ctx, { AI_BADGER_USER_ROOT: "." }, 0)).toBe(true); // sanity
		expect(defaultBusMailSince(ctx, { AI_BADGER_USER_ROOT: ".", PI_BADGER_MESSAGE_BUS: "0" }, 0)).toBe(false);
	});

	test("mail for another session does not read as mine", () => {
		const dir = tempDir("aib-bus-probe-stranger-");
		const dbPath = join(dir, "ai-badger.db");
		writeFileSync(dbPath, "");
		const store = createSqliteStore(dbPath);
		const mine = store.send({ senderSession: "s-other", senderProject: "p1", content: "for me", targetSession: "s-me", targetProject: null });
		store.send({ senderSession: "s-other", senderProject: "p1", content: "for stranger", targetSession: "s-stranger", targetProject: null });
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "s-me" } };
		const env = { AI_BADGER_USER_ROOT: "." };
		expect(defaultBusMailSince(ctx, env, 0)).toBe(true); // sanity: own mail visible
		expect(defaultBusMailSince(ctx, env, mine)).toBe(false); // past my own mail: silent
		const strangerOnly = { cwd: dir, sessionManager: { getSessionId: () => "s-nobody" } };
		expect(defaultBusMailSince(strangerOnly, env, 0)).toBe(false); // stranger mail invisible to others
	});

	test("stores without the hasNewSince seam fall back to list filtering", () => {		const legacy = {
			listForSession: () => [
				{ id: 41, senderSession: "s-other", senderProject: "p1", targetSession: "s-me", targetProject: null, content: "hi", timestamp: "2026-09-09T00:00:00.000Z" },
			],
		};
		const ctx = { cwd: "/p", sessionManager: { getSessionId: () => "s-me" } };
		expect(defaultBusMailSince(ctx, {}, 40, legacy as never)).toBe(true); // 41 > 40 via list
		expect(defaultBusMailSince(ctx, {}, 41, legacy as never)).toBe(false); // at-mark: silent
		expect(defaultBusMailSince(ctx, {}, null, legacy as never)).toBe(false); // null mark: off, even on the fallback path
	});
});
