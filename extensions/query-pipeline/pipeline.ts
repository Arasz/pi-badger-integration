/**
 * query-pipeline runner (PKG-4): the import seam mem-based-rag consumes.
 *
 * `runPipeline` orchestrates planning -> per-query search -> Jev scoring ->
 * document-aware merge under one wall-clock budget, with a single-query
 * fallback on any stage failure. `retrieveResult` never rejects; `retrieve`
 * resolves the bank's `memory_search` envelope string so the existing
 * mem-based-rag parse/prune/slice/format path is untouched.
 *
 * Purity: every dependency is injected (`deps.env/now/scheduler/fetchFn`
 * defaults are the only ambient bindings, declared once below). No imports
 * beyond the sibling query-pipeline modules.
 */
import {
	QP_STATUS_KEY,
	QUERY_PIPELINE_PLANNER_MS_ENV,
	QUERY_PIPELINE_SCORE_MS_ENV,
	QUERY_PIPELINE_SEARCH_LIMIT_ENV,
	QUERY_PIPELINE_SEARCH_MS_ENV,
	QUERY_PIPELINE_TOTAL_MS_ENV,
	numEnv,
	type PipelineCandidate,
	type PipelineProgress,
	type PipelineResult,
	type PipelineScheduler,
	type QueryPipeline,
	type QueryPipelineDeps,
	type PlannerResult,
} from "./types.ts";
import { MERGE_SLOTS, dedupePool, mergeSelect } from "./merge.ts";
import { createRegistryPlanner } from "./planner-call.ts";
import {
	SCORE_BATCH_MAX,
	SCORE_POOL_MAX,
	createJevScorer,
	type JevScoreFetchFn,
	type JevScoreFetchInit,
	type JevScoreFetchResponse,
} from "./jev-client.ts";

export { QP_STATUS_KEY };

// ------------------------------------------------------------------ ambient defaults (the only ones)

/** The one ambient fetch binding; tests always inject `score`/`fetchFn`. */
export const defaultJevFetch: JevScoreFetchFn = (url: string, init: JevScoreFetchInit) =>
	fetch(url, init as RequestInit) as Promise<JevScoreFetchResponse>;

const REAL_SCHEDULER: PipelineScheduler = {
	setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

// ------------------------------------------------------------------ budget

export interface PipelineBudget {
	totalMs: number;
	plannerMs: number;
	searchMs: number;
	scoreMs: number;
	searchLimit: number;
}

/** Read per call; the kill switch is enforced at the call site, not here. */
export function resolvePipelineBudget(env: Record<string, string | undefined>): PipelineBudget {
	return {
		totalMs: numEnv(env, QUERY_PIPELINE_TOTAL_MS_ENV, { fallback: 90_000, min: 5_000, max: 300_000 }),
		plannerMs: numEnv(env, QUERY_PIPELINE_PLANNER_MS_ENV, { fallback: 15_000, min: 1_000, max: 60_000 }),
		searchMs: numEnv(env, QUERY_PIPELINE_SEARCH_MS_ENV, { fallback: 15_000, min: 500, max: 60_000 }),
		scoreMs: numEnv(env, QUERY_PIPELINE_SCORE_MS_ENV, { fallback: 8_000, min: 1_000, max: 60_000 }),
		searchLimit: numEnv(env, QUERY_PIPELINE_SEARCH_LIMIT_ENV, { fallback: 5, min: 1, max: 20 }),
	};
}

// ------------------------------------------------------------------ progress

/** Collapse whitespace, trim, cap with an ellipsis (pinned by test). */
function oneLine(text: string, cap: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= cap ? collapsed : `${collapsed.slice(0, cap - 1)}…`;
}

export function formatProgress(progress: PipelineProgress): string {
	switch (progress.stage) {
		case "planning":
			return "query-pipeline: planning queries…";
		case "searching":
			return `query-pipeline: searching ${progress.index ?? 1}/${progress.total ?? 1} — "${oneLine(progress.query ?? "", 48)}"`;
		case "scoring":
			return `query-pipeline: scoring ${progress.candidates ?? 0} candidates (${progress.batches ?? 0} batches)…`;
		case "merging":
			return `query-pipeline: merging ${progress.pool ?? 0} candidates…`;
		case "fallback":
			return `query-pipeline: fallback${progress.detail ? ` — ${oneLine(progress.detail, 48)}` : ""}…`;
		case "done":
			return "query-pipeline: done";
	}
}

// ------------------------------------------------------------------ helpers

export function toEnvelope(result: PipelineResult): string {
	return JSON.stringify({ data: { results: result.mem, code: result.code } });
}

function linkAbort(parent: AbortSignal, child: AbortController): void {
	if (parent.aborted) {
		child.abort();
		return;
	}
	try {
		parent.addEventListener("abort", () => child.abort(), { once: true });
	} catch {
		// a signal without addEventListener support still runs; the child stays unlinked
	}
}

function dedupeQueries(
	entries: Array<{ q: string; concept: string }>,
	inputQuery: string,
): Array<{ q: string; concept: string }> {
	const seen = new Set<string>([inputQuery.trim()]);
	const out: Array<{ q: string; concept: string }> = [];
	for (const entry of entries) {
		const q = entry.q.trim();
		if (q === "" || seen.has(q)) continue;
		seen.add(q);
		out.push({ q, concept: entry.concept });
	}
	return out;
}

function serverRank(hit: PipelineCandidate): number {
	// Plan §2: finite number → itself; numeric string → parsed; anything else → +Infinity.
	const raw = hit.ranking;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Number.POSITIVE_INFINITY;
}

function annotate(
	hits: PipelineCandidate[] | undefined,
	kind: "memory" | "code",
	query: string,
	concept: string,
): PipelineCandidate[] {
	return (hits ?? []).map((hit) => ({ ...hit, kind, query, concept }));
}

// ------------------------------------------------------------------ the runner

interface RaceOutcome<T> {
	timedOut: boolean;
	value?: T;
	error?: string;
}

export async function runPipeline(deps: QueryPipelineDeps, input: { query: string }): Promise<PipelineResult> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const scheduler = deps.scheduler ?? REAL_SCHEDULER;
	const budget = resolvePipelineBudget(env);
	const t0 = now();
	const deadline = t0 + budget.totalMs;
	const remaining = (): number => deadline - now();

	const shared = new AbortController();
	const external = deps.signal;
	if (external) {
		if (external.aborted) shared.abort();
		else linkAbort(external, shared);
	}

	const counters = { plannerMs: 0, searchMs: 0, scoreMs: 0 };
	const emit = (progress: PipelineProgress): void => {
		if (shared.signal.aborted) return;
		try {
			deps.onProgress?.(progress);
		} catch {
			// progress must never fail the run
		}
	};
	const finish = (
		partial: Partial<PipelineResult> & { status: PipelineResult["status"]; reason: string },
	): PipelineResult => ({
		status: partial.status,
		reason: partial.reason,
		...(partial.error !== undefined ? { error: partial.error } : {}),
		mem: partial.mem ?? [],
		code: partial.code ?? [],
		queries: partial.queries ?? [],
		candidates: partial.candidates ?? 0,
		scored: partial.scored ?? 0,
		plannerMs: counters.plannerMs,
		searchMs: counters.searchMs,
		scoreMs: counters.scoreMs,
		latencyMs: now() - t0,
	});

	const planner = deps.plan ?? createRegistryPlanner({ registry: deps.registry, model: deps.model, env });
	const scorer = deps.score ?? createJevScorer({ fetchFn: defaultJevFetch, scheduler, now, env });

	/** Convert a synchronous throw from an injected seam into a rejection the race can absorb. */
	const callSafe = <T>(fn: () => Promise<T>): Promise<T> => {
		try {
			return Promise.resolve(fn());
		} catch (error) {
			return Promise.reject(error);
		}
	};

	/** Race a promise against a scheduler timer; never rejects. */
	const race = <T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<RaceOutcome<T>> => {
		if (ms <= 0) {
			try {
				onTimeout?.();
			} catch {
				// best-effort abort
			}
			return Promise.resolve({ timedOut: true });
		}
		return new Promise<RaceOutcome<T>>((resolve) => {
			let settled = false;
			const handle = scheduler.setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					onTimeout?.();
				} catch {
					// best-effort abort
				}
				resolve({ timedOut: true });
			}, ms);
			promise.then(
				(value) => {
					if (settled) return;
					settled = true;
					scheduler.clearTimeout(handle);
					resolve({ timedOut: false, value });
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					scheduler.clearTimeout(handle);
					resolve({ timedOut: false, error: error instanceof Error ? error.message : String(error) });
				},
			);
		});
	};

	const parseSearchEnvelope = (text: string): { mem: PipelineCandidate[]; code: PipelineCandidate[] } | null => {
		try {
			const parsed = JSON.parse(text) as { data?: { results?: PipelineCandidate[]; code?: PipelineCandidate[] } };
			return { mem: parsed.data?.results ?? [], code: parsed.data?.code ?? [] };
		} catch {
			return null;
		}
	};

	/** Today's enrichment: one search on the caller query, prune, per-kind slice. */
	const fallback = async (reason: string, lastError?: string): Promise<PipelineResult> => {
		emit({ stage: "fallback", detail: reason });
		const left = remaining();
		if (left < 1_000) return finish({ status: "fallback", reason, mem: [], code: [], ...(lastError !== undefined ? { error: lastError } : {}) });
		const ms = Math.min(budget.searchMs, Math.max(0, left - budget.scoreMs));
		emit({ stage: "searching", index: 1, total: 1, query: input.query, concept: "fallback" });
		const outcome = await race(callSafe(() => deps.search(input.query, budget.searchLimit, ms)), ms);
		if (outcome.timedOut || outcome.error !== undefined || outcome.value === undefined) {
			return finish({
				status: "fallback",
				reason: "search-error",
				error: outcome.error ?? lastError ?? "search timed out",
				mem: [],
				code: [],
			});
		}
		const parsed = parseSearchEnvelope(outcome.value);
		if (parsed === null) {
			return finish({ status: "fallback", reason: "search-error", error: "malformed search envelope", mem: [], code: [] });
		}
		const deduped = dedupePool(annotate(parsed.mem, "memory", input.query, "fallback"), annotate(parsed.code, "code", input.query, "fallback"));
		return finish({
			status: "fallback",
			reason,
			mem: deduped.mem.slice(0, MERGE_SLOTS),
			code: deduped.code.slice(0, MERGE_SLOTS),
			candidates: deduped.mem.length + deduped.code.length,
		});
	};

	const runStages = async (): Promise<PipelineResult> => {
		emit({ stage: "planning" });
		const p0 = now();
		// The planner may never eat the search window.
		const plannerCap = Math.min(budget.plannerMs, Math.max(0, budget.totalMs - budget.searchMs - budget.scoreMs));
		const plannerCtl = new AbortController();
		linkAbort(shared.signal, plannerCtl);
		const planOutcome = await race(callSafe(() => planner(input.query, plannerCtl.signal, plannerCap)), plannerCap, () => plannerCtl.abort());
		counters.plannerMs = now() - p0;
		const plan: PlannerResult = planOutcome.timedOut
			? { status: "fallback", reason: "timeout" }
			: planOutcome.error !== undefined
				? { status: "fallback", reason: "transport" }
				: (planOutcome.value ?? { status: "fallback", reason: "transport" });
		if (plan.status !== "ok") return await fallback(plan.reason);

		const queries = dedupeQueries(
			plan.plan.concepts.flatMap((concept) => concept.queries.map((q) => ({ q, concept: concept.name }))),
			input.query,
		);
		if (queries.length === 0) return await fallback("invalid-shape");

		const s0 = now();
		const memHits: PipelineCandidate[] = [];
		const codeHits: PipelineCandidate[] = [];
		let lastError: string | undefined;
		for (let i = 0; i < queries.length; i++) {
			if (shared.signal.aborted) break;
			if (remaining() <= budget.scoreMs + 500) break;
			const ms = Math.min(budget.searchMs, Math.max(0, remaining() - budget.scoreMs));
			if (ms <= 0) break;
			emit({ stage: "searching", index: i + 1, total: queries.length, query: queries[i]!.q, concept: queries[i]!.concept });
			const outcome = await race(callSafe(() => deps.search(queries[i]!.q, budget.searchLimit, ms)), ms);
			if (outcome.timedOut || outcome.error !== undefined || outcome.value === undefined) {
				lastError = outcome.error ?? `search timed out after ${ms}ms`;
				continue;
			}
			const parsed = parseSearchEnvelope(outcome.value);
			if (parsed === null) {
				lastError = "malformed search envelope";
				continue;
			}
			memHits.push(...annotate(parsed.mem, "memory", queries[i]!.q, queries[i]!.concept));
			codeHits.push(...annotate(parsed.code, "code", queries[i]!.q, queries[i]!.concept));
		}
		counters.searchMs = now() - s0;

		const deduped = dedupePool(memHits, codeHits);
		const poolAll = [...deduped.mem, ...deduped.code];
		if (poolAll.length === 0) return await fallback("no-candidates", lastError);

		const pool = poolAll
			.map((hit, index) => ({ hit, index }))
			.sort((a, b) => serverRank(a.hit) - serverRank(b.hit) || a.index - b.index)
			.map((entry) => entry.hit)
			.slice(0, SCORE_POOL_MAX);

		emit({ stage: "scoring", candidates: pool.length, batches: Math.ceil(pool.length / SCORE_BATCH_MAX) });
		const c0 = now();
		const scoreCtl = new AbortController();
		linkAbort(shared.signal, scoreCtl);
		const scoreDeadline = Math.min(deadline, now() + budget.scoreMs);
		const scoreOutcome = await race(
			callSafe(() => scorer(input.query, pool, scoreCtl.signal, scoreDeadline)),
			Math.max(0, scoreDeadline - now()),
			() => scoreCtl.abort(),
		);
		counters.scoreMs = now() - c0;
		const scoreByHash = new Map<string, number | null>();
		for (const entry of scoreOutcome.value?.results ?? []) scoreByHash.set(entry.hash, entry.score);
		const scoredPool = pool.map((hit) => ({
			...hit,
			score: scoreByHash.has(hit.hash) ? (scoreByHash.get(hit.hash) ?? null) : null,
		}));

		emit({ stage: "merging", pool: scoredPool.length });
		const selected = mergeSelect(scoredPool, MERGE_SLOTS);
		return finish({
			status: "pipeline",
			reason: "ok",
			mem: selected.mem,
			code: selected.code,
			queries: queries.map((entry) => entry.q),
			candidates: pool.length,
			scored: scoredPool.filter((hit) => hit.score !== null).length,
		});
	};

	if (shared.signal.aborted) {
		return finish({ status: "fallback", reason: "aborted", mem: [], code: [] });
	}
	// The budget timer arms before runStages starts, so the run's deadline is the
	// first timer the injected scheduler sees (test-observable ordering).
	const runOutcome = await race(Promise.resolve().then(() => runStages()), budget.totalMs, () => shared.abort());
	if (runOutcome.timedOut) {
		return finish({ status: "fallback", reason: "budget-exhausted", mem: [], code: [] });
	}
	return runOutcome.value ?? finish({ status: "fallback", reason: "budget-exhausted", mem: [], code: [] });
}

export function createQueryPipeline(deps: QueryPipelineDeps): QueryPipeline {
	return {
		retrieveResult: (input) => runPipeline(deps, input),
		retrieve: async (input) => toEnvelope(await runPipeline(deps, input)),
	};
}
