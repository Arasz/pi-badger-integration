/**
 * P2 suite — streaming runner + registry (rows 23–42, T58–T65 of
 * docs/plans/2026-interactive-subagent-delegation.tests.md).
 *
 * Flake conventions (tests doc header): FakeChild emits `close` synchronously from drive calls
 * and its kill() records the signal without exiting (tests decide death — the pi-example
 * mutation trap needs a child that ignores kills); `escalateAfterMs: 0` in every fixture;
 * time is injected (`now: () => NOW`), no fake-timer library — the only real-time waits are
 * macrotask drains for 0 ms escalation timers.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { FakeChild } from "./helpers/fake-child.ts";
import {
  DelegationRegistry,
  type DelegationDeps,
  type DelegationReceipt,
  type DelegationTransition,
  type StartOutcome,
  type StartRequest,
} from "../extensions/subagent/delegation-registry.ts";
import {
  DelegationRunner,
  type DelegationNote,
  type DelegationProgress,
  type LogSinkFactory,
  type RunRequest,
  type RunnerDeps,
  type SpawnFn,
} from "../extensions/subagent/delegation-runner.ts";

const NOW = 1_700_000_000_000;
const MAX_NOTE_CHARS = 64 * 1024;

// ------------------------------------------------------------------ fixtures

function assistantEnd(text: string, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...(usage ? { usage } : {}) },
  };
}

const sessionHeader = { type: "session", version: 3, id: "child-session", cwd: "/p" };

/** Per-run line buffers keyed by run id, plus the deps-shaped factory. */
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

interface RunnerHarness {
  runner: DelegationRunner;
  children: FakeChild[];
  notes: DelegationNote[];
  updates: DelegationProgress[];
}

function makeRunner(overrides: RunnerDeps = {}): RunnerHarness {
  const children: FakeChild[] = [];
  const notes: DelegationNote[] = [];
  const updates: DelegationProgress[] = [];
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const runner = new DelegationRunner({
    escalateAfterMs: 0,
    now: () => NOW,
    spawnFn,
    notifyComplete: (note) => notes.push(note),
    onUpdate: (progress) => updates.push(progress),
    ...overrides,
  });
  return { runner, children, notes, updates };
}

function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    id: "d-1",
    agent: "architect",
    task: "do the thing",
    args: ["--", "do the thing"],
    cwd: "/p",
    startedAt: NOW,
    ...overrides,
  };
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

/** Assert a start was admitted and narrow the outcome for the assertions that follow. */
function expectStarted(outcome: StartOutcome): DelegationReceipt {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`expected an admitted start, got: ${outcome.reason}`);
  return outcome;
}

// ------------------------------------------------------------------ rows 23–25: receipt before exit

describe("background start: receipt resolves before the child exits (rows 23–25)", () => {
  test("row 23: execute returns before child exits", async () => {
    const h = makeRegistry();
    const receipt = expectStarted(await h.registry.start(startRequest()));

    expect(h.children).toHaveLength(1);
    const child = h.children[0]!;
    expect(child.exited).toBe(false);
    expect(receipt.record.state).toBe("running");
    expect(receipt.record.exitCode ?? null).toBeNull();
  });

  test("row 24: order log — returned precedes completed", async () => {
    const order: string[] = [];
    const h = makeRegistry({ notifyComplete: () => order.push("completed") });
    const receipt = await h.registry.start(startRequest());

    order.push("execute-returned");
    expect(receipt.ok).toBe(true);
    h.children[0]!.exit(0);

    expect(order).toEqual(["execute-returned", "completed"]);
  });

  test("row 25: three parallel starts resolve, no child closed", async () => {
    const h = makeRegistry();
    const receipts = [];
    for (let i = 0; i < 3; i++) {
      receipts.push(await h.registry.start(startRequest({ task: `task ${i}` })));
    }

    expect(h.children).toHaveLength(3);
    for (const receipt of receipts) {
      expect(receipt.ok).toBe(true);
      expect(receipt.ok && receipt.record.state).toBe("running");
    }
    for (const child of h.children) expect(child.exited).toBe(false);
  });
});

// ------------------------------------------------------------------ rows 39, T58, T59, T61: admission

describe("admission: cap, FIFO queue, loud rejection, queued abort (rows 39, T58–T61)", () => {
  test("row 39: cap and FIFO dispatch — third spawns synchronously when the first exits", async () => {
    const h = makeRegistry({ cap: 2, queueCap: 16 });
    await h.registry.start(startRequest({ task: "one" }));
    await h.registry.start(startRequest({ task: "two" }));
    const queued = await h.registry.start(startRequest({ task: "three" }));

    expect(h.children).toHaveLength(2);
    expect(queued.ok).toBe(true);
    expect(queued.ok && queued.record.state).toBe("queued");
    expect(queued.ok && queued.record.queuePosition).toBe(1);

    h.children[0]!.exit(0); // first slot frees → the queued run spawns in the same synchronous flow

    expect(h.children).toHaveLength(3);
    expect(h.registry.get("d-3")?.state).toBe("running");
  });

  test("T58: queue-cap-16 loud rejection, both call types", async () => {
    const h = makeRegistry(); // defaults: cap 4, queueCap 16 — the R7 contract itself
    for (let i = 0; i < 4; i++) await h.registry.start(startRequest({ task: `running ${i}` }));
    for (let i = 0; i < 16; i++) {
      const receipt = await h.registry.start(startRequest({ task: `queued ${i}` }));
      expect(receipt.ok && receipt.record.queuePosition).toBe(i + 1);
    }

    // 17th request — the "background" and "blocking" distinction lives in the tool layer (P3);
    // the admission policy rejects every request identically (review CR3: one policy).
    const first = await h.registry.start(startRequest({ task: "over" }));
    const second = await h.registry.start(startRequest({ task: "over again" }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(!first.ok && first.reason).toContain("full");
    expect(!first.ok && first.reason).toContain("retry"); // guidance, surfaced verbatim to callers
    expect(!second.ok && second.reason).toContain("full");
    expect(h.children).toHaveLength(4); // nothing extra spawned
  });

  test("T59: admission pin — blocking call enqueues when slots full and awaits its done promise", async () => {
    const h = makeRegistry({ cap: 2, queueCap: 16 });
    await h.registry.start(startRequest({ task: "one" }));
    await h.registry.start(startRequest({ task: "two" }));
    const blocking = await h.registry.start(startRequest({ task: "three" }));

    expect(blocking.ok).toBe(true);
    expect(blocking.ok && blocking.record.state).toBe("queued");

    h.children[0]!.exit(0); // slot frees → d-3 spawns
    expect(h.registry.get("d-3")?.state).toBe("running");

    h.children[2]!.exit(0); // d-3's child completes
    const final = await (blocking.ok ? blocking.done : Promise.reject(new Error("unreachable")));
    expect(final.state).toBe("completed");
    expect(final.exitCode).toBe(0);
  });

  test("T61: queued-abort removes without kill; dequeue re-checks and never spawns the aborted run", async () => {
    const h = makeRegistry({ cap: 1, queueCap: 16 });
    await h.registry.start(startRequest({ task: "one" }));
    const queued = await h.registry.start(startRequest({ task: "two" }));
    expect(queued.ok).toBe(true);
    const queuedId = queued.ok ? queued.id : "";
    expect(h.children).toHaveLength(1);

    h.registry.abort(queuedId);

    expect(h.registry.get(queuedId)?.state).toBe("aborted");
    expect(h.children).toHaveLength(1); // no kill, no spawn — there was never a child
    expect(h.notes).toHaveLength(1); // R5: aborted-before-start still notifies
    expect(h.notes[0]!.state).toBe("aborted");
    expect(h.notes[0]!.exitCode).toBeUndefined();
    expect(h.notes[0]!.id).toBe(queuedId);

    h.children[0]!.exit(0); // release → dequeue head is the aborted run → skipped, not spawned

    expect(h.children).toHaveLength(1); // admission never spawned it
    expect(h.registry.list().map((r) => r.state).sort()).toEqual(["aborted", "completed"]);
  });
});

// ------------------------------------------------------------------ rows 26–30: live parse + progress

describe("live parse and progress (rows 26–30)", () => {
  test("row 26: message_update delta reaches onUpdate before close", () => {
    const h = makeRunner();
    const handle = h.runner.run(runRequest());

    h.children[0]!.emitEvent({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial answer so far" },
    });

    expect(h.updates.length).toBeGreaterThanOrEqual(1);
    expect(h.children[0]!.exited).toBe(false);
    const latest = h.updates[h.updates.length - 1]!;
    expect(latest.id).toBe("d-1");
    expect(latest.state).toBe("running");
    expect(latest.activity).toContain("partial answer so far");
    handle.killImmediate(); // hygiene: no live child outlives the test
  });

  test("row 27: usage accumulates across turns into the note", async () => {
    const h = makeRunner();
    h.runner.run(runRequest());
    const child = h.children[0]!;

    child.emitEvent(sessionHeader);
    child.emitEvent(assistantEnd("turn one", { input: 10, output: 2, totalTokens: 100 }));
    child.emitEvent(assistantEnd("turn two — final", { input: 5, output: 3, totalTokens: 42 }));
    child.exit(0);

    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.usage).toEqual({
      input: 15,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 42,
      turns: 2,
    });
    expect(h.notes[0]!.exitCode).toBe(0);
  });

  test("row 28: JSON split across chunks parses once", async () => {
    const h = makeRunner();
    h.runner.run(runRequest());
    const child = h.children[0]!;

    child.emitEvent(sessionHeader);
    child.emitSplit(assistantEnd("split answer", { input: 7 }));
    child.exit(0);

    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.usage?.turns).toBe(1); // exactly one parsed message_end, not two
    expect(h.notes[0]!.usage?.input).toBe(7);
    expect(h.notes[0]!.answer).toBe("split answer");
  });

  test("row 29: trailing line without newline is flushed on close", async () => {
    const h = makeRunner();
    h.runner.run(runRequest());
    const child = h.children[0]!;

    child.write(JSON.stringify(assistantEnd("tail answer"))); // no trailing newline
    child.exit(0);

    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.answer).toBe("tail answer");
  });

  test("row 30: garbage is skipped from parsing but preserved in the log", async () => {
    const { logs, logSink } = makeLogSink();
    const h = makeRunner({ logSink });
    h.runner.run(runRequest());
    const child = h.children[0]!;

    child.write("Segmentation fault (core dumped)\n");
    child.emitEvent(assistantEnd("still alive"));
    child.exit(0);

    expect(h.notes).toHaveLength(1); // the run continued
    expect(h.notes[0]!.answer).toBe("still alive");
    const logged = (logs.get("d-1") ?? []).join("\n");
    expect(logged).toContain("Segmentation fault (core dumped)"); // raw bytes survived in the tee
  });
});

// ------------------------------------------------------------------ rows 31–34, 40, 42: completion notes

describe("completion notes (rows 27, 31–34, 40, 42)", () => {
  test("row 31: success note carries output, exit 0 and the run identity", async () => {
    const h = makeRunner();
    h.runner.run(runRequest({ id: "d-1", agent: "architect" }));
    const child = h.children[0]!;

    child.emitEvent(sessionHeader);
    child.emitEvent(assistantEnd("final answer", { input: 1, output: 1 }));
    child.exit(0);

    expect(h.notes).toHaveLength(1);
    const note = h.notes[0]!;
    expect(note.id).toBe("d-1");
    expect(note.agent).toBe("architect");
    expect(note.state).toBe("completed");
    expect(note.exitCode).toBe(0);
    expect(note.answer).toBe("final answer");
  });

  test("row 32: non-zero exit → failure verdict with capped stderr tail", async () => {
    const h = makeRunner();
    h.runner.run(runRequest());
    const child = h.children[0]!;
    const bigStderr = "e".repeat(90 * 1024);

    child.stderrWrite(bigStderr);
    child.emitEvent(assistantEnd("partial before crash"));
    child.exit(2);

    expect(h.notes).toHaveLength(1);
    const note = h.notes[0]!;
    expect(note.exitCode).toBe(2);
    expect(note.stderrTail).toBeDefined();
    expect(note.stderrTail).toContain("earlier characters dropped");
    expect(note.stderrTail!.length).toBeLessThan(90 * 1024);
    expect(note.stderrTail!.endsWith(bigStderr.slice(-100))).toBe(true); // tail, not head
    expect(note.answer).toBe("partial before crash"); // partial answer tail rides along (R3)
  });

  test("row 33: spawn error is delivered loudly", async () => {
    const children: FakeChild[] = [];
    const notes: DelegationNote[] = [];
    const spawnFn: SpawnFn = () => {
      throw new Error("spawn ENOENT");
    };
    const runner = new DelegationRunner({
      escalateAfterMs: 0,
      now: () => NOW,
      spawnFn,
      notifyComplete: (note) => notes.push(note),
    });

    const handle = runner.run(runRequest());

    expect(children).toHaveLength(0);
    expect(handle.record.state).toBe("failed");
    expect(handle.record.spawnError).toContain("ENOENT");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.state).toBe("failed");
    expect(notes[0]!.spawnError).toContain("ENOENT");
  });

  test("row 34: note text is capped with a dropped marker", async () => {
    const h = makeRunner();
    h.runner.run(runRequest());
    const child = h.children[0]!;

    child.emitEvent(assistantEnd("x".repeat(70 * 1024)));
    child.exit(0);

    const answer = h.notes[0]!.answer;
    expect(answer).toContain("earlier characters dropped");
    expect(answer.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 100); // cap + one marker line
    expect(answer.endsWith("x".repeat(50))).toBe(true); // the tail (the answer) survived
  });

  test("row 40: out-of-order completion — notes never cross wires", async () => {
    const h = makeRegistry();
    await h.registry.start(startRequest({ task: "task one" }));
    await h.registry.start(startRequest({ task: "task two" }));
    await h.registry.start(startRequest({ task: "task three" }));
    const [c1, c2, c3] = h.children;

    c1!.emitEvent(assistantEnd("answer one"));
    c2!.emitEvent(assistantEnd("answer two"));
    c3!.emitEvent(assistantEnd("answer three"));
    c2!.exit(0);
    c3!.exit(0);
    c1!.exit(0);

    expect(h.notes.map((n) => n.id)).toEqual(["d-2", "d-3", "d-1"]);
    expect(h.notes.map((n) => n.answer)).toEqual(["answer two", "answer three", "answer one"]);
  });

  test("row 42: hermetic real process — spawn, one event, note delivered (ungated)", async () => {
    const { logs, logSink } = makeLogSink();
    const notes: DelegationNote[] = [];
    const registry = new DelegationRegistry({
      escalateAfterMs: 0,
      now: () => NOW,
      logSink,
      notifyComplete: (note) => notes.push(note),
      // no spawnFn → the real node:child_process spawn
    });

    const receipt = await registry.start(
      startRequest({
        command: process.execPath,
        args: [
          "-e",
          [
            `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"ok from real child"}]}}));`,
            `console.error("boom stderr");`,
          ].join(""),
        ],
        cwd: tmpdir(),
      }),
    );

    expect(receipt.ok).toBe(true);
    await (receipt.ok ? receipt.done : Promise.reject(new Error("unreachable")));
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.state).toBe("completed");
    expect(note.exitCode).toBe(0);
    expect(note.answer).toBe("ok from real child");
    // exactly one parsed child event: the tee holds exactly one message_end line
    const logged = (logs.get(note.id) ?? []).join("\n");
    expect(logged.match(/"type":"message_end"/g) ?? []).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ rows 35–38, T63, T64: kill paths

describe("abort, escalation and kill paths (rows 35–38, T63, T64)", () => {
  test("row 35: SIGTERM then SIGKILL when the child ignores kill (mutation trap)", async () => {
    const h = makeRunner(); // escalateAfterMs 0
    const controller = new AbortController();
    h.runner.run(runRequest({ signal: controller.signal }));
    const child = h.children[0]!;

    controller.abort();

    expect(child.signals).toEqual(["SIGTERM"]);
    await new Promise<void>((resolve) => child.once("kill", (signal) => resolve()));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); // the example's `proc.killed` gate would never get here
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.state).toBe("aborted");
  });

  test("row 36: early close cancels escalation", async () => {
    const h = makeRunner(); // escalateAfterMs 0 — the grace timer fires on the next macrotask
    const controller = new AbortController();
    h.runner.run(runRequest({ signal: controller.signal }));
    const child = h.children[0]!;

    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.exit(0); // closes before the grace timer gets a macrotask

    await drainMacrotasks();
    expect(child.signals).toEqual(["SIGTERM"]); // SIGKILL cancelled by the runner's own saw-close flag
    expect(h.notes).toHaveLength(1); // exactly one note (the abort), no late second one
    expect(h.notes[0]!.state).toBe("aborted");
  });

  test("row 37: already-aborted signal never spawns", async () => {
    const h = makeRegistry();
    const controller = new AbortController();
    controller.abort();

    const receipt = await h.registry.start(startRequest({ signal: controller.signal }));

    expect(h.children).toHaveLength(0); // spawnFn not called
    expect(receipt.ok).toBe(true);
    expect(receipt.ok && receipt.record.state).toBe("aborted");
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.state).toBe("aborted");
    expect(h.notes[0]!.exitCode).toBeUndefined();

    await h.registry.start(startRequest({ task: "next one" })); // the slot was released synchronously
    expect(h.children).toHaveLength(1);
  });

  test("row 38: no completion notification after shutdown", async () => {
    const h = makeRegistry({ cap: 1, queueCap: 16 });
    await h.registry.start(startRequest());
    await h.registry.start(startRequest({ task: "queued one" })); // queued — the other abort path

    h.registry.shutdown();
    expect(h.children[0]!.signals[0]).toBe("SIGTERM");
    h.children[0]!.exit(0); // late close after shutdown

    expect(h.notes).toHaveLength(0); // neither the shutdown-aborts (running AND queued) nor the late exit notifies
    expect(h.registry.list()).toEqual([]); // registry empty (row 48 pins this for P3)
  });

  test("T63: ESRCH / double-kill tolerated", async () => {
    const h = makeRegistry();
    await h.registry.start(startRequest());
    const child = h.children[0]!;

    h.registry.abort("d-1");
    expect(() => h.registry.abort("d-1")).not.toThrow(); // second abort on a terminal run: no-op
    await new Promise<void>((resolve) => child.once("kill", (signal) => resolve()));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); // exactly one escalation, no storm

    child.exit(0);
    expect(() => h.registry.abort("d-1")).not.toThrow(); // kill after natural death
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    // a kill() that throws ESRCH must not escape the runner
    const h2 = makeRunner();
    const controller = new AbortController();
    h2.runner.run(runRequest({ signal: controller.signal }));
    h2.children[0]!.kill = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(() => controller.abort()).not.toThrow();
    expect(h2.notes[0]!.state).toBe("aborted");
  });

  test("T64: exit-path kill is a synchronous SIGKILL, no timers", async () => {
    const h = makeRegistry();
    await h.registry.start(startRequest());
    const child = h.children[0]!;

    h.registry.killAllImmediate(); // what P3's process.on("exit") hook will call

    expect(child.signals).toEqual(["SIGKILL"]); // recorded with no macrotask flush (no await above)
    expect(h.registry.get("d-1")?.state).toBe("running"); // killImmediate settles nothing

    child.exit(null, "SIGKILL");
    expect(h.registry.get("d-1")?.state).toBe("aborted");
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.state).toBe("aborted");
  });
});

// ------------------------------------------------------------------ rows 41, T62: log tee

describe("log tee (rows 41, T62)", () => {
  test("row 41: per-run log ordering under interleaving", async () => {
    const h = makeRegistry();
    await h.registry.start(startRequest({ task: "one" }));
    await h.registry.start(startRequest({ task: "two" }));
    const [c1, c2] = h.children;

    c1!.write("a1\n");
    c2!.write("b1\n");
    c1!.write("a2\n");
    c2!.emitEvent(assistantEnd("answer two"));
    c2!.exit(0);
    c1!.emitEvent(assistantEnd("answer one"));
    c1!.exit(0);

    const log1 = (h.logs.get("d-1") ?? []).join("\n");
    const log2 = (h.logs.get("d-2") ?? []).join("\n");

    // each run's own lines, in order, with no cross-contamination
    expect(log1.indexOf('"type":"run"')).toBeGreaterThanOrEqual(0);
    expect(log1.indexOf("a1")).toBeGreaterThan(-1);
    expect(log1.indexOf("a1")).toBeLessThan(log1.indexOf("a2"));
    expect(log1.indexOf("a2")).toBeLessThan(log1.indexOf("answer one"));
    expect(log1.indexOf("answer one")).toBeLessThan(log1.indexOf('"type":"exit"'));
    expect(log1).not.toContain("b1");
    expect(log1).not.toContain("answer two");

    expect(log2.indexOf("b1")).toBeGreaterThan(-1);
    expect(log2.indexOf("b1")).toBeLessThan(log2.indexOf("answer two"));
    expect(log2.indexOf("answer two")).toBeLessThan(log2.indexOf('"type":"exit"'));
    expect(log2).not.toContain("a1");
    expect(log2).not.toContain("answer one");
  });

  test("T62: log-sink failure is isolated — one warning, run completes, logFile unavailable", async () => {
    const warns: string[] = [];
    let calls = 0;
    const logSink: LogSinkFactory = ({ id }) => ({
      logFile: `/tmp/delegation-logs/${id}.jsonl`,
      appendLine: () => {
        calls += 1;
        if (calls >= 2) throw new Error("disk full"); // header succeeds, mid-run tee fails
      },
    });
    const h = makeRunner({ logSink, warn: (message) => warns.push(message) });
    h.runner.run(runRequest());
    const child = h.children[0]!;

    child.emitEvent(assistantEnd("answer despite sink failure"));
    expect(() => child.exit(0)).not.toThrow(); // sink failure never escapes the runner

    expect(warns).toHaveLength(1); // exactly one warning, via the injectable hook
    expect(warns[0]).toContain("log");
    expect(h.notes).toHaveLength(1); // the run still completes
    expect(h.notes[0]!.answer).toBe("answer despite sink failure");
    expect(h.notes[0]!.logFile).toBeUndefined(); // logFile reported unavailable
    expect(h.notes[0]!.state).toBe("completed");
  });
});

// ------------------------------------------------------------------ T60, T65: events + wait

describe("registry transition events and wait (T60, T65)", () => {
  test("T60: pi.events transition snapshots per phase, serializable", async () => {
    const events: DelegationTransition[] = [];
    const h = makeRegistry({ cap: 1, queueCap: 16, emit: (transition) => events.push(transition) });

    await h.registry.start(startRequest({ task: "one" }));
    expect(events.map((e) => e.state)).toEqual(["running"]);

    const queued = await h.registry.start(startRequest({ task: "two" }));
    expect(events.map((e) => e.state)).toEqual(["running", "queued"]);

    h.children[0]!.exit(0); // d-1 completes (emitted first), then d-2 spawns — chronological order
    h.children[1]!.exit(0); // d-2 completes

    expect(events.map((e) => e.state)).toEqual(["running", "queued", "completed", "running", "completed"]);
    expect(events.map((e) => e.previousState)).toEqual([undefined, undefined, "running", "queued", "running"]);
    expect(queued.ok).toBe(true);
    expect(events.every((e) => e.id === "d-1" || e.id === "d-2")).toBe(true);
    expect(queued.ok && events[2]!.id).toBe("d-1");
    expect(events[3]!.id).toBe("d-2");

    // serializable: plain JSON round-trips losslessly (freeze point 2)
    for (const transition of events) {
      expect(JSON.parse(JSON.stringify(transition))).toEqual(transition);
    }
    // record snapshots ride along and match the registry's own view
    expect(events[4]!.record.state).toBe("completed");
    expect(events[4]!.record.exitCode).toBe(0);
  });

  test("T65: wait() resolves with snapshots (never a timeout error); shutdown resolves pending waits", async () => {
    const h = makeRegistry();
    await h.registry.start(startRequest({ task: "one" }));
    await h.registry.start(startRequest({ task: "two" }));

    // timeout on running ids → per-id snapshots, not an error
    const snapshots = await h.registry.wait(["d-1", "d-2"], 30);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.id).toBe("d-1");
    expect(snapshots[0]!.state).toBe("running");
    expect(snapshots[1]!.state).toBe("running");

    h.children[0]!.exit(0);
    h.children[1]!.exit(1);
    const terminal = await h.registry.wait(["d-1", "d-2"], 5_000);
    expect(terminal[0]!.state).toBe("completed");
    expect(terminal[1]!.state).toBe("completed");
    expect(terminal[1]!.exitCode).toBe(1);

    // shutdown mid-wait → pending waits resolve with terminal states
    const h2 = makeRegistry();
    await h2.registry.start(startRequest({ task: "three" }));
    const pending = h2.registry.wait(["d-1"], 5_000);
    h2.registry.shutdown();
    const resolved = await pending;
    expect(resolved[0]!.state).toBe("aborted");
  });
});
