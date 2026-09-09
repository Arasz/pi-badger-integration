# Plan: centralized message-delivery coordinator (consolidated from MoE 3-expert panel)

**Date:** 2026-09-09
**Task:** `pbi-centralized-message-delivery-coordinator-rebuild`
**Research:** `docs/work/2026-09-09-centralized-delivery-coordinator-research.md` (4 READ / 3 INFERRED / 2 UNVERIFIED, renderer clean)
**Mode:** autonomous away — PRs created+merged by orchestrator; decisions by 3-agent consensus.

## Verdicts carried in (non-negotiable)

- V1 pi-only coordinator first; ai-badger keeps selection semantics (F7).
- V2 acks are voluntary project-broadcast stubs — no ack-wait-as-transport without protocol change (F4, F8).
- V3 peek-then-post-then-advance per target; startup confirm gate stays in-session (F6 C1/C2).
- V4 fail-open per target; short open→DDL→one-txn→close; `busy_timeout=5000`; serialised writers (F6 C3/C4).
- V5 kill-switch `PI_BADGER_MESSAGE_BUS=0` stops loop, never tools (existing contract).
- V6 no 5s/3x constants without measurement (F8). Retry/backoff numbers come from M-spikes or ship as named placeholders with measurement TODOs.
- V7 no socket/channel/unavailable primitives without spike proof (F9, S1/S2).

## Review outcome (3-agent consensus, folded)

- D1: **A waker-only first, 3/3** (d-715 NOT-READY-with-MUSTs, d-716 READY-WITH-FOLDS iff A, d-717 A with F-M1–F-M5). Unbuilt from the user order and why: hook deletion (hooks are the only proven leg; D4 deferred), 5s/3x ack-wait (no in-repo basis; placeholders + TODOs only), central cursor settle + socket/channel wake (pending S2). Documented divergence with named follow-up (S2 + 4B), not refusal.
- Named placeholders (MEASUREMENT-TODO per V6, all in one constants block in `coordinator.ts`): `REGISTRY_TTL_S=300` (read-side staleness filter on `bus_identities.ts`, no DDL change — write-side delete cannot work since idle sessions never turn), `MAX_TICK_SESSIONS=25` (round-robin eviction cursor), retry/unavailable placeholders live ONLY in the deferred 4B spec, never in Phase-1 code.
- Tick seam contract (PKG-2→PKG-3 interface, fixed before PKG-3 starts): `tickCoordinator(store: CoordinatorStore, snapshot, opts: { budget?: number; now: number; env?: Record<string,string|undefined> })` (shipped shape; kill-switch via `env`, not a `disabled` flag) where `snapshot: RegistrySnapshot = { entries: Array<{ sessionId: string; projectId: string | null; lastSeenMs: number }>; version: string }` produced by PKG-1's registry reader; `version` = `max(lastSeenMs)+count` snapshot hash per tick (no persistent version anywhere — in-memory counters die with the process on a multi-process bus). Canonical `RegistrySnapshot`/`RegistryEntry` types + `REGISTRY_TTL_S` live single-sourced (post-review fold: `message-bus-core.ts`); `snapshotVersion` unified with `registryVersion`, swap-case tested. PKG-2 AC4: pure + `scopeOf` import from core allowed.
- Gate arrows: S1→PKG-4 (no 4A wiring without a named host), S2→4B (no mailbox without pass transcript). If S1 fails, 4A = piggyback `computeWakeSet` inside each live session's existing turn/adapter tick — stated openly, idle-machine wake struck from 4A's ACs.
- 4A wiring seam (named): in-repo piggyback — `computeWakeSet` consumed by the existing `turn_start` hook path (`runHookCheck` region); the adapter-poll half lives in the user-scope ai-badger repo and is filed as a cross-repo follow-up, not touched here. 4A AC "hooks behaviorally identical": `git diff` empty on the hook region AND existing hook suite green.
- 4B kept as gated follow-up with restated invariant: bus cursor never passes mail with no live outbox row; outbox row deleted only after renderer post/confirm; restart order outbox-first; startup directs excluded (confirm stays in-session); reject (renderer `sendMessage` throw) holds cursor + keeps row, with reject-then-accept RED mutant; startup-confirm-"no" explicitly out of scope.
- INT fixes: (iii) reworded "no ack row is treated as a delivery receipt for any other row" + asserts no `setTimeout(5000)`/retry-count literal drives delivery; (vii) contention smoke (heartbeat writes INCLUDED in writer count; heartbeat throttled to at most once per TTL/4 per session, best-effort, failure-silent) asserting completion + cursor correctness under fixture with pragma pinned via `openBusDb`, marked smoke-with-retry; D4 residue grep scoped to `extensions/`; token ledger owner = orchestrator pre-merge.
- PKG-1 is openly characterization: registry-lite upsert already ships in `session_start`; the package pins it + adds the TTL touch (true RED: remove the `hasIdentity` guard → old-store send throws).
- PKG-2 grouping-key parameterised per H2 (shape placeholder; S2 may rewrite, not patch).

## OPEN DECISION D1 (for 3-agent consensus vote)

**Q:** Phase-1 delivery leg — (A) waker-only coordinator (tick computes wake set, sessions still self-deliver via existing hooks/adapter poll; zero cursor writes centrally, zero cross-session sends) or (B) mailbox-mediated central delivery (new `coordinator_outbox` table; coordinator owns selection/ordering/retry/cursors; per-session thin renderer owns confirm-gate + render; hooks thinned to the renderer)?

- Expert votes in: d-709 → A first; d-710 → A (mailbox deferred to SPIKE-S2); d-711 → B with A as simpler-shape fallback.
- Consensus rule: ≥2 of 3 review agents agree; orchestrator implements the winner. Loser stays documented as follow-up.
- Either way D4 (hook deletion) is LAST and only on INT green + transport proven; otherwise hooks stay and the plan still closes (documented divergence, not failure).

## Packages

### PKG-1 — Session-registry heartbeat (expert 2 slice C1)

- Files: MOD `extensions/message-bus/index.ts` (piggyback `recordIdentity` on `session_start` + lazy TTL touch on `turn_start`/`check`); NEW `tests/message-bus/message-bus-coordinator-registry.test.ts`.
- ACs: (1) live session appears in registry after `session_start`; (2) stale entries expire after TTL without zombie wake; (3) registry write failure never blocks delivery (fail-open, one console line); (4) `hasIdentity`-absent old stores still send (fallback preserved).
- Gate: `bun run test tests/message-bus/message-bus-coordinator-registry.test.ts` + `bun run typecheck`.
- Tests RED→GREEN: record-on-start; lazy-expiry; write-failure-fail-open; old-store-fallback (delete `recordIdentity` seam → sends stand).

### PKG-2 — Grouping pure + channel cache (expert 2 slice C2+C3)

- Files: NEW `extensions/message-bus/coordinator-group.ts` (pure: `groupByScope`, `buildChannelCache` with version bump); NEW `tests/message-bus/message-bus-coordinator-group.test.ts`.
- ACs: (1) broadcast collect + per-project dict keyed on per-read resolved projectId; (2) project-less sessions get directs only (parity with readAddressed); (3) cache rebuilds only on registry version bump (mutation: bump-less registry change → stale cache detected red); (4) zero imports (house purity: strings/arithmetic only).
- Gate: `bun run test tests/message-bus/message-bus-coordinator-group.test.ts` + `bun run typecheck`.

### PKG-3 — Read-only per-target peek tick (expert 1 slice C1 + expert 2 slice C4)

- Files: NEW `extensions/message-bus/coordinator.ts` (`tickCoordinator(store, sessions, opts)` pure-ish + `computeWakeSet`); NEW `tests/message-bus/message-bus-coordinator.test.ts`.
- ACs: (1) tick is wake-only/read-only: zero `deliver*`/`send`/`sendMessage` calls with pending mail (load-bearing F6 mutant); (2) per-target fail-open (one peek throws → rest decided, error recorded); (3) overlapping ticks single-flight (max-concurrency 1); (4) kill-switch `"0"` → zero store calls + `{disabled:true}`; (5) tick budget respected (round-robin truncation past N sessions).
- Gate: `bun run test tests/message-bus/message-bus-coordinator.test.ts` + `bun run typecheck`.
- Tests RED→GREEN: cursor-untouched; fail-open; single-flight; kill-switch; budget-truncation; no-ack-write guard (assert no `ack:` row written during tick).

### PKG-4 — Delivery leg (winner of D1; exactly one of 4A/4B implemented)

- 4A (waker-only): wire tick into existing adapter-poll/turn seams; sessions self-deliver unchanged. AC: tick wake set matches peek-pending set; no cursor movement centrally; hooks byte-identical.
- 4B (mailbox): NEW `coordinator_outbox` DDL (extension-owned, optional-with-fallback like `bus_identities`); coordinator writes per-target rows + settles bus cursors post-write; NEW thin renderer (turn_start reads outbox, confirm-gate for directs, renders, deletes outbox rows); retry/unavailable state machine with named-placeholder thresholds + measurement TODOs (per V6). AC: cursor never passes unwritten mail; reject-then-accept arrives in order, no duplicates; one target's failure never blocks another; kill-switch stops loop, never tools.
- Files: 4A → MOD `index.ts` wiring only + `message-bus-coordinator-wake.test.ts`. 4B → NEW `coordinator-outbox.ts` + MOD `index.ts` renderer + `message-bus-coordinator-outbox.test.ts` + `...-redeliver.test.ts`.
- Gate: scoped suite + `bun run typecheck`.

### SPIKE-S1 — Presence liveness (timeboxed, scratch only, no repo writes)

- Pass: pasted process-lifetime output per primitive (`setInterval`/`fs.watch`/`node:net` in TUI-quit + `pi -p` settle). Fail → heartbeat-timer stays deferred, piggyback stands.

### SPIKE-S2 — Mailbox vs RPC transport (timeboxed, scratch only)

- Pass: pasted RPC steer transcript + JSONL-append pickup result + named ack-state columns. Fail → mailbox stays deferred, waker-only stands. (Moot if D1→4A, still run for the follow-up record.)

### PKG-INT — Integration package (ALWAYS LAST)

- File: NEW `tests/message-bus/message-bus-coordinator-integration.test.ts` (shared temp-DB store, two+ sessions, non-degenerate fixtures: multi-message inboxes, mixed ages, decoy rows).
- Join gates: (i) cursor never passes undelivered mail; (ii) one target's failure never blocks another; (iii) no ack ever advances a cursor; (iv) unknown-target sends warn-but-land; (v) kill-switch stops loop, never tools; (vi) every failure fail-open with held cursor; (vii) contention smoke: 2 writers + 3 ticks, zero `database is locked`.
- Gate: full `bun run test tests/message-bus/` + `bun run typecheck`; full suite once pre-PR (CI is the gate beyond).

### D4 — Hook removal (only if INT green AND transport proven; else documented deferral)

- Own commit/PR for clean revert. AC: zero hook delivery cards with coordinator on; `check` fallback intact; residue grep for `runHookCheck|runDirectStart` empty.

## Parallelism

- Parallel now: PKG-2 (pure, new files) + SPIKE-S1/S2 (scratch, no repo writes) + PKG-1 test-design.
- Serial chain (single writer): PKG-1 → PKG-3 → PKG-4 on `index.ts`/`coordinator.ts` (land order; disjoint test files may be written ahead).
- PKG-INT after PKG-1–4. D4 last or deferred.
- Isolation: one worktree per implementation lane + per-lane workspace id; two dispatch levels max.

## Top-level AC (plan passes iff)

All shipped packages' ACs checked+met; INT join gates green; research F-verdicts unviolated (reviewer rejects any central `deliver*`+cross-session-send without mailbox, any ack-wait-as-transport, any startup-settle); token ledger recorded; PR merged.
