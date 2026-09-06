# Research: ai-raccoon as prompt-enriching RAG in a pi extension

**Date:** 2026-09-06
**Question:** Can ai-raccoon memory_search serve as a prompt-enriching RAG inside a pi extension without replacing agent memory, and what would it cost and gain?

```chart:matrix
title: injection point options
, latency cost, prompt fidelity, fail-open ease
input-transform, 1, 2, 2
before_agent_start-inject, 2, 4, 4
context-event-append, 3, 3, 3
```

```chart:range
title: transform step ms, 3 runs (canned envelope)
transform: 0.026..0.031..0.037
```

## Findings

### F1 — memory_search returns hits even for no-context prompts, so filtering is mandatory not optional [MEASURED]

Query `stop` against the project bank returned 5 memory + 5 code hits (top memory hit fusionStrength 1.0, both legs rank 1, cosine 0.59) — all lexically matched but semantically useless for a control command. Any extension that searches unconditionally will inject noise on exactly the prompts where latency hurts most.

**Evidence:** `mcp_ai-raccoon_memory_search` run 2026-09-06 on this machine via the pi session, projectId `50a8bb05-4ba6-4002-94be-f8988ecc3b58`, session `research-rag-001`, queries `using ai-raccoon as a RAG prompt augmentation extension with filtering` and `stop`, limit 5; both returned full 5+5 envelopes with `evidenceByHash`/`fusionStats`/`meta` attached.

### F2 — The bank under test is small (22 entries, 0 pending), so relevance observations do not generalise to large banks [MEASURED]

Stats reported 22 entries across `shared`, `project:pi-badger-integration`, and four custom contexts, with 0 deferred embeddings. Snippet quality and fusion margins measured here (topMargin 0.0025 on the RAG query, 0.127 on `stop`) describe a 22-entry bank, not a production-scale one.

**Evidence:** `mcp_ai-raccoon_memory_stats` run 2026-09-06 on this machine, same projectId; `entries:22, pending:0`, contexts listed verbatim in the tool result.

### F3 — The strip-and-shape transform costs microseconds and cuts the envelope to roughly one third [MEASURED]

The throwaway script (`/tmp/rag-augment-demo.py`, python3 on Darwin 25.6.0, MacBook-Air) builds `augmented_prompt = prompt + Context:{retrieval}` from a canned live envelope: transform step 0.026/0.026/0.037 ms across three consecutive runs, raw 1400 chars → context block 532 chars (strip ratio 0.38), full demo output 2078 bytes. The dropped fields are `evidenceByHash`, `fusionStats`, `meta` — all retrieval telemetry, none of it prompt-usable.

**Evidence:** `/usr/bin/time -p python3 /tmp/rag-augment-demo.py` three runs 2026-09-06 (real 0.02/0.02/0.01 s, user 0.01 s each); in-script `transform_ms` 0.026, 0.026, 0.037; `wc -c /tmp/rag-run-1.txt` = 2078 bytes.

### F4 — The seven-case filter matrix behaves as specified, with ordering load-bearing [MEASURED]

After fixing check order (bare-skill and command gates before the 20-char length gate), the script reports: ENRICH on the full IDEA prompt and on `/skill:task extend timeout to 10m because CI is slow`; SKIP as `command/no-context-needed` on `stop`, `continue`, `/delegations`; SKIP as `bare skill call without extension text` on `/skill:task`; SKIP as `too-short` on `hi`. Before the fix `/skill:task` (11 chars) misreported as `too-short` — the wrong reason, same verdict, which is exactly how a filter rots unnoticed.

**Evidence:** `python3 /tmp/rag-augment-demo.py` run 2026-09-06 on this machine; FILTER MATRIX section output quoted verbatim; the ordering fix is the single `edit` to `/tmp/rag-augment-demo.py` moving `SKILL_RE`/command checks above the length gate.

### F5 — pi can rewrite user input before skill expansion and can inject context before the agent loop [READ]

The `input` event fires after extension commands but before skill/template expansion and supports `{action:"transform", text}` chaining across handlers; `before_agent_start` supports injecting a persistent message plus replacing the chained system prompt for the turn. The documented processing order is: extension commands → `input` → skill expansion → template expansion → `before_agent_start` → agent loop.

**Evidence:** `docs/extensions.md` sections `### Input Events` (`input` results `continue`/`transform`/`handled`, processing order 1–5) and `#### before_agent_start` (`message` + `systemPrompt` return shape); corroborated in-repo by `extensions/session-signals/index.ts` (`pi.on("input", …)` returning `{action:"continue"}` with marker parsing).

### F6 — The raw memory_search envelope is dominated by non-prompt fields the extension must strip [READ]

Every MCP tool result is an `ApiEnvelope` serialized as JSON text; the card renderer keys on the bare tool name and the `memory_search` descriptor treats missing keys as unknown (falls back) versus empty-but-present arrays as true no-hits. Live envelopes carry `results[]`, `code[]`, `evidenceByHash{}`, `fusionStats{}`, and `meta{}` — only the first two (path + snippet + rank) belong in a prompt; `correlationId`, leg ranks, cosine, and capacity counters are agent/ops telemetry.

**Evidence:** `extensions/pi-mcp-tools/McpCardRenderers.ts:memory_search` entry (`summarize`/`describeCall`) and `extractCardData`/`collapsedMcpCard`; live `memory_search` responses in F1 showing `evidenceByHash`, `fusionStats`, `meta.waitingPromotionsCount/correlationId`.

### F7 — A full hit is ~1 KB while its snippet is ~100 chars, so snippet-only context is the correct budget [READ]

`memory_get` on the top RAG-query hit (`2243509d…`) returned a `value` of roughly one kilobyte (the D4 admit-with-veto decision text) versus the ~120-char snippet served in the search response. Fetching full values per hit inside the input path would multiply prompt cost per hit by ~8× and add one MCP round-trip per hit; snippet-only with hash citations (full fetch left to the agent) is the shape the existing card KM already assumes.

**Evidence:** `mcp_ai-raccoon_memory_get` run 2026-09-06, hash `2243509d9d09e73d798b403362725de406057aa0497b73d66f4c60d0b8845be6`, same projectId — `value` is the multi-paragraph D4 text vs the one-line `snippet` in F1's search result.

### F8 — The realistic gain is narrow but real, and the architecture that captures it is a fail-open pre-agent filter+inject [INFERRED]

Reasoning from F1–F7: the win is not "smarter answers everywhere" but "fewer cold-start turns on context-heavy prompts" (project conventions, ADRs, prior decisions the model would otherwise ask about or hallucinate). Expected shape: `input`-event filter (F4 rules + marker-awareness) → async `memory_search` with top-k 3+2, snippet cap ~300 chars, cosine/min-relative-score floor → `before_agent_start` injection as a labelled `Context:` block with source paths, never a silent prompt rewrite → hard budget (timeout ~2–5 s, char cap ~1.5 KB, kill-switch env, never in `print`/`json` blocking paths) → memory path untouched (same MCP server, separate call site; agent keeps its own `memory_search` tool). Costs are per-turn latency on enriched prompts, ~0.5–1.5 KB of context on every enriched turn, and a new noise-injection surface whenever retrieval is thin (F1's flat-margin signature: topMargin 0.0025 + single-leg-equivalent agreement). Net: worth building as an experiment behind a flag, not as default-on.

### F9 — Extension-injected context will be mistaken for user intent unless it is labelled and separable [INFERRED]

Reasoning from F5 (transform chains across handlers; `before_agent_start` messages persist in-session) and the session-signals marker contract: an `input`-transform rewrite permanently alters what later handlers and skill expansion see, while a `before_agent_start` injected message is attributable and skippable. So the RAG block must go through injection with a `Source: ai-raccoon memory_search` header and hash/path citations, never through silent prompt rewriting — otherwise `/skill:task <text>` routing, marker parsing (`f!:`, `q!:`), and audit (`session_shutdown` logs) all see a prompt the user never typed.

### F10 — End-to-end added latency and answer-quality delta were not measured [UNVERIFIED]

Only the local transform was timed (F3); no MCP round-trip timing under input-path conditions, no A/B on answer quality, no Windows or headless-mode verification. What would settle it: a behind-flag prototype logging per-turn search ms, enriched/skipped counts with reasons, context chars injected, and a small graded task set (cold-start questions with/without enrichment).

## Still open

- What score floor (cosine / minRelativeScore / fusionStrength) marks "thin, skip injection" for this bank? F1 shows thin responses exist but gives no calibrated threshold — needs a sweep over real prompts.
- Should `code` hits be included by default? F7's size argument says snippets-only, but code snippets without surrounding lines may mislead more than memory prose does.
- Where does the projectId come from in a multi-project session (cwd walk vs `AI_BADGER_PROJECT_ID`)? The message-bus extension resolves it via cwd-walk with env override — the RAG extension needs the same rule, unmeasured here.
- Does enrichment belong on `input` (transform) or `before_agent_start` (inject) when both are available? F9 argues inject; a prototype should try inject-first and keep transform only for the skip decision.
- Throwaway script lives at `/tmp/rag-augment-demo.py` (outside the repo by design); promoting any of it means rewriting as a proper extension with tests, not copying the file.
