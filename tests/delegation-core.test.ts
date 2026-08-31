/**
 * Unit tests for the delegation pure core (plan §2 R11 module map, rows 8–22 + T53–T56 of
 * docs/plans/2026-interactive-subagent-delegation.tests.md).
 *
 * Everything here is hermetic by construction: the module under test imports nothing from
 * node, spawns nothing, and never reads the wall clock — `now`, pid liveness, file listings
 * and mtimes are all parameters (flake conventions, tests doc header).
 */

import { describe, expect, test } from "bun:test";
import {
  type ChildEvent,
  type AdmissionCaps,
  MAX_ACTIVITY_LEN,
  type LogDirEntry,
  type LogRunFile,
  admitRequest,
  allocateRunId,
  applyLiveUsage,
  applyUsage,
  classifyFromLogDir,
  deriveActivity,
  elideTeeStream,
  emptyAdmission,
  emptyUsage,
  extractAnswer,
  parseChildEvent,
  pruneLogFiles,
  releaseRun,
  renderDelegationStatus,
  type DelegationStatusRun,
} from "../extensions/subagent/delegation-core.ts";

/** Fixed epoch so nothing in this suite touches the clock. */
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** An assistant message_end line, the event shape pi's `--mode json` stream emits. */
function assistantEnd(text: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      ...(usage ? { usage } : {}),
    },
  });
}

function parse(line: string) {
  const event = parseChildEvent(line);
  expect(event).toBeDefined();
  return event!;
}

describe("parseChildEvent (rows 8–10)", () => {
  test("row 8: session header line parses", () => {
    const event = parse('{"type":"session","version":3,"id":"abc","cwd":"/p"}');
    expect(event.type).toBe("session");
    expect(event.id).toBe("abc");
    expect(event.cwd).toBe("/p");
  });

  test("row 9: message_end with usage parses intact", () => {
    const event = parse(
      assistantEnd("hi", {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        cost: { total: 0.01 },
        totalTokens: 99,
      }),
    );
    expect(event.type).toBe("message_end");
    expect(event.message?.role).toBe("assistant");
    expect(event.message?.usage?.input).toBe(10);
    expect(event.message?.usage?.output).toBe(2);
    expect(event.message?.usage?.cacheRead).toBe(3);
    expect(event.message?.usage?.cacheWrite).toBe(1);
    expect(event.message?.usage?.cost?.total).toBe(0.01);
    expect(event.message?.usage?.totalTokens).toBe(99);
  });

  test("row 10: blank/garbage lines return undefined, never throw", () => {
    expect(parseChildEvent("")).toBeUndefined();
    expect(parseChildEvent("Segmentation fault")).toBeUndefined();
    expect(parseChildEvent("{oops")).toBeUndefined();
  });
});

describe("applyUsage (rows 11–13)", () => {
  test("row 11: usage accumulator bumps turns + counters", () => {
    const acc = emptyUsage();
    const event = parse(
      assistantEnd("working", {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        cost: { total: 0.01 },
        totalTokens: 99,
      }),
    );
    applyUsage(acc, event);
    expect(acc.input).toBe(10);
    expect(acc.output).toBe(2);
    expect(acc.cacheRead).toBe(3);
    expect(acc.cacheWrite).toBe(1);
    expect(acc.cost).toBe(0.01);
    expect(acc.contextTokens).toBe(99);
    expect(acc.turns).toBe(1);
  });

  test("row 12: zero-usage assistant end still bumps turns", () => {
    const acc = emptyUsage();
    applyUsage(acc, parse(assistantEnd("no usage block")));
    expect(acc.turns).toBe(1);
    expect(acc.input).toBe(0);
    expect(acc.output).toBe(0);
    expect(acc.cacheRead).toBe(0);
    expect(acc.cacheWrite).toBe(0);
    expect(acc.cost).toBe(0);
    expect(acc.contextTokens).toBe(0);
    expect(Number.isNaN(acc.input)).toBe(false);
    expect(Number.isNaN(acc.turns)).toBe(false);
  });

  test("row 13: non-assistant message_end touches nothing", () => {
    for (const role of ["tool", "user"]) {
      const acc = emptyUsage();
      const before = { ...acc };
      applyUsage(acc, parse(JSON.stringify({ type: "message_end", message: { role, content: [] } })));
      expect(acc).toEqual(before);
    }
  });
});

describe("classifyFromLogDir (rows 14–17)", () => {
  function runHeader(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "run",
      runId: "d-1",
      sessionId: "s1",
      agent: "architect",
      task: "do the thing",
      pid: 4242,
      startedAt: 1000,
      ...overrides,
    });
  }

  test("row 14: header present, no exit line, pid dead → lost with agent/task/startedAt from header", () => {
    const file: LogRunFile = {
      id: "d-1",
      lines: [runHeader(), '{"type":"session","version":3,"id":"child"}'],
    };
    const summaries = classifyFromLogDir([file], () => false);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].state).toBe("lost");
    expect(summaries[0].agent).toBe("architect");
    expect(summaries[0].task).toBe("do the thing");
    expect(summaries[0].startedAt).toBe(1000);
  });

  test("row 15: exit line present → completed regardless of session receipts or pid", () => {
    const file: LogRunFile = {
      id: "d-1",
      lines: [runHeader(), '{"type":"session","version":3,"id":"child"}', '{"type":"exit","exitCode":3,"endedAt":2000}'],
    };
    const summaries = classifyFromLogDir([file], () => true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].state).toBe("completed");
    expect(summaries[0].exitCode).toBe(3);
  });

  test("row 16: spawn-failed run is failed, not lost", () => {
    const file: LogRunFile = {
      id: "d-1",
      lines: [runHeader(), '{"type":"spawnError","error":"spawn ENOENT"}'],
    };
    const summaries = classifyFromLogDir([file], () => false);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].state).toBe("failed");
    expect(summaries[0].spawnError).toBe("spawn ENOENT");
  });

  test("row 17: empty log dir → no orphans", () => {
    expect(classifyFromLogDir([], () => true)).toEqual([]);
  });

  test("header without exit and pid alive → still running", () => {
    const file: LogRunFile = { id: "d-1", lines: [runHeader()] };
    const summaries = classifyFromLogDir([file], (pid) => pid === 4242);
    expect(summaries[0].state).toBe("running");
  });

  test("file with no run header at all is lost with only its id", () => {
    const file: LogRunFile = { id: "d-9", lines: ["garbage", '{"type":"session","version":3}'] };
    const summaries = classifyFromLogDir([file], () => true);
    expect(summaries).toEqual([{ id: "d-9", state: "lost" }]);
  });
});

describe("renderDelegationStatus (rows 18–21)", () => {
  test("row 18: one running run — label + 1m32s + activity + usage in one line", () => {
    const line = renderDelegationStatus(
      [
        {
          id: "d-1",
          agent: "architect",
          state: "running",
          startedAt: 0,
          activity: "reading files",
          usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.01, contextTokens: 99, turns: 1 },
        },
      ],
      92_000,
    );
    expect(line).toBeDefined();
    expect(line).toContain("d-1 architect");
    expect(line).toContain("1m32s");
    expect(line).toContain("reading files");
    expect(line).toContain("↑10 ↓2");
    expect(line).toContain("ctx:99");
    expect(line?.split("\n")).toHaveLength(1);
  });

  test("row 19: three runs sort by start; queued shows phase not clock", () => {
    const runs: DelegationStatusRun[] = [
      { id: "d-3", agent: "gamma", state: "queued", startedAt: NOW - 1000 },
      { id: "d-1", agent: "alpha", state: "running", startedAt: NOW - 3000 },
      { id: "d-2", agent: "beta", state: "running", startedAt: NOW - 2000 },
    ];
    const lines = renderDelegationStatus(runs, NOW)!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("d-1 alpha");
    expect(lines[0]).toContain("3s");
    expect(lines[1]).toContain("d-2 beta");
    expect(lines[1]).toContain("2s");
    expect(lines[2]).toBe("d-3 gamma — queued");
    expect(lines[2]).not.toContain("1s");
  });

  test("row 20: exited/orphaned phases render distinctly", () => {
    const lines = renderDelegationStatus(
      [
        { id: "d-1", agent: "architect", state: "completed", startedAt: NOW - 5000, exitCode: 1 },
        { id: "d-2", agent: "architect", state: "lost", startedAt: NOW - 5000 },
      ],
      NOW,
    )!.split("\n");
    expect(lines[0]).toContain("exited 1");
    expect(lines[1]).toContain("lost");
  });

  test("row 21: empty status renders undefined", () => {
    expect(renderDelegationStatus([], NOW)).toBeUndefined();
  });
});

describe("admission policy (row 22)", () => {
  const caps: AdmissionCaps = { cap: 2, queueCap: 16 };

  test("cap then FIFO: two admitted, one queued; release admits the queued head", () => {
    let state = emptyAdmission();

    let step = admitRequest(state, "r1", caps);
    state = step.state;
    expect(step.decision).toEqual({ action: "admit" });

    step = admitRequest(state, "r2", caps);
    state = step.state;
    expect(step.decision).toEqual({ action: "admit" });

    step = admitRequest(state, "r3", caps);
    state = step.state;
    expect(step.decision).toEqual({ action: "queue", queuePosition: 1 });

    const release = releaseRun(state, "r1", caps);
    expect(release.admitted).toBe("r3");
    expect(release.state.running).toEqual(["r2", "r3"]);
    expect(release.state.queue).toEqual([]);
  });

  test("queue cap rejects loudly once full", () => {
    const tight: AdmissionCaps = { cap: 1, queueCap: 1 };
    let state = emptyAdmission();
    state = admitRequest(state, "r1", tight).state;
    state = admitRequest(state, "r2", tight).state;
    const step = admitRequest(state, "r3", tight);
    expect(step.decision.action).toBe("reject");
    expect(step.decision.action === "reject" ? step.decision.reason : "").toContain("full");
    expect(step.state).toBe(state);
  });
});

describe("allocateRunId (T53)", () => {
  test("empty log dir → d-1", () => {
    expect(allocateRunId([])).toBe("d-1");
  });

  test("d-1,d-3 present → next-free d-4 (never the gap d-2)", () => {
    expect(allocateRunId(["d-1.jsonl", "d-3.jsonl"])).toBe("d-4");
    expect(allocateRunId(["d-1.jsonl", "d-3.jsonl"])).not.toBe("d-2");
  });

  test("existing file at the chosen name → skip to the next free id", () => {
    const exists = (id: string) => id === "d-4";
    expect(allocateRunId(["d-1.jsonl", "d-3.jsonl"], exists)).toBe("d-5");
  });

  test("foreign file names are ignored", () => {
    expect(allocateRunId([".DS_Store", "d-2.jsonl", "notes.txt"])).toBe("d-3");
  });
});

describe("extractAnswer (T54)", () => {
  test("last assistant text wins", () => {
    const events = [
      parse('{"type":"session","version":3,"id":"s"}'),
      parse(assistantEnd("first draft")),
      parse(assistantEnd("final answer")),
    ];
    expect(extractAnswer(events, 0)).toEqual({ kind: "text", text: "final answer" });
  });

  test("zero agent events + exit 0 → silent-JSON variant marker", () => {
    const events = [parse('{"type":"session","version":3,"id":"s"}')];
    const answer = extractAnswer(events, 0);
    expect(answer.kind).toBe("silent");
    expect(answer.kind === "silent" ? answer.reason : "").toContain("silent-JSON");
  });

  test("no session header + exit 0 is not the silent variant (non-JSON stdout)", () => {
    expect(extractAnswer([], 0)).toEqual({ kind: "text", text: "" });
  });

  test("non-zero exit without assistant text is a plain empty tail, not silent", () => {
    const events = [parse('{"type":"session","version":3,"id":"s"}')];
    expect(extractAnswer(events, 2)).toEqual({ kind: "text", text: "" });
  });
});

describe("pruneLogFiles (T55)", () => {
  test("older than 14 days deleted, young kept, oldest-first delete order", () => {
    const files: LogDirEntry[] = [
      { name: "d-1.jsonl", mtimeMs: NOW - 20 * DAY },
      { name: "d-2.jsonl", mtimeMs: NOW - 1 * DAY },
      { name: "d-3.jsonl", mtimeMs: NOW - 15 * DAY },
    ];
    const plan = pruneLogFiles(files, NOW);
    expect(plan.delete).toEqual(["d-1.jsonl", "d-3.jsonl"]);
    expect(plan.keep).toEqual(["d-2.jsonl"]);
  });

  test("exactly 14 days old is kept (prune is strictly older-than)", () => {
    const files: LogDirEntry[] = [{ name: "d-1.jsonl", mtimeMs: NOW - 14 * DAY }];
    expect(pruneLogFiles(files, NOW).keep).toEqual(["d-1.jsonl"]);
  });

  test("dir cap trims the oldest files first", () => {
    const files: LogDirEntry[] = [
      { name: "d-5.jsonl", mtimeMs: NOW - 5 * DAY },
      { name: "d-2.jsonl", mtimeMs: NOW - 2 * DAY },
      { name: "d-4.jsonl", mtimeMs: NOW - 4 * DAY },
      { name: "d-1.jsonl", mtimeMs: NOW - 1 * DAY },
      { name: "d-3.jsonl", mtimeMs: NOW - 3 * DAY },
    ];
    const plan = pruneLogFiles(files, NOW, { cap: 2 });
    expect(plan.keep).toEqual(["d-2.jsonl", "d-1.jsonl"]);
    expect(plan.delete).toEqual(["d-5.jsonl", "d-4.jsonl", "d-3.jsonl"]);
  });

  test("empty dir → nothing to do", () => {
    expect(pruneLogFiles([], NOW)).toEqual({ delete: [], keep: [] });
  });
});

describe("elideTeeStream (T56)", () => {
  const header = JSON.stringify({ type: "run", runId: "d-1", agent: "architect", task: "t", pid: 7, startedAt: 5 });
  const lines = Array.from({ length: 20 }, (_, i) =>
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `answer line ${i}` }] } }),
  );
  const stream = lines.join("\n") + "\n";

  test("stream within cap → header + stream verbatim, no marker", () => {
    const out = elideTeeStream(header, stream, stream.length);
    expect(out).toBe(`${header}\n${stream}`);
    expect(out).not.toContain("tee-elided");
  });

  test("stream over cap → header kept, middle elided with marker, tail kept on line boundaries", () => {
    const out = elideTeeStream(header, stream, 200);
    const outLines = out.split("\n");
    expect(outLines[0]).toBe(header);

    const marker = parseChildEvent(outLines[1]);
    expect(marker?.type).toBe("tee-elided");
    const dropped = marker?.droppedBytes;
    expect(typeof dropped).toBe("number");
    expect(dropped as number).toBeGreaterThan(0);
    expect(dropped as number).toBeLessThan(stream.length);

    // The tail is whole original lines, ending with the last line of the stream.
    const tailLines = outLines.slice(2).filter((l) => l.length > 0);
    expect(tailLines[tailLines.length - 1]).toBe(lines[lines.length - 1]);
    for (const line of tailLines) expect(lines).toContain(line);

    // The kept tail is bounded by the cap (plus at most one snapped partial line).
    const keptChars = tailLines.join("\n").length + 1;
    expect(keptChars).toBeLessThanOrEqual(200 + lines[lines.length - 1].length + 2);

    // The marker accounts for every dropped byte: header + marker + kept = total.
    const markerChars = outLines[1].length + 1;
    expect(dropped).toBe(stream.length - keptChars);
  });
});

// ------------------------------------------------------------------ deriveActivity (R9 activity labels)

describe("deriveActivity (R9: stable keyword labels, constant length)", () => {
  const toolStart = (toolName: string, args?: unknown) => ({
    type: "tool_execution_start",
    toolCallId: "tc-1",
    toolName,
    args,
  });

  test("read with a path arg → 'reading <basename>…'", () => {
    expect(deriveActivity(toolStart("read", { path: "src/helpers/deep/util.ts" }))).toBe("reading util.ts…");
  });

  test("edit and write map to editing/writing with a short target", () => {
    expect(deriveActivity(toolStart("edit", { path: "core.ts" }))).toBe("editing core.ts…");
    expect(deriveActivity(toolStart("write", { path: "/tmp/new-file.ts" }))).toBe("writing new-file.ts…");
  });

  test("bash/powershell → bare 'running…' (command text never leaks)", () => {
    expect(deriveActivity(toolStart("bash", { command: "bun run test --ci" }))).toBe("running…");
  });

  test("search-family tools → 'searching…'", () => {
    for (const tool of ["grep", "find", "ls"]) {
      expect(deriveActivity(toolStart(tool, { pattern: "x", path: "/y" }))).toBe("searching…");
    }
  });

  test("delegate → 'delegating…'", () => {
    expect(deriveActivity(toolStart("delegate"))).toBe("delegating…");
  });

  test("unknown tool → 'using <name>…'", () => {
    expect(deriveActivity(toolStart("sqlite_query"))).toBe("using sqlite_query…");
  });

  test("toolcall_start inside message_update maps like a tool start", () => {
    expect(
      deriveActivity({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", toolName: "read", contentIndex: 0, id: "t1" },
      }),
    ).toBe("reading…");
  });

  test("text_delta → constant 'responding…', raw delta never surfaces", () => {
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "some very long partial jsonl {text}" },
    };
    const label = deriveActivity(event);
    expect(label).toBe("responding…");
    expect(label).not.toContain("jsonl");
  });

  test("thinking_delta → constant 'thinking…'", () => {
    expect(
      deriveActivity({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } }),
    ).toBe("thinking…");
  });

  test("labels stay within MAX_ACTIVITY_LEN", () => {
    const label = deriveActivity(toolStart("read", { path: "a-very-long-directory-name-that-keeps-going/and-a-file.ts" }));
    expect(label!.length).toBeLessThanOrEqual(MAX_ACTIVITY_LEN);
  });

  test("other events → undefined (caller keeps the previous label)", () => {
    expect(deriveActivity({ type: "agent_start" })).toBeUndefined();
    expect(deriveActivity({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 } })).toBeUndefined();
    expect(deriveActivity({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "read", result: {}, isError: false })).toBeUndefined();
  });
});

// ------------------------------------------------------------------ applyLiveUsage (live usage fidelity)

describe("applyLiveUsage (message_update cumulative usage → live view)", () => {
  const msgUpdate = (usage: unknown) => ({ type: "message_update", usage });

  test("mid-turn cumulative input appears in the live view before any message_end", () => {
    const base = emptyUsage();
    const live = applyLiveUsage(base, msgUpdate({ input: 14556, output: 982, cacheRead: 27840, totalTokens: 43378 }));
    expect(live.input).toBe(14556);
    expect(live.output).toBe(982);
    expect(live.cacheRead).toBe(27840);
    expect(live.contextTokens).toBe(43378);
  });

  test("cumulative reports are a floor: smaller later reports never clobber larger ones", () => {
    let live = emptyUsage();
    live = applyLiveUsage(live, msgUpdate({ input: 10000, output: 500 }));
    live = applyLiveUsage(live, msgUpdate({ input: 20, output: 900 }));
    expect(live.input).toBe(10000);
    expect(live.output).toBe(900);
  });

  test("cost folds from the nested cost.total", () => {
    const live = applyLiveUsage(emptyUsage(), msgUpdate({ input: 10, cost: { total: 0.5 } }));
    expect(live.cost).toBeCloseTo(0.5);
  });

  test("turns are never touched by live reports (message_end counts turns, not this)", () => {
    const base = emptyUsage();
    base.turns = 3;
    expect(applyLiveUsage(base, msgUpdate({ input: 1 })).turns).toBe(3);
  });

  test("non-message_update events and usage-less updates return the input unchanged", () => {
    const base = emptyUsage();
    expect(applyLiveUsage(base, { type: "message_end" })).toBe(base);
    expect(applyLiveUsage(base, msgUpdate(undefined))).toBe(base);
    expect(applyLiveUsage(base, msgUpdate("not an object"))).toBe(base);
  });
});

// ------------------------------------------------------------------ T89: timeout rendering (deferral pkg P2)

describe("T89 — renderRunLine renders a timed-out run (deferral pkg P2)", () => {
  test("an aborted run with abortReason 'timeout' renders 'aborted (timeout)' (panel + reconstruction path)", () => {
    const line = renderDelegationStatus(
      [{ id: "d-2", agent: "architect", state: "aborted", abortReason: "timeout", startedAt: NOW - 60_000 }],
      NOW,
    );
    expect(line).toBe("d-2 architect — aborted (timeout)");
  });

  test("a user-aborted run renders plain 'aborted'", () => {
    const line = renderDelegationStatus([{ id: "d-3", agent: "beta", state: "aborted", startedAt: NOW }], NOW);
    expect(line).toBe("d-3 beta — aborted");
  });
});

// ------------------------------------------------------------------ T105: RR5 accounting pin (deferral pkg P4)

describe("T105 — a timed-out run's log classifies lost (RR5 pin, deferral pkg P4)", () => {
  test("header + stream lines, no exit line, pid dead → lost — timeout behaves exactly like abort for accounting", () => {
    const file: LogRunFile = {
      id: "d-7",
      lines: [
        JSON.stringify({
          type: "run", runId: "d-7", agent: "architect", persona: "architect", task: "do the thing",
          argv: ["-p"], cwd: "/p", pid: 4242, startedAt: 1000,
        }),
        assistantEnd("partial answer before the kill"),
        '{"type":"stderr","text":"SIGTERM received"}',
        // NO exit line — abortRun (and therefore the timeout expiry) never writes one (RR5)
      ],
    };
    const summaries = classifyFromLogDir([file], () => false);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.state).toBe("lost"); // the documented consequence — not "fixed", pinned
    expect(summaries[0]!.agent).toBe("architect");
    expect(summaries[0]!.task).toBe("do the thing");
  });
});

describe("deriveActivity target hygiene (R9)", () => {
  const readEvent = (args: unknown): ChildEvent =>
    ({ type: "tool_execution_start", toolName: "read", args }) as unknown as ChildEvent;

  test("keeps path-like targets", () => {
    expect(deriveActivity(readEvent({ path: "/a/b/c.md" }))).toBe("reading c.md…");
    expect(deriveActivity(readEvent({ path: "./src/util.ts" }))).toBe("reading util.ts…");
    expect(deriveActivity(readEvent({ path: "README.md" }))).toBe("reading README.md…");
  });

  test("drops non-path words — a bare word must never become the label", () => {
    expect(deriveActivity(readEvent({ path: "them" }))).toBe("reading…");
    expect(deriveActivity(readEvent({ path: "the settings" }))).toBe("reading…");
    expect(deriveActivity(readEvent({ path: "  " }))).toBe("reading…");
  });
});
