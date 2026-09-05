# Research: router-failure free-model fallback extension (`pbi-router-failure-free-model-fallback`)

Date: 2026-09-05. Three parallel read-only lanes (d-487 OpenRouter, d-488 Free-LLM, d-489 pi seams).
Full lane outputs: `/tmp/d-487-report.md` (14k), `/tmp/d-488-report.md` (13k), `/tmp/d-489-report.md` (23k).
Ledger: 37253 + 12767 + 14432 tokens (cache-excluded, from subagent logs; `--delegation` lookup refused, repaired to convention).

## Preflight (Rule 1)

- **Objective:** new pi directory-package extension `extensions/router-fallback/` that detects router/LLM
  request failure from an empty/no-token account (and related billing exhaustion) and switches the
  session to the best free coding model, with user-configurable ordered providers.
- **Constraints:** directory-package model (`extensions/<name>/` → `~/.pi/agent/extensions/<name>/`,
  `publish.ts` + `EXTENSION_DIRS` wiring); TypeBox tool schemas; pure-core/wiring split (monitor precedent);
  factory-with-injected-deps (subagent precedent); TDD; `bun test` + `bunx tsc --noEmit -p .` green;
  no hardcoded secrets (env-var names only); never persist the fallback as default model.
- **Known unknowns (H1–H4, lane d-489):** exact OpenRouter empty-account JSON wording; `after_provider_response`
  on non-HTTP transports; whether rewriting `message_end` error→stop suppresses retry (prefer react-over-rewrite);
  safety of `pi.setModel` mid-stream (act at `agent_end`/settled/command level until tested).
- **Output contract:** `extensions/router-fallback/` (index + `-core.ts` + package.json), tests mirroring
  `tests/` layout, `publish.ts` registration, README/docs, `/fallback` status command, bus transition event.
- **Stop condition:** touched-surface tests green once locally + typecheck; no CI on this repo
  (`sourceControl.platform == "none"`); full `bun test` once before merge.

## Lane A — OpenRouter free coding models + limits (d-487, architect)

Ground truth: live `GET https://openrouter.ai/api/v1/models` (431 models, 19 `:free`), docs markdown
(limits.md, errors-and-debugging.md, authentication.md, privacy, ZDR, FAQ). Discover page is JS-heavy;
the API is ground truth — **the extension must re-fetch `/models` at runtime and filter
`id.endswith(":free")` + `tools in supported_parameters` + text→text, not pin a list (pool churns).**

Coding-suitable `:free` IDs (all tool-capable except Inkling `tool_choice` caveat):
`z-ai/glm-5.2:free` (AA coding 68.8, 256K) > `minimax/minimax-m3:free` (58.6, 1M) >
`thinkingmachines/inkling-small:free` (52.9, 1M, no `tool_choice` param — HYPOTHESIS: forced-auto only) >
`minimax/minimax-m2.7:free` (52.6) > `thinkingmachines/inkling:free` (52.1) >
`nvidia/nemotron-3-ultra-550b-a55b:free` (49.3, orchestrator) > `google/gemma-4-31b-it:free` (43.4, best small) >
`google/gemma-4-26b-a4b-it:free` (39.3) > `nvidia/nemotron-3-super-120b-a12b:free` (37.7) >
`cohere/north-mini-code:free` (36.5, purpose-built agentic coder, weak score) >
`nvidia/nemotron-3.5-lightning:free` (26.8, fast/weak) + `poolside/laguna-s-2.1:free` /
`laguna-xs-2.1:free` (purpose-built coding-agent, Terminal-Bench 2.1 70.2% vendor claim — HYPOTHESIS, no AA score).
Rejected: Ling finance/sante (domain MoEs), Liquid lfm-2.5 (vendor advises against agentic coding),
nano-omni (AA 13.8), content-safety (no tools param), dots-3-note, all audio/TTS (not `:free` at all).

Free-tier limits: key **required even for free**; < $10 lifetime purchase → 20 RPM / 50 RPD;
≥ $10 → 20 RPM / 1000 RPD; negative balance → 402 even on free models; extra accounts do NOT raise limits.
Privacy: separate paid/free training opt-outs; ZDR shrinks the free pool (HYPOTHESIS: mostly non-ZDR).

Error payloads (detector vocabulary): envelope `{error:{code,message,metadata?}}`, status == code.
429 verbatim `rate_limit_exceeded` (+`provider_code` variant, `X-RateLimit-*` + `Retry-After` headers);
**200-with-`error`-body and mid-stream SSE `error` + `finish_reason:"error"` must be scanned — status alone misses.**
402 `payment_required` (full body = reconstruction, HYPOTHESIS); 401 `authentication`;
503 no-provider (model-switch, not key-rotation). Trigger on code ∈ {401,402,429} /
error_type ∈ {authentication, payment_required, rate_limit_exceeded}; NEVER on 400/403/404.

Suggested OpenRouter-internal chain: `z-ai/glm-5.2:free` → `poolside/laguna-s-2.1:free` →
`minimax/minimax-m3:free` → `thinkingmachines/inkling-small:free`.

## Lane B — Free-LLM providers, top-3 picks (d-488, architect)

Ground truth: `github.com/nejib1/Free-LLM` README + `code-examples/<provider>/{README.md,curl.sh,python.py}`
(40 provider dirs) + Groq/Gemini/OpenRouter official docs. **The repo documents zero tool-calling data** —
tool values below are provider-docs-verified or HYPOTHESIS.

Top-3 for the configurable list (axes: coding quality, tool-calling, limit generosity/no-expiry, OpenAI-compat cost):
1. **Groq first** — permanent no-card, 30 RPM / 14.4k RPD (only workhorse quota), OpenAI-compat
   `https://api.groq.com/openai/v1`, tools verified in official docs. Default model `llama-3.3-70b-versatile`
   (HYPOTHESIS: confirm IDs at runtime via `/models`).
2. **Gemini second** — best $0 quality (3.1 Pro/Flash, 2M ctx), permanent no-card, 9k RPD Flash. Costs one knob:
   baseURL must be the OpenAI-compat root `.../v1beta/openai/`, NOT the native endpoint in Free-LLM's curl.sh.
3. **OpenRouter `:free` third** — one key, many free coders, tools passthrough, but 50 req/day = burst fallback only;
   needs `extraHeaders` (HTTP-Referer/X-Title).
Rejected runner-up **Cerebras** (no-card tier ended Aug 2026, card-required + 30-day expiry — a fallback that
demands a card is worse than none); also dead: Chutes (no longer free), GitHub Models (discontinued);
Cohere native-only + 1k/month cap (not a default). Keyless last-resort custom entries (Pollinations GET API —
no tools; LLM7 OpenAI-shape proxy — tools HYPOTHESIS) stay user-addable, not defaults.

Config schema (from lane; drives the plan): ordered `providers[]` = failover priority; per entry
`{id, label, baseURL, apiKeyEnv (name only), model (overridable), enabled, extraHeaders?, timeoutMs?,
rateLimit?{maxRpm, cooldownMs, maxRetries}}`. Behavior: advance on network/5xx/429/auth; failing provider goes
on `cooldownMs` (transient outages recover), not disabled; skip unset-key providers (except keyless);
surface which provider served.

## Lane C — pi failure surfaces + extension seams (d-489, api-engineer)

Researched against installed pi **0.85.1** (repo pins 0.84.4 — verify `setModel`/`model_select` against
0.84.4 before building). Key paths under `/Users/arasz/.bun/install/global/node_modules/` (+ `pi-ai/dist/`).

- Request path: `agent-session.js:168-191` auth resolve (missing auth throws pre-HTTP) → `sdk.js:180-230`
  streamFn (`transformHeaders`/`onPayload`/`onResponse`) → provider folds throws into
  `AssistantMessage{stopReason:"error", errorMessage}` (`openai-completions.js:393-527`) →
  `_handlePostAgentRun` (`agent-session.js:788-808`): retryable → `_prepareRetry` → `continue()`, else
  compaction → drain → `agent_end` (`:350` settled).
- Detection vocabulary (prefer over exact strings): `normalizeProviderError`/`formatProviderError`
  (`error-body.js`, bodies cut at 4000 chars — **match substrings + status prefix, never exact JSON**);
  `isRetryableAssistantError` (`retry.js:167`) — NON-RETRYABLE first: `GoUsageLimitError|FreeUsageLimitError|
  Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing`;
  gated by overflow check (`overflow.d.ts` per-provider patterns); retry budget `settings.retry`
  (default on/3/2s, events `auto_retry_start/end`, `agent_end.willRetry` at `:386,429-437`).
  **Keep `retry.provider.maxRetries: 0`** or SDK retries swallow quota errors before pi sees them.
- Observation points (no dedicated LLM-error hook): `after_provider_response` (`sdk.js:217-226`, sync statuses
  only, no folded message) → `message_end` assistant error (folded `errorMessage`, may return replacement —
  H3 unproven, prefer react-over-rewrite) → `turn_end` → `agent_end` (+`willRetry`) → `agent_settled`.
  Lane verdict: trigger = `isRetryableAssistantError == false + billing-ish` OR `after_provider_response` 402,
  and act at `agent_end`/settled/command level (H4: no mid-stream `setModel` until tested).
- Switch: read `ctx.model/modelRegistry/scopedModels/thinkingLevel` (`runner.js:505-560`); write
  `pi.setModel(model): Promise<boolean>` (`loader.js:339-341` → `agent-session.js:2050-2053`: `false` when
  provider auth unconfigured, no throw; sets state, appends model change, reclamps thinking, emits
  `model_select{source:"set"}` at `:1228-1248`). **No confirmation** in the path; session-only unless
  `persist:true` (**do NOT persist**); prefer targets inside `ctx.scopedModels` when non-empty; set thinking
  level explicitly on reasoning targets. Register fallback providers via `pi.registerProvider`
  (`model-runtime.registerProvider`, `provider-composer.d.ts:ProviderConfigInput`) / `models.json` overrides.
- Patterns to copy: subagent factory-with-deps + TypeBox schemas + mode-keyed behavior (`ctx.mode==="tui"`),
  `TRANSITION_CHANNEL` bus (emit `router-fallback` transition, don't invent a bus), user-scope durable logs
  (0600/0700) + `session_start` reconstruction, `session_shutdown` flush discipline, renderer + 8KB caps,
  per-call env kill-switches (`PI_BADGER_*=0`); monitor pure-core/wiring split (failure-matcher → `-core.ts`,
  node:vm-free pure + injected clock), one-shot/resolve-once edge (switch-once-per-episode + cooldown),
  `/monitors`-style command + completions + tone-by-kind renderer for `/fallback`; tests layout
  (`tests/<name>/*-core.test.ts` + `*-extension.test.ts` + guard tests). Drift note: README wait "120s" is
  stale; code `WAIT_DEFAULT_MS = 300_000`.
