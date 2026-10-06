# ADR: Abort delegation work when a wait deadline expires

Date: 2026-10-06
Status: Accepted (owner request in the delegation UI investigation)

## Context

`delegate.timeoutMs` already killed its child at expiry. `wait.timeoutMs` only
returned a fleet snapshot, leaving watched agents running. The same parameter
name therefore represented two different consequences. The owner requested
aborting behavior for both.

The UI investigation also found that queue-first delegations could be invisible
because the status surface had not captured a UI context. That fix initializes
the context at session start and refreshes it on queue calls and results.

## Decision

A wait deadline is a cancellation deadline, not just an observation budget.

- With explicit `ids`, timeout targets only those watched runs that are still live.
- Without `ids`, it targets every live delegation in this session at expiry,
  including queued runs and runs started after the wait began.
- Completion, input, mail, and ordinary monitor wakes do not cancel work.
- An initially idle wait still uses its visible timer monitor. That timer's
  expiry follows the timeout path, even if it fires before the wait's own timer.
- Timeout claims its result and removes its wake subscriptions before cancelling.
  The resulting abort transitions still deliver completion cards, but cannot
  change this wait's `observed` value from `timeout` to `delegation`.

Cancellation calls `delegations abort` through pi's nested tool API. The tool
accepts an array in `id` for atomic scoped cancellation, while retaining a single
ID and `"all"`. Every selected queued member is removed before admission drains.
This matters for parallel groups: removing just one pending member can make the
remaining group fit into available slots and start another cancellation target.
Running targets use the existing SIGTERM-to-SIGKILL path.

Timeout results include `abortedIds`, `abortErrors`, and a post-request fleet
snapshot. Accepted abort requests are not proof of OS process reaping. A missing
nested API, permission denial, failed call, or missing acknowledgement produces
an explicit warning, not a claim that cancellation succeeded. Older hosts without
pi 1.0.3's nested tool API cannot perform this cancellation.

<!-- trust:trustchecked evidence=extensions/monitor/index.ts:645 evidence=extensions/subagent/delegation-registry.ts:370 -->

## Consequences

This intentionally changes the old non-destructive wait-timeout contract.
Existing callers using short waits for periodic status checks must change: scope
`ids` carefully, choose a deadline that is a real work budget, or register a
monitor and end the turn if agents should continue indefinitely.

The clocks remain different. Delegate deadlines start at spawn and exclude queue
time; omitted or zero delegate deadlines are disabled. Wait deadlines start at
the wait call and default to five minutes, capped at ten minutes. Wait-triggered
aborts use the normal `aborted` state; the wait result identifies their timeout
cause. A delegate's own deadline retains `aborted (timeout)` and its run limit.

The earlier delegation plans remain historical records. This ADR supersedes their
non-aborting wait deadline and idle-timer-as-monitor-wake behavior. The current
[extension catalog](../reference/extension-catalog.md) and
[wait how-to](../howto/wait-check-loop.md) describe the new contract.

## Verification

TDD regressions failed before cancellation was implemented. Tests cover unscoped
and scoped cancellation, running and queued targets, atomic parallel-group
removal, non-timeout input wake, timeout-vs-abort-transition ordering, the idle
timer race, cancellation failures, and direct array-abort validation.

- `tests/monitor/cross-extension-queue.test.ts`
- `tests/monitor/wait-tool.test.ts`
- `tests/subagent-status.test.ts`

No live-terminal rendering or real model-backed cancellation smoke test is claimed.
