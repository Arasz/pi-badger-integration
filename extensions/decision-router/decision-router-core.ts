/**
 * Pure core (part 1) for the decision-router extension: request builders, the
 * response parser, the injected-fetch classifier seam and the fallback classifier.
 *
 * Purity rules (house convention): zero imports; no wall-clock reads, no network
 * and no ambient env — `now`, `scheduler`, `fetchFn` and `env` arrive injected,
 * so every edge is deterministic under stubs. Nothing in this file throws:
 * builders return typed holds, the parser returns typed rejects, and the
 * classifier returns typed error kinds.
 *
 * Frozen contract (plan v2): the threshold consts, REQUEST_TIMEOUT_MS, the
 * STATE_BYTE_BUDGET / PROMPT_CHAR_CAP / CRITERION_CHAR_CAP budgets, the
 * catalogue rule (sorted names, uniform description truncation, typed
 * catalogue-over-budget hold), the fixed tier rubric, and the error vocabulary.
 */

// ------------------------------------------------------------------ frozen consts (plan v2)

export const TOOL_PROB_FLOOR = 0.2;
export const TOOL_CONFIDENCE_GATE = 0.7;
export const UPGRADE_CONFIDENCE_GATE = 0.6;
export const DEMOTE_CONFIDENCE_GATE = 0.85;
export const MIN_PROMPT_CHARS = 12;
export const REQUEST_TIMEOUT_MS = 2500;
export const CACHE_MAX_ENTRIES = 50;
export const STATE_BYTE_BUDGET = 8192;
export const PROMPT_CHAR_CAP = 2000;
export const CRITERION_CHAR_CAP = 200;

/** Default decision model sent on the wire (overridable per builder input). */
export const JEV_MODEL_DEFAULT = "typesafe/jev-1.13";
/** Default OpenRouter decisions endpoint (overridable via env per call). */
export const JEV_ENDPOINT_DEFAULT = "https://openrouter.ai/api/alpha/decisions";
/** Jev choice questions accept at most 255 options (measured contract F2). */
export const JEV_MAX_OPTIONS = 255;
/** Retry-After clamp floor/ceiling in ms: 60 s–1 h (plan v2 R4). */
export const RETRY_AFTER_FLOOR_MS = 60_000;
export const RETRY_AFTER_CEIL_MS = 3_600_000;
/** Keyword fallback match cap (bounded matcher, see createFallbackClassifier). */
export const FALLBACK_MAX_TOOLS = 5;

/** Env names read per call (R6). Only the literal "0" disables (P2 owns the flags). */
export const JEV_API_KEY_ENV = "OPENROUTER_API_KEY";
export const JEV_ENDPOINT_ENV = "PI_BADGER_JEV_ENDPOINT";
export const JEV_TIMEOUT_ENV = "PI_BADGER_JEV_TIMEOUT_MS";
export const JEV_MODEL_ENV = "PI_BADGER_JEV_MODEL";

/** Fixed tier rubric (RES F7 wording, frozen per plan v2 F17). */
export const TIER_CRITERIA = {
	low: "Mechanical, single-file or rename-level change",
	medium: "Multi-file change needing judgement",
	high: "Design, debugging, architecture",
} as const;

export const TOOL_INSTRUCTIONS = "Which tools are needed for this task?";
export const TIER_INSTRUCTIONS = "Which model tier is sufficient for this task?";
export const SKILL_INSTRUCTIONS = "Which skill should handle this task?";
export const NEEDS_SUBAGENT_INSTRUCTIONS = "Does this task need a subagent?";
/** The routing `none` option is always present; this is its criteria text. */
export const NONE_OPTION = "none";
export const NONE_DESCRIPTION = "No skill applies to this task";

// ------------------------------------------------------------------ request types

export interface JevChoiceQuestion {
	readonly type: "choice";
	readonly instructions: string;
	readonly criteria?: Record<string, string>;
}

export interface JevNoulQuestion {
	readonly type: "noul";
	readonly instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevToolStateEntry {
	readonly name: string;
	readonly description: string;
}

export interface JevRequestState {
	readonly task: string;
	readonly tools?: readonly JevToolStateEntry[];
}

export interface JevRequest {
	readonly model: string;
	readonly state: JevRequestState;
	readonly questions: Record<string, JevQuestion>;
}

export interface ToolCatalogueEntry {
	readonly name: string;
	readonly description: string;
}

export interface SkillCatalogueEntry {
	readonly name: string;
	readonly description?: string;
}

export type ToolRequestBuild =
	| { readonly status: "ok"; readonly request: JevRequest }
	| {
			readonly status: "hold";
			readonly reason: "catalogue-over-budget" | "too-many-options" | "empty-catalogue";
			readonly detail: string;
	  };

// ------------------------------------------------------------------ small pure helpers

/** UTF-8 byte length without imports (TextEncoder would need DOM/node types). */
function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1) ?? 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

/** Clamp a probability into [0, 1]; NaN and non-numbers become 0. Never throws. */
export function clampProbability(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

/** Timeout sanitizer: unset/garbage/non-positive → the frozen default. */
export function clampTimeoutMs(raw: string | undefined): number {
	if (raw === undefined) return REQUEST_TIMEOUT_MS;
	const parsed = Math.floor(Number(raw));
	if (!Number.isFinite(parsed) || parsed <= 0) return REQUEST_TIMEOUT_MS;
	return parsed;
}

/** Retry-After (seconds) → clamped ms; missing/garbage → the 60 s floor. */
export function clampRetryAfterMs(header: string | null): number {
	const seconds = header === null ? Number.NaN : Number.parseInt(header, 10);
	if (!Number.isFinite(seconds)) return RETRY_AFTER_FLOOR_MS;
	return Math.min(RETRY_AFTER_CEIL_MS, Math.max(RETRY_AFTER_FLOOR_MS, seconds * 1000));
}

/** Detail strings never leak keys, headers, bodies or prompt text (plan v2 F15 posture). */
const DETAIL_CAP_CHARS = 120;

function capDetail(detail: string): string {
	return detail.length <= DETAIL_CAP_CHARS ? detail : detail.slice(0, DETAIL_CAP_CHARS);
}

// ------------------------------------------------------------------ request builders

function capTask(task: string): string {
	return task.slice(0, PROMPT_CHAR_CAP);
}

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Tool-choice request. Catalogue rule (plan v2 F5): every name is included
 * sorted; descriptions truncate uniformly to fit the state budget; when even
 * empty descriptions overflow, the build holds as catalogue-over-budget —
 * tools are never silently dropped.
 */
export function buildToolChoiceRequest(input: {
	readonly task: string;
	readonly tools: readonly ToolCatalogueEntry[];
	readonly model?: string;
}): ToolRequestBuild {
	const model = input.model ?? JEV_MODEL_DEFAULT;
	const task = capTask(input.task);
	const sorted = [...input.tools].sort(byName);
	if (sorted.length === 0) {
		return { status: "hold", reason: "empty-catalogue", detail: "tool catalogue is empty" };
	}
	if (sorted.length > JEV_MAX_OPTIONS) {
		return {
			status: "hold",
			reason: "too-many-options",
			detail: `tool catalogue has ${sorted.length} options (max ${JEV_MAX_OPTIONS})`,
		};
	}
	let entries = sorted.map((tool) => ({
		name: tool.name,
		description: tool.description.slice(0, CRITERION_CHAR_CAP),
	}));
	let state: JevRequestState = { task, tools: entries };
	if (utf8Length(JSON.stringify(state)) > STATE_BYTE_BUDGET) {
		const fixed = utf8Length(
			JSON.stringify({ task, tools: sorted.map((tool) => ({ name: tool.name, description: "" })) }),
		);
		const perDescription = Math.floor((STATE_BYTE_BUDGET - fixed) / sorted.length);
		if (perDescription < 0) {
			return {
				status: "hold",
				reason: "catalogue-over-budget",
				detail: "tool names alone exceed the state budget",
			};
		}
		entries = sorted.map((tool) => ({ name: tool.name, description: tool.description.slice(0, perDescription) }));
		state = { task, tools: entries };
		if (utf8Length(JSON.stringify(state)) > STATE_BYTE_BUDGET) {
			return {
				status: "hold",
				reason: "catalogue-over-budget",
				detail: "tool catalogue exceeds the state budget after uniform truncation",
			};
		}
	}
	const criteria: Record<string, string> = {};
	for (const entry of entries) criteria[entry.name] = entry.description;
	return {
		status: "ok",
		request: { model, state, questions: { tools: { type: "choice", instructions: TOOL_INSTRUCTIONS, criteria } } },
	};
}

/** Tier-choice request over the fixed low/medium/high rubric and a task-only state. */
export function buildTierChoiceRequest(input: { readonly task: string; readonly model?: string }): JevRequest {
	return {
		model: input.model ?? JEV_MODEL_DEFAULT,
		state: { task: capTask(input.task) },
		questions: {
			tier: { type: "choice", instructions: TIER_INSTRUCTIONS, criteria: { ...TIER_CRITERIA } },
		},
	};
}

/**
 * Routing fan-out: one skill-choice question (options always include `none`)
 * plus the needs_subagent noul question, over a task-only state.
 */
export function buildRoutingRequest(input: {
	readonly task: string;
	readonly skills: readonly SkillCatalogueEntry[];
	readonly model?: string;
}): JevRequest {
	const entries = [...input.skills.map((skill) => ({ name: skill.name, description: skill.description ?? "" })), {
		name: NONE_OPTION,
		description: NONE_DESCRIPTION,
	}].sort(byName);
	const criteria: Record<string, string> = {};
	for (const entry of entries) criteria[entry.name] = entry.description.slice(0, CRITERION_CHAR_CAP);
	return {
		model: input.model ?? JEV_MODEL_DEFAULT,
		state: { task: capTask(input.task) },
		questions: {
			skill: { type: "choice", instructions: SKILL_INSTRUCTIONS, criteria },
			needs_subagent: { type: "noul", instructions: NEEDS_SUBAGENT_INSTRUCTIONS },
		},
	};
}

// ------------------------------------------------------------------ response parser

export interface JevChoiceAnswer {
	readonly type: "choice";
	readonly choice: string;
	readonly probabilities: Record<string, number>;
	readonly confidence: number;
}

export interface JevNoulAnswer {
	readonly type: "noul";
	readonly noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export type AnswerParse =
	| { readonly status: "ok"; readonly answer: JevAnswer }
	| {
			readonly status: "reject";
			readonly reason: "mis-keyed" | "type-mismatch" | "unknown-choice";
			readonly detail: string;
	  };

export interface JevQuestionSpec {
	readonly type: "choice" | "noul";
	/** Live catalogue for winner validation; absent means any non-empty winner parses. */
	readonly options?: readonly string[];
}

export interface JevAnswerSpec {
	readonly questions: Record<string, JevQuestionSpec>;
}

export interface JevUsage {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cost: number;
}

export type BodyParse =
	| {
			readonly status: "ok";
			readonly model: string;
			readonly id: string;
			readonly provider: string;
			readonly usage: JevUsage;
			readonly answers: Record<string, AnswerParse>;
	  }
	| { readonly status: "reject"; readonly reason: "malformed" | "error-envelope"; readonly detail: string };

function parseUsage(value: unknown): JevUsage {
	const record = (
		typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
	) as Record<string, unknown>;
	const num = (candidate: unknown): number =>
		typeof candidate === "number" && !Number.isNaN(candidate) ? candidate : 0;
	return { input_tokens: num(record["input_tokens"]), output_tokens: num(record["output_tokens"]), cost: num(record["cost"]) };
}

function parseAnswer(name: string, entry: unknown, question: JevQuestionSpec): AnswerParse {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return { status: "reject", reason: "mis-keyed", detail: `answer "${name}" is missing or not an object` };
	}
	const record = entry as Record<string, unknown>;
	if (record["type"] !== question.type) {
		return {
			status: "reject",
			reason: "type-mismatch",
			detail: `answer "${name}" is not a ${question.type} answer`,
		};
	}
	if (question.type === "noul") {
		const value = record["noul"];
		if (typeof value !== "number" || Number.isNaN(value)) {
			return { status: "reject", reason: "type-mismatch", detail: `answer "${name}" noul is not a number` };
		}
		return { status: "ok", answer: { type: "noul", noul: clampProbability(value) } };
	}
	const choice = record["choice"];
	if (typeof choice !== "string" || choice === "") {
		return { status: "reject", reason: "type-mismatch", detail: `answer "${name}" choice is not a string` };
	}
	if (question.options !== undefined && !question.options.includes(choice)) {
		return {
			status: "reject",
			reason: "unknown-choice",
			detail: `answer "${name}" winner is outside the live catalogue`,
		};
	}
	const probabilities = record["probabilities"];
	if (typeof probabilities !== "object" || probabilities === null || Array.isArray(probabilities)) {
		return { status: "ok", answer: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0 } };
	}
	const clean: Record<string, number> = {};
	for (const [option, value] of Object.entries(probabilities as Record<string, unknown>)) {
		clean[option] = clampProbability(value);
	}
	const confidence = record["confidence"];
	return {
		status: "ok",
		answer: {
			type: "choice",
			choice,
			probabilities: clean,
			confidence: typeof confidence === "number" ? clampProbability(confidence) : 0,
		},
	};
}

/**
 * Parse one decisions body against the questions we asked. Unknown extra fields
 * are ignored at body and answer level; per-question failures reject that
 * question only. Never throws.
 */
export function parseJevResponseBody(text: string, spec: JevAnswerSpec): BodyParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { status: "reject", reason: "malformed", detail: "response body is not valid JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { status: "reject", reason: "malformed", detail: "response body is not a JSON object" };
	}
	const body = raw as Record<string, unknown>;
	if (body["error"] !== undefined && body["answers"] === undefined) {
		return { status: "reject", reason: "error-envelope", detail: "response carries an error envelope, not answers" };
	}
	const answers = body["answers"];
	const answersObj =
		typeof answers === "object" && answers !== null && !Array.isArray(answers)
			? (answers as Record<string, unknown>)
			: {};
	const parsed: Record<string, AnswerParse> = {};
	for (const [name, question] of Object.entries(spec.questions)) {
		parsed[name] = parseAnswer(name, answersObj[name], question);
	}
	const str = (value: unknown): string => (typeof value === "string" ? value : "");
	return {
		status: "ok",
		model: str(body["model"]),
		id: str(body["id"]),
		provider: str(body["provider"]),
		usage: parseUsage(body["usage"]),
		answers: parsed,
	};
}

// ------------------------------------------------------------------ classifier seam

/** Frozen error vocabulary (plan v2 R11). */
export type JevErrorKind =
	| "misrouted-refusal"
	| "auth"
	| "billing"
	| "rate-limited"
	| "server"
	| "transport-timeout"
	| "malformed"
	| "missing-key";

export interface JevFetchInit {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly signal: AbortSignal;
}

export interface JevFetchHeaders {
	get(name: string): string | null;
}

export interface JevFetchResponse {
	readonly status: number;
	readonly headers: JevFetchHeaders;
	text(): Promise<string>;
}

export type JevFetchFn = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>;

/** Timer seam (update-check precedent): the only clock the classifier may arm. */
export interface JevScheduler {
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface JevClassifierDeps {
	readonly fetchFn: JevFetchFn;
	readonly scheduler: JevScheduler;
	/** Reserved for P2 cooldown/cache timestamps; unused by the P1 seam. */
	readonly now: () => number;
	/** Env record, read per call — never copied, never the ambient env. */
	readonly env: Record<string, string | undefined>;
}

export type ClassifyOutcome =
	| { readonly status: "decided"; readonly response: Extract<BodyParse, { status: "ok" }> }
	| {
			readonly status: "error";
			readonly kind: JevErrorKind;
			readonly retryAfterMs?: number;
			readonly detail: string;
	  };

export interface JevClassifier {
	classify(request: JevRequest): Promise<ClassifyOutcome>;
}

function specFromRequest(request: JevRequest): JevAnswerSpec {
	const questions: Record<string, JevQuestionSpec> = {};
	for (const [name, question] of Object.entries(request.questions)) {
		if (question.type === "noul") {
			questions[name] = { type: "noul" };
		} else {
			questions[name] = {
				type: "choice",
				options: question.criteria === undefined ? undefined : Object.keys(question.criteria),
			};
		}
	}
	return { questions };
}

async function readDecision(response: JevFetchResponse, request: JevRequest): Promise<ClassifyOutcome> {
	const status = response.status;
	if (status === 400) {
		return {
			status: "error",
			kind: "misrouted-refusal",
			detail: "decisions endpoint refused the request (HTTP 400); check model and endpoint",
		};
	}
	if (status === 401) {
		return { status: "error", kind: "auth", detail: "decisions endpoint rejected the credentials (HTTP 401)" };
	}
	if (status === 402) {
		return { status: "error", kind: "billing", detail: "decisions endpoint reported a billing stop (HTTP 402)" };
	}
	if (status === 429) {
		let header: string | null = null;
		try {
			header = response.headers.get("retry-after");
		} catch {
			header = null;
		}
		return {
			status: "error",
			kind: "rate-limited",
			retryAfterMs: clampRetryAfterMs(header),
			detail: "decisions endpoint rate-limited the request (HTTP 429)",
		};
	}
	if (status !== 200) {
		return { status: "error", kind: "server", detail: `decisions endpoint failed (HTTP ${status})` };
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return { status: "error", kind: "malformed", detail: "decision body could not be read" };
	}
	const parsed = parseJevResponseBody(text, specFromRequest(request));
	if (parsed.status === "reject") {
		if (parsed.reason === "error-envelope") {
			return { status: "error", kind: "server", detail: "decisions endpoint returned an error envelope" };
		}
		return { status: "error", kind: "malformed", detail: capDetail(parsed.detail) };
	}
	return { status: "decided", response: parsed };
}

/**
 * Jev classifier seam. Timeout is enforced through the injected scheduler plus
 * an abort signal — a never-resolving fetch settles to `transport-timeout` when
 * the injected deadline fires, with no real sleep and no ambient timers.
 */
export function createJevClassifier(deps: JevClassifierDeps): JevClassifier {
	return {
		async classify(request: JevRequest): Promise<ClassifyOutcome> {
			void deps.now;
			const key = deps.env[JEV_API_KEY_ENV];
			if (key === undefined || key.trim() === "") {
				return { status: "error", kind: "missing-key", detail: "OPENROUTER_API_KEY is missing or empty" };
			}
			const endpoint = deps.env[JEV_ENDPOINT_ENV] ?? JEV_ENDPOINT_DEFAULT;
			const timeoutMs = clampTimeoutMs(deps.env[JEV_TIMEOUT_ENV]);
			const controller = new AbortController();
			const body = JSON.stringify({ model: request.model, state: request.state, questions: request.questions });
			let timer: unknown;
			try {
				const winner = await Promise.race([
					deps.fetchFn(endpoint, {
						method: "POST",
						headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
						body,
						signal: controller.signal,
					}),
					new Promise<undefined>((resolve) => {
						timer = deps.scheduler.setTimeout(() => {
							controller.abort();
							resolve(undefined);
						}, timeoutMs);
					}),
				]);
				if (winner === undefined) {
					return {
						status: "error",
						kind: "transport-timeout",
						detail: `decision request timed out after ${timeoutMs} ms`,
					};
				}
				return await readDecision(winner, request);
			} catch {
				return { status: "error", kind: "transport-timeout", detail: "decision request failed in transport" };
			} finally {
				if (timer !== undefined) deps.scheduler.clearTimeout(timer);
			}
		},
	};
}

// ------------------------------------------------------------------ fallback classifier

export type FallbackDecision = {
	readonly tools:
		| { readonly status: "ok"; readonly names: string[] }
		| { readonly status: "hold"; readonly reason: "no-keyword-match" | "empty-task" };
	readonly tier: { readonly status: "hold"; readonly reason: "fallback-tier-hold" };
	readonly route: { readonly choice: "none"; readonly confidence: 0 };
};

export interface FallbackClassifier {
	classify(task: string, toolNames: readonly string[]): FallbackDecision;
}

function wordParts(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((part) => part.length >= 3);
}

/**
 * Deterministic non-Jev fallback: bounded keyword tool match, tier always
 * holds, route is always none. Word-part matching (never substrings) keeps
 * `already` from matching `read`. Tier hold is deliberate — the measured tier
 * answer contradicted its own rubric (RES F7), so only Jev-plus-policy may move it.
 */
export function createFallbackClassifier(): FallbackClassifier {
	return {
		classify(task: string, toolNames: readonly string[]): FallbackDecision {
			const tier = { status: "hold", reason: "fallback-tier-hold" } as const;
			const route = { choice: "none", confidence: 0 } as const;
			const tokens = new Set(wordParts(task));
			if (tokens.size === 0) {
				return { tools: { status: "hold", reason: "empty-task" }, tier, route };
			}
			const names = [...toolNames]
				.sort()
				.filter((name) => wordParts(name).some((part) => tokens.has(part)))
				.slice(0, FALLBACK_MAX_TOOLS);
			if (names.length === 0) {
				return { tools: { status: "hold", reason: "no-keyword-match" }, tier, route };
			}
			return { tools: { status: "ok", names }, tier, route };
		},
	};
}
