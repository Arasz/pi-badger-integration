# QA session — what is deliberately not built

## Main motive

This session pins down what the wake-only message coordinator intentionally leaves out and what comes next, so future work does not mistake a deferred follow-up for a missing implementation. It is really about the Phase-1 scope boundary, its gated re-entry conditions, and the ordered build path from spikes through delivery leg to integration.

## Refined questions

1. What is deliberately not built in the centralized wake-only coordinator, and what evidence / gated follow-ups cover each exclusion?
2. What are the next steps, with a short explanation why for each?
3. Do we still want a centralized message orchestrator process (durable daemon)?
4. Is the final shape per-session coordinators that deliver, do agent commands go through the coordinator, and can we guarantee 5s wake?
5. Are prior answers describing after-Phase-1 (now) or after-all-phases-complete?

## Structured answers

### Q1 — What is deliberately not built?

Deliberately not built (Phase-1 wake-only stands, hooks remain the delivery leg):

- **Mailbox central delivery** — no `coordinator_outbox` table, no central cursor settle, no cross-session send. Deferred to gated follow-up 4B, which requires SPIKE-S2 pass transcript (RPC steer + JSONL-append pickup + named ack-state columns). D1 consensus was waker-only first (A) 3/3.
- **Hook deletion (D4)** — hooks are the only proven delivery leg. Deletion is LAST, only on INT green + transport proven; otherwise hooks stay and the plan still closes as documented divergence.
- **ack-wait / retry / unavailable state machine (5s / 3x numbers)** — no in-repo basis (F8); acks are voluntary project-broadcast stubs with no transport receipt to wait on (F4/V2). Retry/unavailable placeholders live ONLY in the deferred 4B spec, never in Phase-1 code, per V6 measurement-TODO rule.
- **Socket / process / channel wake and presence primitives** — no socket/channel/unavailable primitives without spike proof (V7, F9, S1/S2). No durable-tick host exists in pi; idle-machine wake was struck from 4A. Tick is piggyback inside a live turn, fail-open, kill-switch `PI_BADGER_MESSAGE_BUS=0` stops loop never tools.

Grounding condensed: plan record verdicts + packages; research findings; how-to invariants.

### Q2 — What are the next steps?

Ordered per plan Parallelism + gate arrows; current tree has PKG-1–3 + INT test files present, `runHookCheck` still in `index.ts`, no `coordinator-outbox.ts` / `computeWakeSet` wiring (inference: PKG-4 not yet built):

1. **Verify PKG-1–3 gates green** — `bun run test tests/message-bus/` + typecheck. Why: serial chain foundation; tick/registry/grouping invariants must hold before any delivery-leg wiring.
2. **Run SPIKE-S1 presence liveness (scratch only, no repo writes)** — paste process-lifetime output per primitive. Why: gates PKG-4; decides whether a durable tick host exists or 4A stays piggyback with idle-machine wake struck.
3. **Run SPIKE-S2 mailbox vs RPC transport (scratch only)** — RPC steer transcript + JSONL-append pickup + ack-state columns. Why: gates 4B; fail means mailbox stays deferred and waker-only stands.
4. **Settle D1 (A waker-only vs B mailbox, exactly one of 4A/4B)** — ≥2-of-3 consensus. Why: plan forbids building both; winner defines PKG-4 scope.
5. **Implement PKG-4 winner** — 4A: wire tick into turn-start/adapter seams with hooks byte-identical; 4B: outbox DDL + thin renderer with cursor-never-passes-unwritten invariant. Why: this is the delivery leg the spikes de-risk.
6. **Run PKG-INT always last** — join gates i–vii including contention smoke. Why: only full pass proves no lost mail, per-target fail-open, no ack-advances-cursor, kill-switch safety.
7. **D4 hook removal only if INT green AND transport proven, else deferred** — own commit/PR for clean revert. Why: hooks are the only proven leg; removal without proof risks delivery loss.
8. **Clear MEASUREMENT-TODOs (`REGISTRY_TTL_S=300`, `MAX_TICK_SESSIONS=25`, retry thresholds)** — validate against real registry sizes / peek latency or keep as named placeholders. Why: V6 forbids shipping tuned constants without measurement.

Grounding condensed: plan Packages/Parallelism/Top-level AC; codebase current-state check; research F8/F9 + how-to piggyback invariant.

### Q3 — Centralized orchestrator process?

No. Centralized logic yes, centralized durable process no (inference from plan + code: the wanted shape is a piggyback tick, not a daemon).

What we still want: the wake-only `tickCoordinator` + registry heartbeat + grouping cache running inside a live session's `turn_start`, with sessions still self-delivering via existing hooks/adapter poll. What we explicitly do NOT want: a background daemon, socket/channel wake host, or cross-session injector — struck from 4A by design because no durable-tick host exists in pi and every evidenced seam (`sendMessage`, timers, `pi.exec`, file watch) is scoped to a live session/process and torn down on `session_shutdown`. S1 is the only gate that could reopen this, and if S1 fails the piggyback stands and heartbeat-timer stays deferred.

Grounding condensed: plan 4A wiring seam + S1 gate; research F5/F6/F7; how-to piggyback-not-daemon; coordinator.ts header.

### Q4 — Per-session delivering coordinators, commands via coordinator, 5s wake?

No to all three as stated (correction, not confirmation):

- **Not per-session delivering coordinators.** There is one shared `tickCoordinator` function that happens to execute inside whichever live session fires `turn_start`. It is read-only/wake-only: peek others → `woke[]` → `console.debug`. It never `deliver*`/`send`/`sendMessage`, never settles cursors or writes acks (pinned by PKG-3 no-deliver mutant + no-ack-write guard). Delivery stays per-session self-delivery: `runHookCheck` peeks-then-posts-then-advances only its own `(sessionId, projectId)`.
- **Agent commands do not go through the coordinator.** `send`/`list`/`check`/`ack`/`reply`/`whoami` hit the `BusStore` (SQLite bus + cursors) directly. Coordinator has no tool surface; kill-switch stops loop/heartbeat/tick but never tools. The tick is observable only via the debug line, not callable.
- **No 5s wake guarantee.** Piggyback runs only when a turn fires; nothing wakes a fully idle machine — struck by design, and V6/F8 explicitly say 5s/3x have no in-repo basis (the nearby 5s is sqlite `busy_timeout=5000`, not a tick budget). The idle-wake that does exist is the separate user-scope adapter poll (`AI_BADGER_PI_BUS_WAKE` / `POLL_SECS` + `MIN_POLL_SECS` floor, watermark + failure-marker gates, fail-open), not the coordinator, and it still needs a live session. Guaranteed 5s would need S1 proof that a timer keeps `pi -p`/TUI alive after settle — unproven.

Grounding condensed: how-to flow + invariants; plan V6/V7 + PKG-3/4A + S1; research F1/F2/F5/F8; `coordinator.ts` + `index.ts:runHookCheck`.

### Q5 — After Phase-1 (now) or after all phases?

Prior answers describe after-Phase-1 = now (waker-only, PKG-1–3 + 4A + INT, hooks stay). That is also the standing final shape unless 4B+D4 ever clear their gates — and even then the invariants do not change.

- **After Phase-1 (now / shipped):** read-only `tickCoordinator` piggybacked on `turn_start` + registry/grouping, zero cursor writes, zero sends, hooks byte-identical deliver own mail, adapter poll remains idle wake, no daemon, no 5s promise.
- **After all phases IF 4B+D4 ever land (gated, not promised):** adds `coordinator_outbox` DDL + per-target rows + cursor settle post-write + thin renderer (turn_start reads outbox, confirm-gate for directs, renders, deletes rows) + retry/unavailable state machine with measured thresholds, and only then thins hooks to the renderer in its own revertable commit. Still piggyback, still fail-open per target, still kill-switch stops loop never tools, still startup confirm stays in-session, still no socket/process wake, still no ack-wait-as-transport (V2/V3/V4 hold). If S2 fails or INT is not green, 4B/D4 stay deferred and Phase-1 stands as the close.

Grounding condensed: plan D1 + PKG-4A vs 4B + 4B invariant + D4 gate + INT-last; how-to piggyback/read-only; research F6 conditions.

## Open / unanswered questions

- None in this session. Execution still needs: S1/S2 transcripts, D1 vote record, PKG-4 diff, INT run log — these are next-step outputs, not unanswered session questions.

## Source links

- `docs/work/2026-09-09-centralized-delivery-coordinator-plan.md` — Verdicts V2/V6/V7, D1 consensus, PKG-1–4 + S1/S2 + INT + D4, Parallelism, Top-level AC
- `docs/work/2026-09-09-centralized-delivery-coordinator-research.md` — F1 hooks turn-bound, F2 adapter poll, F4 acks as stubs, F5 no cross-session primitive, F8 numbers without basis, F9 socket/channel unproven, F6 cursor-adapter conditions
- `docs/howto/message-coordinator.md` — read-only tick invariants, piggyback-not-daemon, kill-switch, What-is-deliberately-not-built section
- `extensions/message-bus/coordinator.ts` — `MAX_TICK_SESSIONS=25` MEASUREMENT-TODO, read-only tick + rotation + kill-switch
- `extensions/message-bus/index.ts` — `runHookCheck` still present, registry heartbeat, no outbox/wake wiring
- `extensions/message-bus/message-bus-core.ts` — `REGISTRY_TTL_S=300` MEASUREMENT-TODO single-source pin
