/**
 * P3 suite — delegate rewiring for background/blocking modes, completion notification and
 * restart reconstruction (rows 43–48, T66–T74 of docs/plans/2026-interactive-subagent-delegation.tests.md).
 *
 * Harness: the fake-pi handlers-map pattern from tests/session-signals/ — a Map-backed `pi`
 * whose registerTool / registerMessageRenderer / on / sendMessage / appendEntry / events calls
 * are captured — plus FakeChild (tests/helpers/fake-child.ts) driven through the real
 * DelegationRegistry the factory constructs. Spawn is injected, so no test touches a real
 * child process; the log dir is a per-test temp dir (the R4 default is only a fallback).
 *
 * Flake conventions (tests doc header): FakeChild emits close synchronously from drive calls;
 * time is injected (`now: () => NOW`); no fake-timer library. Blocking tests call execute()
 * without awaiting, drive the child, then await — the spawn happens synchronously inside
 * registry.start, so children[0] exists before the first drive call.
 *
 * Row 43 scope note: the delegations tool + /delegations command are P4's delegation-status.ts
 * (orchestrator wiring at merge). This suite pins the P3-owned registration surface (delegate
 * tool, session handlers, delegation-result renderer, pi.events wire); P4 completes the row.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChild } from "./helpers/fake-child.ts";
import { AGENTS_DIR } from "../extensions/subagent/index.ts";
import subagent from "../extensions/subagent/index.ts";
import {
  clampRunTimeoutMs,
  notificationVerdict,
  RUN_TIMEOUT_MAX_MS,
} from "../extensions/subagent/index.ts";
import type { DelegationNote } from "../extensions/subagent/delegation-runner.ts";


const NOW = 1_700_000_000_000;

/** Exactly what adjust_agents.py writes: frontmatter keys, then the managed body. */
const SCAFFOLDED = `---
name: architect
description: Architecture specialist. Read-only.
---

# Architect

Produce a blueprint, never an edit.
`;

interface SentMessage {
  message: { customType?: string; content: unknown; display?: boolean; details?: Record<string, unknown> };
  options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
}

interface Harness {
  /** Real pi.on is pub/sub: many handlers per event, run in registration order. The fake
   * must dispatch arrays — single-slot storage let P4's session_shutdown (widget cleanup)
   * silently overwrite P3's (registry kill-all) once the W3 wiring landed. */
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  tools: Map<string, any>;
  commands: Map<string, unknown>;
  renderers: Map<string, (message: any, options: any, theme: any) => unknown>;
  sent: SentMessage[];
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
  const h: Harness = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    renderers: new Map(),
    sent: [],
    entries: [],
    transitions: [],
    children: [],
    spawnOptions: [],
    notifications: [],
    projectDir: mkdtempSync(join(tmpdir(), "aib-subagent-ext-")),
    logDir: mkdtempSync(join(tmpdir(), "aib-subagent-ext-logs-")),
    api: undefined,
  };
  mkdirSync(join(h.projectDir, ...AGENTS_DIR), { recursive: true });
  writeFileSync(join(h.projectDir, ...AGENTS_DIR, "architect.md"), SCAFFOLDED);

  const pi = {
    registerTool: (tool: any) => h.tools.set(tool.name, tool),
    registerCommand: (name: string, opts: unknown) => h.commands.set(name, opts),
    registerMessageRenderer: (customType: string, renderer: any) => h.renderers.set(customType, renderer),
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = h.handlers.get(name) ?? [];
      list.push(handler);
      h.handlers.set(name, list);
    },
    sendMessage: (message: any, options?: any) => h.sent.push({ message, options }),
    appendEntry: (customType: string, data?: unknown) => h.entries.push({ customType, data }),
    events: {
      emit: (channel: string, data: unknown) => h.transitions.push({ channel, data }),
      on: () => () => {},
    },
  };

  const spawnFn = (_command: string, _args: string[], options: { cwd: string }) => {
    h.spawnOptions.push(options);
    const child = new FakeChild();
    h.children.push(child);
    return child;
  };

  h.api = subagent(pi as never, { spawnFn, logDir: h.logDir, now: () => NOW, escalateAfterMs: 0, ...deps }) as {
    registry: any;
  };
  return h;
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

interface DelegateResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}
type OnUpdate = (partial: unknown) => void;

function delegateTool(): { execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, ctx: unknown): Promise<DelegateResult> } {
  return h.tools.get("delegate");
}

function contentOf(result: DelegateResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function callDelegate(
  params: Record<string, unknown>,
  ctx: unknown,
  onUpdate?: OnUpdate,
  toolCallId = "call-1",
): Promise<DelegateResult> {
  return delegateTool().execute(toolCallId, params, undefined, onUpdate, ctx);
}

function fireSessionStart(reason = "startup"): unknown {
  let last: unknown;
  for (const handler of h.handlers.get("session_start") ?? []) {
    last = handler({ type: "session_start", reason }, makeCtx());
  }
  return last;
}

function fireSessionShutdown(reason = "quit"): unknown {
  let last: unknown;
  for (const handler of h.handlers.get("session_shutdown") ?? []) {
    last = handler({ type: "session_shutdown", reason }, makeCtx());
  }
  return last;
}

// ------------------------------------------------------------------ log-dir fixtures

const SESSION_LINE = JSON.stringify({ type: "session", version: 3, id: "child-session", cwd: "/p" });

function assistantEnd(text: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...(usage ? { usage } : {}) },
  });
}

function runHeaderLine(id: string, pid: number | undefined): string {
  return JSON.stringify({
    type: "run",
    runId: id,
    agent: "architect",
    persona: "architect",
    task: `task ${id}`,
    argv: ["-p"],
    cwd: "/p",
    ...(pid !== undefined ? { pid } : {}),
    startedAt: NOW,
    sessionId: "old-session",
  });
}

function exitLine(code: number): string {
  return JSON.stringify({ type: "exit", exitCode: code, endedAt: NOW });
}

function writeLog(dir: string, id: string, lines: string[], mtime?: Date): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, [...lines, ""].join("\n"));
  if (mtime) utimesSync(file, mtime, mtime);
}

/** A genuinely dead pid: a real short-lived process that has already been reaped. */
function deadPid(): number {
  const proc = spawnSync(process.execPath, ["-e", ""]);
  return proc.pid ?? 999_999;
}

const themeStub = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };

// ------------------------------------------------------------------ row 43: registration shape

describe("row 43 — registration shape", () => {
  test("registers the delegate tool, the session handlers, and the delegation-result renderer", () => {
    h = makeHarness();

    expect([...h.tools.keys()]).toContain("delegate");
    expect([...h.handlers.keys()]).toContain("session_start");
    expect([...h.handlers.keys()]).toContain("session_shutdown");
    expect([...h.renderers.keys()]).toContain("delegation-result");
    // The delegations tool + /delegations command are P4's delegation-status.ts — the
    // orchestrator adds that wiring at merge and completes this row's surface there.
  });

  test("wiring (T60): transitions ride pi.events as serializable snapshots", async () => {
    h = makeHarness();
    await callDelegate({ agent: "architect", task: "t" }, makeCtx());
    h.children[0]!.exit(0);

    const states = h.transitions.filter((t) => t.channel === "delegation-transition").map((t) => t.data.state);
    expect(states).toContain("running");
    expect(states).toContain("completed");
    const snapshot = h.transitions.find((t) => t.channel === "delegation-transition")!.data;
    expect(typeof snapshot.id).toBe("string");
    expect(typeof snapshot.at).toBe("number");
    expect(snapshot.record).toBeTypeOf("object");
  });
});

// ------------------------------------------------------------------ row 44: unknown agent

describe("row 44 — unknown agent answers immediately with the persona list", () => {
  test("no child is spawned; the list rides the result", async () => {
    h = makeHarness();
    const result = await callDelegate({ agent: "nope", task: "t" }, makeCtx());

    expect(contentOf(result)).toContain('no persona named "nope"');
    expect(contentOf(result)).toContain("architect:");
    expect(result.details.exitCode).toBeNull();
    expect(h.children).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ T66: background auto-resolution matrix

describe("T66 — background auto-resolution matrix (auto = background iff mode tui)", () => {
  test("mode tui, no explicit value → background receipt", async () => {
    h = makeHarness();
    const result = await callDelegate({ agent: "architect", task: "t" }, makeCtx("tui"));

    expect(result.details.state).toBe("running");
    expect(result.details.id).toBe("d-1");
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.exited).toBe(false);
  });

  test("mode print, no explicit value → blocking result with usage", async () => {
    h = makeHarness();
    const pending = callDelegate({ agent: "architect", task: "t" }, makeCtx("print"));
    h.children[0]!.write(`${SESSION_LINE}\n`);
    h.children[0]!.write(`${assistantEnd("the plan, done", { input: 10, output: 2, cost: { total: 0.01 }, totalTokens: 99 })}\n`);
    h.children[0]!.exit(0);
    const result = await pending;

    expect(contentOf(result)).toContain("the plan, done");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.usage).toBeDefined();
    expect((result.details.usage as any).output).toBe(2);
    expect(result.details.state).toBeUndefined(); // not a receipt
    expect(result.details.degraded).toBeUndefined();
  });

  test("mode rpc, no explicit value → blocking result (hasUI is not the predicate)", async () => {
    h = makeHarness();
    const pending = callDelegate({ agent: "architect", task: "t" }, makeCtx("rpc"));
    h.children[0]!.write(`${assistantEnd("rpc answer")}\n`);
    h.children[0]!.exit(0);
    const result = await pending;

    expect(contentOf(result)).toContain("rpc answer");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.degraded).toBeUndefined();
  });

  test("blocking-in-tui is observable: explicit background:false result names itself", async () => {
    h = makeHarness();
    const pending = callDelegate({ agent: "architect", task: "t", background: false }, makeCtx("tui"));
    h.children[0]!.write(`${assistantEnd("sync answer")}\n`);
    h.children[0]!.exit(0);
    const result = await pending;

    expect(contentOf(result)).toContain("background:false");
    expect(contentOf(result)).toContain("blocking");
    expect(contentOf(result)).toContain("sync answer"); // the inline result still rides below the notice
  });

  test("explicit background:false wins in tui → blocking result", async () => {
    h = makeHarness();
    const pending = callDelegate({ agent: "architect", task: "t", background: false }, makeCtx("tui"));
    h.children[0]!.write(`${assistantEnd("sync answer")}\n`);
    h.children[0]!.exit(0);
    const result = await pending;

    expect(contentOf(result)).toContain("sync answer");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.state).toBeUndefined();
  });

  test("explicit background:true wins in tui → background receipt", async () => {
    h = makeHarness();
    const result = await callDelegate({ agent: "architect", task: "t", background: true }, makeCtx("tui"));

    expect(result.details.state).toBe("running");
    expect(h.children).toHaveLength(1);
  });

  test("wiring (task scope): blocking onUpdate reports live progress per message_end", async () => {
    h = makeHarness();
    const updates: any[] = [];
    const pending = callDelegate({ agent: "architect", task: "t" }, makeCtx("print"), (partial) => updates.push(partial));
    h.children[0]!.write(`${assistantEnd("first turn", { output: 2 })}\n`);
    // Let execute resume and subscribe before the next event: everything before this yield is
    // replayed from the latest-progress buffer, everything after is delivered live.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterFirst = updates.length;
    h.children[0]!.write(`${assistantEnd("second turn", { output: 5 })}\n`);
    h.children[0]!.exit(0);
    await pending;

    expect(afterFirst).toBeGreaterThanOrEqual(1); // delivered while the child was still open
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const last = updates[updates.length - 1] as any;
    expect(last.details.id).toBe("d-1");
    expect(last.details.state).toBe("running");
    expect(last.details.usage.output).toBe(7); // usage accumulates across turns (2 + 5)
  });
});

// ------------------------------------------------------------------ T67: degrade rides the tool result

describe("T67 — background:true outside tui degrades to blocking on the tool result", () => {
  test("print mode + explicit background:true → blocking result, degrade line in content, details.degraded", async () => {
    h = makeHarness();
    const pending = callDelegate({ agent: "architect", task: "t", background: true }, makeCtx("print"));
    h.children[0]!.write(`${assistantEnd("degraded answer")}\n`);
    h.children[0]!.exit(0);
    const result = await pending;

    expect(contentOf(result)).toContain("background");
    expect(contentOf(result)).toContain("blocking");
    expect(contentOf(result)).toContain("degraded answer"); // fully blocking: the answer rides the result
    expect(result.details.degraded).toBeDefined();
    expect(result.details.exitCode).toBe(0);
  });
});

// ------------------------------------------------------------------ row 45 + T68: receipts

describe("row 45 — tool result while running says running (receipt with id/toolCallId)", () => {
  test("receipt details carry id, agent, state, toolCallId and the log path; the child stays open", async () => {
    h = makeHarness();
    const result = await callDelegate({ agent: "architect", task: "t" }, makeCtx(), undefined, "call-42");

    expect(contentOf(result)).toContain("Delegation d-1 started");
    expect(result.details).toMatchObject({ id: "d-1", agent: "architect", state: "running", toolCallId: "call-42" });
    expect(result.details.logFile).toBe(join(h.logDir, "d-1.jsonl"));
    expect(existsSync(join(h.logDir, "d-1.jsonl"))).toBe(true);
    expect(h.children[0]!.exited).toBe(false);
    // single reachable registry instance (the future P4 registerDelegationStatus seam)
    expect(h.api!.registry.get("d-1").toolCallId).toBe("call-42");
  });
});

describe("T68 — receipt queued variant", () => {
  test("cap full → receipt says queued (position N), not started", async () => {
    h = makeHarness("tui", { cap: 1 });
    const first = await callDelegate({ agent: "architect", task: "first" }, makeCtx(), undefined, "call-1");
    expect(first.details.state).toBe("running");

    const second = await callDelegate({ agent: "architect", task: "second" }, makeCtx(), undefined, "call-2");
    expect(second.details.state).toBe("queued");
    expect(second.details.queuePosition).toBe(1);
    expect(contentOf(second)).toContain("Delegation d-2 queued (position 1)");
    expect(h.children).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ rows 46/T69/T70/T71: notifications

describe("row 46 — completion rides sendMessage followUp + triggerTurn", () => {
  test("one delegation-result custom message with the note", async () => {
    h = makeHarness();
    await callDelegate({ agent: "architect", task: "t" }, makeCtx());
    h.children[0]!.write(`${SESSION_LINE}\n`);
    h.children[0]!.write(`${assistantEnd("all done", { input: 10, output: 2, cost: { total: 0.01 } })}\n`);
    h.children[0]!.exit(0);

    expect(h.sent).toHaveLength(1);
    const { message, options } = h.sent[0]!;
    expect(message.customType).toBe("delegation-result");
    expect(String(message.content)).toContain("completed");
    expect(String(message.content)).toContain("all done");
    expect(message.display).toBe(true);
    expect((message.details as any).usage.output).toBe(2);
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  test("T70: double-close fires exactly one notification", async () => {
    h = makeHarness();
    await callDelegate({ agent: "architect", task: "t" }, makeCtx());
    h.children[0]!.write(`${assistantEnd("done once")}\n`);
    h.children[0]!.exit(0);
    h.children[0]!.exit(0); // double close

    expect(h.sent).toHaveLength(1);
  });

  test("T71: notification content stays under the 8 KB cap, with a dropped marker", async () => {
    h = makeHarness();
    await callDelegate({ agent: "architect", task: "t" }, makeCtx());
    h.children[0]!.write(`${assistantEnd("x".repeat(200_000))}\n`);
    h.children[0]!.exit(0);

    expect(h.sent).toHaveLength(1);
    const content = String(h.sent[0]!.message.content);
    expect(content.length).toBeLessThanOrEqual(8 * 1024);
    expect(content).toContain("earlier characters dropped");
  });

  test("T69: abort-queued fires exactly one aborted notification, without exitCode", async () => {
    h = makeHarness("tui", { cap: 1 });
    await callDelegate({ agent: "architect", task: "first" }, makeCtx(), undefined, "call-1");
    const queued = await callDelegate({ agent: "architect", task: "second" }, makeCtx(), undefined, "call-2");
    const queuedId = queued.details.id as string;

    h.api!.registry.abort(queuedId);

    expect(h.sent).toHaveLength(1);
    const { message } = h.sent[0]!;
    expect(message.customType).toBe("delegation-result");
    expect(String(message.content)).toContain("aborted");
    expect((message.details as any).state).toBe("aborted");
    expect((message.details as any).exitCode).toBeUndefined();
    expect(h.children).toHaveLength(1); // no kill — there was never a child
  });
});

// ------------------------------------------------------------------ T72: message renderer

describe("T72 — delegation-result renderer registered (compact card)", () => {
  test("the renderer turns the message into a card showing the verdict", () => {
    h = makeHarness();
    const renderer = h.renderers.get("delegation-result")!;

    const component = renderer(
      {
        customType: "delegation-result",
        content: "Delegation d-1 (architect) completed.\nall done",
        display: true,
        details: { id: "d-1", state: "completed", exitCode: 0 },
      },
      { expanded: false, outputPad: 0 },
      themeStub,
    ) as { render(width: number): string[] };

    expect(component).toBeDefined();
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("Delegation d-1 (architect) completed.");
    expect(rendered).toContain("all done");
  });
});

// ------------------------------------------------------------------ rows 47/T73 + R4 wiring: reconstruction

describe("rows 47/T73 — session_start reconstruction from the log dir", () => {
  test("row 47: marks lost runs, never notifies", () => {
    h = makeHarness();
    writeLog(h.logDir, "d-9", [runHeaderLine("d-9", deadPid())]);

    fireSessionStart();

    const entry = h.entries.find((e) => e.customType === "delegation-reconstruction");
    expect(entry).toBeDefined();
    const runs = entry!.data.runs as Array<{ id: string; state: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("d-9");
    expect(runs[0]!.state).toBe("lost");
    expect(String(entry!.data.rendered)).toContain("lost");
    // R10: no auto-followUp after restart — nothing notified, nothing sent
    expect(h.sent).toHaveLength(0);
  });

  test("wiring (R4): session_start prunes logs older than 14 days before classification", () => {
    h = makeHarness();
    const old = new Date(NOW - 20 * 24 * 60 * 60 * 1000);
    writeLog(h.logDir, "d-1", [runHeaderLine("d-1", 4242), exitLine(0)], old);
    writeLog(h.logDir, "d-2", [runHeaderLine("d-2", 4242), exitLine(0)]);

    fireSessionStart();

    expect(existsSync(join(h.logDir, "d-1.jsonl"))).toBe(false);
    expect(existsSync(join(h.logDir, "d-2.jsonl"))).toBe(true);
  });

  test("T73: ids are never reused across restart (d-1..d-3 → d-4, then d-5)", async () => {
    h = makeHarness();
    for (const id of ["d-1", "d-2", "d-3"]) {
      writeLog(h.logDir, id, [runHeaderLine(id, 4242), exitLine(0)]);
    }
    fireSessionStart();

    const first = await callDelegate({ agent: "architect", task: "one" }, makeCtx(), undefined, "call-1");
    expect(first.details.id).toBe("d-4");

    const second = await callDelegate({ agent: "architect", task: "two" }, makeCtx(), undefined, "call-2");
    expect(second.details.id).toBe("d-5");
  });
});

// ------------------------------------------------------------------ row 48: session_shutdown

describe("row 48 — session_shutdown kills every live child and silences notifications", () => {
  test("two running → SIGTERM both, registry empty, later exits produce no notifications", async () => {
    h = makeHarness();
    await callDelegate({ agent: "architect", task: "one" }, makeCtx(), undefined, "call-1");
    await callDelegate({ agent: "architect", task: "two" }, makeCtx(), undefined, "call-2");
    expect(h.children).toHaveLength(2);

    fireSessionShutdown();

    expect(h.children[0]!.signals[0]).toBe("SIGTERM");
    expect(h.children[1]!.signals[0]).toBe("SIGTERM");
    expect(h.api!.registry.list()).toHaveLength(0);

    h.children[0]!.exit(0);
    h.children[1]!.exit(0);
    expect(h.sent).toHaveLength(0); // row 38 semantics: shutdown drops notifications
  });
});

// ------------------------------------------------------------------ T74: cwd validation

describe("T74 — cwd validation (personas from ctx.cwd, child in params.cwd)", () => {
  test("relative path → loud error, no child", async () => {
    h = makeHarness();
    const result = await callDelegate({ agent: "architect", task: "t", cwd: "relative/path" }, makeCtx());

    expect(contentOf(result)).toContain("invalid cwd");
    expect(contentOf(result)).toContain("relative/path");
    expect(h.children).toHaveLength(0);
  });

  test("missing path → loud error, no child", async () => {
    h = makeHarness();
    const missing = join(h.projectDir, "does-not-exist");
    const result = await callDelegate({ agent: "architect", task: "t", cwd: missing }, makeCtx());

    expect(contentOf(result)).toContain("invalid cwd");
    expect(contentOf(result)).toContain(missing);
    expect(h.children).toHaveLength(0);
  });

  test("a file path → loud error, no child", async () => {
    h = makeHarness();
    const filePath = join(h.projectDir, "a-file.txt");
    writeFileSync(filePath, "not a directory");
    const result = await callDelegate({ agent: "architect", task: "t", cwd: filePath }, makeCtx());

    expect(contentOf(result)).toContain("invalid cwd");
    expect(h.children).toHaveLength(0);
  });

  test("valid cwd: the child runs there while personas still come from ctx.cwd", async () => {
    h = makeHarness();
    const childCwd = mkdtempSync(join(tmpdir(), "aib-subagent-child-"));
    try {
      const result = await callDelegate({ agent: "architect", task: "t", cwd: childCwd }, makeCtx());

      expect(result.details.state).toBe("running"); // persona resolved from ctx.cwd
      expect(h.spawnOptions[0]!.cwd).toBe(childCwd);
    } finally {
      rmSync(childCwd, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ T86–T91: timeout surfaces (deferral pkg P2)

/** Let the applied (floored, 1 s) per-run timeout fire and the followUp flush. */
const drainTimeout = () => new Promise((resolve) => setTimeout(resolve, 1100));

describe("T86–T91 — per-run timeout surfaces (deferral pkg P2)", () => {
  test("T86: clampRunTimeoutMs bounds — undefined/NaN/Infinity/0/negative = off; floor and cap applied", () => {
    expect(clampRunTimeoutMs(undefined)).toBeUndefined();
    expect(clampRunTimeoutMs(Number.NaN)).toBeUndefined();
    expect(clampRunTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampRunTimeoutMs(0)).toBeUndefined();
    expect(clampRunTimeoutMs(-5)).toBeUndefined();
    expect(clampRunTimeoutMs(100)).toBe(1000); // raised to the floor
    expect(clampRunTimeoutMs(90_000)).toBe(90_000); // within bounds: verbatim
    expect(clampRunTimeoutMs(2 ** 32)).toBe(RUN_TIMEOUT_MAX_MS); // timer-overflow guard (review M1)
    expect(RUN_TIMEOUT_MAX_MS).toBe(86_400_000); // 24 h
  });

  test("T87: the schema accepts timeoutMs and clamps at the boundary — registry receives 1000", async () => {
    h = makeHarness();
    const result = await callDelegate({ agent: "architect", task: "t", timeoutMs: 100 }, makeCtx());

    expect(result.details.state).toBe("running");
    expect(h.api!.registry.get("d-1")?.timeoutMs).toBe(1000); // the applied, clamped value on the record
    h.children[0]!.exit(0); // hygiene: settle before the timer can fire
  });

  test("T88: the timeout verdict names the applied limit, not the elapsed runtime", () => {
    const note = {
      id: "d-2",
      agent: "architect",
      task: "t",
      state: "aborted",
      abortReason: "timeout",
      timeoutMs: 60_000,
      durationMs: 610_000, // includes queue wait — must not appear (durationMs is request-time based)
      answer: "",
    } as DelegationNote;
    expect(notificationVerdict(note)).toBe("Delegation d-2 (architect) timed out (limit 1m00s) and was aborted.");

    // a user abort still renders the plain verdict (no marker, no limit)
    const userAbort = { id: "d-3", agent: "architect", task: "t", state: "aborted", durationMs: 5000, answer: "" } as DelegationNote;
    expect(notificationVerdict(userAbort)).toBe("Delegation d-3 (architect) aborted in 5s.");
  });

  test("T90: the blocking result names the timeout", async () => {
    h = makeHarness();
    // timeoutMs 1000 is applied verbatim → the limit renders "1s"; the "1m00s" zero-pad shape is
    // pinned exactly by T88 (a 60 s limit would cost a 60 s real wait here — the row's intent is
    // that the blocking result names the timeout, which this drives end-to-end).
    const pending = callDelegate({ agent: "architect", task: "t", background: false, timeoutMs: 1000 }, makeCtx("print"));
    await drainTimeout(); // expiry aborts the child through the kill path
    const result = await pending;

    expect(contentOf(result)).toContain("timed out (limit 1s) and was aborted");
    expect(result.details.exitCode).toBeNull(); // R5's aborted shape, no exit code
  }, 20_000);

  test("T91 (delegate side): the no-automatic-timeout claims are gone; the param describes the real semantics", () => {
    h = makeHarness();
    const tool = h.tools.get("delegate")!;
    const params = tool.parameters as { properties: Record<string, { description?: string }> };

    expect(String(tool.description)).not.toContain("no automatic per-run timeout");
    expect(String(tool.description)).toContain("timeoutMs");
    expect(params.properties.background?.description ?? "").not.toContain("no automatic per-run timeout");
    const timeoutDescription = params.properties.timeoutMs?.description ?? "";
    expect(timeoutDescription).toContain("1000 ms"); // the floor
    expect(timeoutDescription).toContain("86400000"); // the cap
    expect(timeoutDescription).toContain("SIGTERM"); // the kill path
    expect(timeoutDescription).toContain("spawn"); // the clock starts at spawn, queue wait does not count
  });
});

// ------------------------------------------------------------------ T92–T100: burst batching (deferral pkg P3)

/** Drain past an injected batch window (the fixtures inject small windows; 0 ms is legal too). */
const drainBatchWindow = () => new Promise((resolve) => setTimeout(resolve, 250));

/** Exit every named child in the same synchronous stack (a "same-tick burst"). */
function burst(children: FakeChild[], code = 0): void {
  for (const child of children) {
    child.write(`${assistantEnd("answer")}\n`);
    child.exit(code);
  }
}

function sentIds(message: Record<string, unknown>): string[] {
  const details = message.details as Record<string, unknown>;
  if (details.batched) return (details.notes as Array<{ id: string }>).map((note) => note.id);
  return [details.id as string];
}

describe("T92–T100 — burst batching on the notification wire (deferral pkg P3)", () => {
  test("T92 (PIN): an isolated completion behaves exactly as v1 — lead sent immediately, no batch flag", async () => {
    h = makeHarness();
    await callDelegate({ agent: "architect", task: "t" }, makeCtx());
    h.children[0]!.write(`${assistantEnd("solo answer")}\n`);
    h.children[0]!.exit(0);

    expect(h.sent).toHaveLength(1); // zero added latency — the lead does not wait for the window
    const { message, options } = h.sent[0]!;
    expect(message.customType).toBe("delegation-result");
    expect(String(message.content)).toContain("completed");
    expect(String(message.content)).toContain("solo answer");
    expect(message.display).toBe(true);
    expect((message.details as Record<string, unknown>).batched).toBeUndefined();
    expect((message.details as Record<string, unknown>).id).toBe("d-1");
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  test("T93: a second same-tick completion is held, then flushed as a normal single card", async () => {
    h = makeHarness("tui", { batchWindowMs: 100 });
    await callDelegate({ agent: "architect", task: "one" }, makeCtx(), undefined, "call-1");
    await callDelegate({ agent: "architect", task: "two" }, makeCtx(), undefined, "call-2");
    burst(h.children);

    expect(h.sent).toHaveLength(1); // the lead; the second arrival is held inside the window

    await drainBatchWindow(); // window expiry flushes the held note

    expect(h.sent).toHaveLength(2);
    const second = h.sent[1]!.message;
    expect((second.details as Record<string, unknown>).batched).toBeUndefined(); // a flush of one = a normal card
    expect((second.details as Record<string, unknown>).id).toBe("d-2");
    expect(String(second.content)).toContain("completed");
  });

  test("T94: a three-note burst collapses to lead + one batched message in settle order", async () => {
    h = makeHarness("tui", { batchWindowMs: 100 });
    for (let i = 1; i <= 3; i++) await callDelegate({ agent: "architect", task: `t${i}` }, makeCtx(), undefined, `call-${i}`);
    burst(h.children);

    expect(h.sent).toHaveLength(1);

    await drainBatchWindow();

    expect(h.sent).toHaveLength(2);
    const batch = h.sent[1]!.message;
    expect((batch.details as Record<string, unknown>).batched).toBe(true);
    expect(sentIds(batch)).toEqual(["d-2", "d-3"]); // settle order, never the lead again
    expect(String(batch.content)).toContain("———"); // the card divider
  });

  test("T95: a full 6-card batch never exceeds 8 KB — every card capped with a drop marker", async () => {
    h = makeHarness(); // default window (2000 ms) — the capacity flush lands synchronously
    for (let i = 1; i <= 7; i++) await callDelegate({ agent: "architect", task: `t${i}` }, makeCtx(), undefined, `call-${i}`);
    for (const child of h.children) {
      child.write(`${assistantEnd("x".repeat(10 * 1024))}\n`);
      child.exit(0);
    }

    expect(h.sent).toHaveLength(2); // lead + capacity flush of 6 — no window wait needed
    const batch = h.sent[1]!.message;
    const content = String(batch.content);
    expect(content.length).toBeLessThanOrEqual(8192); // T71's whole-message cap, now under batching
    expect((batch.details as Record<string, unknown>).batched).toBe(true);
    expect((batch.details as Record<string, unknown>).notes).toHaveLength(6);
    expect((content.match(/earlier characters dropped/g) ?? []).length).toBe(6); // every card capped
    expect((content.match(/Delegation d-\d+ \(architect\)/g) ?? []).length).toBe(6); // one verdict per card
  });

  test("T96: an 8-note burst costs 3 sends — lead, batch of 6, single tail (capacity flush keeps the window)", async () => {
    h = makeHarness("tui", { batchWindowMs: 100 });
    for (let i = 1; i <= 8; i++) await callDelegate({ agent: "architect", task: `t${i}` }, makeCtx(), undefined, `call-${i}`);
    burst(h.children);

    expect(h.sent).toHaveLength(2); // lead + the capacity flush of 6, synchronously

    await drainBatchWindow(); // the window stayed open through the capacity flush → the tail rides out

    expect(h.sent).toHaveLength(3);
    expect((h.sent[1]!.message.details as Record<string, unknown>).batched).toBe(true);
    expect(sentIds(h.sent[1]!.message)).toHaveLength(6);
    expect((h.sent[2]!.message.details as Record<string, unknown>).batched).toBeUndefined(); // single tail card
    expect((h.sent[2]!.message.details as Record<string, unknown>).id).toBe("d-8");
  });

  test("T97: per-run uniqueness across lead and batches — every id delivered exactly once", async () => {
    h = makeHarness("tui", { batchWindowMs: 100 });
    for (let i = 1; i <= 8; i++) await callDelegate({ agent: "architect", task: `t${i}` }, makeCtx(), undefined, `call-${i}`);
    burst(h.children);
    await drainBatchWindow();

    const ids = h.sent.flatMap((send) => sentIds(send.message as Record<string, unknown>));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8); // R5/T70 uniqueness survives batching (RR6)
  });

  test("T98: shutdown flushes the held batch exactly once, then silence; an empty expiry sends nothing", async () => {
    h = makeHarness("tui", { batchWindowMs: 100 });
    for (let i = 1; i <= 4; i++) await callDelegate({ agent: "architect", task: `t${i}` }, makeCtx(), undefined, `call-${i}`);
    h.children[0]!.exit(0); // lead
    h.children[1]!.exit(0); // held
    h.children[2]!.exit(0); // held (2 cards → the shutdown flush is a real batch)
    expect(h.sent).toHaveLength(1);

    fireSessionShutdown();

    expect(h.sent).toHaveLength(2); // the held batch rode out exactly once
    const flushed = h.sent[1]!.message;
    expect((flushed.details as Record<string, unknown>).batched).toBe(true);
    expect(sentIds(flushed)).toEqual(["d-2", "d-3"]);

    h.children[3]!.exit(0); // further settle after shutdown → the stopped wire drops it
    await drainBatchWindow(); // the window timer was cleaned — no expiry work, no phantom sends
    expect(h.sent).toHaveLength(2);
  });

  test("T98 (continued): a window expiry over an empty buffer sends nothing", async () => {
    h = makeHarness("tui", { batchWindowMs: 100 });
    await callDelegate({ agent: "architect", task: "t" }, makeCtx());
    h.children[0]!.exit(0); // the lead alone

    await drainBatchWindow();

    expect(h.sent).toHaveLength(1); // no empty batch message ever
  });

  test("T99: the renderer styles each batch card by its own state; a details-less message falls back", () => {
    h = makeHarness();
    const renderer = h.renderers.get("delegation-result")!;
    const fgCalls: Array<[string, string]> = [];
    const recordingTheme = {
      fg: (color: string, text: string) => {
        fgCalls.push([color, text]);
        return text;
      },
      bg: (_color: string, text: string) => text,
    };
    const failed = { id: "d-1", agent: "architect", task: "t", state: "failed", spawnError: "spawn ENOENT", answer: "" } as DelegationNote;
    const exited = { id: "d-2", agent: "architect", task: "t", state: "completed", exitCode: 1, answer: "" } as DelegationNote;
    const aborted = { id: "d-3", agent: "architect", task: "t", state: "aborted", answer: "" } as DelegationNote;
    const clean = { id: "d-4", agent: "architect", task: "t", state: "completed", exitCode: 0, answer: "fine" } as DelegationNote;
    const cards = [failed, exited, aborted, clean];

    const component = renderer(
      {
        customType: "delegation-result",
        content: cards.map((card) => notificationVerdict(card)).join("\n\n———\n\n"),
        display: true,
        details: { batched: true, notes: cards },
      },
      { expanded: false, outputPad: 0 },
      recordingTheme,
    ) as { render(width: number): string[] };

    expect(component).toBeDefined();
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Delegation d-1 (architect) failed to start");
    expect(rendered).toContain("Delegation d-2 (architect) exited 1");
    expect(rendered).toContain("Delegation d-3 (architect) aborted");
    expect(rendered).toContain("Delegation d-4 (architect) completed");
    // the single-path classification, per card: failed AND exited-N → error; aborted → warning; clean → success
    expect(fgCalls.map(([color]) => color)).toEqual(["error", "error", "warning", "success"]);

    // fallback: a message without batch details renders the plain body box (single path)
    fgCalls.length = 0;
    const plain = renderer(
      { customType: "delegation-result", content: "Delegation d-9 (architect) completed.\nbody", display: true, details: { id: "d-9" } },
      { expanded: false, outputPad: 0 },
      recordingTheme,
    ) as { render(width: number): string[] };
    expect(plain.render(80).join("\n")).toContain("body");
    expect(fgCalls.map(([color]) => color)).toEqual(["success"]);
  });

  test("T100: dep overrides — batchWindowMs 0 batches same-tick arrivals; batchMaxCards 2 splits a 5-burst", async () => {
    h = makeHarness("tui", { batchWindowMs: 0, batchMaxCards: 2 });
    for (let i = 1; i <= 5; i++) await callDelegate({ agent: "architect", task: `t${i}` }, makeCtx(), undefined, `call-${i}`);
    burst(h.children); // all five inside the same synchronous stack — a 0 ms window still holds them

    expect(h.sent).toHaveLength(3); // lead + 2 + 2
    expect((h.sent[0]!.message.details as Record<string, unknown>).batched).toBeUndefined();
    expect(sentIds(h.sent[1]!.message)).toEqual(["d-2", "d-3"]);
    expect((h.sent[1]!.message.details as Record<string, unknown>).batched).toBe(true);
    expect(sentIds(h.sent[2]!.message)).toEqual(["d-4", "d-5"]);

    await drainBatchWindow(); // the 0 ms expiry over an empty buffer sends nothing
    expect(h.sent).toHaveLength(3);
  });
});
