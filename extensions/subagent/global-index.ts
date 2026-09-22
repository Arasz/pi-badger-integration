/**
 * The global run index (PKG-3, D3/S4): one JSONL entry per run whose log sink opened, at
 * `<baseLogDir>/index.jsonl`, so `resolve <guid>` can answer across projects and restarts.
 *
 * The index is append-only in the common path; only when the file grows past
 * `INDEX_COMPACT_THRESHOLD` is it rewritten to the newest `INDEX_MAX_ENTRIES` through a temp
 * file + atomic rename. Two live sessions share the file: appends interleave line-atomic,
 * and a compaction is last-writer-wins by design (a concurrent append between the read and
 * the rename may be dropped — the entry is a lookup aid, never run state).
 *
 * Reads skip malformed lines; every write is the caller's to fail-open (an index failure
 * never disables the run's log).
 */

import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** One started run: its global id, local id, project and log path. */
export interface GlobalIndexEntry {
  globalId: string;
  id: string;
  projectKey: string;
  projectRoot: string;
  logFile: string;
  at: number;
}

/** Production bound (D3): the index keeps the newest 500 entries after compaction. */
export const INDEX_MAX_ENTRIES = 500;

/** Compaction fires only above this many lines — ordinary appends never rewrite the file (S4). */
export const INDEX_COMPACT_THRESHOLD = 1000;

/** The fs seam (tests inject it to observe append-only vs temp-file + rename). */
export interface GlobalIndexIo {
  append(file: string, line: string): void;
  read(file: string): string;
  write(file: string, content: string): void;
  rename(from: string, to: string): void;
}

export const defaultGlobalIndexIo: GlobalIndexIo = {
  append(file, line) {
    appendFileSync(file, line, { mode: 0o600 });
  },
  read(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return ""; // no index yet — an empty index is a valid index
    }
  },
  write(file, content) {
    writeFileSync(file, content, { mode: 0o600 });
  },
  rename(from, to) {
    renameSync(from, to);
  },
};

export interface AppendIndexOptions {
  maxEntries?: number;
  compactThreshold?: number;
  io?: GlobalIndexIo;
}

/** Split raw index content into parsed entries, skipping blank and malformed lines. */
function parseEntries(content: string): GlobalIndexEntry[] {
  const entries: GlobalIndexEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<GlobalIndexEntry>;
      if (typeof parsed.globalId !== "string" || typeof parsed.id !== "string") continue;
      entries.push(parsed as GlobalIndexEntry);
    } catch {
      // a torn line from a concurrent writer or a crash: skip it, never fail the read
    }
  }
  return entries;
}

/**
 * Append one entry, compacting to the newest `maxEntries` once the file exceeds
 * `compactThreshold`. Returns whether this call compacted.
 */
export function appendIndexEntry(
  file: string,
  entry: GlobalIndexEntry,
  opts?: AppendIndexOptions,
): { compacted: boolean; entries: number } {
  const io = opts?.io ?? defaultGlobalIndexIo;
  const maxEntries = opts?.maxEntries ?? INDEX_MAX_ENTRIES;
  const compactThreshold = opts?.compactThreshold ?? INDEX_COMPACT_THRESHOLD;

  io.append(file, `${JSON.stringify(entry)}\n`);
  const lines = io.read(file).split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= compactThreshold) return { compacted: false, entries: lines.length };

  const kept = lines.slice(-maxEntries);
  const temp = `${file}.tmp`;
  try {
    io.write(temp, `${kept.join("\n")}\n`);
    io.rename(temp, file); // atomic within the same directory
  } catch (error) {
    try {
      rmSync(temp, { force: true }); // a failed compaction leaves the appended index intact
    } catch {
      // best-effort cleanup only — the caller's fail-open path owns the error
    }
    throw error;
  }
  return { compacted: true, entries: kept.length };
}

/** Every readable entry, oldest first. */
export function readIndex(file: string, io: GlobalIndexIo = defaultGlobalIndexIo): GlobalIndexEntry[] {
  return parseEntries(io.read(file));
}

/** The newest entry for one global id, or undefined — scan from the end (last writer wins). */
export function findIndexEntry(
  file: string,
  globalId: string,
  io: GlobalIndexIo = defaultGlobalIndexIo,
): GlobalIndexEntry | undefined {
  const entries = readIndex(file, io);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.globalId === globalId) return entries[i];
  }
  return undefined;
}
