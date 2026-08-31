# Manual-evidence checklist — pbi-interactive-background-subagent-delegation

One row per check the automated suites cannot prove (qa review finding 5). Each row: the
exact command, the observable pass condition, and an evidence slot. **The task is not done
while a slot is empty.** Automated evidence already recorded: H2 and H4 by
`PI_BADGER_SMOKE=1 bun test tests/subagent-real-child.test.ts` (2 pass / 0 fail / 0 skip,
2026-08-30, commit 3a85012); porcelain cleanliness structural (children run in temp dirs);
publish drift zero; fresh-session load functional (see below).

| # | Check | Command | Pass condition | Evidence |
|---|-------|---------|----------------|----------|
| M1 | **H1** — a `delegation-result` followUp wakes an idle TUI session | `pi` in any ai-badger-scaffolded project → prompt: "delegate to the qa persona in the background: reply with exactly ok" → wait for completion without typing | A `delegation-result` card appears in the transcript AND the agent reacts without a user prompt (a new assistant turn starts on delivery) | ☐ |
| M2 | **H5** — widget and footer coexist without visual fight | During M1's run: capture the screen while the delegation runs | Widget shows the run (id/agent/elapsed/activity); session-signals footer shows no 0-second flash for the background receipt; no overlapping/duplicated render | ☐ |
| M3 | e2e — three background delegations while the user keeps typing | `pi` → prompt dispatching 3 background delegations (any personas, trivial tasks) → type and send a question while they run → wait | All three answers land in sequence as they finish; the interleaved question is answered normally; no lost or duplicated results | ☐ |
| M4 | e2e — restart mid-run | Start a long background delegation → quit pi (Ctrl+C twice) → relaunch `pi` → `/delegations` (or ask the agent to run `delegations` list) | The run reports as lost/orphaned with its id and log path; NO wake-up message fires after restart; `~/.pi/agent/subagent-logs/<id>.jsonl` exists and ends without an exit line | ☐ |
| M5 | MoE-panel-style run in TUI | Prompt: "delegate in the background to architect, api-engineer and test-engineer: each replies with exactly ok; then summarize" | Three receipts return immediately; three followUps land; the summary turn integrates all three | ☐ |

## Automated evidence (already recorded — for the archive)

- **H2** (json-mode + append-system-prompt): smoke row 51 green — real child completed, usage
  > 0, answer delivered in the note, run-header log line written. Measured cold start from a
  fresh dir: ~62 s (one retry cycle) — the smoke watchdog is 120 s for that reason.
- **H4** (SIGTERM→SIGKILL on a real child): smoke row 52 green — child killed in ~100 ms,
  run settled `aborted`.
- **Publish**: `bun run publish` installed 6 files → `~/.pi/agent/extensions/subagent/`;
  `bun run check` in sync (exit 0).
- **Fresh-session load**: `pi -p --no-session "Call the delegations tool with action 'list'…"`
  → tool callable, answered "no delegations have been started"; no duplicate-registration
  warnings (stale `ai-badger-subagent/` confirmed absent from user scope).
- **Suites**: 332 pass / 0 fail (unit, 17 files) + smoke 2/0 with gate set; `bun run
  typecheck` exit 0.

## Manual evidence (deferred rows — T79–T105 task)

| Id  | Check | Command | Expect | Slot |
|-----|-------|---------|--------|------|
| M6 | **Batched-card rendering in a real TUI** (pbi-delegation-timeout-and-burst-batching, plan §6.4) — unit pins cannot see the actual renderer box | `pi` → prompt: "delegate in the background to architect, api-engineer, test-engineer, planner, qa and docs — each replies with exactly ok; then summarize" (or any 3+ near-simultaneous background delegations) → keep typing while they complete | The first completion lands as a normal single card; the near-simultaneous rest land as ONE batched `delegation-result` message — one box, one divider (`———`) between cards, each card's verdict line colored by its own state, whole message ≤ 8 KB — and the summary turn integrates them | ☐ |
| M7 | **Live `delegations list` liveness column** (liveness spec AC1; also the R0 manual evidence) | In a live pi session: run `delegations` (list) while a background delegation is in flight → then quit the child by hand (`kill -9 <pid>` from the run header) and run `delegations` list again | While running: the run's line carries `alive`. After the kill: the same line shows `lost (dead pid)` and the registry still counts the run until the watchdog settles it `aborted (lost)`. The session's own runs are listed (no "registry empty" against reality); with the registry genuinely empty the tool says "registry empty (0 records)" | ☐ |
| M8 | **A real watchdog firing: the lost card** (liveness spec AC10; RR2's terminal transition in a live session) | Start a background delegation on a long task, then `kill -9` the child's pid mid-run so no `close` event is the visible cause; wait past the configured watchdog (default 10 min, or start the session with a short injected `runWatchdogMs`) | Exactly one `delegation-result` card arrives with the verdict "Delegation d-N (agent) stopped responding (no output for 10m00s) and was aborted.", the run's panel line renders `aborted (lost)`, and the run's log file ends with no `exit` line (unrecorded spend, RR5) | ☐ |
