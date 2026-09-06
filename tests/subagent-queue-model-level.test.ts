/**
 * PKG-5 5c — queue-tool schema `level` param + tool-override plumbing (G-6).
 *
 * Group `level:` resolves every member through the same G-6 order the delegate tool uses
 * (tool-override group `model:` > frontmatter `model:` > `level:`-resolved > session);
 * effective level = group param ?? persona file pin. Unknown group level is a usage error
 * (G5-gap closed — live caller input fails fast, even when overridden); an invalid
 * *file* level follows S5 (deciding → throw, overridden → warn). The value after --model
 * always matches the tight openrouter shape (H4 matrix).
 *
 * TDD note: written FIRST per lane TDD discipline; RED witnessed before the 5c
 * implementation commit (see lane report).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeChild } from "./helpers/fake-child.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { AGENTS_DIR } from "../extensions/subagent/index.ts";
import { MODEL_ID_PATTERN } from "../extensions/subagent/delegation-core.ts";
import subagent from "../extensions/subagent/index.ts";

const LOW_PREF = "openrouter/z-ai/glm-5.3-flash";
const MED_PREF = "openrouter/meta/muse-spark-1.3-contributor";

interface Harness {
  tools: Map<string, any>;
  children: FakeChild[];
  spawnedArgs: string[][];
  notifications: string[];
  projectDir: string;
  logDir: string;
}

let h: Harness;
afterEach(() => {
  if (h) {
    rmSync(h.projectDir, { recursive: true, force: true });
    rmSync(h.logDir, { recursive: true, force: true });
  }
});

function personaFile(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} specialist.\n${extra}---\n\n# ${name}\n`;
}

function makeHarness(personas: Record<string, string> = {}): Harness {
  const pi = createFakePi();
  const harness: Harness = {
    tools: pi.tools as Map<string, any>,
    children: [],
    spawnedArgs: [],
    notifications: [],
    projectDir: mkdtempSync(join(tmpdir(), "aib-pkg5-queue-")),
    logDir: mkdtempSync(join(tmpdir(), "aib-pkg5-queue-logs-")),
    api: undefined,
  } as unknown as Harness;
  const agents = join(harness.projectDir, ...AGENTS_DIR);
  mkdirSync(agents, { recursive: true });
  const files = Object.keys(personas).length > 0 ? personas : { architect: "", tester: "" };
  for (const [name, extra] of Object.entries(files)) {
    writeFileSync(join(agents, `${name}.md`), personaFile(name, extra));
  }
  const spawnFn = (_command: string, args: string[], _options: { cwd: string }) => {
    harness.spawnedArgs.push([...args]);
    const child = new FakeChild();
    harness.children.push(child);
    return child;
  };
  subagent(pi as never, { spawnFn, logDir: harness.logDir, now: () => Date.now(), escalateAfterMs: 0 });
  h = harness;
  return harness;
}

function makeCtx(cwd?: string): unknown {
  return {
    ui: { notify: (message: string) => h.notifications.push(message), setWidget: () => {}, setStatus: () => {} },
    mode: "tui",
    hasUI: true,
    cwd: cwd ?? h.projectDir,
    sessionManager: { getSessionId: () => "sess-test" },
    model: undefined,
    signal: undefined,
  };
}

function callQueue(params: Record<string, unknown>, ctx?: unknown, toolCallId = "call-q"): Promise<{ content: Array<{ text: string }>; details: any }> {
  return h.tools.get("queue").execute(toolCallId, params, undefined, undefined, ctx ?? makeCtx());
}

const modelOf = (args: string[]): string | undefined => {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
};

describe("5c queue level param — resolution (G-6)", () => {
  test("add with level low spawns every drained member on the low preferred", async () => {
    makeHarness();
    const result = await callQueue({ action: "add", agent: "architect", tasks: ["one"], level: "low" });
    expect(modelOf(h.spawnedArgs[0]!)).toBe(LOW_PREF);
    expect(result.details.mode).toBe("serial");
  });

  test("add-parallel with level medium resolves all members to the medium preferred", async () => {
    makeHarness();
    await callQueue({
      action: "add-parallel",
      tasks: [
        { agent: "architect", task: "p1" },
        { agent: "tester", task: "p2" },
      ],
      level: "medium",
    });
    expect(h.spawnedArgs).toHaveLength(2);
    for (const args of h.spawnedArgs) expect(modelOf(args)).toBe(MED_PREF);
  });

  test("group model beats group level (G-6 rank 1 > 3) and the override is recorded", async () => {
    makeHarness();
    const result = await callQueue({
      action: "add",
      agent: "architect",
      tasks: ["one"],
      level: "low",
      model: "openrouter/custom/tool",
    });
    expect(modelOf(h.spawnedArgs[0]!)).toBe("openrouter/custom/tool");
    expect(result.details.tasks[0].levelOverride).toBe('explicit model "openrouter/custom/tool" overrode level "low"');
  });

  test("group level beats the persona file level (call-time beats file)", async () => {
    makeHarness({ architect: "level: high\n" });
    await callQueue({ action: "add", agent: "architect", tasks: ["one"], level: "low" });
    expect(modelOf(h.spawnedArgs[0]!)).toBe(LOW_PREF);
  });

  test("persona file level resolves when the group passes none", async () => {
    makeHarness({ architect: "level: medium\n" });
    await callQueue({ action: "add", agent: "architect", tasks: ["one"] });
    expect(modelOf(h.spawnedArgs[0]!)).toBe(MED_PREF);
  });

  test("frontmatter model beats group level (G-6 rank 2 > 3) and the override is recorded", async () => {
    makeHarness({ architect: "model: openrouter/custom/pin\nlevel: low\n" });
    const result = await callQueue({ action: "add", agent: "architect", tasks: ["one"], level: "high" });
    expect(modelOf(h.spawnedArgs[0]!)).toBe("openrouter/custom/pin");
    expect(result.details.tasks[0].levelOverride).toBe('explicit model "openrouter/custom/pin" overrode level "high"');
  });

  test("no level or model anywhere inherits — no --model flag (T-NOPIN queue half)", async () => {
    makeHarness();
    await callQueue({ action: "add", agent: "architect", tasks: ["one"] });
    expect(h.spawnedArgs[0]).not.toContain("--model");
  });
});

describe("5c queue level param — usage errors (G5-gap closed)", () => {
  test("unknown group level is a usage error naming the valid levels", async () => {
    makeHarness();
    await expect(callQueue({ action: "add", agent: "architect", tasks: ["one"], level: "ultra" })).rejects.toThrow(
      /low, medium, high/,
    );
    expect(h.spawnedArgs).toHaveLength(0); // nothing enqueued, nothing spawned
  });

  test("unknown group level is a usage error even when a group model overrides it", async () => {
    makeHarness();
    await expect(
      callQueue({ action: "add", agent: "architect", tasks: ["one"], level: "Low", model: "openrouter/custom/tool" }),
    ).rejects.toThrow(/Valid levels are low, medium, high/);
    expect(h.spawnedArgs).toHaveLength(0);
  });

  test("invalid persona file level deciding alone fails the call naming the valid levels", async () => {
    makeHarness({ architect: "level: ultra\n" });
    await expect(callQueue({ action: "add", agent: "architect", tasks: ["one"] })).rejects.toThrow(
      /low, medium, high/,
    );
    expect(h.spawnedArgs).toHaveLength(0);
  });

  test("invalid persona file level overridden by a group model warns (S5) and proceeds", async () => {
    makeHarness({ architect: "level: ultra\n" });
    const result = await callQueue({
      action: "add",
      agent: "architect",
      tasks: ["one"],
      model: "openrouter/custom/tool",
    });
    expect(modelOf(h.spawnedArgs[0]!)).toBe("openrouter/custom/tool");
    expect(h.notifications.join("\n")).toMatch(/ultra.*low, medium, high|Unknown level/);
    expect(result.details.tasks[0].levelOverride).toBeUndefined(); // invalid level: nothing valid was overridden
  });
});

describe("5c queue level param — H4 negative matrix on the --model value", () => {
  test("every spawned --model value matches the tight openrouter shape", async () => {
    makeHarness({ architect: "level: high\n", tester: "model: openrouter/custom/ok\n" });
    await callQueue({ action: "add", agent: "architect", tasks: ["a"], level: "low" });
    await callQueue({ action: "add", agent: "architect", tasks: ["b"], level: "medium" }, makeCtx(), "call-2");
    await callQueue(
      { action: "add-parallel", tasks: [{ agent: "architect", task: "c" }, { agent: "tester", task: "d" }] },
      makeCtx(),
      "call-3",
    );
    expect(h.spawnedArgs.length).toBeGreaterThan(0);
    for (const args of h.spawnedArgs) {
      const value = modelOf(args);
      expect(value ?? "missing --model").toMatch(MODEL_ID_PATTERN);
    }
  });
});
