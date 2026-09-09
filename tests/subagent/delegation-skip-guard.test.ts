/**
 * Wiring + decision tests for the P5 delegation-skip BLOCKING guard (PKG-5 P5,
 * f: 2026-09-08 — advisory gave us nothing, so prompt-like `pi` spawns block):
 * bash/powershell commands that spawn `pi` directly return `{ block: true }`
 * with "use `delegate` instead" and record a `delegation-skip` entry.
 * Help/version reads (`pi --help`, `-h`, `--version`, `-v`) stay silent.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBenignPiSpawn,
  PI_SPAWN_COMMAND,
  piSpawnDecision,
  registerDelegationSkipGuard,
  SKIP_BLOCK_MESSAGE,
} from "../../extensions/subagent/delegation-skip-guard.ts";
import subagentFactory from "../../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

// ------------------------------------------------------------------ harness

interface Ctx {
  mode: string;
  hasUI: boolean;
  cwd: string;
  ui: { notify: (message: string, level?: string) => void; setWidget: () => void; setStatus: () => void };
}

interface Harness {
  pi: FakePi;
  notified: Array<{ message: string; level?: string }>;
  ctxFor: () => Ctx;
}

function makeHarness(): Harness {
  const pi = createFakePi();
  const notified: Array<{ message: string; level?: string }> = [];
  registerDelegationSkipGuard(pi as never);
  const ctxFor = (): Ctx => ({
    mode: "tui",
    hasUI: true,
    cwd: "/p",
    ui: {
      notify: (message: string, level?: string) => {
        notified.push({ message, level });
      },
      setWidget: () => {},
      setStatus: () => {},
    },
  });
  return { pi, notified, ctxFor };
}

let toolCallSeq = 0;

/**
 * Dispatch one tool_call through every registered handler; collect every result.
 */
function fireToolCall(
  pi: FakePi,
  toolName: string,
  input: Record<string, unknown>,
  ctx: Ctx,
): Array<unknown> {
  return (pi.handlers.get("tool_call") ?? []).map((handler) =>
    handler({ type: "tool_call", toolCallId: `tc-${++toolCallSeq}`, toolName, input }, ctx),
  );
}

function entriesOf(pi: FakePi, customType: string): Array<{ customType: string; data: unknown }> {
  return pi.entries.filter((entry) => entry.customType === customType);
}

// ------------------------------------------------------------------ matrices

/** Prompt-like spawns: must BLOCK (original spike §AC2 minus the two --help rows). */
const MUST_BLOCK = [
  "pi run --task 'x'",
  "pi",
  "nohup pi run --task hi &",
  "nohup pi &",
  "a && pi run --task x",
  "VAR=x pi run",
  "npx pi run --task x",
  "./pi run",
  "sudo pi run",
  "if true; then pi run; fi",
  "$(pi run)",
  "timeout 60 pi run --task x",
  "FOO=1\npi run",
];

/** Help/version reads: documentation, never delegation skips — must stay silent. */
const MUST_ALLOW_HELP = [
  "pi --help",
  "/usr/local/bin/pi --help",
  "pi -h",
  "pi --version",
  "pi -v",
  "npx pi --help",
  "sudo pi --version",
  "./pi --help",
  "pi list --help",
];

const MUST_NOT_FIRE = [
  "pip install requests",
  "pip install pi",
  "happy",
  "echo happy",
  "spin up",
  "cat spin",
  "bun publish.ts",
  "nohup bun publish.ts &",
  "nohup bun run scripts/test-gate.ts &",
  "nohup git push &",
  "npm run sleep-test",
  "sleep 30",
  "echo pi",
  "grep pi README.md",
  'echo "pi run"',
  "my-pi run",
  "pi3 run",
  "PI run",
  // spike residual: wrapper binaries take the pi slot (command-position silent by design).
  "xargs pi",
  "command pi",
];

// ------------------------------------------------------------------ rows

describe("delegation-skip guard matrix (blocking: 13/13 block, help/version + 20/20 silent)", () => {
  test("matrix positives: every MUST-block command decides block with the delegate reason", () => {
    expect(MUST_BLOCK).toHaveLength(13);
    for (const command of MUST_BLOCK) {
      expect(piSpawnDecision(command), command).toEqual({ action: "block", reason: SKIP_BLOCK_MESSAGE });
    }
  });

  test("matrix help/version: every help/version read decides silent", () => {
    expect(MUST_ALLOW_HELP.length).toBeGreaterThan(0);
    for (const command of MUST_ALLOW_HELP) {
      expect(piSpawnDecision(command), command).toEqual({ action: "silent" });
      expect(isBenignPiSpawn(command), command).toBe(true);
    }
  });

  test("matrix negatives: every MUST-NOT command decides silent", () => {
    expect(MUST_NOT_FIRE).toHaveLength(20);
    for (const command of MUST_NOT_FIRE) {
      expect(piSpawnDecision(command), command).toEqual({ action: "silent" });
    }
  });

  test("benign scope is pi-scoped: flags on other commands do not exempt a pi prompt run", () => {
    // --help belongs to echo, not pi → still blocks.
    expect(piSpawnDecision("echo --help; pi run --task x")).toEqual({ action: "block", reason: SKIP_BLOCK_MESSAGE });
    expect(piSpawnDecision("pi run --task x; echo --help")).toEqual({ action: "block", reason: SKIP_BLOCK_MESSAGE });
    // Mixed: one benign pi read + one prompt run → still blocks.
    expect(piSpawnDecision("pi --help; pi run --task x")).toEqual({ action: "block", reason: SKIP_BLOCK_MESSAGE });
  });

  test("empty/undefined commands are silent, and the predicate is stateless across calls", () => {
    expect(piSpawnDecision(undefined)).toEqual({ action: "silent" });
    expect(piSpawnDecision("")).toEqual({ action: "silent" });
    expect(piSpawnDecision("   ")).toEqual({ action: "silent" });
    // No /g/ flag: repeated tests of the same command must agree.
    expect(PI_SPAWN_COMMAND.flags).not.toContain("g");
    for (let i = 0; i < 3; i += 1) {
      expect(piSpawnDecision("pi run --task x")).toEqual({ action: "block", reason: SKIP_BLOCK_MESSAGE });
    }
  });
});

describe("D-S1: positives block + record", () => {
  for (const command of ["pi run --task x", "nohup pi run --task hi &", "pi", "npx pi run --task x"]) {
    test(`block fires on \`${command}\``, () => {
      const { pi, notified, ctxFor } = makeHarness();

      const results = fireToolCall(pi, "bash", { command }, ctxFor());

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ block: true, reason: SKIP_BLOCK_MESSAGE });
      // The block reason is the surface (monitor precedent) — no separate ui.notify.
      expect(notified).toHaveLength(0);
      const recorded = entriesOf(pi, "delegation-skip");
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.data).toMatchObject({ command, blocked: true });
    });
  }

  test("help/version reads stay silent (no block, no record)", () => {
    const { pi, notified, ctxFor } = makeHarness();
    for (const command of ["pi --help", "pi --version", "/usr/local/bin/pi --help", "pi -h"]) {
      const results = fireToolCall(pi, "bash", { command }, ctxFor());
      expect(results, command).toEqual([undefined]);
    }
    expect(notified).toHaveLength(0);
    expect(entriesOf(pi, "delegation-skip")).toHaveLength(0);
  });
});

describe("D-S1b: powershell parity + headless blocks too", () => {
  test("powershell pi spawn blocks + records (bash parity)", () => {
    const { pi, notified, ctxFor } = makeHarness();
    const results = fireToolCall(pi, "powershell", { command: "pi run --task x" }, ctxFor());
    expect(results).toEqual([{ block: true, reason: SKIP_BLOCK_MESSAGE }]);
    expect(notified).toHaveLength(0);
    expect(entriesOf(pi, "delegation-skip")).toHaveLength(1);
  });
  test("hasUI:false still blocks + records (headless parity)", () => {
    const { pi, notified, ctxFor } = makeHarness();
    const ctx = ctxFor();
    ctx.hasUI = false;
    const results = fireToolCall(pi, "bash", { command: "pi run --task x" }, ctx);
    expect(results).toEqual([{ block: true, reason: SKIP_BLOCK_MESSAGE }]);
    expect(notified).toHaveLength(0);
    expect(entriesOf(pi, "delegation-skip")).toHaveLength(1);
  });
});

describe("D-S2: near-miss negatives stay silent", () => {
  for (
    const command of [
      "pip install requests",
      "nohup bun run scripts/test-gate.ts &",
      "nohup git push &",
      "nohup bun publish.ts &",
      "happy",
      "spin up",
      "my-pi run",
    ]
  ) {
    test(`silent on \`${command}\``, () => {
      const { pi, notified, ctxFor } = makeHarness();

      const results = fireToolCall(pi, "bash", { command }, ctxFor());

      expect(results).toHaveLength(1);
      expect(results[0]).toBeUndefined();
      expect(notified).toHaveLength(0);
      expect(entriesOf(pi, "delegation-skip")).toHaveLength(0);
    });
  }
});

describe("D-S4: non-shell tools and non-string commands never reach the predicate", () => {
  test("non-shell tool calls are silent", () => {
    const { pi, notified, ctxFor } = makeHarness();

    for (
      const [toolName, input] of [
        ["delegations", { action: "list" }],
        ["read", { path: "pi" }],
        ["delegate", { agent: "architect", task: "pi run" }],
      ] as Array<[string, Record<string, unknown>]>
    ) {
      expect(fireToolCall(pi, toolName, input, ctxFor())).toEqual([undefined]);
    }

    expect(notified).toHaveLength(0);
    expect(entriesOf(pi, "delegation-skip")).toHaveLength(0);
  });

  test("bash calls without a string command are silent", () => {
    const { pi, notified, ctxFor } = makeHarness();

    for (const input of [{}, { command: 42 }, { command: undefined }, { command: "" }]) {
      expect(fireToolCall(pi, "bash", input as Record<string, unknown>, ctxFor())).toEqual([undefined]);
    }

    expect(notified).toHaveLength(0);
    expect(entriesOf(pi, "delegation-skip")).toHaveLength(0);
  });
});

describe("D-S5: recorder failure still blocks; predicate crash fails open; no env bypass", () => {
  test("throwing appendEntry still blocks — the block is intentional, the record is audit", () => {
    const { pi, ctxFor } = makeHarness();
    pi.appendEntry = () => {
      throw new Error("store gone");
    };

    const results = fireToolCall(pi, "bash", { command: "pi run --task x" }, ctxFor());

    expect(results).toEqual([{ block: true, reason: SKIP_BLOCK_MESSAGE }]);
  });

  test("no env bypass: PI_BADGER_DELEGATION_SKIP_GUARD=0 still blocks a detected spawn", () => {
    process.env.PI_BADGER_DELEGATION_SKIP_GUARD = "0";
    try {
      const { pi, notified, ctxFor } = makeHarness();

      const results = fireToolCall(pi, "bash", { command: "pi run --task x" }, ctxFor());

      expect(results).toEqual([{ block: true, reason: SKIP_BLOCK_MESSAGE }]);
      expect(notified).toHaveLength(0);
      expect(entriesOf(pi, "delegation-skip")).toHaveLength(1);
    } finally {
      delete process.env.PI_BADGER_DELEGATION_SKIP_GUARD;
    }
  });
});

describe("registration: the guard fires through the real subagent factory", () => {
  test("factory-wired guard blocks a bash pi spawn, silent on pip and pi --help", () => {
    const pi = createFakePi();
    const notified: Array<{ message: string; level?: string }> = [];
    const logDir = mkdtempSync(join(tmpdir(), "delegation-skip-guard-"));
    try {
      subagentFactory(pi as never, { logDir });
      const ctx = {
        mode: "tui",
        hasUI: true,
        cwd: "/p",
        ui: {
          notify: (message: string, level?: string) => {
            notified.push({ message, level });
          },
          setWidget: () => {},
          setStatus: () => {},
        },
      };

      const fired: Array<unknown> = [];
      for (const handler of pi.handlers.get("tool_call") ?? []) {
        fired.push(
          handler({ type: "tool_call", toolCallId: "tc-factory-1", toolName: "bash", input: { command: "pi run --task x" } }, ctx),
        );
      }
      expect(fired.some((result) => (result as { block?: boolean } | undefined)?.block === true)).toBe(true);
      expect(entriesOf(pi, "delegation-skip")).toHaveLength(1);

      const silent: Array<unknown> = [];
      for (const handler of pi.handlers.get("tool_call") ?? []) {
        silent.push(
          handler({ type: "tool_call", toolCallId: "tc-factory-2", toolName: "bash", input: { command: "pip install pi" } }, ctx),
        );
      }
      // pip is silent from THIS guard; other guards (monitor) also return undefined for it.
      expect(silent.every((result) => result === undefined)).toBe(true);
      expect(entriesOf(pi, "delegation-skip")).toHaveLength(1);

      const helpSilent: Array<unknown> = [];
      for (const handler of pi.handlers.get("tool_call") ?? []) {
        helpSilent.push(
          handler({ type: "tool_call", toolCallId: "tc-factory-3", toolName: "bash", input: { command: "pi --help" } }, ctx),
        );
      }
      expect(helpSilent.every((result) => result === undefined)).toBe(true);
      expect(entriesOf(pi, "delegation-skip")).toHaveLength(1);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
