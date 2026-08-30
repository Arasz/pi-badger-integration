# Plan — pbi-interactive-background-subagent-delegation

**Status: PLANNED, NOT STARTED.** Implementation is **blocked** on
`pbi-move-extensions-to-dir-packages` (state=STARTED at plan time). First implementation step:
verify the blocked-on checklist (§7), then
`python3 .ai-badger/skills/task/scripts/task_tracker.py start pbi-interactive-background-subagent-delegation --title "Interactive background subagent delegation with progress and logs" --branch task/pbi-interactive-background-subagent-delegation`.

Effort: **high**. MoE-authored (architect, api-engineer, test-engineer); MoE-reviewed
(code-reviewer, qa, architect); all MUST findings folded (§10).
Research record: `docs/plans/2026-interactive-subagent-delegation.research.md` (evidence, hypotheses H1–H5).
Test table: `docs/plans/2026-interactive-subagent-delegation.tests.md` (committed contract — 52 base rows + 26 review rows).

## 1. Goal

1. The main pi agent loop stays **fully interactive** while any number of subagents run (AC1 ← rows 23/24/25/40; the interactive half is the manual e2e checklist).
2. Progress and logs of every delegation are **checkable** — LLM (`delegations` tool), human (`/delegations`), after restart (durable log dir) (AC2, AC5).
3. Existing consumers keep working: ai-badger headless delegation maps unchanged; interactive consumers get a documented migration path (§10 follow-up ledger).

Top-level acceptance criterion: all packages' ACs checked and met (§3, §5).

## 2. Rulings (consolidator decisions; review panel attacked — overridden lane positions recorded per review finding A7)

| # | Decision | Ruling | Why / rejected / overridden |
|---|----------|--------|------------------------------|
| R1 | Where the work lives | Evolve `extensions/subagent/` in place; new pure modules inside the directory package. No scratch files may live in the extension dir (publish ownedDir extra-file drift). | Sibling extension would need a pi.events contract for something never used alone. |
| R2 | Background default | `background?: boolean`; **auto resolves to background iff `ctx.mode === "tui"`** (NOT `ctx.hasUI` — rpc also has UI, review A1); explicit value always wins; `background:true` outside tui **degrades to fully blocking** with the warning riding the **tool result content** / `details.degraded` (never `ui.notify` alone — no-op in print/json, review CR7/A6). | Overrode architect's D2 (opt-in, default blocking): goal 1 outweighs; opt-in leaves interactivity to per-call chance. Rejected: background-by-default in headless (receipt into a run that then exits); separate delegate_background tool. Consumer coordination: §10 ledger. |
| R3 | Child mode | ALL children run `pi -p --mode json --no-session`; one line-buffered parser; blocking mode gains `details.usage`. **Fallback (review CR4): exit 0 with zero parsed agent events (no `agent_end`), regardless of stdout shape → loud error naming the silent-JSON variant, capped raw stdout attached** (H2's silent failure emits a valid `session` header then nothing — "non-JSON stdout" never triggers). Non-zero exit with parsed events → error verdict that still includes the extracted partial answer tail + stderr. | Plain stdout gives nothing until exit. One runner. Rejected: parsing `message_update` deltas; two runners. |
| R4 | Logs | Raw JSONL tee to `~/.pi/agent/subagent-logs/<runId>.jsonl` — `run` header (runId, **sessionId**, persona, task, argv, cwd, pid, startedAt), child stdout verbatim, stderr as `{"type":"stderr",…}`, final `exit` line. **Byte-capped per run (header+tail kept, middle elided with marker — "lossless" claim dropped, review CR14).** Read-time summarization (`extractAnswer`). Prune >14 days on session_start + dir cap oldest-first. Dir 0o700, files 0o600. **Log-sink failure isolation (review CR6): every sink op try/catch-wrapped; first failure = one warning, sink disabled for that run, delegation state untouched; `delegations log` answers "log unavailable".** | Durable, outside every git repo. Rejected: project-dir logs (git pollution), tmpdir (reboot purge), parsed-summary-only (lossy). **R4's format is a de-facto cross-repo contract** (ai-badger `pi_session_source.delegation_usage` will parse it — §10). |
| R5 | Completion notification | Single-shot `pi.sendMessage({customType:"delegation-result", …}, {deliverAs:"followUp", triggerTurn:true})` on **every terminal transition except shutdown-initiated ones — including aborted-before-start (state aborted, no exitCode, review CR2)**; exactly one per run (double-close pinned, T70); exit code, answer tail (**8 KB cap**, review Q2f), duration, usage, log path. Receipt has a **queued variant**: "Delegation d-3 queued (position N)". N near-simultaneous completions ≈ N sequential turns — **documented cost, no batching in v1** (review CR11/A10). | Memory d968: notification must provably arrive. H1 manual-gated; fallback `sendUserMessage`. Rejected: steer, nextTurn, appendEntry-as-notification. |
| R6 | Tool surface | `delegate` keeps its name, gains `background` + `cwd` (**personas always scanned from `ctx.cwd`; child runs in `params.cwd`; validated with `stat` + `isDirectory` — review CR13**). New LLM tool **`delegations`**: `list` / `log` / `abort` / `wait` (capped 120 s default, 600 s max). **wait timeout → per-id state snapshots (not an error); unknown id → loud error; terminal id → immediate return; abort without id → usage error; shutdown resolves pending waits (review CR10).** Human twin `/delegations [log <id>] [abort <id|all>]` with completions. Child denylist `--exclude-tools delegate,delegations` (comma form verified in §7; repeat-flag fallback). Description states: **no automatic per-run timeout** (review A12). | One query/mutate surface. `wait` replaces poll-loops. Rejected: three separate tools. |
| R7 | Concurrency | **One admission policy for every call (review CR3): ≤4 running (env `PI_BADGER_SUBAGENT_MAX_CONCURRENT`), ≤16 queued FIFO; beyond 16 queued, BOTH blocking and background calls are rejected loudly with guidance** (blocking rejection = error result, not a receipt). "Blocking calls exempt" deleted. A blocking call with slots full but queue room **enqueues and awaits** (pinned, T59, review A9). `DelegationDeps` gains `queueCap` beside `cap`. | Overrode architect D8 never-reject: unbounded queue = surprise token spend; 17+ is a fork-burst backstop no realistic caller touches (MoE panels are 3–6). |
| R8 | Abort & shutdown | Extension-owned AbortController per run. Abort via tool/command; **queued records abortable without a kill; admission re-checks aborted flag at dequeue (review CR2)**. **Split kill paths (review CR5): `session_shutdown` (async) = SIGTERM → 5 s grace → SIGKILL; `process.on("exit")` = SIGKILL synchronously, no timers; both tolerate ESRCH/double-kill.** Orphans after hard kill: report-only, **pid probe corroborated by log growth or cmdline match (review CR16)**, never auto-killed. | Esc keeps its platform meaning. Delegations do not outlive the session. |
| R9 | Progress surfaces | Blocking mode: `onUpdate` per `message_end` into the tool row. Background mode: `ctx.ui.setWidget` panel (id, agent, elapsed, activity, ↓tokens; queued count), 5 s tick, cleared on empty; **widget renders background/queued runs only (review CR17)**. **Session-signals: the pi.events wire is CUT (review A3 — it cannot suppress the sub-second flash it was justified by, and adds an untestable cross-extension contract); instead a ~5-line tick-defer of session-signals' first footer render, plus `delegations` added to its default watch list so `wait` is visible.** | Overrode api-engineer's wire AND architect's D9 do-nothing: tick-defer kills the flash with no contract. Widget ≠ footer slot (H5 manual). |
| R10 | Restart/replay | **Log-dir-only reconstruction (review A4): session_start scans `~/.pi/agent/subagent-logs/`; `exit` line → completed; header without exit + dead pid → lost/orphaned; no branch parsing.** **runId allocation: skip-to-next-free across the log dir (review CR1) — ids never reused, so `delegations log d-1` is never ambiguous and no log is overwritten; T73 pins it.** **No auto-followUp after restart** (T47 asserts it). `/tree` navigation away from the delegating branch loses nothing (logs are the truth) but ids of other branches' runs only appear via the log dir — one README line documents this (review CR15). | Replaced branch+log dual reconstruction: the log dir already holds everything; drops branch-walking code and 2–3 test cases. |
| R11 | Module map | `delegation-core.ts` (pure: parseChildEvent, applyUsage, admission policy + runId allocation, classifyFromLogDir, renderDelegationStatus, extractAnswer, formatters), `delegation-runner.ts` (ChildLike seam, spawn, parse wiring, escalation; `escalateAfterMs` injectable, 0 in tests), `delegation-registry.ts` (records, queue, wait, abortAll, pi.events transition snapshots), `delegation-status.ts` (**the `delegations` tool, `/delegations` command, widget — owns its own files so P3/P4 can parallelise**, review A5), `index.ts` (delegate tool, receipt, notification, session wiring, reconstruction). | test-engineer's layering + api-engineer's registry split + architect's parallelisation fix. |

## 3. Acceptance criteria (owning rows cited — qa finding 2)

- **AC1** Main loop interactive while ≥1 background delegation runs; receipt resolves before any child exits; N≥3 parallel; admission/queue correct. ← rows 22, 23, 24, 25, 39, 40, T58, T59, T61, T66 + manual e2e checklist.
- **AC2** Progress/logs checkable: list/log/abort/wait contract, widget, /delegations, log discipline (tee, cap, prune, failure isolation). ← rows 5, 8–21, 26–30, 41, 49, 50, T54, T55, T56, T60, T72, T75–T78.
- **AC3** Completion notification provably lands on every terminal transition except shutdown; exactly one per run; caps respected. ← rows 31–34, 38, 46, T61, T69–T71 + wiring row 46.
- **AC4** Lifecycle safety: escalation with a real child (H4, row 52 — **may not be checked while the smoke reports skipped**, qa finding 4); split kill paths; no test-process leaks; `git status --porcelain` clean (structural: smoke children run in a temp dir with `.pi/agents` scaffold).
- **AC5** Restart replay: log-dir reconstruction, ids never reused, no surprise followUp. ← rows 14–17, 47, T53, T73, T74(wiring).
- **AC6** Backward compat: headless runs get **content-equivalent extracted answers pinned by the P0 characterization oracle (not regenerated from the new code — qa finding 9/N8) plus `details.usage`**; rpc/json/print modes block; typecheck clean. ← rows 1–7, T66, T67.

## 4. Sketch deltas (api-engineer §4 shapes amended by review)

- `DelegationDeps`: `{ spawnFn?, cap?=4, queueCap?=16, escalateAfterMs?=5000, logSink?, notifyComplete?, onUpdate? }`.
- Receipt details: `{ id, agent, state: "running"|"queued", queuePosition?, toolCallId, logFile? }`; receipt content has running and queued variants.
- Blocking result: today's shape + `details.usage` + optional `details.degraded` + degrade line in content.
- `DelegationRecord`: adds `sessionId`; `state` adds nothing (aborted is terminal); `logFile?` absent when sink disabled.
- `runId` allocation lives in `delegation-core` (pure, skip-to-next-free over the log dir).
- pi.events snapshot shape is frozen when P2 lands (interface freeze point 2); P1 exported signatures frozen at P1→P2 handoff (freeze point 1).

## 5. Packages (waves — review A5; interface freeze points as above)

- **W1: P0 ∥ P1** — P0 characterization (`tests/subagent-tool.test.ts`, rows 1–7; witnessed-RED protocol: row 1 authored here, committed green in P3) ∥ P1 pure core (`delegation-core.ts` + `tests/delegation-core.test.ts`, rows 8–22, T53–T56).
- **W2: P2** — runner + registry (`delegation-runner.ts`, `delegation-registry.ts`, `tests/helpers/fake-child.ts`, `tests/delegation-runner.test.ts`, rows 23–42, T58–T65). Freeze point 1 review at handoff.
- **W3: P3 ∥ P4** — P3: delegate rewiring + notification + reconstruction (`index.ts`, `tests/subagent-extension.test.ts`, rows 43–48, T66–T74; commits row 1 green) ∥ P4: status surface (`delegation-status.ts`, session-signals tick-defer, `tests/subagent-status.test.ts`, rows 49–50, T75–T78).
- **W4: P5 — integration package (mandatory).** §7 re-verification; H2 real-child gate; smoke suite + **honesty protocol (record `0 skipped` summary)**; **committed manual-evidence checklist** (H1, H5, e2e interactive, e2e restart, **e2e MoE-panel-style run in TUI** — review CR8); `bun publish.ts --check` + fresh-session load (one delegate, one delegations, one /delegations — no duplicates from a stale `ai-badger-subagent/`); README section (log dir location + rationale + /tree note); AC roll-up citing row ids.

Every package: `bun run test` + `bun run typecheck` green at every commit; then commit (sourceControl.platform=none → local commits).

Budget note (review A8): ≈1.5k implementation LOC + ≈700–900 test LOC against a repo whose whole extension tree is ~700 LOC today — the R9/R10 trims are what keep this landable; nothing further cut.

## 6. Test table

The full row table (78 rows) with RED-first protocol, flake conventions, smoke honesty
protocol, and the manual-evidence checklist lives in
**`docs/plans/2026-interactive-subagent-delegation.tests.md`** — committed with this plan; §5
and that file may not disagree on package numbering or file names (qa finding 1).

## 7. Blocked-on checklist (BEFORE task_tracker start; base layout assumption: directory packages landed)

1. `extensions/subagent/{index.ts,package.json}` exist, `index.ts` is the pi entry; flat session-signals/shift-enter entries renamed — update every path this plan and its tests reference.
2. publish.ts generic `directoryTarget` — **verified against the in-flight worktree (review A11): `EXTENSION_DIRS` includes `subagent`, recursive ownedDir walk; added files need no publish.ts edit.** Re-verify on the merged branch.
3. **Stale user-scope orphans cleaned — HARD GATE, not advisory (review A11): `--check` can never flag a stale `~/.pi/agent/extensions/ai-badger-subagent/` (shared dir, no ownedDir), so this item + P5's fresh-session load are the only guards against double `delegate` registration.**
4. `tests/setup.ts` loader works against directory-package paths; root `typebox` resolvable; ported test tree verified.
5. ai-badger repo no longer installs a subagent extension (`adjust_agents.py` surgery) — **verify in the same pass as item 3** (new installer live, old one removed).
6. Verify `--exclude-tools delegate,delegations` comma form on the pinned pi version (repeat the flag if not).
7. Re-read pi changelog since 0.84.4 for extensions.md deltas touching sendMessage/triggerTurn, setWidget, registerMessageRenderer, `--mode json` event shapes.

## 8. Risks

- **H1 (highest):** sendMessage wake of idle TUI unproven → manual gate + fallback `sendUserMessage`.
- **H2:** `--mode json` + `--append-system-prompt` → real-child gate; silent-variant fallback (R3) catches the quiet failure.
- **H3:** receipt + injected message are the two replay shapes; log-dir-only reconstruction makes receipt-only records first-class.
- **H4:** Bun SIGTERM→SIGKILL escalation → smoke row 52.
- **H5:** widget vs footer coexistence → wiring rows 50/T77 + manual visual check (information duplication included, review CR17).
- Residual: hard-kill orphans (kill -9/crash) spend with no consumer — bounded (≤4, `--no-session`), report-only with corroborated pid probe.
- `wait` re-blocks the loop by design — capped 600 s, description warns; visible in footer via watch-list addition.
- Burst of N completions ≈ N sequential turns — documented (R5), batching deferred.
- Interactive callers get a receipt instead of an inline result — deliberate (goal 1); escape hatch `background:false`; consumer migration in §10 ledger.

## 9. Delegation ledger

Blocking-mode delegations return stdout only — token counts unavailable (itself evidence for R3). Counts to be backfilled at execution time via `task_tracker.py subagent` once the runner ships `details.usage`.

| # | persona | phase |
|---|---------|-------|
| 1 | architect | plan authoring |
| 2 | api-engineer | plan authoring |
| 3 | test-engineer | plan authoring |
| 4 | code-reviewer | plan review |
| 5 | qa | plan review |
| 6 | architect | plan review |

## 10. Plan review outcome + follow-up ledger

**Review verdict (consolidated):** ready to execute once §7 passes — after folding 12 MUSTs
(all folded above; none reopened lane disagreements). Reviewer-confirmed facts: the in-flight
worktree's publish.ts already contains the generic directoryTarget including `subagent` (A11);
`ctx.hasUI` is true in RPC mode, so the auto predicate must be `ctx.mode === "tui"` (A1); the
52-case table originally existed only in session transcript — now committed (Q1).

**Follow-up ledger (part of this task's definition of done for goal 3 — review A2/CR8):**
1. **ai-badger task-skill migration note** — Phase 3 text: interactive pi sessions return
   receipts by default; orchestrators record tokens from the `delegation-result` message
   (`details.usage`) or pass `background:false` for synchronous panel review; seam review
   happens as followUps land. Touch `skills/task/SKILL.md` + `references/lane-dispatch-brief.md` + delegator persona in the ai-badger repo.
2. **`pi_session_source.delegation_usage`** (ai-badger, currently `lambda: None`) — implement
   by parsing `~/.pi/agent/subagent-logs/<runId>.jsonl` usage lines. **Makes R4's log format a
   cross-repo contract: format changes need coordination.**
3. Deferred: optional per-run `timeoutMs` (A12); followUp burst batching if panels exceed ~6 (CR11).
