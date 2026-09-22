# Plan: query-pipeline v1 — delegate-planned multi-query RAG

**Task:** `pbi-multi-query-rag-pipeline-v1` · **Effort:** high · **Date:** 2026-09-22
**Research record:** `docs/work/2026-09-22-query-pipeline-v1-research.md` (A1–A8, B1–B4, C1–C5, D1–D8)
**Predecessor:** `docs/work/2026-09-21-delegated-multi-query-rag-with-jev-selection.md` (F1–F14)

Plan authors: architect (P1), api-engineer (P2), test-engineer (P3) — three independent sections consolidated here. Where the sections disagreed, the resolution is recorded inline as **R#**.

## 0. Goal, scope, owner requirements

Ship a first version of the multi-query retrieval pipeline the research measured: for an enrichable (skill) prompt, plan concept-grouped queries with the **delegator persona** via a **direct model call**, search the bank once per query, score candidates with **Jev**, merge with a **5-slot document-aware budget**, and inject the result through the existing mem-based-rag block — with a **TUI progress indicator** while it runs, a **Jev preload** at session start, and an **adjusted timeout** so the pipeline is not killed mid-flight.

**In scope (v1):** `extensions/query-pipeline/` (new), mem-based-rag auto-enrichment routed through it, publish registration, TUI progress, Jev preload, budget/fallback, tests.
**Out of scope (v1):** parallel searches (v1 sequential), `/ask` routing (**R1**: auto-enrichment only; `/ask` keeps today's single search — recorded as deferred), HTTP planner fallback (**R2**: registry only; any planner failure falls back to a single query), shared-module refactor of decision-router, stale `QueryLengthGuard` fix (handed to ai-raccoon over the bus, acknowledged).

## 1. Architecture

```
extensions/query-pipeline/
  index.ts          pi wiring only: session_start Jev preload (gated, in-flight-guarded, fail-open),
                    session_shutdown cleanup + status/widget clear; injectable deps; no hook of its own.
  types.ts          FROZEN shared types + env-name constants + clamp helpers; imports nothing.
  planner.ts        Pure planner half: DELEGATOR_PERSONA const, PLANNER_ADDENDUM, buildPlannerUserPrompt,
                    parsePlan (last-complete-JSON-object, shape-validated). No imports.
  planner-call.ts   Pi adapter: createRegistryPlanner — structural modelRegistry.streamSimple seam,
                    sync-auth-throw safe, AbortSignal-aware, always resolves a typed result, never throws.
  jev-client.ts     Minimal Jev `score` client (copy-by-contract from decision-router-client.ts):
                    same env names + error vocabulary, injected fetch/scheduler/env, batches ≤12, ≤3 attempts,
                    warm() preload call.
  merge.ts          Pure rank+merge rule (mergeSelect) + dedupePool + docKey. No imports.
  pipeline.ts       THE import seam: createQueryPipeline(deps) -> {retrieve({raw})} plus runPipeline
                    (typed result) and toEnvelope. Stage orchestration, budget/abort, progress, fallbacks.
  README.md         Contract summary + install-alone caveat (decision-router README precedent).
  package.json      Sibling-shaped manifest; deps: @earendil-works/pi-coding-agent, @earendil-works/pi-ai.
  bun.lock          Committed (publish ships it; CI installs --frozen-lockfile per extension).
```

Sibling relative imports survive publish (precedent: `monitor → subagent + message-bus`, `decision-router → router-fallback`); mem-based-rag will import `../query-pipeline/pipeline.ts`. Installing mem-based-rag alone therefore requires query-pipeline — documented, same as existing precedent.

### 1.1 Frozen seam consumed by mem-based-rag

```ts
// pipeline.ts
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

export type PipelinePlannerFn = (raw: string, signal: AbortSignal, timeoutMs: number) => Promise<PlannerResult>;
export interface PipelineScore { hash: string; score: number | null; confidence?: number; }
export type PipelineScorerFn = (
  prompt: string, candidates: PipelineCandidate[], signal: AbortSignal, deadlineMs: number,
) => Promise<{ results: PipelineScore[]; usage: ScoreUsage; batches: number }>;

export interface PipelineResult {
  status: "pipeline" | "fallback";
  reason: string;                 // "ok" | planner fallback reason | "no-candidates" | "budget-exhausted" | "search-error"
  mem: PipelineCandidate[]; code: PipelineCandidate[];
  queries: string[]; candidates: number; scored: number;
  plannerMs: number; searchMs: number; scoreMs: number; latencyMs: number;
}

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
export interface QueryPipeline { retrieve(input: { raw: string }): Promise<string>; }
export function createQueryPipeline(deps: QueryPipelineDeps): QueryPipeline;
export function runPipeline(deps: QueryPipelineDeps, input: { raw: string }): Promise<PipelineResult>;
export function toEnvelope(result: PipelineResult): string;   // {"data":{"results":mem,"code":code}}
```

`retrieve` resolves the exact `memory_search` envelope string (`{"data":{"results":[...],"code":[...]}}`) so mem-based-rag's `JSON.parse → pruneHits → slice` path is untouched. It **never rejects**: every failure degrades to a fallback/partial/empty envelope. `projectId`/`sessionId` are bound in the `search` closure; the pipeline never sees them.

**R3 (slots):** the owner's "5 results" is **5 slots total across mem+code**, not 5 per section. `mergeSelect` counts across kinds and splits by kind only for rendering; env `PI_BADGER_QUERY_PIPELINE_SLOTS` (default 5) makes it adjustable.

## 2. Merge algorithm (`merge.ts`, pure)

**Identity.** chunk = trimmed `hash`. Document `docKey(hit)` = `path:` + trimmed `hit.path ?? hit.sourceFile` when non-empty and not `"?"`, else `hash:` + hash. Score = finite number in [0,3] or null. Server rank = numeric `ranking` or +Infinity.

**Comparator (total order):** numeric scores before null; score desc; server rank asc; stable (insertion order = planner concept order → query order → per-search result order, mem before code).
Null semantics (research F11): `null` is *missing evidence* (call failed / no score / budget), `0` is Jev's verdict "unrelated"; nulls sort last but remain eligible for backfill and for filling slots when the scored pool is too small.

```
mergeSelect(candidates, slots = 5):
  if candidates.length == 0: return { mem: [], code: [] }
  ranked = stableSort(copy(candidates), compare)
  chosen = []; chosenHashes = {}; seenDocs = {}
  for c in ranked:                                  # pass 1: best chunk per distinct document
    if chosen.length == slots: break
    d = docKey(c); if d in seenDocs: continue
    seenDocs.add(d); chosen.push(c); chosenHashes.add(c.hash)
  if chosen.length < slots:                         # pass 2: backfill ONLY from included docs
    for c in ranked:
      if chosen.length == slots: break
      if c.hash in chosenHashes: continue
      if docKey(c) not in seenDocs: continue
      chosen.push(c); chosenHashes.add(c.hash)
  return { mem: chosen.filter(kind=="memory"), code: chosen.filter(kind=="code") }
```

`dedupePool` before scoring: first occurrence wins, deduping on non-empty `hash` OR identical non-empty `snippet` — same rule as `pruneHits` (`rag-core.ts:191-221`), parity-pinned in a cross-package test. `dedupeQueries` drops exact trimmed duplicate queries preserving first occurrence.

## 3. Planner (`planner.ts` + `planner-call.ts`)

**System prompt** = body of `.ai-badger/agents/delegator.md` from the `# Delegator` heading through the end, excluding YAML frontmatter and the managed-by HTML comment, embedded as a frozen const (copy-by-contract; a repo test pins the const equal to the file body so a persona refresh turns it red), followed by:

```
## Retrieval-query planning (this call's only role)

The delegation procedures above are context, not instructions for this call: you
have no tools, you must not read files or search memory, and you must not
dispatch anything. Your entire output is one JSON object of the shape
{"concepts":[{"name":"<short concept name>","queries":["<query>","<query>"]}]}.
Group retrieval queries by core concept; emit 2 to 6 queries total, each at most
300 characters; each query must stand alone (name the actual thing, not "this"
or "the issue"). Query the mechanism/decision content you expect in a software
project's docs and code, not the user's complaints. Output ONLY the JSON object
— no prose, no code fences. If you emit any fragment before the final object,
the final object must still be complete and valid.
```

**User prompt** — the measured harness prompt verbatim (research F4, 4/4 parseable), with the raw pre-expansion prompt inserted between `<<<` and `>>>` (no trimming, no escaping; no input cap — truncation would delete the measured T4 win, F2/F3). Constraint text keeps the conservative "254-token embedding window" wording (the measured prompt).

**`parsePlan(text)`** — scan left-to-right tracking brace depth and JSON string state, collect complete top-level object spans; iterate spans **last → first**; first span that parses AND validates wins (handles F4's fragment-then-object). Validation: top-level object; `concepts` array; `2 ≤ concepts.length ≤ 6`; each concept `{name: 1..120 chars, queries: 1..4 strings}`; each query trimmed 1..300 chars; total queries 2..6. Failure reasons: `empty-text`, `no-json-object`, `invalid-shape`; never throws.

**`createRegistryPlanner({registry, model, env, now})`** — resolve model id from `PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` (`provider/model`) via `registry.find(...)`, else `model`; call `registry.streamSimple(resolved, { systemPrompt, messages: [{role:"user", content: user}] }, { signal })`, `await stream.result()`, extract text via `contentText` (pi-ai export, verified present). Map sync auth throw / error result / abort / no model → typed fallback (`no-model`, `transport`, `timeout`). Never throws.

**R2:** no HTTP planner fallback in v1. Registry failure → `fallback` → single-query path.

## 4. Jev score client (`jev-client.ts`)

Wire shape (measured, `/tmp/rag-multiquery/jev.ts:50-102`):

```json
{"model":"typesafe/jev-1.13","state":"<raw prompt, ≤32000 chars>",
 "questions":{"c0":{"type":"score",
   "instructions":{"candidate":{"path":"…","kind":"memory","excerpt":"<snippet ≤500>"},
     "question":"How much does `candidate` help answer or implement the user's request in the state? Rate only this candidate."},
   "criteria":["unrelated — it does not touch the request","related background — same area, but answers none of the request","partially answers — covers one need, misses the rest","directly answers — a specific need in the request is answered or implemented"]}}}
```

- Endpoint/model/key: `PI_BADGER_JEV_ENDPOINT` ?? `https://openrouter.ai/api/alpha/decisions`; `PI_BADGER_JEV_MODEL` ?? `typesafe/jev-1.13`; `OPENROUTER_API_KEY` (shared names with decision-router, copied by contract — B1).
- Response: `answers.c<i>.{type:"score",score,confidence}`; missing/non-object/wrong type/non-finite → `null`; finite score clamped to [0,3]. `error` envelope / invalid JSON / truncated → typed reject, never throws.
- Batches ≤12 (`SCORE_BATCH_MAX`); ≤3 attempts per batch (`SCORE_ATTEMPTS`); retryable: `server`, `transport-timeout`, `malformed`, `rate-limited`; non-retryable: `auth`, `billing`, `missing-key`, `misrouted-refusal`. No backoff; 429 `Retry-After` recorded, never slept on.
- Per-attempt timeout: `min(PI_BADGER_JEV_SCORE_TIMEOUT_MS ?? 30000, deadlineMs − now())`; ≤0 → skip batch, null its candidates. Timeout enforced by racing fetch against the injected scheduler timer + per-attempt `AbortController` chained to the outer signal (decision-router classifier pattern).
- Status mapping: 400→`misrouted-refusal`, 401→`auth`, 402→`billing`, 429→`rate-limited`, other non-200→`server`, unreadable→`malformed`; missing key → all nulls, zero fetches.
- Pool cap 48 by server rank; `usage` sums parsed batches; `warm()` issues exactly one tiny score call (`state:"warm"`, 5 s cap), result discarded, never throws.
- Error-kind union pinned equal to decision-router's at runtime.

## 5. Budget, progress, fallback

### Env table (clamp: floor, ceiling, non-finite → default; read per call)

| Name | Default | Clamp | Consumer |
|---|---|---|---|
| `PI_BADGER_QUERY_PIPELINE` | enabled | literal `"0"` disables | mem-based-rag call-site switch + preload |
| `PI_BADGER_QUERY_PIPELINE_TOTAL_MS` | 60000 | 5000–300000 | whole-run deadline |
| `PI_BADGER_QUERY_PIPELINE_PLANNER_MS` | 15000 | 1000–60000 | planner hard cap |
| `PI_BADGER_QUERY_PIPELINE_SEARCH_MS` | 15000 | 500–60000 | per-search cap |
| `PI_BADGER_QUERY_PIPELINE_SCORE_MS` | 20000 | 1000–60000 | scoring stage cap + search-phase reserve |
| `PI_BADGER_QUERY_PIPELINE_SLOTS` | 5 | 1–10 | merge budget (total, mem+code) |
| `PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` | unset → `ctx.model` | — | `provider/model` via registry |
| `PI_BADGER_JEV_SCORE_TIMEOUT_MS` | 30000 | 1000–120000 | per scoring attempt |
| `PI_BADGER_JEV_ENDPOINT` / `PI_BADGER_JEV_MODEL` / `OPENROUTER_API_KEY` | shared with decision-router | — | Jev transport |

### Arithmetic (absolute deadline, one shared AbortController)

```
t0 = now(); deadline = t0 + totalMs; remaining = () => deadline - now()
planner timeout = min(plannerMs, totalMs)
search timeout  = min(searchMs, max(0, remaining() - scoreMs)); stop searching when remaining() <= scoreMs + 500
scoring deadline = min(deadline, now() + scoreMs)
fallback timeout = min(searchMs, max(0, remaining())); skip fallback when remaining() < 1000
```

The whole stage sequence is raced against `deadline` via the injected scheduler; on firing, abort the shared controller, attach a no-op catch to the losing promise, return `budget-exhausted` (empty/partial). A single search timeout does not abort the shared controller — remaining queries continue.

### Progress (UI-agnostic callback; mem-based-rag owns the UI)

Exported consts `QP_STATUS_KEY = "query-pipeline"`, `QP_WIDGET_KEY = "query-pipeline"`. Strings (pinned by test): `query-pipeline: planning queries…`, `…searching i/n — "q"`, `…scoring N candidates (B batches)…`, `…merging N candidates…`. Emitted before each stage (fallback search reports `searching 1/1` with `concept:"fallback"`). mem-based-rag's `onProgress` wraps `ctx.ui.setStatus`/`setWidget` in `ctx.hasUI` + try/catch, and clears both with `undefined` in a `finally`. A throwing callback never fails the run.

### Failure matrix (`retrieve` never rejects)

| Failure | Behaviour | Injected |
|---|---|---|
| Planner fails/times out/zero queries | `onProgress(fallback, planner)`; one search on raw; envelope | normal block or `no-hits` |
| One of N searches fails | skip it, continue | block from remaining hits |
| All searches fail | fallback search on raw; empty if it fails | `no-hits` |
| Jev fails/partial | nulls sort last by server rank; merge proceeds | normal block |
| Budget exceeded | partial candidates merge; empty if none | `no-hits` |
| Missing key | scoring skipped (all nulls), multi-query merge by server rank | normal block |
| Unexpected throw | caught at `retrieve` boundary → empty envelope | `no-hits` |
| Preload fails | discarded; turn-time scorer retries | — |

**Kill switch (R4):** mem-based-rag checks `PI_BADGER_QUERY_PIPELINE === "0"` at the call site and runs today's single `searchCall` directly — the pipeline is not constructed. Inside the pipeline, `resolvePipelineBudget` still defaults to enabled (unit-tested independently).

## 6. mem-based-rag integration (PKG-5, the last package)

All edits in `extensions/mem-based-rag/index.ts`; `rag-core.ts` is **not edited** in v1.

- **E1** import `createQueryPipeline` after the rag-core import block (~:36-45).
- **E2** `setStatusSafely(ctx, text)` beside `notifySafely` (~:580-591): try/catch around `ctx.ui?.setStatus?.(QP_STATUS_KEY, text)`.
- **E3** `retrieveViaPipeline(ctx, raccoon, projectId, sessionId, raw, timeoutMs)` after `searchCall` (~:604-619): kill-switch check → direct `searchCall`; else construct the pipeline with `search: (q, limit, ms) => searchCall(raccoon, "memory_search", {projectId, sessionId, query:q, limit}, ms)`, `registry`/`model` from ctx, `onProgress` → `setStatusSafely`, `...deps.pipeline` overrides; `try { return await pipeline.retrieve({raw}) } finally { setStatusSafely(ctx, undefined) }`.
- **E4** auto call site (~:730-735): replace the `searchCall` block with `retrieveViaPipeline(...)`; the `JSON.parse → pruneHits → slice(0,5) → both-empty skip` lines stay byte-identical.
- **E5** `/ask` call site: **unchanged** (R1).
- **E6** `let lastPipeline = "n/a"`; append `Pipeline: ${lastPipeline}.` to `/rag status`.
- **E7** `MemRagDeps` gains `pipeline?: { plan?: PipelinePlannerFn; score?: PipelineScorerFn }` (test seam; mirrors `createClient`/`spawnAsk`).
- **E8** mem-based-rag's `session_start`/`warmClient` unchanged; the Jev preload is query-pipeline's own `session_start` handler (PKG-4).

Envelope survival: pipeline returns original hit objects verbatim (hash/path/sourceFile/snippet/ranking/lineStart/lineEnd) + score; `pruneHits`, `toMemoryContext`, `toExpandedMemoryContext`, card details all untouched.

## 7. Packages, acceptance criteria, gates

TDD for every package: the package's test file(s) land first, run red for the right reason, then implementation lands; the package merges only with its gate green. Test files: PKG-1 `tests/query-pipeline/merge.test.ts` + `planner-parser.test.ts`; PKG-2 `score-client.test.ts` (+ `fixtures/score-fixtures.ts`); PKG-3 `planner-call.test.ts`; PKG-4 `runner.test.ts` + `extension.test.ts` + `tests/publish/publish.test.ts` (added rows); PKG-5 `tests/mem-based-rag/pipeline-routing.test.ts`.

| Package | Files | Depends on | AC | Gate |
|---|---|---|---|---|
| **PKG-1 Frozen core** | `types.ts`, `merge.ts`, `planner.ts` | — | M1–M12 merge rows and P1–P10 parser rows green (full list in the test-plan appendix): 5 distinct docs; backfill only from included docs; no doc admitted that missed pass 1; same-path chunks share one slot (higher score kept); sourceFile fallback; ties keep retrieval order; `0.0` beats `null`; nulls last; zero candidates never throw; no repeated chunk; sixth doc dropped; entries keep their own score/kind. Parser: last-complete-object wins on the F4 fragment shape; trailing prose ignored; unterminated never throws; empty/malformed table typed; 300-char boundary; >6 total queries invalid; trimmed/blank handling; persona const equals `.ai-badger/agents/delegator.md` body; prompt pins raw between `<<<`/`>>>`. | `bun test tests/query-pipeline/merge.test.ts tests/query-pipeline/planner-parser.test.ts`; `bun run typecheck` |
| **PKG-2 Jev client** | `jev-client.ts` | PKG-1 types only | S1–S16 green: frozen consts; 12/13 boundary; batches carry only their candidates and the same state; retry via injected scheduler, capped at 3; auth/billing/refusal single-attempt; status→kind table; 429 Retry-After clamp; never-resolving fetch → `transport-timeout` with `signal.aborted` and 0 pending timers; missing key → 0 fetches; missing answers → null never 0; error envelope/truncated → typed; exact wire key sets; one failed batch leaves others intact; no response body echoed; timeout attempt 1 + success attempt 2 leaves no timer. | `bun test tests/query-pipeline/score-client.test.ts` (stub fetch + manual scheduler only) |
| **PKG-3 Planner adapter** | `planner-call.ts` | PKG-1 types only | Rows: builds `{systemPrompt, messages:[user]}` and calls `streamSimple(model, ctx, {signal})`; sync auth throw → `no-model`/`transport`; error result → fallback; abort → `timeout`; text via `contentText` → `parsePlan`; env model ref resolves via `registry.find`, miss → `no-model`; never throws. | `bun test tests/query-pipeline/planner-call.test.ts` |
| **PKG-4 Runner + extension + publish** | `pipeline.ts`, `index.ts`, `package.json`, `README.md`, `bun.lock`, `publish.ts` | PKG-1/2/3 | R1–R12 green: stage order plan→search×n→score→merge; sequential searches, never for the raw prompt; budget race → fallback, no throw; planner hard timeout, no search after it; progress sequence + final `undefined`; throwing progress safe; throw table (planner/search/merge → fallback; score throw keeps hits null-scored); zero candidates skip scoring; per-search timeout = remaining; planner receives raw; deadline armed on injected scheduler; fallback reason names the stage. E1–E8 green: warm once per session_start, idempotent across a shutdown, fail-open, kill-switch + key gated per call, env read per call, progress key/clear. Publish: `EXTENSION_DIRS` contains `query-pipeline`; package.json shape; purity scan on `pipeline.ts`/`planner.ts`/`merge.ts` (no ambient env/fetch/Date.now/bare timers outside injected seams). | `bun test tests/query-pipeline/runner.test.ts tests/query-pipeline/extension.test.ts tests/publish/publish.test.ts`; `bun run typecheck` |
| **PKG-5 Integration (LAST)** | `extensions/mem-based-rag/index.ts` edits + `tests/mem-based-rag/pipeline-routing.test.ts` | PKG-4 | I1–I8 green: enrichable turn routes through the injected pipeline and injects the merged block (direct search count 0); two overlapping turns serialize through `searchCall` (max concurrency 1); pipeline fallback → exactly 1 search on the raw query and still injects; kill switch → pipeline 0 calls, 1 search; throwing pipeline never rejects the hook; zero merged candidates → `no-hits` skip; expanded mode expands exactly the merged hashes; `/rag status` counters + `pipeline` reason. Existing `bun test tests/mem-based-rag/` baseline (131 pass) unchanged plus new rows, 0 fail; `rag-core.ts` diff empty. | `bun test tests/mem-based-rag/ tests/query-pipeline/`; `bun run typecheck`; full `bun test`; manual gates MG-1/MG-2/MG-3 recorded |

**Plan-level AC:** all five packages' ACs checked and met; touched-surface run + typecheck green; CI green on the PR (`bun test` + `tsc --noEmit`); `bun publish.ts && bun run check` in sync; MG-1/MG-2/MG-3 executed and recorded (MG-1 may validly return "status invisible" — that reopens the progress surface, it is not a test failure); every load-bearing mutation applied/run/reverted with pasted red or labelled `unverified (static reasoning)`.

## 8. Test plan (appendix — full rows)

Full RED-first rows (M1–M12, P1–P10, S1–S16, R1–R12, E1–E8, I1–I8), mutation→RED evidence, vacuity traps H-Q1…H-Q10, and per-package ACs live in the test-plan lane report; the load-bearing mutation subset that must carry pasted red proof: **M4, M7, M9, M12; P1, P7, P8; S2, S5, S9, S11, S14; R2, R3, R5, R7, R9; E2, E4; I1, I2, I3.** Every timer claim asserts the manual scheduler's `pendingCount()` exactly (0 or 1) and `lastDelayMs()` where the delay is the contract. No real network, no real stdio, no real sleeps; manual promise gates for concurrency.

**Manual gates (recorded evidence required):**
- **MG-1 progress visibility** `[UNVERIFIED A5]`: live pi, enrichable skill prompt, capture the terminal while the hook blocks; record first paint, widget, Esc effect, total duration, exact strings. If `setStatus` never paints → rework to `setWidget` (or status from the `input` handler) and record.
- **MG-2 direct planner latency** `[UNVERIFIED F5]`: ≥5 direct `streamSimple` runs; record wall time, tokens, cost, JSON validity, fragment-then-object count, p50/p95; set planner timeout ≈ p95 × 1.5 and total ≈ planner + N × search p95 + score; write numbers into the task report. If p95 is not materially below 66–147 s, reopen the budget rows before merge.
- **MG-3 real MCP end-to-end**: one enriched turn, record query list, selected paths, per-stage latencies, cost, manual relevance skim; repeat with `PI_BADGER_QUERY_PIPELINE=0` for the baseline.

**Gates:** per package as above; touched-surface once before push: `bun test tests/query-pipeline/ tests/mem-based-rag/ tests/publish/`; `bunx tsc --noEmit -p .`; `(cd extensions/query-pipeline && bun install --frozen-lockfile)`; `bun publish.ts` then `bun run check`. CI runs `bun test` + typecheck; `--check` is local-only. Full suite locally only if CI is dead.

## 9. Publish / release

1. `extensions/query-pipeline/package.json` + committed `bun.lock` (`bun install` once in that dir).
2. `publish.ts:70`: add `"query-pipeline"` to `EXTENSION_DIRS`; **export** `EXTENSION_DIRS` so `tests/publish/publish.test.ts` can pin membership.
3. `bun run test` + `bun run typecheck`.
4. `bun run publish` — installs all dirs recursively; auto-installs deps for a fresh clone.
5. `bun run check` — must print `in sync` (before publish it correctly reports `not installed` for the new files).
6. Install-alone caveat documented in `extensions/query-pipeline/README.md` and the mem-based-rag README.
7. Version bump + release commit at the end (orchestrator-owned, one commit).

## 10. Risks, deferred items, open measurements

1. **Turn blocking.** No harness timeout, no cancellation (C2); the delegated planner measured 66–147 s (F5) but the direct call is unmeasured. Mitigation: 15 s planner cap, 60 s total budget, deadline race, single-query fallback, MG-2 measurement. If the direct planner is too slow, flip the default to opt-in (one const) or route `/ask` only.
2. **Progress may not paint.** `setStatus`/`setWidget` visibility from a blocking hook is `[UNVERIFIED]`; MG-1 decides; `setWidget` is the fallback.
3. **Planner JSON drift / registry auth.** Last-complete-object parsing, shape validation, `null` on every failure; first implementation probe confirms auth.
4. **Cost.** Scoring ≈ $0.00036/run + warm ≈ $0.00002/session (measured); direct planner cost unmeasured (MG-2).
5. **Deferred:** parallel searches, `/ask` routing, HTTP planner fallback, mechanical-chunking baseline, planner stability repeats, independent relevance labels (research F14), preload persistence across minute-scale gaps.

## 11. Implementation dispatch (lanes)

- **Wave 1:** PKG-1 — `api-engineer`, own worktree branched from the task branch; TDD; commit per package.
- **Wave 2 (parallel):** PKG-2 (`api-engineer`) ∥ PKG-3 (`api-engineer`) — each its own worktree branched from the PKG-1 commit; disjoint files.
- **Wave 3:** PKG-4 — `api-engineer`, branched from the merged PKG-2+PKG-3 state.
- **Wave 4:** PKG-5 — `api-engineer`, branched from PKG-4; integration + manual gates (MG-1/MG-3 run by the orchestrator with the lane's harness).
- **Review (MoE):** `code-reviewer` + `qa` + one `architect` (different from plan authors) after PKG-5; QA test-quality pass on the new test files.
- Every lane: self-contained brief, TDD RED pasted, mutations applied/reverted with pasted red, no memory writes, no always-loaded context edits, report with evidence per criterion.
