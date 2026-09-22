/**
 * FROZEN shared seam for the query-pipeline extension (plan §1.1): the stage
 * vocabulary, the candidate/plan/result shapes, the injectable deps, the
 * progress-formatter signature, the env-name constants and the clamp helper.
 *
 * Purity rules (house convention, decision-router-client.ts precedent): zero
 * imports; no wall-clock reads, no network and no ambient env — every
 * dependency arrives injected. Nothing in this file throws.
 */

// ------------------------------------------------------------------ pipeline seam (plan §1.1)

export type PipelineStage = "planning" | "searching" | "scoring" | "merging" | "fallback" | "done";

export interface PipelineProgress {
	stage: PipelineStage;
	detail?: string;
	index?: number; total?: number; query?: string; concept?: string;
	candidates?: number; batches?: number; pool?: number;
}

/** One memory_search over the existing transport; resolves the bank's JSON envelope string. */
export type PipelineSearchFn = (query: string, limit: number, timeoutMs: number) => Promise<string>;

export interface PipelineCandidate {           // structural twin of rag-core MemoryHit
	hash: string; path?: string; sourceFile?: string; snippet?: string;
	ranking?: number | string; lineStart?: number; lineEnd?: number;
	kind?: "memory" | "code"; score?: number | null;
	query?: string; concept?: string;
}

export interface PipelinePlan  { concepts: Array<{ name: string; queries: string[] }>; }
export type PlannerResult =
  | { status: "ok"; plan: PipelinePlan }
  | { status: "fallback"; reason: PlannerFallbackReason };
export type PlannerFallbackReason =
  | "no-model" | "timeout" | "transport" | "empty-text" | "no-json-object" | "invalid-shape";

export type PipelinePlannerFn = (query: string, signal: AbortSignal, timeoutMs: number) => Promise<PlannerResult>;
export interface PipelineScore { hash: string; score: number | null; confidence?: number; }

/** Jev wire usage summed across batches (copy-by-contract of decision-router's JevUsage). */
export interface ScoreUsage {
	input_tokens: number;
	output_tokens: number;
	cost: number;
}

export type PipelineScorerFn = (
  prompt: string, candidates: PipelineCandidate[], signal: AbortSignal, deadlineMs: number,
) => Promise<{ results: PipelineScore[]; usage: ScoreUsage; batches: number }>;

export interface PipelineResult {
  status: "pipeline" | "fallback";
  reason: string;                 // "ok" | planner fallback reason | "no-candidates" | "budget-exhausted" | "search-error"
  error?: string;                 // underlying failure text (search-error): mem-based-rag rethrows it to keep "bank error" diagnostics
  mem: PipelineCandidate[]; code: PipelineCandidate[];
  queries: string[]; candidates: number; scored: number;
  plannerMs: number; searchMs: number; scoreMs: number; latencyMs: number;
}

export interface PipelineScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The pinned progress strings; implemented by pipeline.ts (PKG-4) and declared
 * here so the frozen seam carries the signature. mem-based-rag must not
 * re-implement the strings.
 */
export declare function formatProgress(p: PipelineProgress): string;

export interface QueryPipelineDeps {
  search: PipelineSearchFn;                   // required; mem-based-rag binds projectId/sessionId + searchCall
  registry?: unknown;                         // ctx.modelRegistry (structural view; never narrowed here)
  model?: unknown;                            // ctx.model — planner fallback model
  env?: Record<string, string | undefined>;   // default process.env
  now?: () => number;                         // default Date.now
  scheduler?: PipelineScheduler;              // default real setTimeout/clearTimeout
  signal?: AbortSignal;                       // optional external abort
  onProgress?: (p: PipelineProgress) => void;
  plan?: PipelinePlannerFn;                   // test override; default = createRegistryPlanner(...)
  score?: PipelineScorerFn;                   // test override; default = createJevScorer({env, scheduler, now})
}
export interface QueryPipeline {
  retrieve(input: { query: string }): Promise<string>;              // = toEnvelope(await retrieveResult(input))
  retrieveResult(input: { query: string }): Promise<PipelineResult>; // typed surface: lastPipeline/reason live here
}

// ------------------------------------------------------------------ progress keys (plan §5)

/** ctx.ui.setStatus key; mem-based-rag clears with the same key. */
export const QP_STATUS_KEY = "query-pipeline";
/** ctx.ui.setWidget key (optional surface); mem-based-rag clears with the same key. */
export const QP_WIDGET_KEY = "query-pipeline";

// ------------------------------------------------------------------ env names (read per call, plan §5)

/** Kill switch: only the literal "0" disables the pipeline at the call site and preload. */
export const QUERY_PIPELINE_ENV = "PI_BADGER_QUERY_PIPELINE";
export const QUERY_PIPELINE_TOTAL_MS_ENV = "PI_BADGER_QUERY_PIPELINE_TOTAL_MS";
export const QUERY_PIPELINE_PLANNER_MS_ENV = "PI_BADGER_QUERY_PIPELINE_PLANNER_MS";
export const QUERY_PIPELINE_SEARCH_MS_ENV = "PI_BADGER_QUERY_PIPELINE_SEARCH_MS";
export const QUERY_PIPELINE_SCORE_MS_ENV = "PI_BADGER_QUERY_PIPELINE_SCORE_MS";
export const QUERY_PIPELINE_SEARCH_LIMIT_ENV = "PI_BADGER_QUERY_PIPELINE_SEARCH_LIMIT";
export const QUERY_PIPELINE_PLANNER_MODEL_ENV = "PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL";
/** Per scoring attempt (≤ the stage cap); shared name with the decision-router contract. */
export const JEV_SCORE_TIMEOUT_ENV = "PI_BADGER_JEV_SCORE_TIMEOUT_MS";
/** Jev transport names, shared with decision-router by contract. */
export const JEV_ENDPOINT_ENV = "PI_BADGER_JEV_ENDPOINT";
export const JEV_MODEL_ENV = "PI_BADGER_JEV_MODEL";
export const JEV_API_KEY_ENV = "OPENROUTER_API_KEY";

// ------------------------------------------------------------------ clamp helper (plan §5)

export interface NumEnvSpec {
	/** Value returned when the variable is unset or non-finite. */
	readonly fallback: number;
	readonly min: number;
	readonly max: number;
}

/**
 * Read a numeric env var per call and clamp it: floor, ceiling, non-finite →
 * default. A blank string parses to 0 and therefore clamps to the floor, which
 * is the literal reading of the plan §5 clamp rule.
 */
export function numEnv(env: Record<string, string | undefined>, name: string, spec: NumEnvSpec): number {
	const raw = env[name];
	if (raw === undefined) return spec.fallback;
	const parsed = Math.floor(Number(raw));
	if (!Number.isFinite(parsed)) return spec.fallback;
	return Math.min(spec.max, Math.max(spec.min, parsed));
}
