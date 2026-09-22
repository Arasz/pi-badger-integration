/**
 * PKG-5 integration suite — the three requests end-to-end on the merged result.
 *
 * Every test drives the REAL extension factories and the REAL `/delegations` command
 * registration over a temp base log dir with injected deps (spawn, clock, project key);
 * no test reads or writes the real `~/.pi/agent`. The point is cross-package composition,
 * not another unit pass:
 *  - PKG-1 (completion) × PKG-2 (project-local ids): a real run's completion is applied
 *    through pi's whole-argument algorithm, then the completed line runs the real command.
 *  - PKG-2 (per-project namespaces) × PKG-3 (global index/resolve): two sessions share one
 *    base dir and must not see each other's logs; a GUID crosses between them.
 *  - PKG-4 (console capture) × the real rotating file sink.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSink, installConsoleCapture, type ConsoleCapture } from "../../extensions/console-capture/console-capture.ts";
import { GLOBAL_ID_PATTERN } from "../../extensions/subagent/global-id.ts";
import { readIndex } from "../../extensions/subagent/global-index.ts";
import subagent, { AGENTS_DIR, RECONSTRUCTION_ENTRY_TYPE } from "../../extensions/subagent/index.ts";
import { applyArgumentCompletion } from "../helpers/apply-completion.ts";
import { FakeChild } from "../helpers/fake-child.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

const NOW = 1_700_000_000_000;

/** Exactly what a scaffolded persona file holds: frontmatter, then the managed body. */
const SCAFFOLDED_PERSONA = `---
name: architect
description: Architecture specialist. Read-only.
---

# Architect

Produce a blueprint, never an edit.
`;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, any>;
}

interface ToolLike {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<ToolResult>;
}

interface DelegationsCommand {
  getArgumentCompletions(prefix: string): Array<{ value: string; label?: string }> | null;
  handler(args: string, ctx: unknown): Promise<void>;
}

/** One real subagent extension instance over its own project key and a shared base log dir. */
interface Session {
  pi: FakePi;
  baseLogDir: string;
  projectKey: string;
  projectDir: string;
  children: FakeChild[];
  notifications: string[];
  ctx: unknown;
}

const sessions: Session[] = [];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Build one real session: fake pi + injected spawn/clock, temp project dir, pinned key. */
function makeSession(projectKey: string, baseLogDir: string): Session {
  const pi = createFakePi();
  const projectDir = tempDir("aib-integration-project-");
  mkdirSync(join(projectDir, ...AGENTS_DIR), { recursive: true });
  writeFileSync(join(projectDir, ...AGENTS_DIR, "architect.md"), SCAFFOLDED_PERSONA);

  const children: FakeChild[] = [];
  const notifications: string[] = [];
  const spawnFn = (_command: string, _args: string[], _options: { cwd: string }): FakeChild => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };

  subagent(pi as never, {
    spawnFn,
    logDir: baseLogDir,
    projectKey,
    now: () => pi.clock.now,
    escalateAfterMs: 0,
    batchWindowMs: 0,
  });

  const ctx = {
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setWidget: () => {},
      setStatus: () => {},
    },
    mode: "tui", // background delegation: the receipt returns while the child runs
    hasUI: true,
    cwd: projectDir,
    sessionManager: { getSessionId: () => `sess-${projectKey}` },
    model: undefined,
    signal: undefined,
  };

  const session: Session = { pi, baseLogDir, projectKey, projectDir, children, notifications, ctx };
  sessions.push(session);
  return session;
}

afterEach(() => {
  for (const session of sessions.splice(0)) {
    for (const child of session.children) if (!child.exited) child.exit(0);
    for (const handler of session.pi.handlers.get("session_shutdown") ?? []) {
      handler({ type: "session_shutdown", reason: "quit" }, session.ctx);
    }
    rmSync(session.projectDir, { recursive: true, force: true });
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function delegateTool(session: Session): ToolLike {
  return session.pi.tools.get("delegate") as unknown as ToolLike;
}

function delegationsTool(session: Session): ToolLike {
  return session.pi.tools.get("delegations") as unknown as ToolLike;
}

/** Start a real background run through the extension's delegate tool (mode "tui"). */
function startRun(session: Session, task: string, toolCallId: string): Promise<ToolResult> {
  return delegateTool(session).execute(toolCallId, { agent: "architect", task }, undefined, undefined, session.ctx);
}

function fireSessionStart(session: Session): void {
  for (const handler of session.pi.handlers.get("session_start") ?? []) {
    handler({ type: "session_start", reason: "startup" }, session.ctx);
  }
}

/** The runs the session_start handler reconstructed from the session's own project dir. */
function reconstructionRuns(session: Session): Array<{ id: string; logFile?: string }> {
  const entry = session.pi.entries.find((candidate) => candidate.customType === RECONSTRUCTION_ENTRY_TYPE);
  expect(entry).toBeDefined();
  return (entry!.data as { runs: Array<{ id: string; logFile?: string }> }).runs;
}

/** Drive the real `delegations list` action and return both its text and its records. */
async function listDelegations(session: Session): Promise<{ text: string; records: Array<{ id: string; logFile?: string }> }> {
  const result = await delegationsTool(session).execute("tc-list", { action: "list" }, undefined, undefined, session.ctx);
  return {
    text: result.content.map((part) => part.text).join("\n"),
    records: (result.details.records ?? []) as Array<{ id: string; logFile?: string }>,
  };
}

function resolveViaTool(session: Session, id: string): Promise<ToolResult> {
  return delegationsTool(session).execute("tc-resolve", { action: "resolve", id }, undefined, undefined, session.ctx);
}

// ------------------------------------------------------------------ A5.1 completion round-trip

describe("A5.1 — completion round-trip", () => {
  test("completion round-trip: /delegations log + Tab yields the full argument", async () => {
    const base = tempDir("aib-integration-completion-");
    const session = makeSession("proj-a", base);
    const run = await startRun(session, "completion target", "call-1");
    expect(run.details.id).toBe("d-1");

    // The REAL command registration — not the status unit fixture's stand-in.
    const command = session.pi.commands.get("delegations") as unknown as DelegationsCommand;
    const items = command.getArgumentCompletions("log d");
    expect(items).not.toBeNull();
    expect(items!.map((item) => item.value)).toEqual(["log d-1"]);

    // pi's whole-argument splice: the item must carry the verb, not only the id.
    const line = applyArgumentCompletion("/delegations log d", items![0]!);
    expect(line).toBe("/delegations log d-1");
    expect(line).not.toBe("/delegations d-1");

    // Enter on the completed line runs the real command and answers with the run's log.
    // The delegate call already warned that the temp project has no model-groups.json; the
    // command's own answer is the notification under test here.
    session.notifications.length = 0;
    await command.handler("log d-1", session.ctx);
    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0]).toContain(`full log: ${join(base, "projects", "proj-a", "d-1.jsonl")}`);
  });
});

// ------------------------------------------------------------------ A5.2 project isolation

describe("A5.2 — project isolation end-to-end", () => {
  test("project isolation end-to-end: two projects, one base dir, both d-1, no cross-project list leakage", async () => {
    const base = tempDir("aib-integration-isolation-");
    const projectA = makeSession("proj-a", base);
    const projectB = makeSession("proj-b", base);

    const runA = await startRun(projectA, "task from proj-a", "call-a");
    const runB = await startRun(projectB, "task from proj-b", "call-b");

    // Both first runs are d-1: ids restart per project key.
    expect(runA.details.id).toBe("d-1");
    expect(runB.details.id).toBe("d-1");
    expect(runA.details.logFile).toBe(join(base, "projects", "proj-a", "d-1.jsonl"));
    expect(runB.details.logFile).toBe(join(base, "projects", "proj-b", "d-1.jsonl"));
    expect(existsSync(join(base, "projects", "proj-a", "d-1.jsonl"))).toBe(true);
    expect(existsSync(join(base, "projects", "proj-b", "d-1.jsonl"))).toBe(true);

    projectA.children[0]!.exit(0);
    projectB.children[0]!.exit(0);
    fireSessionStart(projectA);
    fireSessionStart(projectB);

    // Reconstruction reads the session's own project dir, never the shared base.
    const runsA = reconstructionRuns(projectA);
    const runsB = reconstructionRuns(projectB);
    expect(runsA.map((summary) => summary.id)).toEqual(["d-1"]);
    expect(runsA[0]!.logFile).toBe(join(base, "projects", "proj-a", "d-1.jsonl"));
    expect(runsB.map((summary) => summary.id)).toEqual(["d-1"]);
    expect(runsB[0]!.logFile).toBe(join(base, "projects", "proj-b", "d-1.jsonl"));

    // List reads the session's own registry; the other project's run is nowhere in it.
    const listA = await listDelegations(projectA);
    expect(listA.records.map((record) => record.id)).toEqual(["d-1"]);
    expect(listA.records[0]!.logFile).toBe(join(base, "projects", "proj-a", "d-1.jsonl"));
    expect(listA.text).toContain("task from proj-a");
    expect(listA.text).not.toContain("task from proj-b");

    const listB = await listDelegations(projectB);
    expect(listB.records.map((record) => record.id)).toEqual(["d-1"]);
    expect(listB.records[0]!.logFile).toBe(join(base, "projects", "proj-b", "d-1.jsonl"));
    expect(listB.text).toContain("task from proj-b");
    expect(listB.text).not.toContain("task from proj-a");
  });
});

// ------------------------------------------------------------------ A5.3 global round-trip

describe("A5.3 — global round-trip", () => {
  test("global round-trip: resolve d-1 -> guid -> resolve guid across projects", async () => {
    const base = tempDir("aib-integration-global-");
    const projectA = makeSession("proj-a", base);
    const projectB = makeSession("proj-b", base);

    const runA = await startRun(projectA, "global target", "call-a");
    expect(runA.details.id).toBe("d-1");
    const globalId = runA.details.globalId as string;
    expect(globalId).toMatch(GLOBAL_ID_PATTERN);
    projectA.children[0]!.exit(0); // settled — the live registry keeps the record

    // resolve d-1 → GUID, answered by the owning project's live registry.
    const local = await resolveViaTool(projectA, "d-1");
    expect(local.details).toMatchObject({ id: "d-1", globalId, projectKey: "proj-a", source: "registry" });
    expect(local.content[0]!.text).toContain(globalId);

    // The same GUID through the OWN project's instance: registry wins over the index.
    const own = await resolveViaTool(projectA, globalId);
    expect(own.details).toMatchObject({ id: "d-1", globalId, projectKey: "proj-a", source: "registry" });

    // Through the other project's instance: no registry record, so the shared index answers
    // with the owning project's key, root and log path.
    const foreign = await resolveViaTool(projectB, globalId);
    expect(foreign.details).toMatchObject({
      id: "d-1",
      globalId,
      projectKey: "proj-a",
      logFile: join(base, "projects", "proj-a", "d-1.jsonl"),
      source: "index",
    });
    expect(foreign.content[0]!.text).toContain("proj-a");

    // The index really holds A's entry — and the foreign answer repeats its root, not B's.
    const entries = readIndex(join(base, "index.jsonl"));
    expect(entries.map((entry) => entry.globalId)).toEqual([globalId]);
    expect(foreign.details.projectRoot).toBe(entries[0]!.projectRoot);
  });
});

// ------------------------------------------------------------------ A5.4 legacy flat logs

describe("A5.4 — legacy flat logs", () => {
  test("legacy flat logs stay invisible to new sessions", async () => {
    const base = tempDir("aib-integration-legacy-");
    const flat = join(base, "d-9.jsonl");
    writeFileSync(
      flat,
      [
        JSON.stringify({ type: "run", runId: "d-9", agent: "architect", task: "legacy run", pid: 4242, startedAt: NOW }),
        JSON.stringify({ type: "exit", exitCode: 0, endedAt: NOW }),
        "",
      ].join("\n"),
    );

    const session = makeSession("proj-a", base);
    fireSessionStart(session);
    // The flat file is not reconstructed: only the project dir is read.
    expect(session.pi.entries.find((entry) => entry.customType === RECONSTRUCTION_ENTRY_TYPE)).toBeUndefined();

    // It neither reserves an id nor feeds the allocator's scan.
    const run = await startRun(session, "new run", "call-1");
    expect(run.details.id).toBe("d-1");
    expect(run.details.logFile).toBe(join(base, "projects", "proj-a", "d-1.jsonl"));

    // resolve never reads the flat file — d-9 is not a run this project has.
    await expect(resolveViaTool(session, "d-9")).rejects.toThrow(/unknown delegation id "d-9"/);

    // list surfaces only this project's run.
    const list = await listDelegations(session);
    expect(list.records.map((record) => record.id)).toEqual(["d-1"]);
    expect(list.text).not.toContain("d-9");
  });
});

// ------------------------------------------------------------------ A5.5 console capture

describe("A5.5 — console capture", () => {
  test("console capture: a leaky extension error never reaches the terminal and the log has it", () => {
    const dir = tempDir("aib-integration-console-");
    const logPath = join(dir, "badger-console.log");

    // The handles a leaky extension would reach: the terminal's console method and stderr.
    // Save the real ones, put recording stand-ins in place, restore them in the finally.
    const terminalLines: unknown[][] = [];
    const stderrChunks: string[] = [];
    const originalConsoleError = console.error;
    const originalStderrWrite = process.stderr.write;
    console.error = (...args: unknown[]) => {
      terminalLines.push(args);
    };
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      // Forward, so a genuine test failure still reaches the runner's output.
      return originalStderrWrite.call(process.stderr, chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;

    let capture: ConsoleCapture | undefined;
    try {
      capture = installConsoleCapture({ env: {}, sink: createFileSink(logPath) });
      expect(capture).toBeDefined();

      console.error("ai-badger: leaky extension error", { detail: 42 });

      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("ai-badger: leaky extension error");
      expect(log).toContain(" error ");
      expect(terminalLines).toEqual([]);
      expect(stderrChunks).toEqual([]);
    } finally {
      capture?.uninstall();
      console.error = originalConsoleError;
      process.stderr.write = originalStderrWrite;
    }

    // Uninstall restored exactly what it captured, and the real handles are back in place.
    expect(console.error).toBe(originalConsoleError);
    expect(process.stderr.write).toBe(originalStderrWrite);
  });
});
