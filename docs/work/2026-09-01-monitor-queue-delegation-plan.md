# Plan v2 — background monitor extension, idle waiting, queued non-blocking delegation

Task `pbi-monitor-queue-delegation-rework` (high-effort). v1 consolidated the planning MoE
(d-231/232/233); v2 folds the review MoE (d-236 code-reviewer / d-237 test-engineer / d-238
architect). MUST findings are folded; SHOULDs adopted where they simplify. Research record:
`2026-09-01-monitor-queue-delegation-research.md` (same dir). This document is the single
dispatch artifact — every test row referenced by a package resolves below.

## Rulings (changed or newly precise in v2 marked ★)

- **R1 (blocking).** TUI: `delegate` always receipts; explicit `background:false` rejected in
  execute (`reason: "blocking-removed"`, guidance → queue/wait, no child). Param STAYS in the
  schema. Headless byte-identical: no param = blocking; explicit `background:true` outside tui
  degrades to blocking with the content line AND `details.degraded` ★ (T67 survives unchanged —
  M1/code-reviewer). `blockedInTui` dies (moot). P4 pre-req: grep-audit `~/RiderProjects/
  ai-badger` for explicit `background: false|background:false` callers; record output; a hit
  gets a one-release accept-and-block shim in headless (no behavior change there). The
  framework's skill docs that instruct `background:false` are scaffold-managed — do NOT edit
  here; the rejection message is the runtime redirect; feed upstream in reflect.
- **R2 (one queue of groups).** The admission FIFO generalizes: every entry is a
  `QueueGroup {groupId, mode: "serial"|"parallel", members, pending}`. Serial group admits its
  next member only when NO member of that group is running and a slot is free; parallel group
  admits all members atomically only when all fit; the next group dequeues when the whole
  previous group settled; later groups never overtake. ★ Run-now rule made precise (M2): a
  run-now delegate admits iff a slot is free AND the queue head is not slot-blocked (a head
  waiting for members-to-settle or for a full parallel fit blocks run-now too) — pinned by two
  named rows (run-now mid-serial-group; run-now at a release a parallel head cannot use).
  Caps unchanged 4/16, counted in TASKS. ★ Serial-overflow (pending members would exceed
  queueCap 16) rejects the whole group naming the cap and the split remedy (S1). Positions:
  receipts snapshot the flat 1-based pending-member index at enqueue; `queue list` renders the
  LIVE recomputed index (S3 + S-10); pin: after clear, survivor positions recompute.
- **R3 (oversize parallel).** Parallel group larger than the running cap → rejected at enqueue
  (loud, names cap, env override, split remedy). All-or-nothing enqueue, never partial.
- **R4 (queue tool).** Dedicated `queue` tool in the subagent extension, module
  `delegation-queue.ts`, factory-registered with an injected context object (persona lookup,
  argv builder, cwd validation, unknown-persona builder — no index.ts import cycle, S6).
  Actions `add | add-parallel | clear | list`; `tasks: (string | {agent, task})[]` with
  per-task persona override; group-level `model?/cwd?/timeoutMs?`. ★ The WHOLE tool is
  tui-only (one mode rule; in headless every action rejects with guidance — S5; the queue is
  permanently empty there). `clear()` = queued-only flush via the proven queued-abort path per
  member; running untouched; N aborted notifications ride the existing batcher; result
  enumerates cancelled + still-running. ★ Member-level abort inside a group: group continues
  with remaining members; an all-aborted group collapses so the next group dequeues (S2, two
  pins).
- **R5 (denylist).** `CHILD_EXCLUDED_TOOLS = "delegate,delegations,queue,monitor,wait"` —
  ★ owned by P3 (lane A owns the file; final value written even though monitor/wait land
  later); the six pin sites migrate: tests/subagent-tool.test.ts:60–75, :87, :107,
  tests/subagent-real-child.test.ts:41, tests/subagent/subagent.test.ts:160, and the
  "Frozen" comment delegation-status.ts:41 (M4 + S-7).
- **R6 ★ (monitor core, simplified per d-238 S1/S2).** Predicate = JS expression string (4 KB
  cap), evaluated as `return (${expr})` in a **fresh `node:vm` context** with a 250 ms timeout
  — no shadowing machinery (fresh context has no process/require), **no Function fallback**
  (bun 1.4.0 honors the timeout — verified by d-237; fallback = documented restriction).
  ★ Promise-escape policy (M-5): a thenable/promise or non-primitive result maps to
  `kind:"error"` + disarm (async IIFEs are expressions and return instantly; the timeout
  cannot bound them) — pinned, including "a healthy monitor still fires after a wedged one".
  Compile failure (the vm wrap rejects statements) rejects at registration, no cap consumed.
  ★ Snapshot = `{delegations: DelegationView[], monitors: {name}[]}` — NO `now`, NO time-based
  re-evaluation: predicates evaluate on `delegation-transition` events ONLY (the shared ticker
  is abolished; d-238 S1). Monitor-event content per kind, ≤ 8 KB.
- **R7 (monitor lifetime).** One-shot, edge-triggered (fires once on first true evaluation,
  including at registration), cap 8 active (injectable). ★ Expiry = per-monitor `setTimeout`
  via an injectable scheduler dep (armed at register, cleared on fire/cancel/expire/shutdown —
  N ≤ 8, the everyMs objection does not apply to one-shot timers), default 10 m, max 60 m;
  expiry removes the monitor and delivers `kind:"expired"`. Fire: monitor removed + one
  `pi.sendMessage({customType: "monitor-event", …}, {deliverAs: "followUp", triggerTurn:
  true})` — NOT batched. Renderer: single Box, tone by kind.
- **R8 (wait tool).** Pending-tool idiom; resolves on the FIRST of: any live delegation
  settles (or a member of `ids` when given) | any armed monitor fires | the user sends a
  message | the timeout passes (default 120 s, max 600 s, clamp not reject; timeout resolves
  with a snapshot, never an error). Nothing-to-wait-for resolves immediately
  (`observed: "empty"`). ★ Tie-break: listener-invocation order (delegation → monitor → input
  → timeout); resolve-once; pinned by a same-synchronous-drain row (S-2/S3). ★ The user-input
  source ships only behind its Tier-1 probe (S-1): construct the real `ExtensionRunner`
  (dist/core/extensions/runner.js:120) with a handlers-map extension, call `emitInput`, assert
  passthrough — ~30 lines, ungated; the fake-harness row is labeled wiring-only. ★ Abort: the
  pending wait observes `ctx.signal` and resolves with `observed: "aborted"`, never an
  unhandled rejection (S5/N-4); shutdown with a pending wait resolves terminally, no
  post-shutdown sendMessage (S-9c). ★ Settle-vs-registration race pinned: a transition landing
  between liveness-read and subscribe still resolves (S-3). Payload never duplicated into the
  wait result (terse pointer). `wait` allowed in ALL modes (self-degrading). `delegations
  wait` unchanged.
- **R9 (enforcement).** Monitor extension owns a `pi.on("tool_call")` handler counting
  `delegations` with action `list|log` only. Sliding 120 s window; the **4th** counted call in
  the window is blocked (M-3 resolves the qa contradiction; W-06/E-01 fixtures rewritten to
  3-allowed/4th-blocked); blocked attempts count; `wait`/`abort`/`queue`/`monitor cancel`
  never counted. `PI_BADGER_MONITOR_POLL_MAX` read per-call (0 = off; N-4). Decision = pure
  function over an injected clock. ★ Drift guard: the wiring test fires the tool name AS
  REGISTERED by the subagent factory, not a hardcoded string (S-9b). State resets on
  session_shutdown (S-9a).
- **R10 (registration).** `extensions/monitor/` (`monitor-core.ts` pure + `index.ts` + house
  package.json + bun install), tools `monitor` (actions `register|list|cancel`) and `wait`.
  ★ The whole `monitor` tool is tui-only (one mode rule — register AND list/cancel; N-1).
  `EXTENSION_DIRS` += `"monitor"`, README row + monitor section.
- ★ **Harness (M-4/M2 — the go/no-go infrastructure item).** The fake-pi harness is extracted
  to `tests/helpers/fake-pi.ts` in P2 (lane A): handlers-map `on` storing ARRAYS per event,
  `registerTool/Command/MessageRenderer` capture, `appendEntry`, captured `sendMessage` list,
  and an **EventEmitter-backed routing bus** — `events.emit` dispatches synchronously to
  registered `on` handlers (real bus semantics, dist/core/event-bus.js), subscriptions
  recorded, unsubscribe returned, `fireTransition(channel, data)` helper, emissions still
  recorded to `h.transitions` (T60 assertions untouched). Lane B consumes it from P6 on;
  mutable injected clock + injectable scheduler available to both lanes.

## Work packages — waves

Lane A owns `extensions/subagent/**` + its tests; lane B owns `extensions/monitor/**` +
`publish.ts` + README monitor parts; P9 integrates. Each lane: its own worktree branched from
the task branch, its own workspace id; TDD (RED pasted per row); gates `bun run test` +
`bun run typecheck` green before hand-off; sequential-wave merges by the orchestrator.

- **Wave 1 (parallel).**
  - **A1 (P1+P2).** Pure group admission (R2/R3 incl. serial-overflow, member-abort
    semantics, live-position helper) + registry groups (enqueueGroup with
    allocate-then-register per member ★ — pin: 3 members, 3 distinct ids (M3);
    batch-commit-before-spawn invariant pin; clear-during-synchronous-cascade pin (S-4);
    member-abort and all-aborted-collapse pins; shutdown) + **harness extraction with routing
    bus** (★ above).
  - **B1 (P5).** Monitor pure core: vm evaluation (R6 incl. promise-escape), one-shot edge,
    snapshot shape, monitor-event content composition (kinds, ≤ 8 KB), clamps (10 m/60 m,
    cap 8), poll-guard pure decision (4th/120 s, counted-blocked, env config).
- **Wave 2 (parallel).**
  - **A2 (P3+P4).** `queue` tool (R4/R5: actions, per-task override, tui-only rule, receipts
    `{groupId, mode, tasks}`, live-position list rendering, denylist final value + 6 pin
    sites, batcher exactly-once for clear) + blocking removal (R1: tui rejection, headless
    unchanged, description rewrites incl. the panel-idiom redirect — synchronous panels use
    receipts + `delegations wait ids` (all-of) — README subagent section, background:false
    audit recorded).
  - **B2 (P6+P7+P8).** Monitor extension wiring (tools, transition subscription via routing
    bus, fire wire + renderer, per-monitor expiry timers, tui-only mode rule, cap 8, headless
    rejection, session_shutdown + `appendEntry("monitor-shutdown", …)`, EXTENSION_DIRS,
    README) + `wait` tool (R8 full: Tier-1 input probe gate, tie-break pin, race pin, abort +
    shutdown pins, immediate-empty) + enforcement wiring (R9).
- **Wave 3.** **P9 (orchestrator).** Integration harness in the task worktree: BOTH factories
  on one routing bus — wait resolves on a queue-driven group settle; enforcement counts
  during queue flow (name-as-registered drift guard); shutdown with pending wait + armed
  monitor + queued group (handler-array regression guard); child argv pin
  `--exclude-tools delegate,delegations,queue,monitor,wait`; `bun run publish` + `bun run
  check`; README pass; docs-gap audit; full gates.

## Test-row contract (authoritative; supersedes d-232/d-233 tables — M1/M5)

Style: bun:test, behaviour-sentence names, fake-pi helpers-map (arrays per event), FakeChild
(kill records, close synchronous), injected clock/scheduler, real micro-sleeps only where a
row says so, per-test timeouts on slow rows. Red-proof: every row witnessed RED before its
package lands (W-08's red witness = a single-slot fake rewrite — N-3, harness mutation, noted
as such).

**New rows.**
| id | pkg | test | AC |
|---|---|---|---|
| Q-A1 | P1 | a parallel group bigger than the running cap is rejected at enqueue, naming cap + override | R3 |
| Q-A2 | P1 | enqueueing past the 16-task queue cap rejects the whole group (all-or-nothing) | R2 |
| Q-A3 | P1 | a serial group admits its next member only when none of that group is running | R2 |
| Q-A4 | P1 | a parallel group is admitted atomically only when every member fits | R2 |
| Q-A5 | P1 | a fully-settled head group is popped before the next is considered; later groups never overtake | R2 |
| Q-A6 | P1 | an all-aborted group collapses and the next group dequeues; a member-abort lets the group continue | R4 |
| Q-B1 | P2 | enqueueing 3 members allocates 3 distinct ids | ★M3 |
| Q-B2 | P2 | a synchronous settle inside a parallel-group spawn admits no duplicate member (batch-commit) | ★B5 |
| Q-B3 | P2 | clear during a synchronous settle cascade: no double-admit, cleared members never spawn, one aborted note per cleared member | ★S-4 |
| Q-B4 | P2 | enqueue to an idle system dequeues immediately; receipts report running vs queued (position N) | R2 |
| Q-B5 | P2 | a queued group member inherits its timeout, clock armed at spawn (T84 generalized) | R2 |
| Q-B6 | P2 | shutdown aborts queued group members without spawning and delivers no notifications | R8/B6 |
| Q-C1 | P3 | queue add/add-parallel return per-task receipts sharing a groupId; unknown persona = delegate's byte-identical string; nothing enqueued | R4 |
| Q-C2 | P3 | queue list renders live positions, mode, running/pending per group; positions recompute after clear (S-10) | R2 |
| Q-C3 | P3 | queue clear cancels queued without kill, reports still-running ids; empty-queue clear is loud-not-error | R4 |
| Q-C4 | P3 | the whole queue tool rejects in non-tui modes with guidance (all actions) | ★R4/S5 |
| Q-C5 | P3 | children are invoked with `--exclude-tools delegate,delegations,queue,monitor,wait` (6 pin sites) | R5 |
| B-A1 | P4 | background:false in tui → rejection `reason:"blocking-removed"`, guidance names queue/wait, no child spawned | R1 |
| B-A2 | P4 | headless matrix unchanged: print/rpc block by default; explicit background:true degrades with details.degraded (T67 green); explicit background:false in print stays blocking (T90 green) | ★R1 |
| B-A3 | P4 | delegate + delegations descriptions pin the new redirect wording (queue for order, wait to spend idle, never poll) | R1/R9 |
| M-A1 | P5 | a predicate compiles as `return (expr)`; statements fail at compile, rejecting registration without consuming cap | R6 |
| M-A2 | P5 | evaluation timeout throws the vm timeout error → typed eval-error (gate test on bun vm support) | R6 |
| M-A3 | P5 | a predicate returning a promise/non-primitive maps to kind:"error" + disarm; a healthy monitor still fires afterwards | ★M-5 |
| M-A4 | P5 | the poll-guard blocks the 4th counted call in the sliding window, blocked attempts count, 0 disables | ★R9 |
| M-B1 | P6 | the factory arms nothing; register arms the subscription; a matching transition delivers exactly one monitor-event followUp `{deliverAs:"followUp", triggerTurn:true}`, unbatched, monitor removed | R6/R7 |
| M-B2 | P6 | expiry via injected scheduler delivers kind:"expired" and removes the monitor without any transition | ★R7 |
| M-B3 | P6 | a throwing predicate delivers one error card and disarms; later transitions evaluate nothing | R6 |
| M-B4 | P6 | the 9th monitor is rejected naming the active 8; cancel disarms; shutdown delivers the monitor-shutdown entry and stops everything | R7 |
| M-B5 | P6 | the whole monitor tool rejects in non-tui modes | ★R10/N-1 |
| W-A1 | P7 | wait resolves with snapshots when the watched delegation settles; fires only once on multiple settles | R8 |
| W-A2 | P7 | wait resolves at its clamped timeout with a snapshot (never an error); observed:"empty" immediately with nothing live | R8 |
| W-A3 | P7 | same-synchronous-drain double source resolves once; observed names the first resolver; the monitor card still arrives | ★S-2 |
| W-A4 | P7 | a transition landing between liveness-read and subscribe still resolves (race pin) | ★S-3 |
| W-A5 | P7 | ctx.signal abort resolves observed:"aborted"; shutdown with a pending wait resolves terminally, no post-shutdown sendMessage | ★S5/S-9c |
| W-A6 | P7 | input wake (wiring row, labeled wiring-only) + Tier-1 real-runner probe passes | ★R8/S-1 |
| E-A1 | P8 | 3 allowed then the 4th delegations list/log in the window is blocked with the wait/monitor guidance (fired with the registered tool name) | ★R9/M-3 |
| E-A2 | P8 | wait/abort/queue/monitor-cancel never counted; env override respected, 0 disables; state resets across shutdown | ★R9/S-9 |

**Migration table (complete; supersedes d-232).**
| test | verdict |
|---|---|
| T66 tui-default receipt (subagent-extension.test.ts:277) | keep |
| T66 print/rpc blocking arms (:286, :302) | keep (headless unchanged) |
| T66 "blocking-in-tui observable" (:315) + "explicit background:false wins in tui" (:330) | delete — replaced by B-A1 |
| T66 "explicit background:true wins in tui" (:343) | keep ★ (param stays; receipt) |
| T66 blocking onUpdate progress (:351) | keep (headless) |
| T67 degrade (:369) | keep unchanged ★ (headless degrade contract) |
| T90 blocking timeout (:660) | keep unchanged ★ (drop nothing) |
| T91 schema claims (:690) | change: background-description line → rejection/redirect wording |
| row-22 admission pins (delegation-core.test.ts:308–337) | change: `admitted: "r3"` → `["r3"]`; queue-cap rejection preserved |
| row-39/T58/T59/T61/T84 (delegation-runner.test.ts) | keep (singles = one-element serial groups) |
| T75/T77 + row 49 (subagent-status.test.ts) | keep (pendingResult derivation; headless rows still exercise it) |
| argv pins (subagent-tool :60–75/:87/:107, subagent-real-child :41, subagent.test :160) + status "Frozen" comment | change to R5's final string |
| T92–T100 batching, T101–T107, T114/T115, T118, T119–T122, reconstruction | keep |

## Risks (top)

1. Re-entrant settle during parallel-group spawn → batch-commit pin (Q-B2) is the highest-severity trap.
2. Harness bus upgrade must stay backwards-compatible (T60 recording) or existing pins break.
3. `input`-while-pending delivery rests on the Tier-1 probe + d-238's dist verification (prompt() emits input before the busy guard, agent-session.js:843); Tier-2 real-pi probe only if Tier 1 is inconclusive.
4. Cross-repo `background:false` callers → audit recorded before A2's P4; shim only on hits.
5. Lane B's README/publish.ts touches vs lane A's README subagent section — different hunks, merge at wave boundaries; P9 re-checks.

## Rejected (over-engineering)

Shared re-evaluation ticker + time predicates (d-238 S1); per-monitor everyMs; Function-constructor
fallback; shadowed-globals machinery; shell-command predicates; durable journals; recurring
monitors; monitor widgets; `delegations queue` actions; a separate queue_parallel tool;
absorbing `delegations wait`.
