/**
 * PKG-5 cross-package parity rows (plan-review C3).
 *
 * The pipeline's candidate shape and its pool dedupe must stay twins of
 * mem-based-rag's MemoryHit and pruneHits — a drift here silently changes what
 * gets injected (e.g. a droppable hit taking a merge slot that pruneHits then
 * deletes, injecting fewer than five entries).
 */
import { describe, expect, test } from "bun:test";
import { dedupePool, mergeSelect } from "../../extensions/query-pipeline/merge.ts";
import { createQueryPipeline, toEnvelope } from "../../extensions/query-pipeline/pipeline.ts";
import type { PipelineCandidate } from "../../extensions/query-pipeline/types.ts";
import { pruneHits, type MemoryHit } from "../../extensions/mem-based-rag/rag-core.ts";

describe("candidate twin", () => {
	test("PipelineCandidate is assignable to MemoryHit", () => {
		const candidate: PipelineCandidate = {
			hash: "h1",
			path: "docs/a.md",
			sourceFile: "docs/a.md",
			snippet: "s",
			ranking: 1,
			lineStart: 1,
			lineEnd: 2,
			kind: "memory",
			score: 1.5,
		};
		const hit: MemoryHit = candidate;
		expect(hit.hash).toBe("h1");
	});
});

describe("dedupePool / pruneHits parity", () => {
	const input: PipelineCandidate[] = [
		{ hash: "a", path: "docs/a.md", snippet: "one" },
		{ hash: "a", path: "docs/a.md", snippet: "two" }, // hash collision → dropped
		{ hash: "b", path: "docs/b.md", snippet: "same snippet" },
		{ hash: "c", path: "docs/c.md", snippet: "same snippet" }, // snippet collision → dropped
		{ hash: "d", path: "?", snippet: "" }, // droppable → dropped before slots
		{ hash: "e", path: "", snippet: "" }, // droppable → dropped
		{ hash: "f", path: "docs/f.md", snippet: "kept" },
	];

	test("per-kind dedupe matches pruneHits exactly", () => {
		const pool = dedupePool(input.slice(), []);
		const pruned = pruneHits(input.slice(), []);
		expect(pool.mem.map((h) => h.hash)).toEqual(pruned.mem.map((h) => h.hash));
		expect(pool.mem.map((h) => h.hash)).toEqual(["a", "b", "f"]);
	});

	test("mem and code dedupe independently (a cross-kind collision is not dropped)", () => {
		const mem = [{ hash: "x", path: "docs/x.md", snippet: "shared snippet" }];
		const code = [{ hash: "y", path: "src/y.ts", snippet: "shared snippet" }];
		const pool = dedupePool(mem, code);
		expect(pool.mem).toHaveLength(1);
		expect(pool.code).toHaveLength(1);
	});

	test("droppable hits never take a merge slot", () => {
		const candidates: PipelineCandidate[] = [
			{ hash: "drop", path: "?", snippet: "", score: 3, kind: "memory" },
			{ hash: "keep", path: "docs/keep.md", snippet: "s", score: 1, kind: "memory" },
		];
		const deduped = dedupePool(candidates, []);
		const selected = mergeSelect(deduped.mem);
		expect(selected.mem.map((h) => h.hash)).toEqual(["keep"]);
	});
});

describe("seam drift pin", () => {
	test("retrieve equals toEnvelope(retrieveResult)", async () => {
		const search = async (): Promise<string> =>
			JSON.stringify({ data: { results: [{ hash: "h1", path: "docs/a.md", ranking: 1, snippet: "s" }], code: [] } });
		const pipeline = createQueryPipeline({
			search,
			plan: async () => ({ status: "fallback", reason: "no-model" }),
			env: {},
		});
		const typed = await pipeline.retrieveResult({ query: "q" });
		const text = await pipeline.retrieve({ query: "q" });
		expect(JSON.parse(text)).toEqual(JSON.parse(toEnvelope(typed)));
	});
});
