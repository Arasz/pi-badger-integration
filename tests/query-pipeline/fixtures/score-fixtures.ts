/**
 * Query-pipeline score-client fixtures (PKG-2): the measured wire request/answer
 * shape from plan §4 / research B2, plus SYNTH error bodies for the status and
 * tolerance rows.
 *
 * Honesty note: the *shape* of the request and answer is the measured one
 * (`{model,state,questions:{c<i>:{type:"score",instructions:{candidate:{path,
 * kind,excerpt},question},criteria:[4 strings]}}}` and
 * `answers.c<i>.{type:"score",score,confidence,probabilities,legend}`). The
 * numeric values below are stipulated stand-ins: the raw eval JSON lived in
 * `/tmp/rag-multiquery/eval/*.eval.json`, which is not committed to this repo.
 * Error bodies are SYNTH, exactly like `tests/decision-router/fixtures/`.
 */

/** The four score criteria, verbatim from plan §4 (measured harness wording). */
export const MEASURED_CRITERIA = [
	"unrelated — it does not touch the request",
	"related background — same area, but answers none of the request",
	"partially answers — covers one need, misses the rest",
	"directly answers — a specific need in the request is answered or implemented",
] as const;

/** The per-candidate question, verbatim from plan §4. */
export const MEASURED_QUESTION =
	"How much does `candidate` help answer or implement the user's request in the state? Rate only this candidate.";

/** The raw pre-expansion prompt stand-in used by the measured request fixture. */
export const MEASURED_PROMPT = "How does the delegation timeout watchdog interact with retries?";

export interface MeasuredScoreCandidate {
	readonly path: string;
	readonly kind: "memory" | "code";
	readonly excerpt: string;
}

export interface MeasuredScoreQuestion {
	readonly type: "score";
	readonly instructions: { readonly candidate: MeasuredScoreCandidate; readonly question: string };
	readonly criteria: string[];
}

/** One wire question exactly as the measured request carried it. */
export function measuredScoreQuestion(candidate: MeasuredScoreCandidate): MeasuredScoreQuestion {
	return {
		type: "score",
		instructions: { candidate: { ...candidate }, question: MEASURED_QUESTION },
		criteria: [...MEASURED_CRITERIA],
	};
}

/** The measured request shape with two candidate questions. */
export const MEASURED_SCORE_REQUEST = {
	model: "typesafe/jev-1.13",
	state: MEASURED_PROMPT,
	questions: {
		c0: measuredScoreQuestion({ path: "docs/a.md", kind: "memory", excerpt: "watchdog excerpt" }),
		c1: measuredScoreQuestion({ path: "extensions/b.ts", kind: "code", excerpt: "retry excerpt" }),
	},
} as const;

/**
 * The measured answer shape (plan §4 / research B2): `answers.c<i>` carries
 * `type:"score"`, a continuous `score`, `confidence` plus the measured extra
 * `probabilities`/`legend` fields the parser must tolerate.
 */
export const MEASURED_SCORE_ANSWER = {
	model: "typesafe/jev-1.13-20260917",
	answers: {
		c0: {
			type: "score",
			score: 2.5,
			confidence: 0.91,
			probabilities: [0.01, 0.04, 0.14, 0.81],
			legend: ["unrelated", "related background", "partially answers", "directly answers"],
		},
		c1: {
			type: "score",
			score: 1,
			confidence: 0.77,
			probabilities: [0.1, 0.55, 0.3, 0.05],
			legend: ["unrelated", "related background", "partially answers", "directly answers"],
		},
		c2: {
			type: "score",
			score: 0,
			confidence: 0.95,
			probabilities: [0.9, 0.08, 0.02, 0],
			legend: ["unrelated", "related background", "partially answers", "directly answers"],
		},
	},
	usage: { input_tokens: 812, output_tokens: 64, cost: 0.000034 },
	id: "gen-dec-synth-score-1",
	provider: "TypeSafe",
} as const;

/** SYNTH (stipulated): 400 body the client maps to `misrouted-refusal`; marker for the leak row. */
export const SYNTH_SCORE_BAD_REQUEST_BODY = '{"error":{"message":"invalid model","code":400},"marker":"SECRET-BODY-MARKER"}';

/** SYNTH (stipulated): 401 body the client maps to `auth`. */
export const SYNTH_SCORE_UNAUTHORIZED_BODY = '{"error":{"message":"Invalid API key provided","code":401}}';

/** SYNTH (stipulated): 402 body the client maps to `billing`. */
export const SYNTH_SCORE_PAYMENT_REQUIRED_BODY = '{"error":{"message":"Insufficient credits","code":402}}';

/** SYNTH (stipulated): 429 body; the Retry-After header drives the recorded value. */
export const SYNTH_SCORE_RATE_LIMITED_BODY = '{"error":{"message":"Rate limit exceeded, retry later","code":429}}';

/** SYNTH (stipulated): 500 body the client maps to `server`. */
export const SYNTH_SCORE_SERVER_ERROR_BODY = '{"error":{"message":"upstream scoring failed","code":500}}';

/** SYNTH (stipulated): HTTP-200 error envelope → typed `server` reject. */
export const SYNTH_SCORE_ERROR_ENVELOPE =
	'{"error":{"message":"upstream scoring failed","code":500},"id":"gen-dec-synth-score-err","provider":"TypeSafe"}';

/** SYNTH (stipulated): truncated JSON mid-body → typed `malformed` reject. */
export const SYNTH_SCORE_TRUNCATED_JSON = '{"model":"typesafe/jev-1.13-20260917","answers":{"c0":{"type":"score","sco';

/** SYNTH (stipulated): only c0 answered; c1/c2 must parse as null, never 0. */
export const SYNTH_SCORE_PARTIAL_ANSWERS_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: { c0: { type: "score", score: 2.5, confidence: 0.91 } },
	usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 },
	id: "gen-dec-synth-score-partial",
	provider: "TypeSafe",
});

/** SYNTH (stipulated): per-answer tolerance table — every wrong shape must parse to null. */
export const SYNTH_SCORE_WRONG_SHAPES_BODY = JSON.stringify({
	model: "typesafe/jev-1.13-20260917",
	answers: {
		c0: { type: "score", score: -1, confidence: 2 },
		c1: { type: "score", score: 5, confidence: -1 },
		c2: { type: "score", score: 1e999 },
		c3: { type: "score", score: "2" },
		c4: { type: "score", score: null },
		c5: { type: "choice", choice: "billing", confidence: 0.9 },
		c6: { type: "score", score: 1.5, confidence: "high" },
	},
	usage: { input_tokens: 200, output_tokens: 20, cost: 0.00002 },
	id: "gen-dec-synth-score-shapes",
	provider: "TypeSafe",
});
