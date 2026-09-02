# FOLDED PLAN — pbi-queue-admission-monitors-results-cache

Plan-review MoE ran 2026-09-02: d-287 (test-engineer), d-288 (code-reviewer). Both verdicts
**READY-WITH-FOLDS**. Base: snapshot `2026-09-02-queue-admission-monitors-results-snapshot.md`
(design pins + TODO 1–7 remain in force; this file records the folds and the lane split).

## Folded rulings (consolidated MoE findings)

- **M1** `extensions/subagent/index.ts:548` — delegate `background` param description still says
  "or delegations wait to wait for results". Rewrite to the monitor-wait redirect. (Both experts.)
- **M2** `delegation-status.ts:13-15` header docstring carries dangling stale wait text
  ("default, 600 s max, timeout resolving with per-id state snapshots… terminal id returns
  immediately") — **grep-invisible** (no "delegations wait" string). Delete fragment. Also
  `:118` "the LLM tool's list/wait output" → "list output".
- **M3** Lane collision fix: `monitor/index.ts:477` (requireTui rejection advertising
  "delegations wait") belongs to **lane B**. In non-tui the redirect target is gone; headless
  `delegate` blocks by default — drop the sentence or point at headless blocking semantics.
- **M4** Monitor extension ships user-visible `/monitors` → `extensions/monitor/package.json`
  1.0.0 → **1.1.0** (alongside subagent 1.1.0 → **1.2.0**).
- **M5** Batch path: `sendCards` has two shapes — single `details:{...note}` and batched
  `details:{batched:true,notes:[...]}`. Structured result rides **each card**:
  `details.result` (single), `details.notes[i].result` (batched). Batched-path test row demanded.
- **M6** Cache→tool seam: `registerDelegationStatus` opts gains `resultCache` ({byId, byParent})
  — the established `staleRuns` pattern; cache constructed in `index.ts` before the register
  call. **No import of index.ts inside delegation-status.ts** (cycle rule). Session-id for
  no-id `results`: defensive cast + try/catch `sessionManager?.getSessionId()` duplicated in
  delegation-status; unresolvable → loud "cannot determine the current session — pass an id",
  never silent empty.
- **M7** Demanded cache test rows: dual-index eviction (9 puts → oldest gone from ring AND byId
  AND byParent; parent array spliced, order kept; parent-with-3-entries variant); unknown-id
  loud failure byte-distinct from registry's unknown-id, never consult registry.get;
  `!("parent_id" in entry)` when note.sessionId undefined; session grouping (no-id → only
  parent_id === current session); `subagent-status.test.ts` makeCtx (:112) gains
  `sessionManager`; absent sessionManager → empty group, not a throw.
- **M8** Monitor test harness: `monitor-extension.test.ts` makeCtx (:116-121) notify stub is a
  no-op → extend to capture notifications (mirror `subagent-extension.test.ts:114-122`) before
  any /monitors rows.
- **M9** TODO 2 rows already exist green at b760d77: `subagent-extension.test.ts:359` (idle →
  receipt `running`) and T68 (:374-384, cap full → `queued (position 1)`, no bypass). Fold:
  annotate both with the f: ruling + ONE new intersection row — delegate queued behind a
  **queue-tool** group head → position 2. Determinism: admission is synchronous; assert before
  settling the child.

### Adopted SHOULDs

- cache.put at `deliverNote` **entry**, before the batch-window branch; `flushHeldNotes` /
  `sendCards` never put; put-before-send so a sendMessage failure still caches.
- cache class owns the note→entry builder; `put(note, { now })`; `timestamp` = injected-clock
  ISO at put-time (**no phantom `finishedAt` on DelegationNote** — it has only `durationMs`).
- put() hygiene: parent_id undefined → skip parent index; parent key deleted when its array
  empties; duplicate delegation_id → old entry removed from ring+parent before insert;
  aborted/failed notes DO enter the cache.
- Unknown-id disambiguation via registry: live/queued → "no cached result yet (state: running)";
  terminal-but-absent → "not in the cache (last 8) — the run may predate the window; use
  delegations list".
- Poll guard counts `results` (one no-id call returns everything; counting costs nothing
  legitimate) — `monitor/index.ts:~705` counted set list|log → list|log|results. **Lane B.**
- README: additions, not just grep-to-zero — results row (lane A), /monitors row (lane B);
  lines ~46-47 sync-panel sentence → monitor-wait redirect (lane A), ~:60 wait-verb (lane A).
- `/monitors` cancel: command path calls internal disarm/list helpers that **skip the
  requireTui gate** (commands are TUI by definition; command-ctx `.mode` presence unverified).
  Headless behaviour = silent no-op via commandResult (mirror /delegations), not an invented
  notify.
- Truncation: caps count **chars**. output (answer, 6000) → tail-keep with the existing
  `[...N earlier characters dropped]` marker (answer lives at the end); input (2000) and
  task_summary (first line ≤120) → head-cap with `…`. Marker strings pinned in tests.
- TODO 5+6 implemented as ONE unit (cache class + builder + wiring + results action) so
  delegation-status.ts is edited once. Default-case error text gains `results`
  ("must be one of list, log, abort, results").
- `.ai-badger/state.json:45` exempt from the grep gate (orchestrator fixes at finish).
- Option (c) re-affirmed by code-reviewer: stands, no cheaper alternative.

## Lane split (worktree-isolated, parallel)

### Lane A — subagent-side. Branch `lane/pbi-queue-a` off task branch. Version: subagent 1.2.0.
TODO 1 (test migration + stale text M1/M2), TODO 2 (M9 annotations + intersection row),
TODO 3 (1.2.0), TODO 5+6 as one unit (result-cache.ts + wiring + results action, M5/M6/M7),
README subagent sections. Owns: `extensions/subagent/**`, `tests/subagent-status.test.ts`,
`tests/subagent-extension.test.ts`, README (subagent rows). Must NOT touch:
`extensions/monitor/**`, `tests/monitor/**`.

### Lane B — monitor-side. Branch `lane/pbi-queue-b` off task branch. Version: monitor 1.1.0.
/monitors command (M8 harness first), :477 text fix (M3), poll-guard counts `results`,
monitor 1.1.0, README monitor row. Owns: `extensions/monitor/**`, `tests/monitor/**`,
README (monitor row). Must NOT touch: `extensions/subagent/**`, `tests/subagent-*.test.ts`.

Shared: README.md only — distinct sections; integration resolves any conflict.
Sub-agents: 0 for both lanes. Gates per lane: `bun run typecheck` + `bun run test` green in
their own worktree; RED output pasted per new row.

## Remaining chain after lanes integrate
implementation review + review-tests QA on changed test files → gates → finish → reflect →
merge to main (temp worktree; main has moved to e3136df) → publish + check → report.
