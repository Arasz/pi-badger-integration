# Research: query-pipeline v1 — delegate-planned multi-query retrieval inside the RAG hook

**Date:** 2026-09-22
**Task:** `pbi-multi-query-rag-pipeline-v1` (high-effort)
**Question:** What exactly must be built so that a new `query-pipeline` extension can plan concept-grouped queries (delegator persona, direct model call), search the ai-raccoon bank per query, score candidates with Jev, and merge them into the existing mem-based-rag injection — with a visible TUI progress indicator, a Jev preload at session start, and a timeout policy that does not kill the turn?

**Predecessor record:** `docs/work/2026-09-21-delegated-multi-query-rag-with-jev-selection.md` (F1–F14; measured pipeline wins 0.98→1.49 / 0.45→1.94 / 0.11→1.27 / 0.93→1.85 mean Jev top-5).

**Method:** three parallel read-only lanes on the task worktree, plus orchestrator spot-checks.
- **R1** — integration map of `extensions/mem-based-rag` (contracts, timeouts, dedup, cards, warm-up, test seams).
- **R2** — Jev client reuse + preload, with measured keep-alive probes (14 Jev calls, $0.000252) and undici pool diagnostics.
- **R3** — extension mechanics: direct model call, TUI progress, hook timeout reality, skill-use trigger.
- Orchestrator read `searchCall`/`getClient`/`resetSessionState` and the research harness scoring wire shape directly.
Grades: `[READ]` code/docs, `[MEASURED]` command output, `[INFERRED]`, `[UNVERIFIED]`.

## A. Integration surface — mem-based-rag

**A1 — The hook contract and the query source [READ].** `before_agent_start` receives `{type,prompt,images,systemPrompt,...}` and returns `{message:{customType,content,display,details}}` which pi injects as a persistent `role:"custom"` message. The `input` handler captures the RAW prompt (pre skill/template expansion) into a session-keyed FIFO; the hook drains it first and falls back to `event.prompt`. The enrichment gate is skill-only (`hasSkillPrefix`), so `/task` and friends are the trigger by construction.
*Evidence:* `extensions/mem-based-rag/index.ts:671-697`; `rag-core.ts:118-157`; pi `dist/core/extensions/runner.js:881-908` (0.84.4); `agent-session.js:1282,918-926`.

**A2 — One search per turn, single-flight [READ].** Both call sites (auto enrichment and `/ask`) issue exactly one `memory_search` with args `{projectId, sessionId, query, limit:5}` (no `kind`/`scope`), parsed as `{data:{results?:MemoryHit[], code?:MemoryHit[]}}`. All searches pass through `searchCall`, which serializes them on a `searchFlight` promise chain — pipeline searches will be sequential through this seam unless deliberately bypassed.
*Evidence:* `index.ts:605-617` (single-flight), `:730-734` (auto), `:938-942` (/ask), `:735-737` (envelope).

**A3 — The "8,000 ms search timeout" is falsified [READ].** The shipped default is **20,000 ms**, clamp 500–60,000 (`PI_BADGER_MEM_RAG_TIMEOUT_MS`); 8,000 survives only in the stale spec. `/ask` child budget is 90,000 default, clamp 500–600,000.
*Evidence:* `index.ts:106-121`; tests pin 20000 (`tests/mem-based-rag/wiring.test.ts:558,568`); stale spec `docs/plans/2026-09-06-mem-based-rag-spec.md:109,115,160`.

**A4 — No path-level dedup; budget is a blind slice [READ].** `pruneHits`/`dedupeHits` drop empty-path/empty-snippet rows and dedupe by hash OR identical snippet, then wiring slices `mem.slice(0,5)` / `code.slice(0,5)`. Chunk-level identity wastes slots (research F10); the pipeline's merge rule is the fix.
*Evidence:* `rag-core.ts:191-221`; `index.ts:737-738`; `rag-core.ts:412-441`.

**A5 — Progress surface: `setStatus`/`setWidget`, not cards [READ].** Durable `/ask` cards are `pi.sendMessage({customType,display:true},{triggerTurn:false})` — append-only, not transient. The repo precedent for live progress is `ctx.ui.setStatus(key,text)` (session-signals) and `setWidget` (subagent delegation-status); working-message/spinner APIs are streaming-only and invisible pre-run. Whether the footer paints while `before_agent_start` still awaits is **not verifiable from this repo** `[UNVERIFIED]` — the plan's manual gate must confirm it live.
*Evidence:* `index.ts:565-572,1090-1152`; `extensions/session-signals/index.ts:129-149`; `extensions/subagent/delegation-status.ts:315,697`; pi `docs/tui.md:768-835,792`.

**A6 — Warm-up pattern to copy [READ].** `session_start` → `resetSessionState()` then `warmClient()`: fire-and-forget `getClient(...).catch(...)`, fully fail-open; `session_shutdown` resets. `getClient` memoizes; a cold proxy handshake (≤15 s) is paid at session start.
*Evidence:* `index.ts:594-601,1161-1180`.

**A7 — Test seams and command [MEASURED].** `MemRagDeps {createClient?, spawnAsk?}` with fakes injected; no injected clock (`Date.now()` direct). `bun test tests/mem-based-rag/` → 131 pass, 0 fail, 7.87 s; shared harness `tests/helpers/fake-pi.ts`.
*Evidence:* `index.ts:440-444,465-469`; `tests/mem-based-rag/wiring.test.ts:1-12`; CI `bun test` (`.github/workflows/ci.yml:45`).

**A8 — No multi-query, planning, or rerank exists today [READ].** Grep across the extension finds only expanded-mode fetch fan-out comments.

## B. Jev scoring client and preload

**B1 — The frozen decision-router client cannot express `score`; ship a minimal client in query-pipeline [READ].** Its question union is `choice|noul` and `parseAnswer` rejects other types; the research scorer uses `type:"score"` with `criteria` as an ordered level array and reads a continuous `a.score`. Reuse **by contract, not by file**: same `OPENROUTER_API_KEY` / `PI_BADGER_JEV_ENDPOINT` / `PI_BADGER_JEV_MODEL` names, same `JevErrorKind` vocabulary, injected `fetch`/`scheduler`/`env`, own 30 s default (the frozen client's 2.5 s is wrong for batched scoring).
*Evidence:* `extensions/decision-router/decision-router-client.ts:24,76,281-289,332,485,538,428-463,553`; wire shape `/tmp/rag-multiquery/jev.ts:50-65,96-102`.

**B2 — Scoring wire shape to reimplement [MEASURED].** `{model, state:<raw prompt string>, questions:{c<i>:{type:"score",instructions:{candidate:{path,kind,excerpt},question},criteria:[4 level strings]}}}`; batches of ≤12 candidates; 3 attempts per batch; answer `{type:"score",score,confidence,probabilities,legend}`; measured cost $0.0014 for 13 calls / 34k input tokens (research F7). T4 eval used 3 calls for its pool.
*Evidence:* `/tmp/rag-multiquery/jev.ts:50-102`; `/tmp/rag-multiquery/eval/t4-over-window.eval.json` (`calls:3`, usage array).

**B3 — Publish mechanics [READ].** `publish.ts:70` lists `EXTENSION_DIRS`; every file under `extensions/<name>/` (minus node_modules) ships to `~/.pi/agent/extensions/<name>/`. Cross-extension relative imports **do** survive publish (precedent: `decision-router → router-fallback`, `monitor → subagent + message-bus`), but fail if an extension is installed alone — acceptable, same as existing precedent. Add `"query-pipeline"` to the list.
*Evidence:* `publish.ts:70,106-120`; `decision-router/index.ts:49`; `monitor/index.ts:37-38`.

**B4 — Preload measured: a warm call, not TCP keep-alive [MEASURED].** pi runs under Node (undici 8.10.2 global fetch). undici discards pooled idle sockets after ~4 s (2 s gap reused; 6 s gap reconnected), while the OpenRouter edge holds HTTP/1.1 idle sockets ≥115 s. So across a 30–60 s gap a fresh handshake is paid regardless (~44 ms on Jev calls). A `session_start` warm call removes the measured **~200–260 ms cold-first-call penalty** (744 ms cold vs 465–530 ms steady) at **≈$0.00002/session**; persistence across minutes is `[UNVERIFIED]`. Reject periodic pings; a long-keep-alive `dispatcher` is a later optimization.
*Evidence:* `/tmp/jev-probe.mjs`, `/tmp/undici-pool-probe.mjs`, `/tmp/edge-keepalive-probe.mjs` (R2 lane log); lsof on live pi process → `/opt/homebrew/Cellar/node/26.9.0/bin/node`.

## C. Planner, progress, timeout, trigger

**C1 — Direct planner call: `ctx.modelRegistry.streamSimple(model, context, options)` [READ].** Provider-neutral; `context.systemPrompt` carries the delegator/planner system prompt; `options.signal` accepts our own `AbortController`; `await stream.result()` yields the assistant message; text via exported `contentText`. Fallback: direct OpenRouter HTTP (`OPENROUTER_API_KEY`) on registry/auth failure.
*Evidence:* pi `docs/extensions.md:1109-1111`; `dist/core/model-registry.d.ts:20-34`; `pi-ai/dist/types.d.ts:434-438,58`.

**C2 — No harness timeout; the hook cannot be cancelled [READ].** `before_agent_start` handlers are awaited in try/catch only — no timer, no race. `ctx.signal`/`agent.abort()`/Esc all act on the *agent run*, which starts only after the hook. A 60–150 s hook means a serialized turn with nothing visible except what the hook itself paints. Any budget must be self-enforced (AbortController + timer).
*Evidence:* pi `dist/core/extensions/runner.js:1016,1037-1055`; `agent-session.js:1283,1331,1289-1300,1608-1617`; `pi-agent-core/dist/agent.js:211-217,341-347`.

**C3 — Skill trigger mechanics [READ].** Order inside `prompt()`: extension commands → `input` handlers (raw text) → skill expansion → prompt-template expansion → `before_agent_start` with the **expanded** `<skill ...>` block. The existing raw-prompt FIFO is the correct planner input; `event.prompt` is not.
*Evidence:* `agent-session.js:1218-1241,1283,1365-1390`; `rag-core.ts:22-35`.

**C4 — Planner prompt draft [READ/INFERRED].** System: delegator persona as retrieval-query planner, no tools, concept-grouped queries, JSON-only, "if you emit a fragment the final object must be complete". User: constraints (2–6 queries, ≤300 chars, name the actual thing, bank is project docs+code) + `{"concepts":[{"name":...,"queries":[...]}]}` + `<<< raw prompt >>>`. Parser must read the **last complete JSON object** (research F4: one of four runs emitted a partial fragment first) and validate shape before use.
*Evidence:* R3 lane report §2; research F4 `:82-92`; persona `.pi/agents/delegator.md`.

**C5 — Top risks [INFERRED].** (1) Turn blocking: 66–147 s delegated planner is not viable; a direct call with a hard planner timeout plus single-query fail-open is the mitigation. (2) Progress invisible: streaming spinner does not exist pre-run; `setStatus`+`setWidget` is the best available surface, and its visibility from a blocking hook needs a live check. (3) Planner JSON drift: last-complete-object extraction + shape validation + fallback.

## Decision inputs for the plan

- **D1** New `extensions/query-pipeline/` with: minimal Jev score client (copy-by-contract), planner call via `ctx.modelRegistry.streamSimple` with delegator-persona system prompt, stage functions (`group → search → rank → merge`), pure and injected-seam testable.
- **D2** mem-based-rag imports query-pipeline's runner and routes its enrichment search(es) through it; `searchCall`'s single-flight stays the transport; output must satisfy the existing `{data:{results,code}}` → `MemoryHit[]` normalization.
- **D3** Merge rule (owner-specified): 5 result slots; rank candidates by Jev score; fill with best chunk per distinct document first; if fewer than 5 distinct documents, backfill remaining slots with next-best chunks from already-included documents.
- **D4** Jev preload: one fail-open warm call at `session_start` (idempotent, gated on key + kill switch), result discarded.
- **D5** Progress: `ctx.ui.setStatus` (+ optional `setWidget`) during planning/searching, cleared in `finally`; durable `/ask`-style card remains the final-result surface only.
- **D6** Timeout policy: pipeline budget env (new), default sized for planner + N sequential searches + scoring; planner gets its own hard timeout; any failure falls back to today's single-query enrichment; the hook never throws.
- **D7** `publish.ts` EXTENSION_DIRS gains `query-pipeline`.
- **D8** The stale `QueryLengthGuard` warning is out of scope here — handed to the ai-raccoon project over the message bus (acknowledged 2026-09-22).

## Still open (not resolved by this record)

- Whether `ctx.ui.setStatus` actually paints while `before_agent_start` is still awaiting `[UNVERIFIED]` — manual gate in Phase 4.
- Planner latency of a **direct** call (research measured only the 66–147 s agent-process shape) — must be measured in the implementation lane and recorded.
- Whether parallelizing the N searches is possible without breaking `searchCall`'s single-flight — deferred to the optimization pass (v1 sequential, matching research F6).
- Whether `streamSimple` auth resolves for the chosen planner model in a fresh session — first implementation probe.
