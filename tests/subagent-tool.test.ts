/**
 * Characterization suite for the ai-badger subagent extension's current pure surface —
 * rows 1–7 of `docs/plans/2026-interactive-subagent-delegation.tests.md` (P0).
 *
 * It locks what `extensions/subagent/index.ts` does TODAY — delegationArgs, scanPersonas,
 * capOutput, piInvocation, parsePersona — before the interactive-background-delegation
 * refactor moves that behavior, so the refactor's blocking path can be diffed against this
 * oracle instead of against memory. Characterization, not aspiration: every assertion below
 * was witnessed against the current implementation, and the exact argv/orderings pinned here
 * are the ones the current code emits.
 *
 * Row 1 pins the planned argv (`--mode json`, denylist `delegate,delegations`) that lane P0
 * witnessed RED; lane P3 unskipped it in the same commit as the `delegationArgs` change that
 * satisfies it. Rows 2–3 pinned the pre-P3 argv details that legitimately changed (R3/R6:
 * JSON mode + the two-tool denylist): row 2's full-array expectations were amended consciously
 * to the new argv; row 3's structural assertions (task behind `--`, single `--`) hold unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS_DIR,
  capOutput,
  delegationArgs,
  parsePersona,
  piInvocation,
  scanPersonas,
  type Persona,
} from "../extensions/subagent/index.ts";

/** Exactly what adjust_agents.py writes: two frontmatter keys, then the managed header. */
const SCAFFOLDED = `---
name: architect
description: >
  Architecture and decomposition specialist. Read-only.
---

<!-- Managed by ai-badger. Source of truth: .ai-badger/agents/architect.md. Do not edit this copy by hand; edit the source and re-run welcome-ai-badger. -->

# Architect

Produce a blueprint, never an edit.
`;

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: "architect",
    description: "Architecture specialist",
    systemPrompt: "# Architect\n",
    filePath: "/tmp/architect.md",
    ...overrides,
  };
}

describe("delegationArgs", () => {
  // row 1 — witnessed RED in lane P0; unskipped in P3 together with the argv change that
  // satisfies it (`--mode json` + the delegate,delegations denylist, R3/R6).
  test("row 1 — argv carries JSON mode + new denylist", () => {
    const args = delegationArgs(persona({ systemPrompt: "" }), "Draft the plan");

    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--exclude-tools",
      "delegate,delegations",
    ]);
    const dash = args.indexOf("--");
    expect(dash).toBeGreaterThan(0);
    expect(args.slice(dash + 1)).toEqual(["Draft the plan"]);
  });

  test("row 2 — argv keeps persona prompt and model", () => {
    const args = delegationArgs(persona(), "Draft the plan", "openrouter/moonshotai/kimi-k2.6");

    // Full-array equality pins the ordering: JSON mode, then flags, then model, then the
    // persona's body, then `--` and the task. (Amended in P3 for the row-1 argv change: the
    // pre-P3 array lacked `--mode json` and excluded only `delegate`.)
    expect(args).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--exclude-tools",
      "delegate,delegations",
      "--model",
      "openrouter/moonshotai/kimi-k2.6",
      "--append-system-prompt",
      "# Architect\n",
      "--",
      "Draft the plan",
    ]);
  });

  test("row 2 — an empty body omits --append-system-prompt even when a model is present", () => {
    const args = delegationArgs(persona({ systemPrompt: "  \n" }), "t", "m");

    // Amended in P3 for the row-1 argv change (same reason as above).
    expect(args).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--exclude-tools",
      "delegate,delegations",
      "--model",
      "m",
      "--",
      "t",
    ]);
    expect(args).not.toContain("--append-system-prompt");
  });

  test("row 3 — argv escapes a task starting with `-`", () => {
    const args = delegationArgs(persona(), "--danger");

    // The task lands behind `--` and is the final token; it appears nowhere else, so no
    // option parser can mistake it for a flag.
    expect(args.slice(-2)).toEqual(["--", "--danger"]);
    expect(args.indexOf("--danger")).toBe(args.length - 1);
    expect(args.filter((a) => a === "--")).toHaveLength(1);
  });

  test("persona `model:` pin takes precedence over the delegating session's model", () => {
    // The pin is the point of the field: a persona that names a model must never silently run
    // on the session's model. The session model is only the fallback when no pin exists.
    const pinned = delegationArgs(
      persona({ model: "opus" }), "Draft the plan", "openrouter/z-ai/glm-5.3-flash");
    expect(pinned).toContain("--model");
    expect(pinned[pinned.indexOf("--model") + 1]).toBe("opus");

    // No pin → the session model is passed through unchanged (row 2's contract).
    const unpinned = delegationArgs(persona(), "Draft the plan", "openrouter/z-ai/glm-5.3-flash");
    expect(unpinned[unpinned.indexOf("--model") + 1]).toBe("openrouter/z-ai/glm-5.3-flash");

    // No pin and no session model → no --model flag at all (the child picks its default).
    expect(delegationArgs(persona(), "t")).not.toContain("--model");
  });
});

describe("scanPersonas", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aib-subagent-tool-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("row 4 — scanPersonas degrades loudly, never throws", () => {
    const agents = join(dir, ...AGENTS_DIR);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "a-architect.md"), SCAFFOLDED);
    writeFileSync(join(agents, "b-noname.md"), "---\ndescription: No name here\n---\nbody\n");
    writeFileSync(join(agents, "c-nodesc.md"), "---\nname: nodesc\n---\nbody\n");
    writeFileSync(join(agents, "d-broken.md"), "---\ndescription: [unclosed\n---\nbody\n");
    writeFileSync(join(agents, "e-unreadable.md"), "---\nname: secret\ndescription: locked\n---\nbody\n");
    chmodSync(join(agents, "e-unreadable.md"), 0o000);
    writeFileSync(join(agents, "f-architect.md"), "---\nname: architect\ndescription: A shadow\n---\nbody\n");
    writeFileSync(join(agents, "notes.txt"), "not a persona");

    const scan = scanPersonas(dir);

    // The valid persona loads; the duplicate keeps first-sorted precedence; non-.md files
    // are silent.
    expect(scan.personas.map((p) => p.name)).toEqual(["architect"]);
    expect(scan.personas[0].filePath).toContain("a-architect.md");
    expect(scan.errors.join("\n")).not.toContain("notes.txt");
    expect(scan.missingDir).toBeUndefined();

    // One line per defective file, in sorted order — missing field, missing field,
    // unparseable YAML, unreadable file — and the scan itself never threw.
    expect(scan.errors).toHaveLength(4);
    expect(scan.errors[0]).toBe("b-noname.md has no `name` in its frontmatter");
    expect(scan.errors[1]).toBe("c-nodesc.md has no `description` in its frontmatter");
    expect(scan.errors[2]).toMatch(/^d-broken\.md could not be parsed \(/);
    expect(scan.errors[3]).toMatch(/^e-unreadable\.md could not be read \(/);

    // Duplicates are listed, naming both the shadowed file and the file that keeps the name.
    expect(scan.duplicates).toEqual([
      "architect: f-architect.md is shadowed by a-architect.md and will never be delegated to",
    ]);
  });

  test("row 4 — .missingDir is set only when the directory is absent", () => {
    const scan = scanPersonas(join(dir, "nope"));

    expect(scan.missingDir).toBe(join(dir, "nope", ...AGENTS_DIR));
    expect(scan.personas).toEqual([]);
    expect(scan.errors).toEqual([]);
  });

  test("a persona file's `model:` pin survives the directory scan", () => {
    const agents = join(dir, ...AGENTS_DIR);
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "pinned.md"), "---\nname: pinned\ndescription: P\nmodel: opus\n---\nbody\n");
    writeFileSync(join(agents, "unpinned.md"), "---\nname: unpinned\ndescription: U\n---\nbody\n");

    const scan = scanPersonas(dir);
    expect(scan.errors).toEqual([]);
    expect(scan.personas.find((p) => p.name === "pinned")?.model).toBe("opus");
    expect(scan.personas.find((p) => p.name === "unpinned")?.model).toBeUndefined();
  });
});

describe("capOutput", () => {
  test("row 5 — capOutput keeps tail, marks drop", () => {
    const text = "0123456789".repeat(10); // 100 chars, head and tail recognizably equal
    const capped = capOutput(text, 40);

    // The marker names the exact dropped count; the kept payload is the last `limit` chars.
    expect(capped).toBe(`[...60 earlier characters dropped]\n${text.slice(-40)}`);
    // Secondary observable: the kept tail is bounded by the limit even though the marker
    // adds overhead on top of it.
    expect(capped.slice(capped.indexOf("\n") + 1)).toHaveLength(40);
    expect(capped.length).toBe("[...60 earlier characters dropped]".length + 1 + 40);
  });

  test("row 5 — output at or under the limit is returned untouched", () => {
    expect(capOutput("short", 100)).toBe("short");
    expect(capOutput("exact", 5)).toBe("exact");
  });
});

describe("piInvocation", () => {
  test("row 6 — piInvocation picks script/execPath/fallback", () => {
    // Bun's virtual script path falls through to `pi` on PATH — the property intersection
    // worth pinning: even exists() returning true cannot make /$bunfs/root/… a runnable script.
    expect(piInvocation(["-p"], { argv: ["bun", "/$bunfs/root/pi"], execPath: "/bin/bun" }, () => true))
      .toEqual({ command: "pi", args: ["-p"] });

    // A real script on disk: re-run it with this process's own execPath.
    expect(piInvocation(["-p"], { argv: ["node", "/opt/pi/cli.js"], execPath: "/usr/bin/node" }, () => true))
      .toEqual({ command: "/usr/bin/node", args: ["/opt/pi/cli.js", "-p"] });

    // Node (or bun) with no script path at all: `pi` on PATH is the fallback.
    expect(piInvocation(["-p"], { argv: ["node"], execPath: "/usr/bin/node" }, () => false))
      .toEqual({ command: "pi", args: ["-p"] });

    // A non-node/bun executable is itself the pi binary: no script prefix, no PATH fallback.
    expect(piInvocation(["-p"], { argv: ["/usr/local/bin/pi"], execPath: "/usr/local/bin/pi" }, () => false))
      .toEqual({ command: "/usr/local/bin/pi", args: ["-p"] });
  });
});

describe("parsePersona", () => {
  test("row 7 — parsePersona rejects missing fields", () => {
    expect(parsePersona("---\ndescription: Reads things\n---\nbody", "/p/.pi/agents/anonymous.md"))
      .toEqual({ error: "anonymous.md has no `name` in its frontmatter" });
    expect(parsePersona("---\nname: named\n---\nbody", "/p/.pi/agents/undescribed.md"))
      .toEqual({ error: "undescribed.md has no `description` in its frontmatter" });
  });

  test("row 7 — a blank or non-string field counts as missing, and errors use the basename", () => {
    expect(parsePersona('---\nname: "   "\ndescription: D\n---\nbody', "/p/.pi/agents/blank.md"))
      .toEqual({ error: "blank.md has no `name` in its frontmatter" });
    expect(parsePersona("---\nname: 42\ndescription: D\n---\nbody", "/p/blanker.md"))
      .toEqual({ error: "blanker.md has no `name` in its frontmatter" });
  });

  test("a `model:` pin parses into Persona.model, trimmed", () => {
    const parsed = parsePersona(
      "---\nname: architect\ndescription: D\nmodel: opus\n---\nbody", "/p/.pi/agents/architect.md");
    expect(parsed).toEqual({
      name: "architect",
      description: "D",
      model: "opus",
      systemPrompt: "body",
      filePath: "/p/.pi/agents/architect.md",
    });
    // Whitespace around the value is the file's, not part of the pin.
    expect(parsePersona("---\nname: a\ndescription: D\nmodel: opus \n---\nb", "/p/a.md"))
      .toMatchObject({ model: "opus" });
  });

  test("a blank, empty, or non-string `model:` is no pin at all — the persona still parses", () => {
    // The pin is a routing preference, not part of the persona's identity: an unusable value
    // leaves the persona unpinned (session model fallback) rather than invalidating the file.
    for (const model of ['""', '"   "', "42", "[a, b]"]) {
      const parsed = parsePersona(
        `---\nname: a\ndescription: D\nmodel: ${model}\n---\nbody`, "/p/a.md");
      expect("error" in parsed).toBe(false);
      if (!("error" in parsed)) expect(parsed.model).toBeUndefined();
    }
    // No model key at all — the scaffolded shape — stays exactly as it was.
    expect(parsePersona("---\nname: a\ndescription: D\n---\nbody", "/p/a.md"))
      .toEqual({ name: "a", description: "D", systemPrompt: "body", filePath: "/p/a.md" });
  });
});
