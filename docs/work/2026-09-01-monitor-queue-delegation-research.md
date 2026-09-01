# Research record — background monitor, idle waiting, queued non-blocking delegation

Task: `pbi-monitor-queue-delegation-rework` (high-effort). Consolidated from three parallel
read-only research lanes (d-227 architect/pi-SDK, d-228 api-engineer/subagent-internals,
d-229 test-engineer/house-style). Raw records: `/tmp/d-227-report.md`, `/tmp/d-228-report.md`,
`/tmp/d-229-report.md`. Every claim carries a `file:line` citation from those lanes; anything
unverified is labelled HYPOTHESIS. Read time: pi 0.84.4 (`@earendil-works/pi-coding-agent`).

## User requirements (verbatim intent)

1. New **monitor** extension: takes "any predicate logic", sends an event/interruption to the
   agent that triggered it, fully in the background.
2. If pi has no "just do nothing" option (no model interaction; harness waits for delegation
   results / monitor / user prompt) — add it as an extension.
3. Enforce monitor usage: **manual polling is blocked** when detected.
4. Remove **blocking delegation** (today the agent can block on a delegation while user
   messages queue). Extend delegation with **queue behavior**:
   - `queue()` — standard: task dequeues when the previous finishes.
   - `queue_parallel()` — takes a group; dequeued together, executed in parallel; the queue
     always accepts groups (arrays); single-task queue = one-element group.
   - `clear()` — flush the queue, cancelling all tasks.
   Goal: the main loop stays always responsive; strict ordering stays available to the agent.

## A. pi SDK facts (d-227; sources: installed pi docs + dist + extensions/)

- **A1. Idle-wake wire (proven):** `pi.sendMessage({customType, content, display, details},
  {deliverAs: "followUp", triggerTurn: true})` — while streaming it queues behind the run;
  when idle it **starts a new agent run** (agent-session.js:1119–1121; docs/extensions.md:
  1433–1437). Precedents: subagent result cards (extensions/subagent/index.ts:607–627),
  pi's own `file-trigger` example. `pi.sendUserMessage(content, {deliverAs})` is the
  user-turn-equivalent, always triggers a turn (extensions.md:1439–1462).
- **A2. Delivery modes:** `"steer"` injects before the next LLM call (mid-run, does not stop
  streaming); `"followUp"` delivered when the run would otherwise stop; `"nextTurn"` parks for
  the next prompt without triggering. True interruption of streaming output is only
  `ctx.abort()` (≈ Escape; agent-session.js:1222–1226).
- **A3. Idle shape:** when the model ends a turn with no pending tool calls and no queued
  steer/followUp, the loop breaks and emits `agent_end` then `agent_settled`; control returns
  to the user (pi-agent-core agent-loop.js:83–168; extensions.md:567–581). `input` events still
  fire while busy and carry `streamingBehavior` ("steer" | "followUp" | undefined=idle)
  (types.d.ts:657–667; session-signals/index.ts:148–161).
- **A4. The only "wait without model interaction" primitive is a pending tool:** the agent loop
  awaits a tool's `execute` promise with no timeout (agent-loop.js:455); while pending, the run
  stays active and no LLM call happens. `delegations wait` already exploits this
  (delegation-status.ts:414). `onUpdate` streams progress from a pending tool.
- **A5. Enforcement hook:** a `pi.on("tool_call")` handler can **block** a tool call by
  returning `{block: true, reason}` (docs/extensions.md:778–794) — fires before execution,
  `event.input` inspectable.
- **A6. Extension lifecycle rules:** factories must not start background resources — arm
  timers/watchers from `session_start`, clean up in `session_shutdown` (extensions.md:112–118).
  UI: `ctx.ui.setWidget/setStatus` + `setInterval` ticker while live (delegation-status.ts:
  262–296); guard with `ctx.hasUI` / `ctx.mode === "tui"`.
- **A7. Mode degradation discipline:** background delivery degrades outside TUI; the subagent
  blocks fully and flags `details.degraded` in print/json modes (index.ts:837–845).

## B. Subagent extension internals (d-228; extensions/subagent/, ~3.3k lines)

- **B1. Components:** `delegation-core.ts` = pure policy (`admitRequest`/`releaseRun`, caps:
  4 running / 16 queued FIFO, records, run-id allocator, log classifier);
  `delegation-runner.ts` = the only process-touching module (spawn, tee, timeout+watchdog
  timers armed **after spawn**); `delegation-registry.ts` = admission state,
  `queuedRequests` Map (the actual FIFO), wait(), abort/abortAll/shutdown, transition
  snapshots on `pi.events`; `index.ts` = the only pi import (tool schema, mode rule,
  followUp wire, batching, log dir, reconstruction); `delegation-status.ts` = `delegations`
  tool (list/log/abort/wait) + `/delegations` command + widget.
- **B2. Blocking path is thin and confined to index.ts:** mode rule `index.ts:845–849`
  (`wantsBackground = params.background ?? mode === "tui"`; explicit values win; explicit
  `background:true` outside tui degrades to blocking, T67), branch `:884–887`,
  `blockingResult` `:922–963` (awaits `outcome.done`, streams progress via
  `latestProgress`/`progressSubscribers`), `blockingContent` `:970–1013`, `BlockingDetails`
  `:309–318`. The registry/runner never knew about "blocking" (T59: blocking = a caller that
  awaits `done`). ~9 pinned tests: T66 matrix, T67 degrade, T90 (tests/subagent-extension.test.ts).
- **B3. Headless is a pinned contract:** R2/AC6 — "rpc/json/print modes block" — exists so
  ai-badger's delegation map gets inline answers in headless `pi -p` runs (plan
  2026-interactive-subagent-delegation.md:46; header index.ts:2–10). HYPOTHESIS (d-228):
  in headless there is no idle session for followUp+triggerTurn to wake, which is why the
  degrade exists. Any removal of blocking must make an explicit headless ruling.
- **B4. An admission queue already exists** (auto-FIFO when all 4 slots busy; queue position
  on the receipt; dequeue re-checks aborted flag; ids allocated over live log dir + live
  queued records, index.ts:694–705). The ask adds an **explicit** ordering queue on top.
- **B5. Dequeue is synchronous and single-slot:** `onSettle → releaseRun (admits exactly one)
  → spawnQueued` (delegation-core.ts:584–601; delegation-registry.ts:319). Group dequeue
  needs a group id on `StartRequest` + a group-aware multi-admit primitive beside
  `releaseRun`, preserving the before-spawn admission move that makes synchronous-settle
  cascades safe (delegation-registry.ts:330–336).
- **B6. Queue durability:** queued-but-unspawned runs leave no durable trace; shutdown aborts
  queued runs and drops notifications (R8: "delegations do not outlive the session"). The log
  dir is the single durable store, its format frozen cross-repo, and header-without-terminal
  classifies `lost`/`stale` — a durable queue would need its own journal (two truth sources)
  or a format change. HYPOTHESIS (d-228): session-scoped queue (crash = loss) is the
  consistent ruling for this task.
- **B7. Notification discipline:** exactly one wire (`runner.notify → registry.notify →
  deliverNote`), burst batching sits below it (2 s window, ≤6 cards, 8 KB budget, exactly-once
  T97). A parallel group finishing together is exactly CR11's burst shape — group completions
  MUST ride the existing batcher; any new queue status output belongs in `appendEntry`, not
  `sendMessage`.
- **B8. `delegations wait`** (120 s default / 600 s cap) is a genuine in-turn block and, after
  blocking removal, the only remaining way for the model to block on a delegation. The
  `/delegations` command has no wait verb — the tool is the only surface to police (A5).
- **B9. Status surfaces join on `toolCallId`**; `pendingResult` (delegation-status.ts) derives
  widget rows from in-flight delegate tool calls — removal of blocking changes that
  derivation (T75/T77 pin it).
- **B10. clear() maps naturally** onto abortAll-queued + `queuedRequests.clear()` + deferred
  resolution; abort paths need no other change.

## C. House style for a new extension (d-229)

- **C1. Add = 3 touchpoints:** `extensions/monitor/{index.ts,package.json}` (house shape:
  private, type module, main index.ts, dep `@earendil-works/pi-coding-agent: "*"`), `bun
  install` in the dir (canonical bun.lock/node_modules), and one line in `EXTENSION_DIRS`
  (publish.ts:68) + README table row (README.md:18–23). Everything else (typecheck include,
  discovery via `~/.pi/agent/extensions/<name>/index.ts`) is automatic.
- **C2. pi-cron never delivers to a session** (scheduler only; launchd fires outside pi) —
  the monitor's in-process push fills a real gap. The subagent notification wire is the house
  pattern to copy.
- **C3. Tests:** bun:test; `tests/<extension>/<topic>.test.ts`; behaviour-sentence test names;
  fake-pi handlers-map whose `on` **stores handler arrays** per event (single-slot storage
  broke shutdown cleanup once — tests/subagent-extension.test.ts:58–110); `sendMessage`
  captured and asserted with exact options `{deliverAs: "followUp", triggerTurn: true}`;
  FakeChild contract (kill records, close synchronous) + injected clock/deps; real
  micro-sleeps for timing windows with explicit per-test timeouts; publish tests inject TEMP
  fixture trees. Gates: `bun run test`, `bun run typecheck` (covers new dirs automatically).

## D. Design tensions the planning panel must rule on

1. **Blocking removal scope vs the headless contract (B3).** Recommendation to evaluate:
   interactive modes become always-background (remove the agent-facing blocking choice —
   explicit `background:false` in tui is rejected with guidance pointing at queue/wait);
   headless keeps today's blocking default (programmatic consumers depend on inline answers).
   Alternative: remove blocking everywhere and migrate headless consumers to receipts +
   log-dir results (cross-repo cost, format frozen).
2. **Queue model.** Recommendation to evaluate: the queue is a FIFO of **groups**; a group =
   `{mode: "serial" | "parallel", tasks: [...]}`; serial group runs members one-by-one,
   parallel group runs members concurrently; the next group dequeues when the whole previous
   group settled. `queue()` = serial group; `queue_parallel()` = parallel group; single task =
   one-element group (matches "single queue is just a special case of [task]"). Open: enqueue
   validation when a parallel group exceeds the running cap; whether run-now (start) delegates
   gate the queue or coexist.
3. **Where the queue lives.** Registry layer (owns admission + queued bookkeeping) with a pure
   group-aware primitive in the core; surface = a new tool in the subagent extension
   (naming: `queue`? actions add/add-parallel/clear/list?) riding the same registry instance.
4. **Monitor predicate language + sources.** "Any predicate logic" — evaluate a JS predicate
   string evaluated in-process against a snapshot (delegation transitions from `pi.events`,
   monitor-registered timers, session state) vs shell-command predicates vs structured
   event-match patterns. Trust stance: the monitor runs in the user's own pi process with the
   user's own permissions (same trust level as extension code), but arbitrary `new Function`
   needs an explicit ruling.
5. **Idle/wait tool design.** Pending-tool idiom (A4): resolves on delegation settle
   (subscribable via `pi.events` transition channel — no cross-extension import), monitor
   fire, user input (`input` event fires while busy — A3), or timeout. Open: relation to
   `delegations wait` (B8) — supersede, keep, or absorb.
6. **Enforcement design.** A5's `tool_call` block: what counts as manual polling (repeated
   `delegations list`/`log`? `wait`?), the window/threshold, the guidance message, and which
   extension owns it.
7. **Naming + registration:** one new extension ("monitor") owning monitor + wait +
   enforcement; queue tools live in the subagent extension; `EXTENSION_DIRS` +1.
