# TASK SNAPSHOT — pbi-queue-admission-monitors-results-cache

**Purpose of this file:** complete handoff for a compacted/fresh session. Everything needed to
resume lives here; do not re-derive. After compaction: `cd /Users/arasz/RiderProjects/pi-badger-integration`,
run `python3 .ai-badger/skills/task/scripts/task_tracker.py status` (task shows STARTED; session id
unchanged by compaction — if the tracker disowns the session, run `task_tracker.py reattach
pbi-queue-admission-monitors-results-cache`), then work in the task worktree below.

## Identity & state

- **taskId:** `pbi-queue-admission-monitors-results-cache` — **STARTED** (not finished)
- **branch:** `task/pbi-queue-admission-monitors-results-cache` · tip `b760d77` (WIP commit)
- **worktree:** `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-queue-admission-monitors-results-cache`
  — ALL implementation happens there, never in the shared main checkout
- **main tip at snapshot:** `98ae18a` (den-refresh 0.159.0). A **sibling session shares this
  repo/checkout** — `git log main` may have moved again; check before merging. If the main
  checkout is occupied on another branch, do main-ref ops via a temp worktree
  (`git worktree add /tmp/x main`), never switch the shared checkout, never commit the
  sibling's uncommitted files. An `origin` remote now exists (sibling added it) — do NOT push.
- **effort: HIGH** (user-confirmed). **Cache read surface: option (c)** — structured event
  cards AND a query action.

## User spec (verbatim intent)

1. Improvement to delegation model and monitor.
2. `/monitors` command for the human to observe monitors.
3. Delegation: (a) queue-only admission — `delegate` itself inserts into the queue
   (one-element serial group), no start-now bypass, the queue is the only way delegations run;
   (b) `delegations wait` action REMOVED — the only waiting surface is the monitor extension's
   `wait` tool, which a user steer interrupts (proven live at 30 s); (c) delegation returns
   results, structured: `{parent_id, delegation_id, task_summary, persona, input, output,
   timestamp}` — delegation finishes → result to result cache → event to parent with output.
4. Result cache: in-memory only, ring of the **last 8** outputs, indexed by `delegation_id`
   and secondarily grouped by `parent_id`.

## DONE (commit `b760d77`, in the task worktree — unpushed, on the task branch)

- `extensions/subagent/index.ts` — `delegate` execute now calls
  `registry.enqueueGroup([request], "serial")` (queue-only admission; idle system drains
  immediately = identical UX; behind groups it queues its turn). Receipt built from the member
  outcome; `background:false`-rejection redirect updated to the monitor's wait tool; delegate
  description rewritten (queue-only admission wording). `registry.start()` remains the
  programmatic API (tests use it) — the TOOL never bypasses.
- `extensions/subagent/delegation-status.ts` — `wait` action removed from the delegations tool
  (schema union, runAction case, ids/timeoutMs params, WAIT_DEFAULT_MS/WAIT_MAX_MS +
  clampWaitMs deleted, description rewritten: NO wait verb, redirect to monitor wait tool).
- Gates at WIP time: NOT yet green — test migration is the first TODO (typecheck fails on
  `tests/subagent-status.test.ts` importing the removed `WAIT_DEFAULT_MS`/`WAIT_MAX_MS`).

## TODO — ordered checklist

1. **Test migration for the wait removal** (make `bun run typecheck` + `bun run test` green):
   - `tests/subagent-status.test.ts`: remove `WAIT_DEFAULT_MS`/`WAIT_MAX_MS` imports (~:41-42);
     DELETE the tool-level wait rows in "T76: delegations tool contract details" ("wait timeout
     resolves…", "wait on an unknown id…", "wait on a terminal id…", "wait bounds: default
     120 s…"). KEEP the registry-level `registry.wait()` rows (T65 describe "registry
     transition events and wait") — the registry API stays; only the TOOL verb is gone.
   - `tests/subagent-extension.test.ts`: rows ~:302 (background:false guidance asserts
     "delegations wait") and ~:668-688 (T91/B-A3 description pins asserting "delegations wait"
     / "delegations wait ids") → update to the new redirect ("the monitor extension's wait
     tool (user input interrupts it)").
   - `grep -rn "delegations wait" extensions/ tests/ README.md` → drive to zero (excluding
     history): known sites — `extensions/monitor/index.ts:~477` (wait-tool description
     suggests delegations wait), `extensions/subagent/delegation-registry.ts:~172,~226`
     (rejection reasons), `extensions/subagent/delegation-status.ts:~64` (stale bounds comment
     — delete) and `~:434`-area (stale sync-panel description line — verify against the new
     text, keep one).
2. **New tool-level rows pinning the f: ruling**: delegate on an idle system → receipt
   `running` (dequeue-on-enqueue); delegate while a slot-blocked head exists → receipt
   `queued (position N)` — NO bypass (the tool-level pin of queue-only admission).
3. **Version**: `extensions/subagent/package.json` 1.1.0 → **1.2.0** (behavior change).
4. **`/monitors` command** (monitor extension): `pi.registerCommand("monitors", …)` in
   `extensions/monitor/index.ts` — no args → armed monitors (id, name, predicate excerpt, age,
   time-left) mirroring the `/delegations` command's `commandResult(ctx, …, "info")` pattern;
   `cancel <id>` → disarm. Tests through the fake-pi harness `commands` map. A headless
   degrade note if `ctx.hasUI` is false (mirror /delegations).
5. **Structured result events**: `DelegationNote` ALREADY carries `sessionId` (= parent_id;
   delegation-runner.ts:103), `answer`, `task`, `agent`. Build
   `{parent_id: note.sessionId (omit the field when undefined — schema stays honest),
   delegation_id: note.id, task_summary: first line of task capped ~120 chars,
   persona: note.agent, input: note.task capped ~2 KB, output: note.answer capped ~6 KB,
   timestamp: finishedAt ISO}` and attach as `result` on the delegation-result card's
   `details` (the human-readable card content stays unchanged — the structured payload rides
   `details` for programmatic use; "event to parent with output" ✓).
6. **Result cache**: new `extensions/subagent/result-cache.ts` (pure class, no imports beyond
   node types): ring of the last **8** results + `Map<delegation_id, entry>` +
   `Map<parent_id, entry[]>` (insertion order = grouping). Eviction of the oldest removes it
   from the ring AND both indexes. Wire at the notify wire in `index.ts` (`deliverNote`):
   build the structured result from the note, `cache.put(...)`, then send cards. Query
   surface (option c): the `delegations` tool gains a **`results [id]`** action — no id →
   cached results grouped by the CURRENT session's parent_id (the tool's `ctx` carries
   `sessionManager.getSessionId()` — the delegations execute already stashes `currentCtx`);
   with id → that delegation's cached result. Unknown id → loud "not in the result cache".
7. **Gates + ship**: `bun run test` + `bun run typecheck` green → commit(s) per package →
   `task_tracker.py finish pbi-queue-admission-monitors-results-cache` → reflect (memory +
   semantica) → merge to main (temp worktree if the main checkout is occupied — see
   concurrency note) → `bun run publish` + `bun run check` → report.

## High-effort process requirement (user chose HIGH)

The design is pinned by this snapshot (treat §Design pins + §TODO as the plan — the
architecture was MoE-planned and triple-reviewed in the previous task; the delta here is
small). Proportionate high-effort execution: (1) run a **plan-review MoE (2-3 experts,
test-engineer + code-reviewer)** on this snapshot's TODO + design pins before implementing —
fold MUSTs; (2) implement in **two lanes** (A: subagent-side = TODO 1, 2, 3, 5, 6; B:
monitor-side = TODO 4 — disjoint files) each with its own worktree off the task branch and
RED-pasted TDD; (3) implementation review + QA (review-tests) on the changed test files;
(4) gates; then the close/reflect/merge/publish chain. Compressing the MoE to fewer reviewers
is acceptable ONLY if the user says so — they explicitly chose HIGH.

## Design pins (ruled — do not re-derive)

- `parent_id` = the delegating pi session's id (`DelegationNote.sessionId`, already captured
  via `toolCtx.sessionManager.getSessionId()` in the delegate execute).
- Option (c): the structured result rides the followUp card `details.result` AND
  `delegations results [id]` queries the cache.
- Cache is **in-memory only** — dies with the session (user explicit). No persistence, no
  journal, no log-dir involvement.
- The queue tool and `delegate` both insert into the ONE queue (registry groups); `delegate`
  = one-element serial group. `queue add/add-parallel` keep explicit group semantics.
- The ONLY waiting surface = the monitor extension's `wait` tool (input-interruptible).
  `delegations wait` is gone. The poll guard (4th list/log in 120 s blocked) unchanged.
- Child denylist stays `delegate,delegations,queue,monitor,wait`.

## Architecture map (where things live)

- `extensions/subagent/index.ts` — delegate/queue tool wiring, notify wire (`deliverNote` +
  2 s batch window + heldNotes), `allocateId` closure (session `allocatedIds` set — never
  remove), unknown-persona shared builder, `queueOpts` injection.
- `extensions/subagent/delegation-registry.ts` — `enqueueGroup`/`clearQueue`/`wait`/`abort`;
  **CRITICAL INVARIANT (review MUST-1): two-phase enqueue — register ALL members' records +
  deferreds + queuedRequests BEFORE spawning any member** (a serial head settling
  synchronously mid-enqueue otherwise drops the promotion and wedges admission on a phantom;
  pinned by the M1 row in delegation-groups.test.ts). `emitTransition` is `stopped`-guarded
  (row-38 symmetry).
- `extensions/subagent/delegation-core.ts` — pure admission: `admitRequest`/`releaseRun`/
  `enqueueGroup`/`drainAdmission`/`liveQueuePosition`; caps 4 running / 16 queued, counted in
  tasks; parallel group > cap rejected at enqueue; all-or-nothing.
- `extensions/subagent/delegation-runner.ts` — spawns children (`pi -p --mode json`), watchdog
  + timeout timers armed at SPAWN only; `DelegationNote` (sessionId :103, answer, task, agent).
- `extensions/subagent/delegation-status.ts` — `delegations` tool (list/log/abort ONLY now) +
  `/delegations` command + widget.
- `extensions/subagent/delegation-queue.ts` — `queue` tool (add/add-parallel/clear/list,
  tui-only), `livePositions()`.
- `extensions/monitor/index.ts` — `monitor` tool (register/list/cancel), `wait` tool (all
  modes, input-interruptible), `tool_call` poll guard, `monitor-event` renderer, session
  handlers. Deps: now/scheduler/maxMonitors/pollGuard.
- `extensions/monitor/monitor-core.ts` — pure: vm predicate eval (250 ms, non-primitive →
  error+disarm), one-shot edge, event composition, clamps, `pollingDecision`.
- `tests/helpers/fake-pi.ts` — THE shared harness: handlers-map (`on` stores ARRAYS per
  event — regression-pinned), EventEmitter routing bus (`fireTransition`), captured
  `sendMessage`/`appendEntry`, `commands` map, mutable `clock`. `tests/helpers/fake-child.ts`
  — FakeChild (kill records, close synchronous).
- Conventions: behaviour-sentence test names; describe blocks named after row ids; RED output
  pasted per row; injected clock/scheduler; no real children (gated `PI_BADGER_SMOKE=1`);
  version per `package.json`; publish = file install to `~/.pi/agent/extensions/<name>/`.
- Prior-task records (architecture + rulings R1–R10):
  `docs/work/2026-09-01-monitor-queue-delegation-research.md` and
  `docs/work/2026-09-01-monitor-queue-delegation-plan.md` (in main).

## Concurrency & environment notes

- A sibling session shares this repo. It has: merged bus-push-delivery work to main
  (`728db83`, `eac85b3`), added an `origin` remote, and switched the shared checkout between
  branches mid-task. Rules: check `git log main --oneline -1` + `git branch --show-current`
  before any main-ref operation; temp-worktree pattern for main ops; never `git push`.
- The main checkout is currently ON `main` (sibling switched it back) with a CLEAN tree.
- `extensions/pi-mcp-tools/node_modules` is gitignored — a fresh worktree needs
  `bun install` at root AND inside `extensions/pi-mcp-tools/` (and `extensions/subagent/`,
  `extensions/monitor/`) or the baseline suite/typecheck is red.
- After compaction the memory bank carries two durable entries on the pi SDK facts and the
  delegation/monitor architecture (search "pi extension SDK facts" / "delegation + monitor
  architecture"); the memory-first gate may also fire before repo searches.

## Snapshot meta

- Written 2026-09-02 by the orchestrating session (startContextTokens 38545; session heavily
  loaded — hence this handoff).
- Previous task (context for continuity): `pbi-monitor-queue-delegation-rework` FINISHED —
  built the monitor extension, queue-of-groups admission, blocking removal; its plan +
  research records are the architecture reference cited above.
