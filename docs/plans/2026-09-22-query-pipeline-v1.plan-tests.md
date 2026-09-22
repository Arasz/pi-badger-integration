# Test plan — `pbi-multi-query-rag-pipeline-v1`

**Status:** committed artifact required by plan review (QA MUST 2.1). The rows below the "Plan-review corrections" section are the P3 test-strategy lane's full list; **where a correction names a row, the correction supersedes it**.

## Plan-review corrections (authoritative)

### C1 — Merge rows: remove the tautology, add the missing rows (QA 1.1, 1.3, 1.6, 1.7; architect SHOULD-6/7/8)
- **M3 is withdrawn.** "backfill never admits a document that missed the best-chunk pass" is unreachable: pass 2 runs only when `D < slots`, where pass 1 already visited every candidate and `seenDocs` contains every docKey. No fixture can redden it. Replace with:
  - **M3a** `fewer docs than slots: second chunks fill remaining slots in global rank order` — D<slots, every doc ≥2 chunks, distinct scores → expected order is score-desc within the backfill.
  - **M3b** `backfill never exceeds the slot budget` — assert `length === slots` exactly.
  - **M3c** `with more docs than slots, pass 2 is a no-op` — D>slots → exactly `slots` entries, all distinct docs.
- **M4 fixture correction:** insert the *lower*-scored chunk of the same `docKey` **before** the higher-scored one; assert the higher-scored chunk survives (otherwise "first inserted wins" passes).
- **New M13** `mem and code share the five-slot budget` — 4 mem + 4 code, slots 5 → exactly 5 total across both arrays, kind split preserved, no kind gets 5.
- **New M14** `a null-scored distinct document takes a pass-1 slot` — A1 2.0, A2 1.9, B1 1.8, C1 1.7, D1 1.6, E1 null → chosen A1,B1,C1,D1,E1 (document-first per the owner's rule; nulls are missing evidence about one chunk, not the document).
- **New M15** `droppable hits never take a slot` — a `{path:"?",snippet:""}` candidate is dropped by `dedupePool` before selection (parity with `isDroppableHit`), so a scored eligible candidate takes the slot.

### C2 — Parser rows: fixtures that can actually fail (QA 1.2, 1.4)
- **P1** must use the measured F4 shape and paste the exact bytes: (i) an **unterminated** object fragment before a valid object; (ii) **two complete valid objects where the later wins**; (iii) a valid object followed by a later complete but **shape-invalid** object → the earlier valid one wins (this is the only input pinning "last that parses *and validates*").
- **P-table** rows assert the **exact reason** (`empty-text` / `no-json-object` / `invalid-shape`) per input, never merely `status !== "ok"`.
- **M6/P-tie fixtures** insert hashes in reverse alphabetical order so a hash-tiebreak mutant dies.

### C3 — New parity file `tests/query-pipeline/parity.test.ts` (QA 1.5; architect F7)
Assigned to PKG-5. Pins: (a) `PipelineCandidate` assignable to `MemoryHit`; (b) `dedupePool` vs `pruneHits` on hash collisions and identical-snippet/different-hash pairs, **per kind**; (c) droppable-hit parity; (d) `JSON.parse(await retrieve(x))` equals `toEnvelope(await retrieveResult(x))`.

### C4 — Missing rows (QA 2.2/3; code-review MUST-1/3)
- **PKG-4:** `toEnvelope` exact `{"data":{"results":[],"code":[]}}` on **every** failure path (planner fail, search fail, budget, unexpected throw); all six `PI_BADGER_QUERY_PIPELINE_*` env clamps (unset/blank/NaN/negative/over-max) + `PI_BADGER_JEV_SCORE_TIMEOUT_MS`; kill-switch split (call site does 1 direct search with `plan`/`score` spies never called; `resolvePipelineBudget` still enabled); `runner-defaults` row: `createQueryPipeline({search, registry: fakeRegistry, env, scheduler, now})` with **no** `plan`/`score` overrides → `status:"pipeline"`; exact `formatProgress` strings; one-of-N search failure continues; all-searches-fail performs **at most one** fallback search; a single search timeout does **not** abort the shared controller; missing key → zero fetches + server-rank merge; external `deps.signal` abort; counters driven by injected `now`; per-search `limit` pinned to 5.
- **PKG-2:** `warm()` one call / `state:"warm"` / 5 s cap / discarded / never throws; per-attempt `min(env, deadline−now)` and ≤0→skip; pool cap 48; usage sum; error-kind union parity; score clamp; candidate `path` falls back to `sourceFile`.
- **PKG-3:** `registry.complete` (NOT `streamSimple` — pi 0.84.4 `ModelRegistry` has no `streamSimple`; verified in `node_modules` types); absent `complete`/`find` → `no-model`; sync auth throw → typed fallback; abort → `timeout`; empty text → `empty-text`; model ref splits on the **first** `/`, missing slash → `no-model`; env unset → `ctx.model`; compile-level `const _score: PipelineScorerFn = createJevScorer({...})` / `const _plan: PipelinePlannerFn = createRegistryPlanner({...})` assertions in PKG-2/PKG-3 tests (architect F3).
- **PKG-5:** `retrieveResult().reason` reaches `lastPipeline` and `/rag status` (code-review MUST-3); search-error rethrow preserves the existing `bank error`/`timed out` reasons (code-review MUST-2); per-search `ms` clamped to `config.timeoutMs`; no `/skill:` prefix reaches planner or fallback search; expanded mode asserts the **exact** merged hash list; envelope field preservation (`ranking`, `lineStart`, `lineEnd`).

### C5 — Isolation corrections (QA 4.1–4.5)
- **4.1 (MUST):** mem-based-rag test env hygiene must delete `OPENROUTER_API_KEY`, `PI_BADGER_JEV_*`, and `PI_BADGER_QUERY_PIPELINE*`; `install()` injects a deterministic fake pipeline (fallback planner → today's single-search path) so the existing 131 tests never touch the network.
- **4.2 (MUST):** query-pipeline's extension factory takes injected deps (`createScorer?`, `warm?`, `env?`, `scheduler?`, `now?`) mirroring `DecisionRouterDeps` — the warm rows have a seam.
- **4.3/4.4:** `MemRagDeps.pipeline` gains `scheduler`/`now`; `PipelineScheduler` is defined in `types.ts` (plan §1.1).
- **4.5:** kill-switch env is cleared in per-file `beforeEach`/`afterEach` so one test's `=0` cannot mask later regressions.

### C6 — Manual-gate corrections (QA 5.1–5.4)
- **MG-1** passes only with pasted painted-and-cleared evidence, or with the fallback surface implemented and re-verified in the same PR. "Recorded as invisible" alone fails.
- **MG-2** uses N ≥ 10, pastes per-run data, and passes only if raw p95 < the shipped planner cap **and** the re-derived `TOTAL ≥ planner_p95×1.5 + N×search_p95 + 8000`; otherwise the default flips to opt-in in the same PR.
- **MG-3** records planner queries ≠ raw prompt, observed search count, per-stage latencies + cost, and ≥1 merged path absent from the `PI_BADGER_QUERY_PIPELINE=0` baseline top-5.
- **MG-1 Esc** criterion stated before running: Esc is expected to be ignored until the hook returns.

---

# Test plan — `pbi-multi-query-rag-pipeline-v1` (P3 test-strategy lane)

Scope: the test half of the implementation plan only. Read-only lane — no file was modified, no memory written, no code executed beyond reads. Production-code layout, env-name freezing, and PR sequencing belong to the sibling lanes; this plan names only the seams those lanes must expose so the tests below can exist.

Sources read: `docs/work/2026-09-22-query-pipeline-v1-research.md` (A7 seams, B4 probe, C2 hook reality, D1–D8); `docs/work/2026-09-21-delegated-multi-query-rag-with-jev-selection.md` (F4, F5, F6, F10, F11, F14); `extensions/mem-based-rag/index.ts:106-121,262,400,440-469,590-800`; `extensions/mem-based-rag/rag-core.ts:155-260`; `extensions/decision-router/decision-router-client.ts:428-585`; `extensions/decision-router/index.ts:85-110`; `tests/helpers/fake-pi.ts`; `tests/mem-based-rag/wiring.test.ts`; `tests/mem-based-rag/rag-core.test.ts`; `tests/decision-router/jev-client.test.ts`; `tests/publish/publish.test.ts`; `publish.ts:70,153-182`; `.github/workflows/ci.yml`; `.ai-badger/skills/review-tests/SKILL.md`; `.ai-badger/skills/design-tests/SKILL.md`.

Legend: `[READ]` verified in repo/research; `[MEASURED]` from the research record's own runs; `[PLAN]` this plan's recommendation, not yet verified; `[UNVERIFIED]` cannot be settled by unit tests (manual gate named).

## 0. Frozen decisions the tests pin, and freeze items the architect must close before RED

From research D1–D8 `[READ]`:

- New `extensions/query-pipeline/` ships a planner call, a minimal Jev score client, pure stage functions, a runner, and a `session_start` preload.
- mem-based-rag routes its enrichment search through the pipeline; `searchCall`'s single-flight stays the transport; output satisfies the existing `{data:{results,code}}` → `MemoryHit[]` normalization.
- Merge rule (owner): 5 slots; rank by Jev score; best chunk per distinct document first; backfill from already-included documents when fewer than 5 distinct docs.
- Preload: one fail-open warm call at `session_start`, idempotent, gated on key + kill switch.
- Progress via `ctx.ui.setStatus` (+ optional `setWidget`), cleared in `finally`; the durable card stays the final-result surface.
- Budget: self-enforced AbortController + timer; planner gets its own hard timeout; any failure falls back to today's single-query enrichment; the hook never throws.
- `publish.ts` `EXTENSION_DIRS` gains `query-pipeline`.
- Today's search timeout is 20,000 ms (clamp 500–60,000), not the stale 8,000 `[READ: A3, index.ts:106-121]`.

Freeze items — tests import exported names and constants, so these must be recorded in the plan before the affected test is written. Where a choice is needed, this plan states the recommended default in parentheses.

| # | Freeze item | Why a test cannot be written without it |
|---|---|---|
| FZ-1 | Export names and file split inside `extensions/query-pipeline/` (`query-pipeline-core.ts`, `score-client.ts`, `planner.ts`, `runner.ts`, `index.ts` — working names) | Every test imports these symbols |
| FZ-2 | Merge identity (`path ?? sourceFile`), tiebreak (stable retrieval order), unscored ordering (after all scored, stable), backfill order (global next-best by score among included documents) | M5–M7, M12 assert exact order |
| FZ-3 | Slots semantics: one merged pool of 5, or per-kind 5+5 | M1/M10 and I1 assert exact lengths |
| FZ-4 | Env names: kill switch (`PI_BADGER_QUERY_PIPELINE=0`), budget (`PI_BADGER_QUERY_PIPELINE_BUDGET_MS`), planner timeout (`PI_BADGER_QUERY_PIPELINE_PLANNER_TIMEOUT_MS`), score timeout (`PI_BADGER_JEV_SCORE_TIMEOUT_MS`, default 30,000) — recommended; `OPENROUTER_API_KEY` / `PI_BADGER_JEV_ENDPOINT` / `PI_BADGER_JEV_MODEL` reused by contract | E4/E5, S1 assert the exported consts |
| FZ-5 | Whether the planner keeps the C1 registry-failure HTTP fallback | E7 is deleted if the fallback is dropped |
| FZ-6 | Retryable kind set (recommended: `server`, `transport-timeout`, `rate-limited`) and backoff schedule | S4–S6 assert call counts |
| FZ-7 | `MemRagDeps` pipeline seam shape (recommended: `pipeline?: { run(input, deps): Promise<PipelineResult> }`, with the hook passing its real `searchCall` as the `search` dep) | I1–I8 |

Testability contract (what sibling lanes must expose) `[PLAN]`:

1. Pure `mergeRanked(candidates: ScoredCandidate[], {slots}): ScoredCandidate[]` — no clock, no I/O, no pi import.
2. Pure `parsePlannerOutput(text: string): PlannerParse` — typed `{status:"ok"|"invalid", reason?}`; never throws.
3. `createScoreClient({fetchFn, scheduler, now, env})` → `{scoreCandidates(candidates): Promise<ScoreResult>, warm(): Promise<void>}`, `ScoreResult = {scores: Map<string, number|null>, errors: ScoreError[]}`; same `JevErrorKind` vocabulary as the frozen client, own 30 s default.
4. `runQueryPipeline(input, {plan, search, score, merge?, progress, now, scheduler, budgetMs, plannerTimeoutMs})` → `{status:"ok", hits, meta} | {status:"fallback", reason}`; never throws.
5. Factory `default function (pi, deps?: {createScoreClient?, plannerFn?, env?, now?, scheduler?})`; `session_start` preload; `setStatus` progress wiring; `MemRagDeps.pipeline` on the mem-based-rag side.

## 1. Test file layout per package

| Package | Test path | Covers | Kind | Isolation controls |
|---|---|---|---|---|
| QP-CORE | `tests/query-pipeline/merge.test.ts` | merge rule: 5 docs, backfill, ties, null/partial scores, zero candidates, path dedup | pure unit | time none, network none, fs none, env none, random none |
| QP-CORE | `tests/query-pipeline/planner-parser.test.ts` | last-complete-object, shape validation, empty, caps | pure unit | same as above |
| QP-CLIENT | `tests/query-pipeline/score-client.test.ts` | batching, retry, error kinds, timeout/abort, partial answers, wire shape | unit with doubles | time = injected scheduler + fixed `now`; network = stub `fetchFn`; env = per-call record |
| QP-CLIENT | `tests/query-pipeline/fixtures/score-fixtures.ts` | measured wire body + synthetic error/truncated bodies (mirrors `tests/decision-router/fixtures/jev-fixtures.ts`) | fixture module | n/a |
| QP-RUNNER | `tests/query-pipeline/runner.test.ts` | stage order, sequential searches, budget/planner timeout → fallback, progress sequence, never throws | unit with doubles | time = injected scheduler + mutable clock; network = fakes; env none |
| QP-EXT | `tests/query-pipeline/extension.test.ts` | preload once/idempotent/fail-open/kill switch, progress wiring, registry fallback, per-call env | wiring on `createFakePi` | time = injected scheduler; network = injected client factory; env = saved/restored record |
| QP-INT | `tests/mem-based-rag/pipeline-routing.test.ts` | hook routes through pipeline, single-flight, fallback to single query, kill switch, no-hits, expanded hashes, status | integration, fakes only | time = manual promise gates (no sleeps); network none (`createClient` fake); fs = tmp project-id dirs; env saved/restored |
| QP-PUB | no new test file; gate only | `EXTENSION_DIRS` registration + install | repo gate | n/a |

Existing files stay untouched: `tests/mem-based-rag/wiring.test.ts`, `rag-core.test.ts`, `tests/decision-router/*` (append-only rule; if the mem-based-rag `install()` helper must learn the pipeline dep, that is a plan deviation to flag, not a silent edit). The new integration file carries its own fakes so the 1,100-line wiring file is not disturbed.

RED order follows the dependency layers, one failing test at a time: Phase 1 QP-CORE → Phase 2 QP-CLIENT → Phase 3 QP-RUNNER → Phase 4 QP-EXT → Phase 5 QP-INT → Phase 6 QP-PUB gate.

## 2. RED-first test list

Every row below is a single `test(...)` whose name states the acceptance criterion. "Seam" names what the test injects; "none (pure)" means the function takes plain data. Fixtures are non-degenerate by construction (see §3 honesty notes). All mutations are `[PLAN]` — the implementation lane must apply, run, and revert each, pasting the output.

### Package QP-CORE — `tests/query-pipeline/merge.test.ts`

| # | Exact test name | Asserts (secondary observable in **bold**) | Seam | Mutation → RED evidence |
|---|---|---|---|---|
| M1 | `five distinct documents fill five slots in descending Jev score order` | exact path order `[d4,d2,d3,d1,d5]`, length 5, one entry per path | none | delete the document sort → input order returned; paste both orders |
| M2 | `fewer than five documents backfill remaining slots from already-included documents` | 2 docs (A: 3 chunks, B: 1) → length 4, order `[A1,B1,A2,A3]` | none | remove the backfill pass → length 2; paste |
| M3 | `backfill never admits a document that missed the best-chunk pass` | a 4th doc's chunk never appears even though its score beats a backfilled chunk | none | backfill pool = all remaining chunks → doc D path appears; paste path list |
| M4 | `two chunks of the same path occupy one document slot; the higher-scored chunk is kept` | A(0.9)+A(0.88)+B..E → exactly `[A,B,C,D,E]`; **A's hash is the 0.9 chunk** | none | dedup key = hash → 6 entries / a doc displaced; paste |
| M5 | `path identity falls back to sourceFile when path is absent` | `{sourceFile:"docs/x.md"}` groups with `{path:"docs/x.md"}` as one document | none | key = `hit.path ?? ""` → two entries; paste paths |
| M6 | `equal scores preserve retrieval order` | 2-way and 3-way exact ties keep input order; a distinct-score doc still sorts above them | none | comparator returns 1 on ties, or tiebreak by path → order flips; paste |
| M7 | `null and missing scores rank after every scored candidate, in retrieval order` | input `[B:null, A:0.0, C:undefined]` → `[A,B,C]` | none | `score ?? 0` → B before A; paste order |
| M8 | `zero candidates merge to an empty list, never throw` | `[] → []`; single candidate → single entry | none | guard replaced by `throw`, or backfill indexes `[0]` → thrown error |
| M9 | `backfill never repeats the best chunk` | 2 docs, 6 chunks, 5 slots → length 5 and hash set size 5 | none | backfill pool includes `slice(0)` → duplicate hash; paste hashes |
| M10 | `slots default to 5; a sixth distinct document is dropped` | 6 docs → 5 entries, lowest absent | none | ignore `slots` → length 6; paste |
| M11 | `each merged entry carries its own score and kind` | backfilled A2 (0.8) entry keeps 0.8 and A2's `kind`, never A1's 0.9 | none | copy group-best score onto every entry → A2 shows 0.9; paste entry |
| M12 | `path dedup with a tie backfills in retrieval order` | A chunks a2(0.7 first), a3(0.7), a1(0.9) + B(0.8) → `[A1,B,a2,a3]` | none | tiebreak by hash/reverse → a3 before a2; paste |

### Package QP-CORE — `tests/query-pipeline/planner-parser.test.ts`

| # | Exact test name | Asserts | Seam | Mutation → RED evidence |
|---|---|---|---|---|
| P1 | `fragment-then-complete-object: the last complete JSON object wins` | F4 shape: partial fragment first, then 2 concepts / 3 queries → `ok` with the complete object's content | none | whole-string `JSON.parse` or first-`{` scan → invalid; paste reason |
| P2 | `trailing prose after the last complete object is ignored` | object + `Hope that helps!` → `ok` | none | strict parse → `invalid`; paste |
| P3 | `an unterminated object is invalid, never throws` | `{"concepts":[{"name":"a","queries":["q1` → typed `invalid` | none | unguarded parse → thrown `SyntaxError` fails the test |
| P4 | `empty or whitespace-only output is invalid with reason empty` | `""`, `"   "` → `invalid`/`empty` | none | empty treated as `{concepts:[]}` → `ok`; paste |
| P5 | `missing concepts, non-array concepts, missing queries and non-string queries are invalid` | 4-row table: `{}`, `{"concepts":"x"}`, `{"concepts":[{"name":"a"}]}`, `{"concepts":[{"name":"a","queries":[1]}]}` | none | skip shape validation → each `ok`; paste the leaking row |
| P6 | `empty concepts and empty queries arrays are invalid` | `{"concepts":[]}`, queries `[]` → `invalid` | none | allow empty → `ok`; paste |
| P7 | `a query over 300 chars is invalid; exactly 300 is valid` | 301 → `invalid`/`query-too-long`; 300 → `ok` | none | remove cap → 301 `ok`; paste |
| P8 | `more than six queries across concepts is invalid; six is valid` | 4 concepts × 2 = 8 → invalid; 6 → ok | none | count per concept → 8 accepted; paste |
| P9 | `queries are trimmed and a whitespace-only query is invalid` | `"  q1  "` → `q1`; `"   "` → invalid | none | skip trim/emptiness → whitespace accepted; paste |
| P10 | `every malformed corpus entry returns a typed result, never throws` | 10 malformed strings; each has `.status ∈ {ok,invalid}`; a catch fails the test on throw | none | remove try/catch → test fails on the thrown entry |

### Package QP-CLIENT — `tests/query-pipeline/score-client.test.ts`

Fixtures from `score-fixtures.ts`: the measured B2 request/answer shape, plus synth 400/401/402/429/500, error-envelope, truncated-JSON, and a partial-answers body. Manual scheduler copied from `tests/decision-router/jev-client.test.ts` (no real timers).

| # | Exact test name | Asserts | Seam | Mutation → RED evidence |
|---|---|---|---|---|
| S1 | `frozen consts: batch 12, timeout 30000, attempts 3, endpoint and model defaults` | exact const values | none | change one in production → mismatch; paste |
| S2 | `25 candidates batch into 12/12/1 requests, each carrying only its own candidates` | 3 calls; question key sets `c0..c11`, `c12..c23`, `c24`; **same raw-prompt `state` in all three** | stub fetch | batch size 13 or single request → call count/key diff; paste |
| S3 | `12 candidates make one request; 13 make two` | boundary | stub fetch | `>` vs `>=` → 12 makes 2 calls; paste |
| S4 | `a server error retries on the injected scheduler and succeeds on attempt 2` | 2 calls, 1 armed timer, scores present | manual scheduler | retry without scheduler → `pendingCount()` 0; paste |
| S5 | `retry is capped at three attempts; a fourth is never sent` | 3 calls, then typed `server` error | manual scheduler | max attempts 5 → call count 5; paste |
| S6 | `auth, billing and misrouted-refusal make exactly one call` | 1 call each | stub fetch | retry every error → 3 calls; paste |
| S7 | `HTTP status maps to the frozen error-kind vocabulary` | 400→misrouted-refusal, 401→auth, 402→billing, 429→rate-limited, 500→server | stub fetch | map 402→server → wrong kind; paste |
| S8 | `429 arms the scheduler at the clamped Retry-After` | floor 60 s / pass-through / ceil 3600 s rows | manual scheduler | ignore header → default backoff; paste delay |
| S9 | `a never-resolving fetch settles to transport-timeout and aborts the signal` | typed timeout, **`init.signal.aborted === true`**, timers cleared | `never: true` + manual scheduler | resolve timeout without `controller.abort()` → `aborted` false; paste |
| S10 | `missing or blank key fails before any fetch and arms no timer` | `missing-key`, 0 calls, 0 timers | env record | fetch with `Bearer undefined` → 1 call; paste |
| S11 | `missing answers are null, never fabricated zeros` | 3 candidates, answers only for c0 → c1/c2 `null` | stub fetch | `?? 0` → 0 vs null; paste |
| S12 | `a 200 error envelope and a truncated body map to server/malformed, never throw` | typed errors | stub fetch | unguarded parse → throw; paste |
| S13 | `the request body is the frozen score wire shape` | top-level keys exactly `{model,state,questions}`; question keys exactly `{type,instructions,criteria}`; `type:"score"`; `instructions.candidate` keys `{path,kind,excerpt}`; `criteria` length 4; `state` is the raw prompt string | stub fetch | rename `candidate`, or criteria as object → key diff; paste |
| S14 | `one batch failing hard leaves the other batches' scores intact` | 13 candidates, batch 2 500×3 → batch 1 scores present, batch 2 null, one error | stub fetch + manual scheduler | fail whole pool on first batch error → empty scores; paste |
| S15 | `a 400 detail never echoes the response body` | `detail` excludes the marker string | stub fetch | echo body → marker present; paste |
| S16 | `a timeout on attempt 1 and success on attempt 2 leaves no armed timer and the first signal aborted` | `pendingCount()` 0 at end; first call's signal aborted | manual scheduler | skip `clearTimeout` → `pendingCount()` 1; paste |

### Package QP-RUNNER — `tests/query-pipeline/runner.test.ts`

Seams: `plan`, `search`, `score`, `progress`, `now`, `scheduler`, `budgetMs`, `plannerTimeoutMs` all injected; search calls gate on manual promises (no sleeps).

| # | Exact test name | Asserts | Seam | Mutation → RED evidence |
|---|---|---|---|---|
| R1 | `stage order is plan, search-per-query, score, merge` | recorded call log exactly `[plan, search:q1, search:q2, score, merge]` | all fakes | score before search → order log; paste |
| R2 | `search runs once per planned query, sequentially, and never for the raw prompt` | 2 calls with q1/q2; second starts only after first resolves | gated search fake | `Promise.all` over queries → second starts early; paste concurrency |
| R3 | `budget exceeded aborts the run and returns the fallback result, never a throw` | planner pending; fire budget timer → `{status:"fallback", reason:"budget"}`; planner signal aborted | manual scheduler | remove budget race → test times out or returns ok; paste |
| R4 | `the planner has its own hard timeout; search never starts after it` | plannerTimeout < budget; fire → `reason:"planner-timeout"`, 0 search calls | manual scheduler | use budget as planner timeout → search called/wrong reason; paste |
| R5 | `progress fires before each stage and clears to undefined in finally` | exact sequence incl. final `undefined`; ordering against the call log | progress spy | omit final clear → last entry not `undefined`; paste sequence |
| R6 | `a throwing progress callback never breaks the run` | progress throws → result still `ok` | progress spy | let the throw propagate → rejects; paste |
| R7 | `planner, search and merge throws return fallback; a score throw keeps hits with null scores` | 4-row table; score row returns `ok` with null scores after search produced candidates | all fakes | catch-all → fallback on score throw; paste status |
| R8 | `zero candidates skip scoring and return a no-hits fallback` | 0 score calls, typed reason | search fake | score empty pool → 1 call; paste |
| R9 | `per-search timeout is the remaining budget, not the full budget` | advance clock after plan; search timeout `< budgetMs` and ≈ budget − elapsed | mutable clock | pass `budgetMs` unchanged → timeout == budget; paste |
| R10 | `the planner receives the raw pre-expansion prompt` | `plan` called with the raw string, never the expanded one | plan spy | pass expanded → wrong string; paste |
| R11 | `the budget deadline is armed on the injected scheduler, not a real timer` | `pendingCount()` 1 while pending, 0 after settle | manual scheduler | real `setTimeout` → `pendingCount()` 0; paste |
| R12 | `the fallback reason names the failing stage` | planner-throw reason contains `planner`; search-throw `search`; merge-throw `merge` | all fakes | one generic reason → constant reason; paste |

### Package QP-EXT — `tests/query-pipeline/extension.test.ts`

Deps: `createScoreClient` factory spy returning `{scoreCandidates, warm}`, `plannerFn`, `env` record, `scheduler`, `now`. `createFakePi` + a `setStatus` recorder.

| # | Exact test name | Asserts | Seam | Mutation → RED evidence |
|---|---|---|---|---|
| E1 | `session_start issues exactly one warm call` | fire twice → `warm` count 1 | client factory spy | warm on every event → 2; paste |
| E2 | `a second session_start in the same session does not warm again; a new session warms again` | start → shutdown → start → 2 warm calls | factory spy | module-global once-forever flag → stays 1; paste |
| E3 | `a failing warm call is fail-open and does not block the next session_start` | `warm` rejects → handler resolves; second session warms again | rejecting fake | rethrow → handler rejects; paste |
| E4 | `PI_BADGER_QUERY_PIPELINE=0 suppresses the warm call, read per call` | env `0` set after factory init → 0 calls; unset → warm | env record | cache at load → warm happens; paste |
| E5 | `a missing OPENROUTER_API_KEY suppresses the warm call` | 0 calls, no error | env record | warm anyway → 1; paste |
| E6 | `the progress callback writes ctx.ui.setStatus with the frozen key and clears it in finally` | `[key,text]…` then `[key, undefined]` | `ctx.ui.setStatus` recorder | omit clear → last status not undefined; paste |
| E7 | `a registry streamSimple failure falls back to the injected HTTP planner` (FZ-5) | registry throws → `plannerFn` called; run still `ok` | fake registry + planner spy | remove fallback → 0 planner calls; paste |
| E8 | `env is read per call, not cached at factory load` | install without key, set key, `session_start` → warm | env record | cache key at load → 0 warm; paste |

### Package QP-INT — `tests/mem-based-rag/pipeline-routing.test.ts`

Install: `createFakePi()` + `factory(pi, {createClient: fakeRaccoon, pipeline: fakePipeline})`; `makeCtx` records `ui.setStatus`. No stdio, no real network; searches gated by held promises.

| # | Exact test name | Asserts | Seam | Mutation → RED evidence |
|---|---|---|---|---|
| I1 | `an enrichable turn routes through the injected pipeline and injects the merged block` | `pipeline.run` once; block contains the 5 pipeline paths in order and starts with the existing `Memory context` header; direct `memory_search` count 0 | `pipeline` fake | bypass pipeline → pipeline 0 / direct 1; paste |
| I2 | `two overlapping turns serialize their searches through the single-flight chain` | pipeline fake calls the injected `search` twice per turn; held promises → max concurrency 1; both turns get blocks | `pipeline` fake + real `searchCall` seam | pipeline calls `raccoon.call` directly → concurrency 2; paste |
| I3 | `pipeline fallback falls back to the single-query search and still injects` | `{status:"fallback"}` → exactly 1 `memory_search` with `decision.query`; block from those hits | `pipeline` fake | return undefined on fallback → message undefined; paste |
| I4 | `the kill switch disables routing; the single query runs and the pipeline is never called` | env `0` → pipeline 0 calls, 1 search | env + `pipeline` fake | ignore env → pipeline 1; paste |
| I5 | `a throwing pipeline never rejects the hook` | pipeline rejects asynchronously → hook resolves (message or undefined) | rejecting `pipeline` fake | remove try/catch → rejects; paste |
| I6 | `zero merged candidates skip as no-hits without injecting` | `ok` with `[]` → undefined, reason contains `no-hits` | `pipeline` fake | inject empty block → message defined; paste |
| I7 | `expanded mode expands exactly the merged hashes` | `memory_get`/`code_get` called only for merged hashes | `pipeline` fake + fake raccoon | expand first-5 raw pool → wrong hash set; paste |
| I8 | `status counters and lastReason reflect the pipeline run` | `/rag status` enriched 1; reason contains `pipeline` | `pipeline` fake | counters untouched → enriched 0; paste |

### Package QP-PUB — registration gate

| # | Gate | Asserts | Mutation → RED evidence |
|---|---|---|---|
| PUB1 | `bun run check` after `bun publish.ts` | exit 0, in sync | add the entry but do **not** install → `bun run check` exits 1 with `not installed: …/query-pipeline/index.ts`; then `bun publish.ts` → exit 0. Delete one destination file → exit 1 `not installed:`; reinstall → 0. Paste both runs |
| PUB2 | CI-mirror dependency install | `(cd extensions/query-pipeline && bun install --frozen-lockfile)` exit 0 | delete `bun.lock` → the frozen install fails; restore → 0. Paste |

## 3. Mutation checks

Protocol (per the `review-tests` convention — a mutation is run, never reasoned): for each row, apply the named one-line edit to production, run the narrowest gate from §5, paste the failing output, revert the edit, re-run green. A row reported without the pasted red is `unverified (static reasoning)` and does not count toward the package AC. `scripts/red_proof.py` may be used where present; otherwise a hand edit + two runs is the evidence format. The Mutation column in §2 is the authoritative list; this section fixes the evidence shape and the traps that make a row pass vacuously.

Load-bearing subset that must carry pasted red proof (all others may be one-line mutations in the same run): M4, M7, M9, M12; P1, P7, P8; S2, S5, S9, S11, S14; R2, R3, R5, R7, R9; E2, E4; I1, I2, I3.

Vacuity traps and the assertion that forbids each:

- **H-Q1 (merge fixtures):** one-chunk-per-document fixtures make path-dedup and backfill invisible. M4/M9 require ≥2 chunks on ≥1 document; M2 requires a 3-chunk document; M10 requires 6 distinct documents.
- **H-Q2 (merge scores):** all-equal scores make the sort row vacuous, all-distinct makes the tie row vacuous. M1 uses strictly distinct scores; M6 uses exact ties plus a distinct third; M7 uses a scored `0.0` against `null` (the only shape where `?? 0` changes the order).
- **H-Q3 (parser):** a corpus of only complete objects passes a naive parser. P1 must carry the F4 fragment-then-complete shape; P3 is a separate unterminated case.
- **H-Q4 (score client doubles):** a stub that always returns 200 makes retry/error rows vacuous. S4/S5/S6/S14 require explicit status transitions; S9 requires `never: true`; S10 asserts zero calls and zero timers.
- **H-Q5 (timer claims):** "no real timer" asserted by absence is weak. Every timer row asserts `scheduler.pendingCount()` exactly (0 or 1) at a named point, and `lastDelayMs()` where the delay is the contract.
- **H-Q6 (runner budget):** `budgetMs` of 0/1 or an immediately-resolving planner makes R3/R4 degenerate. Both use a pending planner plus the manual scheduler; R9 advances the injected clock by a non-zero amount before the plan resolves.
- **H-Q7 (integration single-flight):** injecting the whole pipeline proves routing, not serialization. I2's pipeline fake must call the hook-injected `search` seam, and the concurrency probe must gate with held promises — a sleep-based probe is rejected as evidence.
- **H-Q8 (integration fallback):** a synchronously-thrown pipeline error can pass without a catch if the hook never awaits it. I5's fake rejects asynchronously and the test awaits the hook's result.
- **H-Q9 (preload):** one `session_start` cannot distinguish once from always. E1 fires twice; E2 crosses a `session_shutdown`.
- **H-Q10 (never-throws table):** throws before the first await pass trivially. R7's rows reject after at least one stage boundary; the score row throws only after search returned candidates.

Behaviour-radius rule: each package asserts at least one secondary observable — M11 (entry score/kind), S9/S16 (aborted signal + timer count), R9/R12 (remaining timeout + stage-named reason), I8 (counters + reason), E2 (session-scoped idempotence), I2 (concurrency maximum).

## 4. What cannot be unit-tested, and the manual gates

Three claims are outside the harness. Each gets a manual gate with an exact procedure and a recorded outcome; none may be reported as passing without the record.

### MG-1 — Progress visibility during the blocking `before_agent_start` hook `[UNVERIFIED: A5/C2]`

The research could not verify from this repo whether `ctx.ui.setStatus` paints while the hook still awaits; the harness has no timer around handlers and Esc acts on the agent run, which has not started.

Steps:
1. Bank up (`ai-raccoon serve` reachable on 7721), extension published (`bun publish.ts`), `OPENROUTER_API_KEY` set, `PI_BADGER_MEM_RAG` unset.
2. Start `pi` in a project with the bank; confirm `/rag status` shows the child alive.
3. Send a skill prompt that passes the enrichment gate, e.g. `/skill:task explain the delegation timeout watchdog and how retries interact with the queue`.
4. While the hook blocks, capture the terminal at 5-second intervals (screenshots or a scripted recording).
5. Press Esc once mid-block; note whether anything aborts.
6. Record: first paint timestamp relative to hook start (yes/no), widget appearance, Esc effect, total block duration, and the exact status strings.

Decision rule: if `setStatus` never paints before resolution, the progress surface is reworked (e.g. `setWidget`, or a status set from the `input` handler) and the decision is recorded; the unit-level `setStatus` call assertions (E6) remain valid because they test calls, not pixels.

### MG-2 — Direct planner latency `[UNVERIFIED: F5 measured the agent-process shape only]`

Steps:
1. Run a standalone probe calling the chosen planner model with the C4 system+user prompt 5 times (direct `ctx.modelRegistry.streamSimple` shape, one run through a fresh pi session to confirm auth resolves).
2. Record per run: wall time, input/output tokens, cost, JSON validity, and whether a fragment preceded the complete object (F4 saw 1/4).
3. Record p50/p95 across runs and the cold-first-call penalty separately.
4. Set the planner timeout and pipeline budget defaults from p95 with headroom (recommended: planner timeout ≈ p95 × 1.5; budget ≈ planner timeout + N × search p95 + score), and write the numbers into the plan.

Decision rule: if the direct p95 is not materially below the 66–147 s delegated shape (F5), the pipeline cannot fit a turn and the design reopens before the budget rows are frozen.

### MG-3 — Real MCP end-to-end `[UNVERIFIED]`

Steps:
1. `ai-raccoon serve` up; published extension; run one enriched turn with `PI_BADGER_MEM_RAG_MODE=default`.
2. Capture `/rag status`, the injected block, and the ai-raccoon call log for the turn.
3. Check manually: five distinct display paths with no two entries from the same document (F10), queries match the planner plan, no `bank error` line, and the wall-clock breakdown per stage.
4. Repeat the same prompt with `PI_BADGER_QUERY_PIPELINE=0` for the baseline single-query block.
5. Record: query list, selected paths/hashes, per-stage latencies, token/cost, and a manual relevance skim of both blocks — noting F11/F14 (Jev scores are not independent labels; relevance bands overlap).

Decision rule: if real searches blow the frozen budget, tune the budget or the default query count; the numbers land in the plan's evidence file. Optionally also record the B4 preload effect (cold vs warm first score call; measured ~744 ms vs ~465–530 ms on the probe machine, ≈$0.00002/session) — a measurement, not a gate.

Also not unit-testable, measurement-only: planner query stability across repeats (F14), the mechanical-chunking baseline (F14), and whether preload persistence survives minute-scale gaps (B4 `[UNVERIFIED]`).

## 5. Gates

Iteration gates (one failing test at a time, per phase; run from the worktree root):

- QP-CORE: `bun test tests/query-pipeline/merge.test.ts` and `bun test tests/query-pipeline/planner-parser.test.ts`
- QP-CLIENT: `bun test tests/query-pipeline/score-client.test.ts`
- QP-RUNNER: `bun test tests/query-pipeline/runner.test.ts`
- QP-EXT: `bun test tests/query-pipeline/extension.test.ts`
- QP-INT: `bun test tests/mem-based-rag/pipeline-routing.test.ts`
- Existing-suite regression: `bun test tests/mem-based-rag/` — the current baseline is 131 pass / 0 fail / 7.87 s `[MEASURED: A7]`; after this work the same run must show the existing 131 unchanged plus the new file's rows, 0 fail.

Touched-surface run once before push (test economy: focused runs above, full suite left to CI): `bun test tests/query-pipeline/ tests/mem-based-rag/ tests/publish/`

Typecheck: `bunx tsc --noEmit -p .`

Publish / packaging: `(cd extensions/query-pipeline && bun install --frozen-lockfile)` then `bun publish.ts` then `bun run check` (= `bun publish.ts --check`).

Full suite locally only if CI is dead: `bun test`.

CI expectations (`.github/workflows/ci.yml`): `bun install --frozen-lockfile`; per-extension `bun install --frozen-lockfile` (so the new extension's `bun.lock` must be committed); `bun test` exit 0, 0 fail; `bunx tsc --noEmit -p .` exit 0. `bun run check` is deliberately local-only (CI's user scope is empty) — do not expect it in CI.

How each gate is watched red: every focused gate is reddened by applying its row's mutation (§2) and running it; the typecheck gate is reddened by a deliberate type-break mutation (e.g. rename an exported symbol without updating the import); the publish gate is reddened by adding the `EXTENSION_DIRS` entry and running `bun run check` before installing (`not installed:`), and by deleting a destination file after installing; the CI-mirror gate is reddened by deleting the new extension's `bun.lock`. A gate never watched red is not evidence.

## 6. Acceptance criteria

Per package:

- **QP-CORE AC:** M1–M12 and P1–P10 green in their focused gates; each row's mutation applied, run, reverted with pasted red; pure files import nothing from pi, fetch, or the clock; parser never throws across the malformed corpus.
- **QP-CLIENT AC:** S1–S16 green; zero real network, zero real timers (all timer rows assert the manual scheduler's pending count and delay); error vocabulary identical to the frozen client's list; the wire-shape row asserts exact key sets.
- **QP-RUNNER AC:** R1–R12 green; no test observes real elapsed time; budget/planner-timeout rows complete deterministically via the manual scheduler; the never-throws table covers planner, search, score, and merge failures.
- **QP-EXT AC:** E1–E8 green; preload is session-scoped once, fail-open, kill-switchable, and key-gated; progress clears in `finally`; env is read per call.
- **QP-INT AC:** I1–I8 green; `bun test tests/mem-based-rag/` shows the pre-existing 131 pass unchanged plus the new rows, 0 fail; no existing test file edited; no stdio child and no real network in the file.
- **QP-PUB AC:** the entry is in `EXTENSION_DIRS`; `bun publish.ts` then `bun run check` exit 0; `bun install --frozen-lockfile` in the new extension dir exits 0 with a committed lockfile.

Plan-level AC: all six package ACs checked and met; the touched-surface run, typecheck, and publish check green; CI green on the PR (`bun test` + typecheck); freeze items FZ-1–FZ-7 resolved and recorded before their dependent rows were written; manual gates MG-1, MG-2, MG-3 each executed with the named record (MG-1 may validly return "status invisible" — that reopens the progress design, it is not a test failure); every mutation row carries applied/run/reverted evidence or is labelled `unverified (static reasoning)` and excluded from the count.