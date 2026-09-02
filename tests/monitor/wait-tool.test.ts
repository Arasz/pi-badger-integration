/**
 * Wiring tests for the monitor extension's wait tool (plan v2 rows W-A1–W-A6, ruling R8).
 *
 * The wait is a pending tool: its execute returns a promise that resolves on the FIRST of —
 * a watched delegation settling (ids filter; default any), an armed monitor firing, the user
 * sending a message, or the timeout. Tie-break is listener registration order (delegation →
 * monitor → input → timeout) with resolve-once. W-A5's rows load BOTH factories on one
 * fake-pi (the handler-array storage regression); the input wake row is wiring-only, and the
 * Tier-1 real-runner probe pins the pi-build behavior the input source ships behind (S-1).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import monitor from "../../extensions/monitor/index.ts";
import { TRANSITION_CHANNEL } from "../../extensions/subagent/index.ts";
import subagent from "../../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

// ------------------------------------------------------------------ harness

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

function transition(id: string, state: string, at = 1_700_000_000_000) {
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

interface Harness {
  pi: FakePi;
  scheduler: Scheduler;
}

function makeHarness(deps: Record<string, unknown> = {}): Harness {
  const pi = createFakePi();
  const scheduler = manualScheduler();
  monitor(pi as never, { now: () => pi.clock.now, scheduler, ...deps });
  return { pi, scheduler };
}

/** BOTH factories on one fake-pi — W-A5's shutdown rows run with every handler registered.
 * The temp logDir keeps the subagent's session_start reconstruction off the real home dir. */
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeCombinedHarness(): Harness {
  const pi = createFakePi();
  const scheduler = manualScheduler();
  const logDir = mkdtempSync(join(tmpdir(), "aib-monitor-wait-"));
  tempDirs.push(logDir);
  subagent(pi as never, { now: () => pi.clock.now, escalateAfterMs: 0, logDir });
  monitor(pi as never, { now: () => pi.clock.now, scheduler });
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

function monitorTool(pi: FakePi): Execute {
  const tool = pi.tools.get("monitor");
  if (!tool) throw new Error("the monitor extension did not register a `monitor` tool");
  return tool.execute as unknown as Execute;
}

function makeCtx(mode = "tui"): unknown {
  return {
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/p",
  };
}

/** A short real sleep so pending-state assertions cannot race the microtask queue. */
const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fire the session_start handlers: in production pi starts the session before any tool runs,
 * which arms the transition subscription so the fleet view accumulates from the first
 * transition. Tests that prime transitions BEFORE a monitor/wait exists must call this. */
function startSession(pi: FakePi): void {
  for (const handler of pi.handlers.get("session_start") ?? []) handler({}, makeCtx());
}

function sentMonitorEvents(pi: FakePi): Array<Record<string, unknown>> {
  return pi.sent.filter((s) => s.message.customType === "monitor-event").map((s) => s.message as Record<string, unknown>);
}

// ------------------------------------------------------------------ W-A1

describe("W-A1: delegation settles resolve the wait", () => {
  test("wait resolves with snapshots when the watched delegation settles, and only once on multiple settles", async () => {
    const { pi, scheduler } = makeHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running")); // something live
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();
    expect(scheduler.timers.size).toBe(1); // the wait's own timeout is armed

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    const result = await pending;
    expect(result.details).toMatchObject({ observed: "delegation", waitedMs: 0 });
    const records = result.details.records as Array<{ id: string; state: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "d-1", state: "completed", agent: "architect" });
    expect(scheduler.timers.size).toBe(0); // cleaned up

    // resolve-once: later settles cannot re-resolve or rewrite the result
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "completed"));
    const recordsAfter = (result.details.records as unknown[]).length;
    expect(recordsAfter).toBe(1);
    expect(result.details.observed).toBe("delegation");
  });

  test("with ids the watch is scoped: an unwatched settle does not resolve, a watched one does", async () => {
    const { pi } = makeHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "running"));

    let settled = false;
    const pending = waitTool(pi)("tc-wait", { ids: ["d-2"] }, undefined, undefined, makeCtx()).then((r) => {
      settled = true;
      return r;
    });
    await tick();
    expect(settled).toBe(false);

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    await tick();
    expect(settled).toBe(false); // unwatched

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "completed"));
    const result = await pending;
    const records = result.details.records as Array<{ id: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("d-2");
  }, 5_000);
});

// ------------------------------------------------------------------ W-A2

describe("W-A2: timeout and the empty fleet", () => {
  test("wait resolves at its clamped timeout with a fleet snapshot, never an error", async () => {
    const { pi, scheduler } = makeHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();
    expect(scheduler.timers.size).toBe(1); // something live: the wait's own timeout only, no timer monitor
    expect([...scheduler.timers.values()][0]!.ms).toBe(300_000); // the 5 min default (W-A7)
    scheduler.fire([...scheduler.timers.keys()][0]!);

    const result = await pending;
    expect(result.details.observed).toBe("timeout");
    const records = result.details.records as Array<{ id: string; state: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "d-1", state: "running" });
    expect(scheduler.timers.size).toBe(0);
  });

  test("the timeout clamps to the 600 s max", async () => {
    const { pi, scheduler } = makeHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const pending = waitTool(pi)("tc-wait", { timeoutMs: 999_999 }, undefined, undefined, makeCtx());
    await tick();
    expect([...scheduler.timers.values()][0]!.ms).toBe(600_000);
    scheduler.fire([...scheduler.timers.keys()][0]!);
    await pending;
  });

  test("W-A7: nothing live and nothing armed arms a wait-timer monitor and keeps blocking (tui)", async () => {
    const { pi, scheduler } = makeHarness();
    let settled = false;
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()).then((r) => {
      settled = true;
      return r;
    });
    await tick();
    expect(settled).toBe(false); // no immediate empty — the wait sleeps
    expect(scheduler.timers.size).toBe(2); // the wait's own timeout AND the timer monitor's expiry
    const list = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(list.content[0]!.text).toMatch(/wait-timer/); // visible: name + never-firing predicate
    expect(list.content[0]!.text).toMatch(/\bfalse\b/);

    scheduler.fire([...scheduler.timers.keys()][0]!); // the wait's own timeout (armed first)
    const result = await pending;
    expect(result.details.observed).toBe("timeout");
    expect(scheduler.timers.size).toBe(0); // the timer monitor disarmed with the wait
    expect(sentMonitorEvents(pi)).toHaveLength(0); // silently: no expired card after the result
  });

  test("W-A7: if the timer monitor's expiry wins the race, the wait resolves monitor and the expired card arrives", async () => {
    const { pi, scheduler } = makeHarness();
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();
    const handles = [...scheduler.timers.keys()];
    scheduler.fire(handles[1]!); // the timer monitor's expiry (inserted second)

    const result = await pending;
    expect(result.details.observed).toBe("monitor");
    expect(result.details.records).toBeUndefined(); // the payload rides the card, never the result
    const events = sentMonitorEvents(pi);
    expect(events).toHaveLength(1);
    expect((events[0]!.details as { kind?: string }).kind).toBe("expired");
    expect(scheduler.timers.size).toBe(0); // the wait's own timeout cleaned up by the wake
  });

  test("W-A7: cancelling the wait-timer monitor does not strand the wait — its own timeout still resolves", async () => {
    const { pi, scheduler } = makeHarness();
    const pending = waitTool(pi)("tc-wait", { timeoutMs: 5_000 }, undefined, undefined, makeCtx());
    await tick();
    await monitorTool(pi)("tc-cancel", { action: "cancel", id: "m-1" }, undefined, undefined, makeCtx());
    expect(scheduler.timers.size).toBe(1); // only the wait's own timeout remains

    scheduler.fire([...scheduler.timers.keys()][0]!);
    const result = await pending;
    expect(result.details.observed).toBe("timeout");
    expect(scheduler.timers.size).toBe(0);
    expect(sentMonitorEvents(pi)).toHaveLength(0);
  });

  test("W-A7: a monitor expiring mid-wait wakes the wait with the expired card", async () => {
    const { pi, scheduler } = makeHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running")); // something live: no auto-arm
    await monitorTool(pi)(
      "tc-register",
      { action: "register", predicate: "false", timeoutMs: 10_000 },
      undefined,
      undefined,
      makeCtx(),
    );
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();
    const expiry = [...scheduler.timers.entries()].find(([, timer]) => timer.ms === 10_000);
    expect(expiry).toBeDefined(); // the user monitor's expiry, distinct from the wait's 300 s timeout

    scheduler.fire(expiry![0]!);
    const result = await pending;
    expect(result.details.observed).toBe("monitor"); // expiry is a monitor wake too (W-A7)
    expect(sentMonitorEvents(pi)).toHaveLength(1);
  });

  test("wait is allowed in every mode (self-degrading): print mode waits, never rejects", async () => {
    const { pi } = makeHarness();
    const result = await waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx("print"));
    expect(result.details.observed).toBe("empty"); // no tui-only gate fired
  });
});

// ------------------------------------------------------------------ W-A3

describe("W-A3: tie-break and resolve-once in one drain", () => {
  test("a delegation settle and a monitor fire in the same drain resolve once, delegation first, card still arrives", async () => {
    const { pi } = makeHarness();
    await monitorTool(pi)(
      "tc-register",
      { action: "register", predicate: `delegations.some((d) => d.id === "d-1" && d.state === "completed")` },
      undefined,
      undefined,
      makeCtx(),
    );
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed")); // settles AND fires, one drain
    const result = await pending;
    expect(result.details.observed).toBe("delegation"); // first resolver by listener order
    const records = result.details.records as Array<{ id: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("d-1");
    expect(sentMonitorEvents(pi)).toHaveLength(1); // the monitor card still arrives
  });

  test("a monitor firing alone wakes the wait with a terse pointer — the payload rides the card, not the result", async () => {
    const { pi } = makeHarness();
    await monitorTool(pi)(
      "tc-register",
      { action: "register", predicate: `delegations.some((d) => d.id === "d-1")` },
      undefined,
      undefined,
      makeCtx(),
    );
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx()); // armed monitor = something to wait for
    await tick();

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const result = await pending;
    expect(result.details.observed).toBe("monitor");
    expect(result.details.records).toBeUndefined(); // never duplicated
    expect(sentMonitorEvents(pi)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ W-A4

describe("W-A4: settle-vs-liveness race", () => {
  test("a transition landing between the subscription and the liveness re-check still resolves (never a false empty)", async () => {
    const { pi } = makeHarness();
    // Nothing is live when execute() is called — an implementation that reads liveness BEFORE
    // subscribing would resolve "empty" here. The wait subscribes first and re-checks after.
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed")); // lands in the race window

    const result = await pending;
    expect(result.details.observed).toBe("delegation");
    const records = result.details.records as Array<{ id: string }>;
    expect(records[0]!.id).toBe("d-1");
  });
});

// ------------------------------------------------------------------ W-A5

describe("W-A5: abort and shutdown (combined subagent + monitor load)", () => {
  test("a ctx.signal abort resolves observed:aborted and cleans up", async () => {
    const { pi, scheduler } = makeCombinedHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const controller = new AbortController();
    const pending = waitTool(pi)("tc-wait", {}, controller.signal, undefined, makeCtx());
    await tick();
    expect(scheduler.timers.size).toBe(1);

    controller.abort();
    const result = await pending;
    expect(result.details.observed).toBe("aborted");
    expect(scheduler.timers.size).toBe(0); // timers/subscriptions cleaned up
    expect(sentMonitorEvents(pi)).toHaveLength(0);
  });

  test("an already-aborted signal resolves aborted immediately", async () => {
    const { pi } = makeCombinedHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await waitTool(pi)("tc-wait", {}, controller.signal, undefined, makeCtx());
    expect(result.details.observed).toBe("aborted");
  });

  test("shutdown with a pending wait resolves terminally and sends nothing post-shutdown", async () => {
    const { pi } = makeCombinedHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();

    const sentBefore = pi.sent.length;
    const shutdownHandlers = pi.handlers.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThanOrEqual(3); // handler arrays, not single slots
    for (const handler of shutdownHandlers) handler({}, makeCtx());

    const result = await pending;
    expect(result.details.observed).toBe("aborted"); // terminal, never a hang
    expect(pi.sent.length).toBe(sentBefore); // no post-shutdown sendMessage

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    expect(pi.sent.length).toBe(sentBefore); // and nothing wakes after shutdown
  }, 5_000);
});

// ------------------------------------------------------------------ W-A6

describe("W-A6: the user-input source", () => {
  test("input wake resolves the wait (wiring-only)", async () => {
    const { pi } = makeHarness();
    startSession(pi);
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const pending = waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx());
    await tick();

    const inputHandlers = pi.handlers.get("input") ?? [];
    expect(inputHandlers).toHaveLength(1);
    inputHandlers[0]!({ type: "input", text: "hello", source: "interactive" }, makeCtx());
    const result = await pending;
    expect(result.details.observed).toBe("input");
  });

  test("an input handler is armed once and does not consume or transform the input", async () => {
    const { pi } = makeHarness();
    // print mode keeps these rows on the immediate-empty path — in tui an idle wait arms the
    // W-A7 timer monitor and blocks; the input source arms at execute start in EVERY mode.
    const first = await waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx("print")); // arms the input source
    expect(first.details.observed).toBe("empty");
    const second = await waitTool(pi)("tc-wait", {}, undefined, undefined, makeCtx("print"));
    expect(second.details.observed).toBe("empty");
    expect(pi.handlers.get("input")).toHaveLength(1); // armed once, persistent, no-op when idle
  });

  test("Tier-1: the real ExtensionRunner delivers input to a registered extension handler (S-1 probe)", async () => {
    // The user-input source ships only if THIS holds on the installed pi build: a handlers-map
    // extension registered on the real runner receives emitInput passthrough.
    const { ExtensionRunner } = await import("@earendil-works/pi-coding-agent");
    const seen: Array<{ text: string; source: string }> = [];
    const extension = {
      path: "/probe/extension/index.ts",
      resolvedPath: "/probe/extension/index.ts",
      sourceInfo: { type: "user" },
      handlers: new Map([
        [
          "input",
          [
            (event: { type: string; text: string; source: string }) => {
              seen.push({ text: event.text, source: event.source });
              return undefined; // pure observation: never handled, never transformed
            },
          ],
        ],
      ]),
      tools: new Map(),
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    };
    const runner = new ExtensionRunner([extension as never], {} as never, "/probe-cwd", undefined as never, undefined as never);
    const result = await runner.emitInput("wake up", undefined, "interactive");
    expect(seen).toEqual([{ text: "wake up", source: "interactive" }]);
    expect(result).toEqual({ action: "continue" }); // passthrough: the input is not swallowed
  });
});
