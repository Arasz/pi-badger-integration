# Plan: pbi-delegation-liveness-watchdog

**Status: PLANNED.** Author: orchestrating session inline (reduced-rigor note: two architect
lanes died silently mid-run — d-28/d-41 class — so planning went in-session; the independent
review stays delegated). Implements docs/plans/2026-delegation-liveness-monitoring-spec.md.
Parent constraints inherited: R4 (frozen log contract), R5 (exactly one notification per run,
T70), R8 (kill paths), R10/CR10 (shutdown). Foundation from the landed A12/CR11 task
(`839e8be`): `RunState` timer idiom, `abortReason` additive fields, clamp conventions,
`cardTone`/renderer guard, test fixtures (FakeChild, injected `now`, `drainMacrotasks`,
`escalateAfterMs: 0`).

**Test rows continue the deferral table at T108+.** Every NEW row is witnessed RED before its
implementing commit; PIN rows are green-then-mutation-validated.

## 1. Rulings

### RR1 (R0): the visibility bug is diagnose-first, with two honest outcomes

Evidence: during the previous task, the `delegations` tool answered "no delegations have
been started" while same-session runs (d-21/26/28) were live in the runner. Static reading
says one closure constructs the registry (index.ts L620) and registers both tools (L723+),
so a single instance cannot disagree with itself. The running session, however, executes the
extension copy loaded at session start — older than several publishes — so the mismatch is
plausibly between two instance generations or inside an older tool implementation.

- **Outcome A (bug in code):** a repro test — register the extension in the fake-pi
  harness, start a run, invoke the `delegations` tool handler → it must list the run. RED
  today means the fix is code; fold it.
- **Outcome B (environmental / stale instance):** the repro passes → the code fix is still
  owed as a guard: the `delegations` tool output carries the registry instance's stats
  (record count) and, when the registry is empty, says so as "registry empty" rather than
  "no delegations have been started" — plus a startup log line with the extension version,
  so a stale instance is identifiable from its own output. The live repro becomes a
  manual-evidence row (AC1 of the spec).

Both outcomes are acceptable task completions for R0; which one fired is reported.

### RR2 (R1): the watchdog is an inactivity timer beside the timeout timer

Per-run `RunState.watchdogTimer`, armed at spawn alongside `timeoutTimer`, reset in
`handleLine` after each successfully parsed event, gated on `!state.settled` (S1: every
stream event, not just `message_update` — a long silent tool call streaming
`tool_execution_update` must not false-trip; the settled gate keeps the lost-settle →
close → tail-flush path from re-arming an orphan watchdog). Fires only while unsettled →
`abortRun` (R8's one kill path) → settle `aborted` with `abortReason: "lost"` +
`watchdogMs` on the record/note → the normal R5 notification. Composes with `timeoutMs`
without sharing a timer: watchdog = no activity for N ms; timeout = wall clock since spawn;
**any settle clears both** (a timeout expiry is terminal — cleared, not "reset as
activity", N3). Value clamped in the core helper: floor **1_000 ms** (S2: test rows drain
in ~1.1 s like the timeout rows — the house `drainMacrotasks` idiom drives real timers,
not injected-`now` arithmetic), cap **`RUN_TIMEOUT_MAX_MS`** (M1: the watchdog arms through
the same `setTimeout` whose >2^31−1 ms clamp fires in ~1 ms — an uncapped injectable
"3e9" would instantly abort every run `lost`; the cap is mandatory, not cosmetic).
Default `RUN_WATCHDOG_MS = 600_000`, dep-injectable `runWatchdogMs` via the registry
spread — a per-`RunState` timer, so no registry edit (N1), `0` = off = fixture idiom.

Surfaces: verdict `Delegation d-2 (architect) stopped responding (no output for 10m00s) and
was aborted.`; `describeRecord`/`renderRunLine` render `aborted (lost)` via the existing
`abortReason` branches (S4 pattern from the timeout task) — both branches get a row (S4).
Verdicts render durations through `formatDuration` (zero-padded — `10m00s`), naming the
configured threshold, never elapsed.

### RR3 (R2): the operator probe is read-only

`delegations list` gains a `pid` liveness line per running record via a three-way probe
(ESRCH → `dead`, EPERM → `unknown`, else `alive`; pid comes from the run header the runner
already records). Dead-but-unsettled renders `lost (dead pid)`. No auto-settle in v1 — an
explicit `abort` remains the settle path. `unknown` never renders as `dead`. The existing
boolean `pidAlive` (EPERM → alive) that feeds `classifyFromLogDir` is UNCHANGED and pinned
— the three-way probe is report-only and they coexist (S3).

### RR4 (R3): staleness is a pure classification

`classifyFromLogDir` gains `stale` — **with the M2 precedence fix**: at HEAD the tee writes
only the header at spawn and the tail at close (stderr held in memory), so a live run's
log mtime ≈ spawn time and mtime alone would brand every healthy 10-min cross-session run
`stale`. Classification order: terminal lines first → pid-alive → `running` (never `stale`)
→ then stale-vs-lost by mtime among pid-dead, terminal-line-less logs. Threshold parameter
(default 600_000 ms, injected) — distinct from `lost` and from existing states, which keep
their exact current outputs (pinned). Log format untouched — mtime is filesystem, not a
line type. Surfaced in the `delegations` tool when the registry is empty: reconstructed
`stale` runs are listed with their log paths.

## 2. Packages and serialisation

| Pkg | Files | Notes |
|-----|-------|-------|
| P1 | `delegation-runner.ts`, `delegation-registry.ts`, `delegation-core.ts` (clamp+verdict helpers), `tests/delegation-runner.test.ts`, `tests/delegation-core.test.ts` | watchdog core; runner-only — no index.ts |
| P2 | `index.ts` (R0 repro/guard + surfaces wiring), `delegation-status.ts` (probe), `tests/subagent-extension.test.ts`, `tests/subagent-status.test.ts` | depends on P1's fields |
| P3 | `delegation-core.ts` (`classifyFromLogDir`), `delegation-status.ts` (owns the empty-registry list case — `runAction` inside `registerDelegationStatus`; the factory signature widens additively via `opts`, M3), `index.ts` (wiring) | land after P2 |
| P4 | cross-feature integration tests + docs | last, mandatory |

Strictly serial P1 → P2 → P3 → P4, one lane, **commit after every package** (the d-28
rule). Docs land in P4: RR5-style header paragraph (liveness contract), tests-doc rows,
ledger note in the liveness spec, manual-evidence rows (spec AC1 + AC10).

## 3. Packages, ACs, test rows

### Pkg P1: watchdog core

ACs:
- **AC-W1** Inactivity expiry kills through `abortRun` and settles `aborted` +
  `abortReason: "lost"` with exactly one note. Proven by T108, T109.
- **AC-W2** Activity resets the deadline; a streaming run past the threshold never trips.
  Proven by T110 (injected `now`).
- **AC-W3** Settles clear the watchdog; shutdown beats it (CR10). Proven by T111, T112.
- **AC-W4** Composition with `timeoutMs`: either settle clears both; a timeout expiry is
  activity (resets the watchdog). Proven by T113.

| id | file | test | arrange → act → assert | red-first |
|----|------|------|--------------------------|-----------|
| T108 | runner | inactivity expiry kills via the abort path | `runWatchdogMs: 1000` (S2 floor), `escalateAfterMs: 0`, silent child, `drainMacrotasks(1100)` → signals `["SIGTERM","SIGKILL"]`, state `aborted` | NEW; mutation: direct settle or second kill path → red |
| T109 | runner | lost settle carries the marker, no exitCode, one note | same setup → note `abortReason: "lost"`, record mirrors it, no `exitCode` key | NEW; mutation: plain abort without marker → red |
| T110 | runner | activity resets the deadline | two parsed-event bursts (mixed types incl. tool events) each just under threshold, spanning 2× threshold via real drains → completed normally, `signals: []` | NEW; mutation: arm-once-never-reset → red; mutation: reset on message_update only → a tool-event-only run trips → red (S1) |
| T111 | runner | natural close clears the watchdog | `exit(0)` before threshold → drain past it → completed, no signals | PIN-style (mirrors T81; mutation: remove clear → red) |
| T112 | runner (registry) | shutdown with an armed watchdog notifies nothing | `shutdown()` pre-expiry → drain → notes empty | NEW |
| T113 | runner | timeout expiry clears the watchdog; both timers clear on any settle | `timeoutMs: 5` fires → watchdog never fires after; a watchdog fire with `timeoutMs` armed settles once, not twice | NEW |

### Pkg P2: visibility + operator surfaces

ACs:
- **AC-W5** R0 resolved per RR1: repro test written; code fix or guard landed; outcome
  reported. Proven by T114 (+ manual row if outcome B).
- **AC-W6** The lost verdict renders; durations via `formatDuration`; limit-named.
  Proven by T115.
- **AC-W7** `delegations list` shows `alive`/`dead`/`unknown`/`lost (dead pid)`.
  Proven by T116.

| id | file | test | arrange → act → assert | red-first |
|----|------|------|--------------------------|-----------|
| T114 | extension | registry empty ≠ blind: tool AND panel output identify emptiness | harness + zero runs → delegations tool AND the `/delegations` statusPanel (N2) say "registry empty" wording + stats; with one run → listed | Outcome A: NEW red (today's wording in both surfaces); Outcome B: NEW green guard + manual row |
| T115 | extension + core + status | lost verdict + both render branches | note `{state:"aborted", abortReason:"lost", watchdogMs:600000}` → verdict `stopped responding (no output for 10m00s) and was aborted.` exact string; `renderRunLine` and `describeRecord` render `aborted (lost)` (S4) | NEW |
| T116 | status | liveness probe | running record pid alive → `alive`; reaped pid → `lost (dead pid)`; EPERM stub → `unknown`; settled records skip the probe; queued records (no pid) skip it (N4) | NEW; mutation: EPERM rendered as dead → red |

### Pkg P3: staleness classification

ACs:
- **AC-W8** `classifyFromLogDir` returns `stale` for a terminal-line-less log older than
  the threshold; recent logs and terminal logs unchanged (pinned). Proven by T117.
- **AC-W9** Empty-registry listing surfaces reconstructed `stale` runs. Proven by T118.

| id | file | test | arrange → act → assert | red-first |
|----|------|------|--------------------------|-----------|
| T117 | core | stale classification with M2 precedence | header-only log, dead pid, old mtime → `stale`; **live pid + old mtime → `running`, never `stale`** (the tee writes mid-run are none — mtime ≈ spawn time, M2); same + recent mtime → existing state; log with `exit` + old mtime → never `stale` | NEW |
| T118 | extension | empty registry + stale logs → listed with log paths | no runs; log dir with a stale file → delegations tool lists it as `stale` with path | NEW |

### Pkg P4: integration + documentation (mandatory last)

ACs:
- **AC-W10** Watchdog × batching × timeout compose: a lost settle inside an open batch
  window rides the batch; a mixed burst carries exactly one lost verdict; shutdown race
  closed end-to-end. Proven by T119, T120, T121.
- **AC-W11** Gates green; docs landed. Proven by the gate run + doc checks.

| id | file | test | arrange → act → assert | red-first |
|----|------|------|--------------------------|-----------|
| T119 | extension | lost card rides an open batch | lead exits; second child goes silent → watchdog fires inside the window → flush carries the lost verdict | NEW |
| T120 | extension | mixed burst: one lost among completions | 7-run burst, one silent → 2 messages, exactly one lost verdict | NEW |
| T121 | extension | shutdown + watchdog + batch race end-to-end | armed watchdog + pending batch + `session_shutdown` → flushed once, no sends after | NEW |

## 4. Documentation deliverables (P4)

1. `extensions/subagent/index.ts` header: liveness paragraph — silent child death is the
   defect class this extension exists to end; the watchdog turns it into a normal terminal
   transition.
2. Tests doc: append T108–T121 as liveness rows.
3. Liveness spec: mark R0–R3 landed, note which R0 outcome fired.
4. Manual-evidence rows: live `delegations list` liveness column (AC1); a real watchdog
   firing (kill -9 a child mid-run in a live session, witness the lost card).

## 5. Non-goals

No auto-restart of lost runs; no per-tool-call watchdogs inside the child; no log-format
change; no auto-settle from the operator probe; no user-facing config surface beyond the
dep injectables.

## 6. Risks

- Timer double-bookkeeping (watchdog vs timeout) — T113 is the guard; both live in
  `RunState` with shared clear discipline.
- `kill(pid, 0)` portability — POSIX only; pi's TUI runs on POSIX today (documented).
- Stale-vs-lost overlap — `stale` is registry-empty-only in v1 (RR4), avoiding double
  reporting.
