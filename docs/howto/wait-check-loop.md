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

Just `wait` — with whatever `timeoutMs` fits the work (default 5 min, max
600 s, clamped; the timeout resolves, never errors):

- `observed: "mail"` → handle the delivered mail (ack what you consumed).
- `observed: "delegation"` / `"monitor"` → the watched work settled.
- `observed: "input"` → a user message arrived; it takes precedence.
- `observed: "timeout"` → nothing settled and no mail arrived; wait again or stop.
- `observed: "empty"` (non-TUI, nothing live) → the tick has nothing to hold;
  in headless modes a blocking `delegate` call is the way to wait for
  delegation work instead.
- `observed: "aborted"` → the turn is ending; do not wait again.

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
