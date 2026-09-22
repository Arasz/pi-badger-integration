# query-pipeline

Delegate-planned multi-query retrieval for the ai-raccoon bank, consumed by the
`mem-based-rag` extension.

**Flow:** `group` (concept-grouped queries planned with the delegator persona via
a direct model call) → `split` (one `memory_search` per query, sequential,
single-flight through mem-based-rag's `searchCall`) → `rank` (Jev `score`
questions, batched) → `merge` (5 slots total: best chunk per distinct document
first; when fewer than five documents match, the remaining slots backfill with
the next-best chunks of the already-included documents) → the bank's
`memory_search` envelope, which mem-based-rag parses, prunes and injects exactly
as before.

## Install

Ships with `bun publish.ts` (user scope: `~/.pi/agent/extensions/query-pipeline/`).
`mem-based-rag` statically imports `../query-pipeline/pipeline.ts`, so the two
directories must be installed together — the publish flow installs all owned
directories in one run. Installing `mem-based-rag` alone fails at extension load
(same precedent as `monitor → subagent` and `decision-router → router-fallback`).

The extension's own `index.ts` registers exactly two hooks: a gated,
session-scoped, fail-open Jev warm call on `session_start` (one tiny score call,
≈$0.00002/session, to pay the measured cold-first-call penalty) and a
`session_shutdown` reset that clears the pinned status/widget keys.

## Environment

| Name | Default | Clamp | Role |
|---|---|---|---|
| `PI_BADGER_QUERY_PIPELINE` | enabled | literal `"0"` disables | Kill switch, checked at the mem-based-rag call site (falls back to today's single search) and by the preload. This is the only off switch — disabling the extension directory is not one, because mem-based-rag imports it statically. |
| `PI_BADGER_QUERY_PIPELINE_TOTAL_MS` | 90000 | 5000–300000 | Whole-run deadline. Exceeded → partial/fallback envelope, never a throw. |
| `PI_BADGER_QUERY_PIPELINE_PLANNER_MS` | 15000 | 1000–60000 | Planner hard cap. Never consumes the search window. |
| `PI_BADGER_QUERY_PIPELINE_SEARCH_MS` | 15000 | 500–60000 | Per-search cap. |
| `PI_BADGER_QUERY_PIPELINE_SCORE_MS` | 8000 | 1000–60000 | Scoring stage cap and search-phase reserve. |
| `PI_BADGER_QUERY_PIPELINE_SEARCH_LIMIT` | 5 | 1–20 | `limit` sent to each `memory_search`. |
| `PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` | unset → the session model | — | `provider/model` reference resolved through `ctx.modelRegistry.find`. A value with no `/` is a typed `no-model` fallback. |
| `PI_BADGER_JEV_SCORE_TIMEOUT_MS` | 15000 | 1000–120000 | Per scoring attempt (shared name with the decision-router contract). |
| `PI_BADGER_JEV_ENDPOINT` | `https://openrouter.ai/api/alpha/decisions` | — | Shared with decision-router. |
| `PI_BADGER_JEV_MODEL` | `typesafe/jev-1.13` | — | Shared with decision-router. |
| `OPENROUTER_API_KEY` | — | — | Jev scoring and the preload. Missing → scoring is skipped (candidates merge by server rank) and no warm call is made. |

## Failure behaviour

`retrieve` never rejects. A planner failure, timeout, empty or invalid plan, an
empty candidate pool, a failed search, or an exhausted budget degrades to a
single `memory_search` on the caller query (today's enrichment) — or to an empty
envelope, which mem-based-rag reports as `no-hits`. A dead bank surfaces through
the pipeline's `search-error` reason, which mem-based-rag rethrows into its
existing `bank error` skip path so diagnostics survive.

## Data egress

The pipeline sends data off the machine, which the previous single-search path
did not:

- the caller query (the `/skill:<id>`-stripped prompt) is sent to the planner
  model provider;
- the caller query plus up to 500 characters of each candidate excerpt is sent
  to OpenRouter for Jev scoring.

Set `PI_BADGER_QUERY_PIPELINE=0` to keep everything local.

## Modules

| File | Role |
|---|---|
| `types.ts` | Frozen seam: stage/progress/result types, env names, clamp helper. Imports nothing. |
| `merge.ts` | Pure `docKey` / comparator / `dedupePool` (per kind, `pruneHits` parity) / `mergeSelect`. Imports nothing. |
| `planner.ts` | Pure planner half: the delegator-persona system prompt, the measured user prompt, `parsePlan` (last-complete-JSON-object, shape-validated). Imports nothing. |
| `planner-call.ts` | `createRegistryPlanner` over `ctx.modelRegistry.complete` (pi 0.84.4 exposes `complete`, not `streamSimple`); every failure is a typed fallback. |
| `jev-client.ts` | Minimal Jev `score` client, copy-by-contract from `decision-router-client.ts`; injected fetch/scheduler/env; `warmJevScore`. |
| `pipeline.ts` | The import seam: `createQueryPipeline` → `{retrieve, retrieveResult}`, plus `runPipeline`, `toEnvelope`, `formatProgress`, `resolvePipelineBudget`. |
| `index.ts` | Extension wiring: `session_start` preload, `session_shutdown` reset/clear. |

## Tests

`bun test tests/query-pipeline/` — pure-core rows, score-client rows, planner
adapter rows, runner rows (manual scheduler + injected clock; no real timers,
network or stdio), and the extension-wiring rows. `bun test tests/publish/`
pins the registry membership.
