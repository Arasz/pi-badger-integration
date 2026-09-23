/**
 * PKG-3 (A3.5) — the global index file: one JSONL entry per started run, append-only below a
 * compaction threshold and rewritten through a temp file + atomic rename above it, bounded to
 * the newest 500 entries. Two live sessions share the file (last writer wins, documented in
 * the module header), so the append path must never be a read-modify-write on every entry.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendIndexEntry,
  defaultGlobalIndexIo,
  findIndexEntry,
  INDEX_COMPACT_THRESHOLD,
  INDEX_MAX_ENTRIES,
  readIndex,
  type GlobalIndexEntry,
  type GlobalIndexIo,
} from "../../extensions/subagent/global-index.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aib-global-index-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function entry(n: number, globalId = `01926b4a-0000-7000-8000-${String(n).padStart(12, "0")}`): GlobalIndexEntry {
  return {
    globalId,
    id: `d-${n}`,
    projectKey: "proj-a",
    projectRoot: "/p",
    logFile: `/logs/projects/proj-a/d-${n}.jsonl`,
    at: 1_700_000_000_000 + n,
  };
}

describe("A3.5 — global index file", () => {
  test("global index: append writes one JSONL entry with project and log path", () => {
    const file = join(tempDir(), "index.jsonl");
    appendIndexEntry(file, entry(1));

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(entry(1));
  });

  test("global index: lookup by guid returns the newest entry", () => {
    const file = join(tempDir(), "index.jsonl");
    const globalId = "01926b4a-0000-7000-8000-000000000001";
    appendIndexEntry(file, { ...entry(1, globalId), id: "d-1" });
    appendIndexEntry(file, { ...entry(2, globalId), id: "d-2" });

    expect(findIndexEntry(file, globalId)?.id).toBe("d-2");
    expect(findIndexEntry(file, "01926b4a-0000-7000-8000-0000000000ff")).toBeUndefined();
  });

  test("global index: compaction keeps the newest N entries", () => {
    const file = join(tempDir(), "index.jsonl");
    for (let n = 1; n <= 5; n++) appendIndexEntry(file, entry(n), { maxEntries: 3, compactThreshold: 3 });

    expect(readIndex(file).map((e) => e.id)).toEqual(["d-3", "d-4", "d-5"]);
    expect(INDEX_MAX_ENTRIES).toBe(500); // the production bound D3 names
  });

  test("global index: append-only below the threshold, atomic rename above it", () => {
    const file = join(tempDir(), "index.jsonl");
    const calls: string[] = [];
    const io: GlobalIndexIo = {
      ...defaultGlobalIndexIo,
      write: (target, content) => {
        calls.push(`write ${target}`);
        defaultGlobalIndexIo.write(target, content);
      },
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        defaultGlobalIndexIo.rename(from, to);
      },
    };

    for (let n = 1; n <= 4; n++) appendIndexEntry(file, entry(n), { maxEntries: 2, compactThreshold: 4, io });
    expect(calls).toEqual([]); // append-only at/below the threshold: no rewrite, no rename
    expect(readIndex(file)).toHaveLength(4);

    appendIndexEntry(file, entry(5), { maxEntries: 2, compactThreshold: 4, io });
    expect(calls).toEqual([`write ${file}.tmp`, `rename ${file}.tmp -> ${file}`]);
    expect(readIndex(file).map((e) => e.id)).toEqual(["d-4", "d-5"]);
    expect(existsSync(`${file}.tmp`)).toBe(false); // the rename consumed the temp file
  });

  test("global index: the PRODUCTION defaults compact one past the threshold", () => {
    // Both mutation survivors the QA review found lived here: tests only passed explicit
    // thresholds/maxEntries, so INDEX_COMPACT_THRESHOLD = 1e9 and
    // maxEntries ?? MAX_SAFE_INTEGER both stayed green. This drives the real defaults.
    const file = join(tempDir(), "index.jsonl");
    for (let n = 1; n <= INDEX_COMPACT_THRESHOLD + 1; n++) appendIndexEntry(file, entry(n));

    const kept = readIndex(file);
    expect(kept).toHaveLength(INDEX_MAX_ENTRIES);
    expect(kept.at(-1)!.id).toBe(`d-${INDEX_COMPACT_THRESHOLD + 1}`);
  });

  test("global index: malformed lines are skipped, never failing a read or a lookup", () => {
    const file = join(tempDir(), "index.jsonl");
    appendIndexEntry(file, entry(1));
    appendFileSync(file, "{not json\n");
    appendFileSync(file, `${JSON.stringify({ globalId: "x" })}\n`); // missing id -> skipped
    appendIndexEntry(file, entry(2));

    expect(readIndex(file).map((e) => e.id)).toEqual(["d-1", "d-2"]);
    expect(findIndexEntry(file, entry(2).globalId)?.id).toBe("d-2");
  });
});
