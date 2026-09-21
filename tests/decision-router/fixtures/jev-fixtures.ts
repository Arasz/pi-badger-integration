/**
 * Decision-router fixtures: measured Jev response bodies plus stipulated SYNTH shapes.
 *
 * Measured bodies are transcribed verbatim from `fixtures/raw/*.response.json`
 * (probed 2026-09-21, committed on the task branch). A test in
 * `response-parser.test.ts` asserts deep-equality against those raw files, so any
 * transcription drift goes red immediately.
 *
 * Shapes the live probes did not cover (401/402/429, timeouts, truncated JSON,
 * error envelopes, mis-keyed/type-mismatched answers) are STIPULATED stand-ins and
 * are marked SYNTH below. Plan v2 F23 records 401/402/429 as SYNTH-stipulated.
 */

/** Measured 2026-09-21: payout triage → billing (verbatim from 01-payout.response.json). */
export const PAYOUT_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "billing",
			probabilities: { billing: 1, sales: 0, technical: 0 },
			confidence: 0.99,
		},
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-1790021978-K7JjmqPBxMh2kmgQVVfq",
	provider: "TypeSafe",
} as const;

/** Measured 2026-09-21: identical payout repeat (verbatim from 01b-payout-repeat.response.json). */
export const PAYOUT_REPEAT_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "billing",
			probabilities: { billing: 0.99, technical: 0.01, sales: 0 },
			confidence: 0.99,
		},
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-1790021978-tASuaqcbYZZLzILVqgiq",
	provider: "TypeSafe",
} as const;

/** Measured 2026-09-21: API 500s after deploy → technical (verbatim from 02-api500.response.json). */
export const API500_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "technical",
			probabilities: { technical: 1, billing: 0, sales: 0 },
			confidence: 1,
		},
	},
	usage: { input_tokens: 371, output_tokens: 38, cost: 0.000015582 },
	id: "gen-dec-1790021979-gzZdaBE615kXDG0szsFC",
	provider: "TypeSafe",
} as const;

/** Measured 2026-09-21: pricing question → sales (verbatim from 03-pricing.response.json). */
export const PRICING_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "sales",
			probabilities: { sales: 1, billing: 0, technical: 0 },
			confidence: 1,
		},
	},
	usage: { input_tokens: 368, output_tokens: 38, cost: 0.000015456 },
	id: "gen-dec-1790021979-n1Izm9HTZc0VNCwITIlg",
	provider: "TypeSafe",
} as const;

/**
 * Measured 2026-09-21: multi-question fan-out, low-confidence tool pick
 * (verbatim from 04-tool-selection.response.json). NOTE: the lane brief describes
 * this case as "bash 0.91 / conf 0.90" — the saved body says read 0.69 / conf 0.61
 * (bash 0.91 / conf 0.89 is case 06). The raw file wins; the brief is stale.
 */
export const TOOL_SELECTION_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		first_tool: {
			type: "choice",
			choice: "read",
			probabilities: { write: 0, edit: 0, read: 0.69, bash: 0.23, grep: 0.08 },
			confidence: 0.61,
		},
		complexity: {
			type: "choice",
			choice: "low",
			probabilities: { medium: 0.12, low: 0.88, high: 0 },
			confidence: 0.81,
		},
	},
	usage: { input_tokens: 474, output_tokens: 90, cost: 0.000019908 },
	id: "gen-dec-1790021980-Njk9KqFO19u84952l3ll",
	provider: "TypeSafe",
} as const;

/**
 * Measured 2026-09-21: tier question (verbatim from 05-model-tier.response.json).
 * NOTE: the lane brief and plan R8 cite medium 0.84 / low 0.16 / conf 0.75 —
 * the saved body says medium 0.79 / low 0.21 / conf 0.69. Raw file wins.
 */
export const MODEL_TIER_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		tier: {
			type: "choice",
			choice: "medium",
			probabilities: { medium: 0.79, low: 0.21, high: 0 },
			confidence: 0.69,
		},
	},
	usage: { input_tokens: 365, output_tokens: 38, cost: 0.00001533 },
	id: "gen-dec-1790021980-Wz1greewFPIuduuawMaZ",
	provider: "TypeSafe",
} as const;

/**
 * Measured 2026-09-21: choice + noul fan-out (verbatim from 06-json-state.response.json).
 * This is the case with bash 0.9 / conf 0.89 and needs_subagent noul 0.35.
 */
export const JSON_STATE_RESPONSE = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		first_tool: {
			type: "choice",
			choice: "bash",
			probabilities: { bash: 0.9, grep: 0.04, edit: 0, delegate: 0.01, read: 0.05, write: 0 },
			confidence: 0.89,
		},
		needs_subagent: { type: "noul", noul: 0.35 },
	},
	usage: { input_tokens: 486, output_tokens: 79, cost: 0.000020412 },
	id: "gen-dec-1790021981-w6uuuUCsm6jwVvv8krwx",
	provider: "TypeSafe",
} as const;

/** Raw-file stem per measured export, for the verbatim cross-check test. */
export const MEASURED_FIXTURES: ReadonlyArray<{ readonly file: string; readonly body: unknown }> = [
	{ file: "01-payout.response.json", body: PAYOUT_RESPONSE },
	{ file: "01b-payout-repeat.response.json", body: PAYOUT_REPEAT_RESPONSE },
	{ file: "02-api500.response.json", body: API500_RESPONSE },
	{ file: "03-pricing.response.json", body: PRICING_RESPONSE },
	{ file: "04-tool-selection.response.json", body: TOOL_SELECTION_RESPONSE },
	{ file: "05-model-tier.response.json", body: MODEL_TIER_RESPONSE },
	{ file: "06-json-state.response.json", body: JSON_STATE_RESPONSE },
];

/** SYNTH (stipulated, not measured): 401 body the classifier maps to `auth`. */
export const SYNTH_UNAUTHORIZED_BODY = '{"error":{"message":"Invalid API key provided","code":401}}';

/** SYNTH (stipulated, not measured): 402 body the classifier maps to `billing`. */
export const SYNTH_PAYMENT_REQUIRED_BODY = '{"error":{"message":"Insufficient credits","code":402}}';

/** SYNTH (stipulated, not measured): 429 body; the Retry-After header drives the cooldown. */
export const SYNTH_RATE_LIMITED_BODY = '{"error":{"message":"Rate limit exceeded, retry later","code":429}}';

/** SYNTH (stipulated, not measured): truncated JSON mid-body → `malformed`. */
export const SYNTH_TRUNCATED_JSON = '{"model":"typesafe/jev-1.13-20260917","answers":{"depart';

/** SYNTH (stipulated, not measured): HTTP-200 error envelope → `error-envelope`. */
export const SYNTH_ERROR_ENVELOPE =
	'{"error":{"message":"upstream decision failed","code":500},"id":"gen-dec-synth-1","provider":"TypeSafe"}';

/** SYNTH (stipulated, not measured): answer keyed under the wrong name → `mis-keyed`. */
export const SYNTH_MISKEYED_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: {
		departmant: {
			type: "choice",
			choice: "billing",
			probabilities: { billing: 0.99, technical: 0.01, sales: 0 },
			confidence: 0.99,
		},
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-synth-miskeyed",
	provider: "TypeSafe",
});

/** SYNTH (stipulated, not measured): answer type disagrees with the spec → `type-mismatch`. */
export const SYNTH_TYPE_MISMATCH_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: { department: { type: "noul", noul: 0.83 } },
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-synth-typemismatch",
	provider: "TypeSafe",
});

/** SYNTH (stipulated, not measured): winner outside the live catalogue → `unknown-choice`. */
export const SYNTH_UNKNOWN_CHOICE_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "delegate",
			probabilities: { delegate: 0.9, billing: 0.05, technical: 0.05, sales: 0 },
			confidence: 0.9,
		},
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-synth-ghost",
	provider: "TypeSafe",
});

/** SYNTH (stipulated, not measured): unknown fields at body AND answer level are ignored. */
export const SYNTH_EXTRA_FIELDS_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "billing",
			probabilities: { billing: 1, sales: 0, technical: 0 },
			confidence: 0.99,
			reasoning: "not part of the contract",
		},
		shadow_extra_question: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 },
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288, extra_usage_field: 7 },
	id: "gen-dec-synth-extra",
	provider: "TypeSafe",
	legend: "not part of the contract",
	future_field: { nested: true },
});

/** SYNTH (stipulated, not measured): choice answer without confidence → confidence 0. */
export const SYNTH_NO_CONFIDENCE_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "billing",
			probabilities: { billing: 0.99, technical: 0.01, sales: 0 },
		},
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-synth-noconf",
	provider: "TypeSafe",
});

/** SYNTH (stipulated, not measured): choice answer without probabilities → winner-only, confidence 0. */
export const SYNTH_NO_PROBABILITIES_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: { department: { type: "choice", choice: "billing", confidence: 0.99 } },
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-synth-noprobs",
	provider: "TypeSafe",
});

/** SYNTH (stipulated, not measured): out-of-range probabilities are clamped, never throw. */
export const SYNTH_BAD_PROBABILITIES_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: {
		department: {
			type: "choice",
			choice: "billing",
			probabilities: { billing: 2, technical: -0.5, sales: 0 },
			confidence: 1.5,
		},
	},
	usage: { input_tokens: 364, output_tokens: 38, cost: 0.000015288 },
	id: "gen-dec-synth-badprobs",
	provider: "TypeSafe",
});
