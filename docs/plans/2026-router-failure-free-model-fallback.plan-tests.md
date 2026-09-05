# Test plan — `pbi-router-failure-free-model-fallback` (TEST lane only)

Scope: TEST plan. Structure/detection owned by architect lane, provider/config schema owned by api-engineer lane — this plan names only the seams they must expose for testability. Read-only; no code written, no tests run.

Sources (absolute):
- `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-router-failure-free-model-fallback/docs/plans/2026-router-failure-free-model-fallback.research.md`
- `/tmp/d-487-report.md`, `/tmp/d-488-report.md`, `/tmp/d-489-report.md`
- Precedents: `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-router-failure-free-model-fallback/tests/monitor/monitor-core.test.ts`, `.../tests/monitor/monitor-extension.test.ts`, `.../tests/subagent-model-fallback.test.ts`, `.../tests/helpers/fake-pi.ts`, `.../extensions/monitor/monitor-core.ts`, `.../extensions/monitor/index.ts`, `.../extensions/subagent/index.ts`
- Gates: `bun test` (repo `package.json` script `test`), typecheck `bunx tsc --noEmit -p .`

Planned layout (mirrors `tests/monitor/`, `tests/subagent/`):
- `tests/router-fallback/router-fallback-core.test.ts` — pure matcher + failover selector, hermetic, injected `now`, no sleeps
- `tests/router-fallback/router-fallback-extension.test.ts` — wiring on shared `tests/helpers/fake-pi.ts` (`createFakePi`, mutable `FakeClock`, manual scheduler), injected `setModel/registerProvider/clock/scheduler/mode`
- `tests/router-fallback/router-fallback-guard.test.ts` — env kill-switches, per-call reads
- Cross-package row lives in `router-fallback-extension.test.ts` (combined load, cf. monitor M-B4/M-B5 precedent)

## Seams sibling lanes must expose (testability contract)

1. **Pure matcher** in `extensions/router-fallback/router-fallback-core.ts`: `(input: { status?: number; errorMessage?: string; body?: unknown; headers?: Record<string,string> }) => { kind: "router-failure" | "model-switch-only" | "no-match"; reason: string }`. node:vm-free pure, no clock, no pi import (monitor `monitor-core.ts` precedent). Matches **substrings + status prefix, never exact JSON** (bodies cut at 4000 chars per `error-body.js`).
2. **Pure failover selector** in same core: `(providers, state: { cooldownUntil: Record<id, epochMs>; attempts: Record<id, number> }, now) => { action: "try" | "wait" | "exhausted"; providerId?; retryAfterMs? }`. All time via injected `now`; `Retry-After` parsed in core (pure), waited on in wiring (manual scheduler).
3. **Factory with injected deps** in `extensions/router-fallback/index.ts`: `export default function (pi, deps?: { now?, scheduler?{setTimeout,clearTimeout}, setModelFn?, registerProviderFn?, maxSwitchesPerEpisode?, cooldownMs?, failurePatterns? })` (subagent `SubagentDeps` precedent, `extensions/subagent/index.ts`).
4. **Env gates** (names only, never secrets): `PI_ROUTER_FALLBACK_ENABLED` (master, `0`=off), `PI_ROUTER_FALLBACK_MAX_SWITCHES`, read **per call/event**, not cached at load (monitor `PI_BADGER_MONITOR_POLL_MAX` per-call precedent). Per-provider secrets only via `apiKeyEnv` name (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`), resolved with `getenv(apiKeyEnv)` at attempt time so unset-key skip is testable.

## Test rows

Gate shorthand: `G-core` = `bun test tests/router-fallback/router-fallback-core.test.ts`; `G-ext` = `bun test tests/router-fallback/router-fallback-extension.test.ts`; `G-guard` = `bun test tests/router-fallback/router-fallback-guard.test.ts`; `G-type` = `bunx tsc --noEmit -p .`. Expected output for every row unless noted: exit 0, `<n> pass, 0 fail`. RED evidence = the exact failing assertion output implementation lanes must paste before the fix.

### Package 1 — pure failure matcher (`router-fallback-core.test.ts`)

| # | Target | Failure mode it targets | Mutation proving it real | Gate + RED evidence required |
|---|---|---|---|---|
| C1 | 429 `rate_limit_exceeded` triggers | Throttled router misread as fatal/ignored, no fallback offered | Change `429` → `4290` in matcher table (or delete `rate_limit_exceeded` substring) | `G-core`. RED: `expect(match({status:429, errorMessage:"429: Rate limit exceeded…"})).toBe("router-failure")` fails with `Received: "no-match"` |
| C2 | 402 `payment_required` / credits wording triggers | Empty/no-token account (the headline scenario) missed because matcher keys on 429 only | Delete `payment_required` / `insufficient credits` alternative from pattern | `G-core`. RED: 402 fixture (`{code:402,…error_type:"payment_required"}`) returns `"no-match"`; test prints received kind |
| C3 | 401 `authentication` triggers | Expired/disabled key loops forever instead of failing over | Delete `authentication` alternative | `G-core`. RED: 401 fixture returns `"no-match"` |
| C4 | Mid-stream SSE `error` + `finish_reason:"error"` triggers despite HTTP 200 | Status-only detector misses streaming failures (d-487 verbatim SSE) | Remove the SSE/chunk-scan branch (status-only match) | `G-core`. RED: SSE chunk fixture (verbatim `data: {"id":"gen-abc123",…,"error":{"code":429…},"choices":[{…,"finish_reason":"error"}]}`) returns `"no-match"` |
| C5 | 200-with-`error`-body triggers | Post-header provider failure missed (status 200, body `{error:{…}}`) | Gate body scan on `status!==200` (i.e. `if status===200 return no-match`) | `G-core`. RED: `{status:200, body:{error:{code:402,…}}}` returns `"no-match"` |
| C6 | Negatives: 400/403/404 NEVER trigger | Request-side bug burns the whole fallback chain switching models that can't help | Widen trigger to `status>=400` | `G-core`. RED: each of 400/403/404 fixtures returns `"router-failure"`, expected `"no-match"` — paste which status leaked |
| C7 | 503 → `model-switch-only`, not `router-failure` (key rotation) | No-provider-availability (e.g. ZDR conflict) rotates keys pointlessly instead of switching model | Map 503 → `router-failure` | `G-core`. RED: 503 fixture returns `"router-failure"`, expected `"model-switch-only"` |
| C8 | Truncation at 4000 chars still matches | `formatProviderError` cut (`MAX_PROVIDER_ERROR_BODY_CHARS=4000`) pushes the keyword past the cut and the full-body test passes vacuously | Assert on `("x".repeat(5000) + "insufficient_quota")` prefixed with `"402: "` — then truncate input to 4000 in test before calling matcher | `G-core`. RED: truncated-input fixture returns `"no-match"`; the untruncated twin passing alone is NOT accepted as evidence (see honesty note H-Q1) |
| C9 | Context-overflow NEVER triggers fallback | Overflow (`maximum context length`, `prompt is too long` per `overflow.d.ts`) steals the compaction path and switches models instead of compacting | Delete the overflow-exclusion check | `G-core`. RED: overflow fixture (`"maximum context length is X tokens"`) returns `"router-failure"`, expected `"no-match"` |
| C10 | Intersection: 429 + billing text → fallback, non-retryable wins | `isRetryableAssistantError` order violated: 429-with-`insufficient_quota` sent to SDK retry (swallowed by `retry.provider.maxRetries>0` path) instead of fallback | Test non-retryable substrings BEFORE retryable ones; mutation = swap the two check blocks | `G-core`. RED: `429 + "insufficient_quota"` fixture classified retryable/`"no-match"`; paste received classification |
| C11 | Property intersection (secondary observable): match result carries `reason` naming the evidence | Matcher returns right kind for wrong reason (e.g. status fallback when the test meant body-scan) — green for the wrong reason | Return `reason:""` / constant reason | `G-core`. RED: `expect(result.reason).toContain("payment_required")` (or `"finish_reason"` for C4, `"status-prefix"` for C1) fails on empty/constant string |

### Package 2 — ordered failover selector (same pure file, `now`-injected)

| # | Target | Failure mode | Mutation | Gate + RED evidence |
|---|---|---|---|---|
| F1 | Cooldown, not disable | Transient outage permanently removes a provider; second episode has nowhere to go | On failure set `cooldownUntil=Infinity` (or delete expiry) | `G-core`. RED: `advance(now+cooldownMs+1); select()` still returns `wait/exhausted` instead of the recovered provider; paste both `select()` outputs |
| F2 | Skip unset-key providers, except keyless custom | Fallback attempts a provider with no key, stalls on auth instead of advancing | Stub `getenv`→always-set (or delete the skip branch) | `G-core`. RED: provider with `apiKeyEnv:"GROQ_API_KEY"` unset is selected (`action:"try"`) instead of skipped; keyless entry (`apiKeyEnv:""`) must still be selected — assert both in one test |
| F3 | `maxRetries` advances, exhaustion is terminal | One poisoned provider retried forever; chain never reaches Gemini/OpenRouter | Set `maxRetries=Infinity` in selector (or `attempts` never incremented) | `G-core`. RED: after `maxRetries+1` failures `select()` returns same provider instead of next; paste attempt counts |
| F4 | `Retry-After` honored (`wait = max(retryAfter, cooldownMs)`) | Burst burns Groq→Gemini→OpenRouter in one second; 50/day OpenRouter budget vaporized | Ignore `Retry-After` header (use `cooldownMs` only) | `G-core`. RED: header `Retry-After: 120` + `cooldownMs: 1000` yields `retryAfterMs: 1000`, expected `120000`; paste received ms |
| F5 | `enabled:false` skipped without reorder | Disabled provider still attempted, or list order mutated | Flip `enabled` check off | `G-core`. RED: disabled first provider selected; plus `expect(order).toEqual(original)` fails if implementation splices |
| F6 | Full exhaustion → `exhausted` + surfaced serving record | Silent stall when all three fail (no notice, no which-provider-served) | Return `wait` forever on empty eligible set | `G-core`. RED: all-cooldown/all-failed state returns `action:"wait"`, expected `"exhausted"`; companion assert `record.servedBy` chain length === attempts |

### Package 3 — extension wiring (`router-fallback-extension.test.ts`, fake-pi + manual scheduler)

| # | Target | Failure mode | Mutation | Gate + RED evidence |
|---|---|---|---|---|
| W1 | Act at `agent_end`/`agent_settled` level; NEVER rewrite `message_end` error→stop | Retry/compaction path suppressed by message rewrite (H3 unproven); prefer react-over-rewrite | Return `{message: fixed}` from `message_end` handler | `G-ext`. RED: handler return value is defined (expected `undefined`); plus assert `pi.setModel` (injected `setModelFn`) NOT called during `message_end`, only after `agent_end` — paste call log |
| W2 | `setModel→false` (provider auth unconfigured, `loader.js:339-341`→`agent-session.js:2050-2053`) advances, never throws | Unhandled `false`/throw aborts the episode on the first free provider | Stub `setModelFn`→`false` on first provider; mutation = `if (!ok) throw` or stop-the-chain | `G-ext`. RED: second provider never attempted (`setModelFn` call count 1, expected 2); paste call argv |
| W3 | Never persist (`persist:true` never passed; session-only) | Fallback silently becomes the default model for all future sessions | Pass `persist:true` in wiring | `G-ext`. RED: `expect(setModelCalls[0].options?.persist).not.toBe(true)` fails; paste captured options object |
| W4 | Prefer target inside `ctx.scopedModels` when non-empty | `/scoped-models` users surprised by out-of-scope switch (scope gates pickers, not `setModel` — lane verdict) | Empty the scope-preference branch (always pick global first) | `G-ext`. RED: with `scopedModels:[gemini-entry]` and global-first ordering, selected target is the out-of-scope one; paste selected `{provider, id}` |
| W5 | Thinking reclamp on reasoning targets (`setThinkingLevel`, non-reasoning→`"off"`) | Landing on reasoning model keeps stale level (or crashes); landing off-reasoning keeps thinking on | Remove `setThinkingLevel` call | `G-ext`. RED: `setThinkingLevel` spy call count 0 after switch to reasoning target; paste spy calls |
| W6 | `session_shutdown` flush (timers cleared, subs unsubscribed; subagent SIGTERM→5s→SIGKILL precedent) | Cooldown timers fire post-shutdown; bus leaks across sessions | Skip `clearTimeout`/unsubscribe in shutdown handler | `G-ext`. RED: after firing `session_shutdown`, manual-scheduler `timers.size` ≠ 0 or `fire(handle)` still calls `setModelFn`; paste timer map size |
| W7 | Switch-once-per-episode + cooldown (monitor one-shot `evaluateMonitor` precedent) | Flapping: three `agent_end[error]` in one episode → three switches | Reset the episode guard on every event | `G-ext`. RED: `setModelFn` call count 3 within one episode (same `now`), expected 1; advance `now` past cooldown and assert second episode MAY switch (prevents vacuous always-once) |
| W8 | Notice + bus + command: `router-fallback` transition on `TRANSITION_CHANNEL` bus, `/fallback` status, tone-by-kind renderer, which-provider-served surfaced | Silent switch (subagent f:2026-09-02 ruling: fallback recorded, never silent) | Delete `pi.events.emit` call | `G-ext`. RED: `pi.transitions` has no `router-fallback` entry after a switch; paste `pi.transitions` array; companion: `/fallback` command registered (`pi.commands.has("fallback")`) and renderer registered |
| W9 | `willRetry` deference: no switch while `agent_end.willRetry===true`; act on `agent_settled` / `auto_retry_end{success:false}` | Double-action: extension switches mid-retry, SDK `continue()` then fights it (H4) | Switch immediately on first `agent_end` regardless of `willRetry` | `G-ext`. RED: `setModelFn` called while `willRetry:true` (expected 0 calls until settled); paste `willRetry` value and call count |

### Package 4 — guards (`router-fallback-guard.test.ts`)

| # | Target | Failure mode | Mutation | Gate + RED evidence |
|---|---|---|---|---|
| G1 | Master kill-switch `PI_ROUTER_FALLBACK_ENABLED=0` read **per call** | Cached-at-load flag: user disables mid-session, extension keeps switching | Cache env at factory load (read once) | `G-guard`. RED: set env `0` AFTER factory init, fire `agent_end[error]` → switch still happens (`setModelFn` called); paste env value + call count |
| G2 | `PI_ROUTER_FALLBACK_MAX_SWITCHES=0` disables; N caps episode | Cap read once / off-by-one lets one extra switch through | `<=` → `<` (or ignore env) | `G-guard`. RED: with `=0`, switch occurs; with `=1`, second-episode switch occurs; paste counts |
| G3 | Guard evaluation has no side effects (blocked attempts don't arm cooldown/switch) | Disabled-guard path still mutates selector state, poisoning the next enabled episode | Advance state even when disabled | `G-guard`. RED: disabled episode followed by enabled episode starts with `attempts>0`/`cooldownUntil` set; paste state dump |

### Package 5 — integration / publish (wiring + repo gates)

| # | Target | Failure mode | Mutation | Gate + RED evidence |
|---|---|---|---|---|
| I1 | `publish.ts` + `EXTENSION_DIRS` registration (directory-package model) | Extension built but never installed to `~/.pi/agent/extensions/router-fallback/` | Remove the `router-fallback` entry from `EXTENSION_DIRS` | `bun publish.ts --check` (expected: exit 0, lists `router-fallback`). RED: paste `--check` output missing the entry / non-zero exit |
| I2 | Cross-package: combined load (router-fallback + subagent + monitor) on one fake-pi — no handler clobber, own bus channel (no parallel bus invented) | Single-slot `pi.on` storage silently drops `session_shutdown` cleanup (documented fake-pi regression); invented bus splits observers | Register with single-slot stub OR emit on a new channel name | `G-ext`. RED: after loading all three factories, `pi.handlers.get("session_shutdown").length` < 3, or `pi.transitions` channel ≠ shared `TRANSITION_CHANNEL` constant; paste handler counts per event |
| I3 | Typecheck + no-secret invariant | `any`-leak or hardcoded key passes unit tests | (gate only; mutation = the suite's own C–G mutations must also keep `G-type` green after fix) | `G-type` expected: exit 0, no output. RED (on break): paste `tsc` error lines; plus `grep -rn "sk-\|AIza\|xoxb" extensions/router-fallback/` expected empty — paste any hit as failure |

## QA honesty notes (which rows could pass vacuously + the preventing assertion)

- **H-Q1, truncation twin (C8):** an untruncated 402 fixture passes even with a naive full-body regex. Prevention: the row REQUIRES the truncated-input twin (`input.slice(0,4000)` with keyword at offset >4000 + `"402: "` prefix) — the test fails unless status-prefix matching exists. A PR showing only the untruncated half is rejected.
- **H-Q2, non-zero-fixture rule:** cooldown/exhaustion tests with `cooldownMs: 0/1` or single-provider lists pass regardless of logic (degenerate fixtures). Prevention: F1/F3/F6 REQUIRE `cooldownMs ≥ 1000`, `providers.length ≥ 3` (Groq/Gemini/OpenRouter order), `maxRetries ≥ 1`, and W7 requires the post-cooldown second-episode switch to prove the guard is episode-scoped, not permanently-once.
- **H-Q3, `setModel:true` only (W2/W3):** a stub that always resolves `true` makes the false-path and persist assertions vacuous. Prevention: W2 REQUIRES the `false`-on-first-provider stub in the same file; W3 asserts on the captured options object identity (`toHaveBeenCalledWith(expect.objectContaining({persist: expect.not.toBe(true)}))` is insufficient — assert the exact options arg).
- **H-Q4, status-only SSE (C4):** a 429-status SSE fixture passes a status-only matcher. Prevention: C4 fixture MUST carry `status:200` at the HTTP layer with the error only in the chunk payload (the d-487 verbatim shape).
- **H-Q5, cached-env green (G1):** setting the kill-switch before factory init passes even with load-time caching. Prevention: G1 sets env AFTER init and fires another event — order is part of the test name.

## Unverified beliefs — HYPOTHESIS + settle-without-blocking

- **H1 — exact OpenRouter empty-account JSON (402 vs 429, `insufficient_quota` vs credits wording).** Stand-in: fixtures built from docs-envelope shape `{error:{code,message,metadata:{error_type}}}` + classifier vocabulary (`retry.js:167` lists), matched by substring. Settle: one live capture (empty account request, save raw body) → add verbatim fixture row to C2; unit work NOT blocked. If wording differs, only fixture strings change, matcher logic stands.
- **H2 — `after_provider_response` on non-HTTP transports (WS status?).** Stand-in: wiring tests fire `agent_end`/`message_end` only; `after_provider_response` handling tested with `{status, headers}` shape but marked optional. Settle: runtime probe logging event receipt per transport; if WS never fires, drop that observation point (no test change — W1/W9 already cover the settled-level path).
- **H3 — `message_end` rewrite suppressing retry.** Stand-in: W1 PINS react-over-rewrite (handler must return `undefined`) so the plan holds either way. Settle: single probe test (rewrite error→stop, observe `_prepareRetry`/`willRetry`) run once against pinned 0.84.4; if suppression works, architect may propose a rewrite variant — as a NEW row with its own RED evidence, not a silent change.
- **H4 — `pi.setModel` mid-stream safety.** Stand-in: W9 PINS deferred action (settled/command level). Settle: probe calling `setModel` between `message_end[error]` and retry `continue()` on 0.84.4; until green, H4 rows stay deferred. Repo pins `0.84.4`, lane researched `0.85.1` — verify `setModel`/`model_select` against `0.84.4` first (d-489 drift warning).
- **H5 (from d-487/488) — Inkling `tool_choice` enforcement; free-model roster churn; Groq/Gemini default IDs; ZDR-vs-free overlap.** Stand-in: NO pinned model list in tests — fixtures use synthetic `{provider, id}` triples; runtime resolution (`/models` re-fetch, `id.endswith(":free")` + `tools in supported_parameters`) is api-engineer lane's contract, untested here beyond W4's scope-preference shape. Settle: runtime `/models` probe + `tool_choice:"required"` probe; results change config defaults, not test rows.

## What was rejected (and why)

1. **Exact-JSON matching** — rejected: `error-body.js` truncates at 4000 chars and SDK folds messages; rows C1–C5/C8 mandate substring + status-prefix (d-489 verdict).
2. **`message_end` rewrite as the switch mechanism** — rejected (W1): H3 unproven, risks suppressing retry/compaction; react-over-rewrite pinned until probe evidence.
3. **Mid-turn `setModel`** — rejected (W9): H4 untested; act at `agent_end`/`settled`/command level.
4. **Triggering on 400/403/404 or pinning the free-model list** — rejected (C6, H5): request-side errors don't benefit from switching; the pool churns, so tests use synthetic providers and runtime re-fetches `/models`.
5. **`persist:true` fallback** — rejected (W3): session-only by constraint ("never persist the fallback as default model").
6. **Live-key / network tests in the unit suite** — rejected: H1–H5 settle via one-off captures/probes + fixture stand-ins; unit rows stay hermetic (`now`-injected, manual scheduler, fake-pi). Full `bun test` once before merge per repo stop condition; per-change runs stay at `G-core`/`G-ext`/`G-guard` + `G-type` (test economy).

## Acceptance-criteria evidence map

1. **Rows {target, failure mode, mutation, gate} grouped by package** — tables C1–C11, F1–F6, W1–W9, G1–G3, I1–I3 above; grouping follows sibling splits (core matcher+selector / wiring / guards / publish-cross-package).
2. **RED evidence per row** — every row's Gate column states the failing assertion output implementation lanes must paste; no row is satisfiable by a green-only report.
3. **QA honesty notes** — H-Q1–H-Q5 name the vacuous-pass shape and the assertion forbidding it.
4. **HYPOTHESIS labels + non-blocking settle** — H1–H5 each pair a fixture stand-in (unit work proceeds) with a named capture/probe that settles it.