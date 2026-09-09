# Research: centralized message-delivery coordinator ownership and cursor-adapter feasibility

**Date:** 2026-09-09
**Question:** Should the centralized message-delivery coordinator live in ai-badger (shared by all frameworks) or in the pi extension, and can a cursor adapter correctly advance pi sessions?

## Findings

### F1 — pi extension delivery today is turn-boundary hooks, not a durable loop [READ]

Hooks own delivery: `session_start` reads direct-only mail with a user confirm gate, `turn_start` runs the peek-then-post-then-advance check, and `check` delivers on demand. The last hop is `pi.sendMessage` as followUp. No cross-session loop exists in this repo.

**Evidence:** `.ai-badger/worktrees/pbi-centralized-message-delivery-coordinator-rebuild/extensions/message-bus/index.ts:703` (`pi.on("session_start"`), `:722` (`pi.on("turn_start"`), `:473` (`pi.sendMessage({ customType ... }, { deliverAs: "followUp"`), `:514` hook-path peek-then-post comment.

### F2 — Idle wake today is an adapter poll timer with watermark + failure-marker gates [READ]

The ai-badger user-scope adapter arms a per-session poll (`AI_BADGER_PI_BUS_WAKE` / `AI_BADGER_PI_BUS_POLL_SECS`), probes read-only, skips on exact MAX+COUNT equality, and advances the watermark only to the tick-time fingerprint on parseable outcomes without the failure marker. Every error spawns (fail-open).

**Evidence:** `/Users/arasz/.pi/agent/extensions/ai-badger/bus-prefilter.ts:1-25` (tick SKIP / watermark / failure-marker invariants), `:31-66` (`AI_BADGER_PI_BUS_WAKE`, `AI_BADGER_PI_BUS_POLL_SECS`, `MIN_POLL_SECS`).

### F3 — ai-badger owns the selection semantics every coordinator must reuse [READ]

First-read 30-minute window + 16-cap + sender-exclusion + scope classification + cursor landing past MAX live in the python store, with a vendored copy in this repo's skill scripts. Any coordinator that re-implements selection instead of calling it reintroduces known strand bugs.

**Evidence:** `/Users/arasz/RiderProjects/ai-badger/engine/badger_store.py:1890-1930` (`deliver_for_session`), `.ai-badger/skills/task/scripts/badger_store.py:42-45` (`_START_CAP = 16`), `:1890-1906` (first-delivery window/cap comment).

### F4 — Acks are voluntary project-broadcast stubs, not transport receipts [READ]

`ack` is a metadata-only `ack: #id` stub sent as a project broadcast by explicit tool/command action in the receiving session. Nothing auto-acks on delivery. Correlating `ack #id` to a per-target delivery confirmation requires parsing broadcast bodies with cross-session id collisions and no per-target identity.

**Evidence:** `extensions/message-bus/message-bus-core.ts:126-128` (stub, no body bytes), `extensions/message-bus/index.ts:848-862` (ack needs inbox membership, never ack an ack), `:877` (ack-as-project-broadcast description).

### F5 — A central loop cannot inject into another live session with today's extension API [INFERRED]

Reasoning from F1 + F2 and three parallel read-only lanes (d-706 pi-host, d-707 backend-ownership, d-708 cursor-adapter): every evidenced seam (`sendMessage`, `appendEntry`, timers, `pi.exec`, file watch) is scoped to a live session/process and torn down on `session_shutdown`. No cross-session `sendMessage`, socket, or channel primitive was evidenced in the extension surface. Durability in-tree comes only from the filesystem (SQLite bus, session JSONL) and OS-managed processes (pi-cron launchd pattern).

### F6 — A cursor adapter is feasible-with-conditions, not a drop-in [INFERRED]

Reasoning from F1 + F4 and lane d-708: cursor rows + peek/deliver/getCursor + `busy_timeout=5000` + fail-open precedents are sufficient mechanics, but only if: peek-then-post-then-advance per target, never settle startup batches centrally (confirm gate stays in-session), fail-open per target, short open→DDL→one-txn→close with serialised writers, feature-detect peek/identity seams, resolve `(sessionId, projectId)` per read, honour the `PI_BADGER_MESSAGE_BUS=0` kill-switch, and — load-bearing — either the coordinator only wakes (sessions still self-deliver) or a new session-readable mailbox is introduced. Centrally advancing bus cursors while injecting from outside the owning process loses mail.

### F7 — Recommendation is pi-only coordinator first, ai-badger keeps selection semantics [INFERRED]

Reasoning from F1–F6 and lane d-707: extension-owned tables with optional-with-fallback seams (`bus_identities` precedent) make a pi-side experiment reversible; a shared loop with a cursor bug is machine-wide. The cheaper experiment is a pi-only single-poll coordinator reusing select/peek semantics behind existing gating, promoted to shared only after ack/ordering semantics prove out against real contention. A shared loop additionally needs an un-designed 4-framework wake-driver interface plus a python schema change the owner has deferred before.

### F8 — Ack-wait 5s / 3x redeliver / mark-unavailable numbers have no in-repo basis [UNVERIFIED]

No 5s ack-wait, 3x redeliver, or unavailable threshold was observed in the reads. The evidenced nearby budgets are the adapter tick floor and the 5s sqlite `busy_timeout` — adjacent numbers, not justifications. Needs measurement before adopting; cursor-held redelivery already gives at-least-once on the hook path.

### F9 — Socket wake, channel cache, and unavailable detection are unproven [UNVERIFIED]

No socket/channel primitive, no presence/heartbeat/TTL on `bus_identities` (existence-only), and no per-target ack/unavailable state design were observed. Channel cache `session → [targets]` shape, grouping granularity (broadcast collect + per-project dict), and project-less handling still need a spike against the live pi runtime, not more reading.

## Still open

- Does closing the last TUI session quit the process or idle with timers/sockets alive? (decides whether live-session-required is absolute; read interactive-mode/sessionpicker sources)
- Does an armed `setInterval`/`fs.watch`/`node:net` listener keep `pi -p`/`--mode json` alive after the run settles, or does the host force-exit? (one small experiment)
- Can an external coordinator steer/followUp a live session over RPC (`examples/extensions/rpc-demo.ts`, `rpc-client.d.ts`)? (the wake path with sessions open)
- Is appending `custom`/`custom_message` JSONL rows from another process safe/picked-up or ignored/overwritten? (bounds external-injection designs)
- Where would per-target ack/unavailable state live (new columns? new table? upgrade hook)? (needed before any ai-badger-side proposal)
- What settles the widened peek→settle race under central IPC — merge-or-rewind rule? (needs a design + contention measurement)
- Full multi-framework consumer list (Copilot session-source shape unconfirmed this pass).
