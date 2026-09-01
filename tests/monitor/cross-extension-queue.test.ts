/**
 * P9 — cross-extension integration: the subagent queue and the monitor extension on ONE
 * fake-pi instance (plan v2 package P9). Wave suites pinned each side; these rows pin the
 * JOINS the plan named:
 *
 * - a queue-driven group settle wakes a pending `wait` through the REAL wire (queue tool →
 *   registry spawn → transition emission → monitor subscription → wait resolver), and the
 *   completion card still arrives through the real batching path — both consumers of the one
 *   transition stream coexist;
 * - the serial drain proceeds under combined load (second member spawns after the first
 *   settles while subscriptions are live);
 * - enforcement counting coexists with queue traffic (queue actions never count);
 * - shutdown with EVERYTHING live (pending wait + armed monitor + running child + queued
 *   member) resolves the wait terminally, drops the monitor cleanly, aborts the queued member
 *   without spawning it, and sends nothing post-shutdown — the handler-array regression guard
 *   at full load.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChild } from "../helpers/fake-child.ts";
import { createFakePi, type FakePi, type FakePiHandler } from "../helpers/fake-pi.ts";
import { AGENTS_DIR, RESULT_CUSTOM_TYPE, TRANSITION_CHANNEL } from "../../extensions/subagent/index.ts";
import subagent from "../../extensions/subagent/index.ts";
import monitor from "../../extensions/monitor/index.ts";

const NOW = 1_700_000_000_000;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const SCAFFOLDED = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

Body of ${name}.
`;

function manualScheduler() {
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers,
    setTimeout(handler: () => void, ms: number): unknown {
      const id = ++seq;
      timers.set(id, { fn: handler, ms });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
  };
}

interface Harness {
  pi: FakePi;
  scheduler: ReturnType<typeof manualScheduler>;
  children: FakeChild[];
  projectDir: string;
  logDir: string;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** BOTH factories on one fake-pi — the P9 join runs with every handler registered. */
function makeCombinedHarness(): Harness {
  const pi = createFakePi();
  const scheduler = manualScheduler();
  const projectDir = mkdtempSync(join(tmpdir(), "aib-p9-project-"));
  const logDir = mkdtempSync(join(tmpdir(), "aib-p9-logs-"));
  tempDirs.push(projectDir, logDir);

  const agents = join(projectDir, ...AGENTS_DIR);
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "architect.md"), SCAFFOLDED("architect", "Architecture specialist. Read-only."));

  const children: FakeChild[] = [];
  const spawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  subagent(pi as never, { spawnFn, logDir, now: () => pi.clock.now, escalateAfterMs: 0, batchWindowMs: 0 });
  monitor(pi as never, { now: () => pi.clock.now, scheduler });
  return { pi, scheduler, children, projectDir, logDir };
}

function registerMonitor(h: Harness, params: Record<string, unknown>): Promise<ToolResult> {
  return tool(h.pi, "monitor")("tc-m", { action: "register", ...params }, undefined, undefined, makeCtx(h));
}

function makeCtx(h: Harness, mode = "tui"): unknown {
  return {
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: h.projectDir,
    sessionManager: { getSessionId: () => "sess-p9" },
    model: undefined,
    signal: undefined,
  };
}

/** Fire session_start BEFORE any tool call — production always does, and the monitor arms
 * its transition subscription there, so the fleet map sees every spawn transition. */
function startSession(h: Harness): void {
  for (const handler of h.pi.handlers.get("session_start") ?? []) handler({}, makeCtx(h));
}

type Execute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: unknown,
) => Promise<ToolResult>;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

function tool(pi: FakePi, name: string): Execute {
  const tool = pi.tools.get(name);
  if (!tool) throw new Error(`expected a registered "${name}" tool — the combined load failed`);
  return tool.execute as unknown as Execute;
}

function transition(id: string, state: string): Record<string, unknown> {
  return { id, agent: "architect", task: `task ${id}`, state, at: NOW, record: { id, agent: "architect", state } };
}

function sentOf(pi: FakePi, customType: string): Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> {
  return (pi.sent as Array<{ message: { customType?: string } }> & { message?: { customType?: string } }[])
    .filter((s) => s.message.customType === customType) as never;
}

// ------------------------------------------------------------------ the join

describe("P9: a queue-driven group settle wakes a pending wait through the real wire", () => {
  test("queue add spawns the serial head; its settle resolves wait and delivers the completion card", async () => {
    const h = makeCombinedHarness();
    const { pi } = h;
    startSession(h);

    const queued = await tool(pi, "queue")(
      "tc-q",
      { action: "add", agent: "architect", tasks: ["Task one", "Task two"] },
      undefined,
      undefined,
      makeCtx(h),
    );
    expect(queued.details.tasks).toHaveLength(2);
    expect(h.children).toHaveLength(1); // serial group admits exactly its head on an idle system
    const headId = (queued.details.tasks as Array<{ id: string }>)[0]!.id;

    // the spawn transition reached the monitor's fleet map before wait starts
    const pending = tool(pi, "wait")("tc-w", {}, undefined, undefined, makeCtx(h));
    await tick();

    h.children[0]!.exit(0); // synchronous settle → transition → drain → notifications

    const result = await pending;
    expect(result.details.observed).toBe("delegation");
    const records = result.details.records as Array<{ id?: string; state?: string }>;
    expect(records.some((r) => r.id === headId && r.state === "completed")).toBe(true);

    // the drain spawned the second member; the completion card rode the real batching path
    expect(h.children).toHaveLength(2);
    const cards = sentOf(pi, RESULT_CUSTOM_TYPE);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  test("wait resolved once: the drain's own transitions do not double-wake or re-fire", async () => {
    const h = makeCombinedHarness();
    const { pi } = h;
    startSession(h);

    await tool(pi, "queue")(
      "tc-q",
      { action: "add", agent: "architect", tasks: ["Task one", "Task two"] },
      undefined,
      undefined,
      makeCtx(h),
    );
    const pending = tool(pi, "wait")("tc-w", {}, undefined, undefined, makeCtx(h));
    await tick();

    h.children[0]!.exit(0);
    const result = await pending;
    expect(result.details.observed).toBe("delegation");

    // the drain's second-member spawn + later settle produce no further wait resolutions —
    // the resolver is gone; transitions still flow (the monitor map keeps updating)
    const sentBefore = pi.sent.length;
    h.children[1]!.exit(0);
    await tick();
    expect((result.details.records as unknown[]).length).toBeGreaterThan(0);
    expect(pi.sent.length).toBeGreaterThan(sentBefore); // second card delivered to the transcript
  });
});

describe("P9: enforcement coexists with queue flow", () => {
  test("queue actions never count; delegations list counting works mid-queue", async () => {
    const h = makeCombinedHarness();
    const { pi } = h;
    startSession(h);

    await tool(pi, "queue")(
      "tc-q",
      { action: "add-parallel", agent: "architect", tasks: ["Task one", "Task two"] },
      undefined,
      undefined,
      makeCtx(h),
    );
    expect(h.children).toHaveLength(2); // parallel head admitted atomically on an idle system

    // three sanctioned queue actions never advance the poll window
    await tool(pi, "queue")("tc-l1", { action: "list" }, undefined, undefined, makeCtx(h));
    await tool(pi, "queue")("tc-l2", { action: "list" }, undefined, undefined, makeCtx(h));

    const listHandlers = (pi.handlers.get("tool_call") ?? []) as FakePiHandler[];
    expect(listHandlers.length).toBeGreaterThanOrEqual(1);
    const fire = (input: Record<string, unknown>) => {
      let verdict: { block?: boolean; reason?: string } | undefined;
      for (const handler of listHandlers) {
        const out = handler({ type: "tool_call", toolName: "delegations", input }, makeCtx(h));
        if (out && typeof out === "object" && (out as { block?: boolean }).block) verdict = out;
      }
      return verdict;
    };

    expect(fire({ action: "list" })).toBeUndefined();
    expect(fire({ action: "list" })).toBeUndefined();
    expect(fire({ action: "list" })).toBeUndefined();
    expect(fire({ action: "list" })?.block).toBe(true); // the 4th list is polling, queue traffic or not
  });
});

describe("P9: shutdown with everything live (the full-load handler-array guard)", () => {
  test("pending wait + armed monitor + running child + queued member all die cleanly", async () => {
    const h = makeCombinedHarness();
    const { pi, scheduler } = h;
    startSession(h);

    await tool(pi, "queue")(
      "tc-q",
      { action: "add", agent: "architect", tasks: ["Task one", "Task two"] },
      undefined,
      undefined,
      makeCtx(h),
    );
    await registerMonitor(h, { predicate: "false", name: "wake-1" });
    const pending = tool(pi, "wait")("tc-w", {}, undefined, undefined, makeCtx(h));
    await tick();
    expect(h.children).toHaveLength(1); // d-1 running, d-2 queued, never spawned

    const sentBefore = pi.sent.length;
    const shutdownHandlers = pi.handlers.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThanOrEqual(3); // subagent + status + monitor: arrays, not slots
    for (const handler of shutdownHandlers) handler({}, makeCtx(h));

    const result = await pending;
    // Terminal, never a hang. Which source wins depends on shutdown ordering: the subagent's
    // handler runs first and its queued-member abort emits a transition, so the delegation
    // source legitimately beats the monitor's own terminal resolution (R8 first-of).
    expect(["aborted", "delegation"]).toContain(result.details.observed as string);
    expect(pi.entries.find((e) => e.customType === "monitor-shutdown")).toBeDefined();
    expect(scheduler.timers.size).toBe(0);
    expect(h.children).toHaveLength(1); // the queued member never spawned

    // nothing wakes after shutdown: transitions and exits deliver nothing
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-9", "completed"));
    expect(pi.sent.length).toBe(sentBefore);
  }, 5_000);
});
