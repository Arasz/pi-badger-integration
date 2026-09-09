# Research: waking a wait-blocked agent for message-bus mail

**Date:** 2026-09-09
**Question:** What pi API or hook mechanism can wake an agent blocked in wait so it receives newly sent messages, and can extra hooks improve delivery reliability?

## Findings

### F1 — wait wakes only on delegation settle, monitor fire, user input, timeout, or abort [MEASURED]

The wait tool blocks the turn until the FIRST of: a watched delegation settling, an armed monitor firing, the user sending a message (the `input` event), or the timeout. With nothing live and nothing armed it arms a `wait-timer` monitor (tui) or resolves `empty` immediately (non-tui). Bus-DB writes, `turn_start` hooks, and `sendMessage` cards are not in that list.

**Evidence:** `bun test tests/monitor/wait-tool.test.ts` on this machine (macOS, bun v1.4.2, repo at 2026-09-09 HEAD) — 18 pass, 0 fail, 63 expects. Decisive rows: W-A1 delegation settle resolves; W-A3 monitor fire resolves with a terse pointer; W-A6 input wake resolves the wait wiring-only plus the Tier-1 real-runner input passthrough probe; W-A2 timeout/empty behaviour. Re-ran `bun test tests/message-bus/message-bus-hook-visibility.test.ts tests/message-bus/message-bus-extension.test.ts` — 35 pass, 0 fail — confirming the hook-visibility contract below holds on this checkout.

### F2 — message-bus delivery is a turn-boundary seam, not a push waker [READ]

The bus extension states its own contract: idle-session wake stays with the adapter's poll timer, and its hooks (`session_start` + `turn_start`) only inject mail as context for a turn that is starting anyway. `send` is a SQLite row write; `check`/`list` read it on demand; the delivery card is posted with `deliverAs: "followUp"`.

**Evidence:** `extensions/message-bus/index.ts:16-22` ("not a push waker … turn-boundary seam"), `extensions/message-bus/index.ts:666-693` (only `session_start` and `turn_start` subscriptions), `extensions/message-bus/index.ts:443-444` (`sendCard` uses `{ deliverAs: "followUp", triggerTurn }`).

### F3 — a followUp card with triggerTurn only wakes an idle agent, so it queues behind a wait-held turn [READ]

The monitor wiring documents the one delivery wire both monitor-event and delegation-result cards ride: while the parent run is active the card queues via `followUp` and is delivered when the run would otherwise stop; when idle, `triggerTurn` starts a run. A `wait` tool call holds the run open (it is a pending tool execution inside the turn), so the bus card sent mid-wait queues instead of interrupting, and `turn_start` — the hook that would deliver it — cannot fire until the wait resolves.

**Evidence:** `extensions/monitor/index.ts:236-245` (the one monitor-event wire comment, streaming-parent vs idle behaviour), plus the pi spec section `docs/extensions.md` — `pi.sendMessage(message, options?)` (`deliverAs` steer/followUp/nextTurn; `triggerTurn: true` wakes only an idle agent, ignored for `nextTurn`).

### F4 — no pi API fires an arbitrary hook from outside; the only mid-turn receipt wire is the input event [READ]

Hooks (`session_start`, `turn_start`, `tool_call`, `agent_end`, …) are emitted by the pi runtime on its lifecycle diagram — extensions subscribe via `pi.on`, they cannot invoke one out-of-band. The one documented receipt-while-busy path is the `input` event, which fires on message receipt even while the agent is busy (with `event.streamingBehavior` set), and is exactly what `wait` subscribes to as its input source and what session-signals uses for `!`-grade interrupts. A cross-process bus `send` never traverses that event — it writes SQLite in another process.

**Evidence:** `extensions/session-signals/index.ts:7-13` ("pi's `input` event fires on receipt even while busy … legacy hooks fire at turn start and can never see a mid-turn message"), `extensions/monitor/index.ts:465-474` (`ensureInputArmed`: the persistent `pi.on("input")` observer that settles pending waits), plus the pi spec section `docs/extensions.md` — `input` event (`event.source` interactive/rpc/extension, `event.streamingBehavior` steer/followUp/undefined) and the lifecycle diagram (hooks fire around prompts, turns, and tool calls).

### F5 — adding more hook listeners cannot wake a wait-blocked agent [INFERRED]

Reasoning from F1 (the closed wake-source list) + F2 (bus hooks are turn-boundary) + F4 (hooks are runtime-emitted, not callable): registering extra `turn_start` / `agent_end` / `tool_result` / `session_start` handlers only adds code that runs when the runtime is already turning. While `wait` holds the turn open, none of those events fire, so the extra listeners sit idle exactly like the bus's own `turn_start` listener. More hooks widen coverage of turns that happen anyway; they do not create a wake-up.

### F6 — the reliable pattern is short waits plus explicit check, not push [INFERRED]

> Update (2026-09-09, task pbi-wait-tick-shared-cursor-race): live-tested (F7–F9 below).
> The tick as first shipped (cursor-based peek) lost a shared-cursor race with the
> adapter poll and slept through R1; the tick now tracks a private high-water mark
> per wait (`readMailMark` / `defaultBusMailSince`, optional indexed `hasNewSince`
> seam) and is race-free. Behavior pinned in `tests/wait-check-loop-guidance.test.ts`
> (two-consumer regression); user doc `docs/howto/wait-check-loop.md`.

Reasoning from F1–F5: because no push path reaches a `wait`-held turn cross-process (monitor fleet maps and `pendingWaits` are in-process memory; bus rows are cross-process SQLite), the waiter must come up for air itself — `wait` with a short `timeoutMs`, then `message-bus check`, then loop. The sender side needs no new hook; the receiver side needs a polling discipline (which is also what the bus header prescribes: the adapter's poll timer owns idle wake). An in-process `sendMessage` followUp card is still worth posting so the mail surfaces at the next turn boundary, but it must not be mistaken for a wake.

## Still open

### Live test (2026-09-09, tasks pbi-wait-check-loop-bus-mail + pbi-wait-tick-shared-cursor-race)

Two live rounds against session `01a087bd` (second TUI session, same project):

### F7 — a cursor-based tick sleeps through mail the adapter consumes first [MEASURED]

R1: the waiter entered `wait` (timeoutMs 180000) ~12 s after the instruction message
and timed out the full 180 s, although the WAKE message sat deliverable in the bus
for ~90 s mid-wait. The tick probed the shared delivery cursor, which the adapter
poll had already advanced past the WAKE (consume-at-sighting, display-at-boundary).

**Evidence:** bus DB rows `#815` (instruction, 19:57:45Z), `#816` (WAKE, 19:59:27Z),
`#817` (waiter reply `OBSERVED=timeout WAITEDMS=180000`, 20:00:57Z), run live from
this checkout (`message-bus send` to the waiter session, replies read back the same way).

### F8 — the same tick wakes within a second when it sights first [MEASURED]

R3 (same session, same code): the waiter entered `wait` (timeoutMs 300000); the WAKE
committed at 20:08:04.168Z and the wait resolved `observed: "mail"` at 20:08:04.419Z
(251 ms later); the waiter replied 5 s after the WAKE.

**Evidence:** bus DB rows `#820` (R3 instructions, 20:05:24Z), `#821` (WAKE, 20:08:04Z),
`#822` (waiter reply `OBSERVED=mail WAITEDMS=153000`, 20:08:09Z); waiter toolResult
`observed: mail, waitedMs: 153370` in its session transcript.

### F9 — the adapter consumes at sighting and displays at the turn boundary [READ]

The waiter's session transcript shows the adapter posting the R1-WAKE as an
`ai-badger` custom message at 20:00:51.554Z — the exact millisecond its `wait`
timeout toolResult landed. A co-sighting is implausible across an 84 s gap between
the WAKE commit and the post; the consistent reading is consume-early (cursor past
the WAKE within the wait, blinding the cursor-based tick ~90 consecutive times)
and post-late (followUp queued behind the blocked turn, flushed at its end).

**Evidence:** waiter session transcript
`/Users/arasz/.pi/agent/sessions/--Users-arasz-RiderProjects-pi-badger-integration--/2026-09-09T19-55-52-865Z_01a087bd-b8a0-73e5-8693-4edbe14dd5b0.jsonl`
lines 10–11 (wait timeout toolResult and adapter card share timestamp 20:00:51.554Z).

### F10 — the mark-based tick hits every race window live, plus the silence control [MEASURED]

Ack-gated retest against a fresh session (`01a087f3`, new code from process start):
the waiter signalled each window (`READY-Wn`), the tester sent the WAKE ~30 s later,
three windows — W1 `mail` 44 s seeing WAKE-A, W2 `mail` 43 s seeing WAKE-B (no re-fire
on WAKE-A: strict-above-mark holds live), W3 `timeout` 40 s on silence (no phantom
wake). The waiter's post-wake `check` calls again read "no new messages" while the
mail was pending (adapter-consumed), reconfirming F9 from the other side — which is
why the `mail` result text now names `list` as the fallback read.

Method note (for future live tests): the ack-gated protocol (READY per window, WAKE
~30 s after) cost ~5–9 s of sync per round vs 150 s+ blind leads — whole suite ~2.5 min
vs ~15 min. Tester-side sub-60 s timing is imprecise (own LLM latency adds ~15 s),
so keep ≥30 s margins; READY labels prevent misattribution across windows.

**Evidence:** bus DB rows `#829` (instructions, 21:09:55Z) through `#835` (waiter
report `W1 mail,44000,WAKE-A / W2 mail,43000,WAKE-B / W3 timeout,40000`, 21:12:30Z);
WAKE-A `#831` (21:10:46Z) and WAKE-B `#833` (21:11:38Z) each resolved within a second.

### Closure (2026-09-09) — will not continue

Closed as wont-continue under task pbi-wait-check-loop-bus-mail: F6 (short-wait +
check loop) is the implemented answer as an internal tick, and none of these would
change it.

- ~~Whether an RPC `prompt`/`steer` delivered mid-tool aborts or queues behind `wait`~~ — CLOSED: even an aborting steer would be the wrong primitive for mail (it kills the waiter's turn); the internal tick is the contract regardless of the RPC answer.
- ~~What the adapter's poll-timer interval actually is~~ — CLOSED as a tuning question; F9 below makes the tick independent of the adapter's cadence, so the interval no longer matters to wake reliability.
- ~~Whether a same-process bus→monitor bridge is worth the coupling~~ — CLOSED: rejected; it would fix only same-session self-notify, never the cross-agent case in the question, while coupling two extensions.

Original items (kept for history):

- Whether an RPC `prompt`/`steer` delivered mid-tool-aborts or queues behind `wait` on this pi build was not exercised end-to-end (needs a two-process live test: one TUI waiter, one RPC sender, observing `wait` output) — the docs say streaming delivery queues after tool calls, but only a live run settles it.
- What the adapter's poll-timer interval actually is (bus-store.ts/bus-prefilter.ts live outside this repo's checkout) and whether shortening it is cheaper than a wait/check loop for sub-minute latency.
- Whether a future in-process bridge (bus `send` in the SAME process also arming a no-op monitor fire to settle local waits) is worth the coupling — it would fix same-session self-notify only, never the cross-agent case in the question.
