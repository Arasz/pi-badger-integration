/**
 * PKG-2 (A2.1/A2.2 support) — project key resolution and the per-project log layout.
 *
 * The resolver mirrors the message-bus project walk (F5): `AI_BADGER_PROJECT_ID` wins, then
 * the nearest `.ai-badger/project-id`, then the nearest `.git` root, then cwd — every
 * fallback hashed to `p-<sha256(root).slice(0, 12)>` so a project without ai-badger still
 * gets a stable key. The key is a single path segment: sanitized, capped, and never `.`/`..`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashProjectKey, projectLogDir, resolveProjectKey } from "../../extensions/subagent/project-key.ts";

const tempDirs: string[] = [];
function tempDir(prefix = "aib-project-key-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("A2.1 — project key resolution", () => {
  test("project key: AI_BADGER_PROJECT_ID wins and is sanitized", () => {
    const root = tempDir();
    mkdirSync(join(root, ".ai-badger"));
    writeFileSync(join(root, ".ai-badger", "project-id"), "from-file\n");

    // The env override wins over the file, and invalid characters become one separator.
    expect(resolveProjectKey(root, { AI_BADGER_PROJECT_ID: "  My Project!!  " })).toBe("My-Project");
    // A value that sanitizes to nothing is unusable — the stable cwd hash answers instead.
    expect(resolveProjectKey(root, { AI_BADGER_PROJECT_ID: "///" })).toBe(hashProjectKey(root));
  });

  test("project key: .ai-badger/project-id is the key; missing file falls back to a stable hash", () => {
    const root = tempDir();
    mkdirSync(join(root, ".ai-badger"));
    writeFileSync(join(root, ".ai-badger", "project-id"), "  abc-123  \n");
    expect(resolveProjectKey(root, {})).toBe("abc-123");

    // `.ai-badger` without the file stops the walk and hashes the dir containing it.
    const bare = tempDir();
    mkdirSync(join(bare, ".ai-badger"));
    const key = resolveProjectKey(bare, {});
    expect(key).toBe(hashProjectKey(bare));
    expect(key).toMatch(/^p-[0-9a-f]{12}$/);
    expect(resolveProjectKey(bare, {})).toBe(key); // stable across calls
    expect(key).not.toBe(resolveProjectKey(tempDir(), {})); // distinct roots, distinct keys
  });

  test("project key: no .ai-badger walks to .git; no .git hashes cwd", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectKey(nested, {})).toBe(hashProjectKey(repo));

    // No `.ai-badger` and no `.git` anywhere above: the key hashes cwd itself.
    const loose = tempDir();
    expect(resolveProjectKey(loose, {})).toBe(hashProjectKey(loose));
  });
});

describe("A2.2 support — project log layout", () => {
  test("project log dir: base/projects/<key>", () => {
    expect(projectLogDir("/logs", "proj-a")).toBe(join("/logs", "projects", "proj-a"));
  });
});
