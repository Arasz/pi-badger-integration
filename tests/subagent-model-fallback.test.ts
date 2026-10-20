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
 *
 * The SAME retry also covers the billing class: a child that ends on a provider 402
 * (out of credits) is an API error inside a LIVE child — the 402 arrives in the child's
 * stdout event stream (an assistant turn with `stopReason: "error"`), the child exits 0,
 * and its stderr says nothing about it. The startup arm cannot see that (it reads stderr
 * and demands exit 1), so the billing arm reads the child's last assistant turn instead.
 * The block at the end of this file pins that arm at every seam it can break.
 */

import { describe, expect, test } from "bun:test";
import {
  DelegationRunner,
  isBillingExhaustionFailure,
  isModelStartupFailure,
  type DelegationNote,
  type LogSinkFactory,
  type RunRequest,
  type RunnerDeps,
  type SpawnFn,
} from "../extensions/subagent/delegation-runner.ts";
import { DelegationRegistry, type StartRequest } from "../extensions/subagent/delegation-registry.ts";
import { classifyFailure } from "../extensions/router-fallback/router-fallback-core.ts";
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
  // f: 2026-09-29 (M8/H4 shape gate): these mechanics exercise ADMITTED pins — a bare alias
  // like `opus` never reaches argv anymore (refused at argv-build; that path and its
  // fall-through are pinned in subagent-model-level.test.ts's shape-gate block).
  const PIN = "openrouter/custom/pinned";
  const PINNED = ["-p", "--mode", "json", "--model", PIN, "--", "review the diff"];

  test("swaps the persona pin for the parent model", () => {
    const fallback = fallbackArgsFor(PINNED, persona({ model: PIN }), "openrouter/z-ai/glm-5.3-flash");
    expect(fallback).toEqual(["-p", "--mode", "json", "--model", "openrouter/z-ai/glm-5.3-flash", "--", "review the diff"]);
  });

  test("drops the --model pair when no parent model is known", () => {
    const fallback = fallbackArgsFor(PINNED, persona({ model: PIN }), undefined);
    expect(fallback).toEqual(["-p", "--mode", "json", "--", "review the diff"]);
  });

  test("returns undefined when the persona pins no model", () => {
    const unpinned = ["-p", "--mode", "json", "--model", "openrouter/z-ai/glm-5.3-flash", "--", "t"];
    expect(fallbackArgsFor(unpinned, persona(), "openrouter/z-ai/glm-5.3-flash")).toBeUndefined();
  });

  test("returns undefined when the pinned value is not the argv's --model value", () => {
    // Defensive: the tool layer is the only argv builder, so this "should not happen" —
    // the helper must stay pure and refuse to guess anyway.
    expect(fallbackArgsFor(PINNED, persona({ model: "openrouter/other/model" }), "openrouter/z-ai/glm-5.3-flash")).toBeUndefined();
  });

  test("never mutates the primary argv", () => {
    const primary = [...PINNED];
    fallbackArgsFor(primary, persona({ model: PIN }), "openrouter/z-ai/glm-5.3-flash");
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

// ------------------------------------------------------------------ billing (402) retry

/** The provider 402, folded into the child's assistant turn — the shape pi's
 * `formatProviderError` produces ("<status>: <body>"). */
const PAYMENT_REQUIRED_BODY =
  '402: {"message":"This request requires more credits, or fewer max_tokens.","code":402,' +
  '"metadata":{"limit_source":"openrouter_credits"}}';

/** The provider-prefixed shape ("<provider> (<status>): <body>"). */
const PROVIDER_PREFIXED_402 = 'OpenRouter (402): {"message":"Insufficient credits.","code":402}';

/** One failed assistant turn carrying an error message — the child's turn boundary. */
function failedTurn(errorMessage: string): Record<string, unknown> {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  };
}

describe("isBillingExhaustionFailure", () => {
  test("matches the 402 status prefix, in both provider-error shapes", () => {
    expect(isBillingExhaustionFailure(PAYMENT_REQUIRED_BODY)).toBe(true);
    expect(isBillingExhaustionFailure(PROVIDER_PREFIXED_402)).toBe(true);
  });

  test("rejects every other status — a 401 (auth) or 429 (throttle) is not a billing failure", () => {
    // Failure mode: the status check widened to any 4xx/5xx. Mutation: accept any 3-digit
    // status → this test must redden.
    expect(isBillingExhaustionFailure('401: {"message":"Invalid API key"}')).toBe(false);
    expect(isBillingExhaustionFailure('429: {"message":"Rate limit exceeded"}')).toBe(false);
    expect(isBillingExhaustionFailure('500: {"message":"internal error"}')).toBe(false);
    expect(isBillingExhaustionFailure("")).toBe(false);
  });

  test("the status is a PREFIX, not a number anywhere in the text", () => {
    // Failure mode: the rule loosened to "contains 402". Mutation: drop the anchor → this
    // test must redden.
    expect(isBillingExhaustionFailure('{"message":"the 402 quota is gone"}')).toBe(false);
    expect(isBillingExhaustionFailure('{"error":"upstream said 402: try later"}')).toBe(false);
    expect(isBillingExhaustionFailure("4021: not a status")).toBe(false);
    expect(isBillingExhaustionFailure("402")).toBe(false);
  });
});

describe("the 402 rule and the router-fallback core's rule agree", () => {
  // The two extensions ship as separate packages and cannot import each other, so the rule
  // is copied — this test is what keeps the copy in step with the sibling.
  test("every 402 this rule fires on, the sibling also calls a billing exhaustion", () => {
    for (const errorMessage of [PAYMENT_REQUIRED_BODY, PROVIDER_PREFIXED_402, "402: plain text", "402: {…}"]) {
      if (!isBillingExhaustionFailure(errorMessage)) continue;
      expect(classifyFailure({ errorMessage }).kind).toBe("billing-exhaustion");
    }
  });
});

describe("DelegationRunner — billing (402) fallback retry", () => {
  test("a child that ends on a 402 respawns on the parent model and completes there", async () => {
    // Failure mode: the 402 arm does not exist at all — the run settles on the dead child.
    // Mutation: delete the billing arm → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);

    expect(h.children).toHaveLength(2);
    expect(h.spawnedArgv[1]).toEqual(FALLBACK_ARGS);

    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(record.state).toBe("completed");
    expect(record.exitCode).toBe(0);
    expect(record.modelFallback).toContain("402");
    expect(h.notes[0]!.modelFallback).toBe(record.modelFallback);
  });

  test("the 402 arm ignores the exit code and the progress guard", async () => {
    // The 402 is an API error inside a LIVE child: it exits 0, and the child emitted a
    // progress event before it. Failure mode: the startup arm's guards (exit 1, no progress
    // event) applied to the billing arm. Mutation: demand code === 1 and no progress event
    // for the 402 arm → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(assistantEnd("partial work"));
    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);

    expect(h.children).toHaveLength(2);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);
    await done;
  });

  test("the provider-prefixed 402 shape respawns too", async () => {
    // Failure mode: only the bare "<status>: " shape is matched. Mutation: drop the
    // provider-prefixed regex → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PROVIDER_PREFIXED_402));
    h.children[0]!.exit(0, null);

    expect(h.children).toHaveLength(2);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);
    await done;
  });

  test("a non-billing failure does not respawn", async () => {
    // Failure mode: the status check widened to any 4xx/5xx. Mutation: accept any status
    // → this test must redden.
    for (const errorMessage of ['401: {"message":"Invalid API key"}', '429: {"message":"Rate limit"}']) {
      const h = makeRunner();
      const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;
      h.children[0]!.emitEvent(failedTurn(errorMessage));
      h.children[0]!.exit(0, null);
      // Asserted before the await: a respawn here would leave the second child running and
      // the run unsettled — the assertion must fail fast, not time out.
      expect(h.children).toHaveLength(1);
      await done;
    }
  });

  test("a child that recovered from a 402 does not respawn", async () => {
    // The in-child router-fallback can switch model and carry on: the run then ends on a
    // NORMAL turn, and the 402 is history. Failure mode: "any 402 in the stream" instead of
    // "the last assistant turn failed". Mutation: scan every event for a 402 → this test
    // must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.emitEvent(assistantEnd("recovered on the fallback model"));
    h.children[0]!.exit(0, null);

    await done;
    expect(h.children).toHaveLength(1);
    expect(h.notes[0]!.answer).toBe("recovered on the fallback model");
  });

  test("a 402 without a fallback argv does not respawn", async () => {
    // Failure mode: the missing-fallback guard dropped. Mutation: pass no fallbackArgs →
    // this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest()).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);

    await done;
    expect(h.children).toHaveLength(1);
  });

  test("a 402 whose fallback argv equals the primary argv does not respawn", async () => {
    // Failure mode: the identical-argv guard dropped (the respawn would change nothing).
    // Mutation: drop the equality check → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: PRIMARY_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);

    await done;
    expect(h.children).toHaveLength(1);
  });

  test("a 402 respawns at most once", async () => {
    // Failure mode: the one-retry guard dropped. Mutation: remove the `retried` guard →
    // this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);
    h.children[1]!.emitEvent(sessionHeader);
    h.children[1]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(h.children).toHaveLength(2);
    expect(record.modelFallback).toContain("402");
    // The second attempt also died on a 402: the run settles with no answer, and the note
    // says so instead of reporting the failed attempt's text.
    expect(record.state).toBe("completed");
    expect(h.notes[0]!.answer).toBe("");
    expect(h.notes[0]!.silentReason).toBeDefined();
  });

  test("the 402 respawn keeps one log header, one exit line and one note", async () => {
    // The catalog claims the respawn is not a second delegation. Failure mode: the 402 path
    // broke the log/note invariants the startup path keeps. Mutation: emit a second header
    // or exit line on the respawn → this test must redden.
    const { logs, logSink } = makeLogSink();
    const h = makeRunner({ logSink });
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);
    await done;

    const lines = (logs.get("d-1") ?? []).map((line) => JSON.parse(line) as { type: string });
    expect(lines.filter((l) => l.type === "run")).toHaveLength(1);
    expect(lines.filter((l) => l.type === "exit")).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
  });

  test("the card verdict names the 402 that forced the respawn", async () => {
    // The verdict is the card's only line: it must carry the cause, not just the respawn.
    // Failure mode: the card clause lost its reason → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);
    await done;

    const verdict = notificationVerdict(h.notes[0]!);
    expect(verdict).toContain("hit a provider billing failure");
    expect(verdict).toContain("402");
    expect(verdict).toContain("openrouter/z-ai/glm-5.3-flash");
  });

  test("the recorded reason names the pin, the 402 and the retried model", async () => {
    // Failure mode: the reason is not recorded (the respawn would be silent). Mutation:
    // record an empty reason → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(record.modelFallback).toContain("opus");
    expect(record.modelFallback).toContain("402");
    expect(record.modelFallback).toContain("openrouter/z-ai/glm-5.3-flash");
  });

  test("a child killed by a signal does not respawn", async () => {
    // Failure mode: the signal guard dropped — a killed child would be respawned as if it
    // had failed on its model. Mutation: drop the `signal !== null` guard → this test must
    // redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(1, "SIGTERM");

    const record = await done;
    expect(h.children).toHaveLength(1);
    expect(record.state).toBe("aborted");
  });

  test("a last turn that failed for ANOTHER reason does not respawn", async () => {
    // The last assistant turn decides: an earlier 402 followed by a 500 is not a billing
    // failure. Failure mode: the search skips a non-402 last error and keeps looking
    // backwards for an earlier 402 → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.emitEvent(failedTurn('500: {"message":"internal error"}'));
    h.children[0]!.exit(0, null);

    await done;
    expect(h.children).toHaveLength(1);
  });

  test("a startup failure still records the startup wording", async () => {
    // The two classes read differently: a model that cannot start was REJECTED; a 402 is a
    // billing failure, not a rejected model. Failure mode: one wording for both → this
    // test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.exit(1, null);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(record.modelFallback).toContain("was rejected");
    expect(record.modelFallback).not.toContain("billing failure");
  });

  test("a startup failure and a 402 turn are the billing class", async () => {
    // The two classes cannot both apply: the startup class demands that no progress event
    // was parsed, and a 402 turn IS a message_end — a progress event. So a child that
    // carries a 402 turn is a billing failure, whatever its stderr says.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.stderrWrite(MODEL_FAILURE_STDERR);
    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(1, null);

    expect(h.children).toHaveLength(2);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);
    const record = await done;
    expect(record.modelFallback).toContain("hit a provider billing failure");
  });

  test("the failed attempt's text is never reported as the run's answer", async () => {
    // The child produced text, then died on a 402; the respawn produced nothing. The
    // settled answer must come from the respawned attempt (none) — not from the failed
    // attempt's partial text. Failure mode: the answer walk ignores the attempt boundary
    // → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(sessionHeader);
    h.children[0]!.emitEvent(assistantEnd("half an answer from the failed attempt"));
    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);
    h.children[1]!.emitEvent(sessionHeader);
    h.children[1]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(record.modelFallback).toContain("hit a provider billing failure");
    expect(h.notes[0]!.answer).toBe("");
    expect(h.notes[0]!.silentReason).toBeDefined();
  });

  test("the recorded reason carries the provider's own words, not the raw JSON", async () => {
    // Failure mode: the raw provider body is dumped into the reason (a JSON blob is not a
    // sentence). Mutation: skip the provider-message extraction → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent(failedTurn(PAYMENT_REQUIRED_BODY));
    h.children[0]!.exit(0, null);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);

    const record = await done;
    expect(record.modelFallback).toContain("requires more credits");
    expect(record.modelFallback).not.toContain("limit_source");
  });

  test("a real provider 402 — the shape the child's stream carries — respawns", async () => {
    // The measured payload (the child's own log, d-83.jsonl): a provider 402 folded into
    // the assistant turn. Failure mode: the event shape the child really emits is not what
    // the predicate reads → this test must redden.
    const h = makeRunner();
    const done = h.runner.run(retryRequest({ fallbackArgs: FALLBACK_ARGS })).done;

    h.children[0]!.emitEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "openrouter",
        model: "deepseek/deepseek-v4.1-flash",
        stopReason: "error",
        errorMessage:
          '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 887478 tokens, but can only afford 1252.","code":402,"metadata":{"limit_source":"openrouter_credits"}}',
      },
    });
    h.children[0]!.exit(0, null);

    expect(h.children).toHaveLength(2);
    h.children[1]!.emitEvent(assistantEnd("ship it"));
    h.children[1]!.exit(0, null);
    const record = await done;
    expect(record.modelFallback).toContain("requires more credits");
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
