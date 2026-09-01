/**
 * P3 suite — the `queue` tool (plan v2 packages P3, rows Q-C1…Q-C5 of
 * docs/work/2026-09-01-monitor-queue-delegation-plan.md).
 *
 * Harness: the same shape as tests/subagent-extension.test.ts — the shared fake-pi helper
 * (handlers as arrays per event, EventEmitter routing bus, mutable injected clock) driving the
 * REAL subagent extension factory with FakeChild spawns. Queue actions run against the one
 * registry the factory constructs (registry.enqueueGroup / clearQueue are wave-1 APIs); the
 * notification wire is the factory's real batching path, so clear notifications are asserted
 * with the T92–T100 idioms (lead card immediate, held notes flush on the injected window).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChild } from "./helpers/fake-child.ts";
import { createFakePi, type FakePiHandler, type FakePiRenderer, type FakePiSentMessage } from "./helpers/fake-pi.ts";
import { AGENTS_DIR } from "../extensions/subagent/index.ts";
import subagent from "../extensions/subagent/index.ts";

const NOW = 1_700_000_000_000;

const SCAFFOLDED = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

Body of ${name}.
`;

interface Harness {
  handlers: Map<string, FakePiHandler[]>;
  tools: Map<string, any>;
  commands: Map<string, unknown>;
  renderers: Map<string, FakePiRenderer>;
  sent: FakePiSentMessage[];
  entries: Array<{ customType: string; data: any }>;
  transitions: Array<{ channel: string; data: any }>;
  children: FakeChild[];
  spawnOptions: Array<{ cwd: string }>;
  notifications: string[];
  projectDir: string;
  logDir: string;
  api: { registry: any } | undefined;
}

function makeHarness(mode = "tui", deps: Record<string, unknown> = {}): Harness {
  const pi = createFakePi();
  const h: Harness = {
    handlers: pi.handlers,
    tools: pi.tools as Map<string, any>,
    commands: pi.commands,
    renderers: pi.renderers,
    sent: pi.sent,
    entries: pi.entries as Array<{ customType: string; data: any }>,
    transitions: pi.transitions as Array<{ channel: string; data: any }>,
    children: [],
    spawnOptions: [],
    notifications: [],
    projectDir: mkdtempSync(join(tmpdir(), "aib-queue-tool-")),
    logDir: mkdtempSync(join(tmpdir(), "aib-queue-tool-logs-")),
    api: undefined,
  };
  mkdirAgents(h.projectDir);

  const spawnFn = (_command: string, _args: string[], options: { cwd: string }) => {
    h.spawnOptions.push(options);
    const child = new FakeChild();
    h.children.push(child);
    return child;
  };

  h.api = subagent(pi as never, { spawnFn, logDir: h.logDir, now: () => pi.clock.now, escalateAfterMs: 0, ...deps }) as {
    registry: any;
  };
  return h;
}

function mkdirAgents(dir: string): void {
  const agents = join(dir, ...AGENTS_DIR);
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "architect.md"), SCAFFOLDED("architect", "Architecture specialist. Read-only."));
  writeFileSync(join(agents, "tester.md"), SCAFFOLDED("tester", "Test specialist."));
}

let h: Harness;
afterEach(() => {
  if (h) {
    rmSync(h.projectDir, { recursive: true, force: true });
    rmSync(h.logDir, { recursive: true, force: true });
  }
});

function makeCtx(mode = "tui", cwd?: string): unknown {
  return {
    ui: { notify: (message: string) => h.notifications.push(message), setWidget: () => {}, setStatus: () => {} },
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: cwd ?? h.projectDir,
    sessionManager: { getSessionId: () => "sess-test" },
    model: undefined,
    signal: undefined,
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}
type OnUpdate = (partial: unknown) => void;

function queueTool(): {
  execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, ctx: unknown): Promise<ToolResult>;
} {
  return h.tools.get("queue");
}

function registryOf(h: Harness): { abort(id: string): unknown } {
  return (h.api as { registry: { abort(id: string): unknown } }).registry;
}

function delegateTool(): {
  execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, ctx: unknown): Promise<ToolResult>;
} {
  return h.tools.get("delegate");
}

function contentOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function callQueue(params: Record<string, unknown>, ctx: unknown, toolCallId = "call-q"): Promise<ToolResult> {
  return queueTool().execute(toolCallId, params, undefined, undefined, ctx);
}

function callDelegate(params: Record<string, unknown>, ctx: unknown, toolCallId = "call-d"): Promise<ToolResult> {
  return delegateTool().execute(toolCallId, params, undefined, undefined, ctx);
}

/** Let an injected batch window (and other macrotasks) flush. */
const drainBatchWindow = () => new Promise((resolve) => setTimeout(resolve, 250));

/** T92–T100 idiom: the run ids a sent message carries (single card or batched). */
function sentIds(message: Record<string, unknown>): string[] {
  const details = message.details as Record<string, unknown>;
  if (details.batched) return (details.notes as Array<{ id: string }>).map((note) => note.id);
  return [details.id as string];
}

// ------------------------------------------------------------------ registration wiring

describe("queue tool — registration wiring (plan v2 R4)", () => {
  test("the queue tool registers alongside delegate and delegations on the one registry", () => {
    h = makeHarness();

    expect([...h.tools.keys()]).toEqual(expect.arrayContaining(["delegate", "delegations", "queue"]));
  });
});

// ------------------------------------------------------------------ Q-C1: receipts

describe("Q-C1 — queue add/add-parallel return per-task receipts sharing a groupId (plan v2 R4)", () => {
  test("add on an idle system drains immediately: receipts report running vs queued (position N)", async () => {
    h = makeHarness();
    const result = await callQueue({ action: "add", agent: "architect", tasks: ["task one", "task two"] }, makeCtx());

    const details = result.details as { groupId: string; mode: string; tasks: Array<{ id: string; state: string; queuePosition?: number }> };
    expect(details.groupId).toMatch(/^g-\d+$/);
    expect(details.mode).toBe("serial");
    expect(details.tasks).toHaveLength(2);
    // distinct ids (★M3 generalized to the tool surface), shared groupId
    expect(details.tasks[0]!.id).not.toBe(details.tasks[1]!.id);
    // immediate-drain case reports running; the second member waits behind it (serial)
    expect(details.tasks[0]).toMatchObject({ state: "running" });
    expect(details.tasks[1]).toMatchObject({ state: "queued", queuePosition: 1 });
    expect(contentOf(result)).toContain(details.tasks[0]!.id);
    expect(contentOf(result)).toContain("running");
    expect(contentOf(result)).toContain("followUp");
    // only the drained member spawned
    expect(h.children).toHaveLength(1);
  });

  test("add-parallel behind a full system queues every member with flat 1-based positions", async () => {
    h = makeHarness("tui", { cap: 3 });
    for (let i = 1; i <= 3; i++) await callDelegate({ agent: "architect", task: `blocker ${i}` }, makeCtx(), `call-blocker-${i}`);
    expect(h.children).toHaveLength(3); // every slot full — a parallel group cannot fit atomically

    const result = await callQueue(
      {
        action: "add-parallel",
        tasks: [
          { agent: "architect", task: "p1" },
          { agent: "tester", task: "p2" },
          { agent: "tester", task: "p3" },
        ],
      },
      makeCtx(),
      "call-parallel",
    );

    const details = result.details as { groupId: string; mode: string; tasks: Array<{ id: string; state: string; queuePosition?: number }> };
    expect(details.mode).toBe("parallel");
    expect(details.tasks).toHaveLength(3);
    expect(details.tasks.map((t) => t.state)).toEqual(["queued", "queued", "queued"]);
    expect(details.tasks.map((t) => t.queuePosition)).toEqual([1, 2, 3]);
    expect(h.children).toHaveLength(3); // nothing spawns behind the blockers
    // the per-task {agent, task} override reached the registry records
    const agents = details.tasks.map((t) => h.api!.registry.get(t.id).agent);
    expect(agents).toEqual(["architect", "tester", "tester"]);
  });

  test("an unknown persona is answered with delegate's byte-identical string and enqueues nothing", async () => {
    h = makeHarness();
    const delegateResult = await callDelegate({ agent: "nope", task: "t" }, makeCtx());
    const queueResult = await callQueue({ action: "add", tasks: [{ agent: "nope", task: "t" }] }, makeCtx());

    expect(contentOf(queueResult)).toBe(contentOf(delegateResult));
    expect(h.children).toHaveLength(0);
    expect(h.api!.registry.list()).toHaveLength(0);
  });

  test("an unknown persona anywhere in the group aborts the whole group (all-or-nothing)", async () => {
    h = makeHarness();
    const result = await callQueue(
      { action: "add", tasks: [{ agent: "architect", task: "fine" }, { agent: "ghost", task: "not fine" }] },
      makeCtx(),
    );

    expect(contentOf(result)).toContain('no persona named "ghost"');
    expect(h.children).toHaveLength(0);
    expect(h.api!.registry.list()).toHaveLength(0); // the fine task was NOT enqueued either
  });

  test("a plain-string task without a group agent is a loud usage error", async () => {
    h = makeHarness();
    await expect(callQueue({ action: "add", tasks: ["just a task"] }, makeCtx())).rejects.toThrow(/agent/);
    expect(h.children).toHaveLength(0);
  });

  test("group-level cwd is validated like delegate's (invalid → loud error, nothing spawns)", async () => {
    h = makeHarness();
    const result = await callQueue({ action: "add", agent: "architect", tasks: ["t"], cwd: "relative/path" }, makeCtx());

    expect(contentOf(result)).toContain("invalid cwd");
    expect(contentOf(result)).toContain("relative/path");
    expect(h.children).toHaveLength(0);
    expect(h.api!.registry.list()).toHaveLength(0);
  });

  test("group-level timeoutMs is clamped like delegate's (100 → 1000 on the spawned record)", async () => {
    h = makeHarness();
    const result = await callQueue({ action: "add", agent: "architect", tasks: ["t"], timeoutMs: 100 }, makeCtx());

    const details = result.details as { tasks: Array<{ id: string }> };
    expect(h.api!.registry.get(details.tasks[0]!.id)?.timeoutMs).toBe(1000);
    h.children[0]!.exit(0); // hygiene: settle before the real timer can fire
  });
});

// ------------------------------------------------------------------ Q-C2: list

describe("Q-C2 — queue list renders live positions, mode, running/pending per group (plan v2 R2/S-10)", () => {
  test("list shows live positions recomputed after admissions and member-level clears; receipts' snapshots go stale", async () => {
    h = makeHarness("tui", { cap: 2 });
    await callDelegate({ agent: "architect", task: "blocker 1" }, makeCtx(), "call-blocker-1");
    await callDelegate({ agent: "architect", task: "blocker 2" }, makeCtx(), "call-blocker-2");
    const g1 = await callQueue({ action: "add", agent: "architect", tasks: ["a1", "a2", "a3"] }, makeCtx(), "call-g1");
    const g2 = await callQueue(
      { action: "add-parallel", tasks: [{ agent: "architect", task: "b1" }, { agent: "tester", task: "b2" }] },
      makeCtx(),
      "call-g2",
    );
    const a = ((g1.details as any).tasks as Array<{ id: string }>).map((t) => t.id);
    const b = ((g2.details as any).tasks as Array<{ id: string }>).map((t) => t.id);
    // receipts snapshot the flat index at enqueue: a1..a3 at 1..3, b1/b2 at 4/5
    expect(((g1.details as any).tasks as Array<{ queuePosition?: number }>).map((t) => t.queuePosition)).toEqual([1, 2, 3]);
    expect(((g2.details as any).tasks as Array<{ queuePosition?: number }>).map((t) => t.queuePosition)).toEqual([4, 5]);

    const first = await callQueue({ action: "list" }, makeCtx());
    const firstGroups = (first.details as { groups: Array<{ groupId: string; mode: string; running: number; pending: number; members: Array<{ id: string; state: string; queuePosition?: number }> }> }).groups;
    expect(firstGroups).toHaveLength(2);
    expect(firstGroups[0]).toMatchObject({ mode: "serial", running: 0, pending: 3 });
    expect(firstGroups[1]).toMatchObject({ mode: "parallel", running: 0, pending: 2 });
    expect(firstGroups[1]!.members.map((m) => m.queuePosition)).toEqual([4, 5]);

    // blocker 1 settles → a1 is admitted → the LIVE positions recompute (a2: 2 → 1, …)
    h.children[0]!.exit(0);
    const afterAdmission = await callQueue({ action: "list" }, makeCtx());
    const admissionGroups = (afterAdmission.details as { groups: Array<{ groupId: string; running: number; pending: number; members: Array<{ id: string; state: string; queuePosition?: number }> }> }).groups;
    expect(admissionGroups[0]).toMatchObject({ running: 1, pending: 2 });
    const positionsAfterAdmission = admissionGroups
      .flatMap((g) => g.members)
      .reduce((acc, m) => acc.set(m.id, m.queuePosition), new Map<string, number | undefined>());
    expect(positionsAfterAdmission.get(a[0])).toBeUndefined(); // a1 is running — no position
    expect(positionsAfterAdmission.get(a[1])).toBe(1); // was 2 on the receipt
    expect(positionsAfterAdmission.get(a[2])).toBe(2); // was 3
    expect(positionsAfterAdmission.get(b[0])).toBe(3); // was 4
    expect(positionsAfterAdmission.get(b[1])).toBe(4); // was 5
    expect(contentOf(afterAdmission)).toContain("live position 1");

    // member-level clears (delegations abort on queued members): survivors recompute again
    h.api!.registry.abort(a[1]);
    h.api!.registry.abort(a[2]);
    const afterClears = await callQueue({ action: "list" }, makeCtx());
    const clearGroups = (afterClears.details as { groups: Array<{ groupId: string; running: number; pending: number; members: Array<{ id: string; state: string; queuePosition?: number }> }> }).groups;
    expect(clearGroups).toHaveLength(2); // g1 keeps its RUNNING member (a1) — only a fully-settled group collapses
    expect(clearGroups[0]).toMatchObject({ running: 1, pending: 0 });
    const survivorPositions = clearGroups[1]!.members.reduce((acc, m) => acc.set(m.id, m.queuePosition), new Map<string, number | undefined>());
    expect(survivorPositions.get(b[0])).toBe(1); // was 3 — recomputed after the clears
    expect(survivorPositions.get(b[1])).toBe(2); // was 4
    expect(contentOf(afterClears)).toContain("live position 1");
  });

  test("list with nothing queued is loud, not an error", async () => {
    h = makeHarness();
    const result = await callQueue({ action: "list" }, makeCtx());

    expect(contentOf(result)).toContain("queue empty");
    expect(result.details).toMatchObject({ groups: [] });
  });
});

// ------------------------------------------------------------------ Q-C3: clear

describe("Q-C3 — queue clear cancels queued without kill and reports still-running ids (plan v2 R4)", () => {
  test("clear cancels every queued member, leaves the running child untouched, enumerates both", async () => {
    h = makeHarness("tui", { cap: 2 });
    // both slots full — no free slot the clear could promote a member into (the mid-clear
    // promotion path is registry-level pinned; here the flush must be total)
    await callDelegate({ agent: "architect", task: "blocker 1" }, makeCtx(), "call-blocker-1");
    await callDelegate({ agent: "architect", task: "blocker 2" }, makeCtx(), "call-blocker-2");
    const g = await callQueue({ action: "add", agent: "architect", tasks: ["q1", "q2", "q3"] }, makeCtx(), "call-g");
    const queuedIds = ((g.details as any).tasks as Array<{ id: string }>).map((t) => t.id);

    const result = await callQueue({ action: "clear" }, makeCtx());

    expect(contentOf(result)).toContain("cancelled 3 queued");
    expect(contentOf(result)).toContain(queuedIds.join(", "));
    expect(contentOf(result)).toContain("Still running (untouched)");
    expect(result.details).toMatchObject({ cancelled: queuedIds, stillRunning: ["d-1", "d-2"] });
    // no kill — queued members never spawned, and the running children got no signal
    expect(h.children).toHaveLength(2);
    expect(h.children[0]!.signals).toHaveLength(0);
    expect(h.children[1]!.signals).toHaveLength(0);
    // the cancelled members are terminal-aborted in the registry
    for (const id of queuedIds) expect(h.api!.registry.get(id)?.state).toBe("aborted");
  });

  test("cancelled notifications ride the batcher exactly once (T92–T100 idioms: lead + one batch)", async () => {
    h = makeHarness("tui", { cap: 2, batchWindowMs: 100 });
    await callDelegate({ agent: "architect", task: "blocker 1" }, makeCtx(), "call-blocker-1");
    await callDelegate({ agent: "architect", task: "blocker 2" }, makeCtx(), "call-blocker-2");
    const g = await callQueue({ action: "add", agent: "architect", tasks: ["q1", "q2", "q3"] }, makeCtx(), "call-g");
    const queuedIds = ((g.details as any).tasks as Array<{ id: string }>).map((t) => t.id);

    await callQueue({ action: "clear" }, makeCtx());

    // exactly one aborted note per cancelled member — the lead immediately, the rest batched
    expect(h.sent).toHaveLength(1);
    await drainBatchWindow();
    expect(h.sent).toHaveLength(2);
    const batch = h.sent[1]!.message as Record<string, unknown>;
    expect((batch.details as Record<string, unknown>).batched).toBe(true);
    expect(sentIds(batch)).toEqual(queuedIds.slice(1)); // settle order, never the lead again
    const allNotified = [...h.sent.flatMap((s) => sentIds(s.message as Record<string, unknown>))].sort();
    expect(allNotified).toEqual([...queuedIds].sort()); // every member exactly once
    for (const sent of h.sent) {
      expect(sent.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(String(sent.message.content)).toContain("aborted");
    }
  });

  test("an empty-queue clear is loud, not an error", async () => {
    h = makeHarness();
    const result = await callQueue({ action: "clear" }, makeCtx());

    expect(contentOf(result)).toContain("already empty");
    expect(result.details).toMatchObject({ cancelled: [], stillRunning: [] });
  });
});

// ------------------------------------------------------------------ Q-C4: tui-only

describe("Q-C4 — the whole queue tool rejects in non-tui modes with guidance (plan v2 ★R4/S5)", () => {
  for (const mode of ["print", "rpc", "json"]) {
    for (const action of ["add", "add-parallel", "clear", "list"]) {
      test(`${action} rejects in ${mode} mode, naming blocking delegate — nothing enqueued`, async () => {
        h = makeHarness(mode);
        const params =
          action === "add" || action === "add-parallel"
            ? { action, agent: "architect", tasks: ["t"] }
            : { action };
        const result = await callQueue(params, makeCtx(mode));

        expect(contentOf(result)).toContain("TUI");
        expect(contentOf(result)).toContain("delegate"); // guidance points at the blocking tool
        expect(result.details).toMatchObject({ reason: "tui-only", action });
        expect(h.children).toHaveLength(0);
        expect(h.api!.registry.list()).toHaveLength(0); // the queue is permanently empty headless
      });
    }
  }
});

// ------------------------------------------------------------------ S-1 (implementation review)

describe("S-1: live positions agree with the core's definition across mutations", () => {
  test("positions renumber densely 1..n after a member abort (agreement with liveQueuePosition)", async () => {
    h = makeHarness("tui", { cap: 2 });
    await callDelegate({ agent: "architect", task: "blocker 1" }, makeCtx(), "call-blocker-1");
    await callDelegate({ agent: "architect", task: "blocker 2" }, makeCtx(), "call-blocker-2");
    const g1 = await callQueue({ action: "add", agent: "architect", tasks: ["a1", "a2"] }, makeCtx(), "call-g1");
    const g2 = await callQueue({ action: "add", agent: "tester", tasks: ["b1"] }, makeCtx(), "call-g2");
    const ids = (r: typeof g1) => ((r.details as { tasks: Array<{ id: string }> }).tasks.map((x) => x.id));
    expect(ids(g1)).toEqual(["d-3", "d-4"]);
    expect(ids(g2)).toEqual(["d-5"]);

    // abort the first queued member: the survivors must renumber densely 1..n — the
    // liveQueuePosition contract the tool's rendering re-derives (S-1 cross-reference)
    await registryOf(h).abort("d-3");
    const after = await callQueue({ action: "list" }, makeCtx(), "call-list");
    const positions = (after.details as { groups: Array<{ members: Array<{ id: string; queuePosition?: number }> }> })
      .groups.flatMap((g) => g.members)
      .reduce((acc, m) => acc.set(m.id, m.queuePosition), new Map<string, number | undefined>());
    expect(positions.get("d-4")).toBe(1);
    expect(positions.get("d-5")).toBe(2);
  });
});
