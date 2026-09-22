/**
 * Minimal Jev `score` client (plan §4), copied by contract from
 * `decision-router-client.ts`: the same `OPENROUTER_API_KEY` /
 * `PI_BADGER_JEV_ENDPOINT` / `PI_BADGER_JEV_MODEL` names, the same error
 * vocabulary, and the same injected-fetch/scheduler/env seam — but its own
 * `score` question shape, batching and pool rules.
 *
 * Purity rules (house convention): the only import is `./types.ts`; no
 * wall-clock reads, no network and no ambient env — `now`, `scheduler`,
 * `fetchFn` and `env` arrive injected. Nothing in this file throws: builders
 * return wire objects, the parser returns typed rejects, and the scorer and
 * warm-up resolve typed results on every failure.
 *
 * Contract highlights (plan §4):
 *  - request body `{model, state, questions:{c<i>:{type:"score",instructions:
 *    {candidate:{path,kind,excerpt},question},criteria:[4 strings]}}}`;
 *    `state` ≤ 32000 chars, `excerpt` ≤ 500 chars, `path` =
 *    `hit.path ?? hit.sourceFile ?? ""`.
 *  - batches ≤ 12 (`SCORE_BATCH_MAX`), pool cap 48 by server rank, ≤ 3 attempts
 *    per batch, no backoff; retryable = `server|transport-timeout|malformed|
 *    rate-limited`, everything else is final. A 429's Retry-After is recorded,
 *    never slept on.
 *  - per-attempt timeout `min(PI_BADGER_JEV_SCORE_TIMEOUT_MS ?? 15000,
 *    deadlineMs − now())`; ≤ 0 skips the batch with nulls. The timeout races
 *    the injected fetch against the injected scheduler and aborts a
 *    per-attempt AbortController chained to the caller's signal.
 *  - `warmJevScore` issues exactly one tiny call (`state:"warm"`, candidate
 *    `{path:"warm",kind:"memory",excerpt:""}`, 5 s cap), discards the result
 *    and never throws.
 */

import {
	JEV_API_KEY_ENV,
	JEV_ENDPOINT_ENV,
	JEV_MODEL_ENV,
	JEV_SCORE_TIMEOUT_ENV,
	numEnv,
	type PipelineCandidate,
	type PipelineScore,
	type PipelineScorerFn,
	type PipelineScheduler,
	type ScoreUsage,
} from "./types.ts";

// ------------------------------------------------------------------ frozen consts (plan §4)

export const SCORE_BATCH_MAX = 12;
export const SCORE_ATTEMPTS = 3;
export const SCORE_POOL_MAX = 48;
export const SCORE_TIMEOUT_DEFAULT_MS = 15_000;
export const SCORE_TIMEOUT_MIN_MS = 1_000;
export const SCORE_TIMEOUT_MAX_MS = 120_000;
export const WARM_TIMEOUT_MS = 5_000;
export const SCORE_STATE_CHAR_CAP = 32_000;
export const SCORE_EXCERPT_CHAR_CAP = 500;
export const SCORE_ENDPOINT_DEFAULT = "https://openrouter.ai/api/alpha/decisions";
export const SCORE_MODEL_DEFAULT = "typesafe/jev-1.13";

/** Per-candidate question, verbatim from plan §4. */
export const SCORE_QUESTION =
	"How much does `candidate` help answer or implement the user's request in the state? Rate only this candidate.";

/** The four ordered criteria levels, verbatim from plan §4. */
export const SCORE_CRITERIA = [
	"unrelated — it does not touch the request",
	"related background — same area, but answers none of the request",
	"partially answers — covers one need, misses the rest",
	"directly answers — a specific need in the request is answered or implemented",
] as const;

/** Retry-After clamp floor/ceiling in ms (copy-by-contract of decision-router's R4). */
export const RETRY_AFTER_FLOOR_MS = 60_000;
export const RETRY_AFTER_CEIL_MS = 3_600_000;

/** Frozen error vocabulary, identical to decision-router's `JevErrorKind`. */
export const SCORE_ERROR_KINDS = [
	"misrouted-refusal",
	"auth",
	"billing",
	"rate-limited",
	"server",
	"transport-timeout",
	"malformed",
	"missing-key",
] as const;
export type JevScoreErrorKind = (typeof SCORE_ERROR_KINDS)[number];

export const SCORE_RETRYABLE_KINDS = [
	"server",
	"transport-timeout",
	"malformed",
	"rate-limited",
] as const satisfies readonly JevScoreErrorKind[];
export const SCORE_NON_RETRYABLE_KINDS = [
	"auth",
	"billing",
	"missing-key",
	"misrouted-refusal",
] as const satisfies readonly JevScoreErrorKind[];

const RETRYABLE = new Set<JevScoreErrorKind>(SCORE_RETRYABLE_KINDS);

// ------------------------------------------------------------------ wire + fetch types

export interface JevScoreWireCandidate {
	readonly path: string;
	readonly kind: "memory" | "code";
	readonly excerpt: string;
}

export interface JevScoreWireQuestion {
	readonly type: "score";
	readonly instructions: { readonly candidate: JevScoreWireCandidate; readonly question: string };
	readonly criteria: string[];
}

export interface JevScoreRequest {
	readonly model: string;
	readonly state: string;
	readonly questions: Record<string, JevScoreWireQuestion>;
}

export interface JevScoreFetchInit {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly signal: AbortSignal;
}

export interface JevScoreFetchHeaders {
	get(name: string): string | null;
}

export interface JevScoreFetchResponse {
	readonly status: number;
	readonly headers: JevScoreFetchHeaders;
	text(): Promise<string>;
}

export type JevScoreFetchFn = (url: string, init: JevScoreFetchInit) => Promise<JevScoreFetchResponse>;

export interface JevScoreDeps {
	readonly fetchFn: JevScoreFetchFn;
	readonly scheduler: PipelineScheduler;
	readonly now: () => number;
	/** Env record, read per call — never copied, never the ambient env. */
	readonly env: Record<string, string | undefined>;
}

// ------------------------------------------------------------------ small pure helpers

const DETAIL_CAP_CHARS = 120;

function capDetail(detail: string): string {
	return detail.length <= DETAIL_CAP_CHARS ? detail : detail.slice(0, DETAIL_CAP_CHARS);
}

function zeroUsage(): ScoreUsage {
	return { input_tokens: 0, output_tokens: 0, cost: 0 };
}

/** Finite score clamped to [0, 3]; anything else is missing evidence. */
function clampScore(value: number): number {
	return Math.min(3, Math.max(0, value));
}

/** Finite confidence clamped to [0, 1]; anything else is omitted. */
function clampConfidence(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(1, Math.max(0, value));
}

/** Retry-After (seconds) → clamped ms; missing/garbage → the 60 s floor. */
export function clampRetryAfterMs(header: string | null): number {
	const seconds = header === null ? Number.NaN : Number.parseInt(header, 10);
	if (!Number.isFinite(seconds)) return RETRY_AFTER_FLOOR_MS;
	return Math.min(RETRY_AFTER_CEIL_MS, Math.max(RETRY_AFTER_FLOOR_MS, seconds * 1000));
}

// ------------------------------------------------------------------ request builder

/** One `score` question for a candidate; the measured wire shape, verbatim. */
export function buildScoreQuestion(candidate: PipelineCandidate): JevScoreWireQuestion {
	return {
		type: "score",
		instructions: {
			candidate: {
				path: candidate.path ?? candidate.sourceFile ?? "",
				kind: candidate.kind ?? "memory",
				excerpt: (candidate.snippet ?? "").slice(0, SCORE_EXCERPT_CHAR_CAP),
			},
			question: SCORE_QUESTION,
		},
		criteria: [...SCORE_CRITERIA],
	};
}

// ------------------------------------------------------------------ response parser

export interface JevScoreAnswer {
	readonly score: number | null;
	readonly confidence?: number;
}

export interface JevScoreParsedBatch {
	readonly answers: Record<string, JevScoreAnswer>;
	readonly usage: ScoreUsage;
}

export type JevScoreBodyParse =
	| { readonly status: "ok"; readonly batch: JevScoreParsedBatch }
	| { readonly status: "reject"; readonly reason: "malformed" | "error-envelope"; readonly detail: string };

function parseUsage(value: unknown): ScoreUsage {
	const record = (
		typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
	) as Record<string, unknown>;
	const num = (candidate: unknown): number =>
		typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
	return {
		input_tokens: num(record["input_tokens"]),
		output_tokens: num(record["output_tokens"]),
		cost: num(record["cost"]),
	};
}

/** Tolerant per-answer parse: missing/wrong-type/non-finite → null, never a throw. */
function parseScoreAnswer(entry: unknown): JevScoreAnswer {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { score: null };
	const record = entry as Record<string, unknown>;
	if (record["type"] !== "score") return { score: null };
	const rawScore = record["score"];
	const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? clampScore(rawScore) : null;
	const confidence = clampConfidence(record["confidence"]);
	return confidence === undefined ? { score } : { score, confidence };
}

/** Parse one decisions body against the question names we asked. Never throws. */
export function parseScoreResponseBody(text: string, names: readonly string[]): JevScoreBodyParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { status: "reject", reason: "malformed", detail: "score body is not valid JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { status: "reject", reason: "malformed", detail: "score body is not a JSON object" };
	}
	const body = raw as Record<string, unknown>;
	if (body["error"] !== undefined && body["answers"] === undefined) {
		return { status: "reject", reason: "error-envelope", detail: "score response carries an error envelope" };
	}
	const answersRaw = body["answers"];
	const answersObj = (
		typeof answersRaw === "object" && answersRaw !== null && !Array.isArray(answersRaw) ? answersRaw : {}
	) as Record<string, unknown>;
	const answers: Record<string, JevScoreAnswer> = {};
	for (const name of names) answers[name] = parseScoreAnswer(answersObj[name]);
	return { status: "ok", batch: { answers, usage: parseUsage(body["usage"]) } };
}

// ------------------------------------------------------------------ classifier seam

export type JevScoreClassifyOutcome =
	| { readonly status: "ok"; readonly batch: JevScoreParsedBatch }
	| {
			readonly status: "error";
			readonly kind: JevScoreErrorKind;
			readonly retryAfterMs?: number;
			readonly detail: string;
	  };

function classifyError(kind: JevScoreErrorKind, detail: string, retryAfterMs?: number): JevScoreClassifyOutcome {
	return retryAfterMs === undefined
		? { status: "error", kind, detail }
		: { status: "error", kind, retryAfterMs, detail };
}

/** Map one HTTP response to a parsed batch or a typed error kind. Never throws. */
export async function classifyScoreResponse(
	response: JevScoreFetchResponse,
	names: readonly string[],
): Promise<JevScoreClassifyOutcome> {
	const status = response.status;
	if (status === 400) {
		return classifyError(
			"misrouted-refusal",
			"scoring endpoint refused the request (HTTP 400); check model and endpoint",
		);
	}
	if (status === 401) return classifyError("auth", "scoring endpoint rejected the credentials (HTTP 401)");
	if (status === 402) return classifyError("billing", "scoring endpoint reported a billing stop (HTTP 402)");
	if (status === 429) {
		let header: string | null = null;
		try {
			header = response.headers.get("retry-after");
		} catch {
			header = null;
		}
		return classifyError(
			"rate-limited",
			"scoring endpoint rate-limited the request (HTTP 429)",
			clampRetryAfterMs(header),
		);
	}
	if (status !== 200) return classifyError("server", `scoring endpoint failed (HTTP ${status})`);
	let text: string;
	try {
		text = await response.text();
	} catch {
		return classifyError("malformed", "score body could not be read");
	}
	const parsed = parseScoreResponseBody(text, names);
	if (parsed.status === "reject") {
		if (parsed.reason === "error-envelope") {
			return classifyError("server", "scoring endpoint returned an error envelope");
		}
		return classifyError("malformed", capDetail(parsed.detail));
	}
	return { status: "ok", batch: parsed.batch };
}

// ------------------------------------------------------------------ attempt machinery

type AttemptOutcome =
	| { readonly status: "ok"; readonly batch: JevScoreParsedBatch }
	| {
			readonly status: "error";
			readonly kind: JevScoreErrorKind;
			readonly retryAfterMs?: number;
			readonly detail: string;
	  }
	| { readonly status: "skipped"; readonly reason: "deadline" | "aborted" };

/**
 * One attempt: race the injected fetch against the injected scheduler timer and
 * the caller's abort signal. The timeout aborts the per-attempt controller so
 * the fetch's `init.signal.aborted` is observable; every armed timer is cleared.
 */
async function attemptScore(
	deps: JevScoreDeps,
	endpoint: string,
	key: string,
	body: string,
	attemptTimeoutMs: number,
	outerSignal: AbortSignal,
	names: readonly string[],
): Promise<AttemptOutcome> {
	if (outerSignal.aborted) return { status: "skipped", reason: "aborted" };
	const controller = new AbortController();
	let timer: unknown;
	let onAbort: (() => void) | undefined;
	try {
		const fetchPromise = deps
			.fetchFn(endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: controller.signal,
			})
			.then((response) => ({ kind: "response" as const, response }));
		const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
			timer = deps.scheduler.setTimeout(() => {
				controller.abort();
				resolve({ kind: "timeout" });
			}, attemptTimeoutMs);
		});
		const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
			onAbort = () => {
				controller.abort();
				resolve({ kind: "aborted" });
			};
			outerSignal.addEventListener("abort", onAbort, { once: true });
		});
		const winner = await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
		if (winner.kind === "timeout") {
			return {
				status: "error",
				kind: "transport-timeout",
				detail: `score request timed out after ${attemptTimeoutMs} ms`,
			};
		}
		if (winner.kind === "aborted") return { status: "skipped", reason: "aborted" };
		return await classifyScoreResponse(winner.response, names);
	} catch {
		return { status: "error", kind: "transport-timeout", detail: "score request failed in transport" };
	} finally {
		if (timer !== undefined) deps.scheduler.clearTimeout(timer);
		if (onAbort !== undefined) outerSignal.removeEventListener("abort", onAbort);
	}
}

// ------------------------------------------------------------------ pool

interface PoolEntry {
	readonly index: number;
	readonly poolIndex: number;
	readonly candidate: PipelineCandidate;
}

function serverRankOf(candidate: PipelineCandidate): number {
	return typeof candidate.ranking === "number" && Number.isFinite(candidate.ranking)
		? candidate.ranking
		: Number.POSITIVE_INFINITY;
}

/** Stable sort by server rank, then cap at `SCORE_POOL_MAX`. */
function capPool(candidates: readonly PipelineCandidate[]): PoolEntry[] {
	const decorated = candidates.map((candidate, index) => ({ index, candidate }));
	decorated.sort((a, b) => {
		const rankA = serverRankOf(a.candidate);
		const rankB = serverRankOf(b.candidate);
		if (rankA !== rankB) return rankA - rankB;
		return a.index - b.index;
	});
	return decorated.slice(0, SCORE_POOL_MAX).map((entry, poolIndex) => ({ ...entry, poolIndex }));
}

// ------------------------------------------------------------------ scorer

/**
 * The `PipelineScorerFn` seam. Results carry one entry per input candidate in
 * input order (nulls for out-of-pool, skipped, failed or missing answers); usage
 * sums every parsed batch; `batches` counts attempted HTTP batches.
 */
export function createJevScorer(deps: JevScoreDeps): PipelineScorerFn {
	return async function scoreCandidates(prompt, candidates, signal, deadlineMs) {
		const nullResults = (): PipelineScore[] => candidates.map((candidate) => ({ hash: candidate.hash, score: null }));
		try {
			if (candidates.length === 0) return { results: [], usage: zeroUsage(), batches: 0 };
			const key = deps.env[JEV_API_KEY_ENV];
			if (key === undefined || key.trim() === "") {
				return { results: nullResults(), usage: zeroUsage(), batches: 0 };
			}
			const endpoint = deps.env[JEV_ENDPOINT_ENV] ?? SCORE_ENDPOINT_DEFAULT;
			const model = deps.env[JEV_MODEL_ENV] ?? SCORE_MODEL_DEFAULT;
			const envTimeout = numEnv(deps.env, JEV_SCORE_TIMEOUT_ENV, {
				fallback: SCORE_TIMEOUT_DEFAULT_MS,
				min: SCORE_TIMEOUT_MIN_MS,
				max: SCORE_TIMEOUT_MAX_MS,
			});
			const state = prompt.slice(0, SCORE_STATE_CHAR_CAP);
			const pool = capPool(candidates);
			const scored = new Map<number, JevScoreAnswer>();
			const usage = zeroUsage();
			let batches = 0;

			for (let start = 0; start < pool.length; start += SCORE_BATCH_MAX) {
				if (signal.aborted) break;
				const slice = pool.slice(start, start + SCORE_BATCH_MAX);
				const questions: Record<string, JevScoreWireQuestion> = {};
				for (const entry of slice) questions[`c${entry.poolIndex}`] = buildScoreQuestion(entry.candidate);
				const body = JSON.stringify({ model, state, questions } satisfies JevScoreRequest);
				const names = Object.keys(questions);

				let outcome: AttemptOutcome | undefined;
				let attempt = 0;
				while (attempt < SCORE_ATTEMPTS) {
					const remaining = deadlineMs - deps.now();
					if (remaining <= 0 || signal.aborted) {
						outcome = { status: "skipped", reason: remaining <= 0 ? "deadline" : "aborted" };
						break;
					}
					attempt += 1;
					if (attempt === 1) batches += 1;
					outcome = await attemptScore(
						deps,
						endpoint,
						key,
						body,
						Math.min(envTimeout, remaining),
						signal,
						names,
					);
					if (outcome.status === "ok") break;
					if (outcome.status === "skipped") break;
					if (!RETRYABLE.has(outcome.kind)) break;
				}

				if (outcome?.status === "ok") {
					for (const entry of slice) {
						scored.set(entry.index, outcome.batch.answers[`c${entry.poolIndex}`] ?? { score: null });
					}
					usage.input_tokens += outcome.batch.usage.input_tokens;
					usage.output_tokens += outcome.batch.usage.output_tokens;
					usage.cost += outcome.batch.usage.cost;
				}
			}

			return {
				results: candidates.map((candidate, index) => {
					const answer = scored.get(index);
					return answer === undefined ? { hash: candidate.hash, score: null } : { hash: candidate.hash, ...answer };
				}),
				usage,
				batches,
			};
		} catch {
			return { results: nullResults(), usage: zeroUsage(), batches: 0 };
		}
	};
}

// ------------------------------------------------------------------ warm-up

/**
 * One tiny score call (`state:"warm"`, a single `warm` candidate, 5 s cap) to
 * pay the measured cold-first-call penalty at session start. Exactly one fetch
 * attempt, the result is discarded, and nothing ever throws.
 */
export async function warmJevScore(deps: JevScoreDeps): Promise<void> {
	try {
		const key = deps.env[JEV_API_KEY_ENV];
		if (key === undefined || key.trim() === "") return;
		const endpoint = deps.env[JEV_ENDPOINT_ENV] ?? SCORE_ENDPOINT_DEFAULT;
		const model = deps.env[JEV_MODEL_ENV] ?? SCORE_MODEL_DEFAULT;
		const request: JevScoreRequest = {
			model,
			state: "warm",
			questions: { c0: buildScoreQuestion({ hash: "warm", path: "warm", kind: "memory", snippet: "" }) },
		};
		await attemptScore(deps, endpoint, key, JSON.stringify(request), WARM_TIMEOUT_MS, new AbortController().signal, [
			"c0",
		]);
	} catch {
		// fail-open by contract: the preload never blocks or fails a session
	}
}
