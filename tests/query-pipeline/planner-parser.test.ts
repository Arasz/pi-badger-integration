/**
 * PKG-1 planner-parser rows (P1–P10, corrected per the plan-review C2 section)
 * plus the persona pin and the prompt-assembly pin.
 *
 * Pure unit tests: no clock, no I/O beyond reading the persona source file for
 * the pin, no env, no randomness. The measured F4 bytes are pasted verbatim
 * (unterminated fragment first, then the complete object) and the measured
 * planner user prompt prefix is an independent copy of the harness prompt.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DELEGATOR_PERSONA, PLANNER_ADDENDUM, PLANNER_USER_PREFIX, buildPlannerUserPrompt, parsePlan } from "../../extensions/query-pipeline/planner.ts";

// The measured harness prompt prefix (research F4, 4/4 parseable), copied from
// the harness run — the raw prompt goes between the `<<<` and `>>>` markers.
const MEASURED_PREFIX = `You are a retrieval-query planner for an ai-raccoon memory bank. Do not use any tools. Do not read files. Do not search memory. Analyze the USER REQUEST below and produce focused memory_search queries for a hybrid (keyword + embedding) bank.

Constraints:
- Group queries by core concept. One concept may need several angles; several concepts may each need a few angles.
- 2 to 6 queries total, each at most 300 characters.
- Each query must stand alone (name the actual thing, not "this" or "the issue") and must fit comfortably inside a 254-token embedding window.
- Query the mechanism/decision content you expect to exist in a software project's docs and code, not the user's complaints or pleasantries.
- Output ONLY one JSON object, no prose and no code fences, exactly this shape:
{"concepts":[{"name":"<short concept name>","queries":["<query>","<query>"]}]}

USER REQUEST:
<<<
`;

// The exact bytes of the one F4 run that emitted a partial JSON fragment before
// the complete object (log d-1353). The fragment is unterminated; the complete
// object starts while it is still open, so a brace-depth scanner must find the
// nested candidate, and the last parseable+valid object must win.
const F4_FRAGMENT_THEN_OBJECT = `{"concepts":[{"name":"cursor bookkeeping","queries":["pi message bus cursor storage location per session project and when cursor advances on list check","message bus concurrent poll delivery check race causing duplicate delivery"]

{"concepts":[{"name":"cursor bookkeeping","queries":["pi message bus cursor storage per session project when cursor advances on list check","message bus ack reply unread count semantics across sessions sharing project id"]},{"name":"broadcast routing","queries":["project broadcast fan-out vs direct session send delivery duplication differences","message bus delivery check polling interval concurrent poll race duplicate delivery"]},{"name":"session resume replay","queries":["session resume idle wait-blocked wake one-second internal check replaying already consumed mail"]}]}
`;

const twoConceptPlan = (a: string, b: string): string =>
	JSON.stringify({
		concepts: [
			{ name: "first", queries: [a] },
			{ name: "second", queries: [b] },
		],
	});

describe("parsePlan — last complete JSON object wins", () => {
	test("P1 fragment-then-complete-object: the last complete JSON object wins", () => {
		// (i) the measured F4 bytes: fragment first, complete object later.
		const fromF4 = parsePlan(F4_FRAGMENT_THEN_OBJECT);
		expect(fromF4.status).toBe("ok");
		if (fromF4.status !== "ok") return;
		expect(fromF4.plan.concepts).toHaveLength(3);
		// The later object's wording must win over the fragment's near-identical one.
		expect(fromF4.plan.concepts[0]?.queries[0]).toBe(
			"pi message bus cursor storage per session project when cursor advances on list check",
		);
		expect(fromF4.plan.concepts[1]?.name).toBe("broadcast routing");

		// (ii) two complete valid objects: the later one wins.
		const laterWins = parsePlan(`${twoConceptPlan("early-a", "early-b")}\n${twoConceptPlan("late-a", "late-b")}`);
		expect(laterWins.status).toBe("ok");
		if (laterWins.status !== "ok") return;
		expect(laterWins.plan.concepts[0]?.name).toBe("first");
		expect(laterWins.plan.concepts[0]?.queries).toEqual(["late-a"]);
		expect(laterWins.plan.concepts[1]?.queries).toEqual(["late-b"]);

		// (iii) a valid object followed by a later complete-but-shape-invalid object:
		// the earlier valid object wins (the only input pinning "parses AND validates").
		const earlierWins = parsePlan(`${twoConceptPlan("kept-a", "kept-b")}\n{"concepts":[]}`);
		expect(earlierWins.status).toBe("ok");
		if (earlierWins.status !== "ok") return;
		expect(earlierWins.plan.concepts[0]?.queries).toEqual(["kept-a"]);
	});

	test("P2 trailing prose after the last complete object is ignored", () => {
		const result = parsePlan(`${twoConceptPlan("q1", "q2")}\n\nHope that helps!`);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.plan.concepts).toHaveLength(2);
	});

	test("P3 an unterminated object is invalid, never throws", () => {
		expect(parsePlan('{"concepts":[{"name":"a","queries":["q1')).toEqual({
			status: "fallback",
			reason: "no-json-object",
		});
	});

	test("P4 empty or whitespace-only output is invalid with reason empty-text", () => {
		expect(parsePlan("")).toEqual({ status: "fallback", reason: "empty-text" });
		expect(parsePlan("   ")).toEqual({ status: "fallback", reason: "empty-text" });
		expect(parsePlan("\n\t  ")).toEqual({ status: "fallback", reason: "empty-text" });
	});

	test("P5 missing concepts, non-array concepts, missing queries and non-string queries are invalid", () => {
		const corpus = [
			"{}",
			'{"concepts":"x"}',
			// Each row isolates one broken field: the other concept is well-formed.
			'{"concepts":[{"name":"a"},{"name":"b","queries":["q1","q2"]}]}',
			'{"concepts":[{"name":"a","queries":[1,"q2"]},{"name":"b","queries":["q3"]}]}',
		];
		for (const entry of corpus) {
			expect(parsePlan(entry)).toEqual({ status: "fallback", reason: "invalid-shape" });
		}
	});

	test("P6 empty concepts and empty queries arrays are invalid", () => {
		expect(parsePlan('{"concepts":[]}')).toEqual({ status: "fallback", reason: "invalid-shape" });
		// Isolated: two valid concepts, but the first carries an empty queries array.
		expect(parsePlan('{"concepts":[{"name":"a","queries":[]},{"name":"b","queries":["q2","q3"]}]}')).toEqual({
			status: "fallback",
			reason: "invalid-shape",
		});
	});

	test("P7 a query over 300 chars is invalid; exactly 300 is valid", () => {
		const exactly300 = "x".repeat(300);
		const over300 = "x".repeat(301);
		const plan = (query: string): string =>
			JSON.stringify({ concepts: [{ name: "a", queries: [query] }, { name: "b", queries: ["q2"] }] });
		const valid = parsePlan(plan(exactly300));
		expect(valid.status).toBe("ok");
		if (valid.status !== "ok") return;
		expect(valid.plan.concepts[0]?.queries[0]).toHaveLength(300);
		expect(parsePlan(plan(over300))).toEqual({
			status: "fallback",
			reason: "invalid-shape",
		});
	});

	test("P8 more than six queries across concepts is invalid; six is valid", () => {
		const eight = JSON.stringify({
			concepts: [1, 2, 3, 4].map((n) => ({ name: `c${n}`, queries: [`q${n}a`, `q${n}b`] })),
		});
		const six = JSON.stringify({
			concepts: [1, 2, 3].map((n) => ({ name: `c${n}`, queries: [`q${n}a`, `q${n}b`] })),
		});
		expect(parsePlan(eight)).toEqual({ status: "fallback", reason: "invalid-shape" });
		const result = parsePlan(six);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.plan.concepts.flatMap((concept) => concept.queries)).toHaveLength(6);
	});

	test("P9 queries are trimmed and a whitespace-only query is invalid", () => {
		const trimmed = parsePlan('{"concepts":[{"name":"  a  ","queries":["  q1  "]},{"name":"b","queries":["q2"]}]}');
		expect(trimmed.status).toBe("ok");
		if (trimmed.status !== "ok") return;
		expect(trimmed.plan.concepts[0]?.name).toBe("a");
		expect(trimmed.plan.concepts[0]?.queries[0]).toBe("q1");
		// Isolated: two valid concepts, but the first query is whitespace-only.
		expect(
			parsePlan('{"concepts":[{"name":"a","queries":["   "]},{"name":"b","queries":["q2","q3"]}]}'),
		).toEqual({
			status: "fallback",
			reason: "invalid-shape",
		});
	});

	test("P10 every malformed corpus entry returns a typed result, never throws", () => {
		const corpus = [
			"",
			"   ",
			"no json here",
			"{",
			"{}",
			"[]",
			"null",
			"42",
			'{"concepts":"x"}',
			'{"concepts":[{"name":"a","queries":[1]}]}',
			'{"concepts":[{"name":"a","queries":["q1',
			'{"concepts":[{"name":"a","queries":["q1","q2"]},{"name":"b","queries":["q3"]}],"unexpected":',
		];
		for (const entry of corpus) {
			let result: ReturnType<typeof parsePlan> | undefined;
			try {
				result = parsePlan(entry);
			} catch (error) {
				throw new Error(`parsePlan threw on ${JSON.stringify(entry)}: ${String(error)}`);
			}
			expect(["ok", "fallback"]).toContain(result.status);
			if (result.status === "fallback") {
				expect(["empty-text", "no-json-object", "invalid-shape"]).toContain(result.reason);
			}
		}
	});
});

describe("planner prompts — persona pin and assembly", () => {
	test("P11 DELEGATOR_PERSONA equals the .ai-badger/agents/delegator.md body", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "..", ".ai-badger", "agents", "delegator.md"),
			"utf8",
		);
		const headingAt = source.indexOf("# Delegator");
		expect(headingAt).toBeGreaterThanOrEqual(0);
		const body = source.slice(headingAt);
		expect(DELEGATOR_PERSONA).toBe(body);
		// The frontmatter and any managed-by comment must not be embedded.
		expect(DELEGATOR_PERSONA.startsWith("# Delegator")).toBe(true);
		expect(DELEGATOR_PERSONA).not.toContain("name: delegator");
		expect(DELEGATOR_PERSONA).not.toContain("Managed by");
	});

	test("P12 buildPlannerUserPrompt inserts the raw query between <<< and >>> verbatim", () => {
		const query = "  explain the delegation watchdog\nand its retries  ";
		expect(buildPlannerUserPrompt(query)).toBe(`${MEASURED_PREFIX}${query}\n>>>`);
		// Independent copy: the production prefix is the measured harness prompt.
		expect(PLANNER_USER_PREFIX).toBe(MEASURED_PREFIX);
		expect(buildPlannerUserPrompt(query)).toBe(
			`${MEASURED_PREFIX}  explain the delegation watchdog\nand its retries  \n>>>`,
		);
		// No trimming, no escaping: quotes, backslashes and markers survive verbatim.
		const tricky = 'a "quoted" \\ backslash >>> marker';
		expect(buildPlannerUserPrompt(tricky)).toBe(`${MEASURED_PREFIX}${tricky}\n>>>`);
		// The conservative measured constraint wording is kept.
		expect(buildPlannerUserPrompt("q")).toContain("254-token embedding window");
	});

	test("P13 PLANNER_ADDENDUM pins the retrieval-query role and the JSON-only contract", () => {
		expect(PLANNER_ADDENDUM.startsWith("## Retrieval-query planning (this call's only role)")).toBe(true);
		expect(PLANNER_ADDENDUM).toContain('{"concepts":[{"name":"<short concept name>","queries":["<query>","<query>"]}]}');
		expect(PLANNER_ADDENDUM).toContain("no tools");
		expect(PLANNER_ADDENDUM).toContain("2 to 6 queries total");
		expect(PLANNER_ADDENDUM.endsWith("the final object must still be complete and valid.")).toBe(true);
		// The system prompt is the persona followed by the addendum (plan §3).
		const systemPrompt = `${DELEGATOR_PERSONA}\n\n${PLANNER_ADDENDUM}`;
		expect(systemPrompt).toContain("## Retrieval-query planning (this call's only role)");
		expect(systemPrompt.indexOf("# Delegator")).toBeLessThan(
			systemPrompt.indexOf("## Retrieval-query planning (this call's only role)"),
		);
	});
});
