/**
 * Unit tests for the mem-based-rag core: the enrichment filter (order matters —
 * bare-skill and command gates beat the length gates), the skill-prefix query
 * extraction, and both injected block shapes (default snippets, expanded full
 * values with per-hit snippet fallback).
 */
import { describe, expect, test } from "bun:test";
import {
	extractQuery,
	shouldEnrich,
	toExpandedMemoryContext,
	toMemoryContext,
	uniqueLongWords,
} from "../../extensions/mem-based-rag/rag-core.ts";

describe("shouldEnrich filter gates", () => {
	test("the IDEA prompt enriches", () => {
		const prompt =
			"IDEA: using ai-raccoon as a RAG we want prompt augmentation with filtering implemented as extension";
		const decision = shouldEnrich(prompt);
		expect(decision.enrich).toBe(true);
		expect(decision.reason).toBe("ok");
		expect(decision.query).toBe(prompt);
	});

	test("control words skip even though some pass the length gate", () => {
		for (const word of ["stop", "continue", "exit", "quit", "clear", "help"]) {
			expect(shouldEnrich(word).reason).toBe(word.length < 20 ? "control-word" : "control-word");
		}
	});

	test("single-token slash commands skip", () => {
		expect(shouldEnrich("/delegations")).toEqual(
			expect.objectContaining({ enrich: false, reason: "command" }),
		);
		expect(shouldEnrich("/monitors")).toEqual(
			expect.objectContaining({ enrich: false, reason: "command" }),
		);
	});

	test("bare skill call reports bare-skill-call, not too-short", () => {
		// /skill:task is 11 chars — the ordering pin: skill gate before length gate.
		expect(shouldEnrich("/skill:task")).toEqual(
			expect.objectContaining({ enrich: false, reason: "bare-skill-call" }),
		);
	});

	test("skill call with extension text enriches on the extension text", () => {
		const decision = shouldEnrich("/skill:task extend the delegation timeout because CI runners are slow and flaky again tomorrow morning");
		expect(decision.enrich).toBe(true);
		expect(decision.query).toBe("extend the delegation timeout because CI runners are slow and flaky again tomorrow morning");
	});

	test("thin prompts skip: fewer than 8 unique long words", () => {
		// 6 unique words >3 chars — the calibration case from the jsaa bank probes.
		const decision = shouldEnrich("prompt context injection extension before_agent_start filter");
		expect(decision).toEqual(
			expect.objectContaining({ enrich: false, reason: "too-thin", uniqueWords: 6 }),
		);
	});

	test("thinness floor is configurable", () => {
		const prompt = "prompt context injection extension before_agent_start filter";
		expect(shouldEnrich(prompt, { minWords: 6 }).enrich).toBe(true);
		expect(shouldEnrich(prompt, { minWords: 7 }).reason).toBe("too-thin");
	});

	test("empty and whitespace-only prompts skip", () => {
		expect(shouldEnrich("").reason).toBe("empty");
		expect(shouldEnrich("   ").reason).toBe("empty");
	});
});

describe("extractQuery", () => {
	test("strips the skill invocation prefix, keeps the user words", () => {
		expect(extractQuery("/skill:task extend the timeout")).toBe("extend the timeout");
		expect(extractQuery("/skill:review this diff for races")).toBe("this diff for races");
	});

	test("leaves non-skill prompts untouched", () => {
		expect(extractQuery("how does the fallback chain work")).toBe("how does the fallback chain work");
	});

	test("a bare skill call extracts to empty (caller reports bare-skill-call first)", () => {
		expect(extractQuery("/skill:task")).toBe("/skill:task");
	});
});

describe("uniqueLongWords", () => {
	test("counts case-insensitive unique words of 3+ chars", () => {
		expect(uniqueLongWords("Stop the router Router fallback").size).toBe(3); // stop, router, fallback — the is noise
		expect(uniqueLongWords("a an the it is on").size).toBe(0);
	});

	test("3-letter signal words count, noise words do not", () => {
		// fix/api/env/bus are intent in tech prompts; the/and/for are not.
		expect(uniqueLongWords("fix EPIPE ENOENT SIGTERM in stdio child").size).toBe(6); // fix, epipe, enoent, sigterm, stdio, child
		expect(uniqueLongWords("the and for are you can").size).toBe(0);
		expect(uniqueLongWords("use the api key for env bus").size).toBe(5); // use, api, key, env, bus (the/for are noise)
	});
});

describe("toMemoryContext (default mode)", () => {
	const mem = [
		{ hash: "aaa", ranking: 1, path: "shared/x.md", snippet: "first memory snippet" },
		{ hash: "bbb", ranking: 0.9, path: "shared/y.md", snippet: "second memory snippet" },
	];
	const code = [{ hash: "ccc", ranking: 1, path: "src/a.ts", snippet: "some code", lineStart: 10, lineEnd: 20 }];

	test("block carries memories, code, hashes pointers, and truncation note", () => {
		const block = toMemoryContext("how does context injection work here", mem, code);
		expect(block).toContain("Memory context (ai-raccoon memory_search");
		expect(block).toContain("- memories (snippets — to get full content use memory_get with the hash):");
		expect(block).toContain("[m1] shared/x.md (rank 1) :: first memory snippet");
		expect(block).toContain("- code (snippets — to get full content use code_get with the hash):");
		expect(block).toContain("[c1] src/a.ts:10-20 (rank 1) :: some code");
		expect(block).toContain("hashes identify the full entries");
	});

	test("empty sections say so instead of vanishing", () => {
		const block = toMemoryContext("a sufficiently long and meaningful question here", [], []);
		expect(block).toContain("(no memory hits)");
		expect(block).toContain("(no code hits)");
	});

	test("keeps top 3 memories and top 2 code hits", () => {
		const many = [1, 2, 3, 4, 5].map((i) => ({ hash: `h${i}`, path: `p${i}.md`, snippet: `s${i}` }));
		const block = toMemoryContext("a sufficiently long and meaningful question here", many, many);
		expect(block).toContain("[m3]");
		expect(block).not.toContain("[m4]");
		expect(block).toContain("[c2]");
		expect(block).not.toContain("[c3]");
	});
});

describe("toExpandedMemoryContext", () => {
	test("full values render with path and chunk provenance", () => {
		const block = toExpandedMemoryContext("how does context injection work here", [
			{ hit: { hash: "aaa", path: "shared/x.md" }, kind: "memory", value: "the full decision text", path: "shared/x.md", chunk: "chunk 2/36" },
			{ hit: { hash: "ccc", path: "src/a.ts", snippet: "fallback snippet" }, kind: "code" },
		]);
		expect(block).toContain("memory_get/code_get, expanded");
		expect(block).toContain("[m1] shared/x.md (chunk 2/36) :: the full decision text");
		// per-hit failure falls back to the snippet
		expect(block).toContain("[c1] src/a.ts :: fallback snippet");
	});
});
