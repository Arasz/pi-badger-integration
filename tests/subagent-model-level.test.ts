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
import { FROZEN_MODEL_GROUPS, VALID_LEVELS } from "../extensions/subagent/delegation-core.ts";
import { loadModelGroups } from "../extensions/subagent/index.ts";

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
  test("frozen carries the PKG-1 preferred pins (source: tiers/pkg1-registry canonical)", () => {
    expect(FROZEN_MODEL_GROUPS.groups.low[0]?.id).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(FROZEN_MODEL_GROUPS.groups.medium[0]?.id).toBe("openrouter/meta/muse-spark-1.3-contributor");
    expect(FROZEN_MODEL_GROUPS.groups.high[0]?.id).toBe("openrouter/meta/muse-spark-1.3-contributor");
  });

  test("closed level set is exactly low|medium|high", () => {
    expect([...VALID_LEVELS]).toEqual(["low", "medium", "high"]);
    expect(Object.keys(FROZEN_MODEL_GROUPS.groups).sort()).toEqual(["high", "low", "medium"]);
  });
});
