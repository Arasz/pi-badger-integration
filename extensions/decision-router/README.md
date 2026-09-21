# decision-router

Pre-flight routing for pi sessions: one TypeSafe Jev 1.13 decision call per
enabled distinct turn, fanned out to three questions — additive tool selection,
an asymmetric model-tier choice, and shadow-only skill routing.

## What it does

- **Tool selection (additive).** One `choice` question carries the whole live
  catalogue (names sorted, descriptions truncated uniformly to fit the 8 KB
  state budget, up to 255 options). A decision actuates
  `active ∪ {p ≥ 0.2}` only when the winner is in the live catalogue and its
  confidence is ≥ 0.7; an unknown/ghost winner rejects the whole question, and
  a subset already active holds. Tools are never removed and never narrowed.
- **Model tier pre-flight (asymmetric).** A fixed `low | medium | high` rubric.
  `high` with confidence ≥ 0.6 upgrades to the high tier model; `low` with
  confidence ≥ 0.85 demotes to the low tier model; `medium`, off-rubric
  answers, weaker confidence, and an already-on-target model all hold. The
  target must be configured (`PI_BADGER_JEV_TIER_*_MODEL`); unset targets fall
  back to the current model, so a tier answer alone can never move the session.
  A configured target is resolved through the model registry
  (`ctx.modelRegistry.find(provider, id)`) and `setModel` receives the full
  registry model — never a `{provider, id}` stub, which pinned pi stores
  verbatim and which breaks the next request. A target that is empty or
  whitespace, cannot be split into `provider/model-id`, or is absent from the
  registry holds that step (`tier-target-unset` / `target-not-in-registry`)
  and never calls `setModel`.
  While a `router-fallback` switch latch is armed, upgrades hold (demotes still
  pass).
- **Skill routing (shadow only).** A skill `choice` over the turn's
  model-invocable skills plus `none`, recorded as
  `{question, choice, confidence, promptHash}` in a 20-record ring. It never
  actuates anything; `/decisions shadow` shows the records.

The three questions ride **one** `POST` per enabled turn
(`{model, state: {task, tools?}, questions}`); the tools question is omitted
when the catalogue is empty or over budget, and disabled capabilities are left
out of the fan-out rather than answered locally.

## Environment variables

Read per call from the live environment. Only the literal string `0` disables a
switch — any other value (including `false`) leaves it enabled. Precedence is
**per-capability env kill > master env kill > `/decisions off` session
override**; `/decisions on` never lifts an env kill.

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required. Missing or empty means zero requests (skip reason `missing-key`). |
| `PI_BADGER_DECISION_ROUTER` | enabled | Master kill switch; `0` disables all three capabilities. |
| `PI_BADGER_DECISION_ROUTER_TOOLS` | enabled | Per-capability kill switch for tool selection. |
| `PI_BADGER_DECISION_ROUTER_MODEL` | enabled | Per-capability kill switch for the model tier. |
| `PI_BADGER_DECISION_ROUTER_ROUTING` | enabled | Per-capability kill switch for shadow routing. |
| `PI_BADGER_JEV_MODEL` | `typesafe/jev-1.13` | Decision model sent on the wire. |
| `PI_BADGER_JEV_ENDPOINT` | `https://openrouter.ai/api/alpha/decisions` | Decisions endpoint. |
| `PI_BADGER_JEV_TIMEOUT_MS` | `2500` | Request timeout; unset, garbage or non-positive values use the default. |
| `PI_BADGER_JEV_TIER_LOW_MODEL` | current model | `provider/model-id` target for a demote. Unset → current model; empty/whitespace or absent from the registry → hold. |
| `PI_BADGER_JEV_TIER_MEDIUM_MODEL` | current model | `provider/model-id` target for a medium-tier answer (no actuation path). |
| `PI_BADGER_JEV_TIER_HIGH_MODEL` | current model | `provider/model-id` target for an upgrade. Unset → current model; empty/whitespace or absent from the registry → hold. |

## Policy defaults

These are frozen constants in the code — not env-tunable:

| Setting | Value |
|---|---|
| Tool probability floor | `0.2` (`TOOL_PROB_FLOOR`) |
| Tool confidence gate | `0.7` (`TOOL_CONFIDENCE_GATE`) |
| Upgrade confidence gate | `0.6` (`UPGRADE_CONFIDENCE_GATE`) |
| Demote confidence gate | `0.85` (`DEMOTE_CONFIDENCE_GATE`) |
| Short-prompt threshold | `12` non-whitespace characters (`MIN_PROMPT_CHARS`) |
| Request timeout | `2500` ms (`REQUEST_TIMEOUT_MS`) |
| Session cache | LRU cap `50` entries (`CACHE_MAX_ENTRIES`), key `(promptHash, catalogueHash, modelId)`, no TTL |
| State / prompt / criteria budgets | `8192` bytes / `2000` chars / `200` chars |

The cache is invalidated by a catalogue change, a foreign `model_select`, a
`router-fallback` switch notice, `/decisions reset`, and session shutdown.
A `429` arms the `Retry-After` cooldown, clamped to 60 s–1 h.

## Fallback

The alpha endpoint lives behind the injected classifier seam. Any transport,
parse or status failure degrades to the deterministic fallback classifier
(bounded word-part tool match, tier always holds, route always `none`), which
is recorded observe-only in `/decisions status` — the tool set and the model
stay untouched. A missing or empty key is a silent no-op: no request is sent
and no fallback record is made. Every error path leaves the session unchanged;
the stored `lastError` line is capped at 120 characters, and the key, headers,
bodies and prompt text never reach any log surface or shadow-ring entry.

## Commands

`/decisions [status|off|on|check|shadow|reset]`

- `status` (default) — config, key presence, last decision + reason, fallback
  note, `lastError`, cooldown, latch, cache size/hits, cost, ring size.
- `off` / `on` — session override; env kills still apply.
- `check <prompt>` — decide now, bypassing cooldown and cache (not the
  kill/key/session/prompt gates).
- `shadow` — recent routing records (choice, confidence, prompt hash).
- `reset` — clear cache, cooldown, errors, latch and ring for this session.

## Handler order

The single async `before_agent_start` handler applies **tools → model →
routing-log**, each step independently fail-open. Tool changes go through
`setActiveTools` only; the handler never mutates
`systemPromptOptions.selectedTools` (in pinned pi 0.84.4 the
`BeforeAgentStartEventResult` surface carries only `message`/`systemPrompt`,
and handler results are contained in `runner.js:881-930`). The model step
calls `setModel` with a single positional full registry model resolved from
the configured `provider/model-id` target (session-only, never persisted) and
sets the thinking level only after the model lands; a declined, missing,
unparseable or unresolved target holds that step without touching the others.
