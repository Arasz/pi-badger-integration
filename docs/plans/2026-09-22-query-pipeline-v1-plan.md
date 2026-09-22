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
  planner-call.ts   Pi adapter: createRegistryPlanner — structural modelRegistry.complete seam (pi 0.84.4
                    ModelRegistry exposes complete, NOT streamSimple — verified in node_modules types),
                    sync-auth-throw safe, AbortSignal-aware, always resolves a typed result, never throws.
  jev-client.ts     Minimal Jev `score` client (copy-by-contract from decision-router-client.ts):
                    same env names + error vocabulary, injected fetch/scheduler/env, batches ≤12, ≤3 attempts,
                    warm() preload call.
  merge.ts          Pure rank+merge rule (mergeSelect) + dedupePool + docKey. No imports.
  pipeline.ts       THE import seam: createQueryPipeline(deps) -> {retrieve({raw})} plus runPipeline
                    (typed result) and toEnvelope. Stage orchestration, budget/abort, progress, fallbacks.
  README.md         Contract summary + install-alone caveat (decision-router README precedent).
  package.json      Sibling-shaped manifest; dep: @earendil-works/pi-coding-agent only (text extraction is
                    inlined, so no pi-ai dependency and no version-skew surface).
  bun.lock          Committed (publish ships it; CI installs --frozen-lockfile per extension).
```

**Package order (plan-review F1):** `package.json` + `bun.lock` are created in **PKG-1** (the package that first creates the directory), not PKG-4 — CI's per-extension loop (`ci.yml:31-35`, `bash -e`) runs `bun install --frozen-lockfile` in every `extensions/*/` and fails on a directory with no `package.json`.

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

export type PipelinePlannerFn = (query: string, signal: AbortSignal, timeoutMs: number) => Promise<PlannerResult>;
export interface PipelineScore { hash: string; score: number | null; confidence?: number; }
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

export function formatProgress(p: PipelineProgress): string;   // the pinned stage strings; mem-based-rag must not re-implement them

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
export function createQueryPipeline(deps: QueryPipelineDeps): QueryPipeline;
export function runPipeline(deps: QueryPipelineDeps, input: { query: string }): Promise<PipelineResult>;
export function toEnvelope(result: PipelineResult): string;   // {"data":{"results":mem,"code":code}}
```

**Input is `query`, not `raw` (plan-review F18):** mem-based-rag passes `decision.query` (the `/skill:<id>`-prefix-stripped text `extractQuery` already produces), so the fallback search and the planner see exactly what today's search sees. A test pins that no `/skill:` prefix reaches the planner prompt or the fallback search. `retrieve` and `retrieveResult` are one implementation (`retrieve` wraps `retrieveResult` via `toEnvelope`), with a drift-pin test asserting `JSON.parse(await retrieve(x))` equals `toEnvelope(await retrieveResult(x))`.

`retrieve` resolves the exact `memory_search` envelope string (`{"data":{"results":[...],"code":[...]}}`) so mem-based-rag's `JSON.parse → pruneHits → slice` path is untouched. It **never rejects**: every failure degrades to a fallback/partial/empty envelope. `projectId`/`sessionId` are bound in the `search` closure; the pipeline never sees them.

**R3 (slots):** the owner's "5 results" is **5 slots total across mem+code**, not 5 per section. `mergeSelect` counts across kinds and splits by kind only for rendering; the budget is the hardcoded `MERGE_SLOTS = 5` (no env knob in v1).

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

`dedupePool` runs **per kind** (mem and code separately, matching `pruneHits`) and drops droppable rows first (`isDroppableHit` parity: empty/`?` path AND empty snippet), then dedupes on non-empty `hash` OR identical non-empty `snippet`, first occurrence wins — the same rule as `pruneHits` (`rag-core.ts:185-221`), pinned by a cross-package parity test (`tests/query-pipeline/parity.test.ts`, PKG-5). Dropping droppables before selection is load-bearing: a `{path:"?",snippet:""}` hit would otherwise win a pass-1 slot and then be deleted by mem-based-rag's `pruneHits`, injecting fewer than 5 entries. `dedupeQueries` drops exact trimmed duplicate queries preserving first occurrence, and drops any planned query equal to the input query (the planner must not be paid twice for an echo).

**Slots are hardcoded `MERGE_SLOTS = 5` in v1** (plan-review F15/SHOULD-9): no env knob, because mem-based-rag's `slice(0,5)` and `toMemoryContext`'s `maxMem/maxCode` defaults would silently cap anything larger anyway. **Null-scored distinct documents do take pass-1 slots** (pinned decision, plan-review SHOULD-8): the owner's rule is document-first, and a null is missing evidence about *one chunk*, not proof the document is irrelevant; the comparator still ranks scored candidates above nulls for pass-2 ordering. A merge test row pins this (A1 2.0, A2 1.9, B1 1.8, C1 1.7, D1 1.6, E1 null, slots 5 → A1,B1,C1,D1,E1).

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

**`createRegistryPlanner({registry, model, env, now})`** — resolve model id from `PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` by splitting on the **first `/`** (`provider/model`; a value with no `/` → `no-model`), via `registry.find(provider, modelId)`, else `model`; call `registry.complete(resolved, { systemPrompt, messages: [{role:"user", content: user}] }, { signal })` (`ModelRegistry.complete` is the public seam present in pi 0.84.4 and 0.87 — `streamSimple` exists only on the private runtime and on newer registries, plan-review MUST-1), await the `AssistantMessage`, extract text inline from `message.content` parts (`type === "text"` joined) — no `@earendil-works/pi-ai` dependency. Map absent `complete`/`find`, sync auth throw, error result, abort, and empty text → typed fallback (`no-model`, `transport`, `timeout`, `empty-text`). Never throws.

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
- Candidate wire `path` is `hit.path ?? hit.sourceFile ?? ""` (same fallback as `docKey`/`effectivePath`).
- Batches ≤12 (`SCORE_BATCH_MAX`); ≤3 attempts per batch (`SCORE_ATTEMPTS`); retryable: `server`, `transport-timeout`, `malformed`, `rate-limited`; non-retryable: `auth`, `billing`, `missing-key`, `misrouted-refusal`. No backoff; 429 `Retry-After` recorded, never slept on.
- Per-attempt timeout: `min(PI_BADGER_JEV_SCORE_TIMEOUT_MS ?? 15000, deadlineMs − now())`; ≤0 → skip batch, null its candidates. Timeout enforced by racing fetch against the injected scheduler timer + per-attempt `AbortController` chained to the outer signal (decision-router classifier pattern).
- Status mapping: 400→`misrouted-refusal`, 401→`auth`, 402→`billing`, 429→`rate-limited`, other non-200→`server`, unreadable→`malformed`; missing key → all nulls, zero fetches.
- Pool cap 48 by server rank; `usage` sums parsed batches; `warm()` issues exactly one tiny score call (`state:"warm"`, 5 s cap), result discarded, never throws.
- Error-kind union pinned equal to decision-router's at runtime.

## 5. Budget, progress, fallback

### Env table (clamp: floor, ceiling, non-finite → default; read per call)

| Name | Default | Clamp | Consumer |
|---|---|---|---|
| `PI_BADGER_QUERY_PIPELINE` | enabled | literal `"0"` disables | mem-based-rag call-site switch + preload |
| `PI_BADGER_QUERY_PIPELINE_TOTAL_MS` | 90000 | 5000–300000 | whole-run deadline |
| `PI_BADGER_QUERY_PIPELINE_PLANNER_MS` | 15000 | 1000–60000 | planner hard cap |
| `PI_BADGER_QUERY_PIPELINE_SEARCH_MS` | 15000 | 500–60000 | per-search cap |
| `PI_BADGER_QUERY_PIPELINE_SCORE_MS` | 8000 | 1000–60000 | scoring stage cap + search-phase reserve |
| `PI_BADGER_QUERY_PIPELINE_SEARCH_LIMIT` | 5 | 1–20 | per-query `limit` sent to `memory_search` (today's value; pinned in search-args tests) |
| `PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` | unset → `ctx.model` | — | `provider/model` via registry |
| `PI_BADGER_JEV_SCORE_TIMEOUT_MS` | 15000 | 1000–120000 | per scoring attempt (≤ stage cap) |
| `PI_BADGER_JEV_ENDPOINT` / `PI_BADGER_JEV_MODEL` / `OPENROUTER_API_KEY` | shared with decision-router | — | Jev transport |

### Arithmetic (absolute deadline, one shared AbortController)

```
t0 = now(); deadline = t0 + totalMs; remaining = () => deadline - now()
planner timeout = min(plannerMs, max(0, totalMs - searchMs - scoreMs))   # never consumes the search window
search timeout  = min(searchMs, max(0, remaining() - scoreMs)); stop searching when remaining() <= scoreMs + 500
scoring deadline = min(deadline, now() + scoreMs)
fallback timeout = min(searchMs, max(0, remaining() - scoreMs)); skip fallback when remaining() < 1000
```

**Defaults re-derived (plan-review F9/MUST-4):** the score reserve is 8 s (4× the measured 1.5–2 s for 3–4 batches), not 20 s — a 20 s reserve truncated the slowest measured prompt (T1: 6 searches, p50 7.9 s, 48.8 s total) to ~3 searches while leaving the reserve unused. Total 90 s gives a T1-class run (planner ≤15 s + 6×7.9 s + 8 s ≈ 70 s) full headroom. MG-2 re-derives `TOTAL = planner_p95×1.5 + N×search_p95 + 8000` from live numbers and rewrites these defaults if they differ. The planner cap is additionally clamped so a long planner can never eat the search window: with `TOTAL_MS=5000` and `PLANNER_MS=15000`, the planner gets at most `5000 − searchMs − scoreMs` and the fallback still has ≥1000 ms.

The whole stage sequence is raced against `deadline` via the injected scheduler; on firing, abort the shared controller, attach a no-op catch to the losing promise, return `budget-exhausted` (empty/partial). A single search timeout does not abort the shared controller — remaining queries continue.

### Progress (UI-agnostic callback; mem-based-rag owns the UI)

Exported consts `QP_STATUS_KEY = "query-pipeline"`, `QP_WIDGET_KEY = "query-pipeline"`. Strings (pinned by test in `formatProgress`): `query-pipeline: planning queries…`, `…searching i/n — "q"`, `…scoring N candidates (B batches)…`, `…merging N candidates…`. Emitted before each stage (fallback search reports `searching 1/1` with `concept:"fallback"`). mem-based-rag's `onProgress` calls the exported `formatProgress` (never re-implements the strings), wraps `ctx.ui.setStatus`/`setWidget` in `ctx.hasUI` + try/catch, and clears both with `undefined` in a `finally` — gated on the run token (INT-8). A throwing callback never fails the run.

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

All edits in `extensions/mem-based-rag/index.ts`; `rag-core.ts` is **not edited** in v1. Steps are named **INT-1..INT-9** to avoid colliding with the extension-test rows E1–E8.

- **INT-1** import `createQueryPipeline`, `formatProgress` after the rag-core import block (~:36-45).
- **INT-2** `setStatusSafely(ctx, text)` beside `notifySafely` (~:580-591): try/catch around `ctx.ui?.setStatus?.(QP_STATUS_KEY, text)`; `undefined` clears.
- **INT-3** `retrieveViaPipeline(ctx, raccoon, projectId, sessionId, query, timeoutMs)` after `searchCall` (~:604-619): kill-switch check → direct `searchCall`; else construct the pipeline with `search: (q, limit, ms) => searchCall(raccoon, "memory_search", {projectId, sessionId, query:q, limit}, Math.min(ms, timeoutMs))` (**per-search clamp to `config.timeoutMs`**, plan-review MUST-2 — otherwise a 500 ms test budget waits 15 s), `registry`/`model` from ctx, `onProgress` → `setStatusSafely(ctx, formatProgress(p))`, `...deps.pipeline` overrides; then:
  ```ts
  const result = await pipeline.retrieveResult({ query });
  lastPipeline = result.reason;
  // Preserve today's diagnostics: a dead bank still reports "bank error" with its message.
  if (result.status === "fallback" && result.reason === "search-error") throw new Error(result.error ?? "search failed");
  return toEnvelope(result);
  ```
  wrapped in `try { … } finally { setStatusSafely(ctx, undefined) }`. The rethrow is caught by the hook's existing outer catch (`:784-791`) → `skipped (bank error: …)`, so `wiring.test.ts:400-417` ("bank error") and `:419-438` ("timed out") keep passing with their existing assertions (plan-review MUST-2/6.1/6.2).
- **INT-4** auto call site (~:730-735): replace the `searchCall` block with `retrieveViaPipeline(ctx, raccoon, projectId, sessionId, decision.query, config.timeoutMs)`; the `JSON.parse → pruneHits → slice(0,5) → both-empty skip` lines stay byte-identical.
- **INT-5** `/ask` call site: **unchanged** (R1).
- **INT-6** `let lastPipeline = "n/a"`; append `Pipeline: ${lastPipeline}.` to `/rag status`; **reset `lastPipeline = "n/a"` in `resetSessionState`** (plan-review F19).
- **INT-7** `MemRagDeps` gains `pipeline?: { plan?: PipelinePlannerFn; score?: PipelineScorerFn; scheduler?: PipelineScheduler; now?: () => number }` (test seam; mirrors `createClient`/`spawnAsk`; the scheduler/now additions keep PKG-5 off real timers).
- **INT-8** progress ownership across overlapping turns (plan-review F11): the pipeline stamps each run with a monotonic token; `onProgress` ignores emissions whose token is not the latest, and the `finally` clears the status only if this run still owns the token — an earlier finisher must not wipe a later run's status.
- **INT-9** `session_start`/`warmClient` unchanged; the Jev preload is query-pipeline's own `session_start` handler (PKG-4).

**Test-env hygiene (plan-review QA 4.1/4.5):** PKG-5 extends the mem-based-rag test helper's env list (`tests/mem-based-rag/wiring.test.ts:29-58`) to also delete `OPENROUTER_API_KEY`, `PI_BADGER_JEV_*`, and `PI_BADGER_QUERY_PIPELINE*`, and `install()` injects a deterministic fake pipeline (fallback planner) so the pre-existing 131 tests exercise today's single-search path with **zero network**. New rows inject real plan/score fakes. Without this, any machine with `OPENROUTER_API_KEY` set would make the existing suite issue real Jev fetches.

Envelope survival: pipeline returns original hit objects verbatim (hash/path/sourceFile/snippet/ranking/lineStart/lineEnd) + score; `pruneHits`, `toMemoryContext`, `toExpandedMemoryContext`, card details all untouched.

## 7. Packages, acceptance criteria, gates

TDD for every package: the package's test file(s) land first, run red for the right reason, then implementation lands; the package merges only with its gate green. Test files: PKG-1 `tests/query-pipeline/merge.test.ts` + `planner-parser.test.ts`; PKG-2 `score-client.test.ts` (+ `fixtures/score-fixtures.ts`); PKG-3 `planner-call.test.ts`; PKG-4 `runner.test.ts` + `extension.test.ts` + `tests/publish/publish.test.ts` (added rows); PKG-5 `tests/mem-based-rag/pipeline-routing.test.ts`.

| Package | Files | Depends on | AC | Gate |
|---|---|---|---|---|
| **PKG-1 Frozen core + manifest** | `types.ts`, `merge.ts`, `planner.ts`, `package.json`, `bun.lock` | — | M1–M12 merge rows (corrected per plan review: drop the tautological "no doc admitted that missed pass 1" row; add D<slots backfill order, no repeated hash, never exceed slots, D>slots pass-2 no-op, mem/code total split, droppable-hit parity, null-distinct-doc pass-1 row) and P1–P10 parser rows (fragment-then-complete, two complete objects where the later wins, later-invalid falls back to the earlier valid, exact reason per malformed input) green. Package.json exists from the first commit so CI's per-extension frozen install does not fail. | `bun test tests/query-pipeline/merge.test.ts tests/query-pipeline/planner-parser.test.ts`; `bun run typecheck`; `(cd extensions/query-pipeline && bun install --frozen-lockfile)` |
| **PKG-2 Jev client** | `jev-client.ts` | PKG-1 types only | S1–S16 green plus warm-client rows (one call, `state:"warm"`, 5 s cap, discarded, never throws), per-attempt `min(env, deadline−now)` and ≤0→skip, pool cap 48, usage sum, error-kind union parity, score clamp, `path` falls back to `sourceFile`. A compile-level `const _score: PipelineScorerFn = createJevScorer({...})` assertion makes type drift fail this package's gate. | `bun test tests/query-pipeline/score-client.test.ts` (stub fetch + manual scheduler only) |
| **PKG-3 Planner adapter** | `planner-call.ts` | PKG-1 types only | Rows: calls `registry.complete(model, {systemPrompt, messages:[user]}, {signal})`; absent `complete`/`find` → `no-model`; sync auth throw → typed fallback; error result → fallback; abort → `timeout`; inline text extraction → `parsePlan`; env model ref splits on first `/`, missing slash → `no-model`; unset env → `ctx.model`; empty text → `empty-text`; never throws. Compile-level `const _plan: PipelinePlannerFn = createRegistryPlanner({...})` assertion. | `bun test tests/query-pipeline/planner-call.test.ts` |
| **PKG-4 Runner + extension + publish** | `pipeline.ts`, `index.ts`, `README.md`, `publish.ts` | PKG-1/2/3 | R1–R12 green (plus: planner cap never consumes the search window; fallback subtracts the score reserve; one-of-N search failure continues; all-searches-fail performs at most one fallback search; single search timeout does not abort the shared controller; missing key → zero fetches + server-rank merge; external `deps.signal` abort; counters from injected `now`) and E1–E8 green (warm once per session, idempotent across shutdown, fail-open, kill-switch + key gated per call, env read per call, progress key/clear, `formatProgress` strings, **a `runner-defaults` row calling `createQueryPipeline` with no `plan`/`score` overrides and asserting `status:"pipeline"`**). Publish: `EXTENSION_DIRS` contains `query-pipeline`; `toEnvelope` shape asserted on **every** failure path; all six env clamps; kill-switch split (call site vs `resolvePipelineBudget`); purity scan. | `bun test tests/query-pipeline/ tests/publish/publish.test.ts`; `bun run typecheck` |
| **PKG-5 Integration (LAST)** | `extensions/mem-based-rag/index.ts` edits (INT-1..INT-9), `tests/mem-based-rag/pipeline-routing.test.ts`, `tests/query-pipeline/parity.test.ts`, wiring-test env hygiene | PKG-4 | I1–I8 green (plus exact merged-hash list in expanded mode; envelope field preservation for `ranking`/`lineStart`/`lineEnd`; no `/skill:` prefix reaches planner or fallback; per-search `limit` pinned to 5) and the parity rows: `PipelineCandidate` assignable to `MemoryHit`; `dedupePool` vs `pruneHits` on hash/snippet collisions per kind; droppable-hit parity; `retrieve` == `toEnvelope(retrieveResult)`. Existing `bun test tests/mem-based-rag/` baseline (131 pass) unchanged with the env-hygiene + fake-pipeline injection (no assertion rewrites needed: the search-error rethrow preserves the "bank error"/"timed out" reasons). `rag-core.ts` diff empty. | `bun test tests/mem-based-rag/ tests/query-pipeline/`; `bun run typecheck`; full `bun test`; manual gates MG-1/MG-2/MG-3 recorded |

**Plan-level AC:** all five packages' ACs checked and met; touched-surface run + typecheck green; CI green on the PR (`bun test` + `tsc --noEmit`); `bun publish.ts && bun run check` in sync; MG-1/MG-2/MG-3 executed and recorded; every load-bearing mutation applied/run/reverted with pasted red or labelled `unverified (static reasoning)`.

## 8. Test plan (appendix — full rows)

Full RED-first rows (M1–M12, P1–P10, S1–S16, R1–R12, E1–E8, I1–I8), mutation→RED evidence, vacuity traps H-Q1…H-Q10, and per-package ACs live in the committed test-plan artifact **`docs/plans/2026-09-22-query-pipeline-v1.plan-tests.md`** (plan-review MUST 2.1: the artifact is committed before Wave 1, and its "Plan-review corrections" section supersedes the rows it names). The load-bearing mutation subset that must carry pasted red proof: **M4, M7, M9, M12; P1, P7, P8; S2, S5, S9, S11, S14; R2, R3, R5, R7, R9; E2, E4; I1, I2, I3.** Every timer claim asserts the manual scheduler's `pendingCount()` exactly (0 or 1) and `lastDelayMs()` where the delay is the contract. No real network, no real stdio, no real sleeps; manual promise gates for concurrency.

**Manual gates (recorded evidence required; both must be able to fail — plan-review QA 5.1/5.2):**
- **MG-1 progress visibility** `[UNVERIFIED A5]`: live pi, enrichable skill prompt, capture the terminal while the hook blocks; record first paint timestamp, widget, Esc effect (state the acceptable outcome first: Esc is expected to be ignored until the hook returns), total duration, exact strings. **Pass requires pasted evidence that the status/widget painted and cleared.** If `setStatus` never paints, the gate fails until the chosen fallback (`setWidget`, or a status set from the `input` handler) is implemented and re-verified with pasted evidence in the same PR — "recorded as invisible" alone does not pass.
- **MG-2 direct planner latency** `[UNVERIFIED F5]`: **N ≥ 10** direct `registry.complete` runs; paste per-run wall time, tokens, cost, JSON validity, parse shape; record p50/p95 (not max). **Pass criterion:** raw p95 < the shipped `PI_BADGER_QUERY_PIPELINE_PLANNER_MS` default, and the re-derived defaults satisfy `TOTAL ≥ planner_p95×1.5 + N×search_p95 + 8000`; if not, flip the default to opt-in in the same PR (the exit, not an option) or cut the planner. Write the numbers into the task report and the plan's env table.
- **MG-3 real MCP end-to-end**: one enriched turn; record planner queries ≠ the raw prompt, observed search count, per-stage latencies + cost, and **≥1 merged path absent from the `PI_BADGER_QUERY_PIPELINE=0` baseline top-5** (the F9 claim) from the same session, plus a manual relevance skim (F11/F14: Jev scores are not independent labels).

**Gates:** per package as above; touched-surface once before push: `bun test tests/query-pipeline/ tests/mem-based-rag/ tests/publish/`; `bunx tsc --noEmit -p .`; `(cd extensions/query-pipeline && bun install --frozen-lockfile)`; `bun publish.ts` then `bun run check`. CI runs `bun test` + typecheck; `--check` is local-only. Full suite locally only if CI is dead.

## 9. Publish / release

1. `extensions/query-pipeline/package.json` + committed `bun.lock` (**PKG-1**; `bun install` once in that dir).
2. `publish.ts:70`: add `"query-pipeline"` to `EXTENSION_DIRS`; **export** `EXTENSION_DIRS` so `tests/publish/publish.test.ts` can pin membership; update the `publish.ts` header comment's extension enumeration (plan-review SHOULD-13).
3. Docs (plan-review F13): `extensions/query-pipeline/README.md` (contract, env names, install-alone caveat, **data-egress note**: the query text leaves the machine to the planner provider and the candidate excerpts/prompt go to OpenRouter for Jev scoring, gated by the kill switch) and a `docs/reference/extension-catalog.md` section for the new extension.
4. `bun run test` + `bun run typecheck`.
5. `bun run publish` — installs all dirs recursively; auto-installs deps for a fresh clone.
6. `bun run check` — must print `in sync` (before publish it correctly reports `not installed` for the new files).
7. Install-alone caveat documented (mem-based-rag has no README today — the caveat lives in the query-pipeline README and the catalog section; no new mem-based-rag README is required).
8. Version bump + release commit at the end (orchestrator-owned, one commit).

## 10. Risks, deferred items, open measurements

1. **Turn blocking.** No harness timeout, no cancellation (C2); the delegated planner measured 66–147 s (F5) but the direct call is unmeasured. Mitigation: 15 s planner cap (never eating the search window), 90 s total budget with an 8 s score reserve, deadline race, single-query fallback, MG-2 measurement. If the direct planner is too slow, flip the default to opt-in (one const) — **not** "/ask only" (plan-review F16: `/ask` routing is unscoped in v1, so that mitigation does not exist).
2. **Progress may not paint.** `setStatus`/`setWidget` visibility from a blocking hook is `[UNVERIFIED]`; MG-1 decides; `setWidget` is the fallback.
3. **Planner JSON drift / registry auth.** Last-complete-object parsing, shape validation, `null` on every failure; first implementation probe confirms auth.
4. **Cost.** Scoring ≈ $0.00036/run + warm ≈ $0.00002/session (measured); direct planner cost unmeasured (MG-2).
5. **Deferred:** parallel searches, `/ask` routing, HTTP planner fallback, mechanical-chunking baseline (plan-review F17 flags it as possibly load-bearing — if a trivial paragraph split captures the planner's win, the planner can be cut; run it as a cheap spike in the optimization pass), planner stability repeats, independent relevance labels (research F14), preload persistence across minute-scale gaps, `PI_BADGER_QUERY_PIPELINE_SLOTS` configurability (hardcoded 5 in v1).

## 11. Implementation dispatch (lanes)

- **Wave 1:** PKG-1 — `api-engineer`, own worktree branched from the task branch; TDD; commit per package.
- **Wave 2 (parallel):** PKG-2 (`api-engineer`) ∥ PKG-3 (`api-engineer`) — each its own worktree branched from the PKG-1 commit; disjoint files.
- **Wave 3:** PKG-4 — `api-engineer`, branched from the merged PKG-2+PKG-3 state.
- **Wave 4:** PKG-5 — `api-engineer`, branched from PKG-4; integration + manual gates (MG-1/MG-3 run by the orchestrator with the lane's harness).
- **Review (MoE):** `code-reviewer` + `qa` + one `architect` (different from plan authors) after PKG-5; QA test-quality pass on the new test files.
- Every lane: self-contained brief, TDD RED pasted, mutations applied/reverted with pasted red, no memory writes, no always-loaded context edits, report with evidence per criterion.

## 12. Implementation amendments (recorded 2026-09-23)

**A1 — Planner shape tolerance (MG-2 measurement, 2026-09-23).** Measured on the direct planner (deepseek-v4.1-flash, N=10): the model reliably emits **4 concepts / 7–9 queries** — structurally valid but over the "2 to 6 queries total" contract. The plan's strict rejection discarded **5/10 usable plans** (silent fallback to the single query), which would have erased most of the pipeline's win. Amended: `parsePlan` now **normalizes** — drops malformed concepts/queries, ignores unknown keys, truncates to 6 total and 4 per concept; `invalid-shape` only when fewer than 2 usable queries remain. Re-measured: **10/10 parse**, p50 4.2 s / p95 5.6 s, ≈$0.0003/call, planner cap 15 s holds with 2.7× headroom. Test rows P5–P9 updated to the tolerant semantics.

**A2 — Numeric-string server rank.** Plan §2 required `ranking` numeric strings to parse; `merge.ts`/`pipeline.ts` initially treated them as `+Infinity`. Fixed in both; rows M21/M22 added, M21 mutation-proven red.

**A3 — Review-rigor note.** The implementation-review MoE could not run: five consecutive delegated review lanes stalled on established provider connections (2026-09-22 23:54 → 2026-09-23 00:14) while the orchestrating session stayed live; the machine had 6+ concurrent children from a sibling session. The plan-review MoE (three independent reviewers) and the per-package mutation ledgers did run. The implementation review was completed **in-session** against the plan ACs (reduced rigor, recorded).
