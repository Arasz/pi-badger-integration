# Research record — pbi-interactive-background-subagent-delegation

Status: PLANNING ONLY. Implementation is blocked on `pbi-move-extensions-to-dir-packages`
(state=STARTED, worktree `.ai-badger/worktrees/pbi-move-extensions-to-dir-packages`, branch
`task/pbi-move-extensions-to-dir-packages`). Every finding below cites how it is known.

## User goal (verbatim intent)

1. Main agent loop stays **fully interactive** when any number of subagents are delegated.
2. There is a way to **check on subagents' progress and logs**.
3. Wait for `pbi-move-extensions-to-dir-packages` to fully finish before implementing; plan now. High effort.

## Current state of delegation (measured — read of `extensions/subagent/index.ts` @ main 1ea120b)

- One tool, `delegate`. Its `execute` **awaits** the child `pi -p` process (`runPi`) before
  returning → the main agent turn blocks for the entire child run.
- Child argv: `pi -p --no-session --exclude-tools delegate --append-system-prompt <persona body> -- <task>`.
  stdout+stderr buffered in memory; last 64 KB returned at the end. No live progress, no
  on-disk log, no status query, no usage accounting.
- Multiple `delegate` calls in one assistant message DO run concurrently (pi parallel tool
  mode, default), but the turn cannot end until all complete — the user cannot type and the
  agent cannot react until every child exits.
- Personas: `.pi/agents/*.md` (architect, api-engineer, test-engineer, code-reviewer, qa,
  delegator) parsed by `scanPersonas` with loud per-file error reporting.

## Related existing extension (measured — read of `extensions/session-signals/session-signals.ts`)

- Footer status for in-flight delegations already exists: `DelegationTracker` +
  `renderStatus` (`⏳ delegate <agent> — 1m23s`), driven by `tool_call`/`tool_result` events,
  5 s tick. **Only works for blocking delegations** — it watches tool-call lifetime, and a
  backgrounded delegation's tool call returns immediately.
- Marker importance (`!`) mid-run abort also lives there (`input` event, `ctx.abort()`).

## pi platform capabilities (measured — pi-coding-agent 0.84.4 docs/extensions.md, docs/json.md, examples/extensions/subagent/index.ts)

1. `execute(toolCallId, params, signal, onUpdate, ctx)` — `onUpdate` streams partial results
   into the tool row (`tool_execution_update`). pi's own subagent example streams live child
   progress this way.
2. `pi.sendMessage(msg, { deliverAs: "followUp" | "steer", triggerTurn: true })` — extension
   can inject a message that wakes the agent when idle; `followUp` queues behind an active
   run. This is the platform's "notification that actually arrives".
3. `pi.appendEntry(customType, data)` + `registerEntryRenderer` — durable TUI-only cards, not
   in LLM context, reconstructible from session entries.
4. `ctx.ui.setWidget` (above/below editor), `ctx.ui.setStatus` (footer slot — separate from
   widgets), `pi.registerCommand` with `getArgumentCompletions`.
5. `--mode json -p` children emit JSON-line events (`agent_start`, `turn_start`,
   `message_start/update/end` with per-message `usage`, `tool_execution_start/update/end`,
   `agent_end`). pi's example line-buffers and parses these live to accumulate usage and
   emit `onUpdate` per `message_end`. `session` header line first, then events.
6. State reconstruction pattern: persist state in tool-result `details`; rebuild on
   `session_start` from `ctx.sessionManager.getBranch()`.
7. `session_shutdown` is the cleanup point for session-scoped resources.
8. Truncation utilities exported (`truncateTail`, 50 KB / 2000-line defaults).
9. `pi.events` — inter-extension event bus.

## Repo constraints (measured)

- Extension deliberately did NOT vendor pi's 35 KB subagent example (header comment in
  `extensions/subagent/index.ts`): new code must stay lean and purpose-built. The ~80-line
  JSON-parse loop pattern is knowledge, not vendored code.
- Child must keep `--exclude-tools delegate` (no recursive delegation).
- Tests: bun test; real extension loaded through jiti with injectable `spawn` (`runPi` takes
  `spawnFn`) — the new design must keep this seam. `tests/setup.ts` documents the loader.
- publish.ts today ships 3 targets (adapter dir, 2 single-file). The `subagent` extension is
  installed user-scope as a directory `~/.pi/agent/extensions/ai-badger-subagent/` (currently
  byte-identical to canonical — diffed). `pbi-move-extensions-to-dir-packages` will move
  publish to directory-package targets; the finished layout is the base for this task.
- config.json: `commands.test=bun run test`, `commands.lint=bun run typecheck`; personas:
  architect, api-engineer, test-engineer, code-reviewer (+ qa, delegator); `sourceControl.platform=none` → no PR flow, local commits.

## Memory findings (cited)

- `shared/d968…` (reference-subagent-background-push, 2026-07-28): a subagent's backgrounded
  shell died when its turn ended; one agent stalled forever waiting for a notification that
  could not arrive while the harness said "finished". Lesson: background delegations need a
  completion notification path that provably lands (see capability 2) and must not depend on
  the child's own backgrounded processes.
- `shared/…0.115.1-disjoint-files-are-not-isolation` (ai-badger changelog): agents sharing
  build output make green runs meaningless. Relevant for parallel delegations: per-child cwd
  choice stays the caller's responsibility, but the tool should accept a `cwd` override so
  worktree-isolated lanes are possible.

## Hypotheses (unverified — must be proven during implementation)

- H1: `pi.sendMessage(triggerTurn: true)` while the TUI is idle reliably wakes the session
  (docs say yes; needs a manual interactive test).
- H2: `--mode json` children accept `--append-system-prompt` (pi's example passes it, so
  likely yes; verify with one real child run).
- H3: Tool-result `details` are final once `execute` returns — a backgrounded delegation's
  final output CANNOT be retro-fitted into the original tool result; it must arrive as a
  later injected message. Session replay must handle both shapes. (Follows from the API
  shape; verify during design.)
- H4: Bun spawn of children that outlive the spawning turn behaves like node for
  SIGTERM/SIGKILL escalation; the abort-listener pattern in pi's example carries over.
- H5: `ctx.ui.setWidget` and session-signals' `setStatus` do not fight (different slots).

## Derived taskId

`pbi-interactive-background-subagent-delegation` (alias `pbi` from repo name + in-flight
task's prefix; key = interactive background subagent delegation).

## MoE delegation ledger (token counts recorded manually — tracker not started by design)

Blocking-mode delegations return stdout only — token counts unavailable (itself evidence
for the JSON-mode ruling R3 in the plan). Backfill at execution time.

| # | persona | phase |
|---|---------|-------|
| 1 | architect | plan authoring |
| 2 | api-engineer | plan authoring |
| 3 | test-engineer | plan authoring |
| 4 | code-reviewer | plan review |
| 5 | qa | plan review |
| 6 | architect | plan review |
