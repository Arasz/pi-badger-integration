/**
 * Result cache suite (f: 2026-09-02 option (c) + M7 demanded rows): the in-memory ring of the
 * LAST 8 delegation result entries, dual-indexed by delegation_id and grouped by parent_id.
 *
 * The class is pure (no imports at all — the note input is a structural slice of
 * DelegationNote), so these rows drive it directly with plain objects and an injected clock.
 */

import { describe, expect, test } from "bun:test";
import {
  DelegationResultCache,
  RESULT_CACHE_LIMIT,
  RESULT_INPUT_MAX_CHARS,
  RESULT_OUTPUT_MAX_CHARS,
  TASK_SUMMARY_MAX_CHARS,
  buildResultEntry,
  type ResultNoteInput,
} from "../extensions/subagent/result-cache.ts";

const NOW = 1_700_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

function note(overrides: Partial<ResultNoteInput> = {}): ResultNoteInput {
  return { id: "d-1", agent: "architect", task: "do the thing", answer: "the answer", ...overrides };
}

describe("M7 — the result cache ring, dual-index eviction", () => {
  test("nine puts keep the LAST 8: the oldest is gone from the ring, byId and byParent; the parent array is spliced with remaining order kept", () => {
    const cache = new DelegationResultCache();
    for (let i = 1; i <= 9; i++) {
      cache.put(note({ id: `d-${i}`, sessionId: "sess" }), { now: () => NOW + i });
    }

    expect(cache.all().map((entry) => entry.delegation_id)).toEqual(["d-2", "d-3", "d-4", "d-5", "d-6", "d-7", "d-8", "d-9"]);
    expect(cache.byId("d-1")).toBeUndefined(); // the oldest left byId too
    expect(cache.byParent("sess").map((entry) => entry.delegation_id)).toEqual([
      "d-2",
      "d-3",
      "d-4",
      "d-5",
      "d-6",
      "d-7",
      "d-8",
      "d-9",
    ]); // spliced, remaining insertion order kept
  });

  test("a parent whose entries all evict loses its byParent key entirely", () => {
    const cache = new DelegationResultCache();
    cache.put(note({ id: "d-1", sessionId: "sess-lone" }), { now: () => NOW });
    for (let i = 2; i <= 9; i++) {
      cache.put(note({ id: `d-${i}`, sessionId: "sess-other" }), { now: () => NOW + i });
    }

    expect(cache.byId("d-1")).toBeUndefined();
    expect(cache.byParent("sess-lone")).toEqual([]); // emptied array → the key is gone
    expect(cache.byParent("sess-other")).toHaveLength(8);
  });

  test("a re-put of an existing delegation id removes the old entry from ring and parent index before inserting (newest position)", () => {
    const cache = new DelegationResultCache();
    for (let i = 1; i <= 3; i++) cache.put(note({ id: `d-${i}`, sessionId: "sess" }), { now: () => NOW + i });
    cache.put(note({ id: "d-1", sessionId: "sess", task: "task one, retried" }), { now: () => NOW + 100 });

    expect(cache.all().map((entry) => entry.delegation_id)).toEqual(["d-2", "d-3", "d-1"]); // d-1 is newest again
    expect(cache.byId("d-1")?.task_summary).toBe("task one, retried"); // the fresh entry, not a stale copy
    expect(cache.byParent("sess")).toEqual(cache.all()); // one entry per id in the parent group
  });

  test("the ring size constant is 8 (design pin)", () => {
    expect(RESULT_CACHE_LIMIT).toBe(8);
  });
});

describe("M7 — the note→entry builder", () => {
  test("parent_id is omitted when the note has no sessionId, and the parent index is skipped", () => {
    const cache = new DelegationResultCache();
    const entry = cache.put(note({ sessionId: undefined }), { now: () => NOW });

    expect("parent_id" in entry).toBe(false); // the schema stays honest — no null parent
    expect(cache.all()).toEqual([entry]);
  });

  test("aborted and failed notes enter the cache like any other", () => {
    const cache = new DelegationResultCache();
    const aborted = cache.put(note({ id: "d-1", answer: "partial before the abort" }), { now: () => NOW });
    const failed = cache.put(note({ id: "d-2", agent: "tester", answer: "" }), { now: () => NOW + 1 });

    expect(cache.byId("d-1")).toBe(aborted);
    expect(cache.byId("d-2")).toBe(failed);
    expect(cache.byId("d-2")?.output).toBe("");
  });

  test("timestamp is stamped from the injected clock as ISO at put time — the note carries no finish time of its own", () => {
    const entry = buildResultEntry(note(), () => NOW + 1234);
    expect(entry.timestamp).toBe(new Date(NOW + 1234).toISOString());
  });

  test("task_summary is the task's FIRST line capped at 120 chars with … — deliberately not taskExcerpt's 100", () => {
    expect(TASK_SUMMARY_MAX_CHARS).toBe(120);
    expect(buildResultEntry(note({ task: "first line\nsecond line" }), () => NOW).task_summary).toBe("first line");
    const long = "x".repeat(200);
    const summary = buildResultEntry(note({ task: long }), () => NOW).task_summary;
    expect(summary).toBe(`${"x".repeat(120)}…`);
  });

  test("input is the task head-capped at 2000 chars with …", () => {
    expect(RESULT_INPUT_MAX_CHARS).toBe(2000);
    const task = "y".repeat(2500);
    const entry = buildResultEntry(note({ task }), () => NOW);
    expect(entry.input).toBe(`${"y".repeat(2000)}…`);
    expect(entry.input.length).toBe(2001);
  });

  test("output is the answer tail-kept at 6000 chars with the codebase's '[...N earlier characters dropped]' marker — the answer lives at the end", () => {
    expect(RESULT_OUTPUT_MAX_CHARS).toBe(6000);
    const answer = `head-${"z".repeat(6000)}`;
    const entry = buildResultEntry(note({ answer }), () => NOW);
    expect(entry.output).toContain("[...5 earlier characters dropped]"); // 6005 − 6000
    expect(entry.output.endsWith(answer.slice(-6000))).toBe(true); // the tail survives
    expect(entry.output).not.toContain("head-"); // the head was dropped, not the answer
    // within the cap the answer is verbatim
    expect(buildResultEntry(note({ answer: "short answer" }), () => NOW).output).toBe("short answer");
  });
});
