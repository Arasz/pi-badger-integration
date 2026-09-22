/**
 * Project identity for delegation logs (PKG-2, plan D1/§2): one key per project, so run ids
 * and log files are namespaced per project instead of machine-globally.
 *
 * Resolution mirrors the message-bus project walk (`resolveProjectId`, F5) with a fallback
 * that always answers: `AI_BADGER_PROJECT_ID` wins, then the nearest `.ai-badger` (its
 * `project-id` file when readable and usable, the dir's hash otherwise), then the nearest
 * `.git` root, then cwd — every fallback `p-<sha256(root).slice(0, 12)>` so a project without
 * ai-badger still gets a stable key. The walk stops at the nearest `.ai-badger`, present or
 * not, exactly like the message bus.
 *
 * The key is used as ONE path segment: it is sanitized to `[A-Za-z0-9._-]`, trimmed, capped
 * at 64 chars, and never `.` or `..`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The env override the message bus honours too (D1). */
export const PROJECT_ID_ENV = "AI_BADGER_PROJECT_ID";

const KEY_MAX_CHARS = 64;

/** A resolved project: the key plus the directory the walk stopped at (the project root). */
export interface ProjectIdentity {
  key: string;
  root: string;
}

/**
 * Sanitize one candidate key: invalid characters collapse to a single `-`, leading/trailing
 * separators are trimmed, the result is capped at 64 chars. Returns undefined when nothing
 * usable remains — including the traversal-shaped `.` and `..`.
 */
export function sanitizeProjectKey(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return undefined;
  return cleaned.slice(0, KEY_MAX_CHARS);
}

/** The stable fallback key of a root: `p-<sha256(root).slice(0, 12)>`. */
export function hashProjectKey(root: string): string {
  return `p-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}`;
}

/**
 * Resolve cwd's project identity: the key and the root that produced it. An unusable env
 * override falls back to the cwd hash (it never resumes the walk — the override was explicit).
 */
export function resolveProject(cwd: string, env: Record<string, string | undefined> = process.env): ProjectIdentity {
  const start = resolve(cwd);
  const override = env[PROJECT_ID_ENV];
  if (typeof override === "string" && override.trim()) {
    const key = sanitizeProjectKey(override);
    return { key: key ?? hashProjectKey(start), root: start };
  }
  let dir = start;
  for (;;) {
    const aiBadger = join(dir, ".ai-badger");
    if (existsSync(aiBadger)) {
      let value: string | undefined;
      try {
        value = readFileSync(join(aiBadger, "project-id"), "utf8");
      } catch {
        value = undefined; // unreadable file == no usable value; the dir's hash answers
      }
      return { key: (value !== undefined ? sanitizeProjectKey(value) : undefined) ?? hashProjectKey(dir), root: dir };
    }
    if (existsSync(join(dir, ".git"))) return { key: hashProjectKey(dir), root: dir };
    const parent = dirname(dir);
    if (parent === dir) return { key: hashProjectKey(start), root: start };
    dir = parent;
  }
}

/** The project key alone — the common call (D1). */
export function resolveProjectKey(cwd: string, env: Record<string, string | undefined> = process.env): string {
  return resolveProject(cwd, env).key;
}

/** The per-project run-log directory under the base log dir (D2). */
export function projectLogDir(base: string, key: string): string {
  return join(base, "projects", key);
}
