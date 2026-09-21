# ADR — decision-router: one Jev 1.13 pre-flight call for tools, model tier and shadow routing

Status: **ratified in-lane** (task `pbi-jev-routing-tool-model-selection`, 2026-09-21).
Scope: `extensions/decision-router/{decision-router-client.ts,decision-router-core.ts,index.ts}`,
the P4 integration files, and `tests/decision-router/*`. Research records:
`docs/work/2026-09-21-typesafe-jev-routing-tool-and-model-selection.md` (RES) and
`docs/work/2026-09-21-jev-decision-router-implementation-seams.md` (SEAMS); plan v2
(`2026-09-21-pbi-jev-routing-tool-model-selection.md`) wins on every conflict and its
rulings R1–R15 are restated below.

## Context

A pi session has three recurring pre-flight decisions: which tools a turn needs, which
model tier is sufficient, and which skill should handle it. Nothing in the repo answers
them in-session — `router-fallback` reacts *after* a provider failure, and the extension
trees own no selection logic. RES measured TypeSafe Jev 1.13 on OpenRouter's alpha
decisions endpoint as a usable classifier: `{state, questions}` in, typed answers plus
per-option probabilities out, ~0.47–0.89 s per call, ~$0.000015–0.000020 per call, up
to 255 options per choice question (RES F1–F6). SEAMS then established that the pinned
pi 0.84.4 already exposes every needed seam: `before_agent_start` with the raw prompt
and async handlers, `getAllTools`/`getActiveTools`/`setActiveTools`, `setModel`,
`setThinkingLevel`, one `EXTENSION_DIRS` registration array, and injectable-fetch test
precedent. The design problem is therefore not capability but **risk posture**: an
alpha endpoint, a probabilistically wrong answer, and a turn path that must never break
a session or burn priced calls on noise.

## Decision

### Rulings R1–R15

| # | Ruling |
|---|---|
| R1 | Extension name `decision-router` — provider-neutral; the vendor stays behind the alpha-endpoint classifier seam. |
| R2 | One extension, one `before_agent_start` handler, ONE fanned-out Jev call per enabled distinct turn. |
| R3 | Two pure modules — `decision-router-client.ts` (types, builders, parser, injected-fetch classifier) and `decision-router-core.ts` (skip chain, policy, cache keys) — plus `index.ts` wiring. Both pure modules carry zero ambient I/O (banned-token gate below). |
| R4 | Request timeout 2500 ms (`PI_BADGER_JEV_TIMEOUT_MS`, clamped non-positive/garbage back to 2500), no in-turn retry; a 429 arms the `Retry-After` cooldown clamped to 60 s–1 h. |
| R5 | Session cache: key `(promptHash, catalogueHash, modelId)`, no TTL, LRU cap 50. Invalidated by catalogue change, foreign `model_select`, `router-fallback` switch, `/decisions reset`, shutdown. No general cooldown. |
| R6 | Env surface: `OPENROUTER_API_KEY`; `PI_BADGER_DECISION_ROUTER` + `_TOOLS`/`_MODEL`/`_ROUTING`; `PI_BADGER_JEV_MODEL`, `_ENDPOINT`, `_TIMEOUT_MS`, `_TIER_LOW_MODEL`/`_MEDIUM_MODEL`/`_HIGH_MODEL`. Only the literal `"0"` disables. Thresholds are constants, not env. |
| R7 | Tools are ADDITIVE: `enabled = active ∪ {p ≥ 0.2}`, applied only when top confidence ≥ 0.7; already-enabled subsets hold; an unknown winner rejects the whole question; narrowing is deferred. |
| R8 | Tier is asymmetric: `high` + confidence ≥ 0.6 upgrades, `low` + confidence ≥ 0.85 demotes, `medium`/off-rubric/missing hold; already-on-target holds; the fallback switch latch blocks upgrades only. |
| R9 | Routing is SHADOW ONLY: record `{question, choice, confidence, promptHash}`; no enforce path and no flag. |
| R10 | Skip chain (in order): kill switches → session off → missing key → cooldown → slash-prefixed → marker-prefixed → short prompt (< 12 non-whitespace chars) → in-flight → cache hit. Queued follow-ups do not refire the hook. |
| R11 | The handler never throws; per-question rejects degrade that question only; every error path leaves the tool set and model untouched; the error vocabulary is frozen (`misrouted-refusal`, `auth`, `billing`, `rate-limited`, `server`, `transport-timeout`, `malformed`, `missing-key`). |
| R12 | Parser is fail-closed: missing confidence → 0, missing probabilities → winner-only confidence 0, non-catalogue winner rejects, probabilities clamp into [0,1], unknown extra fields ignored at body and answer level, nothing throws. |
| R13 | `router-fallback` non-interference: disjoint phases, a foreign or fallback model change invalidates the cache, no revert, and the switch latch forbids upgrades until a clean settled turn. |
| R14 | Tests are hermetic: `createFakePi` plus injected deps, measured fixtures from `fixtures/raw` (SYNTH-labelled where stipulated), and every hold/no-op row asserts spy-uncalled + snapshot-identical + branch-ran. |
| R15 | Integration: `publish.ts` `EXTENSION_DIRS`, zero-dependency `package.json`, extension README, catalog section, repo README row, this ADR, cross-package tests. No shutdown `appendEntry`. |

### Policy detail

- **Fan-out.** One body carries the task state plus a `tools` choice question (live
  catalogue, names sorted, descriptions truncated uniformly to fit 8192 bytes —
  over-budget holds as `catalogue-over-budget`), a `tier` choice over the frozen rubric
  (`low`: mechanical/single-file/rename; `medium`: multi-file judgement; `high`:
  design/debugging/architecture), and, for routing, a `skill` choice over the turn's
  model-invocable skills plus `none` with a `needs_subagent` noul companion. Disabled
  capabilities are omitted from the fan-out, never answered locally.
- **Tool apply.** The wiring calls `setActiveTools([...active, ...enable])` in sorted
  unique order; the winner is validated against the live catalogue but is not
  force-included — its probability entry decides like every other option. An empty
  subset and an already-enabled subset hold.
- **Model apply.** `setModel` receives exactly one positional `{provider, id}`; the
  thinking level is set only after the model call returns true. A decline
  (`set-model-declined`) or throw (`apply-failed`) holds that step alone.
- **Skip chain.** Implemented in `evaluateTurn` in R10 order; kill switches resolve
  per capability first (a partial kill narrows the fan-out, it does not skip the turn).
  The `/decisions check` command bypasses cooldown and cache only.
- **Logging.** The shadow ring stores `promptHash` only; `lastError` is capped at 120
  characters; the key, headers, bodies and prompt text never reach a log surface.

### Verified pinned API surface (F2, re-checked in-worktree)

Repo pin: `package.json` devDependency `@earendil-works/pi-coding-agent` = `0.84.4`
(`bun.lock` resolved 0.84.4). All lines below were re-read in this worktree after
`bun install`, not recalled from docs:

| Surface | Evidence |
|---|---|
| `BeforeAgentStartEvent` carries the raw `prompt` | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:539` |
| Async-capable handler (`Promise<R \| void> \| R \| void`) | `…/dist/core/extensions/types.d.ts:902` |
| `before_agent_start` registration signature | `…/dist/core/extensions/types.d.ts:923` |
| `ToolInfo` (name/description/parameters/guidelines + source) | `…/dist/core/extensions/types.d.ts:1192` |
| `ctx.getModel()` | `…/dist/core/extensions/types.d.ts:1261` |
| `selectedTools` / `skills` in system-prompt options | `…/dist/core/system-prompt.d.ts:9,24` |
| `ThinkingLevel` union (`off`…`max`; we use low/medium/high) | `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:261` |
| `prompt()` awaits `emitBeforeAgentStart` before the loop | `…/dist/core/agent-session.js:915` |
| `setActiveToolsByName` rebuilds tools + system prompt | `…/dist/core/agent-session.js:659-672` |
| Extension-level `setModel` returns false without configured auth | `…/dist/core/agent-session.js:2043-2048` |
| Handler repetition is contained (a throw becomes an extension error, never a turn crash) | `…/dist/core/extensions/runner.js:881-930` |

`BeforeAgentStartEventResult` in the pinned version carries only `message` and
`systemPrompt` (`types.d.ts:845`), and the runner applies only those two keys — hence
the deliberate rule that the handler mutates the tool set through `setActiveTools`
alone and **never** writes to `systemPromptOptions.selectedTools`.

### Hook-semantics probe

`setModel` inside an async `before_agent_start` is the one seam F2 could not prove live.
The manual probe is committed at `tests/decision-router/probe/hook-probe.md`; it is
**not run in-pipeline** because spawning `pi` is blocked by the repo's delegation-skip
guard. The probe covers tools actuation, tier pre-flight, fallback non-interference and
kill-switch/privacy behaviour. If a live run shows the model step declining or throwing
while tools and routing still work, the documented fallback is the
**thinking-level-only path**: keep tier answers wired to `setThinkingLevel` alone and
record the decline as a follow-up; the wiring already isolates that step.

### Module size

Plan v2 R3 set ~500 lines per module as a cohesion guideline.
`decision-router-client.ts` is **635 lines** — one cohesive contract file (types,
builders, parser, classifier, fallback) — and was kept whole rather than split further;
`decision-router-core.ts` (395) and `index.ts` (650) remain within their intended roles.
The client is under watch: revisit the split if it grows beyond this contract.

## Consequences

- **What ships.** `/decisions status|off|on|check|shadow|reset`, additive tool
  actuation, the asymmetric tier path (only live when tier targets are configured), and
  a shadow ring for routing. Tool selection can only widen the active set; routing can
  only observe.
- **What is deliberately absent.** No routing enforcement, no tool narrowing, no
  persisted model change, no general cooldown, no shutdown `appendEntry` — each was
  cut in plan v2 (F24) and lives under follow-ups instead.
- **Failure is per-step.** A dead endpoint, a malformed body, a missing key, or a
  thrown setter degrades that step and leaves the session exactly as it was; the
  deterministic fallback classifier is recorded observe-only, never actuated.
- **Cost/latency.** One ~$0.000015–0.000020, ~0.5 s call per *enabled distinct* turn;
  the cache and the skip chain keep noise and repeats from spending budget.
- **Test economy.** Bundled fixtures are the source of truth for parser behaviour;
  a `bun test` run covers client, core, wiring and cross-package gates hermetically —
  no network, no wall clock, no real timers.

## Alternatives

- **`@typesafe-ai/sdk` instead of raw fetch.** Rejected: RES F10 found the first-party
  SDK targets `api.typesafe.ai` and it is unverified whether it accepts a base URL for
  OpenRouter's `/alpha/decisions` route; the hand-rolled request is ~30 lines behind an
  injected-fetch seam and keeps the zero-dependency directory package. Revisit if the
  base-URL override is confirmed.
- **Enforce mode for routing (act on the skill answer).** Rejected (plan v2 F24/R9):
  the route answer is the least validated of the three (RES F13); shadow records build
  the labelled corpus first, and the action type has no actuation variant, so an
  enforce path cannot be accidentally reintroduced.
- **Narrowing (`setActiveTools` to the subset only).** Rejected for v1 (R7): a wrong
  narrowing can starve the model of the tool it needs; additivity is the safe
  direction — a wrong widening costs a few tool tokens. Narrowing stays a follow-up
  once the probability floor has a labelled corpus behind it.
- **Cache TTL (10-minute expiry).** Rejected (plan v2 R5): the cache key already names
  every dependency (prompt hash, catalogue hash, model id), so time alone cannot make
  a stored decision stale; TTL would just spend calls for no correctness gain.
- **A 60 s general cooldown between priced decisions.** Rejected: distinct prompts are
  exactly what the feature exists to decide; throttling them would silently drop
  decisions. Only the server's own 429 signal (Retry-After, clamped) arms a cooldown.
- **The `score` primitive for a complexity number.** Rejected: RES F15 never exercised
  `score` (live evidence only exists for `choice`/`noul`), and the asymmetry lives in
  confidence gates on a discrete tier answer — a threshold on an unmeasured scalar
  would be invented precision.
- **Mutation of `systemPromptOptions.selectedTools` inside the hook.** Rejected on the
  pinned-API evidence above: the result surface does not carry it in 0.84.4, and the
  documented equivalent is `setActiveTools` (SEAMS F1/F2; RES F8).

## Deferred follow-ups

- **Labelled prompt corpus before tuning demotion.** RES F7 measured a tier answer that
  contradicted its own rubric, so the demote gate stays at 0.85 and no demotion tuning
  is legitimate until a labelled corpus (existing sessions replayed against known-good
  tiers) exists.
- **Narrowing mode** (remove tools, not just add) — needs the same corpus.
- **Routing enforcement** — revisit once shadow records show the routing answer is
  calibrated on this repo's prompts.
- **255-option live probe** — a real full tool catalogue was never sent to Jev (RES
  F15); the build-time guard and golden-body budget test pin our side only.
- **429/402 probe** — rate-limit and billing responses are SYNTH-stipulated
  (RES F15); a bounded live probe should confirm `Retry-After` presence and shape.
- **Data-retention terms** — where prompts/tool descriptions are retained by OpenRouter
  and TypeSafe is unchecked (RES F15); a privacy review gates any corpus work.
- **Live in-hook `setModel` probe** — `tests/decision-router/probe/hook-probe.md`;
  fallback is the thinking-level-only path.
