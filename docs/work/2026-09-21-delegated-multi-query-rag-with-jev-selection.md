# Research: delegate-planned multi-query retrieval with Jev selection for long prompts

**Date:** 2026-09-21
**Question:** For prompts at or beyond ai-raccoon's effective query-embedding window, does a delegate-generated multi-query retrieval pass with Jev-scored selection surface more useful context entries than the current single full-prompt query?

```chart:range
title: pipeline step latency, seconds (one measured run per prompt unless noted)
delegated planner, T1-T3 (3 parallel runs): 65.6..65.7..65.8
delegated planner, T4 (1 run): 146.8..146.8..146.8
searches T1 (6, sequential): 5.6..7.9..11.2
searches T2 (5, sequential): 3.7..5.6..7.4
searches T3 (6, sequential): 1.7..2.6..6.1
searches T4 (4, sequential): 1.7..1.7..1.9
```

```chart:matrix
title: mean Jev score of the selected top 5 (0-3 scale, path-level dedup in every column)
, baseline top5 by server rank, baseline pool reranked by Jev, pipeline top5 by Jev, union ceiling
t1 multi-concept (426 tok), 0.98, 1.21, 1.49, 1.49
t2 long-tail (374 tok), 0.45, 1.36, 1.94, 1.94
t3 hooks, thin coverage (317 tok), 0.11, 0.51, 1.27, 1.30
t4 over-window (619 tok), 0.93, 1.27, 1.85, 1.95
```

## Method

Four prompts, each a realistic multi-paragraph request written against this repo. Three sit
under this machine's real query window (T1 426 tokens, T2 374, T3 317); one, T4, is over it
(619 tokens, 2,959 chars) with its actual ask ("parallel agents stepping on each other in the
shared checkout; give each its own repository copy, main read-only, integrate by PR") buried in
the final paragraph, past the window boundary.

- **Baseline arm:** one `memory_search` on the full prompt, limit 10 per section — what
  `mem-based-rag` does today, except today's extension sends limit 5.
- **Pipeline arm:** delegate the prompt to the `delegator` persona with a planner instruction
  (concept-grouped queries, 2-6 total, each ≤300 chars); run one `memory_search` per query at
  limit 5; merge and dedupe; score every candidate with Jev (`typesafe/jev-1.13` via
  OpenRouter `/api/alpha/decisions`, `score` question, levels 0 unrelated .. 3 directly
  answers); take the top 5.
- Both arms' candidates were merged and scored in the same Jev calls, so no arm is judged on a
  different scale. The harness lives in `/tmp/rag-multiquery/` (`collect.ts`, `jev.ts`,
  `evaluate.ts`, `analyze.ts`, `truncation-probe.ts`); it is ephemeral, every number below is
  reproduced here.

## Findings

### F1 — The query-embedding window that matters on this machine is 510 content tokens, not 254 [READ]

`OnnxEmbeddingGenerator.MaxContentTokens = 254` is the bundled default model's window, and
`QueryLengthGuard` still warns past 1,000 characters with "roughly the first 254 tokens". But
this machine runs a manifest model (SFR-Embedding-Code-400M_R, 8,190-token context), and for
manifest models the query trim uses `ManifestContentBudget = min(MaxManifestChunkTokens,
contextWindowTokens − SpecialTokenReservation)` = `min(512 − 2, 8190 − 2)` = **510 tokens**.
The 1,000-character warning is therefore stale here by a factor of two in chars; the log's own
history shows the switch (254 on 2026-08-22, 510 on 2026-08-28).

**Evidence:** `~/RiderProjects/ai-raccoon/src/AiRaccoon.Infrastructure/Embedding/EmbeddingService.cs:47-49,140-157,400-415`; `src/AiRaccoon.Infrastructure/Embedding/EngineDescriptor.cs:32`; `~/.ai-raccoon/models/Salesforce__SFR-Embedding-Code-400M_R/ai-raccoon.manifest.json` (`contextWindowTokens: 8190`); `ai-raccoon doctor` shows that model on both engines; historical warnings in `~/.ai-raccoon/quiet.log` ("1120 tokens exceeded the 254-token window" on 2026-08-22; "1404 tokens exceeded the 510-token window" on 2026-08-28). The 254-vs-1000 warning lives at `src/AiRaccoon.Core/Memory/QueryGuard/QueryLengthGuard.cs:10-38`.

### F2 — The 619-token test prompt was trimmed by 109 tokens before vector embedding, and the bank recorded the trim [MEASURED]

Counting the T4 prompt with the model's own WordPiece vocab gives 619 tokens; the trim boundary
falls at character 2,423 of 2,959, so the final 536 characters — the entire worktree-isolation
ask — never reach the query embedding. The bank's own metrics table confirms the trim happened:
rows named `search.query.truncated_tokens` record value 109 (tokens over the 510 window) at
22:54:06, 22:55:14, 22:57:18 and 22:58:17 on 2026-09-21, and value 810 for the deliberately huge
control query. FTS still searches the full query text, so this is a vector-leg-only loss.

**Evidence:** token count via `BertWordPieceTokenizer` on `~/.ai-raccoon/models/Salesforce__SFR-Embedding-Code-400M_R/vocab.txt` (script `/tmp/rag-multiquery/tokenize.py`); `sqlite3 ~/.ai-raccoon/memory.db "select rowid,value,datetime(recorded_at,'unixepoch','localtime') from metrics where name='search.query.truncated_tokens'"` — my two T4 full-prompt probes and the T4 pipeline baseline are among those 109-excess rows; the 810 row at 22:56:10 matches the 1,322-token control query (`bun run /tmp/rag-multiquery/trim-probe.ts`, 6,660 chars). The metric is bank-wide, so not every row in that window is attributable to this test. Warning text and the full-text FTS carve-out: `EmbeddingService.cs:441-446`.

### F3 — On the one over-window prompt, the trim did not cause a hard retrieval miss [MEASURED]

The buried ask's target chunk (the "worktree pattern for main ops; never git push" chunk of
`docs/work/2026-09-02-queue-admission-monitors-results-snapshot.md`) still surfaced from the
full 619-token prompt, with the vector leg ranking it #8 — worse than the tail-only query
(vector #4) but present. The visible half of the prompt talks about delegation, monitoring and
session work, which is thematically adjacent enough that the truncated embedding still reached
the document. This is an honest negative on the strongest form of the truncation hypothesis:
one prompt, and the target topic's vocabulary was already in the visible half.

**Evidence:** `/tmp/rag-multiquery/truncation-probe.ts`, two runs. Full prompt: target hash `47327752…` rank 0.938, legs vector#8/fts#46, cosine 0.588. Tail-text query: rank 0.984, vector#4/fts#7, cosine 0.561. Keyword-free paraphrase: rank 0.851, vector#9/fts#19, cosine 0.535. Limit 20/10/10, kind memory.

### F4 — A delegated subagent produced usable concept-grouped queries on all four runs [MEASURED]

Four `delegate` calls (persona `delegator`) returned parseable JSON each time: 11 concepts and
21 queries total, 2-6 queries per prompt, longest query 135 characters — comfortably inside the
window. Query quality tracked the prompt: T4's plan found `worktree-agent-isolation parallel
agents separate git worktree checkout branch cut from origin main` and `no-shared-checkout rule
read-only main checkout PR-only integration parallel sessions`. One run (T2) emitted a partial
JSON fragment before the complete object; the harness read the last complete object, but a
production parser must not assume single-object output.

**Evidence:** outputs captured from the `delegate` tool and stored in `/tmp/rag-multiquery/plans/*.json`; run argv and transcripts in `~/.pi/agent/subagent-logs/d-1352.jsonl`, `d-1353.jsonl`, `d-1354.jsonl`, `d-1359.jsonl` (log files are shared across sessions and append, so the planner segment is the one whose task text starts "You are a retrieval-query planner"). Query lengths counted in `/tmp/rag-multiquery/plans`.

### F5 — Delegated planning cost 66 seconds for three parallel runs and 147 seconds for a single run [MEASURED]

T1-T3 planners ran concurrently and each finished in ~66 s wall-clock; T4's planner, launched
alone later, took 147 s. That is 1.1-2.4 minutes of added latency per enriched turn before a
single search runs. The three parallel runs cost $0.0023-$0.0025 each (21.4-21.6k input tokens,
no cache); T4's longer run cost $0.0010 because 21.1k of its input came from cache. One run
each; no repeats, no cold-start isolation.

**Evidence:** `startedAt`/`endedAt` and final `usage` from the `run`/`exit` records in
`~/.pi/agent/subagent-logs/d-1352.jsonl` (65.8 s, $0.002474), `d-1353.jsonl` (65.6 s,
$0.002394), `d-1354.jsonl` (65.7 s, $0.002334), `d-1359.jsonl` (146.8 s, $0.001044), parsed
2026-09-21; the d-1353 delegation followUp reported the same run as 1m06s, ↑21.4k ↓1.3k,
$0.0024.

### F6 — Retrieval added 7-49 seconds per prompt across 4-6 searches [MEASURED]

Sequential per-query searches (single-flight, as the extension would do) cost: T1 6 searches,
5.6/7.9/11.2 s min/median/max (48.8 s total); T2 5 searches, 3.7/5.6/7.4 (28.1 s); T3 6
searches, 1.7/2.6/6.1 (20.6 s); T4 4 searches, 1.7/1.7/1.9 (7.0 s). Early searches in a session
pay a warm-up; the first harness search took 14 s cold. These overlap nothing — the pipeline as
drawn is additive.

**Evidence:** per-search latencies recorded in `/tmp/rag-multiquery/results/*.json` (`pipeline.searches[].latencyMs`), summarized from `/tmp/rag-multiquery/collect.log` and `collect-t4.log`; `mcp_ai-raccoon_memory_performance` for the session showed `memory_search` p50 6.7 s, p95 46.2 s over 31 calls in the test window.

### F7 — Jev scored both arms' entire candidate pools for $0.0014 [MEASURED]

13 batched decisions calls, 34,073 input tokens, $0.001431 total — about a tenth of a cent per
prompt. Planning cost ~6× more ($0.0082 across four delegated runs, F5), and both are noise
against the latency: cost is not the constraint here, orchestration is.

**Evidence:** `usage` arrays in `/tmp/rag-multiquery/eval/*.eval.json`, produced by `/tmp/rag-multiquery/jev.ts` calling `https://openrouter.ai/api/alpha/decisions` with `typesafe/jev-1.13`, 3-4 calls of ≤12 candidates per prompt, 2026-09-21.

### F8 — The pipeline's top-5 outscored today's baseline top-5 on all four prompts [MEASURED]

On the 0-3 Jev scale, path-deduped: T1 0.98 → 1.49, T2 0.45 → 1.94, T3 0.11 → 1.27, T4 0.93 →
1.85. The scores are Jev's own assignment, and both arms' candidates were judged in the same
calls; the scorer is not independent (see F11). Manual spot-checks of the selected paths
confirmed the T1, T2 and T4 top-5 entries are on-topic; T3's are not (F11).

**Evidence:** `/tmp/rag-multiquery/evaluate.ts` and `analyze.ts` over `/tmp/rag-multiquery/results/*.json`; matrix chart above; per-prompt selections in `/tmp/rag-multiquery/eval/*.eval.json`.

### F9 — The win is mostly retrieval: Jev reranking of the baseline's own pool closed only part of the gap [MEASURED]

Reranking just the baseline pool with Jev takes T1 1.21, T2 1.36, T3 0.51, T4 1.27 — better
than the baseline's own ranking everywhere, still below the pipeline in all four. In three of
four prompts no document scoring ≥1.5 was unique to the baseline pool; only T4 had one
(`2026-deepseek-default-delegation.plan-review-pbi.md`, 1.63). Multi-query retrieval found
material the single query never returned; selection alone would not have.

**Evidence:** "high-score (>=1.5) docs baseline-only" and the baseline-pool rerank lines in `/tmp/rag-multiquery/analyze.log`; candidate provenance in `/tmp/rag-multiquery/eval/*.eval.json` (`baseline` flag, `concepts` array).

### F10 — Chunk-level identity wastes slots and makes Jev scores per-chunk, not per-document [MEASURED]

The raw T1 pipeline top-5 spent four slots on two documents
(`2026-09-01-monitor-queue-delegation-research.md` at 1.55 and 1.31; the Jev research doc at 1.55
and 1.30) because different chunks carry different hashes. Path-level dedup costs ~0.03 mean
score in T1 but fills the block with distinct documents. Related: two chunks of the same
mem-based-rag spec scored 0.05 and 1.77 against the same T3 prompt, so a score is evidence
about the injected excerpt, not about the document. The current extension dedupes by
hash/snippet only (`extensions/mem-based-rag/rag-core.ts:178-205`). Two selected entries were
shared-context promotions whose display path is a bare hash (`shared/<hash>.md`), a rendering
problem for the injected block.

**Evidence:** raw vs path-deduped selections in `/tmp/rag-multiquery/evaluate.log` and `analyze.log`; chunk-level scores for the same paths in `/tmp/rag-multiquery/eval/t3-hooks.eval.json`; `shared/95feb112…md` and `shared/b2fcca…md` rows in `eval/t1-multi-concept.eval.json` and `eval/t4-over-window.eval.json`.

### F11 — With thin bank coverage, Jev still returns partial scores for structurally similar but wrong documents [MEASURED]

T3 asked how the commit-reminder and test-economy hooks decide to fire. The bank has no
dedicated material for those hooks: a direct search for the topic top-ranked `update-integrations`
and queue-admission docs. From that weak pool, Jev's top picks were a chunk of the P5 bus-identity
spike describing a tool_call command matcher (1.86) and a chunk of the mem-based-rag spec about
session reset (1.77). Neither document mentions commit-reminder or test-economy at all; they
match the *shape* of the question (command matching, per-session counters). Jev cannot say "the
pool contains no answer" — it grades the best structural match. Selection quality is bounded by
pool coverage, and a score floor would not have caught this.

**Evidence:** selections and snippets in `/tmp/rag-multiquery/evaluate.log` (T3) and `eval/t3-hooks.eval.json`; `grep -c -i "commit.reminder\|test.economy" docs/work/2026-09-08-pbi-bus-identity-p5-spike.md` = 0; direct `memory_search` for the topic returned `docs/howto/update-integrations.md` first (2026-09-21).

### F12 — As tested, this pipeline cannot fit the extension's per-turn budget [INFERRED]

Reasoning from F5 (66-147 s planning), F6 (7-49 s searching), F7 (scoring) and the existing
contract — `before_agent_start` is a blocking hook with an 8,000 ms search timeout
(`docs/plans/2026-09-06-mem-based-rag-spec.md` §6, §7; wiring at
`extensions/mem-based-rag/index.ts:683-761`): the planner alone is 8-18× the whole current
budget. Viable shapes would be a much cheaper planner call (one direct model call, not a full
agent process), a background/prefetch execution model, or running the pipeline only on explicit
commands like `/ask`. The tested shape is a research instrument, not a drop-in hook.

### F13 — The planner was a full agent process on a different model that made no tool calls [MEASURED]

The delegated children ran with argv `pi -p --mode json --no-session --exclude-tools
delegate,delegations,queue,monitor,wait --model openrouter/meta/muse-spark-1.3-contributor
--append-system-prompt <delegator persona> -- <planner prompt>`. No tool events appear in the
T4 planner segment, so the 147 s is model/agent latency, not file reading. The planner therefore
does not need tools or project context — a narrower, cheaper call site is open.

**Evidence:** `argv` in `~/.pi/agent/subagent-logs/d-1353.jsonl` and `d-1359.jsonl`; event-type count for the d-1359 planner segment (`message_*`, no `tool*`), parsed 2026-09-21.

### F14 — Query stability across repeats and a mechanical chunking baseline are untested [UNVERIFIED]

Each prompt was planned once; nothing here says the same prompt yields the same concepts twice,
or that a trivial split into paragraph-sized queries (no LLM) would not capture most of the win.
No labels exist for these prompts, so "better" above means "Jev-scored higher", not
"human-judged more useful" — the independent check was a manual skim of selected paths, not a
fixture set.

## Still open

- **Stability and recall of the planner.** Repeat each prompt N times and compare concept sets and
  query overlap; needs a target list per prompt to measure recall rather than eyeballing.
- **A mechanical chunking baseline.** Split the long prompt into ≤400-token paragraph queries and
  run the same merge/score; if it lands near the delegate's mean, most of the latency is avoidable.
- **Independent relevance labels.** Jev selected and judged; a hand-labelled fixture set (which
  bank entries genuinely answer each prompt) would settle the actual win and calibrate Jev's
  ranges here (observed: relevant ≈ 1.5-2.4, structural noise ≈ 1.2-1.9 — overlapping).
- **Scoring on full values.** Scoring used 300-char snippets; whether `memory_get` values change
  selection (and at what added latency) is open.
- **Hook-time feasibility.** Whether a nested delegation from inside `before_agent_start` queues,
  deadlocks, or merely delays was not tested — planners here were delegated from the top-level
  session, not from a hook.
- **Bank coverage for hook topics.** The commit-reminder and test-economy skills live in
  `.ai-badger/skills/` and the hooks themselves in the framework; whether the ingest scope should
  include them (or the framework repo) is a coverage decision this test surfaced, not answered.
- **The stale 254-token warning.** `QueryLengthGuard` tells users a 1,000-char query is over the
  window; on this machine it is not. Either the guidance should follow the configured model or the
  constant should be re-derived from the engine descriptor.
