# REVIEW FOLDS (normative) — plan review MoE d-493/d-494/d-495, folded 2026-09-05

This file OVERRIDES the three lane docs where they conflict. Lane docs are frozen history;
implementation briefs embed this file's normative content. Sources: `/tmp/d-493-review.md`
(code-reviewer, structure/feasibility), `/tmp/d-494-review.md` (qa, testability),
`/tmp/d-495-review.md` (delegator, arbitration/budget). Later evidence wins on conflicts;
each override names its basis.

## F0 reading order for implementers

`2026-router-failure-free-model-fallback.plan.md` (map) → THIS FILE (normative delta) →
lane docs (detail). Hypotheses: architect §6 + providers §5 + tests H1–H5 stand, plus F0-H below.

## F1 join rulings (final)

- **J1 ADOPT-B:** no `registerProvider` for defaults (groq/google/openrouter are built-ins;
  registering a builtin id risks full model-list replacement, `provider-composer.js:124`).
  Registration reserved for custom/keyless overlays. Architect §1-table + §4 seam text updated accordingly.
- **J2 ADOPT-B:** Gemini via native built-in (`googleGenerativeAIApi`, baseUrl `…/v1beta`), zero knobs.
  The `/v1beta/openai/` compat route is a rejected opt-in example only.
- **J3 ADOPT-B + freeze:** corrected IDs everywhere —
  `groq/llama-3.3-70b-versatile`, `google/gemini-3.1-flash-lite` (+escalation `gemini-3.1-pro-preview`),
  OpenRouter chain `z-ai/glm-5.2:free → poolside/laguna-s-2.1:free → minimax/minimax-m3:free →
  thinkingmachines/inkling-small:free`. Stale IDs (`gemini-3.1-flash`, `gemini-3.1-pro`,
  `google/gemini-2.0-flash-exp:free`) appear ONLY as C15 regression fixtures. Guards: H7
  (free-entitlement probe) + H8 (0.84.4-vs-0.85.1 diff) are PKG-E entry gates.
- **J4 THIRD-WAY:** extension `agent_end` payload is `{messages}`-only (`types.d.ts:555-558`;
  `willRetry` attaches on the session-bus emit at `agent-session.js:386`, stripped at `:473-474`).
  Wiring RECOMPUTES retryability via PKG-A (`recomputeRetryability(lastAssistant)` mirroring
  `_isRetryableError`: overflow pre-check + retry.js order — NEW PKG-A export). W9 rewritten (F3).
- **J5 THIRD-WAY:** folded-`errorMessage` ONLY (no hook carries chunks/bodies; `sdk.js:217-226`).
  Folded shapes for the two streaming cases: `"Provider finish_reason: error"` and
  `"Stream ended without finish_reason"` (verified: chunk loop never reads `chunk.error`;
  `finish_reason:"error"` folds via `mapStopReason` dropping code/wording; choiceless 200-envelope
  falls through to the generic marker). Expected kinds are **hold+notice, never billing-fallback**
  (generic markers carry no billing signal; matching them as billing would also catch
  `content_filter`). C4/C5 reframed (F3). One-off probe (Lane A pre-merge): stub-fetch canned
  SSE/200-envelope through installed pi-ai `streamSimple`, paste captured `errorMessage` into
  fixtures. Reopen condition: a demonstrated folding-bypass transport reinstates a branch as a
  NEW row with its own RED (H2 owns this).
- **J6 ADOPT-A:** 5-kind vocabulary `billing-exhaustion | throttle | auth | model-unavailable |
  not-fallback` (architect A1). C1 429-without-billing → `throttle` (+cooldown-only assert, zero
  `setModel`); C2 → `billing-exhaustion`; C3 → `auth`; C7 kept, renamed `model-unavailable`;
  C6/C9 → `not-fallback`; C10 kept reworded (order-pin). Tests seam-1 signature replaced with
  architect A1's `classifyFailure({errorMessage, afterProviderStatus})`. F-rows stay decoupled via
  the P4 mapping table (F2).
- **J7 ADOPT plan.md proposal:** `PI_BADGER_ROUTER_FALLBACK` (master, `"0"`=off, unset=on) +
  `PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES` (default 1/episode), read per call/event (monitor
  `PI_BADGER_MONITOR_POLL_MAX` precedent: unset/empty→default-on, `0`→off). G1/G2 renamed; G1 keeps
  set-after-init ordering + literal `"0"` + `on→off→on` sequence (qa H-Q5). Grep guard: `PI_ROUTER_FALLBACK`
  (without `PI_BADGER_` prefix) must be empty in tests+extension.
- **J8 ADOPT-A refined:** shared `pi.events` bus mechanism, DISTINCT event name `router-fallback`
  (same-channel emit would trip monitor's `isTransitionPayload` guard). Constant owned+exported by
  PKG-B (`extensions/router-fallback/index.ts`). W8/I2 assert emit on `router-fallback` + assert
  `delegation-transition` untouched; same-channel emit is the reddening mutation. Bus payload frozen
  (N1): `{episodeId, kind, reason, from{provider,model}, to{provider,model}, servedBy[]}`.

## F2 canonical contracts (supersede ALL lane seam texts)

- **PKG-A exports:** `classifyFailure({errorMessage, afterProviderStatus}) → {kind (5, F1-J6), reason}`,
  `recomputeRetryability(lastAssistantMessage) → boolean` (NEW, J4),
  `shouldSwitch(state, classification, now) → {switch|hold}` — episode one-shot + kill-switch ONLY
  (the `cooldown` action is REMOVED; M2: cooldown lives in the PKG-C selector),
  cap/kill helpers (`isDisabled`, `clampCooldownMs`, 8KB cap).
- **PKG-C owns (canonical, M1/M9):** `isEligible`, `resolveTargets`, `decideNextTarget(state, event) →
  {entry, model} | {none, reason}` (+`getServingProvider`, `requiredThinking`). `recordOutcome`
  (architect seam) is DELETED. F-rows target `decideNextTarget` (try≈`{entry,model}`,
  wait≈`{none, reason+retryAfterMs}`, exhausted≈`{none, terminal-reason}`).
- **P4 MUST contain the A1-kind→selector-action table (S3):** billing-exhaustion→advance+try;
  auth→advance-if-configured-else-notice; throttle→wait (cooldown-only, NEVER model switch);
  model-unavailable→intra-provider model rotate, then advance; not-fallback→hold.
- **Execution assignment:** try/advance executes in PKG-B ONCE (M3: providers P2.3's gate moves into
  PKG-B's extension test; P2 keeps the `isEligible` pre-filter). `Retry-After` assigned to PKG-C
  (M4: pure parse in selector, `wait=max(retryAfter,cooldownMs)`); B1 latches `headers` alongside
  status. `/models` fetch policy assigned to PKG-C P3 (S4) WITH S-cut: v1 ships pinned-first +
  `modelRegistry.find` filter; the fetch (timeout/offline/never-block-hot-path) is specified now as
  the follow-up's contract, implemented later.
- **`requiredThinking` (S2):** `ThinkingLevel`-only for reasoning targets, `undefined` for
  non-reasoning (skip the call; session auto-clamp already landed on off). Extension
  `setThinkingLevel` excludes `"off"` (`types.d.ts:1013`).
- **W3 restated (S1):** extension `setModel(model)` takes NO options (`types.d.ts:1006`,
  `loader.js:339-341`) — `persist:true` is structurally unpassable through wiring. W3 asserts argv
  shape (`setModel` called with exactly the model arg) as a regression guard, on the pi-level call
  log after `await flush()`, plus rejection twin (`setModelFn→rejects` advances, never throws).
  The REAL never-persist guard is the `settingsManager.setDefaultModelAndProvider` spy (W17, qa P-P4a).
- **Factory-deps mapping (N2):** PKG-B maps env/config→selector state; tests inject selector state
  directly. One sentence to that effect belongs in PKG-B.
- **`registerProviderFn` test dep survives J1** (N3) for the custom/keyless path; defaults never call it.
- **H3 downgraded (N6):** a `message_end` error→stop rewrite likely WOULD suppress retry (static path
  traced) — react-over-rewrite stands for the stronger reason (rewrite would blind `agent_end`
  detection + dirty history + kill legitimate transient retries). W1 unchanged (return `undefined` +
  zero-`setModel`-during-`message_end`).

## F3 rewritten test rows (replace lane-doc versions)

- **W9′ (J4):** no `willRetry` key anywhere. Retryable twin: `agent_end` with trailing
  `500 Service Unavailable` (no billing substring, no overflow) under default retry settings →
  0 `setModel` calls; then `agent_settled` (same messages) → switch proceeds per recomputation.
  Billing twin: `agent_end` with `402: payment_required: insufficient credits` → exactly 1 call
  (act-point `agent_end` per architect B1). Mutation: remove recomputed-retryability guard (every
  `agent_end[error]` switchable) → first sequence yields 1 call (RED with call log + received kind).
  Companion core row: `recomputeRetryability` mirrors `_isRetryableError`.
- **C4′ (J5):** fixture `match({errorMessage:'429: Rate limit exceeded … "error":{"code":429} …
  "finish_reason":"error"', afterProviderStatus:200})` → `throttle` (+cooldown-only). Mutation:
  delete folded-`finish_reason` substring alternative. Reason must contain `finish_reason` (C11 twin).
  HYPOTHESIS: exact folded SSE wording — settled by the F1-J5 stub-fetch probe.
- **C5′ (J5):** fixture `match({errorMessage:"402: payment_required: insufficient credits…",
  afterProviderStatus:200})` → `billing-exhaustion`. `body?:unknown` DELETED from matcher input.
  Mutation: delete billing-substring/prefix branch → RED `not-fallback`.
- **C8′ (qa, two twins + forbid):** (i) prefix twin (existing) → `billing-exhaustion` via prefix;
  (ii) substring twin: `"429: "+"y".repeat(100)+"insufficient_quota"` truncated to 4000, keyword inside
  window, prefix stripped → must match via substring; (iii) tests call `match(string)` ONLY — any
  `body` arg is a failure. Mutations one-per-twin.
- **C2′ (qa):** kind `billing-exhaustion`, folded fixture
  `match({errorMessage:"402: payment_required: insufficient credits…", afterProviderStatus:402})`,
  split mutations (delete `payment_required` only; delete `insufficient credits` only).
- **W5′ (S2-corrected):** reasoning twin (spy called) + non-reasoning twin: switch to Groq
  `llama-3.3-70b-versatile` (`reasoning:false`) → `setTimeThinkingLevel` NOT called (auto-clamp),
  model landed. (qa's `assert setThinkingLevel("off")` is UNBUILDABLE — type excludes `"off"`.)
- **G1′/G2′:** renamed knobs (F1-J7) + literal `"0"` + `on→off→on` + grep guard; G2 keeps `=0/=1`
  asserts + per-call twin (set `=1` after init, two episodes, second holds).
- **W8′/I2′ (J8):** assert `{channel:"pi.events", event:"router-fallback"}` + `delegation-transition`
  untouched + `pi.commands.has("fallback")` + renderer registered; mutations: delete emit (RED:
  no entry), emit-on-`delegation-transition` (RED: foreign entry), delete `registerCommand`,
  delete `registerMessageRenderer`. I2 additionally: 3-factory load →
  `handlers.get("session_shutdown").length>=3` (N5: test-engineer confirms non-vacuous at impl-review).
- **I4 (new, qa):** `--check` purity — `bun publish.ts --check` writes nothing
  (`git status --porcelain` empty for the installed tree).
- **I3 widened (qa):** secret grep `sk-|gsk_|sk-or-|AIza|xoxb` over `extensions/router-fallback/`, empty.
- **F4′ (qa):** add cooldown-dominates twin (`Retry-After:1` + `cooldownMs:60000` → `60000`), `_ms` asserts.
- **F5′/F6′/W1′/W2′/C15/F9/F10/W17** per qa §2–§3 (adopted as written, with S1/S2 corrections above).

## F4 new coverage rows (qa §3, PKG-D-owned; adopted with sketches as normative)

C12 provider-prefix `OpenRouter (402): …`→`billing-exhaustion` · C13 metadata-tolerant substring
(whitespace/new-field injected) · C14 overflow+billing→`not-fallback` (order-pin) ·
W10 auth-single-provider→hold+notice (zero eligible → 0 `setModel` + notice sent) ·
F7 throttle→cooldown (`setModelFn` 0, `shouldSwitch`→`cooldown`) ·
F8 503→same-provider next model (not next provider) · W11 episode re-arm (`settled`/`reset` reopen) ·
G4 `clampCooldownMs` + 8KB cap · W12 402-latch OR (either input suffices; latch alone → 0 calls
until `agent_end`) · W13 tag-only `before_provider_request` + `model_select{source:"set"}` confirm ·
W14 `getServingProvider()` tracks advance-on-`false` · W15 command surface (reset re-arms, off/on,
completions `status|reset|off|on`, both modes) · W16 lazy-arm (0 timers/subs until first
failure/command) · C15 schema rejects bad custom + stale IDs resolve-or-skip (never throw) ·
F9 all-keys-unset → `eligible []` + `no fallback auth` + 0 `setModel` · F10 rotated head
(`find→undefined`) serves second entry · W17 `settingsManager.setDefaultModelAndProvider` spy 0 ·
G4/I4 as above. Full mutation+gate per row: qa §3 table (verbatim sketches).

## F5 packaging/docs/lines (corrections)

- `EXTENSION_DIRS` lives at **`publish.ts:70`** (verified by orchestrator + code-reviewer S6;
  architect `:29` and providers `:75` are both wrong). Correct both refs.
- Single README author in PKG-E (S5; overrides providers P5 + architect E4 dual-authorship —
  P5's provider table becomes input text).
- H-Q1–H-Q5 fixes adopted (qa §4) EXCEPT H-Q3's exact-options-identity demand (dropped per S1;
  drain + pi-level-log + rejection-twin parts kept).
- N4 stale line refs (union `:813`, replacement `:509-527`, thinking `:1408-1423`) noted, design-neutral.
- S-cut STANDS (delegator §2, required for 4-lane shape): P3 v1 = pinned chain + `find` filter;
  live `/models` re-fetch + keyless-registration probe (H11) are named follow-ups; H7/H9/H10/H8 are
  one-off captures gating PKG-E, never lanes. S2 (keyless docs/schema-only) confirmed, no edit.
- M11 (H8+H7 as PKG-E gates) confirmed. M12 intent kept (two-layer persist guards: W3 argv-shape +
  W17 setter-spy).
- N5 carried: test-engineer confirms I2 non-vacuous at impl-review.

## F6 implementation sequence (delegator §3, unchanged)

Fold blockers (this file) → Lane A (PKG-A; exits frozen exports + 5-kind vocabulary; J5 probe included)
→ Lanes B ∥ C (B needs A signatures; C needs trigger contract + skeleton marker names on paper;
C pure hunks may merge alongside B, C wiring hunks merge AFTER B; C ships post-S-cut scope)
→ Lane E (needs A+B+C merged + H8/H7 probes; exits publish one-liner + README + I1–I4 + full suite).
RED-evidence assignment: A: C1–C15 (+C11 reason twins); B: W1–W17 + G1–G4 + I2; C: F1–F10 + C15 +
I3 greps; E: I1–I4 + full `bun test` once + `bun run check` exit 0.

## F0-H new hypothesis from review

- **F0-H1 (code-reviewer J5 scope):** openai-SDK-throw branch shapes inside the stub-fetch probe scope —
  settled by the same probe. **F0-H2:** exact `setModel` argv shape (object vs positional) — verify
  against `agent-session.js:1254-1270` at Lane B build; W3/W14 fixtures use the verified shape.
- **F0-H3:** bus channel string + `fire("agent_end")`/`fire("agent_settled")` support in
  `tests/helpers/fake-pi.ts` (qa assumes `handlers` arrays + manual-scheduler map) — Lane B verifies
  on first touch; if absent, extend fake-pi (not the plan).
