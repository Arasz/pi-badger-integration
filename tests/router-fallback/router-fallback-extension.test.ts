/**
 * Wiring tests for the router-fallback extension factory (PKG-B rows W1–W17, G1′/G2′/G4, I2′).
 *
 * The harness is the shared fake-pi (tests/helpers/fake-pi.ts): handler ARRAYS per event,
 * the EventEmitter-backed routing bus for `pi.events`, and a mutable injected clock.
 * The manual scheduler and the extension-event `fire` helper are test-local (the monitor
 * precedent) — fake-pi needed no changes for this lane (F0-H3 verdict in the report).
 *
 * The entire provider seam (Lane C) arrives as injected factory deps typed per F2
 * (`decideNextTarget → {entry,model} | {none,reason}`, `getServingProvider`,
 * `requiredThinking`, `resolveTargets`, `isEligible`), defaulting to safe stubs.
 * These rows prove wiring-behavior-given-seam; selector policy is Lane C's F-rows.
 *
 * Verified shapes (F0-H2, installed pi 0.85.1 + repo-pinned 0.84.4):
 * - extension `setModel(model)` is positional single-arg → `Promise<boolean>`
 *   (`false` = auth unconfigured, never throws); the session-level
 *   `setModel(model, {persist})` is unreachable from extensions, so W3′ pins the
 *   argv shape (exactly one arg) as the never-persist regression guard.
 * - extension `agent_end` payload is `{messages}`-only (no `willRetry` anywhere);
 *   `agent_settled` carries no messages — the wiring latches the failure at
 *   `agent_end` and reaps it at `agent_settled`.
 */

import { describe, expect, test } from "bun:test";

import routerFallback, {
  ROUTER_FALLBACK_CHANNEL,
  ROUTER_FALLBACK_COMMAND,
  ROUTER_FALLBACK_CUSTOM_TYPE,
  type DecideNextTargetResult,
  type RouterFallbackDeps,
  type RouterFallbackModelRef,
} from "../../extensions/router-fallback/index.ts";
import { TRANSITION_CHANNEL } from "../../extensions/subagent/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";

// ------------------------------------------------------------------ fixtures

const BILLING_402 = "402: payment_required: insufficient credits — add funds or use a free model";
const AUTH_401 = "401: authentication failed — invalid credentials for this key";
const RETRY_503 = "503: Service Unavailable — upstream connect error, retry shortly";
const THROTTLE_500 = "500 Service Unavailable";
const GENERIC_BOOM = "boom: something broke upstream";
const CLEAN_STOP = "all good";

const GROQ: RouterFallbackModelRef = { provider: "groq", id: "llama-3.3-70b-versatile" };
const GEMINI: RouterFallbackModelRef = { provider: "google", id: "gemini-3.1-flash-lite" };

function assistant(message: Record<string, unknown>) {
  return { role: "assistant", stopReason: "stop", timestamp: 1_700_000_000_000, ...message };
}

function agentEndMessages(last: Record<string, unknown>) {
  return [{ role: "user", content: "go", timestamp: 1_700_000_000_000 }, assistant(last)];
}

/** Verified `agent_end` shape: `{messages}` only — no `willRetry` key exists here. */
function agentEndEvent(last: Record<string, unknown>) {
  return { type: "agent_end", messages: agentEndMessages(last) };
}

/** Verified `agent_settled` shape: no messages — the wiring reaps its own latch. */
function agentSettledEvent() {
  return { type: "agent_settled" };
}

// ------------------------------------------------------------------ harness

/** Manual scheduler: timers are recorded, never run; tests fire by handle. */
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

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Invoke every handler registered for one extension event, in order; returns results. */
async function fire(pi: FakePi, name: string, event: unknown, ctx: unknown): Promise<unknown[]> {
  const handlers = pi.handlers.get(name) ?? [];
  const results: unknown[] = [];
  for (const handler of handlers) results.push(await handler(event, ctx));
  return results;
}

/** Invoke without awaiting — the caller flushes explicitly (W2/W3′ flush discipline). */
function fireNoWait(pi: FakePi, name: string, event: unknown, ctx: unknown): Promise<unknown[]> {
  const handlers = pi.handlers.get(name) ?? [];
  return (async () => {
    const results: unknown[] = [];
    for (const handler of handlers) results.push(await handler(event, ctx));
    return results;
  })();
}

interface SetModelCall {
  model: unknown;
  argc: number;
}

function makeSetModel(script: Array<boolean | Error> = [true]) {
  const calls: SetModelCall[] = [];
  const queue = [...script];
  const fn = async (...args: unknown[]): Promise<boolean> => {
    calls.push({ model: args[0], argc: args.length });
    await Promise.resolve();
    const next = queue.length > 0 ? queue.shift()! : true;
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

interface SeamScript {
  decide?: DecideNextTargetResult[];
  serving?: { id: string; label: string; model: string } | undefined;
  thinking?: (model: RouterFallbackModelRef) => string | undefined;
}

function tryTarget(model: RouterFallbackModelRef): DecideNextTargetResult {
  return { entry: { id: model.provider, label: model.provider, model: model.id }, model };
}

function noneTarget(reason = "stub: no targets configured"): DecideNextTargetResult {
  return { none: true as const, reason };
}

function makeSeam(script: SeamScript = {}) {
  const decideQueue = [...(script.decide ?? [])];
  const calls = { decide: [] as unknown[], resolve: [] as unknown[], serving: 0, thinking: [] as unknown[], registerProvider: [] as unknown[] };
  let serving = script.serving;
  return {
    calls,
    advanceServing(next: { id: string; label: string; model: string }) {
      serving = next;
    },
    seam: {
      isEligible: () => true,
      resolveTargets: (ctx: unknown) => {
        calls.resolve.push(ctx);
        return [];
      },
      decideNextTarget: (event: unknown) => {
        calls.decide.push(event);
        return decideQueue.length > 0 ? decideQueue.shift()! : noneTarget();
      },
      getServingProvider: () => {
        calls.serving += 1;
        return serving;
      },
      requiredThinking: (model: RouterFallbackModelRef) => {
        calls.thinking.push(model);
        return script.thinking?.(model);
      },
    },
  };
}

interface Notice {
  message: string;
  type?: string;
}

interface Harness {
  pi: FakePi;
  scheduler: Scheduler;
  env: Record<string, string | undefined>;
  setModel: ReturnType<typeof makeSetModel>;
  thinkingCalls: unknown[];
  seam: ReturnType<typeof makeSeam>;
  notices: Notice[];
  ctx: (overrides?: Record<string, unknown>) => unknown;
}

function makeHarness(
  options: {
    setModelScript?: Array<boolean | Error>;
    seam?: SeamScript;
    deps?: Partial<RouterFallbackDeps>;
    now?: number;
  } = {},
): Harness {
  const pi = createFakePi({ now: options.now });
  const scheduler = manualScheduler();
  const env: Record<string, string | undefined> = {};
  const setModel = makeSetModel(options.setModelScript);
  const thinkingCalls: unknown[] = [];
  const seam = makeSeam(options.seam);
  const notices: Notice[] = [];
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
    mode: "tui",
    hasUI: true,
    cwd: "/p",
    model: undefined,
    scopedModels: [],
    ...overrides,
  });
  routerFallback(pi as never, {
    now: () => pi.clock.now,
    scheduler,
    env,
    setModelFn: setModel.fn,
    setThinkingLevelFn: (level: unknown) => thinkingCalls.push(level),
    selector: seam.seam as never,
    ...options.deps,
  });
  return { pi, scheduler, env, setModel, thinkingCalls, seam, notices, ctx };
}

function sentNotices(pi: FakePi) {
  return pi.sent.filter((entry) => entry.message.customType === ROUTER_FALLBACK_CUSTOM_TYPE);
}

// ------------------------------------------------------------------ W1

describe("W1: message_end never acts — returns undefined, zero setModel", () => {
  test("assistant-error at message_end classifies but returns undefined with no setModel call", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    const results = await fire(
      h.pi,
      "message_end",
      { type: "message_end", message: assistant({ stopReason: "error", errorMessage: BILLING_402 }) },
      ctx,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toBeUndefined();
    expect(h.setModel.calls).toHaveLength(0);
  });

  test("after_provider_response latches status and never acts", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const results = await fire(
      h.pi,
      "after_provider_response",
      { type: "after_provider_response", status: 402, headers: {} },
      h.ctx(),
    );
    expect(results[0]).toBeUndefined();
    expect(h.setModel.calls).toHaveLength(0);
  });

  test("MUTATION PIN: a message_end handler that calls setModel reddens this row", async () => {
    // Documents the failure mode W1 exists to catch: if the implementation ever
    // switches mid-turn (racing pi's `_handlePostAgentRun` retry/continue), the
    // zero-setModel assert below fails with the rogue call's argv.
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    await fire(
      h.pi,
      "message_end",
      { type: "message_end", message: assistant({ stopReason: "error", errorMessage: BILLING_402 }) },
      h.ctx(),
    );
    expect(h.setModel.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ W2

describe("W2: setModel false/reject advances once, never throws", () => {
  test("false on the first target advances to the second (flushed, pi-level log)", async () => {
    const h = makeHarness({
      setModelScript: [false, true],
      seam: { decide: [tryTarget(GROQ), tryTarget(GEMINI)] },
    });
    const pending = fireNoWait(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    await flush();
    await pending;
    expect(h.setModel.calls.map((call) => call.model)).toEqual([GROQ, GEMINI]);
    expect(sentNotices(h.pi)).toHaveLength(1);
  });

  test("rejection advances instead of throwing", async () => {
    const h = makeHarness({
      setModelScript: [new Error("No API key for groq/llama"), true],
      seam: { decide: [tryTarget(GROQ), tryTarget(GEMINI)] },
    });
    let threw: unknown;
    try {
      await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeUndefined();
    expect(h.setModel.calls.map((call) => call.model)).toEqual([GROQ, GEMINI]);
  });

  test("two failures in a row end notice-only: no third attempt, no throw", async () => {
    const h = makeHarness({
      setModelScript: [false, false],
      seam: { decide: [tryTarget(GROQ), tryTarget(GEMINI), tryTarget(GROQ)] },
    });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.setModel.calls).toHaveLength(2);
    expect(sentNotices(h.pi)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ W3′

describe("W3′: never persist — argv-shape guard (persist is structurally unpassable)", () => {
  test("setModel is called with exactly the model arg — no options object can ride along", async () => {
    const pi = createFakePi();
    const scheduler = manualScheduler();
    const calls: SetModelCall[] = [];
    (pi as unknown as Record<string, unknown>).setModel = async (...args: unknown[]) => {
      calls.push({ model: args[0], argc: args.length });
      return true;
    };
    const seam = makeSeam({ decide: [tryTarget(GEMINI)] });
    routerFallback(pi as never, {
      now: () => pi.clock.now,
      scheduler,
      env: {},
      selector: seam.seam as never,
    });
    const ctx = { ui: { notify: () => {} }, mode: "tui", hasUI: true, cwd: "/p", model: undefined, scopedModels: [] };
    const pending = fireNoWait(pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    await flush();
    await pending;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argc).toBe(1);
    expect(calls[0]!.model).toEqual(GEMINI);
    // Structural note: the extension-level `setModel(model)` takes no options
    // (types.d.ts:1006; loader.js:339-341) — the session-level
    // `setModel(model, {persist})` is unreachable from extensions, so an argv
    // of length 1 PROVES `persist:true` was never passed. The REAL setter spy
    // (settingsManager.setDefaultModelAndProvider) is pinned in W17.
  });
});

// ------------------------------------------------------------------ W4

describe("W4: scopedModels are forwarded to the seam and its in-scope pick is honored", () => {
  test("resolveTargets receives ctx.scopedModels; setModel lands the seam's in-scope pick", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const scopedModels = [{ model: { provider: "google", id: "gemini-3.1-flash-lite", reasoning: true } }];
    await fire(
      h.pi,
      "agent_end",
      agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }),
      h.ctx({ scopedModels }),
    );
    expect(h.seam.calls.resolve).toHaveLength(1);
    const received = h.seam.calls.resolve[0] as { scopedModels: Array<{ model: { id: string } }> };
    expect(received.scopedModels.map((entry) => entry.model.id)).toEqual(["gemini-3.1-flash-lite"]);
    expect(h.setModel.calls.map((call) => call.model)).toEqual([GEMINI]);
  });
});

// ------------------------------------------------------------------ W5′

describe("W5′: thinking level is explicit on reasoning targets, untouched otherwise", () => {
  test("reasoning target: setThinkingLevel called with the seam's explicit level", async () => {
    const h = makeHarness({
      seam: { decide: [tryTarget(GEMINI)], thinking: (model) => (model.provider === "google" ? "medium" : undefined) },
    });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.setModel.calls.map((call) => call.model)).toEqual([GEMINI]);
    expect(h.thinkingCalls).toEqual(["medium"]);
  });

  test("non-reasoning Groq target: setThinkingLevel NOT called (session auto-clamp owns off)", async () => {
    const h = makeHarness({
      seam: { decide: [tryTarget(GROQ)], thinking: (model) => (model.provider === "google" ? "medium" : undefined) },
    });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.setModel.calls.map((call) => call.model)).toEqual([GROQ]);
    expect(h.thinkingCalls).toEqual([]);
  });
});

// ------------------------------------------------------------------ W6

describe("W6: session_shutdown flushes timers and state", () => {
  test("an armed wait timer is cleared on shutdown and never fires setModel", async () => {
    const h = makeHarness({ seam: { decide: [{ none: true, reason: "stub: cooling down", retryAfterMs: 60_000 }] } });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.scheduler.timers.size).toBe(1);
    const [[handle]] = [...h.scheduler.timers.keys()].map((key) => [key]);
    await fire(h.pi, "session_shutdown", { type: "session_shutdown" }, h.ctx());
    expect(h.scheduler.timers.size).toBe(0);
    expect(() => h.scheduler.fire(handle!)).toThrow();
    expect(h.setModel.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ W7

describe("W7: at most one switch per episode, re-armed by settle", () => {
  test("second billing failure in the same episode holds; settled re-arms the next one", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ W8′

describe("W8′: switch emits on router-fallback; delegation-transition untouched", () => {
  test("N1 payload lands on the shared pi.events bus with command+renderer registered", async () => {
    const h = makeHarness({
      seam: { decide: [tryTarget(GEMINI)], serving: { id: "groq", label: "groq", model: "llama-3.3-70b-versatile" } },
    });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    const fallbackEmissions = h.pi.transitions.filter((entry) => entry.channel === ROUTER_FALLBACK_CHANNEL);
    expect(fallbackEmissions).toHaveLength(1);
    expect(ROUTER_FALLBACK_CHANNEL).toBe("router-fallback");
    const payload = fallbackEmissions[0]!.data as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["episodeId", "from", "kind", "reason", "servedBy", "to"]);
    expect(payload.kind).toBe("billing-exhaustion");
    expect(payload.to).toEqual({ provider: "google", model: "gemini-3.1-flash-lite" });
    expect(payload.from).toEqual({ provider: "unknown", model: "unknown" });
    expect(payload.servedBy).toEqual(["groq", "google"]);
    expect(typeof payload.episodeId).toBe("string");
    expect(h.pi.transitions.filter((entry) => entry.channel === TRANSITION_CHANNEL)).toHaveLength(0);
    expect(h.pi.commands.has(ROUTER_FALLBACK_COMMAND)).toBe(true);
    expect(h.pi.renderers.has(ROUTER_FALLBACK_CUSTOM_TYPE)).toBe(true);
  });

  test("from reflects the session model when the context carries one", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    await fire(
      h.pi,
      "agent_end",
      agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }),
      h.ctx({ model: { provider: "groq", id: "llama-3.3-70b-versatile" } }),
    );
    const payload = h.pi.transitions.filter((entry) => entry.channel === ROUTER_FALLBACK_CHANNEL)[0]!.data as Record<string, unknown>;
    expect(payload.from).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile" });
  });

  test("renderer tones by card kind and ignores empty bodies", () => {
    const h = makeHarness();
    const render = h.pi.renderers.get(ROUTER_FALLBACK_CUSTOM_TYPE)!;
    const tones: unknown[] = [];
    const theme = {
      fg: (tone: unknown, text: unknown) => {
        tones.push(tone);
        return String(text);
      },
      bg: (_slot: unknown, line: string) => line,
    };
    const options = { outputPad: 2 };
    for (const kind of ["switched", "hold", "exhausted"]) {
      const box = render({ content: `${kind} card`, details: { kind } } as never, options as never, theme as never);
      expect(box).toBeDefined();
    }
    expect(tones).toEqual(["success", "warning", "error"]);
    expect(render({ content: "", details: {} } as never, options as never, theme as never)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ W9′

describe("W9′: recomputed-hold until settled; billing switches at agent_end", () => {
  test("retryable 503 holds at agent_end (0 calls), then switches at agent_settled", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    const event = agentEndEvent({ stopReason: "error", errorMessage: RETRY_503 });
    expect("willRetry" in event).toBe(false);
    await fire(h.pi, "agent_end", event, ctx);
    expect(h.setModel.calls).toHaveLength(0);
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    expect(h.setModel.calls).toHaveLength(1);
    expect(h.setModel.calls[0]!.model).toEqual(GEMINI);
  });

  test("billing 402 switches AT agent_end (act-point), settled only mints the next episode", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    expect(h.setModel.calls).toHaveLength(1);
  });

  test("literal-500 throttle twin holds at BOTH agent_end and agent_settled (S3: throttle never switches models)", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: THROTTLE_500 }), ctx);
    expect(h.setModel.calls).toHaveLength(0);
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    expect(h.setModel.calls).toHaveLength(0);
  });

  test("MUTATION PIN: without the recomputed-retryability guard the 503 agent_end switches", async () => {
    // Removing the guard makes every agent_end[error] switchable — this twin
    // would then yield 1 call at agent_end instead of 0. The RED below (0 calls
    // on the correct build) proves the guard is load-bearing.
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: RETRY_503 }), h.ctx());
    expect(h.setModel.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ W10

describe("W10: auth failure with zero eligible targets holds with a notice", () => {
  test("0 setModel calls, one capped notice naming the hold reason", async () => {
    const h = makeHarness({ seam: { decide: [noneTarget("stub: no eligible providers for auth")] } });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: AUTH_401 }), h.ctx());
    expect(h.setModel.calls).toHaveLength(0);
    const cards = sentNotices(h.pi);
    expect(cards).toHaveLength(1);
    const content = String(cards[0]!.message.content);
    expect(content.length).toBeLessThanOrEqual(8192);
    expect(content).toMatch(/no eligible providers for auth/);
  });
});

// ------------------------------------------------------------------ W11

describe("W11: settled and /fallback reset mint a fresh episode with a zeroed count", () => {
  test("/fallback reset re-arms a spent episode", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as { handler: (args: string, ctx: unknown) => Promise<void> };
    await command.handler("reset", ctx);
    const resetNotice = h.notices[h.notices.length - 1]!;
    expect(resetNotice.message).toMatch(/new episode/);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(2);
  });

  test("settled mints a FRESH episode id (uniqueness only) with a zeroed count", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    const firstId = (h.pi.transitions.filter((entry) => entry.channel === ROUTER_FALLBACK_CHANNEL)[0]!.data as { episodeId: string }).episodeId;
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    const emissions = h.pi.transitions.filter((entry) => entry.channel === ROUTER_FALLBACK_CHANNEL);
    expect(emissions).toHaveLength(2);
    const secondId = (emissions[1]!.data as { episodeId: string }).episodeId;
    expect(secondId).not.toBe(firstId);
  });
});

// ------------------------------------------------------------------ W12

describe("W12: the 402 latch is an OR-input — either signal suffices, the latch alone never acts", () => {
  test("latch alone produces zero calls until agent_end sees an error", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "after_provider_response", { type: "after_provider_response", status: 402, headers: {} }, ctx);
    expect(h.setModel.calls).toHaveLength(0);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: CLEAN_STOP }), ctx);
    expect(h.setModel.calls).toHaveLength(0);
  });

  test("generic error text + 402 latch switches (latch supplies the billing signal)", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "after_provider_response", { type: "after_provider_response", status: 402, headers: {} }, ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: GENERIC_BOOM }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
  });

  test("billing text alone switches with no latch (message supplies the signal)", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.setModel.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ W13

describe("W13: before_provider_request is tag-only; model_select{source:set} confirms landing", () => {
  test("tagging marks the in-flight fallback attempt and never switches", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
    const payload: Record<string, unknown> = {};
    const results = await fire(h.pi, "before_provider_request", { type: "before_provider_request", payload }, ctx);
    expect(results[0]).toBeUndefined();
    expect(payload.routerFallbackAttempt).toBe(true);
    expect(h.setModel.calls).toHaveLength(1);
  });

  test("without an in-flight switch the payload is left untouched", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const payload: Record<string, unknown> = {};
    const results = await fire(h.pi, "before_provider_request", { type: "before_provider_request", payload }, h.ctx());
    expect(results[0]).toBeUndefined();
    expect(payload).toEqual({});
  });

  test("model_select{source:set} confirms the landing; other sources are ignored", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    await fire(
      h.pi,
      "model_select",
      { type: "model_select", model: GEMINI, previousModel: GROQ, source: "cycle" },
      ctx,
    );
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as { handler: (args: string, ctx: unknown) => Promise<void> };
    h.notices.length = 0;
    await command.handler("status", ctx);
    expect(h.notices[h.notices.length - 1]!.message).not.toMatch(/landed: google\/gemini-3\.1-flash-lite/);
    await fire(
      h.pi,
      "model_select",
      { type: "model_select", model: GEMINI, previousModel: GROQ, source: "set" },
      ctx,
    );
    await command.handler("status", ctx);
    expect(h.notices[h.notices.length - 1]!.message).toMatch(/landed: google\/gemini-3\.1-flash-lite/);
  });
});

// ------------------------------------------------------------------ W14

describe("W14: the serving record tracks the advance-on-false", () => {
  test("/fallback status names the advanced provider after a false hop", async () => {
    const h = makeHarness({
      setModelScript: [false, true],
      seam: {
        decide: [tryTarget(GROQ), tryTarget(GEMINI)],
        serving: { id: "groq", label: "groq", model: "llama-3.3-70b-versatile" },
      },
    });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls.map((call) => call.model)).toEqual([GROQ, GEMINI]);
    h.seam.advanceServing({ id: "google", label: "google", model: "gemini-3.1-flash-lite" });
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as { handler: (args: string, ctx: unknown) => Promise<void> };
    h.notices.length = 0;
    await command.handler("status", ctx);
    expect(h.seam.calls.serving).toBeGreaterThan(0);
    expect(h.notices[h.notices.length - 1]!.message).toMatch(/google/);
  });
});

// ------------------------------------------------------------------ W15

describe("W15: /fallback command surface", () => {
  test("status renders in tui and headless modes", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as {
      handler: (args: string, ctx: unknown) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => unknown;
    };
    await command.handler("status", h.ctx({ mode: "tui", hasUI: true }));
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.message).toMatch(/episode/);
    await command.handler("", h.ctx({ mode: "json", hasUI: false }));
    expect(h.notices).toHaveLength(2);
    expect(h.notices[1]!.message).toMatch(/episode/);
    expect(typeof command.getArgumentCompletions).toBe("function");
  });

  test("completions offer status|reset|off|on and null on no match", async () => {
    const h = makeHarness();
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as {
      getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null;
    };
    const all = command.getArgumentCompletions("")!.map((item) => item.value).sort();
    expect(all).toEqual(["off", "on", "reset", "status"]);
    expect(command.getArgumentCompletions("s")!.map((item) => item.value)).toEqual(["status"]);
    expect(command.getArgumentCompletions("o")!.map((item) => item.value).sort()).toEqual(["off", "on"]);
    expect(command.getArgumentCompletions("zzz")).toBeNull();
  });

  test("unknown subcommand answers with guidance and changes nothing", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as { handler: (args: string, ctx: unknown) => Promise<void> };
    await command.handler("bogus", ctx);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.message).toMatch(/usage: \/fallback \[status\|reset\|off\|on\]/);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
  });

  test("off disables for the session; on lifts the session override", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as { handler: (args: string, ctx: unknown) => Promise<void> };
    await command.handler("off", ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(0);
    await command.handler("on", ctx);
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ W16

describe("W16: lazy-arm — zero timers and bus subs until the first failure or command", () => {
  test("fresh factory holds no timers, no bus subscriptions and no pending failure", async () => {
    const h = makeHarness();
    expect(h.scheduler.timers.size).toBe(0);
    expect(h.pi.subscriptions).toHaveLength(0);
    expect(h.pi.transitions).toHaveLength(0);
    expect(h.setModel.calls).toHaveLength(0);
    // The passive observers ARE registered at load — they are the tripwire that
    // lets the first failure arm the episode (a subscription that fires only on
    // demand costs nothing until its event arrives).
    for (const name of ["after_provider_response", "message_end", "agent_end", "agent_settled", "model_select", "before_provider_request", "session_shutdown"]) {
      expect((h.pi.handlers.get(name) ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ------------------------------------------------------------------ W17

describe("W17: the persisted default is never touched", () => {
  test("a full switch leaves settingsManager.setDefaultModelAndProvider at zero calls", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const settingsCalls: unknown[][] = [];
    (h.pi as unknown as Record<string, unknown>).settingsManager = {
      setDefaultModelAndProvider: (...args: unknown[]) => settingsCalls.push(args),
    };
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.setModel.calls).toHaveLength(1);
    expect(settingsCalls).toHaveLength(0);
    for (const call of h.setModel.calls) expect(call.argc).toBe(1);
  });
});

// ------------------------------------------------------------------ G1′

describe("G1′: master kill-switch PI_BADGER_ROUTER_FALLBACK=0, read per call", () => {
  test("on → off → on across episodes; only the literal 0 disables", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    const billing = () => fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    const settled = () => fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    await billing();
    expect(h.setModel.calls).toHaveLength(1);
    await settled();
    h.env.PI_BADGER_ROUTER_FALLBACK = "0";
    await billing();
    expect(h.setModel.calls).toHaveLength(1);
    await settled();
    delete h.env.PI_BADGER_ROUTER_FALLBACK;
    await billing();
    expect(h.setModel.calls).toHaveLength(2);
  });

  test("set AFTER init still disables (per-call read, never cached at load)", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    h.env.PI_BADGER_ROUTER_FALLBACK = "0";
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.setModel.calls).toHaveLength(0);
  });

  test("disabled episodes leave no latch: re-enable then settle cleanly with no phantom switch", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    h.env.PI_BADGER_ROUTER_FALLBACK = "0";
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    delete h.env.PI_BADGER_ROUTER_FALLBACK;
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    expect(h.setModel.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ G2′

describe("G2′: PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES budget, read per call", () => {
  test("=0 disables every switch; =1 holds the second attempt in the same episode", async () => {
    const zero = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    zero.env.PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES = "0";
    await fire(zero.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), zero.ctx());
    expect(zero.setModel.calls).toHaveLength(0);

    const one = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    one.env.PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES = "1";
    const ctx = one.ctx();
    await fire(one.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    await fire(one.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(one.setModel.calls).toHaveLength(1);
  });

  test("per-call twin: lowering to 0 after init stops the next episode", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI), tryTarget(GEMINI)] } });
    const ctx = h.ctx();
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
    await fire(h.pi, "agent_settled", agentSettledEvent(), ctx);
    h.env.PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES = "0";
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(h.setModel.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ G4

describe("G4: notice cap end-to-end (8 KB whole-card budget)", () => {
  test("a 20 KB billing error still fits the notice inside 8192 chars", async () => {
    const h = makeHarness({ seam: { decide: [tryTarget(GEMINI)] } });
    const longError = `402: payment_required: ${"y".repeat(20_000)}`;
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: longError }), h.ctx());
    expect(h.setModel.calls).toHaveLength(1);
    const cards = sentNotices(h.pi);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]!.message.content).length).toBeLessThanOrEqual(8192);
  });

  test("a seam wait arms a clampCooldownMs-clamped timer (negative → default 60 s)", async () => {
    const h = makeHarness({ seam: { decide: [{ none: true, reason: "stub: cooling down", retryAfterMs: -5 }] } });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    expect(h.scheduler.timers.size).toBe(1);
    const [[, timer]] = [...h.scheduler.timers.entries()];
    expect(timer!.ms).toBe(60_000);
  });

  test("an explicit retryAfterMs passes the clamp through unchanged", async () => {
    const h = makeHarness({ seam: { decide: [{ none: true, reason: "stub: cooling down", retryAfterMs: 120_000 }] } });
    await fire(h.pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), h.ctx());
    const [[, timer]] = [...h.scheduler.timers.entries()];
    expect(timer!.ms).toBe(120_000);
    expect(h.setModel.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ I2′

describe("I2′: combined load — subagent + monitor + router-fallback share one fake-pi", () => {
  test("three session_shutdown handlers coexist; our emit owns router-fallback only", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmSync } = await import("node:fs");
    const monitor = (await import("../../extensions/monitor/index.ts")).default;
    const subagent = (await import("../../extensions/subagent/index.ts")).default;

    const pi = createFakePi();
    const scheduler = manualScheduler();
    const logDir = mkdtempSync(join(tmpdir(), "rf-combined-"));
    try {
      subagent(pi as never, { now: () => pi.clock.now, escalateAfterMs: 0, logDir });
      monitor(pi as never, { now: () => pi.clock.now, scheduler });
      const shutdownBefore = (pi.handlers.get("session_shutdown") ?? []).length;
      expect(shutdownBefore).toBeGreaterThanOrEqual(2);
      const setModel = makeSetModel([true]);
      const seam = makeSeam({ decide: [tryTarget(GEMINI)] });
      routerFallback(pi as never, {
        now: () => pi.clock.now,
        scheduler,
        env: {},
        setModelFn: setModel.fn,
        selector: seam.seam as never,
      });

      expect((pi.handlers.get("session_shutdown") ?? []).length).toBe(shutdownBefore + 1);
      expect((pi.handlers.get("session_shutdown") ?? []).length).toBeGreaterThanOrEqual(3);
      expect(pi.commands.has("fallback")).toBe(true);
      expect(pi.commands.has("monitors")).toBe(true);

      const ctx = { ui: { notify: () => {} }, mode: "tui", hasUI: true, cwd: "/p", model: undefined, scopedModels: [] };
      await fire(pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
      expect(setModel.calls).toHaveLength(1);
      expect(pi.transitions.filter((entry) => entry.channel === ROUTER_FALLBACK_CHANNEL)).toHaveLength(1);
      expect(pi.transitions.filter((entry) => entry.channel === TRANSITION_CHANNEL)).toHaveLength(0);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ seam defaults (F2 safe stubs)

describe("seam defaults: with no Lane C wiring the factory holds silently-safe", () => {
  test("default stubs are empty-eligible / {none}: billing holds, zero setModel, J1 registerProvider never called", async () => {
    const pi = createFakePi();
    const scheduler = manualScheduler();
    const registerCalls: unknown[] = [];
    const setModel = makeSetModel([true]);
    routerFallback(pi as never, {
      now: () => pi.clock.now,
      scheduler,
      env: {},
      setModelFn: setModel.fn,
      registerProviderFn: (...args: unknown[]) => registerCalls.push(args),
    });
    const ctx = { ui: { notify: () => {} }, mode: "tui", hasUI: true, cwd: "/p", model: undefined, scopedModels: [] };
    await fire(pi, "agent_end", agentEndEvent({ stopReason: "error", errorMessage: BILLING_402 }), ctx);
    expect(setModel.calls).toHaveLength(0);
    expect(registerCalls).toHaveLength(0);
  });
});
