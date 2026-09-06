/**
 * JOIN integration for the model-tier wave (tiers/int): cross-package assertions no
 * PKG-5 lane test owns. The lane files pin their own surfaces (5a registry source,
 * 5b resolver/argv/fallback, 5c queue tool); this file pins the JOINS:
 *
 *   7a  frozen fallback == the PKG-1 canonical preferred pins (triangulated with
 *       ai-badger's tests/test_model_tiers_integration.py, which pins the same
 *       three ids against the shipped registry), the PKG-5 ADR names them, and a
 *       project registry file wins over frozen (import path decides).
 *   7b  pi-child spawn matrix through the REAL delegate tool with spawn capture
 *       (FakeChild): low|medium|high resolve to the preferred pins, an explicit
 *       frontmatter model wins verbatim over a level, absent-everything inherits
 *       (no --model without a session model; the session model with one), and an
 *       unknown deciding level rejects with nothing spawned.
 *
 * Reading guide: "Claude-shim" half of the 7b matrix (model_groups.resolve over
 * the shipped registry) lives in ai-badger's tests/test_model_tiers_integration.py;
 * this file is the pi-child half. The argv-shape matrix in the lane files is the
 * gated unit test; this file drives the same shapes through spawn.
 *
 * G2 live-auth canary is deliberately NOT here: it needs credentials and is a
 * manual checklist line, never a gate.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChild } from "./helpers/fake-child.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { FROZEN_MODEL_GROUPS, MODEL_ID_PATTERN } from "../extensions/subagent/delegation-core.ts";
import {
  AGENTS_DIR,
  delegationArgs,
  loadModelGroups,
} from "../extensions/subagent/index.ts";
import subagent from "../extensions/subagent/index.ts";

// Canonical preferred pins (source: tiers/pkg1-registry canonical seed, measured
// 2026-09-05; triangulated with ai-badger tests/test_model_tiers_integration.py).
const LOW_PREF = "openrouter/z-ai/glm-5.3-flash";
const MED_PREF = "openrouter/meta/muse-spark-1.3-contributor";
const HIGH_PREF = "openrouter/meta/muse-spark-1.3-contributor";

const ADR_PATH = new URL("../docs/work/2026-09-06-pkg5-level-registry-adr.md", import.meta.url);

function projectFile(dir: string, obj: unknown): void {
  const dot = join(dir, ".ai-badger");
  mkdirSync(dot, { recursive: true });
  writeFileSync(join(dot, "model-groups.json"), JSON.stringify(obj));
}

const member = (id: string, preferred = false) => ({ id, preferred });

function canonicalProjectFile(dir: string): void {
  projectFile(dir, {
    registryVersion: 1,
    groups: {
      low: [member(LOW_PREF, true)],
      medium: [member(MED_PREF, true)],
      high: [member(HIGH_PREF, true)],
    },
  });
}

describe("join 7a — frozen fallback triangulates the PKG-1 canonical pins", () => {
  test("FROZEN preferred ids are the canonical three", () => {
    expect(FROZEN_MODEL_GROUPS.groups.low[0]?.id).toBe(LOW_PREF);
    expect(FROZEN_MODEL_GROUPS.groups.medium[0]?.id).toBe(MED_PREF);
    expect(FROZEN_MODEL_GROUPS.groups.high[0]?.id).toBe(HIGH_PREF);
  });

  test("the PKG-5 ADR names the same three pins (prose == registry, not eyeball)", async () => {
    const text = await Bun.file(ADR_PATH).text();
    for (const pin of [LOW_PREF, MED_PREF, HIGH_PREF]) {
      expect(text).toContain(pin);
    }
  });

  test("a project registry wins over frozen (import path decides, not the fallback)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aib-join-import-"));
    try {
      const DISTINCT = "openrouter/join/probe-low";
      projectFile(dir, {
        registryVersion: 1,
        groups: {
          low: [member(DISTINCT, true)],
          medium: [member(MED_PREF, true)],
          high: [member(HIGH_PREF, true)],
        },
      });
      const loaded = loadModelGroups(dir);
      expect(loaded.source).toBe("project");
      const args = delegationArgs(
        { systemPrompt: "s", level: "low" } as never,
        "t",
        undefined,
        loaded.registry,
      );
      const i = args.indexOf("--model");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe(DISTINCT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ 7b spawn matrix

interface SpawnCell {
  command: string;
  args: string[];
}

function personaFile(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} specialist.\n${extra}---\n\n# ${name}\n`;
}

async function runDelegate(
  personas: Record<string, string>,
  params: Record<string, unknown>,
  opts: { sessionModel?: { provider: string; id: string }; projectFile?: "canonical" | "none" } = {},
): Promise<{ spawns: SpawnCell[]; receipt: unknown }> {
  const projectDir = mkdtempSync(join(tmpdir(), "aib-join-dlg-"));
  const logDir = mkdtempSync(join(tmpdir(), "aib-join-dlg-logs-"));
  try {
    if (opts.projectFile !== "none") canonicalProjectFile(projectDir);
    const agents = join(projectDir, ...AGENTS_DIR);
    mkdirSync(agents, { recursive: true });
    for (const [name, extra] of Object.entries(personas)) {
      writeFileSync(join(agents, `${name}.md`), personaFile(name, extra));
    }
    const pi = createFakePi();
    const spawns: SpawnCell[] = [];
    const children: FakeChild[] = [];
    const spawnFn = (command: string, args: string[], _options: { cwd: string }) => {
      spawns.push({ command, args: [...args] });
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    subagent(pi as never, { spawnFn, logDir, now: () => Date.now(), escalateAfterMs: 0 });
    const notifications: string[] = [];
    const ctx = {
      ui: { notify: (m: string) => notifications.push(m), setWidget: () => {}, setStatus: () => {} },
      mode: "tui",
      hasUI: true,
      cwd: projectDir,
      sessionManager: { getSessionId: () => "sess-join" },
      model: opts.sessionModel,
      signal: undefined,
    };
    const tool = (pi.tools as Map<string, any>).get("delegate");
    const pending = tool.execute("call-join", params, undefined, undefined, ctx) as Promise<unknown>;
    // Settle every spawned child: session envelope, one answer, clean exit.
    for (const child of children) {
      child.write(`${JSON.stringify({ type: "session", version: 3, id: "c", cwd: "/p" })}\n`);
      child.write(
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
      );
      child.exit(0);
    }
    const receipt = await pending;
    return { spawns, receipt };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
}

const modelOf = (args: string[]): string | undefined => {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
};

describe("join 7b — delegate spawn matrix (pi child, spawn capture)", () => {
  test("level low|medium|high spawns on the preferred pin", async () => {
    for (const [persona, expected] of [
      [{ low: "level: low\n" }, LOW_PREF],
      [{ med: "level: medium\n" }, MED_PREF],
      [{ hi: "level: high\n" }, HIGH_PREF],
    ] as const) {
      const name = Object.keys(persona)[0]!;
      const { spawns } = await runDelegate(persona, { agent: name, task: "do it" });
      expect(spawns).toHaveLength(1);
      expect(modelOf(spawns[0]!.args)).toBe(expected);
      expect(spawns[0]!.args).toContain("--");
    }
  });

  test("explicit frontmatter model wins verbatim over a level (override)", async () => {
    const { spawns } = await runDelegate(
      { both: "level: low\nmodel: openrouter/custom/explicit\n" },
      { agent: "both", task: "do it" },
    );
    expect(spawns).toHaveLength(1);
    expect(modelOf(spawns[0]!.args)).toBe("openrouter/custom/explicit");
  });

  test("absent level and model inherits: no --model without a session model", async () => {
    const { spawns } = await runDelegate({ plain: "" }, { agent: "plain", task: "do it" });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args).not.toContain("--model");
  });

  test("absent level and model inherits the session model when one exists", async () => {
    const { spawns } = await runDelegate({ plain: "" }, { agent: "plain", task: "do it" }, {
      sessionModel: { provider: "openrouter", id: "session/parent" },
    });
    expect(spawns).toHaveLength(1);
    expect(modelOf(spawns[0]!.args)).toBe("openrouter/session/parent");
  });

  test("every spawned --model value matches the tight openrouter shape", async () => {
    const { spawns } = await runDelegate(
      { lo: "level: low\n", both: "level: low\nmodel: openrouter/custom/explicit\n" },
      { agent: "lo", task: "do it" },
    );
    expect(spawns).toHaveLength(1);
    const value = modelOf(spawns[0]!.args);
    expect(value ?? "missing --model").toMatch(MODEL_ID_PATTERN);
  });

  test("unknown deciding level rejects naming the valid levels — nothing spawned", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aib-join-dlg-err-"));
    const logDir = mkdtempSync(join(tmpdir(), "aib-join-dlg-err-logs-"));
    try {
      canonicalProjectFile(projectDir);
      const agents = join(projectDir, ...AGENTS_DIR);
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "bad.md"), personaFile("bad", "level: ultra\n"));
      const pi = createFakePi();
      const spawns: SpawnCell[] = [];
      const spawnFn = (command: string, args: string[], _options: { cwd: string }) => {
        spawns.push({ command, args: [...args] });
        return new FakeChild();
      };
      subagent(pi as never, { spawnFn, logDir, now: () => Date.now(), escalateAfterMs: 0 });
      const ctx = {
        ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
        mode: "tui",
        hasUI: true,
        cwd: projectDir,
        sessionManager: { getSessionId: () => "sess-join" },
        model: undefined,
        signal: undefined,
      };
      const tool = (pi.tools as Map<string, any>).get("delegate");
      await expect(tool.execute("call-err", { agent: "bad", task: "do it" }, undefined, undefined, ctx)).rejects.toThrow(
        /low, medium, high/,
      );
      expect(spawns).toHaveLength(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
