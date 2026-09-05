/**
 * Wiring tests for the monitor extension's manual-wait enforcement (f: 2026-09-02 ruling:
 * "any manual attempt should be redirected on the harness level"). A bash/powershell
 * `sleep`/`Start-Sleep` parks the main loop — the exact thing the wait-tool rework removed
 * `delegations wait` for — so the tool_call handler blocks it and redirects to the wait tool /
 * monitor registration. The decision itself is the pure core's `manualWaitDecision`; these rows
 * pin the WIRING: which tools are guarded, the env kill switch read per call, and that a bash
 * sleep never counts into the delegations poll-guard window.
 */

import { afterEach, describe, expect, test } from "bun:test";
import monitor from "../../extensions/monitor/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

// ------------------------------------------------------------------ harness

interface Harness {
  pi: FakePi;
}

function makeHarness(): Harness {
  const pi = createFakePi();
  monitor(pi as never, { now: () => pi.clock.now });
  return { pi };
}

const WAIT_GUARD_ENV = "PI_BADGER_WAIT_GUARD";
const POLL_ENV = "PI_BADGER_MONITOR_POLL_MAX";
afterEach(() => {
  delete process.env[WAIT_GUARD_ENV];
  delete process.env[POLL_ENV];
});

interface BlockResult {
  block?: boolean;
  reason?: string;
}

let toolCallSeq = 0;

/** Dispatch one tool_call through every registered handler (handler arrays); return the first block. */
function fireToolCall(pi: FakePi, toolName: string, input: Record<string, unknown>): BlockResult | undefined {
  for (const handler of pi.handlers.get("tool_call") ?? []) {
    const result = handler({ type: "tool_call", toolCallId: `tc-${++toolCallSeq}`, toolName, input }, {
      mode: "tui",
      hasUI: true,
      cwd: "/p",
      ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
    }) as BlockResult | undefined;
    if (result?.block) return result;
  }
  return undefined;
}

// ------------------------------------------------------------------ rows

describe("W-G — manual-wait enforcement: shell sleeps are blocked at the harness level (f: 2026-09-02)", () => {
  test("W-G1: a bash `sleep 30` tool call is blocked with wait-tool / monitor registration guidance", () => {
    const { pi } = makeHarness();

    const blocked = fireToolCall(pi, "bash", { command: "sleep 30" });

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("main loop");
    expect(blocked?.reason).toContain("wait tool");
    expect(blocked?.reason).toContain("monitor");
  });

  test("W-G2: a sleep inside a compound command is blocked too (bun run test && sleep 30)", () => {
    const { pi } = makeHarness();

    const blocked = fireToolCall(pi, "bash", { command: "bun run test && sleep 30" });

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("wait tool");
  });

  test("W-G3: powershell Start-Sleep is blocked the same way", () => {
    const { pi } = makeHarness();

    const blocked = fireToolCall(pi, "powershell", { command: "Start-Sleep -Seconds 30" });

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("wait tool");
  });

  test("W-G4: non-wait commands pass — `cat sleep` and `npm run sleep-test` are not waits", () => {
    const { pi } = makeHarness();

    expect(fireToolCall(pi, "bash", { command: "cat sleep" })).toBeUndefined();
    expect(fireToolCall(pi, "bash", { command: "npm run sleep-test" })).toBeUndefined();
  });

  test("W-G5: non-shell tools are never wait-guarded (delegations list reaches the poll guard untouched)", () => {
    const { pi } = makeHarness();

    expect(fireToolCall(pi, "delegations", { action: "list" })).toBeUndefined();
  });

  test("W-G6: PI_BADGER_WAIT_GUARD=0 disables the guard — the sleep passes", () => {
    const { pi } = makeHarness();
    process.env[WAIT_GUARD_ENV] = "0";

    expect(fireToolCall(pi, "bash", { command: "sleep 30" })).toBeUndefined();
  });

  test("W-G7: a blocked bash sleep never counts into the delegations poll-guard window", () => {
    const { pi } = makeHarness();
    fireToolCall(pi, "bash", { command: "sleep 30" });
    fireToolCall(pi, "bash", { command: "sleep 10 && echo done" });

    // Three delegations list calls — the poll guard's limit is 3 allowed / 4th blocked; two
    // blocked sleeps must not have consumed any of that budget.
    expect(fireToolCall(pi, "delegations", { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, "delegations", { action: "list" })).toBeUndefined();
    expect(fireToolCall(pi, "delegations", { action: "list" })).toBeUndefined();
    const fourth = fireToolCall(pi, "delegations", { action: "list" });
    expect(fourth?.block).toBe(true); // blocked by the POLL guard (its reason), not the wait guard
    expect(fourth?.reason).toContain("delegations list/log call #4");
  });

  test("W-G8: shell-keyword boundaries are blocked too — for/do, then, subshell, brace, negation (f: sleep-loop miss)", () => {
    const { pi } = makeHarness();

    // The exact miss: `do` sits between `;` and `sleep`, so the old `;`/`|`/`&` boundary never fired.
    expect(
      fireToolCall(pi, "bash", {
        command: "for i in $(seq 1 10); do sleep 45; s=$(gh pr checks 619 2>&1); done",
      })?.block,
    ).toBe(true);
    expect(fireToolCall(pi, "bash", { command: "for i in 1 2 3; do sleep 45; done" })?.block).toBe(true);
    expect(fireToolCall(pi, "bash", { command: "if true; then sleep 5; fi" })?.block).toBe(true);
    expect(fireToolCall(pi, "bash", { command: "(sleep 5)" })?.block).toBe(true);
    expect(fireToolCall(pi, "bash", { command: "{ sleep 5; }" })?.block).toBe(true);
    expect(fireToolCall(pi, "bash", { command: "! sleep 5" })?.block).toBe(true);
    // Right boundary still holds for closers: `sleep)` is a wait, `sleep-test`/`sleepwalker` are not.
    expect(fireToolCall(pi, "bash", { command: "echo $(sleep 5)" })?.block).toBe(true);
    expect(fireToolCall(pi, "bash", { command: "sleepwalker" })).toBeUndefined();
  });
});
