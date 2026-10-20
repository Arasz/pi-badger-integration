/**
 * The model map's shape (framework 0.210.x): every group is an object carrying a `models`
 * list, and the map has a fourth tier, `top`.
 *
 * The extension reads the delivered `.ai-badger/model-groups.json` at delegation time. When
 * the map's shape moved under it, every level-based delegation silently degraded to the
 * frozen pins — the file was refused, and nothing said why. These tests pin both shapes the
 * extension must read, the fourth tier, and the delivered file itself.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FROZEN_MODEL_GROUPS,
  groupMembers,
  isUsableModelRegistry,
  MODEL_ID_PATTERN,
  resolveDelegationModel,
  resolveLevel,
  VALID_LEVELS,
  type LevelRegistry,
} from "../extensions/subagent/delegation-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const member = (id: string, preferred = false) => ({ id, preferred });

/** The map's shape: a group is an object carrying its members. */
const mapShape = () => ({
  registryVersion: 3,
  groups: {
    low: { models: [member("openrouter/anthropic/claude-haiku-5.5", true)] },
    medium: { models: [member("openrouter/anthropic/claude-sonnet-5.5", true)] },
    high: { models: [member("openrouter/anthropic/claude-opus-5.5", true)] },
    top: { models: [member("openrouter/anthropic/claude-fable-5.1", true)] },
  },
});

/** The shape a pre-0.210 scaffold delivered: a group is the member list itself. */
const legacyShape = () => ({
  registryVersion: 1,
  groups: {
    low: [member("openrouter/z-ai/glm-5.3-flash", true)],
    medium: [member("openrouter/deepseek/deepseek-v4.1-flash", true)],
    high: [member("openrouter/deepseek/deepseek-v4.1-flash", true)],
  },
});

describe("the model map's shape", () => {
  test("the map's shape is a usable registry", () => {
    expect(isUsableModelRegistry(mapShape())).toBe(true);
  });

  test("the legacy list shape is still a usable registry", () => {
    expect(isUsableModelRegistry(legacyShape())).toBe(true);
  });

  test("the fourth tier resolves from the map's shape", () => {
    const registry = mapShape() as unknown as LevelRegistry;
    expect(resolveLevel(registry, { level: "top" }).model).toBe("openrouter/anthropic/claude-fable-5.1");
  });

  test("top is a valid level", () => {
    expect(VALID_LEVELS).toContain("top");
    expect(VALID_LEVELS).toEqual(["low", "medium", "high", "top"]);
  });

  test("a registry without top is usable, and asking for top names the rule", () => {
    const legacy = legacyShape() as unknown as LevelRegistry;
    expect(isUsableModelRegistry(legacy)).toBe(true);
    expect(() => resolveLevel(legacy, { level: "top" })).toThrow(/no usable "top" group/);
  });

  test("an unknown level still names the valid set, top included", () => {
    const registry = mapShape() as unknown as LevelRegistry;
    expect(() => resolveLevel(registry, { level: "ultra" })).toThrow(/low, medium, high, top/);
  });

  test("provider affinity reads the members of the map's shape", () => {
    const registry = {
      registryVersion: 3,
      groups: {
        low: { models: [member("openrouter/anthropic/claude-haiku-5.5", true), member("anthropic/claude-haiku-5.5")] },
        medium: { models: [member("openrouter/anthropic/claude-sonnet-5.5", true)] },
        high: { models: [member("openrouter/anthropic/claude-opus-5.5", true)] },
        top: { models: [member("openrouter/anthropic/claude-fable-5.1", true)] },
      },
    } as unknown as LevelRegistry;
    const resolved = resolveDelegationModel(registry, { level: "low", sessionModel: "anthropic/claude-haiku-4.5" });
    expect(resolved.model).toBe("anthropic/claude-haiku-5.5");
  });

  test("the frozen fallback carries the map's shape and its own pins", () => {
    const low = groupMembers(FROZEN_MODEL_GROUPS.groups.low);
    const medium = groupMembers(FROZEN_MODEL_GROUPS.groups.medium);
    const high = groupMembers(FROZEN_MODEL_GROUPS.groups.high);
    const top = groupMembers(FROZEN_MODEL_GROUPS.groups.top);
    expect(low?.[0]?.id).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(medium?.[0]?.id).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(high?.[0]?.id).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(top?.[0]?.id).toBe("openrouter/anthropic/claude-fable-5.1");
  });

  test("the delivered map is usable by the resolver, and every tier resolves", () => {
    const delivered = JSON.parse(readFileSync(join(root, ".ai-badger", "model-groups.json"), "utf8"));
    expect(isUsableModelRegistry(delivered)).toBe(true);
    const registry = delivered as LevelRegistry;
    for (const level of VALID_LEVELS) {
      const id = resolveLevel(registry, { level }).model;
      expect(id, `${level} resolves`).toBeDefined();
      expect(MODEL_ID_PATTERN.test(id ?? ""), `${level} id is provider-qualified`).toBe(true);
    }
  });
});
