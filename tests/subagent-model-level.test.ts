/**
 * PKG-5 5a — registry source: import-from-target-project + frozen fallback.
 *
 * ADR: docs/work/2026-09-06-pkg5-level-registry-adr.md (IMPORT verdict, absence rule).
 * `loadModelGroups` reads `<cwd>/.ai-badger/model-groups.json` at delegation time (never a
 * vendored copy, never the ai-badger repo); missing/unreadable/unparseable/structurally
 * unusable file degrades to FROZEN_MODEL_GROUPS with a warning naming the rule (router
 * degrade-on-stale precedent) — delegation never bricks for lack of a registry file.
 *
 * TDD note: written FIRST per lane TDD discipline; RED witnessed before the 5a
 * implementation commit (see lane report).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FROZEN_MODEL_GROUPS,
  InvalidLevelError,
  MODEL_ID_PATTERN,
  resolveDelegationModel,
  resolveLevel,
  VALID_LEVELS,
  type LevelRegistry,
} from "../extensions/subagent/delegation-core.ts";
import {
  AGENTS_DIR,
  delegationArgs,
  fallbackArgsFor,
  loadModelGroups,
  notificationVerdict,
  parsePersona,
  scanPersonas,
  type Persona,
} from "../extensions/subagent/index.ts";
import type { DelegationNote } from "../extensions/subagent/delegation-runner.ts";
import { FakeChild } from "./helpers/fake-child.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import subagent from "../extensions/subagent/index.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "aib-pkg5-5a-"));
}

/** Minimal member-object fixture (never string lists — T-FAKESHAPE): id + preferred flag. */
const member = (id: string, preferred = false) => ({ id, preferred });

function projectFile(dir: string, obj: unknown): void {
  const dot = join(dir, ".ai-badger");
  mkdirSync(dot, { recursive: true });
  writeFileSync(join(dot, "model-groups.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
}

describe("5a loadModelGroups — absence rule (T-MISS halves)", () => {
  test("missing file degrades to the frozen fallback with a warning", () => {
    const dir = tmpRoot();
    try {
      const loaded = loadModelGroups(dir);
      expect(loaded.source).toBe("frozen");
      expect(loaded.registry).toBe(FROZEN_MODEL_GROUPS);
      expect(loaded.warning ?? "").toMatch(/model-groups\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unparseable file degrades to frozen with a warning naming the rule", () => {
    const dir = tmpRoot();
    try {
      projectFile(dir, "{ not json");
      const loaded = loadModelGroups(dir);
      expect(loaded.source).toBe("frozen");
      expect(loaded.warning ?? "").toMatch(/parse|unparseable|invalid/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("structurally unusable file (no groups / empty group / id-less preferred) degrades to frozen", () => {
    const cases: Array<[string, unknown]> = [
      ["no groups key", { registryVersion: 1 }],
      ["empty low group", { groups: { low: [], medium: [member("openrouter/x/y")], high: [member("openrouter/x/y")] } }],
      ["preferred without id", { groups: { low: [{ preferred: true }], medium: [member("openrouter/x/y")], high: [member("openrouter/x/y")] } }],
    ];
    for (const [name, obj] of cases) {
      const dir = tmpRoot();
      try {
        projectFile(dir, obj);
        const loaded = loadModelGroups(dir);
        expect(loaded.source).toBe("frozen");
        expect(loaded.warning ?? `${name}: no warning`).toMatch(/low|medium|high|group|usable/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("valid project file loads with source project and no warning", () => {
    const dir = tmpRoot();
    try {
      projectFile(dir, {
        registryVersion: 7,
        groups: {
          low: [member("openrouter/z-ai/glm-5.3-flash", true)],
          medium: [member("openrouter/meta/muse-spark-1.3-contributor", true)],
          high: [member("openrouter/meta/muse-spark-1.3-contributor", true)],
        },
      });
      const loaded = loadModelGroups(dir);
      expect(loaded.source).toBe("project");
      expect(loaded.warning).toBeUndefined();
      expect(loaded.registry.groups.low[0]?.id).toBe("openrouter/z-ai/glm-5.3-flash");
      expect(loaded.registry.registryVersion).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("5a FROZEN_MODEL_GROUPS — degrade-on-stale pins", () => {
  test("frozen carries the ai-badger canonical preferred pins", () => {
    expect(FROZEN_MODEL_GROUPS.source).toContain("ai-badger canonical");
    expect(FROZEN_MODEL_GROUPS.groups.low[0]?.id).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(FROZEN_MODEL_GROUPS.groups.medium[0]?.id).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(FROZEN_MODEL_GROUPS.groups.high[0]?.id).toBe("openrouter/deepseek/deepseek-v4.1-flash");
  });

  test("closed level set is exactly low|medium|high", () => {
    expect([...VALID_LEVELS]).toEqual(["low", "medium", "high"]);
    expect(Object.keys(FROZEN_MODEL_GROUPS.groups).sort()).toEqual(["high", "low", "medium"]);
  });
});

// ------------------------------------------------------------------ 5b resolver

/** Member-object fixtures only (T-FAKESHAPE): id + preferred + pricing/evidence; the medium
 * tail carries aliases + demoted status, the high tail an always-latest alias — the resolver
 * must return `.id` and never dereference either (T-ALIAS). */
const FIXTURE: LevelRegistry = {
  registryVersion: 9,
  groups: {
    low: [
      { id: "openrouter/z-ai/glm-5.3-flash", preferred: true, pricing: { inputPerM: 0.075, outputPerM: 0.25 }, evidence: "low preferred" },
      { id: "openrouter/deepseek/deepseek-v4-flash-0731", preferred: false, pricing: { inputPerM: 0.0875, outputPerM: 0.175 }, evidence: "tail" },
    ],
    medium: [
      { id: "openrouter/meta/muse-spark-1.3-contributor", preferred: true, pricing: { inputPerM: 0.1, outputPerM: 0.2 }, evidence: "medium preferred", weightsId: "muse-spark-1.3-weights" },
      { id: "openrouter/anthropic/claude-sonnet-5", preferred: false, pricing: { inputPerM: 2, outputPerM: 10 }, evidence: "demoted tail", aliases: ["~anthropic/claude-sonnet-latest"], status: "demoted", revisionWatch: true },
    ],
    high: [
      { id: "openrouter/meta/muse-spark-1.3-contributor", preferred: true, pricing: { inputPerM: 0.1, outputPerM: 0.2 }, evidence: "high preferred", weightsId: "muse-spark-1.3-weights" },
      { id: "openrouter/anthropic/claude-fable-5.1", preferred: false, pricing: { inputPerM: 10, outputPerM: 50 }, evidence: "ceiling", aliases: ["~anthropic/claude-fable-latest"] },
    ],
  },
};

function tierPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: "architect",
    description: "Architecture specialist",
    systemPrompt: "# Architect\n",
    filePath: "/tmp/architect.md",
    ...overrides,
  };
}

const modelOf = (args: string[]): string | undefined => {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
};

describe("5b resolveLevel — pure level resolution", () => {
  test("L1-D1: low/medium/high resolve to the groups' preferred ids", () => {
    expect(resolveLevel(FIXTURE, { level: "low" }).model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(resolveLevel(FIXTURE, { level: "medium" }).model).toBe("openrouter/meta/muse-spark-1.3-contributor");
    expect(resolveLevel(FIXTURE, { level: "high" }).model).toBe("openrouter/meta/muse-spark-1.3-contributor");
    expect(resolveLevel(FIXTURE, { level: "low" }).resolvedLevel).toBe("low");
    expect(resolveLevel(FIXTURE, { level: "low" }).registryVersion).toBe(9);
  });

  test("L1-D2: explicit model beats level verbatim, override recorded", () => {
    const r = resolveLevel(FIXTURE, { level: "low", model: "openrouter/custom/explicit" });
    expect(r.model).toBe("openrouter/custom/explicit");
    expect(r.overriddenLevel).toBe("low");
    expect(r.overridingModel).toBe("openrouter/custom/explicit");
    // A shape-failing bare pin is refused before emit (grandfather clause retired — the
    // explicit-pin shape gate below): the level resolves instead and the refusal is recorded.
    const refused = resolveLevel(FIXTURE, { level: "low", model: "opus" });
    expect(refused.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(refused.modelWarning ?? "").toContain('"opus"');
  });

  test("L1-D3: unknown level throws naming the valid levels, never falls back", () => {
    expect(() => resolveLevel(FIXTURE, { level: "ultra" })).toThrow(/low.*medium.*high|low, medium, high/);
    expect(() => resolveLevel(FIXTURE, { level: "ultra" })).toThrow(/ultra/);
    // …and with a parent model available: still throws (the deciding pin raises, never a silent default).
    expect(() => resolveLevel(FIXTURE, { level: "ultra", model: undefined })).toThrow(/Valid levels/);
  });

  test("T-A7: invalid level with an explicit model warns (S5 non-deciding path), deciding raises", () => {
    const r = resolveLevel(FIXTURE, { level: "ultra", model: "openrouter/custom/x" });
    expect(r.model).toBe("openrouter/custom/x");
    expect(r.levelWarning ?? "").toMatch(/ultra/);
    expect(r.levelWarning ?? "").toMatch(/low, medium, high/);
    expect(r.overriddenLevel).toBeUndefined();
  });

  test("T-CASE: level is case-sensitive lowercase-only; surrounding whitespace is stripped", () => {
    for (const bad of ["Low", "LOW", "Medium", "HIGH", " lowx", "loww"]) {
      expect(() => resolveLevel(FIXTURE, { level: bad }), bad).toThrow(InvalidLevelError);
    }
    expect(resolveLevel(FIXTURE, { level: "  low  " }).model).toBe("openrouter/z-ai/glm-5.3-flash");
  });

  test("T-EMPTY: blank level (empty/whitespace) is absent — inherit, never an error", () => {
    expect(resolveLevel(FIXTURE, { level: "" })).toEqual({});
    expect(resolveLevel(FIXTURE, { level: "   " })).toEqual({});
    expect(resolveLevel(FIXTURE, { level: "   ", model: "" })).toEqual({});
  });

  test("T-NOPIN: neither level nor model returns no pin (inherit — omit --model)", () => {
    const r = resolveLevel(FIXTURE, {});
    expect(r.model).toBeUndefined();
    expect(r.resolvedLevel).toBeUndefined();
  });

  test("T-ALIAS: resolver returns the member id, never an alias or weights-sibling", () => {
    // Medium's tail carries aliases + demoted status; high's tail an always-latest alias.
    // Resolving either tier returns index-0's id — the alias strings are unreachable.
    expect(resolveLevel(FIXTURE, { level: "medium" }).model).not.toContain("~");
    expect(resolveLevel(FIXTURE, { level: "high" }).model).toBe("openrouter/meta/muse-spark-1.3-contributor");
  });

  test("T-ERRSHAPE: unknown-level error carries the §5 problem shape", () => {
    let caught: unknown;
    try {
      resolveLevel(FIXTURE, { level: "meduim" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidLevelError);
    const err = caught as InvalidLevelError;
    expect(err.message).toMatch(/meduim/);
    expect(err.message).toMatch(/low, medium, high/);
    expect(err.invalidLevel).toBe("meduim");
    expect(err.validLevels).toEqual(["low", "medium", "high"]);
    expect(err.status).toBe(400);
    expect(err.type).toBe("https://github.com/Arasz/ai-badger/problems/invalid-level");
  });

  test("M8: a resolved id that fails the tight shape is refused, never emitted", () => {
    const bad = (id: unknown): LevelRegistry => ({
      groups: {
        low: [{ id: id as string, preferred: true }],
        medium: FIXTURE.groups.medium,
        high: FIXTURE.groups.high,
      },
    });
    for (const id of ["opus", "--model x", "openrouter/a/b c", ""]) {
      expect(() => resolveLevel(bad(id), { level: "low" }), String(id)).toThrow(/refus|emit|shape|pattern/i);
    }
  });

  test("§4.8: an empty group never auto-picks — it throws naming the rule", () => {
    const empty: LevelRegistry = { groups: { low: [], medium: FIXTURE.groups.medium, high: FIXTURE.groups.high } };
    expect(() => resolveLevel(empty, { level: "low" })).toThrow(/low/);
  });
});

describe("5b resolveDelegationModel — G-6 four-source precedence, verbatim", () => {
  test("tool-override > frontmatter model > level-resolved > session", () => {
    const low = "openrouter/z-ai/glm-5.3-flash";
    // Each rank wins over everything below it.
    expect(resolveDelegationModel(FIXTURE, { sessionModel: "openrouter/s/s" }).model).toBe("openrouter/s/s");
    expect(resolveDelegationModel(FIXTURE, { level: "low", sessionModel: "openrouter/s/s" }).model).toBe(low);
    expect(
      resolveDelegationModel(FIXTURE, { frontmatterModel: "openrouter/f/f", level: "low", sessionModel: "openrouter/s/s" }).model,
    ).toBe("openrouter/f/f");
    expect(
      resolveDelegationModel(FIXTURE, { toolModel: "openrouter/t/t", frontmatterModel: "openrouter/f/f", level: "low", sessionModel: "openrouter/s/s" }).model,
    ).toBe("openrouter/t/t");
  });

  test("blank values at every rank count as absent", () => {
    expect(resolveDelegationModel(FIXTURE, { toolModel: "  ", frontmatterModel: "", level: "low" }).model).toBe(
      "openrouter/z-ai/glm-5.3-flash",
    );
    expect(resolveDelegationModel(FIXTURE, {})).toEqual({});
  });

  test("override record names the beaten level only when a valid level lost to an explicit model", () => {
    const r = resolveDelegationModel(FIXTURE, { frontmatterModel: "openrouter/f/f", level: "low" });
    expect(r.overriddenLevel).toBe("low");
    expect(r.overridingModel).toBe("openrouter/f/f");
    expect(resolveDelegationModel(FIXTURE, { level: "low" }).overriddenLevel).toBeUndefined();
  });
});

describe("5b explicit pin shape gate (M8/H4 — the d-324 class)", () => {
  test("every shape-failing pin is refused before emit; the level resolves instead, warned", () => {
    for (const bad of [
      "sonnet", "Opus", "OPUS", "haiku", "fable-5.1",
      "openrouter/", "openrouter", "openrouter/a/b c", "--model x",
    ]) {
      const r = resolveLevel(FIXTURE, { level: "low", model: bad });
      expect(r.model, bad).toBe("openrouter/z-ai/glm-5.3-flash");
      expect(r.resolvedLevel, bad).toBe("low");
      expect(r.overridingModel, bad).toBeUndefined();
      expect(r.modelWarning ?? "", bad).toContain(`"${bad}"`);
    }
  });

  test("a refused pin with no level resolves nothing — the session rank decides, verbatim and warned", () => {
    const r = resolveLevel(FIXTURE, { model: "sonnet" });
    expect(r.model).toBeUndefined();
    expect(r.modelWarning ?? "").toContain('"sonnet"');
    // G-6 fall-through: the session model decides — parent-proven values pass unvalidated.
    const g = resolveDelegationModel(FIXTURE, { frontmatterModel: "sonnet", sessionModel: "anthropic/claude-x" });
    expect(g.model).toBe("anthropic/claude-x");
    expect(g.modelWarning ?? "").toContain('"sonnet"');
  });

  test("a refused pin no longer rescues an invalid level; an admitted pin still does (S5)", () => {
    expect(() => resolveLevel(FIXTURE, { level: "ultra", model: "sonnet" })).toThrow(InvalidLevelError);
    const r = resolveLevel(FIXTURE, { level: "ultra", model: "openrouter/custom/x" });
    expect(r.model).toBe("openrouter/custom/x");
    expect(r.levelWarning ?? "").toMatch(/ultra/);
  });

  test("admitted pins still win verbatim (G-6) — the gate is shape-only, never a rewrite", () => {
    const r = resolveLevel(FIXTURE, { level: "low", model: "openrouter/custom/explicit" });
    expect(r.model).toBe("openrouter/custom/explicit");
    expect(r.modelWarning).toBeUndefined();
  });

  test("refusals cascade per rank in G-6 order — a refused rank never masks a usable one", () => {
    // rank 1 refused → the admitted rank-2 pin decides (and still beats the level)
    const a = resolveDelegationModel(FIXTURE, {
      toolModel: "sonnet",
      frontmatterModel: "openrouter/f/f",
      level: "low",
      sessionModel: "openrouter/s/p",
    });
    expect(a.model).toBe("openrouter/f/f");
    expect(a.overridingModel).toBe("openrouter/f/f");
    expect(a.modelWarning ?? "").toContain('"sonnet"');
    expect(a.modelWarning ?? "").not.toContain('"openrouter/f/f"');
    // both explicit ranks refused → the level decides, both refusals recorded
    const b = resolveDelegationModel(FIXTURE, { toolModel: "sonnet", frontmatterModel: "opus", level: "low" });
    expect(b.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(b.modelWarning ?? "").toContain('"sonnet"');
    expect(b.modelWarning ?? "").toContain('"opus"');
    // both refused, no level → the session decides, warned
    const c = resolveDelegationModel(FIXTURE, { toolModel: "sonnet", frontmatterModel: "opus", sessionModel: "openrouter/s/p" });
    expect(c.model).toBe("openrouter/s/p");
    expect(c.modelWarning ?? "").toContain('"sonnet"');
    expect(c.modelWarning ?? "").toContain('"opus"');
    // blank stays silent (blank ≡ absent, not refused)
    const d = resolveDelegationModel(FIXTURE, { toolModel: "  ", frontmatterModel: "openrouter/f/f", level: "low" });
    expect(d.modelWarning).toBeUndefined();
    // a refused rank-2 pin is named even when rank 1 decides (S5 non-deciding-pin standard)
    const e = resolveDelegationModel(FIXTURE, { toolModel: "openrouter/t/t", frontmatterModel: "sonnet", level: "low" });
    expect(e.model).toBe("openrouter/t/t");
    expect(e.modelWarning ?? "").toContain('"sonnet"');
  });

  test("argv never carries the refused value (delegationArgs — the argv-build refusal)", () => {
    expect(modelOf(delegationArgs(tierPersona({ level: "low", model: "sonnet" }), "t", "openrouter/s/p", FIXTURE))).toBe(
      "openrouter/z-ai/glm-5.3-flash",
    );
    expect(modelOf(delegationArgs(tierPersona({ model: "sonnet" }), "t", "openrouter/s/p", FIXTURE))).toBe(
      "openrouter/s/p",
    );
    expect(delegationArgs(tierPersona({ model: "sonnet" }), "t", undefined, FIXTURE)).not.toContain("--model");
  });

  test("fallbackArgsFor arms on the level-resolved id after a refused pin, never on session passthrough", () => {
    const PARENT = "openrouter/session/parent";
    const primary = delegationArgs(tierPersona({ level: "low", model: "sonnet" }), "review", PARENT, FIXTURE);
    expect(modelOf(primary)).toBe("openrouter/z-ai/glm-5.3-flash");
    const fallback = fallbackArgsFor(primary, tierPersona({ level: "low", model: "sonnet" }), PARENT, FIXTURE);
    expect(modelOf(fallback!)).toBe(PARENT);
    // refused pin, no level → the argv is already the session model → no identical retry
    const sessionArgv = delegationArgs(tierPersona({ model: "sonnet" }), "review", PARENT, FIXTURE);
    expect(modelOf(sessionArgv)).toBe(PARENT);
    expect(fallbackArgsFor(sessionArgv, tierPersona({ model: "sonnet" }), PARENT, FIXTURE)).toBeUndefined();
  });
});

describe("5b delegationArgs — level wiring (L1-D1..D5, T-NOPIN)", () => {
  test("L1-D1: persona level low resolves to the low preferred (default frozen registry)", () => {
    const args = delegationArgs(tierPersona({ level: "low" }), "Draft the plan", "openrouter/session/parent");
    expect(modelOf(args)).toBe("openrouter/z-ai/glm-5.3-flash");
  });

  test("L1-D1: every tier resolves against an explicit registry fixture", () => {
    expect(modelOf(delegationArgs(tierPersona({ level: "low" }), "t", "openrouter/s/p", FIXTURE))).toBe(
      "openrouter/z-ai/glm-5.3-flash",
    );
    expect(modelOf(delegationArgs(tierPersona({ level: "medium" }), "t", "openrouter/s/p", FIXTURE))).toBe(
      "openrouter/meta/muse-spark-1.3-contributor",
    );
    expect(modelOf(delegationArgs(tierPersona({ level: "high" }), "t", undefined, FIXTURE))).toBe(
      "openrouter/meta/muse-spark-1.3-contributor",
    );
  });

  test("L1-D2: explicit frontmatter model beats persona level", () => {
    const args = delegationArgs(tierPersona({ level: "low", model: "openrouter/custom/explicit" }), "t", "openrouter/s/p", FIXTURE);
    expect(modelOf(args)).toBe("openrouter/custom/explicit");
  });

  test("L1-D3: unknown persona level throws naming valid levels — no argv returned", () => {
    expect(() => delegationArgs(tierPersona({ level: "ultra" }), "t", "openrouter/s/p", FIXTURE)).toThrow(
      /low, medium, high/,
    );
  });

  test("T-NOPIN: no level anywhere keeps today's inherit behavior byte-identical", () => {
    // Session model passes through; no session model means no --model flag at all.
    expect(modelOf(delegationArgs(tierPersona(), "t", "openrouter/s/p", FIXTURE))).toBe("openrouter/s/p");
    expect(delegationArgs(tierPersona(), "t", undefined, FIXTURE)).not.toContain("--model");
  });

  test("L1-D5 + H4: the value after --model always matches the provider/model shape", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const value = modelOf(delegationArgs(tierPersona({ level }), "t", "openrouter/s/p", FIXTURE));
      expect(value ?? `${level}: missing --model`).toMatch(MODEL_ID_PATTERN);
    }
    // The bar itself: bare aliases (any case), incomplete ids, and whitespace never match.
    for (const bad of [
      "opus", "Opus", "OPUS", "sonnet", "Sonnet", "haiku", "Haiku", "fable", "Fable-5.1", "FABLE",
      "openrouter/", "openrouter", "openrouter/a/b ",
    ]) {
      expect(bad).not.toMatch(MODEL_ID_PATTERN);
    }
  });
});

describe("5b fallbackArgsFor — level-resolved pins (L1-D4)", () => {
  const PARENT = "openrouter/session/parent";

  test("swaps a level-resolved pin for the parent model", () => {
    const primary = delegationArgs(tierPersona({ level: "low" }), "review", PARENT, FIXTURE);
    expect(modelOf(primary)).toBe("openrouter/z-ai/glm-5.3-flash");
    const fallback = fallbackArgsFor(primary, tierPersona({ level: "low" }), PARENT, FIXTURE);
    expect(modelOf(fallback!)).toBe(PARENT);
    expect(primary[primary.indexOf("--model") + 1]).toBe("openrouter/z-ai/glm-5.3-flash"); // primary untouched
  });

  test("drops the --model pair when no parent model is known", () => {
    const primary = delegationArgs(tierPersona({ level: "low" }), "review", undefined, FIXTURE);
    const fallback = fallbackArgsFor(primary, tierPersona({ level: "low" }), undefined, FIXTURE);
    expect(fallback).not.toContain("--model");
  });

  test("returns undefined when the argv --model is not the level-resolved id (defensive)", () => {
    const primary = delegationArgs(tierPersona({ level: "low" }), "review", PARENT, FIXTURE);
    const tampered = [...primary];
    tampered[tampered.indexOf("--model") + 1] = "openrouter/other/model";
    expect(fallbackArgsFor(tampered, tierPersona({ level: "low" }), PARENT, FIXTURE)).toBeUndefined();
  });

  test("an undecidable level (invalid) yields no fallback instead of throwing", () => {
    const primary = delegationArgs(tierPersona({ model: "openrouter/custom/x" }), "review", PARENT, FIXTURE);
    expect(fallbackArgsFor(primary, tierPersona({ level: "ultra" }), PARENT, FIXTURE)).toBeUndefined();
  });
});

describe("5b parsePersona — dual-key frontmatter (G-2/G-3)", () => {
  test("level: parses trimmed alongside model:", () => {
    expect(parsePersona("---\nname: a\ndescription: D\nlevel: medium\n---\nbody", "/p/a.md")).toEqual({
      name: "a",
      description: "D",
      level: "medium",
      systemPrompt: "body",
      filePath: "/p/a.md",
    });
    expect(
      parsePersona("---\nname: a\ndescription: D\nlevel: low \nmodel: opus\n---\nbody", "/p/a.md"),
    ).toMatchObject({ level: "low", model: "opus" });
  });

  test("blank or non-string level: is no pin — the persona still parses (validation is at resolve time)", () => {
    for (const level of ['""', '"   "', "42", "[a, b]"]) {
      const parsed = parsePersona(`---\nname: a\ndescription: D\nlevel: ${level}\n---\nbody`, "/p/a.md");
      expect("error" in parsed).toBe(false);
      if (!("error" in parsed)) expect(parsed.level).toBeUndefined();
    }
  });

  test("scanPersonas passes level: through from delivered .pi/agents files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aib-pkg5-5b-"));
    try {
      const agents = join(dir, ...AGENTS_DIR);
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "leveled.md"), "---\nname: leveled\ndescription: L\nlevel: high\n---\nbody\n");
      const scan = scanPersonas(dir);
      expect(scan.errors).toEqual([]);
      expect(scan.personas.find((p) => p.name === "leveled")?.level).toBe("high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("5b levelOverride note (acceptance 3 — recorded like modelFallback)", () => {
  const baseNote: DelegationNote = {
    id: "d-1",
    agent: "architect",
    task: "t",
    state: "completed",
    exitCode: 0,
    answer: "done",
  };

  test("notificationVerdict names the explicit-model-over-level override", () => {
    const verdict = notificationVerdict({
      ...baseNote,
      levelOverride: 'explicit model "openrouter/custom/x" overrode level "low"',
    });
    expect(verdict).toContain("completed");
    expect(verdict).toContain('explicit model "openrouter/custom/x" overrode level "low"');
  });

  test("no override recorded means the verdict is byte-identical to today", () => {
    expect(notificationVerdict(baseNote)).toBe("Delegation d-1 (architect) completed.");
  });
});

describe("modelWarning note (M8/H4 follow-up — refusals ride the completion card)", () => {
  const baseNote: DelegationNote = {
    id: "d-1",
    agent: "architect",
    task: "t",
    state: "completed",
    exitCode: 0,
    answer: "done",
  };
  const REFUSAL = 'explicit model "sonnet" fails /shape/ — refusing to emit it into --model argv';

  test("notificationVerdict names the refused pin", () => {
    const verdict = notificationVerdict({ ...baseNote, modelWarning: REFUSAL });
    expect(verdict).toContain("completed");
    expect(verdict).toContain('explicit model "sonnet"');
    expect(verdict).toContain("refusing to emit it into --model argv");
  });

  test("refusal, fallback and override clauses all render on one verdict", () => {
    const verdict = notificationVerdict({
      ...baseNote,
      modelWarning: REFUSAL,
      modelFallback: '--model openrouter/x/y was rejected (boom) — retried on --model openrouter/z-ai/glm-5.3-flash',
      levelOverride: 'explicit model "openrouter/x/y" overrode level "low"',
    });
    expect(verdict).toContain("refusing to emit it into --model argv");
    expect(verdict).toContain("was rejected (boom)");
    expect(verdict).toContain('overrode level "low"');
  });

  test("no refusal recorded means the verdict is byte-identical to today", () => {
    expect(notificationVerdict(baseNote)).toBe("Delegation d-1 (architect) completed.");
  });

  test("a refused pin rides the run's completion card — verdict line and details (e2e)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aib-mw-card-"));
    const logDir = mkdtempSync(join(tmpdir(), "aib-mw-card-logs-"));
    try {
      const pi = createFakePi();
      const children: FakeChild[] = [];
      const spawnFn = () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      };
      subagent(pi as never, { spawnFn, logDir, now: () => Date.now(), escalateAfterMs: 0 });
      const agents = join(projectDir, ...AGENTS_DIR);
      mkdirSync(agents, { recursive: true });
      // The d-324 class again: `model: sonnet` (bare alias) beside a valid level.
      writeFileSync(join(agents, "pinned.md"), "---\nname: pinned\ndescription: P\nmodel: sonnet\nlevel: high\n---\nbody\n");
      const ctx = {
        ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
        mode: "tui",
        hasUI: true,
        cwd: projectDir,
        sessionManager: { getSessionId: () => "sess-test" },
        model: undefined,
        signal: undefined,
      };
      const tool = (pi.tools as Map<string, any>).get("delegate");
      await tool.execute("call-mw", { agent: "pinned", task: "do it" }, undefined, undefined, ctx);
      // Settle the run: the refusal rides the card verdict AND the note (details).
      children[0]!.write(`${JSON.stringify({ type: "session", version: 3, id: "c", cwd: "/p" })}\n`);
      children[0]!.write(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "did it" }] } })}\n`,
      );
      children[0]!.exit(0);
      const card = (pi.sent as Array<{ message: { content: unknown; details: unknown } }>)[0]!.message;
      expect(String(card.content)).toContain("refusing to emit it into --model argv");
      expect(String(card.content)).toContain('"sonnet"');
      expect(String((card.details as Record<string, unknown>).modelWarning)).toContain('"sonnet"');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("5b delegate tool — level end to end (frozen degrade + override record)", () => {
  test("persona with model:+level: receipts the explicit model and records the override", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aib-pkg5-e2e-"));
    const logDir = mkdtempSync(join(tmpdir(), "aib-pkg5-e2e-logs-"));
    try {
      const pi = createFakePi();
      const children: FakeChild[] = [];
      const spawnFn = () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      };
      subagent(pi as never, { spawnFn, logDir, now: () => Date.now(), escalateAfterMs: 0 });
      const agents = join(projectDir, ...AGENTS_DIR);
      mkdirSync(agents, { recursive: true });
      writeFileSync(
        join(agents, "both.md"),
        "---\nname: both\ndescription: B\nmodel: openrouter/custom/explicit\nlevel: low\n---\nbody\n",
      );
      const notifications: string[] = [];
      const ctx = {
        ui: { notify: (m: string) => notifications.push(m), setWidget: () => {}, setStatus: () => {} },
        mode: "tui",
        hasUI: true,
        cwd: projectDir,
        sessionManager: { getSessionId: () => "sess-test" },
        model: undefined,
        signal: undefined,
      };
      const tool = (pi.tools as Map<string, any>).get("delegate");
      const receipt = await tool.execute("call-1", { agent: "both", task: "do it" }, undefined, undefined, ctx);
      // Explicit model wins over the level; the override rides the receipt details …
      expect((receipt.details as Record<string, unknown>).levelOverride).toBe(
        'explicit model "openrouter/custom/explicit" overrode level "low"',
      );
      // … the child spawns on the explicit model …
      const spawned = children[0] as FakeChild & { args?: string[] };
      expect(spawned).toBeDefined();
      // … and the missing project registry degraded loudly to frozen (absence rule UX).
      expect(notifications.join("\n")).toMatch(/model-groups\.json.*frozen/i);
      // Settle the run: the followUp card names the override like modelFallback.
      children[0]!.write(`${JSON.stringify({ type: "session", version: 3, id: "c", cwd: "/p" })}\n`);
      children[0]!.write(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "did it" }] } })}\n`,
      );
      children[0]!.exit(0);
      const card = (pi.sent as Array<{ message: { content: unknown; details: unknown } }>)[0]!.message;
      expect(String(card.content)).toContain('explicit model "openrouter/custom/explicit" overrode level "low"');
      expect((card.details as Record<string, unknown>).levelOverride).toBe(
        'explicit model "openrouter/custom/explicit" overrode level "low"',
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("d-324 class: a bare model: pin is refused at argv-build — the level id spawns, refusal notified", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aib-pkg5-gate-"));
    const logDir = mkdtempSync(join(tmpdir(), "aib-pkg5-gate-logs-"));
    try {
      const pi = createFakePi();
      const children: FakeChild[] = [];
      const spawnedArgs: string[][] = [];
      const spawnFn = (_command: string, args: string[]) => {
        spawnedArgs.push([...args]);
        const child = new FakeChild();
        children.push(child);
        return child;
      };
      subagent(pi as never, { spawnFn, logDir, now: () => Date.now(), escalateAfterMs: 0 });
      const agents = join(projectDir, ...AGENTS_DIR);
      mkdirSync(agents, { recursive: true });
      // The incident in miniature: `model: sonnet` (bare alias) beside a valid level.
      writeFileSync(join(agents, "pinned.md"), "---\nname: pinned\ndescription: P\nmodel: sonnet\nlevel: high\n---\nbody\n");
      const notifications: string[] = [];
      const ctx = {
        ui: { notify: (m: string) => notifications.push(m), setWidget: () => {}, setStatus: () => {} },
        mode: "tui",
        hasUI: true,
        cwd: projectDir,
        sessionManager: { getSessionId: () => "sess-test" },
        model: undefined,
        signal: undefined,
      };
      const tool = (pi.tools as Map<string, any>).get("delegate");
      await tool.execute("call-gate", { agent: "pinned", task: "do it" }, undefined, undefined, ctx);
      // The bare pin never reached argv — the high preferred spawned instead (frozen registry).
      expect(modelOf(spawnedArgs[0]!)).toBe("openrouter/deepseek/deepseek-v4.1-flash");
      expect(spawnedArgs[0]).not.toContain("sonnet");
      // The refusal is recorded at dispatch (S5 standard) — never silent.
      expect(notifications.join("\n")).toContain('"sonnet"');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
