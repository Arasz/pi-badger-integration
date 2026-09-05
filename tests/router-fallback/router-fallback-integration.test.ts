/**
 * Cross-package integration for the router-fallback extension (PKG-E rows I1–I4).
 *
 * Unlike the lane-B/C suites (seam stubs / injected selector state), every row
 * here loads the REAL wired factory — no `selector` dep — over a fake registry
 * (catalog + auth views) and the fake-pi clock. The only fakes are the registry
 * contents, the clock, and `setModel`/`setThinkingLevel` recorders.
 *
 * Rows:
 * - I2′ story: billing-on-primary → fallback serves → notice names the provider;
 *   cooldown honored then recovered; `/fallback status` post-switch.
 * - F9-through-wiring: no keys anywhere → 0 setModel + "no fallback auth" notice.
 * - reasoning passthrough: a reasoning catalog entry yields setThinkingLevel("low").
 * - I1: hermetic publish-logic proof for the new dir (directoryTarget over the
 *   real canonical root into a TEMP userDir — never the live ~/.pi).
 * - I3: secret scan over the canonical dir (names only, never values).
 * - I4: `--check` purity on temp fixtures (exit codes + no-write proof).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import routerFallback from "../../extensions/router-fallback/index.ts";
import { ROUTER_FALLBACK_MAX_SWITCHES_ENV } from "../../extensions/router-fallback/router-fallback-core.ts";
import { ROUTER_FALLBACK_CHANNEL, ROUTER_FALLBACK_COMMAND } from "../../extensions/router-fallback/index.ts";
import { ROUTER_FALLBACK_CUSTOM_TYPE } from "../../extensions/router-fallback/index.ts";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";
import { fire } from "./helpers.ts";
import { directoryTarget, drifts, main } from "../../publish.ts";

// ------------------------------------------------------------------ harness

const BILLING_402 = "402: payment_required: insufficient credits — add funds or use a free model";

function assistant(message: Record<string, unknown>) {
  return { role: "assistant", stopReason: "stop", timestamp: 1_700_000_000_000, ...message };
}

function agentEndEvent(last: Record<string, unknown>) {
  return {
    type: "agent_end",
    messages: [{ role: "user", content: "go", timestamp: 1_700_000_000_000 }, assistant(last)],
  };
}

/** Pinned-chain catalog: pro-preview deliberately ABSENT (stale-id resolve-or-skip). */
const CATALOG: Record<string, { reasoning: boolean }> = {
  "groq/llama-3.3-70b-versatile": { reasoning: false },
  "google/gemini-3.1-flash-lite": { reasoning: false },
  "openrouter/z-ai/glm-5.2:free": { reasoning: false },
  "openrouter/poolside/laguna-s-2.1:free": { reasoning: false },
  "openrouter/minimax/minimax-m3:free": { reasoning: false },
  "openrouter/thinkingmachines/inkling-small:free": { reasoning: false },
};

function fakeRegistry(configured: Record<string, boolean>, catalog: Record<string, { reasoning: boolean }> = CATALOG) {
  return {
    find: (provider: string, modelId: string): { reasoning: boolean } | undefined =>
      catalog[`${provider}/${modelId}`],
    getProviderAuthStatus: (provider: string): { configured: boolean } => ({
      configured: configured[provider] ?? false,
    }),
  };
}

interface WiredHarness {
  pi: FakePi;
  env: Record<string, string | undefined>;
  setModelCalls: unknown[];
  thinkingCalls: unknown[];
  ctx: Record<string, unknown>;
}

function makeWired(options: {
  env?: Record<string, string | undefined>;
  configured?: Record<string, boolean>;
  catalog?: Record<string, { reasoning: boolean }>;
  primary?: { provider: string; id: string };
} = {}): WiredHarness {
  const pi = createFakePi();
  const env: Record<string, string | undefined> = {
    GROQ_API_KEY: "test-groq-key-name-only",
    GEMINI_API_KEY: "test-gemini-key-name-only",
    ...options.env,
  };
  const setModelCalls: unknown[] = [];
  const thinkingCalls: unknown[] = [];
  routerFallback(pi as never, {
    now: () => pi.clock.now,
    env,
    // The ONLY fakes: session actuation recorders. Provider policy is real Lane C.
    setModelFn: async (...args: unknown[]) => {
      setModelCalls.push(args[0]);
      return true;
    },
    setThinkingLevelFn: (level: unknown) => thinkingCalls.push(level),
  });
  const ctx: Record<string, unknown> = {
    ui: { notify: () => {} },
    mode: "tui",
    hasUI: true,
    cwd: "/p",
    model: options.primary ?? { provider: "anthropic", id: "claude-opus-primary" },
    scopedModels: [],
    modelRegistry: fakeRegistry(options.configured ?? { groq: true, google: true, openrouter: false }),
  };
  if (options.catalog !== undefined) {
    ctx.modelRegistry = fakeRegistry(options.configured ?? { groq: true, google: true, openrouter: false }, options.catalog);
  }
  return { pi, env, setModelCalls, thinkingCalls, ctx };
}

function billingEnd(message = BILLING_402) {
  return agentEndEvent({ stopReason: "error", errorMessage: message });
}

function fallbackNotices(pi: FakePi) {
  return pi.sent.filter((entry) => entry.message.customType === ROUTER_FALLBACK_CUSTOM_TYPE);
}

// ------------------------------------------------------------------ I2′ story

describe("I2′ story (real wiring): billing-on-primary → fallback serves → notice names provider", () => {
  test("first billing failure switches the anthropic primary to Groq and names it", async () => {
    const h = makeWired();
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toEqual([{ provider: "groq", id: "llama-3.3-70b-versatile" }]);
    const cards = fallbackNotices(h.pi);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]!.message.content)).toMatch(/groq/i);
    const emissions = h.pi.transitions.filter((entry) => entry.channel === ROUTER_FALLBACK_CHANNEL);
    expect(emissions).toHaveLength(1);
    const payload = emissions[0]!.data as Record<string, unknown>;
    expect(payload.kind).toBe("billing-exhaustion");
    expect(payload.from).toEqual({ provider: "anthropic", model: "claude-opus-primary" });
    expect(payload.to).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile" });
    expect(payload.servedBy).toEqual(["groq"]);
  });

  test("second failure advances past the cooling head; expiry re-admits it (cooldown recovery)", async () => {
    const h = makeWired({ env: { [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "3" } });
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toEqual([{ provider: "groq", id: "llama-3.3-70b-versatile" }]);
    // Same episode: Groq is parked (60 s cooldown) → Gemini serves.
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toEqual([
      { provider: "groq", id: "llama-3.3-70b-versatile" },
      { provider: "google", id: "gemini-3.1-flash-lite" },
    ]);
    // Same episode, still inside both cooldowns → exhausted, notice-only.
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toHaveLength(2);
    const cards = fallbackNotices(h.pi);
    expect(String(cards[cards.length - 1]!.message.content)).toMatch(/exhausted/);
    // Past the 60 s cooldown the head recovers and serves again.
    h.pi.clock.advance(61_000);
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toHaveLength(3);
    expect(h.setModelCalls[2]).toEqual({ provider: "groq", id: "llama-3.3-70b-versatile" });
  });

  test("/fallback status post-switch names the serving provider and the failure kind", async () => {
    const h = makeWired({ env: { [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "3" } });
    const seen: string[] = [];
    h.ctx.ui = { notify: (message: string) => seen.push(message) };
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    const command = h.pi.commands.get(ROUTER_FALLBACK_COMMAND) as {
      handler: (args: string, ctx: unknown) => Promise<void>;
    };
    await command.handler("status", h.ctx);
    const status = seen[seen.length - 1]!;
    expect(status).toMatch(/serving: gemini \(gemini-3\.1-flash-lite\)/);
    expect(status).toMatch(/billing-exhaustion/);
    expect(status).toMatch(/episode/);
  });

  test("non-reasoning targets never touch setThinkingLevel (session auto-clamp owns it)", async () => {
    const h = makeWired();
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toHaveLength(1);
    expect(h.thinkingCalls).toEqual([]);
  });

  test("a reasoning catalog entry yields the explicit setThinkingLevel passthrough", async () => {
    const reasoningCatalog: Record<string, { reasoning: boolean }> = {
      ...CATALOG,
      "google/gemini-3.1-flash-lite": { reasoning: true },
    };
    const h = makeWired({
      env: { [ROUTER_FALLBACK_MAX_SWITCHES_ENV]: "2" },
      catalog: reasoningCatalog,
    });
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls[1]).toEqual({ provider: "google", id: "gemini-3.1-flash-lite" });
    expect(h.thinkingCalls).toEqual(["low"]);
  });
});

describe("F9 through real wiring: no keys anywhere holds with a no-auth notice", () => {
  test("empty env + unconfigured auth → 0 setModel, notice names the missing keys", async () => {
    const h = makeWired({
      env: { GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined, OPENROUTER_API_KEY: undefined },
      configured: { groq: false, google: false, openrouter: false },
    });
    await fire(h.pi, "agent_end", billingEnd(), h.ctx);
    expect(h.setModelCalls).toHaveLength(0);
    const cards = fallbackNotices(h.pi);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]!.message.content)).toMatch(/no fallback auth/);
  });
});

// ------------------------------------------------------------------ I1 (hermetic publish logic)

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

describe("I1: hermetic publish logic for the router-fallback dir (never the live ~/.pi)", () => {
  test("directoryTarget covers every canonical file incl. package.json; drifts detects the empty userDir", async () => {
    const userDir = mkdtempSync(join(tmpdir(), "rf-publish-user-"));
    try {
      const target = directoryTarget("router-fallback", { root: repoRoot(), userDir });
      const rel = target.pairs.map((pair) => pair.source.slice(`${repoRoot()}/extensions/router-fallback/`.length));
      for (const name of ["index.ts", "router-fallback-core.ts", "fallback-providers.ts", "package.json"]) {
        expect(rel).toContain(name);
      }
      for (const pair of target.pairs) {
        expect(await Bun.file(pair.source).exists()).toBe(true);
      }
      // Hermetic temp userDir is empty → every canonical file reads "not installed".
      const report = drifts(target);
      expect(report.problems.length).toBeGreaterThan(0);
      expect(report.problems.every((problem) => problem.startsWith("not installed:"))).toBe(true);
      // …so --check (injected targets only — the real user scope is never read) fails.
      expect(main(["--check"], { targets: [target] })).toBe(1);
    } finally {
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("publish.ts EXTENSION_DIRS owns router-fallback (the E3 one-liner)", async () => {
    const source = readFileSync(join(repoRoot(), "publish.ts"), "utf8");
    const line = source.split("\n").find((text) => text.includes("EXTENSION_DIRS ="));
    expect(line).toBeDefined();
    expect(line!).toMatch(/"router-fallback"/);
  });
});

// ------------------------------------------------------------------ I3 (secret scan)

describe("I3: no secret values in the canonical dir (env-var names only)", () => {
  test("sk-|gsk_|sk-or-|AIza|xoxb scan over extensions/router-fallback/ is empty", async () => {
    const dir = join(repoRoot(), "extensions", "router-fallback");
    const hits: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const text = readFileSync(join(dir, entry), "utf8");
      // I3 patterns, verbatim from the plan row.
      const matches = text.match(/sk-|gsk_|sk-or-|AIza|xoxb/g);
      if (matches) hits.push(`${entry}: ${matches.join(",")}`);
    }
    expect(hits).toEqual([]);
  });
});

// ------------------------------------------------------------------ I4 (--check purity on fixtures)

describe("I4: --check purity — injected fixtures only, nothing written", () => {
  function snapshot(base: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(`${full.slice(base.length)}:${readFileSync(full, "utf8")}`);
      }
    };
    walk(base);
    return out.sort();
  }

  test("in-sync fixtures exit 0 with a byte-identical tree afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "rf-check-root-"));
    const userDir = mkdtempSync(join(tmpdir(), "rf-check-user-"));
    try {
      mkdirSync(join(root, "extensions", "demo"), { recursive: true });
      writeFileSync(join(root, "extensions", "demo", "index.ts"), "export default 1;\n");
      mkdirSync(join(userDir, "demo"), { recursive: true });
      writeFileSync(join(userDir, "demo", "index.ts"), "export default 1;\n");
      const target = directoryTarget("demo", { root, userDir });
      const before = snapshot(userDir);
      expect(main(["--check"], { targets: [target] })).toBe(0);
      expect(snapshot(userDir)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("drifted fixtures exit 1 (the gate bites) and still write nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "rf-check-root-"));
    const userDir = mkdtempSync(join(tmpdir(), "rf-check-user-"));
    try {
      mkdirSync(join(root, "extensions", "demo"), { recursive: true });
      writeFileSync(join(root, "extensions", "demo", "index.ts"), "export default 1;\n");
      const target = directoryTarget("demo", { root, userDir });
      const before = snapshot(userDir);
      expect(main(["--check"], { targets: [target] })).toBe(1);
      expect(snapshot(userDir)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});
