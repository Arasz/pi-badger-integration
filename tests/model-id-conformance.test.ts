import { describe, expect, test } from "bun:test";
import { admitExplicitModel, MODEL_ID_PATTERN, resolveLevel, type LevelRegistry } from "../extensions/subagent/delegation-core.ts";
import matrix from "./fixtures/model-id-conformance.json";
import { delegationArgs, parsePersona } from "../extensions/subagent/index.ts";

// Oracle: docs/work/2026-10-06-provider-model-id-contract.md, shape contract.
// Pure resolution and argv construction: no clock, network, filesystem, env or random input.
describe("provider/model pins", () => {
  test("native explicit pin is admitted unchanged", () => {
    expect(admitExplicitModel("openai/gpt-6.1-sol")).toEqual({ model: "openai/gpt-6.1-sol" });
  });
});

const registry: LevelRegistry = {
  registryVersion: 1,
  groups: {
    low: [{ id: "local/qwen:7b", preferred: true }],
    medium: [{ id: "anthropic/claude-sonnet-5", preferred: true }],
    high: [{ id: "fireworks/accounts/fireworks/models/x", preferred: true }],
  },
};

for (const { id, valid } of matrix) {
  test(`raw shape ${valid ? "accepts" : "rejects"} ${JSON.stringify(id)}`, () => {
    expect(MODEL_ID_PATTERN.test(id)).toBe(valid);
    if (valid) expect(admitExplicitModel(id)).toEqual({ model: id });
    const resolve = () => resolveLevel({ ...registry, groups: { ...registry.groups, low: [{ id }] } }, { level: "low" });
    if (valid) expect(resolve()).toEqual({ model: id, resolvedLevel: "low", registryVersion: 1 });
    else expect(resolve).toThrow(/refusing to/);
  });
}

test("explicit pin trimming stays separate from the raw shape boundary", () => {
  for (const id of [" openai/gpt-6.1-sol ", "openai/gpt-6.1-sol\n", "\topenai/gpt-6.1-sol\r\n"]) {
    expect(MODEL_ID_PATTERN.test(id)).toBe(false);
    expect(admitExplicitModel(id)).toEqual({ model: "openai/gpt-6.1-sol" });
  }
  expect(admitExplicitModel("openai/gpt\n6")).toEqual({ refusal: expect.stringContaining("refusing to emit") });
  expect(admitExplicitModel(" \n")).toEqual({});
});

for (const id of ["openai/gpt-6.1-sol", "local/qwen:7b", "fireworks/accounts/fireworks/models/x", "openai/@preview/gpt-6"]) {
  test(`persona pin passes unchanged to --model: ${id}`, () => {
    const persona = parsePersona(`---\nname: worker\ndescription: work\nmodel: ${id}\n---\n`, "/project/.pi/agents/worker.md");
    if ("error" in persona) throw new Error(persona.error);
    const args = delegationArgs(persona, "task", "openrouter/parent/model", registry);
    const flag = args.indexOf("--model");
    expect(flag).toBeGreaterThan(-1);
    expect(args[flag + 1]).toBe(id);
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(args.slice(-2)).toEqual(["--", "task"]);
  });
}

test("native preferred registry pins resolve with telemetry and unchanged argv", () => {
  for (const [level, id] of [["low", "local/qwen:7b"], ["medium", "anthropic/claude-sonnet-5"], ["high", "fireworks/accounts/fireworks/models/x"]] as const) {
    expect(resolveLevel(registry, { level })).toEqual({ model: id, resolvedLevel: level, registryVersion: 1 });
    const args = delegationArgs({ systemPrompt: "", level }, "task", undefined, registry);
    expect(args[args.indexOf("--model") + 1]).toBe(id);
  }
});
