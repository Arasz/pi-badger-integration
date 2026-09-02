/**
 * Wiring tests for the monitor extension's factory (plan v2 rows M-B1–M-B5, rulings R6/R7/R10).
 *
 * The harness is the shared fake-pi (tests/helpers/fake-pi.ts): EventEmitter-backed routing bus,
 * handlers stored as ARRAYS per event (the shutdown-cleanup regression), captured sendMessage /
 * appendEntry / renderers, and a mutable injected clock. Time never passes on its own: the
 * expiry timers run through a manual scheduler the tests fire by handle, and the clock moves
 * only when a test calls pi.clock.advance. The M-B4/M-B5 rows load BOTH factories (subagent +
 * monitor) on one fake-pi instance — that combined load is the handler-array storage regression
 * pin (E-A1's drift guard lives in poll-guard.test.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import monitor from "../../extensions/monitor/index.ts";
import { TRANSITION_CHANNEL } from "../../extensions/subagent/index.ts";
import subagent from "../../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

const tempDirs: string[] = [];

/** Captured ui.notify calls — makeCtx's notify stub pushes here (M8: the harness captures
 * notifications instead of dropping them, mirroring tests/subagent-extension.test.ts's
 * h.notifications, plus the tone so command rows can assert info/warning/error). */
const notifications: Array<{ message: string; type?: string }> = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  notifications.length = 0;
});

// ------------------------------------------------------------------ harness

/** Manual scheduler: expiry timers are recorded, never run on their own; tests fire by handle. */
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

/** One DelegationTransition-shaped payload, exactly what the subagent's registry emits. */
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

/** BOTH factories on one fake-pi — the combined load E-A1/M-B4/W-A5 rows pin against. */
function makeCombinedHarness(): Harness {
  const pi = createFakePi();
  const scheduler = manualScheduler();
  const logDir = mkdtempSync(join(tmpdir(), "aib-monitor-combined-")); // never the real ~/.pi/agent/subagent-logs
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

function monitorTool(pi: FakePi): Execute {
  const tool = pi.tools.get("monitor");
  if (!tool) throw new Error("the monitor extension did not register a `monitor` tool");
  return tool.execute as unknown as Execute;
}

function makeCtx(mode = "tui"): unknown {
  return {
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }), setWidget: () => {}, setStatus: () => {} },
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/p",
  };
}

async function register(
  pi: FakePi,
  params: { predicate: string; name?: string; interrupt?: boolean; timeoutMs?: number },
  mode = "tui",
): Promise<ToolResult> {
  return monitorTool(pi)(
    "tc-register",
    { action: "register", ...params },
    undefined,
    undefined,
    makeCtx(mode),
  );
}

function sentMonitorEvents(pi: FakePi): Array<{ message: Record<string, unknown>; options: unknown }> {
  return pi.sent
    .filter((s) => s.message.customType === "monitor-event")
    .map((s) => ({ message: s.message as Record<string, unknown>, options: s.options }));
}

// ------------------------------------------------------------------ M-B1

describe("M-B1: arming and the fire wire", () => {
  test("the factory arms nothing — no bus subscription, no timers, no input handler, no sends", () => {
    const { pi, scheduler } = makeHarness();
    expect(pi.subscriptions).toHaveLength(0);
    expect(scheduler.timers.size).toBe(0);
    expect(pi.handlers.get("input")).toBeUndefined();
    expect(pi.sent).toHaveLength(0);
  });

  test("register arms the transition subscription and nothing else fires before a transition", () => {
    const { pi } = makeHarness();
    register(pi, { predicate: `delegations.some((d) => d.id === "d-1" && d.state === "completed")` });
    const busSubscriptions = pi.subscriptions.filter((s) => s.channel === TRANSITION_CHANNEL);
    expect(busSubscriptions).toHaveLength(1);
    expect(pi.sent).toHaveLength(0);
  });

  test("a matching transition delivers exactly one unbatched followUp card and removes the monitor", async () => {
    const { pi } = makeHarness();
    await register(pi, { predicate: `delegations.some((d) => d.id === "d-1" && d.state === "completed")`, name: "wake-me" });
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    expect(sentMonitorEvents(pi)).toHaveLength(0); // predicate still false while running

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    const cards = sentMonitorEvents(pi);
    expect(cards).toHaveLength(1);
    const { message, options } = cards[0]!;
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true }); // unbatched, exact wire
    expect(message.display).toBe(true);
    expect(message.details).toMatchObject({
      kind: "fired",
      monitorId: "m-1",
      name: "wake-me",
      predicate: `delegations.some((d) => d.id === "d-1" && d.state === "completed")`,
    });
    expect((message.details as Record<string, unknown>).firedAt).toBeNumber();
    const snapshot = (message.details as Record<string, unknown>).snapshot as { delegations: Array<{ id: string }> };
    expect(snapshot.delegations).toHaveLength(1);
    expect(snapshot.delegations[0]!.id).toBe("d-1");
    expect(message.details).not.toHaveProperty("batched");
    expect(typeof message.content).toBe("string");
    expect((message.content as string).length).toBeGreaterThan(0);

    // one-shot: the monitor is removed — later transitions evaluate nothing
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "completed"));
    expect(sentMonitorEvents(pi)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ M-B2

describe("M-B2: expiry", () => {
  test("expiry via the injected scheduler delivers kind:expired and removes the monitor without any transition", async () => {
    const { pi, scheduler } = makeHarness();
    await register(pi, { predicate: "false", timeoutMs: 5000 });
    expect(scheduler.timers.size).toBe(1);
    const [, timer] = [...scheduler.timers.entries()][0]!;
    expect(timer.ms).toBe(5000);

    const transitionsBefore = pi.transitions.length;
    scheduler.fire([...scheduler.timers.keys()][0]!);
    expect(pi.transitions.length).toBe(transitionsBefore); // no transition involved

    const cards = sentMonitorEvents(pi);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.message.details).toMatchObject({ kind: "expired", monitorId: "m-1" });
    expect(cards[0]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });

    // removed: later transitions bring nothing back
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    expect(sentMonitorEvents(pi)).toHaveLength(1);
  });

  test("an absent timeoutMs arms the 10-minute default; fire and cancel clear the timer", async () => {
    const { pi, scheduler } = makeHarness();
    await register(pi, { predicate: `delegations.some((d) => d.id === "d-1" && d.state === "completed")` });
    expect(scheduler.timers.size).toBe(1);
    expect([...scheduler.timers.values()][0]!.ms).toBe(600_000);

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    expect(sentMonitorEvents(pi)).toHaveLength(1);
    expect(scheduler.timers.size).toBe(0); // fire cleared the expiry timer
  });
});

// ------------------------------------------------------------------ M-B3

describe("M-B3: throwing predicates", () => {
  test("a throwing predicate delivers one error card and disarms; later transitions evaluate nothing", async () => {
    const { pi } = makeHarness();
    // compiles, is false while the fleet is empty, throws once delegations exist
    const predicate = "delegations.length > 0 && delegations[0].missing.field";
    await register(pi, { predicate });
    expect(sentMonitorEvents(pi)).toHaveLength(0); // idle at registration: short-circuited false

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    const cards = sentMonitorEvents(pi);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.message.details).toMatchObject({ kind: "error", monitorId: "m-1", predicate });
    expect(String((cards[0]!.message.details as Record<string, unknown>).reason).length).toBeGreaterThan(0);

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "running"));
    expect(sentMonitorEvents(pi)).toHaveLength(1); // never retried
  });
});

// ------------------------------------------------------------------ QA F2

describe("QA F2: a predicate that is true at registration fires immediately (wiring layer)", () => {
  test("registering an already-true predicate delivers the fired card and leaves nothing armed", async () => {
    const { pi } = makeCombinedHarness();
    // arm the subscription with a silent monitor, then put a live delegation in the map —
    // so the NEXT registration's own evaluation sees a non-empty fleet
    await register(pi, { predicate: "false", name: "silent" });
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    expect(sentMonitorEvents(pi)).toHaveLength(0);

    const receipt = await register(pi, { predicate: "delegations.length > 0", name: "already-true" });
    expect(receipt.details.state).toBe("fired"); // the receipt names the immediate fire, not a phantom arm

    const cards = sentMonitorEvents(pi);
    expect(cards).toHaveLength(1); // fired at registration, not on some later transition
    expect(cards[0]!.message.details).toMatchObject({ kind: "fired", monitorId: "m-2" });
    const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(listed.content[0]!.text).toMatch(/silent/); // one-shot: only the fired monitor is gone
    expect(listed.content[0]!.text).not.toMatch(/already-true/);
  });
});

// ------------------------------------------------------------------ leading-return recovery (agent-facing predicate)

describe("register normalizes a leading-return predicate (the old schema phrasing)", () => {
  test("the receipt, the armed list and the fire card echo the bare expression, not `return …`", async () => {
    const { pi } = makeHarness();
    const receipt = await register(pi, {
      predicate: 'return delegations.some((d) => d.state === "completed")',
      name: "recovered",
    });
    expect(receipt.details.state).toBe("armed");
    expect(receipt.details.predicate).toBe('delegations.some((d) => d.state === "completed")');
    const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(listed.content[0]!.text).toContain('delegations.some((d) => d.state === "completed")');
    expect(listed.content[0]!.text).not.toMatch(/return/);

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    const cards = sentMonitorEvents(pi);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.message.details).toMatchObject({ kind: "fired", predicate: 'delegations.some((d) => d.state === "completed")' });
  });

  test("a leading-return predicate whose remainder still fails rejects with guidance", async () => {
    const { pi } = makeHarness();
    await expect(register(pi, { predicate: "return const x" })).rejects.toThrow(/do not write `return`/);
  });
});

// ------------------------------------------------------------------ M-B4

describe("M-B4: cap, cancel and shutdown (combined subagent + monitor load)", () => {
  test("the 9th monitor is rejected naming the active 8", async () => {
    const { pi } = makeCombinedHarness();
    for (let i = 1; i <= 8; i++) {
      const receipt = await register(pi, { predicate: "false", name: `wake-${i}` });
      expect(receipt.details.state).toBe("armed");
    }
    await expect(register(pi, { predicate: "false", name: "one-too-many" })).rejects.toThrow(
      /8 active monitors[\s\S]*m-1[\s\S]*m-8/,
    );
    expect(sentMonitorEvents(pi)).toHaveLength(0);
  });

  test("cancel disarms the monitor and frees a cap slot", async () => {
    const { pi } = makeCombinedHarness();
    // all monitors stay silent ("false") except m-3, whose predicate is true exactly at fleet size 3
    for (let i = 1; i <= 8; i++) await register(pi, { predicate: i === 3 ? "delegations.length === 3" : "false" });
    const cancelled = await monitorTool(pi)(
      "tc-cancel",
      { action: "cancel", id: "m-3" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(cancelled.details).toMatchObject({ id: "m-3" });

    // disarmed: three running transitions would have fired m-3's predicate
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-2", "running"));
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-3", "running"));
    expect(sentMonitorEvents(pi)).toHaveLength(0);

    // the cap slot is freed: an otherwise-9th register succeeds
    const ninth = await register(pi, { predicate: "false" });
    expect(ninth.details.state).toBe("armed");
  });

  test("cancel of an unknown id is loud", async () => {
    const { pi } = makeCombinedHarness();
    await expect(
      monitorTool(pi)("tc-cancel", { action: "cancel", id: "m-99" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/m-99/);
  });

  test("shutdown delivers the monitor-shutdown entry, clears timers, unsubscribes and stops everything", async () => {
    const { pi, scheduler } = makeCombinedHarness();
    await register(pi, { predicate: "false", name: "wake-1" });
    await register(pi, { predicate: "false" });
    pi.clock.advance(30_000); // both monitors are 30 s old at shutdown

    const shutdownHandlers = pi.handlers.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThanOrEqual(3); // subagent + status + monitor: arrays, not single slot
    for (const handler of shutdownHandlers) handler({}, makeCtx());

    const entry = pi.entries.find((e) => e.customType === "monitor-shutdown");
    expect(entry).toBeDefined();
    expect(entry!.data).toEqual({
      monitors: [
        { id: "m-1", name: "wake-1", ageMs: 30_000 },
        { id: "m-2", ageMs: 30_000 },
      ],
    });
    expect(scheduler.timers.size).toBe(0);

    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    expect(sentMonitorEvents(pi)).toHaveLength(0); // everything stopped
  });

  test("the list action renders the armed monitors with predicates and remaining time", async () => {
    const { pi } = makeCombinedHarness();
    const empty = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(empty.content[0]!.text).toMatch(/no active monitors/i);

    await register(pi, { predicate: "delegations.length > 0", name: "wake-1" });
    pi.clock.advance(45_000);
    const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(listed.content[0]!.text).toContain("m-1");
    expect(listed.content[0]!.text).toContain("wake-1");
    expect(listed.content[0]!.text).toContain("delegations.length > 0");
  });
});

// ------------------------------------------------------------------ M-B5

describe("M-B5: the whole monitor tool is tui-only", () => {
  test.each(["print", "rpc"])("every action rejects in %s with guidance", async (mode) => {
    const { pi } = makeHarness();
    await expect(register(pi, { predicate: "false" }, mode)).rejects.toThrow(/tui-only/);
    await expect(
      monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx(mode)),
    ).rejects.toThrow(/tui-only/);
    await expect(
      monitorTool(pi)("tc-cancel", { action: "cancel", id: "m-1" }, undefined, undefined, makeCtx(mode)),
    ).rejects.toThrow(/tui-only/);
  });

  test("register rejects an invalid predicate without consuming the cap", async () => {
    const { pi } = makeHarness();
    for (let i = 1; i <= 8; i++) await register(pi, { predicate: "false" });
    await expect(register(pi, { predicate: "const x = 1" })).rejects.toThrow(/predicate/i); // statement, not expression
    // the cap was not consumed by the rejected register: a 9th VALID monitor still hits the cap
    await expect(register(pi, { predicate: "false" })).rejects.toThrow(/8 active monitors/);
  });
});

// ------------------------------------------------------------------ B-T: the tui-only rejection guidance

describe("B-T: the tui-only rejection points at headless blocking, not the removed delegations wait", () => {
  test("B-T1: the non-tui rejection never advertises delegations wait and names the delegate blocking semantics", async () => {
    const { pi } = makeHarness();
    const error: Error = await register(pi, { predicate: "false" }, "print").then(
      () => {
        throw new Error("expected the register to reject in print mode");
      },
      (reason) => reason as Error,
    );
    // lane A removed `delegations wait` — the guidance must not advertise a verb that no longer exists
    expect(error.message).not.toMatch(/delegations wait/);
    // and must point at what actually blocks headless: a delegate call blocks until settle
    expect(error.message).toMatch(/blocks this turn until the delegation settles/);
  });
});

// ------------------------------------------------------------------ renderer pin (P6 scope)

describe("monitor-event renderer", () => {
  test("a renderer is registered and tones the card head by kind", async () => {
    const { pi } = makeHarness();
    await register(pi, { predicate: "false" });
    const renderer = pi.renderers.get("monitor-event");
    expect(renderer).toBeTypeOf("function");

    const tones: string[] = [];
    const theme = {
      bg: (_key: string, line: string) => line,
      fg: (tone: string, text: string) => {
        tones.push(tone);
        return text;
      },
    };
    for (const kind of ["fired", "expired", "error"]) {
      tones.length = 0;
      const rendered = renderer!(
        { content: `Monitor m-1 ${kind} — body line`, display: true, details: { kind } },
        { outputPad: 0 },
        theme,
      );
      // Box identity differs between the test's and the extension's module copies — assert the
      // shape (a Box-like container came back) and the TONE, which is the contract here.
      expect(rendered).not.toBeUndefined();
      expect(typeof (rendered as { addChild?: unknown }).addChild).toBe("function");
      expect(tones).toEqual([kind === "fired" ? "success" : kind === "expired" ? "warning" : "error"]);
    }
  });

  test("a message without content renders nothing (unknown senders degrade safely)", () => {
    const { pi } = makeHarness(); // the renderer registers at factory time — passive, arms nothing
    const renderer = pi.renderers.get("monitor-event");
    expect(renderer).toBeTypeOf("function");
    const rendered = renderer!({ content: "", display: true, details: undefined }, { outputPad: 0 }, {
      bg: (_key: string, line: string) => line,
      fg: (tone: string, text: string) => text,
    });
    expect(rendered).toBeUndefined();
  });
});

// ------------------------------------------------------------------ B-C: the /monitors command

interface MonitorCommand {
  description?: string;
  getArgumentCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> | null;
  handler(args: string, ctx: unknown): Promise<void>;
}

function monitorsCommand(pi: FakePi): MonitorCommand {
  const command = pi.commands.get("monitors");
  if (!command) throw new Error("the monitor extension did not register a /monitors command");
  return command as unknown as MonitorCommand;
}

describe("B-C: the /monitors command (mirrors /delegations)", () => {
  test("B-C1: the command registers passively at factory load — present with a description, arming nothing", () => {
    const { pi, scheduler } = makeHarness();
    const command = monitorsCommand(pi); // throws (RED) while the command is unregistered
    expect(command.description).toBeTypeOf("string");
    expect(command.description!.length).toBeGreaterThan(0);
    // a command is a passive surface: no transition subscription, no expiry timers, no sends
    expect(pi.subscriptions).toHaveLength(0);
    expect(scheduler.timers.size).toBe(0);
    expect(pi.sent).toHaveLength(0);
  });

  test("B-C2: no arguments notifies the armed monitors — id, name, predicate excerpt, age, time left — as an info", async () => {
    const { pi } = makeHarness();
    const longPredicate = `delegations.some((d) => d.state === "running" && d.agent === "architect" && d.exitCode === null && d.id.length > 0)`;
    expect(longPredicate.length).toBeGreaterThan(100);
    await register(pi, { predicate: longPredicate, name: "wake-1" });
    pi.clock.advance(45_000);

    await monitorsCommand(pi).handler("", makeCtx());

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("info");
    const message = notifications[0]!.message;
    expect(message).toContain("m-1");
    expect(message).toContain("(wake-1)");
    expect(message).toContain("armed 45s ago");
    expect(message).toContain("time left 9m 15s");
    // the predicate is excerpted, not verbatim: head-capped with an ellipsis
    expect(message).toContain(longPredicate.slice(0, 100));
    expect(message).toContain("…");
    expect(message).not.toContain(longPredicate);
  });

  test("B-C3: with nothing armed the panel says so", async () => {
    const { pi } = makeHarness();
    await monitorsCommand(pi).handler("", makeCtx());
    expect(notifications).toEqual([{ message: expect.stringMatching(/no active monitors/i), type: "info" }]);
  });

  test("B-C4: cancel <id> disarms — the monitor list afterwards no longer shows it and its expiry timer is gone", async () => {
    const { pi, scheduler } = makeHarness();
    await register(pi, { predicate: "false", name: "doomed" });
    await register(pi, { predicate: "false", name: "survivor" });
    expect(scheduler.timers.size).toBe(2);

    await monitorsCommand(pi).handler("cancel m-1", makeCtx());

    expect(notifications).toEqual([{ message: expect.stringContaining("m-1"), type: "info" }]);
    // asserted via the monitor list afterwards (the command and the tool must agree):
    const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(listed.content[0]!.text).not.toContain("doomed");
    expect(listed.content[0]!.text).toContain("survivor");
    expect(scheduler.timers.size).toBe(1); // the cancelled monitor's expiry timer is cleared
  });

  test("B-C5: cancel of an unknown id notifies a loud error naming the id", async () => {
    const { pi } = makeHarness();
    await monitorsCommand(pi).handler("cancel m-99", makeCtx());
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("error");
    expect(notifications[0]!.message).toContain("m-99");
  });

  test("B-C6: malformed arguments notify the usage line as info, not an error", async () => {
    const { pi } = makeHarness();
    await monitorsCommand(pi).handler("cancel", makeCtx()); // cancel without an id
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("info");
    expect(notifications[0]!.message).toMatch(/\/monitors/);
  });

  test("B-C7: headless the command notifies nothing — the panel is a silent no-op and cancel still disarms", async () => {
    const { pi } = makeHarness();
    await register(pi, { predicate: "false", name: "headless-doomed" });
    const headless = makeCtx("print");

    await monitorsCommand(pi).handler("", headless);
    expect(notifications).toHaveLength(0); // no invented headless notify

    await monitorsCommand(pi).handler("cancel m-1", headless);
    expect(notifications).toHaveLength(0); // still silent
    const listed = await monitorTool(pi)("tc-list", { action: "list" }, undefined, undefined, makeCtx());
    expect(listed.content[0]!.text).toContain("no active monitors"); // the disarm itself still happened
  });

  test("B-C8: completions offer cancel and the armed monitor ids (mirroring /delegations)", async () => {
    const { pi } = makeHarness();
    const command = monitorsCommand(pi);
    // first position: the cancel verb only
    expect(command.getArgumentCompletions("")).toEqual([{ value: "cancel", label: "cancel", description: expect.anything() }]);
    expect(command.getArgumentCompletions("c")).toEqual([{ value: "cancel", label: "cancel", description: expect.anything() }]);
    expect(command.getArgumentCompletions("x")).toBeNull();

    // no armed monitors → no id completions
    expect(command.getArgumentCompletions("cancel ")).toBeNull();

    await register(pi, { predicate: "false", name: "wake-1" });
    await register(pi, { predicate: "false" });
    expect(command.getArgumentCompletions("cancel ")).toEqual([
      { value: "m-1", label: "m-1 (wake-1)" },
      { value: "m-2", label: "m-2" },
    ]);
    expect(command.getArgumentCompletions("cancel m")).toHaveLength(2);
    expect(command.getArgumentCompletions("cancel z")).toBeNull();
    // only the id position completes ids: the bare prefix never leaks them
    const barePrefix = command.getArgumentCompletions("");
    expect(barePrefix!.every((item) => item.value !== "m-1")).toBe(true);
  });
});

// ------------------------------------------------------------------ review folds (S1/S2)

describe("review folds — snapshot isolation (S1)", () => {
  test("a mutating predicate cannot falsify the fleet map for later monitors", async () => {
    const { pi } = makeCombinedHarness();
    // the mutator arms while the fleet is empty (mutates nothing, evaluates false, stays armed)
    await register(pi, { predicate: `((delegations[0] || {}).state = "wedge", false)`, name: "mutator" });
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "running"));
    expect(sentMonitorEvents(pi)).toHaveLength(0); // mutator evaluated against the live d-1 and stayed false

    // an honest monitor must see the TRUE state: with live objects the mutator's write would
    // have falsified d-1's view for every later evaluation (review S1)
    await register(pi, { predicate: `delegations.some((d) => d.id === "d-1" && d.state === "completed")`, name: "honest" });
    pi.fireTransition(TRANSITION_CHANNEL, transition("d-1", "completed"));
    const cards = sentMonitorEvents(pi);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.message.details).toMatchObject({ kind: "fired", monitorId: "m-2" });
  });
});
