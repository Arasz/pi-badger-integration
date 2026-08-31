# Spec: Delegation liveness monitoring — no child dies unwitnessed

| | |
|---|---|
| **Status** | Draft — queued; task starts after `pbi-delegation-timeout-and-burst-batching` lands |
| **Date** | 2026-08-31 |
| **Target repo** | pi-badger-integration (`extensions/subagent/`) |
| **Origin** | Live witness: lane d-28 died silently 2026-08-31 (pid gone, log frozen, no `exit`/`agent_settled`, no receipt, no followUp, no notification — work lost only because it had committed nothing yet); plus the `delegations` tool reporting "no delegations started" while d-21/26/28 ran from the same session |
| **Raised by** | pi-badger-integration session, 2026-08-31 (owner feedback: "can we somehow monitor child process state?") |

---

## Background

A delegation child (`pi -p --mode json`) can die without the runner ever settling its run:
the process vanished, the tee log froze mid-thinking, and neither the runner's notification
path nor the session's `delegations` tool had anything to show. Node's `close`/`error`
events on the spawned child are the primary monitor today and settle ordinary deaths — but
d-28 proved a death class slips past them, and the operator surface (`delegations` tool,
`ps` by hand) had to fill the gap manually. This spec closes that class.

Three layers, in dependency order: **R0** fix the registry visibility bug everything keys
off; **R1** a runner liveness watchdog (the real fix); **R2** operator liveness surface;
**R3** an external staleness scan as the safety net that works even when the runner is
compromised.

## Problem 1: silent child death produces no terminal transition

Witnessed (d-28): child pid gone, log file mtime frozen > 6 min, no `exit` line, no
`agent_settled`, no notification, no receipt. The run stays `running` in every surface
forever; the orchestrator only finds out by hand-probing. The runner's `close`/`error`
handlers settle ordinary deaths, so the gap is a specific unhandled path (handler not
reached, settle guard swallowed it, or death outside the handlers' view) — root cause must
be identified, not assumed.

## Problem 2: the `delegations` tool cannot see its own session's runs

While d-21, d-26, d-28 ran from this session, `delegations` (list action) reported "no
delegations have been started". Every monitoring surface built on the registry is blind if
the registry instance the tool queries is not the one the runner records into. Suspected
(unverified): the session loaded a pre-refactor extension copy at startup (the stale-load
class seen twice this month) — but the tool→registry wiring must be root-caused, not
assumed.

## Required changes

- **R0 (prerequisite) — registry visibility.** Root-cause why the `delegations` tool and
  the runner's registry disagree; fix so a session's own live runs are always listed. If
  the cause is a stale loaded extension, the fix is still owed in code: the tool must fail
  loud (or self-identify its registry instance) rather than answer "none" against a
  non-empty registry.
- **R1 — runner liveness watchdog.** Arm an inactivity timer per run; reset it on every
  stream event the runner already sees (tee writes / `message_update` handling). If it
  fires while the run is unsettled: kill via the existing R8 `abortRun` path (no second
  kill implementation), settle `aborted` with a new `abortReason: "lost"`, deliver the
  exactly-one R5 notification. Defaults: `RUN_WATCHDOG_MS = 600_000` (10 min) — generous,
  because thinking streams continuously and long tool calls still emit events —
  dep-injectable via `SubagentDeps` (`runWatchdogMs`), `0` = off, and `0` is the test
  fixture idiom. Composes with the A12 `timeoutMs` (total-runtime cap) without sharing a
  timer: watchdog = no activity for N ms; timeout = wall clock since spawn.
- **R2 — operator surface.** `delegations list` gains a liveness probe: for each running
  record, `kill(pid, 0)` (the run header already carries the pid) → `alive` / `dead` /
  `unknown` (EPERM/ESRCH edge). A dead-but-unsettled run renders `lost (dead pid)`.
  Report-only in v1; an explicit `abort` remains the way to settle it (the watchdog makes
  that a rare path).
- **R3 — external staleness scan.** Extend `classifyFromLogDir` (pure, mtime injected)
  with a `stale` classification: log has no terminal line AND mtime age > threshold →
  `stale` (distinct from `lost`). Surface: a `stale` filter/annotation in the `delegations`
  tool listing runs reconstructed from logs when the registry answer is empty. This is the
  net that catches deaths even when the runner instance itself is gone.

**Hard constraints (inherited):** R4 log format frozen — no new tee line types; the
watchdog settles through existing paths only. R5 exactly-one-notification survives the
`lost` settle (T70 double-close pin intact). R8 kill machinery reused. CR10: the watchdog
never fires after shutdown (settled + stopped guards, same as the A12 timer). The A12
in-flight work (`timeoutMs`, `abortReason`, timer idiom) is the foundation this builds on —
this spec starts **after** that task merges, and reuses its landed patterns rather than
re-inventing them.

## Acceptance criteria

RED-first discipline: provocation ACs are witnessed failing against pre-fix code, red
output pasted in the task record. Test rows continue the committed table's numbering.

- **AC1 (visibility, R0).** In a live session, runs started by that session appear in
  `delegations list` while running (manual-evidence row — a unit test cannot see the
  wiring). Root cause of the mismatch documented in the task notes.
- **AC2 (watchdog provocation, R1).** A fixture child that stops emitting and never fires
  `close` → the watchdog fires at `runWatchdogMs` → run settles `aborted` +
  `abortReason: "lost"`, exactly one notification with a "lost" verdict, signals show the
  R8 escalation path. Fails on pre-fix code (run stays running forever).
- **AC3 (watchdog resets).** Continuous activity past the threshold never trips it; each
  new stream event pushes the deadline. Proven with injected-clock fixtures.
- **AC4 (composition).** With both `timeoutMs` and the watchdog armed: a timeout expiry
  counts as terminal (watchdog never fires after it); an inactivity trip during an open
  timeout behaves as one abort. Proven by an integration test.
- **AC5 (CR10).** Shutdown + watchdog race: post-shutdown, no watchdog fire, no
  notification, no send.
- **AC6 (R5/T70).** The `lost` settle path delivers exactly one note per run; the
  double-close pin stays green.
- **AC7 (operator surface, R2).** `delegations list` shows `lost (dead pid)` for a running
  record whose pid is gone (fixture: record with a reaped pid); live pids show `alive`.
- **AC8 (staleness, R3).** `classifyFromLogDir` on a header-only frozen log with injected
  old mtime → `stale`; same file with recent mtime → existing classification (pinned
  unchanged); a log with `exit` → never `stale`.
- **AC9 (R4).** No new line types in the tee format; the parser contract tests
  (ai-badger's M1 ruling: records iff `exit` OR `agent_settled`) stay green — a `lost` run's
  log classifies as unrecorded spend, exactly like abort/timeout. Pinned.
- **AC10 (gates).** Full `bun run test` + `bun run typecheck` green; every new row
  red-first witnessed or PIN-marked; manual-evidence rows appended for the live-TUI
  surfaces (AC1, plus a real "lost" card rendering).

## Out of scope

- Changing the A12/CR11 work in flight — this builds on its landed patterns.
- Process-supervision beyond detection (no auto-restart, no retry-on-lost — the
  orchestrator re-dispatches, as happened with d-33).
- Per-tool-call watchdogs inside the child; the child's own extension behavior is pi's
  domain.
- Fixing ai-badger-side consumption of lost runs beyond what the existing parser already
  does (they are unrecorded spend by contract, AC9).

## References

- Silent-death witness: `~/.pi/agent/subagent-logs/d-28.jsonl` (frozen at 4,148 events,
  all `thinking_delta`, no terminal line); pid 40543 absent from `ps` at diagnosis.
- Foundation (in flight): `docs/work/2026-08-30-delegation-timeout-and-burst-batching-plan.md`
  — `RunState` timer idiom, `abortReason` additive fields, clamp/dep-inject conventions.
- Code seams: `extensions/subagent/delegation-runner.ts` (`onClose`, `finishSettle`,
  `abortRun`), `delegation-registry.ts` (admission, stopped guard, T70), `index.ts`
  (`deliverNote`, `delegations` tool), `delegation-core.ts` (`classifyFromLogDir` rows 14–17,
  `deriveActivity`), `delegation-status.ts` (`describeRecord`).
- Parent plan constraints: `docs/plans/2026-interactive-subagent-delegation.md` R4/R5/R8/R10,
  CR10, T70; tests table (row numbering continues).
