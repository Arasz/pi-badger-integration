/**
 * PKG-1 merge rows (M1–M15, corrected per the plan-review C1 section; M3 withdrawn)
 * plus the dedupePool/docKey rows that pin the per-kind prune parity rules.
 *
 * Pure unit tests: no clock, no I/O, no env, no randomness. Every fixture is
 * non-degenerate by construction — multi-chunk documents for path dedup/backfill,
 * strictly distinct scores for sort rows, exact ties with a distinct third for
 * tie rows, `0.0` against `null`/`undefined`, and reverse-alphabetical insertion
 * for the tie rows so a hash-tiebreak mutant dies.
 */

import { describe, expect, test } from "bun:test";
import { MERGE_SLOTS, dedupePool, docKey, mergeSelect, type MergeCandidate } from "../../extensions/query-pipeline/merge.ts";
import type { PipelineCandidate } from "../../extensions/query-pipeline/types.ts";

/** One candidate chunk; path is the document identity unless overridden. */
function cand(
	hash: string,
	score: number | null | undefined,
	path: string,
	kind: "memory" | "code" = "memory",
): PipelineCandidate {
	return { hash, score, path, kind, snippet: `snippet ${hash}` };
}

const hashes = (hits: readonly MergeCandidate[]): string[] => hits.map((hit) => hit.hash);

describe("mergeSelect — document-aware five-slot budget", () => {
	test("M1 five distinct documents fill five slots in descending Jev score order", () => {
		// Insertion order is d1..d5; score order is d4,d2,d3,d1,d5 — sorting is load-bearing.
		const pool = [
			cand("d1", 1.5, "docs/d1.md"),
			cand("d2", 2.5, "docs/d2.md"),
			cand("d3", 2.0, "docs/d3.md"),
			cand("d4", 3.0, "docs/d4.md"),
			cand("d5", 1.0, "docs/d5.md"),
		];
		const { mem, code } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["d4", "d2", "d3", "d1", "d5"]);
		expect(mem).toHaveLength(5);
		expect(code).toHaveLength(0);
		expect(new Set(mem.map((hit) => docKey(hit))).size).toBe(5);
	});

	test("M2 fewer than five documents backfill remaining slots from already-included documents", () => {
		// A has three chunks, B has one: two distinct documents, four slots used.
		const pool = [
			cand("a1", 3.0, "docs/a.md"),
			cand("a2", 2.0, "docs/a.md"),
			cand("a3", 1.0, "docs/a.md"),
			cand("b1", 2.5, "docs/b.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a1", "b1", "a2", "a3"]);
		expect(mem).toHaveLength(4);
	});

	test("M3a fewer documents than slots: second chunks fill remaining slots in global rank order", () => {
		// A and B each carry two chunks with strictly distinct scores; the backfill
		// must follow the global score order (B2 before A2), not group per document.
		const pool = [
			cand("a1", 3.0, "docs/a.md"),
			cand("a2", 1.0, "docs/a.md"),
			cand("b1", 2.5, "docs/b.md"),
			cand("b2", 1.5, "docs/b.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a1", "b1", "b2", "a2"]);
		expect(mem).toHaveLength(4);
	});

	test("M3b backfill never exceeds the slot budget", () => {
		// Two documents, seven chunks, five slots — the pass-2 loop must stop at 5.
		const pool = [
			cand("a1", 5.0, "docs/a.md"),
			cand("a2", 4.0, "docs/a.md"),
			cand("a3", 3.0, "docs/a.md"),
			cand("a4", 2.0, "docs/a.md"),
			cand("a5", 1.0, "docs/a.md"),
			cand("b1", 4.5, "docs/b.md"),
			cand("b2", 3.5, "docs/b.md"),
		];
		const { mem, code } = mergeSelect(pool);
		expect(mem).toHaveLength(5);
		expect(mem.length + code.length).toBe(5);
		expect(hashes(mem)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
	});

	test("M3c with more documents than slots, pass 2 is a no-op", () => {
		// Six documents (each with a second chunk) > five slots: pass 1 fills every
		// slot with a distinct document, so the backfill pass must not run.
		const pool = [
			cand("a1", 12.0, "docs/a.md"),
			cand("a2", 11.0, "docs/a.md"),
			cand("b1", 10.0, "docs/b.md"),
			cand("b2", 9.0, "docs/b.md"),
			cand("c1", 8.0, "docs/c.md"),
			cand("c2", 7.0, "docs/c.md"),
			cand("d1", 6.0, "docs/d.md"),
			cand("d2", 5.0, "docs/d.md"),
			cand("e1", 4.0, "docs/e.md"),
			cand("e2", 3.0, "docs/e.md"),
			cand("f1", 2.0, "docs/f.md"),
			cand("f2", 1.0, "docs/f.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(mem).toHaveLength(5);
		expect(hashes(mem)).toEqual(["a1", "b1", "c1", "d1", "e1"]);
		expect(new Set(mem.map((hit) => docKey(hit))).size).toBe(5);
	});

	test("M4 two chunks of the same path occupy one document slot; the higher-scored chunk is kept", () => {
		// Corrected fixture: the LOWER-scored chunk of the same document is inserted
		// first, so "first inserted wins" cannot pass — the higher score must win.
		const pool = [
			cand("a-low", 0.88, "docs/a.md"),
			cand("a-high", 0.9, "docs/a.md"),
			cand("b", 0.85, "docs/b.md"),
			cand("c", 0.8, "docs/c.md"),
			cand("d", 0.75, "docs/d.md"),
			cand("e", 0.7, "docs/e.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a-high", "b", "c", "d", "e"]);
		expect(mem).toHaveLength(5);
	});

	test("M5 path identity falls back to sourceFile when path is absent", () => {
		// h1 carries only sourceFile; h2 carries the same document as `path`.
		const pool: PipelineCandidate[] = [
			{ hash: "h1", score: 3.0, sourceFile: "docs/x.md", kind: "memory", snippet: "snippet h1" },
			{ hash: "h2", score: 2.0, path: "docs/x.md", kind: "memory", snippet: "snippet h2" },
			cand("h3", 1.0, "docs/y.md"),
		];
		const { mem } = mergeSelect(pool);
		// h2 is backfilled after h3: the same document, but never a second pass-1 slot.
		expect(hashes(mem)).toEqual(["h1", "h3", "h2"]);
		expect(mem).toHaveLength(3);
	});

	test("M6 equal scores preserve retrieval order", () => {
		// Three-way and two-way exact ties, inserted in reverse alphabetical order,
		// plus a distinct-scored document that must sort above every tie.
		const pool = [
			cand("t_c", 1.0, "docs/tc.md"),
			cand("t_b", 1.0, "docs/tb.md"),
			cand("t_a", 1.0, "docs/ta.md"),
			cand("u_b", 1.0, "docs/ub.md"),
			cand("u_a", 1.0, "docs/ua.md"),
			cand("high", 2.0, "docs/high.md"),
		];
		const { mem } = mergeSelect(pool, 6);
		expect(hashes(mem)).toEqual(["high", "t_c", "t_b", "t_a", "u_b", "u_a"]);
	});

	test("M7 null and missing scores rank after every scored candidate, in retrieval order", () => {
		// `0.0` is Jev's "unrelated" verdict and outranks null; null and undefined are
		// both missing evidence and keep retrieval order among themselves.
		const pool: PipelineCandidate[] = [
			cand("b", null, "docs/b.md"),
			cand("a", 0.0, "docs/a.md"),
			{ hash: "c", path: "docs/c.md", kind: "memory", snippet: "snippet c" },
		];
		const { mem } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a", "b", "c"]);
		expect(mem[0].score).toBe(0.0);
		expect(mem[1].score).toBeNull();
		expect(mem[2].score).toBeUndefined();
	});

	test("M8 zero candidates merge to an empty list, never throw", () => {
		expect(mergeSelect([])).toEqual({ mem: [], code: [] });
		const { mem, code } = mergeSelect([cand("only", 1.0, "docs/only.md")]);
		expect(hashes(mem)).toEqual(["only"]);
		expect(code).toHaveLength(0);
	});

	test("M9 backfill never repeats the best chunk", () => {
		// Two documents, six chunks, five slots: the best chunk of each document is
		// chosen once in pass 1 and must never be re-admitted by the backfill.
		const pool = [
			cand("a1", 6.0, "docs/a.md"),
			cand("a2", 5.0, "docs/a.md"),
			cand("a3", 4.0, "docs/a.md"),
			cand("a4", 3.0, "docs/a.md"),
			cand("b1", 5.5, "docs/b.md"),
			cand("b2", 2.0, "docs/b.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(mem).toHaveLength(5);
		expect(new Set(hashes(mem)).size).toBe(5);
		expect(hashes(mem)).toEqual(["a1", "b1", "a2", "a3", "a4"]);
	});

	test("M10 slots default to 5; a sixth distinct document is dropped", () => {
		expect(MERGE_SLOTS).toBe(5);
		const pool = ["d1", "d2", "d3", "d4", "d5", "d6"].map((hash, index) =>
			cand(hash, 6 - index, `docs/${hash}.md`),
		);
		const { mem } = mergeSelect(pool);
		expect(mem).toHaveLength(5);
		expect(hashes(mem)).toEqual(["d1", "d2", "d3", "d4", "d5"]);
		expect(hashes(mem)).not.toContain("d6");
	});

	test("M11 each merged entry carries its own score and kind", () => {
		// A's second chunk is a code hit with its own 0.8 score; it must not inherit
		// A1's 0.9 score or its memory kind.
		const pool = [
			cand("a1", 0.9, "docs/a.md", "memory"),
			cand("b1", 0.85, "docs/b.md", "memory"),
			cand("a2", 0.8, "docs/a.md", "code"),
		];
		const { mem, code } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a1", "b1"]);
		expect(hashes(code)).toEqual(["a2"]);
		expect(mem[0].score).toBe(0.9);
		expect(mem[1].score).toBe(0.85);
		expect(code[0].score).toBe(0.8);
		expect(code[0].kind).toBe("code");
	});

	test("M12 path dedup with a tie backfills in retrieval order", () => {
		// a3 and a2 tie at 0.7; a3 is retrieved first (reverse-alphabetical insertion,
		// so a hash-tiebreak mutant dies), so a3 must backfill first.
		const pool = [
			cand("a3", 0.7, "docs/a.md"),
			cand("a2", 0.7, "docs/a.md"),
			cand("a1", 0.9, "docs/a.md"),
			cand("b", 0.8, "docs/b.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a1", "b", "a3", "a2"]);
	});

	test("M13 mem and code share the five-slot budget", () => {
		// Four memory + four code candidates, strictly distinct scores: exactly five
		// entries total across both arrays, and neither kind can take all five.
		const pool = [
			cand("m1", 3.0, "docs/m1.md", "memory"),
			cand("c1", 2.9, "docs/c1.md", "code"),
			cand("m2", 2.7, "docs/m2.md", "memory"),
			cand("c2", 2.6, "docs/c2.md", "code"),
			cand("m3", 2.4, "docs/m3.md", "memory"),
			cand("c3", 2.3, "docs/c3.md", "code"),
			cand("m4", 2.1, "docs/m4.md", "memory"),
			cand("c4", 2.0, "docs/c4.md", "code"),
		];
		const { mem, code } = mergeSelect(pool);
		expect(mem.length + code.length).toBe(5);
		expect(hashes(mem)).toEqual(["m1", "m2", "m3"]);
		expect(hashes(code)).toEqual(["c1", "c2"]);
		expect(mem.every((hit) => hit.kind === "memory")).toBe(true);
		expect(code.every((hit) => hit.kind === "code")).toBe(true);
	});

	test("M14 a null-scored distinct document takes a pass-1 slot", () => {
		// Document-first: E1's null is missing evidence about one chunk, not proof
		// the document is irrelevant, so it takes the fifth slot ahead of A's backfill.
		const pool = [
			cand("a1", 2.0, "docs/a.md"),
			cand("a2", 1.9, "docs/a.md"),
			cand("b1", 1.8, "docs/b.md"),
			cand("c1", 1.7, "docs/c.md"),
			cand("d1", 1.6, "docs/d.md"),
			cand("e1", null, "docs/e.md"),
		];
		const { mem } = mergeSelect(pool);
		expect(hashes(mem)).toEqual(["a1", "b1", "c1", "d1", "e1"]);
		expect(mem[4].score).toBeNull();
		expect(hashes(mem)).not.toContain("a2");
	});

	test("M15 droppable hits never take a slot", () => {
		// `? ::` (missing path AND snippet) is dropped by dedupePool before selection,
		// so the scored eligible candidates take the slots instead.
		const pool: PipelineCandidate[] = [
			{ hash: "droppable", path: "?", snippet: "", score: 3.0, kind: "memory" },
			cand("good1", 2.0, "docs/good1.md"),
			cand("good2", 1.0, "docs/good2.md"),
		];
		const deduped = dedupePool(pool, []);
		expect(hashes(deduped.mem)).toEqual(["good1", "good2"]);
		const { mem } = mergeSelect(deduped.mem);
		expect(hashes(mem)).toEqual(["good1", "good2"]);
	});
});

describe("dedupePool — per-kind prune parity", () => {
	test("M16 identical non-empty hashes dedupe per kind, first occurrence wins", () => {
		const memPool = [cand("dup", 3.0, "docs/first.md"), cand("dup", 1.0, "docs/second.md")];
		const codePool = [cand("dup", 2.0, "docs/code-first.md", "code")];
		const deduped = dedupePool(memPool, codePool);
		expect(deduped.mem).toHaveLength(1);
		expect(deduped.mem[0].path).toBe("docs/first.md");
		expect(deduped.code).toHaveLength(1);
		expect(deduped.code[0].path).toBe("docs/code-first.md");
	});

	test("M17 identical non-empty snippets dedupe across different hashes, first wins", () => {
		const memPool: PipelineCandidate[] = [
			{ hash: "h1", path: "docs/a.md", snippet: "same body", kind: "memory" },
			{ hash: "h2", path: "docs/b.md", snippet: "  same body  ", kind: "memory" },
		];
		const deduped = dedupePool(memPool, []);
		expect(hashes(deduped.mem)).toEqual(["h1"]);
	});

	test("M18 mem and code dedupe independently", () => {
		const memPool = [cand("shared", 1.0, "docs/mem.md")];
		const codePool = [cand("shared", 1.0, "docs/code.md", "code")];
		const deduped = dedupePool(memPool, codePool);
		expect(hashes(deduped.mem)).toEqual(["shared"]);
		expect(hashes(deduped.code)).toEqual(["shared"]);
	});

	test("M19 a hit with an empty path but a snippet is kept", () => {
		// Droppable requires BOTH halves empty; either alone is kept (pruneHits parity).
		const memPool: PipelineCandidate[] = [
			{ hash: "h1", path: "", snippet: "body text", kind: "memory" },
			{ hash: "h2", path: "?", snippet: "other body", kind: "memory" },
			{ hash: "h3", path: "", snippet: "", kind: "memory" },
		];
		const deduped = dedupePool(memPool, []);
		expect(hashes(deduped.mem)).toEqual(["h1", "h2"]);
	});
});

describe("docKey — document identity", () => {
	test("M20 path wins when non-empty and not `?`; sourceFile and hash are fallbacks", () => {
		expect(docKey({ hash: "h", path: "docs/x.md" })).toBe("path:docs/x.md");
		expect(docKey({ hash: "h", sourceFile: "docs/x.md" })).toBe("path:docs/x.md");
		expect(docKey({ hash: "h", path: "docs/x.md", sourceFile: "docs/y.md" })).toBe("path:docs/x.md");
		expect(docKey({ hash: "h", path: "?" })).toBe("hash:h");
		expect(docKey({ hash: "h", path: "   " })).toBe("hash:h");
		expect(docKey({ hash: " h " })).toBe("hash:h");
	});
});

describe("server rank parsing (plan §2)", () => {
	test("M21 a numeric-string ranking sorts as its number, not as +Infinity", () => {
		const numeric = { hash: "n", score: null, path: "docs/n.md", snippet: "s", ranking: "2", kind: "memory" } as MergeCandidate;
		const other = { hash: "o", score: null, path: "docs/o.md", snippet: "s", ranking: 5, kind: "memory" } as MergeCandidate;
		const { mem } = mergeSelect([other, numeric]);
		expect(mem.map((hit) => hit.hash)).toEqual(["n", "o"]);
	});

	test("M22 a non-numeric ranking sorts last", () => {
		const bad = { hash: "bad", score: null, path: "docs/bad.md", snippet: "s", ranking: "not-a-number", kind: "memory" } as MergeCandidate;
		const good = { hash: "good", score: null, path: "docs/good.md", snippet: "s", ranking: 9, kind: "memory" } as MergeCandidate;
		const { mem } = mergeSelect([bad, good]);
		expect(mem.map((hit) => hit.hash)).toEqual(["good", "bad"]);
	});
});
