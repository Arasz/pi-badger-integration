# Waiting for message-bus mail: the wait wakes itself

A `wait`-blocked turn wakes on new message-bus mail — no check loop needed.
The wait checks the bus internally **every second** (fixed 1 s tick, one shared
timer for every pending wait) and resolves with `observed: "mail"`. Mail
delivery then follows on the turn the wait resolves into (the `turn_start`
hook delivers, like any other turn boundary — see the message-bus card, or run
`message-bus check` for the same mail).

Background: `docs/work/2026-09-09-pi-wait-wake-message-bus.md` (F1–F5 prove no
push path reaches a wait-held turn cross-process, which is why the check lives
inside the wait rather than in a hook).

## What the agent does

Call `wait` with a deadline that fits the work (default 5 min, max 600 s,
clamped). **Reaching that deadline aborts the watched live delegations.** Pass
`ids` to limit the scope; without `ids`, timeout targets all live delegations
in the current session at expiry, including running and queued work.

```json
{"ids": ["d-1"], "timeoutMs": 120000}
```

This waits up to two minutes and, if the deadline is reached, aborts only
`d-1`. If you want agents to keep running while you await mail, register a
monitor or end your turn instead of setting a short `wait` timeout.
<!-- trust:trustchecked evidence=extensions/monitor/index.ts:645 -->

- `observed: "mail"` → handle the delivered mail (ack what you consumed).
- `observed: "delegation"` → a watched run settled; other runs keep going.
- `observed: "monitor"` → a monitor event arrived; no work is cancelled.
- `observed: "input"` → a user message arrived; it takes precedence.
- `observed: "timeout"` → cancellation was requested for the watched live runs.
  Check `abortedIds`, `abortErrors`, and the post-request `records` snapshot.
  Non-empty `abortErrors` means cancellation was blocked, failed, or unavailable;
  handle that warning rather than assuming the children stopped.
- `observed: "empty"` (non-TUI, nothing live) → the tick has nothing to hold;
  in headless modes a blocking `delegate` call is the way to wait for
  delegation work instead.
- `observed: "aborted"` → the turn is ending; do not wait again.

`delegate.timeoutMs` and `wait.timeoutMs` now both abort work, but their clocks
and scopes differ. A delegate deadline starts when that child spawns (1 s–24 h,
off when omitted). A wait deadline starts when the wait begins (5 min by default,
maximum 600 s) and applies to its watched scope. Input, mail, completion, and
ordinary monitor wakes do not abort that scope. The internal idle timer's expiry
is a timeout, not an ordinary monitor wake.

Running children use the existing SIGTERM-to-SIGKILL path. Queued targets are
removed together so cancellation cannot accidentally start another target.
`abortedIds` acknowledges abort requests; it does not promise that every OS
process has already been reaped. See the
[ADR](../work/2026-10-06-aborting-delegation-wait-timeouts-adr.md) for the decision.

## Properties worth knowing

- **Fail-open.** A missing or locked bus, a missing session identity, or any
  probe error reads as "no mail" — the wait keeps waiting for its other
  sources and still ends on timeout. Bus trouble never breaks or hangs a wait.
- **Read-only.** The tick peeks (never advances the cursor), so delivery stays
  exactly-once through the normal hook path.
- **Race-free vs the adapter.** The tick tracks a private high-water mark per wait
  (max addressed id at wait start) instead of the shared delivery cursor: when the
  adapter's poll consumes mail out-of-band mid-wait, the tick still sees the new id
  and wakes. Only mail arriving *after* the wait starts can wake it.
- **Kill switch.** `PI_BADGER_MESSAGE_BUS=0` disables the tick along with the
  delivery hooks; the `check` tool stays.
- **No polling-guard cost.** The internal tick is not a `delegations list`
  call — manual `delegations list`/`log`/`results` polling is still blocked
  (4th call in 120 s), and a shell `sleep` loop is still redirected to `wait`.
