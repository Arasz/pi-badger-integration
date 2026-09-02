/**
 * Model-pin fallback (f: 2026-09-02 — "make the model part fully optional — not fail
 * delegation in any case, fallback to the parent model").
 *
 * The persona `model:` pin used to be a LOUD-failure contract: an unresolvable or
 * unauthenticated pin exited the child 1 and the delegation failed. The d-324 class broke
 * that contract differently — pi's credential-blind alias resolution picked
 * amazon-bedrock for the bare alias `opus`, so a perfectly-formed pin failed at the auth
 * gate ("No API key found for amazon-bedrock", exit 1, with only a session header on
 * stdout — pi emits the header BEFORE resolving auth, so the retry guard is "no PROGRESS
 * event parsed", not "no event at all"). The owner ruling supersedes the loud-failure
 * contract: a pin that cannot START is retried once on the parent model, and the fallback
 * is RECORDED on the note (never silent, never fatal). These tests pin that behavior at
 * every seam:
 *
 *   - `fallbackArgsFor` (tool layer): derives the fallback argv from the primary argv.
 *   - `isModelStartupFailure` (runner): the stderr signature that arms the retry.
 *   - `DelegationRunner`: the one retry, its guards, and the recorded reason.
 *   - `DelegationRegistry`: the StartRequest pass-through.
 *   - `notificationVerdict` (card): the fallback clause on the verdict line.
 */

import { describe, expect, test } from "bun:test";
import {
  DelegationRunner,
  isModelStartupFailure,
  type DelegationNote,
  type LogSinkFactory,
  type RunRequest,
  type RunnerDeps,
  type SpawnFn,
} from "../extensions/subagent/delegation-runner.ts";
import { DelegationRegistry, type StartRequest } from "../extensions/subagent/delegation-registry.ts";
import { fallbackArgsFor, notificationVerdict, type Persona } from "../extensions/subagent/index.ts";
import { FakeChild } from "./helpers/fake-child.ts";

const NOW = 1_700_000_000_000;

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: "code-reviewer",
    description: "Review gate",
    systemPrompt: "# Code Reviewer\n",
    filePath: "/tmp/code-reviewer.md",
    ...overrides,
  };
}

// ------------------------------------------------------------------ fallbackArgsFor

describe("fallbackArgsFor", () => {
  const PINNED = ["-p", "--mode", "json", "--model", "opus", "--", "review the diff"];

  test("swaps the persona pin for the parent model", () => {
    const fallback = fallbackArgsFor(PINNED, persona({ model: "opus" }), "openrouter/z-ai/glm-5.3-flash");
    expect(fallback).toEqual(["-p", "--mode", "json", "--model", "openrouter/z-ai/glm-5.3-flash", "--", "review the diff"]);
  });

  test("drops the --model pair when no parent model is known", () => {
    const fallback = fallbackArgsFor(PINNED, persona({ model: "opus" }), undefined);
    expect(fallback).toEqual(["-p", "--mode", "json", "--", "review the diff"]);
  });

  test("returns undefined when the persona pins no model", () => {
    const unpinned = ["-p", "--mode", "json", "--model", "openrouter/z-ai/glm-5.3-flash", "--", "t"];
    expect(fallbackArgsFor(unpinned, persona(), "openrouter/z-ai/glm-5.3-flash")).toBeUndefined();
  });

  test("returns undefined when the pinned value is not the argv's --model value", () => {
    // Defensive: the tool layer is the only argv builder, so this "should not happen" —
    // the helper must stay pure and refuse to guess anyway.
    expect(fallbackArgsFor(PINNED, persona({ model: "sonnet" }), "openrouter/z-ai/glm-5.3-flash")).toBeUndefined();
  });

  test("never mutates the primary argv", () => {
    const primary = [...PINNED];
    fallbackArgsFor(primary, persona({ model: "opus" }), "openrouter/z-ai/glm-5.3-flash");
    expect(primary).toEqual(PINNED);
  });
});

// ------------------------------------------------------------------ failure signature

describe("isModelStartupFailure", () => {
  test("matches the observed pi startup model failures", () => {
    // The d-324 stderr, verbatim shape.
    expect(isModelStartupFailure("No API key found for amazon-bedrock.\n\nUse /login to log into a provider via OAuth or API key.")).toBe(true);
    expect(isModelStartupFailure('Error: Model "opus7" not found')).toBe(true);
    expect(isModelStartupFailure('Model "opus" is ambiguous across providers: amazon-bedrock/…, anthropic/…')).toBe(true);
    expect(isModelStartupFailure('Unknown provider "opuss". Use --list-models to see available providers/models.')).toBe(true);
    expect(isModelStartupFailure("No models available. Check your installation or add models to models.json.")).toBe(true);
  });

  test("rejects ordinary task stderr", () => {
    expect(isModelStartupFailure("panic: something else went wrong\n    at review.ts:1")).toBe(false);
    expect(isModelStartupFailure("")).toBe(false);
  });
});

// ------------------------------------------------------------------ runner retry

const MODEL_FAILURE_STDERR = "No API key found for amazon-bedrock.\n\nUse /login to log into a provider via OAuth or API key.";

/** pi emits a session header on stdout BEFORE resolving auth — the d-324 log proves it. */
const sessionHeader = { type: "session", version: 3, id: "child-session", cwd: "/p" };

const PRIMARY_ARGS = ["-p", "--mode", "json", "--no-session", "--model", "opus", "--append-system-prompt", "# R\n", "--", "review"];
const FALLBACK_ARGS = [
  "-p",
  "--mode",
  "json",
  "--no-session",
  "--model",
  "openrouter/z-ai/glm-5.3-flash",
  "--append-system-prompt",
  "# R\n",
  "--",
  "review",
];

function assistantEnd(text: string): Record<string, unknown> {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

interface Harness {
  runner: DelegationRunner;
  children: FakeChild[];
  spawnedArgv: string[][];
  notes: DelegationNote[];
}

function makeRunner(overrides: RunnerDeps = {}): Harness {
  const children: FakeChild[] = [];
  const spawnedArgv: string[][] = [];
  const notes: DelegationNote[] = [];
  const spawnFn: SpawnFn = (_command, args) => {
    spawnedArgv.push(args);
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const runner = new DelegationRunner({
    escalateAfterMs: 0,
    now: () => NOW,
    spawnFn,
    notifyComplete: (note) => notes.push(note),
    ...overrides,
  });
  return { runner, children, spawnedArgv, notes };
}

function makeLogSink(): { logs: Map<string, string[]>; logSink: LogSinkFactory } {
  const logs = new Map<string, string[]>();
  const logSink: LogSinkFactory = ({ id }) => ({
    logFile: `/tmp/delegation-logs/${id}.jsonl`,
    appendLine: (line) => {
      const list = logs.get(id) ?? [];
      list.push(line);
      logs.set(id, list);
    },
  });
  return { logs, logSink };
}

function retryRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    id: "d-1",
    agent: "code-reviewer",
    task: "review",
    args: PRIMARY_ARGS,
    cwd: "/p",
    startedAt: NOW,
    ...overrides,
  };
}

describe("DelegationRunner — model startup fallback retry", () => {
  test("retries once on a model startup failure and completes on the fallback argv", async () => {
    const { logs, logSink } = makeLogSink();
    const h = makeRunner({ logSink });
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    // Attempt 1: the d-324 shape — a session header, then the model stderr, exit 1. The
    // session header is a parsed event but NOT a progress event; the retry must still fire.
    h.children[0]!.emitEvent(sessionHeader);
    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.exit(1, null);

    // The retry spawned with the fallback argv.
    expect(h.children).toHaveLength(2);
    expect(h.spawnedArgv[1]).toEqual(FALLBACK_ARGS);

    // Attempt 2 runs to completion.
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(record.state).toBe("completed");
    expect(record.exitCode).toBe(0);
    expect(record.modelFallback).toContain("opus");
    expect(record.modelFallback).toContain("amazon-bedrock");

    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.state).toBe("completed");
    expect(h.notes[0]!.exitCode).toBe(0);
    expect(h.notes[0]!.answer).toBe("ship it");
    expect(h.notes[0]!.modelFallback).toBe(record.modelFallback);

    // Exactly one child exit line and one run header — the retry is the same run, not a
    // second one (reconstruction and accounting read one header per run id).
    const lines = (logs.get("d-1") ?? []).map((line) => JSON.parse(line) as { type: string; text?: string });
    expect(lines.filter((l) => l.type === "run")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "exit")).toHaveLength(1);
    expect(lines.some((l) => l.type === "stderr" && (l.text ?? "").includes("model"))).toBe(true);
  });

  test("does not retry once a progress event was parsed (the child started working)", async () => {
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;
    h.children[0]!.emitEvent(assistantEnd("partial"));
    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.exit(1, null);

    const record = await done;
    expect(h.children).toHaveLength(1);
    expect(record.state).toBe("completed");
    expect(record.exitCode).toBe(1);
    expect(record.modelFallback).toBeUndefined();
  });

  test("does not retry when the stderr is not a model startup failure", async () => {
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;
    h.children[0]!.stderrWrite("panic: unrelated explosion");
    h.children[0]!.exit(1, null);

    await done;
    expect(h.children).toHaveLength(1);
  });

  test("does not retry without fallbackArgs", async () => {
    const h = makeRunner();
    const done = h.runner.run(retryRequest()).done;
    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.exit(1, null);

    await done;
    expect(h.children).toHaveLength(1);
  });

  test("does not retry when the fallback argv equals the primary argv", async () => {
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: PRIMARY_ARGS })).done;
    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.exit(1, null);

    await done;
    expect(h.children).toHaveLength(1);
  });

  test("retries at most once — a failing fallback settles the run", async () => {
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;
    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.exit(1, null);
    h.children[1]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[1]!.exit(1, null);

    const record = await done;
    expect(h.children).toHaveLength(2);
    expect(record.state).toBe("completed");
    expect(record.exitCode).toBe(1);
    // The first attempt's stderr still rides the failure note (row 32 discipline).
    expect(h.notes[0]!.stderrTail).toContain("amazon-bedrock");
  });

  test("a 'Model not found' pin failure also retries", async () => {
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;
    h.children[0]!.stderrWrite('Error: Model "opus7" not found');
    h.children[0]!.exit(1, null);
    h.children[1]!.emitEvent(assistantEnd("ok"));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(h.children).toHaveLength(2);
    expect(record.exitCode).toBe(0);
  });
});

// ------------------------------------------------------------------ registry pass-through

describe("DelegationRegistry — fallbackArgs pass-through", () => {
  test("StartRequest.fallbackArgs reaches the runner's retry", async () => {
    const children: FakeChild[] = [];
    const spawnedArgv: string[][] = [];
    const { logSink } = makeLogSink();
    const registry = new DelegationRegistry({
      escalateAfterMs: 0,
      now: () => NOW,
      spawnFn: (_command, args) => {
        spawnedArgv.push(args);
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      logSink,
    });
    const request: StartRequest = {
      agent: "code-reviewer",
      task: "review",
      args: PRIMARY_ARGS,
      fallbackArgs: FALLBACK_ARGS,
      cwd: "/p",
    };
    const outcome = await registry.start(request);
    expect(outcome.ok).toBe(true);
    children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    children[0]!.exit(1, null);
    children[1]!.emitEvent(assistantEnd("ok"));
    children[1]!.exit(0, null);
    if (outcome.ok) await outcome.done;

    expect(spawnedArgv[1]).toEqual(FALLBACK_ARGS);
  });
});

// ------------------------------------------------------------------ card verdict

describe("notificationVerdict — model fallback clause", () => {
  test("appends the fallback reason to the completed verdict", () => {
    const note = {
      id: "d-1",
      agent: "code-reviewer",
      task: "review",
      state: "completed" as const,
      answer: "ship it",
      modelFallback: "--model opus was rejected (No API key found for amazon-bedrock) — retried on --model openrouter/z-ai/glm-5.3-flash",
    };
    const verdict = notificationVerdict(note);
    expect(verdict).toContain("completed");
    expect(verdict).toContain("--model opus was rejected");
  });

  test("no clause when no fallback fired", () => {
    const note = { id: "d-1", agent: "code-reviewer", task: "review", state: "completed" as const, answer: "ok" };
    expect(notificationVerdict(note)).not.toContain("retried");
  });
});
