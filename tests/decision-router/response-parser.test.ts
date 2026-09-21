/**
 * Response-parser tests for the decision-router core (plan v2 P1, rows B1–B12).
 *
 * Hermetic by construction: every body comes from `fixtures/jev-fixtures.ts`
 * (measured bodies transcribed from `fixtures/raw/`, SYNTH shapes stipulated where
 * the live probes never went). The first describe block pins the transcription —
 * if a fixture drifts from its raw file, that goes red, not the parser rows.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	clampProbability,
	parseJevResponseBody,
	type JevAnswerSpec,
} from "../../extensions/decision-router/decision-router-client.ts";
import {
	API500_RESPONSE,
	JSON_STATE_RESPONSE,
	MEASURED_FIXTURES,
	MODEL_TIER_RESPONSE,
	PAYOUT_REPEAT_RESPONSE,
	PAYOUT_RESPONSE,
	PRICING_RESPONSE,
	SYNTH_BAD_PROBABILITIES_BODY,
	SYNTH_ERROR_ENVELOPE,
	SYNTH_EXTRA_FIELDS_BODY,
	SYNTH_MISKEYED_BODY,
	SYNTH_NO_CONFIDENCE_BODY,
	SYNTH_NO_PROBABILITIES_BODY,
	SYNTH_TRUNCATED_JSON,
	SYNTH_TYPE_MISMATCH_BODY,
	SYNTH_UNKNOWN_CHOICE_BODY,
	TOOL_SELECTION_RESPONSE,
} from "./fixtures/jev-fixtures.ts";

const RAW_DIR = join(import.meta.dir, "fixtures", "raw");

/** Single-question department spec over the probe's three options. */
const DEPT_SPEC: JevAnswerSpec = {
	questions: { department: { type: "choice", options: ["billing", "technical", "sales"] } },
};

/** Two-question spec matching the measured 04 tool-selection fan-out. */
const TOOL_SPEC: JevAnswerSpec = {
	questions: {
		first_tool: { type: "choice", options: ["read", "write", "edit", "bash", "grep"] },
		complexity: { type: "choice", options: ["low", "medium", "high"] },
	},
};

/** Mixed choice + noul spec matching the measured 06 fan-out. */
const MIXED_SPEC: JevAnswerSpec = {
	questions: {
		first_tool: { type: "choice", options: ["read", "write", "edit", "bash", "grep", "delegate"] },
		needs_subagent: { type: "noul" },
	},
};

// --------------------------------------------------------------- verbatim pin

describe("measured fixtures are verbatim copies of fixtures/raw", () => {
	for (const { file, body } of MEASURED_FIXTURES) {
		test(`${file} transcribes byte-identical JSON`, () => {
			const rawText = readFileSync(join(RAW_DIR, file), "utf8");
			expect(JSON.parse(rawText)).toEqual(JSON.parse(JSON.stringify(body)));
		});
	}
});

// --------------------------------------------------------------- B1–B4 measured bodies

describe("B1 — payout triage parses verbatim", () => {
	test("billing winner with probabilities, confidence and usage intact", () => {
		const parsed = parseJevResponseBody(JSON.stringify(PAYOUT_RESPONSE), DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.model).toBe("typesafe/jev-1.13-20260917");
		expect(parsed.id).toBe("gen-dec-1790021978-K7JjmqPBxMh2kmgQVVfq");
		expect(parsed.provider).toBe("TypeSafe");
		expect(parsed.usage).toEqual({ input_tokens: 364, output_tokens: 38, cost: 0.000015288 });
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "billing",
				probabilities: { billing: 1, sales: 0, technical: 0 },
				confidence: 0.99,
			},
		});
	});
});

describe("B2 — api500 and pricing parse verbatim", () => {
	test("technical winner with confidence 1", () => {
		const parsed = parseJevResponseBody(JSON.stringify(API500_RESPONSE), DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "technical",
				probabilities: { technical: 1, billing: 0, sales: 0 },
				confidence: 1,
			},
		});
	});

	test("sales winner with confidence 1", () => {
		const parsed = parseJevResponseBody(JSON.stringify(PRICING_RESPONSE), DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		const answer = parsed.answers["department"];
		expect(answer.status).toBe("ok");
		if (answer.status !== "ok") throw new Error("expected ok answer");
		expect(answer.answer).toMatchObject({ type: "choice", choice: "sales", confidence: 1 });
	});
});

describe("B3 — multi-question tool-selection fan-out parses verbatim", () => {
	test("both questions land independently (low-confidence read pick preserved)", () => {
		const parsed = parseJevResponseBody(JSON.stringify(TOOL_SELECTION_RESPONSE), TOOL_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["first_tool"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "read",
				probabilities: { write: 0, edit: 0, read: 0.69, bash: 0.23, grep: 0.08 },
				confidence: 0.61,
			},
		});
		expect(parsed.answers["complexity"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "low",
				probabilities: { medium: 0.12, low: 0.88, high: 0 },
				confidence: 0.81,
			},
		});
	});
});

describe("B4 — choice + noul fan-out parses verbatim", () => {
	test("bash winner and the noul number both survive", () => {
		const parsed = parseJevResponseBody(JSON.stringify(JSON_STATE_RESPONSE), MIXED_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		const tool = parsed.answers["first_tool"];
		expect(tool.status).toBe("ok");
		if (tool.status !== "ok") throw new Error("expected ok answer");
		expect(tool.answer).toMatchObject({ type: "choice", choice: "bash", confidence: 0.89 });
		expect(parsed.answers["needs_subagent"]).toEqual({
			status: "ok",
			answer: { type: "noul", noul: 0.35 },
		});
	});
});

// --------------------------------------------------------------- B5–B8 fail-closed rejects

describe("B5 — mis-keyed answer rejects that question, never throws", () => {
	test("expected name absent degrades to a typed reject with the body still usable", () => {
		const parsed = parseJevResponseBody(SYNTH_MISKEYED_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toMatchObject({ status: "reject", reason: "mis-keyed" });
	});

	test("a wholly missing answers object mis-keys every expected question", () => {
		const parsed = parseJevResponseBody('{"model":"m","id":"i","provider":"p"}', DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toMatchObject({ status: "reject", reason: "mis-keyed" });
	});
});

describe("B6 — type mismatch rejects that question, never throws", () => {
	test("noul answer against a choice spec rejects", () => {
		const parsed = parseJevResponseBody(SYNTH_TYPE_MISMATCH_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toMatchObject({ status: "reject", reason: "type-mismatch" });
	});

	test("choice answer against a noul spec rejects", () => {
		const parsed = parseJevResponseBody(
			JSON.stringify(JSON_STATE_RESPONSE),
			{ questions: { needs_subagent: { type: "choice", options: ["yes", "no"] } } },
		);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["needs_subagent"]).toMatchObject({ status: "reject", reason: "type-mismatch" });
	});
});

describe("B7 — unknown (ghost) winner rejects the whole question", () => {
	test("delegate is not in the live catalogue, so the question rejects even at conf 0.9", () => {
		const parsed = parseJevResponseBody(SYNTH_UNKNOWN_CHOICE_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toMatchObject({ status: "reject", reason: "unknown-choice" });
	});
});

describe("B8 — out-of-range probabilities clamp, never throw", () => {
	test("negative clamps to 0, above-1 clamps to 1, over-1 confidence clamps to 1", () => {
		const parsed = parseJevResponseBody(SYNTH_BAD_PROBABILITIES_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "billing",
				probabilities: { billing: 1, technical: 0, sales: 0 },
				confidence: 1,
			},
		});
	});

	test("clampProbability: NaN and non-numbers become 0 (JSON text cannot spell NaN)", () => {
		expect(clampProbability(Number.NaN)).toBe(0);
		expect(clampProbability("0.5")).toBe(0);
		expect(clampProbability(undefined)).toBe(0);
		expect(clampProbability(-0.25)).toBe(0);
		expect(clampProbability(1.5)).toBe(1);
		expect(clampProbability(0.23)).toBe(0.23);
	});
});

// --------------------------------------------------------------- B9–B12 preservation and defaults

describe("B9 — zero-probability options are preserved, not pruned", () => {
	test("sales 0 survives the repeat body verbatim", () => {
		const parsed = parseJevResponseBody(JSON.stringify(PAYOUT_REPEAT_RESPONSE), DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		const answer = parsed.answers["department"];
		expect(answer.status).toBe("ok");
		if (answer.status !== "ok") throw new Error("expected ok answer");
		expect(answer.answer).toMatchObject({
			probabilities: { billing: 0.99, technical: 0.01, sales: 0 },
		});
	});
});

describe("B10 — unknown extra fields are ignored at body and answer level", () => {
	test("legend, future_field, extra usage and answer fields change nothing", () => {
		const parsed = parseJevResponseBody(SYNTH_EXTRA_FIELDS_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "billing",
				probabilities: { billing: 1, sales: 0, technical: 0 },
				confidence: 0.99,
			},
		});
		// The unpredicted extra question is dropped, not bled into the typed surface.
		expect(Object.keys(parsed.answers)).toEqual(["department"]);
	});
});

describe("B10b — noul numbers and multi-question fan-out survive together", () => {
	test("needs_subagent 0.35 is exact and both 06 answers are present", () => {
		const parsed = parseJevResponseBody(JSON.stringify(JSON_STATE_RESPONSE), MIXED_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(Object.keys(parsed.answers).sort()).toEqual(["first_tool", "needs_subagent"]);
		expect(parsed.answers["needs_subagent"]).toEqual({ status: "ok", answer: { type: "noul", noul: 0.35 } });
	});
});

describe("B11 — missing confidence defaults to 0", () => {
	test("the choice still parses; only confidence is zeroed", () => {
		const parsed = parseJevResponseBody(SYNTH_NO_CONFIDENCE_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "billing",
				probabilities: { billing: 0.99, technical: 0.01, sales: 0 },
				confidence: 0,
			},
		});
	});
});

describe("B12 — missing probabilities degrade to winner-only with confidence 0", () => {
	test("probabilities carry only the winner at 1 and confidence is forced to 0", () => {
		const parsed = parseJevResponseBody(SYNTH_NO_PROBABILITIES_BODY, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 0 },
		});
	});

	test("a non-object probabilities value degrades the same way", () => {
		const body = JSON.stringify({
			model: "m",
			answers: { department: { type: "choice", choice: "billing", probabilities: [0.5], confidence: 0.9 } },
			id: "i",
			provider: "p",
		});
		const parsed = parseJevResponseBody(body, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 0 },
		});
	});
});

describe("A2 (code-S1) — an inconsistent probability map degrades to winner-only (fail-closed)", () => {
	test("a winner absent from probabilities never actuates a non-winner", () => {
		const body = JSON.stringify({
			model: "m",
			answers: {
				department: { type: "choice", choice: "billing", probabilities: { sales: 0.9 }, confidence: 0.99 },
			},
			id: "i",
			provider: "p",
		});
		const parsed = parseJevResponseBody(body, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 0 },
		});
	});

	test("a winner whose entry is not a finite number degrades the same way", () => {
		const body = JSON.stringify({
			model: "m",
			answers: {
				department: {
					type: "choice",
					choice: "billing",
					probabilities: { billing: "0.99", sales: 0.01 },
					confidence: 0.99,
				},
			},
			id: "i",
			provider: "p",
		});
		const parsed = parseJevResponseBody(body, DEPT_SPEC);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["department"]).toEqual({
			status: "ok",
			answer: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 0 },
		});
	});
});

// --------------------------------------------------------------- body-level rejects

describe("truncated JSON and error envelopes reject at the body level, never throw", () => {
	test("truncated JSON is malformed", () => {
		expect(parseJevResponseBody(SYNTH_TRUNCATED_JSON, DEPT_SPEC)).toMatchObject({
			status: "reject",
			reason: "malformed",
		});
		expect(parseJevResponseBody("not json at all{{", DEPT_SPEC)).toMatchObject({
			status: "reject",
			reason: "malformed",
		});
	});

	test("an error envelope is error-envelope, not a decision", () => {
		expect(parseJevResponseBody(SYNTH_ERROR_ENVELOPE, DEPT_SPEC)).toMatchObject({
			status: "reject",
			reason: "error-envelope",
		});
	});

	test("a missing noul value is a type-mismatch reject, not a silent zero", () => {
		const body = JSON.stringify({
			model: "m",
			answers: { needs_subagent: { type: "noul" } },
			id: "i",
			provider: "p",
		});
		const parsed = parseJevResponseBody(body, { questions: { needs_subagent: { type: "noul" } } });
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["needs_subagent"]).toMatchObject({ status: "reject", reason: "type-mismatch" });
	});
});

// --------------------------------------------------------------- tier regression pin

describe("tier fixture parses against its own rubric", () => {
	test("medium winner with the measured 0.79/0.21/0.69 vector (brief said 0.84/0.16/0.75)", () => {
		const parsed = parseJevResponseBody(JSON.stringify(MODEL_TIER_RESPONSE), {
			questions: { tier: { type: "choice", options: ["low", "medium", "high"] } },
		});
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("expected ok");
		expect(parsed.answers["tier"]).toEqual({
			status: "ok",
			answer: {
				type: "choice",
				choice: "medium",
				probabilities: { medium: 0.79, low: 0.21, high: 0 },
				confidence: 0.69,
			},
		});
	});
});
