# Plan: router-failure free-model fallback (`pbi-router-failure-free-model-fallback`)

High-effort. MoE plan panel: architect (d-490) + api-engineer (d-491) + test-engineer (d-492).
Lane docs (read all three; this file is the map + the combination check):
- `2026-router-failure-free-model-fallback.plan-architect.md` — overall split, PKG-A (pure matcher), PKG-B (wiring/switch/command), PKG-E integration
- `2026-router-failure-free-model-fallback.plan-providers.md` — PKG-P1..P5 (schema, defaults, auth, resolution, policy, packaging/docs seams)
- `2026-router-failure-free-model-fallback.plan-tests.md` — test rows C1–C11, F1–F6, W1–W9, G1–G3, I1–I3 + honesty H-Q1–H-Q5
- Research: `2026-router-failure-free-model-fallback.research.md` + `/tmp/d-487-report.md` + `/tmp/d-488-report.md` + `/tmp/d-489-report.md`

## Package map (mergable units; last = integration)

| Pkg | Files | Owner lane | Entry gate |
|---|---|---|---|
| PKG-A pure matcher (`router-fallback-core.ts`: `classifyFailure`, `shouldSwitch`, caps/kill helpers) | new, `extensions/router-fallback/` + `tests/router-fallback/` | architect §2 | d-487 payloads + retry.js vocabulary in hand |
| PKG-B wiring (`index.ts`: observers, switch, `/fallback`, lifecycle) | new, same dirs | architect §3 | PKG-A signatures frozen (same author, may overlap) |
| PKG-C provider/config (`fallback-providers.ts`: schema, defaults, `isEligible`, `resolveTargets`, `decideNextTarget`, `getServingProvider`, `requiredThinking`) | new, same dirs | api-engineer §1 (P1–P5) | needs architect skeleton markers + trigger contract (serialises on those two points only) |
| PKG-D test-matrix ownership | `tests/router-fallback/` | test-engineer (rows = input, judges sufficiency) | runs alongside all |
| PKG-E INTEGRATION (publish.ts one-liner, package.json, cross-package tests, README) | `publish.ts:29`, README, repo package.json | architect §7 | serial after A+B+C |

Top-level AC: every package AC checked+met (`bun test` touched surface once per change, `bunx tsc --noEmit -p .`, `bun run check` exit 0 after E).
Shared-file serialisation: only PKG-E touches `publish.ts` / README / repo package.json — A/B/C are conflict-free until E.

## Join conflicts (orchestrator's combination check — review MoE rules on each)

- **J1 `registerProvider` for defaults.** Architect §4/PKG-C seam says "`pi.registerProvider` wiring"; providers lane C5/R1 (catalog-verified) says NO registration for defaults — groq/google/openrouter are all built-in (`types.d.ts:19`), registration only for custom/keyless overlays. Proposed: adopt R1; PKG-C drops registration for defaults. Reviewer: confirm or overturn with catalog evidence.
- **J2 Gemini route.** Architect cites d-488's `/v1beta/openai/` compat knob; providers lane C3 corrects to native built-in, zero knobs (compat route = rejected opt-in example). Proposed: adopt C3. Reviewer: confirm.
- **J3 Corrected default IDs.** Providers lane C1/C2: `gemini-3.1-flash(-pro)` and `google/gemini-2.0-flash-exp:free` do NOT exist in pi 0.85.1's catalog; corrected to `gemini-3.1-flash-lite` / `gemini-3.1-pro-preview` / `z-ai/glm-5.2:free`. Architect §4 still cites d-488 §2 uncorrected. Proposed: corrected IDs everywhere + C1/C2 regression fixtures (tests lane offers them). Reviewer: confirm the freeze + H7/H8 probes.
- **J4 `willRetry` on the extension payload.** Architect §0 correction: `willRetry` proven on session-bus emit, NOT on extension `agent_end` payload — recompute via PKG-A. Tests lane W9 keys off `agent_end.willRetry===true`. Proposed: W9 rewritten to recomputed-retryability-or-settled (no payload field). Reviewer: rule + state the exact rewrite.
- **J5 SSE / 200-with-error scanning.** Architect §5.4: redundant, folding already happens (`openai-completions.js:497-527`) — scan folded `errorMessage` only. Tests lane C4/C5 demand chunk-scan + body-scan branches. Proposed: C4/C5 fixtures become folded-message shapes (verbatim content preserved, observed at `message_end`), unless a reviewer shows a transport that bypasses folding. Reviewer: rule with transport evidence.
- **J6 Trigger-kind naming.** Architect A1: 5 kinds (billing-exhaustion/auth → switch; throttle → cooldown-only; model-unavailable → model-rotate; not-fallback). Tests lane: binary + C7 503→`model-switch-only`. Proposed: adopt A1 vocabulary; C-rows reworded, C7 kept. Reviewer: confirm naming + that F-rows (cooldown) and C-rows (matcher) stay decoupled.
- **J7 Env var names.** Architect A3: `PI_BADGER_ROUTER_FALLBACK[_MAX_SWITCHES]`; tests lane G1/G2: `PI_ROUTER_FALLBACK_ENABLED` / `PI_ROUTER_FALLBACK_MAX_SWITCHES`. Proposed: `PI_BADGER_` prefix (monitor `PI_BADGER_MONITOR_POLL_MAX` precedent), exact names `PI_BADGER_ROUTER_FALLBACK` (master, `0`=off) + `PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES` (default 1/episode). Reviewer: confirm.
- **J8 Bus channel.** Architect: new `router-fallback` name on the shared `pi.events` bus; tests lane I2/W8: shared `TRANSITION_CHANNEL` constant. Proposed: same bus mechanism (`pi.events.emit/on`), distinct event name `router-fallback` (no second bus). Reviewer: confirm + name the constant owner (PKG-B).

## Merged hypotheses (probes named; unit work unblocked via fixture stand-ins)

H1 live-402 capture (owner: whoever probes before PKG-A merge) · H2 WS-transport probe (402-latch is OR-input, folded path suffices) ·
H3 message_end-rewrite probe (W1 pins react-over-rewrite either way) · H4 mid-turn-setModel probe (W9 pins deferred either way) ·
H-pi84/H8 0.84.4-vs-0.85.1 diff (PKG-E gate, blocks final ID freeze) · H-free model IDs/quotas/tool flags (overridable config, C1/C2 fixtures) ·
H5 ZDR-503 (model-switch, not key-rotation) · H6/H11 keyless-custom probes (custom-only until proven) · H7 Gemini free entitlement (swap default if fails) ·
H9 Referer/X-Title optionality (add statically on failure) · H10 cooldown/retry/timeout tuning (user-overridable).
Full statements + probes: architect §6, providers §5, tests H1–H5.

## Budget arithmetic (for reviewers)

Spent: research 64452 (cache-excluded) + plan lanes pending record (d-490/491/492 usage in subagent logs).
Remaining estimate: review MoE (3) + implementation (3–4 lanes: A, B, C, E; D cross-cutting) + impl-review MoE (3) + fixes + QA.
Cost control: hermetic fixtures (no live keys in unit suite), touched-surface runs per change, one full `bun test` before merge.

## For the review MoE

Attack structure, feasibility, budget arithmetic, testability. Rule on J1–J8 (MUST/SHOULD fold list).
Fold MUST/SHOULD findings back into the three lane docs before any implementation dispatch.
