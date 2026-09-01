/**
 * P2 suite — registry group bookkeeping + the shared fake-pi harness (plan v2 packages P2,
 * rows Q-B1…Q-B6 of docs/work/2026-09-01-monitor-queue-delegation-plan.md).
 *
 * The registry harness is the makeRegistry fixture from tests/delegation-runner.test.ts
 * (FakeChild, injected clock, per-test temp log dir) driving the REAL DelegationRegistry.
 * Rows here cover the group-level registry surface: enqueueGroup (allocate-then-register,
 * per-member receipts, batch-commit-before-spawn), clearQueue (queued-only flush through the
 * queued-abort path), member-abort / all-aborted-collapse, timeout inheritance and shutdown.
 *
 * The fake-pi harness pins live here too (the harness is P2's deliverable): routing-bus
 * semantics, handler arrays per event, and the mutable injected clock lane B consumes.
 */

import { describe, expect, test } from "bun:test";
import { FakeChild } from "./helpers/fake-child.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import {
  DelegationRegistry,
  type DelegationDeps,
  type GroupMemberOutcome,
  type StartRequest,
} from "../extensions/subagent/delegation-registry.ts";
import type { DelegationNote, DelegationProgress, LogSinkFactory, SpawnFn } from "../extensions/subagent/delegation-runner.ts";

const NOW = 1_700_000_000_000;

// ------------------------------------------------------------------ fixtures (delegation-runner.test.ts harness)

function assistantEnd(text: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...(usage ? { usage } : {}) },
  };
}

function makeLogSink(): { logs: Map<string, string[]>; logSink: LogSinkFactory } {
  const logs = new Map<string, string[]>();
  const logSink: LogSinkFactory = ({ id }) => ({
    logFile: `/tmp/delegation-logs/${id}.jsonl`,
    appendLine: (line) => {
      const list = logs.get(id) ?? [];
      list.push(line);
      logs.set(id, list);
    },
  });
  return { logs, logSink };
}

interface RegistryHarness {
  registry: DelegationRegistry;
  children: FakeChild[];
  notes: DelegationNote[];
  updates: DelegationProgress[];
  logs: Map<string, string[]>;
}

function makeRegistry(overrides: Partial<DelegationDeps> = {}): RegistryHarness {
  const children: FakeChild[] = [];
  const notes: DelegationNote[] = [];
  const updates: DelegationProgress[] = [];
  const { logs, logSink } = makeLogSink();
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const registry = new DelegationRegistry({
    escalateAfterMs: 0,
    now: () => NOW,
    spawnFn,
    logSink,
    notifyComplete: (note) => notes.push(note),
    onUpdate: (progress) => updates.push(progress),
    ...overrides,
  });
  return { registry, children, notes, updates, logs };
}

function startRequest(overrides: Partial<StartRequest> = {}): StartRequest {
  return { agent: "architect", task: "do the thing", args: ["--", "do the thing"], cwd: "/p", ...overrides };
}

/** Let scheduled 0 ms escalation timers (and other macrotasks) run to completion. */
function drainMacrotasks(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idsOf(outcomes: GroupMemberOutcome[]): string[] {
  return outcomes.map((outcome) => (outcome.ok ? outcome.id : "<rejected>"));
}

/**
 * A child that fails SYNCHRONOUSLY inside runner.run(): the error listener fires the moment
 * the runner registers it, so the settle cascade (onSettle → releaseRun → spawnQueued) runs
 * before the spawn call returns — the self-settling trap Q-B2 pins the batch-commit against.
 */
class SyncFailChild extends FakeChild {
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === "error") {
      listener(new Error("spawn failed synchronously"));
      return this;
    }
    return super.on(event, listener);
  }
}

// ------------------------------------------------------------------ Q-B1: allocate-then-register

describe("registry enqueueGroup (Q-B1, Q-B4 — plan v2 R2/★M3)", () => {
  test("Q-B1: enqueueing 3 members allocates 3 distinct ids — every id allocated before any spawn", async () => {
    const allocations: string[] = [];
    const allocationCountAtSpawn: number[] = [];
    const h = makeRegistry({
      allocateId: () => {
        const id = `x-${allocations.length + 1}`;
        allocations.push(id);
        return id;
      },
      spawnFn: () => {
        allocationCountAtSpawn.push(allocations.length);
        const child = new FakeChild();
        h.children.push(child);
        return child;
      },
    });
    // h is captured by the spawnFn closure above; assigned right after construction.
    const outcomes = await h.registry.enqueueGroup(
      [startRequest({ task: "one" }), startRequest({ task: "two" }), startRequest({ task: "three" })],
      "parallel",
    );

    expect(idsOf(outcomes)).toEqual(["x-1", "x-2", "x-3"]); // 3 members, 3 distinct ids (★M3)
    expect(h.children).toHaveLength(3); // idle system → the whole parallel group dequeues now
    for (const outcome of outcomes) {
      expect(outcome.ok && outcome.record.state).toBe("running");
      expect(outcome.ok && outcome.groupId).toBe("g-1"); // one group id shared by all members
      expect(outcome.ok && outcome.mode).toBe("parallel");
    }
    // allocate-then-register: every spawn happened after ALL three ids were allocated
    expect(allocationCountAtSpawn).toEqual([3, 3, 3]);
  });

  test("Q-B4: enqueue to an idle system dequeues immediately; receipts report running vs queued with flat positions", async () => {
    const h = makeRegistry({ cap: 2, queueCap: 16 });
    const outcomes = await h.registry.enqueueGroup(
      [startRequest({ task: "one" }), startRequest({ task: "two" }), startRequest({ task: "three" })],
      "serial",
    );

    // idle: the serial group admits exactly its first member; the rest queue behind it
    expect(outcomes[0].ok && outcomes[0].record.state).toBe("running");
    expect(outcomes[1].ok && outcomes[1].record.state).toBe("queued");
    expect(outcomes[1].ok && outcomes[1].record.queuePosition).toBe(1);
    expect(outcomes[2].ok && outcomes[2].record.queuePosition).toBe(2);
    expect(h.children).toHaveLength(1);

    // the release admits the group's next member in the same synchronous flow
    h.children[0]!.exit(0);
    expect(h.children).toHaveLength(2);
    expect(h.registry.get(idsOf(outcomes)[1]!)?.state).toBe("running");

    // a non-idle enqueue never starts at enqueue time: it waits entirely for the next release
    const late = await h.registry.enqueueGroup([startRequest({ task: "late" })], "serial");
    expect(late[0].ok && late[0].record.state).toBe("queued");
    expect(h.children).toHaveLength(2);
  });

  test("an enqueue the admission policy rejects is rejected all-or-nothing: no ids registered, no children", async () => {
    const h = makeRegistry({ cap: 2, queueCap: 16 });
    const outcomes = await h.registry.enqueueGroup(
      [startRequest({ task: "one" }), startRequest({ task: "two" }), startRequest({ task: "three" })],
      "parallel", // 3 members > running cap 2 (R3)
    );

    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.reason).toContain("cap of 2");
      expect(!outcome.ok && outcome.reason).toContain("PI_BADGER_SUBAGENT_MAX_CONCURRENT");
      expect(!outcome.ok && outcome.reason).toContain("split");
    }
    expect(h.children).toHaveLength(0);
    expect(h.registry.list()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ Q-B2: batch-commit-before-spawn

describe("batch-commit-before-spawn (Q-B2 — plan v2 ★B5)", () => {
  test("Q-B2: a synchronous settle inside a parallel-group spawn admits no duplicate member (enqueue path)", async () => {
    let spawns = 0;
    const h = makeRegistry({
      spawnFn: () => {
        spawns += 1;
        const child = spawns === 1 ? new SyncFailChild() : new FakeChild(); // member 1 self-settles inside run()
        h.children.push(child);
        return child;
      },
    });
    const outcomes = await h.registry.enqueueGroup(
      [startRequest({ task: "one" }), startRequest({ task: "two" }), startRequest({ task: "three" })],
      "parallel",
    );

    // the whole group was committed to admission state BEFORE any spawn, so member 1's
    // synchronous settle could not re-admit members 2/3 — each spawned exactly once
    expect(h.children).toHaveLength(3); // a double-admit would spawn members 2/3 twice (5 children)
    expect(idsOf(outcomes)).toEqual(["d-1", "d-2", "d-3"]);
    expect(outcomes[0].ok && outcomes[0].record.state).toBe("failed");
    expect(outcomes[1].ok && outcomes[1].record.state).toBe("running");
    expect(outcomes[2].ok && outcomes[2].record.state).toBe("running");
    expect(await (outcomes[0].ok ? outcomes[0].done : Promise.reject(new Error("unreachable")))).toMatchObject({
      state: "failed",
    });
  });

  test("Q-B2: the same invariant on the release path — a parallel group admitted by a release spawns once each", async () => {
    let spawns = 0;
    const h = makeRegistry({
      spawnFn: () => {
        spawns += 1;
        const child = spawns === 3 ? new SyncFailChild() : new FakeChild(); // third spawn = first group member
        h.children.push(child);
        return child;
      },
    });
    await h.registry.start(startRequest({ task: "s1" }));
    await h.registry.start(startRequest({ task: "s2" }));
    const outcomes = await h.registry.enqueueGroup(
      [startRequest({ task: "m1" }), startRequest({ task: "m2" }), startRequest({ task: "m3" })],
      "parallel", // 2 running + 3 pending > cap 4: the group waits
    );
    expect(h.children).toHaveLength(2);

    h.children[0]!.exit(0); // release → 1 + 3 ≤ 4: the whole group drains into admission state…

    // …then spawns: member 1 self-settles inside run() but must not re-admit members 2/3
    expect(h.children).toHaveLength(5); // 2 singles + 3 group spawns, one each (a double-admit → 7)
    expect(h.registry.get(idsOf(outcomes)[0]!)?.state).toBe("failed");
    expect(h.registry.get(idsOf(outcomes)[1]!)?.state).toBe("running");
    expect(h.registry.get(idsOf(outcomes)[2]!)?.state).toBe("running");

    h.children[1]!.exit(0); // hygiene: settle the second single
    expect(h.notes.map((note) => note.state).sort()).toEqual(["completed", "completed", "failed"]);
  });
});

// ------------------------------------------------------------------ Q-B3: clear during a synchronous cascade

describe("clearQueue (Q-B3 — plan v2 R4/★S-4)", () => {
  test("Q-B3: clear during a synchronous settle cascade: no double-admit, cleared members never spawn, one aborted note per cleared member", async () => {
    interface Harness extends RegistryHarness {
      clearResult: { cancelled: string[]; stillRunning: string[] } | undefined;
    }
    let h: Harness | undefined;
    let spawns = 0;
    const spawnFn: SpawnFn = (_command, _args, options) => {
      spawns += 1;
      if (spawns === 3 && h) {
        // the cascade's spawn: group P settled, serial member s1 is spawning, t1 still queued
        h.clearResult = h.registry.clearQueue();
      }
      const child = new FakeChild();
      h!.children.push(child);
      void options;
      return child;
    };
    const { logs, logSink } = makeLogSink();
    const registry = new DelegationRegistry({
      escalateAfterMs: 0,
      now: () => NOW,
      spawnFn,
      logSink,
      notifyComplete: (note) => h!.notes.push(note),
      onUpdate: (progress) => h!.updates.push(progress),
    });
    h = { registry, children: [], notes: [], updates: [], logs, clearResult: undefined };

    const groupP = await registry.enqueueGroup(
      [startRequest({ task: "p1" }), startRequest({ task: "p2" })],
      "parallel",
    ); // idle → both spawn
    const groupS = await registry.enqueueGroup([startRequest({ task: "s1" })], "serial"); // waits
    const groupT = await registry.enqueueGroup([startRequest({ task: "t1" })], "serial"); // waits
    const t1Id = groupT[0].ok ? groupT[0].id : "";
    expect(h.children).toHaveLength(2);

    h.children[0]!.exit(0); // p1 settles → s1 (waiting head) admits and spawns → the hook clears the queue
    expect(h.children).toHaveLength(3); // t1 never spawned
    expect(registry.get(t1Id)?.state).toBe("aborted");
    expect(h.clearResult?.cancelled).toEqual([t1Id]);
    expect(await (groupT[0].ok ? groupT[0].done : Promise.reject(new Error("unreachable")))).toMatchObject({
      state: "aborted",
    });

    h.children[1]!.exit(0); // p2 settles
    h.children[2]!.exit(0); // s1 settles

    const abortedNotes = h.notes.filter((note) => note.state === "aborted");
    expect(abortedNotes.map((note) => note.id)).toEqual([t1Id]); // exactly one aborted note per cleared member
    expect(h.notes.map((note) => note.id)).toEqual([t1Id, idsOf(groupP)[0], idsOf(groupP)[1], idsOf(groupS)[0]]);
    expect(new Set(registry.list().map((record) => record.id)).size).toBe(4); // no double-admit, no duplicates
  });

  test("clearQueue flushes queued members through the queued-abort path — one note each, running untouched", async () => {
    const h = makeRegistry({ cap: 1, queueCap: 16 });
    await h.registry.start(startRequest({ task: "running" }));
    const group = await h.registry.enqueueGroup([startRequest({ task: "q1" }), startRequest({ task: "q2" })], "serial");
    expect(group.map((outcome) => outcome.ok && outcome.record.state)).toEqual(["queued", "queued"]);

    const result = h.registry.clearQueue();

    expect(result.cancelled).toEqual(idsOf(group)); // flat queue order
    expect(result.stillRunning).toEqual(["d-1"]); // running untouched
    expect(h.children).toHaveLength(1); // no kills, no spawns
    expect(h.children[0]!.signals).toEqual([]);
    expect(h.notes.map((note) => note.state)).toEqual(["aborted", "aborted"]); // exactly one per member
    expect(h.notes.map((note) => note.id)).toEqual(idsOf(group));
    for (const id of result.cancelled) expect(h.registry.get(id)?.state).toBe("aborted");

    h.children[0]!.exit(0); // the running member still settles and notifies normally
    expect(h.notes[2]!.state).toBe("completed");
  });
});

// ------------------------------------------------------------------ Q-A6 at registry level

describe("member abort and collapse at registry level (plan v2 R4 ★)", () => {
  test("a member aborted while queued lets its group continue: the remaining member still runs in turn", async () => {
    const h = makeRegistry();
    const group = await h.registry.enqueueGroup(
      [startRequest({ task: "s1" }), startRequest({ task: "s2" }), startRequest({ task: "s3" })],
      "serial",
    );
    const [s1, s2, s3] = idsOf(group);
    expect(h.children).toHaveLength(1); // s1 running

    h.registry.abort(s2!); // member abort while queued
    expect(h.registry.get(s2!)?.state).toBe("aborted");
    expect(h.registry.get(s3!)?.state).toBe("queued"); // the group continues

    h.children[0]!.exit(0); // s1 settles → s3 (NOT skipped) admits
    expect(h.children).toHaveLength(2);
    expect(h.registry.get(s3!)?.state).toBe("running");
  });

  test("an all-aborted group collapses and the next group dequeues at the next release", async () => {
    const h = makeRegistry({ cap: 2, queueCap: 16 });
    await h.registry.start(startRequest({ task: "r1" }));
    await h.registry.start(startRequest({ task: "r2" }));
    const groupP = await h.registry.enqueueGroup([startRequest({ task: "p1" }), startRequest({ task: "p2" })], "serial");
    const groupB = await h.registry.enqueueGroup([startRequest({ task: "b1" })], "serial");
    const [p1, p2] = idsOf(groupP);
    const b1 = idsOf(groupB)[0]!;
    expect(h.children).toHaveLength(2);

    h.registry.abort(p1!);
    h.registry.abort(p2!); // gP fully aborted → collapses
    expect(h.registry.get(p1!)?.state).toBe("aborted");
    expect(h.registry.get(p2!)?.state).toBe("aborted");
    expect(h.children).toHaveLength(2); // nothing spawned (no free slot yet)

    h.children[0]!.exit(0); // r1 settles → gB (the next group) dequeues
    expect(h.children).toHaveLength(3);
    expect(h.registry.get(b1)?.state).toBe("running");
    expect(h.notes.filter((note) => note.state === "aborted").map((note) => note.id)).toEqual([p1, p2]);
  });
});

// ------------------------------------------------------------------ Q-B5: timeout inheritance

describe("queued group member timeout (Q-B5 — T84 generalized)", () => {
  test("a queued group member inherits its timeout; the clock arms at spawn, not while queued", async () => {
    const h = makeRegistry({ cap: 1, queueCap: 16 });
    await h.registry.start(startRequest({ task: "first" }));
    const group = await h.registry.enqueueGroup([startRequest({ task: "second", timeoutMs: 5 })], "serial");
    const secondId = idsOf(group)[0]!;
    expect(group[0].ok && group[0].record.state).toBe("queued");

    await drainMacrotasks(1100); // longer than the applied timeout: a start()-armed timer would have fired
    expect(h.registry.get(secondId)?.state).toBe("queued"); // queue wait is admission's business

    h.children[0]!.exit(0); // settle the first → the member spawns and the clock arms
    expect(h.children).toHaveLength(2);
    expect(h.registry.get(secondId)?.state).toBe("running");

    await drainMacrotasks(1100); // the spawn-armed expiry
    expect(h.registry.get(secondId)?.state).toBe("aborted");
    expect(h.registry.get(secondId)?.abortReason).toBe("timeout");
    expect(h.children[0]!.signals).toEqual([]); // the first child was never signaled
    const memberNotes = h.notes.filter((note) => note.id === secondId);
    expect(memberNotes).toHaveLength(1); // exactly one note for the timed-out member
    expect(memberNotes[0]!.abortReason).toBe("timeout");
  }, 30_000);
});

// ------------------------------------------------------------------ Q-B6: shutdown

describe("shutdown with queued group members (Q-B6)", () => {
  test("shutdown aborts queued group members without spawning and delivers no notifications", async () => {
    const h = makeRegistry({ cap: 1, queueCap: 16 });
    await h.registry.start(startRequest({ task: "first" }));
    const group = await h.registry.enqueueGroup([startRequest({ task: "queued member" })], "serial");
    expect(group[0].ok && group[0].record.state).toBe("queued");

    h.registry.shutdown();

    expect(h.children).toHaveLength(1); // the queued member never spawned
    expect(h.children[0]!.signals).toEqual(["SIGTERM"]); // the running member took the kill path
    expect(h.notes).toHaveLength(0); // no notifications for anyone (row 38 semantics, groups included)
    expect(h.registry.list()).toEqual([]);
  });
});

// ------------------------------------------------------------------ fake-pi harness (P2 deliverable — plan v2 ★Harness)

describe("fake-pi routing bus (P2 harness — plan v2 ★Harness, M-4/M2)", () => {
  test("events.emit dispatches synchronously to registered events.on handlers; emissions are still recorded", () => {
    const pi = createFakePi();
    const seen: unknown[] = [];
    pi.events.on("delegation-transition", (data) => seen.push(data));
    pi.events.emit("delegation-transition", { state: "running" });

    expect(seen).toEqual([{ state: "running" }]); // synchronous dispatch, real pi bus semantics
    expect(pi.transitions).toEqual([{ channel: "delegation-transition", data: { state: "running" } }]);
  });

  test("subscriptions are recorded per channel and the unsubscribe function stops delivery", () => {
    const pi = createFakePi();
    const seen: string[] = [];
    const off = pi.events.on("channel-a", (data) => seen.push(`a:${(data as { n: number }).n}`));
    pi.events.on("channel-b", () => seen.push("b"));
    expect(pi.subscriptions.map((subscription) => subscription.channel)).toEqual(["channel-a", "channel-b"]);

    off();
    pi.events.emit("channel-a", { n: 1 });
    pi.events.emit("channel-b", {});
    expect(seen).toEqual(["b"]); // the unsubscribed handler no longer fires
  });

  test("fireTransition(channel, data) is emit: one call records the emission and dispatches to subscribers", () => {
    const pi = createFakePi();
    const seen: unknown[] = [];
    pi.events.on("delegation-transition", (data) => seen.push(data));
    pi.fireTransition("delegation-transition", { id: "d-1", state: "completed" });

    expect(seen).toEqual([{ id: "d-1", state: "completed" }]);
    expect(pi.transitions).toEqual([{ channel: "delegation-transition", data: { id: "d-1", state: "completed" } }]);
  });

  test("a throwing bus handler is contained and later handlers still run (real bus error containment)", () => {
    const pi = createFakePi();
    const seen: string[] = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      pi.events.on("channel", () => {
        throw new Error("boom");
      });
      pi.events.on("channel", () => seen.push("after"));
      expect(() => pi.events.emit("channel", {})).not.toThrow();
    } finally {
      console.error = original;
    }
    expect(seen).toEqual(["after"]);
    expect(errors.some((line) => line.includes("boom"))).toBe(true);
  });

  test("pi.on stores handler ARRAYS per event — two handlers on one event both run in registration order", () => {
    const pi = createFakePi();
    const order: string[] = [];
    pi.on("session_start", () => order.push("first"));
    pi.on("session_start", () => order.push("second"));
    expect(pi.handlers.get("session_start")).toHaveLength(2); // the documented single-slot regression
    for (const handler of pi.handlers.get("session_start") ?? []) handler({ type: "session_start" }, {});
    expect(order).toEqual(["first", "second"]);
  });

  test("the injected clock is mutable: deps reading () => pi.clock.now observe set/advance", () => {
    const pi = createFakePi({ now: 1000 });
    expect(pi.clock.now).toBe(1000);
    pi.clock.advance(500);
    expect(pi.clock.now).toBe(1500);
    pi.clock.set(9_999);
    expect(pi.clock.now).toBe(9_999);

    let observed = 0;
    const readClockDep = (): number => pi.clock.now; // the shape factories receive as `now`
    observed = readClockDep();
    expect(observed).toBe(9_999);
  });

  test("registerTool/Command/MessageRenderer, sendMessage and appendEntry are captured (T60's recording surface intact)", () => {
    const pi = createFakePi();
    pi.registerTool({ name: "delegate", execute: () => {} });
    pi.registerCommand("delegations", { handler: () => {} });
    pi.registerMessageRenderer("delegation-result", () => ({}) as unknown);
    pi.sendMessage({ customType: "delegation-result", content: "done", display: true }, { deliverAs: "followUp", triggerTurn: true });
    pi.appendEntry("delegation-reconstruction", { runs: [] });

    expect([...pi.tools.keys()]).toEqual(["delegate"]);
    expect([...pi.commands.keys()]).toEqual(["delegations"]);
    expect([...pi.renderers.keys()]).toEqual(["delegation-result"]);
    expect(pi.sent).toEqual([
      {
        message: { customType: "delegation-result", content: "done", display: true },
        options: { deliverAs: "followUp", triggerTurn: true },
      },
    ]);
    expect(pi.entries).toEqual([{ customType: "delegation-reconstruction", data: { runs: [] } }]);
  });
});
