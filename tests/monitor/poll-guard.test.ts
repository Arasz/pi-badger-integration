/**
 * Wiring tests for the monitor extension's manual-polling enforcement (plan v2 rows E-A1/E-A2,
 * ruling R9). The decision itself is the pure core's `pollingDecision` (M-A4, wave 1); these
 * rows pin the WIRING: the handler counts only the delegations tool's list/log/results actions, the
 * env kill switch is read per call, state resets on session_shutdown, and — the drift guard —
 * the guard is exercised with the tool name AS the subagent factory registered it, read from
 * the harness's pi.tools (never a hardcoded string). Both factories load on one fake-pi.
 */

import { afterEach, describe, expect, test } from "bun:test";
import monitor from "../../extensions/monitor/index.ts";
import subagent from "../../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

// ------------------------------------------------------------------ harness

interface Harness {
  pi: FakePi;
}

function makeCombinedHarness(): Harness {
  const pi = createFakePi();
  subagent(pi as never, { now: () => pi.clock.now, escalateAfterMs: 0 });
  monitor(pi as never, { now: () => pi.clock.now });
  return { pi };
}

const POLL_ENV = "PI_BADGER_MONITOR_POLL_MAX";
afterEach(() => {
  delete process.env[POLL_ENV];
});

interface BlockResult {
  block?: boolean;
  reason?: string;
}

let toolCallSeq = 0;

/** The tool/shutdown context both factories' handlers receive (delegation-status's shutdown
 * clears its widget when hasUI, so the stub carries a ui surface). */
function makeCtx(): unknown {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/p",
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
  };
}

/** Dispatch one tool_call through every registered handler (handler arrays); return the first block. */
function fireToolCall(pi: FakePi, toolName: string, input: Record<string, unknown>): BlockResult | undefined {
  let blocked: BlockResult | undefined;
  for (const handler of pi.handlers.get("tool_call") ?? []) {
    const result = handler({ type: "tool_call", toolCallId: `tc-${++toolCallSeq}`, toolName, input }, makeCtx()) as BlockResult | undefined;
    if (result?.block) blocked = result;
  }
  return blocked;
}

/**
 * E-A1 drift guard: the delegations tool name AS REGISTERED by the subagent factory — read
 * from pi.tools by identifying the status tool's action union (the only registered tool whose
 * action literals contain both "list" and "log"). A rename anywhere in the subagent's
 * registration makes this throw, failing the rows loudly instead of testing a dead name.
 */
function registeredDelegationsName(pi: FakePi): string {
  for (const [name, tool] of pi.tools) {
    const params = tool.parameters as
      | { properties?: { action?: { anyOf?: Array<{ const?: unknown }> } } }
      | undefined;
    const literals = (params?.properties?.action?.anyOf ?? [])
      .map((variant) => variant?.const)
      .filter((value): value is string => typeof value === "string");
    if (literals.includes("list") && literals.includes("log")) return name;
  }
  throw new Error("drift: no registered tool exposes list+log actions — the subagent's delegations registration moved");
}

function shutdownSession(pi: FakePi): void {
  for (const handler of pi.handlers.get("session_shutdown") ?? []) handler({}, makeCtx());
}

// ------------------------------------------------------------------ E-A1

describe("E-A1: the poll guard blocks the 4th counted call in the window", () => {
  test("3 delegations list calls are allowed, the 4th is blocked with the wait/monitor guidance — fired with the registered name", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi); // drift guard: never a hardcoded string
    expect(delegations.length).toBeGreaterThan(0);

    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();

    const blocked = fireToolCall(pi, delegations, { action: "list" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/manual polling blocked/i);
    expect(blocked?.reason).toMatch(/wait/); // the alternatives are named
    expect(blocked?.reason).toMatch(/monitor/);
  });

  test("blocked attempts count: the 5th call's reason names #5 (QA F1 — the caller must append blocked timestamps)", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    for (let i = 0; i < 3; i++) expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })?.reason).toMatch(/#4/);
    // the blocked 4th itself counts (R9): the 5th's reason must advance to #5 — red under a
    // wiring that only pushes timestamps on the allow branch
    expect(fireToolCall(pi, delegations, { action: "list" })?.reason).toMatch(/#5/);
  });

  test("list and log count toward the same window", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "log", id: "d-1" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "log", id: "d-1" })?.block).toBe(true);
  });

  test("B-G1: the delegations results action counts in the same window — the 4th results call in 120 s is blocked", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi); // drift guard: never a hardcoded string
    // lane A's results action (one no-id call returns everything) is a polling surface like
    // list/log: three are allowed, the fourth inside the window is blocked with the guidance.
    expect(fireToolCall(pi, delegations, { action: "results" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "results" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    const blocked = fireToolCall(pi, delegations, { action: "results" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/manual polling blocked/i);
  });

  test("the window slides: past 120 s the same calls are allowed again", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    for (let i = 0; i < 3; i++) expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true);

    pi.clock.advance(121_000); // every timestamp has slid out of the window
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true);
  });
});

// ------------------------------------------------------------------ E-A2

describe("E-A2: what never counts, the env switch, and the reset", () => {
  test("wait/abort/queue/monitor-cancel are allowed and never counted", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);

    // two counted calls, then every exempt shape, then a third list:
    // if ANY exempt call had counted, this third list would already be the 4th and block.
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "wait", timeoutMs: 1000 })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "abort", id: "all" })).toBeUndefined();
    expect(fireToolCall(pi, "queue", { action: "add", tasks: ["x"] })).toBeUndefined();
    expect(fireToolCall(pi, "monitor", { action: "cancel", id: "m-1" })).toBeUndefined();
    expect(fireToolCall(pi, "wait", {})).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined(); // 3rd counted — allowed

    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true); // 4th counted — blocked
  });

  test("the env override is read per call: 0 disables mid-session, unsetting restores the limit", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);

    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();

    process.env[POLL_ENV] = "0"; // read at the NEXT call: the guard is off
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();

    delete process.env[POLL_ENV]; // restored: the 3 earlier timestamps are still in the window
    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true);
  });

  test("a non-zero env value lowers the limit", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    process.env[POLL_ENV] = "1";
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true);
  });

  test("state resets across session_shutdown (both factories' handlers run)", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();

    shutdownSession(pi);

    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true); // a fresh window, not a carry-over
  });
});

// ------------------------------------------------------------------ SHOULD-4

describe("SHOULD-4: the kill switch discriminates, and invalid env values fall back", () => {
  test("disabled calls do not count: re-enabling must NOT inherit the disabled window's phantom calls", () => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    process.env[POLL_ENV] = "5";
    for (let i = 0; i < 3; i++) expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();

    process.env[POLL_ENV] = "0"; // disabled: nothing counts
    for (let i = 0; i < 3; i++) expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();

    process.env[POLL_ENV] = "5"; // re-enabled: the window holds the 3 pre-disable calls, not 6
    // pre-fix (disabled calls counted) the window would hold 6 and THIS call would block
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined(); // counted 4 — under 5
    expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined(); // counted 5 — at the limit
    expect(fireToolCall(pi, delegations, { action: "list" })?.reason).toMatch(/#6/); // counted 6 — blocked
  });

  test.each(["abc", "-1", "2.5"])("invalid poll env value %s falls back to the configured default", (raw) => {
    const { pi } = makeCombinedHarness();
    const delegations = registeredDelegationsName(pi);
    process.env[POLL_ENV] = raw;
    for (let i = 0; i < 3; i++) expect(fireToolCall(pi, delegations, { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, delegations, { action: "list" })?.block).toBe(true); // default max 3 still governs
  });
});
