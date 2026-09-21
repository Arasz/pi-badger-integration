# Research: TypeSafe Jev 1.13 as a routing, tool-selection and model-selection classifier

**Date:** 2026-09-21
**Question:** How could the TypeSafe Jev 1.13 structured-decision model be used for routing, tool selection, and model selection — and what is actually verified about it (API shape, availability, latency, cost, limits)?

```chart:range
title: Jev decision latency, seconds (9 calls, sequential, 2026-09-21; dot = median)
all decisions calls: 0.471..0.535..0.891
identical payout triage x3: 0.508..0.522..0.662
```

## Findings

### F1 — The model is callable today through OpenRouter on a dedicated decisions endpoint, using this project's existing OpenRouter key [MEASURED]

`POST https://openrouter.ai/api/alpha/decisions` with body `{model, state, questions}` returns HTTP 200. The standard chat/completions route hard-refuses it: HTTP 400, `"typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."` No TypeSafe account was needed — only the `OPENROUTER_API_KEY` already in this environment.

**Evidence:** 9 `curl` calls from this macOS machine, 2026-09-21. Minimal form: `curl -s -w "%{http_code} %{time_total}" https://openrouter.ai/api/alpha/decisions -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" -d '{"model":"typesafe/jev-1.13","state":"My payout has failed three days in a row.","questions":{"department":{"type":"choice","instructions":"Which team should handle this message?","criteria":{"billing":"Payments, payouts, invoices, refunds","technical":"Bugs, outages, integrations, API errors","sales":"Pricing, upgrades, new accounts"}}}}'`. Case bodies in `/tmp/jev-cases/*.json`, script `/tmp/jev-probe.sh`; the chat/completions refusal was the first exploratory call.

### F2 — The contract is `{state, questions}` in, typed answers and per-option probabilities out [MEASURED]

Request: `{"model": "typesafe/jev-1.13", "state": <string|object|array>, "questions": {<name>: {type: "choice"|"score"|"noul", "instructions": <string|object|array>, "criteria"?}}}`. Response: `{"model", "answers": {<name>: {"type", "choice"|"score"|"noul", "probabilities"?, "confidence"?, "legend"?}}, "usage": {"input_tokens", "output_tokens", "cost"}, "id", "provider"}`. Several questions ride one call (fan-out), and probabilities come back for every option, not just the winner. Choice allows up to 255 options — enough to name a whole toolset in one question.

**Evidence:** live responses from `/tmp/jev-probe.sh` and `/tmp/jev-body2.json`; the same shape is documented at `https://docs.typesafe.ai/api.md` (Evaluation endpoint; Choice/Noul/Score) and `https://docs.typesafe.ai/introduction/quickstart.md`. Verbatim response from the payout case: `{"model":"typesafe/jev-1.13-20260917","answers":{"department":{"type":"choice","choice":"billing","probabilities":{"technical":0.01,"billing":0.99,"sales":0},"confidence":0.99}},"usage":{"input_tokens":364,"output_tokens":38,"cost":1.5288e-05},"provider":"TypeSafe"}`.

### F3 — Decision latency sat between 0.47 s and 0.89 s across 9 calls; the identical-case spread was 0.51–0.66 s [MEASURED]

One decision costs roughly half a second of added wall-clock — tolerable for a once-per-turn pre-flight question, not for an in-loop hot path. Three identical payout-triage calls gave 0.508 s, 0.521 s and 0.662 s: the spread is real and worth budgeting against, not a fixed 0.5 s.

**Evidence:** `/tmp/jev-probe.sh`, run sequentially on this macOS machine, 2026-09-21; nine `/api/alpha/decisions` calls timed with `curl -w "%{time_total}"`: 0.4707, 0.5076, 0.5132, 0.5215, 0.5354, 0.6005, 0.6197, 0.6617, 0.8912. Not measured under concurrency or from a cold connection pool.

### F4 — A decision costs $0.000015–$0.000020; a million decisions would cost roughly $16–20 [MEASURED]

Per-call `usage.cost` ranged 1.5288e-05 to 2.0412e-05 USD for 364–486 input tokens and 38–90 output tokens. OpenRouter's model metadata prices prompt at $0.042 per 1M tokens and completion at $0. The same calls confirm this project's OpenRouter key is valid and funded — worth flagging because `docs/reference/extension-catalog.md:225` (2026-09-05) records "No valid provider key exists in this environment"; at least for OpenRouter that note is now stale (my call was a paid model, not the `:free` entitlement the catalog's blocker referred to).

**Evidence:** `usage.cost` on 9 live responses (`/tmp/jev-probe.sh`, `/tmp/jev-body2.json`); pricing metadata from `GET https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints` (`prompt: "0.000000042"`, `completion: "0"`, fetched 2026-09-21).

### F5 — On realistic triage prompts it picked the intended route every time, with high confidence [MEASURED]

Billing/payout failure → `billing` (0.99); API 500s after a deploy → `technical` (1.00); pricing/seat question → `sales` (1.00). Companion `noul` questions in the same calls answered "needs same-day intervention" 0.83 and "delegate vs inline" 0.36. One call answered two questions.

**Evidence:** cases 01–03 in `/tmp/jev-cases/` and the JSON-state call in `/tmp/jev-body2.json`, run 2026-09-21. "Intended" is my label from the criteria I wrote; three cases is a demonstration, not a benchmark.

### F6 — Tool selection works, but confidence varies — and the probability vector is more useful than the winner [MEASURED]

With task + `active_tools` as structured state, it chose `bash` (0.91, confidence 0.90) for "why does the build fail" — defensible. On "fix the failing test" it chose `read` (0.69, confidence 0.61) against `grep` (0.08). The lower confidence is itself informative: that decision is genuinely ambiguous. Because the answer carries a probability per option, a caller can enable a *set* (all tools above a threshold) rather than trusting the discrete pick — which maps directly onto `pi.setActiveTools`.

**Evidence:** case `04-tool-selection` in `/tmp/jev-cases/` and the JSON-state call in `/tmp/jev-body2.json`, 2026-09-21; max-255-options limit from `https://docs.typesafe.ai/api.md` (Choice).

### F7 — A model-tier question was answered against the model's own rubric [MEASURED]

I asked which tier a rename task needs, with criteria "low: mechanical, single-file or rename-level change". It answered `medium` (0.84) and put `low` at 0.16 — while the task matched the `low` criterion's own wording. One case proves nothing about calibration; it does show that model-tier judgement is not a category this model already knows how to apply, so it should not demote a session's model without a labelled fixture set first.

**Evidence:** case `05-model-tier` in `/tmp/jev-cases/` (`{"state":"Task: rename the variable cooldownMs to cooldownDurationMs across 3 files and update its tests.","questions":{"tier":{"type":"choice","instructions":"Which model tier is sufficient for this task?","criteria":{"low":"Mechanical, single-file or rename-level change","medium":"Multi-file change needing judgement","high":"Design, debugging, architecture"}}}}`), `/tmp/jev-probe.sh` output, confidence 0.75.

### F8 — pi already exposes the exact seams these three uses need [READ]

- Tool set: `pi.getAllTools()` / `pi.getActiveTools()` / `pi.setActiveTools(names)` — `docs/extensions.md:1780`; `before_agent_start` can change `systemPromptOptions.selectedTools` durably, and the docs say calling `setActiveTools` there has the same effect — `docs/extensions.md:535`.
- The documented dynamic-tool pattern (register everything, keep a `search_tools` loader active, enable matches on demand) names "project-specific routing" as the intended upgrade for its keyword matcher — `docs/extensions.md:2468`.
- Model: `pi.setModel(model)` — `docs/extensions.md:1807`; `pi.setThinkingLevel(level)` — `docs/extensions.md:1821`.
- The repo's own `router-fallback` already drives `setModel`/`setThinkingLevel` (`extensions/router-fallback/index.ts:501-519`) but only reactively, once per episode, after a billing/auth/route failure (`docs/reference/extension-catalog.md:182`).

**Evidence:** `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:535,1780,1807,1821,2468` (installed pi 0.85.x); `extensions/router-fallback/index.ts:381-390,501-519,572-634`; `docs/reference/extension-catalog.md:182`.

### F9 — The OpenRouter endpoint metadata closes the obvious questions [READ]

`GET https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints` returns: provider `TypeSafe`, endpoint id `typesafe/jev-1.13-20260917`, modality `text->decisions` (text input only), context 32 000, max output 28 800, `supported_parameters: []` (no temperature, no tools, no JSON mode), uptime 100 % over the last 30 min / 5 min / 1 day, created 2026-09-18. `supports_tool_choice` reads all-true on the endpoint — an artifact of the routing API, not a tool-use capability.

**Evidence:** that endpoint JSON, fetched 2026-09-21; `https://docs.typesafe.ai/concepts/system-one.md` — the model "does not write replies, produce code, or generate explanations of its reasoning".

### F10 — A first-party TypeScript SDK exists but is aimed at api.typesafe.ai [READ]

`@typesafe-ai/sdk` 0.6.0 is on npm (MIT, ESM+CJS, Node ≥ 20). Its docs show `new TypeSafeClient()` against the TypeSafe API. Whether it takes a base-URL override for OpenRouter's `/alpha/decisions` route is unchecked, so a raw `fetch` (about 30 lines) is the safer integration here.

**Evidence:** `https://docs.typesafe.ai/sdk/javascript.md`; `https://registry.npmjs.org/@typesafe-ai%2Fsdk` (`dist-tags.latest = "0.6.0"`, license MIT), fetched 2026-09-21.

### F11 — Tool selection is the strongest fit: one confidence-gated call per turn, applied through `setActiveTools` [INFERRED]

Reasoning from F6 (tool picks with usable confidence and a probability vector), F2 (255 options, structured state) and F8 (`setActiveTools` exists; `before_agent_start` is the documented place to change the tool set): an extension registers its tool catalogue as a single Choice question, sends `{task, tool names + one-line descriptions, repo context}`, and enables the tools above a probability floor when confidence clears a threshold — otherwise it changes nothing. The gate is not optional: F6 measured a 0.61-confidence pick, and a wrong narrowing can starve the model of the tool it needs. Changing the tool set also rewrites prompt/tool deltas, so the loadout should change rarely, not every turn.

### F12 — Model selection should be a pre-flight complement to `router-fallback`, with upgrades free and demotions gated [INFERRED]

Reasoning from F3 (fast enough), F4 (cheap enough), F7 (one measured tier miss), F8 (the pieces exist): `router-fallback` responds to a failure after it happened, once per episode, over a pinned chain (`extensions/router-fallback/index.ts:501`, `docs/reference/extension-catalog.md:182`). Jev can classify the task *before* the turn and choose a tier or model through the same `setModel`/`setThinkingLevel` calls. Because F7 measured a tier answer that contradicted its own rubric, the safe policy is asymmetric — a wrong upgrade costs money, a wrong demote costs quality and retries — so demote only on high confidence and a cheap-tier answer, and leave the model untouched otherwise. A labelled fixture set (existing sessions replayed against known-good tiers) is the gate before enabling demotion.

### F13 — Prompt routing (skill/persona/handler) is the least invasive first deployment: shadow-mode, fan-out, confidence-visible [INFERRED]

Reasoning from F5 (correct, high-confidence classification on triage-shaped prompts), F2 (several questions per call, probabilities included) and F8 (`before_agent_start` receives `event.prompt`): one call can ask for `{skill, persona, needs_subagent, model_tier}` and a handler can log the answers without changing behaviour. Shadow mode builds the labelled corpus F12 needs, and it is the cheapest way to learn whether a ~25-skill catalogue is a stable classification target before letting it route anything. Existing deterministic routing (leading-`/` commands, prompt markers) should stay in front of it — those are free and exact.

### F14 — The alpha path is the main operational risk; put it behind an interface with a non-Jev fallback [INFERRED]

Reasoning from F1 (the working path is literally `/api/alpha/decisions`) and F2 (the only documented stable surface is TypeSafe's own `POST /v1/systemone`): any integration should sit behind a small `classify()` interface whose fallback is the deterministic matcher it replaced (keyword/BM25 tool search per `docs/extensions.md:2468`, or the existing pinned chain), so an endpoint change is a degraded feature, not a broken session. Chat completions being hard-refused (F1) is a small mercy: the client cannot silently degrade to text.

### F15 — Rate limits under sustained load, data handling, and the SDK base-URL override are unchecked [UNVERIFIED]

Single calls returned no `X-RateLimit-*` or `Retry-After` headers, so nothing about a paid-route quota is known from this work; a production loop should discover it with a bounded test rather than assume. Also unchecked: where routing states (which would include user prompts and tool descriptions) are retained or processed once they leave for OpenRouter and TypeSafe, and whether `@typesafe-ai/sdk` can point at the OpenRouter route.

## Still open

- Calibration against outcomes: are the 0.99-confidence triage answers right at the claimed rate on this repo's own prompts? Needs a labelled fixture set (100+ prompts, per-class accuracy plus a reliability curve), not the three cases measured here.
- Rate/quota behaviour of `/api/alpha/decisions` under sustained turn-rate load: what the failure mode is (429? 402?), and whether `Retry-After` ever appears.
- Data-retention and privacy terms for sending prompts and tool descriptions through OpenRouter to TypeSafe, and whether repo policy permits that in shadow-mode logging.
- Whether `@typesafe-ai/sdk` accepts a base URL that reaches the OpenRouter decisions route (which would remove the hand-rolled fetch).
- The `score` primitive was not exercised at all; it is the natural fit for a single "complexity" number if a tier policy wants thresholds rather than classes.
- Live behaviour of a 255-option Choice (a real tool catalogue) was not tested — only 4–6 options per question.
