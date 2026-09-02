# pi-badger-integration

Canonical source for [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent
extensions that are **not** part of the [ai-badger](../ai-badger) framework, with the publish
flow that installs them, and full unit-test coverage for everything this repo owns.

This repo exists so the integration source has its own git history and code management,
independent of ai-badger's release machinery.

## What lives here

Every extension installs as a directory package: `extensions/<name>/` →
`~/.pi/agent/extensions/<name>/`, shipping every file except the `node_modules`
subtree (pi discovers `~/.pi/agent/extensions/<name>/index.ts` only).

| Extension | Canonical source | Installed to |
|---|---|---|
| ai-badger hooks adapter (PreToolUse gates + PostToolUse arms) | `features/pi/adjustments/adapter/` | `~/.pi/agent/extensions/ai-badger/` |
| pi-cron (cron scheduler: in-process Bun.cron under bun, self-managed launchd agents otherwise) | `extensions/pi-cron/` | `~/.pi/agent/extensions/pi-cron/` |
| pi-mcp-tools (universal MCP tools extension) | `extensions/pi-mcp-tools/` | `~/.pi/agent/extensions/pi-mcp-tools/` |
| session-signals (marker `!` importance — mid-run abort; delegation working status in the footer) | `extensions/session-signals/` | `~/.pi/agent/extensions/session-signals/` |
| shift-enter-newline (Shift+Enter newline for terminals that cannot report it, e.g. JetBrains IDE terminal) | `extensions/shift-enter-newline/` | `~/.pi/agent/extensions/shift-enter-newline/` |
| subagent (delegation to ai-badger personas scaffolded into `<project>/.pi/agents/`; background runs, progress and logs — see below) | `extensions/subagent/` | `~/.pi/agent/extensions/subagent/` |
| monitor (one-shot predicate monitors over delegation transitions, the idle `wait` tool, and manual-polling enforcement — see below) | `extensions/monitor/` | `~/.pi/agent/extensions/monitor/` |

Still ai-badger-owned: the adapter is vendored + tested in ai-badger's
`features/pi/` (see the three-copy model below).

## The subagent extension: background delegation

The `delegate` tool runs a persona as a separate `pi -p --mode json` child. In an
interactive TUI session (`ctx.mode === "tui"`) delegation is **always background** —
blocking was removed there: the tool returns immediately with a receipt (`d-<n>`, state
running/queued) and the main agent loop stays interactive — the user can keep typing, the
agent can keep working. When the child settles, its result lands in exactly one
`delegation-result` follow-up message (exit code, answer tail capped at 8 KB, duration,
token usage, log path) and wakes the agent; completions arriving inside a 2 s coalesce
window share one batched message (lead card immediate, up to 6 cards per batch). Results
arrive on their own — **never poll** for them (repeated `delegations list`/`log` polling is
blocked by the monitor's enforcement). To keep a strict order, queue work with the
**`queue` tool**: `add` (serial group — members run one at a time, in order),
`add-parallel` (members run concurrently once they all fit), `clear` (cancel every queued
task; running ones untouched), `list` (the queued groups with live positions). The whole
queue tool is TUI-only. An explicit `background: false` in the TUI is rejected at execution
time (`reason: "blocking-removed"`, no child runs) with guidance pointing at `queue`
(ordering), `delegations wait` (spending idle time) and `delegations abort` (stopping
runs). A synchronous panel is receipts plus `delegations wait ids`, which waits for ALL
named ids. In headless modes (`-p`, json, rpc) delegation stays **blocking** — the result
is the tool result, byte-compatible with the pre-background contract, plus `details.usage`;
an explicit `background: true` outside the TUI degrades to blocking with a note in the tool
result and `details.degraded`. There is no automatic wall-clock timeout: runs
are unbounded unless the `delegate` call passes `timeoutMs` (clamped to 1 s–24 h; on expiry
the run is aborted and settles as `aborted (timeout)`). The inactivity watchdog is
automatic: a child that emits no stream events for 10 minutes (default) is aborted and
settles as `aborted (lost)`.

Checking on delegations:

- **`delegations` tool** (LLM-facing): `list` (state, elapsed, current activity, usage),
  `log <id>` (bounded tail + full path), `abort <id|all>`, `wait [ids] [timeoutMs ≤ 600s]`
  (resolves with per-id snapshots; completion messages arrive regardless).
- **`/delegations [log <id>] [abort <id|all>]`** (human-facing command).
- **Widget** above the editor: one line per background running run (id, agent, elapsed,
  current activity, usage) plus a queued count, cleared when the session's runs end.
- **Logs**: every child's raw JSONL event stream is teed to
  `~/.pi/agent/subagent-logs/<runId>.jsonl` — a `run` header (runId, sessionId, persona,
  task, argv, cwd, pid, startedAt), the child's events verbatim, stderr as
  `{"type":"stderr",…}` lines, and a final `exit` line. Byte-capped per run (header + tail
  kept, middle elided). Logs live at user scope deliberately: they survive reboots and
  never touch any project's git status. Retention: >14 days pruned at `session_start`,
  directory capped oldest-first.

Lifecycle: at most 4 children run at once (env `PI_BADGER_SUBAGENT_MAX_CONCURRENT`), 16
queued FIFO, loud rejection beyond. `session_shutdown` SIGTERMs running children (SIGKILL
after a 5 s grace). Delegations do not
outlive the session — after a restart the log dir is the durable truth: finished runs are
classified from their `exit` line, receipt-only runs report as lost (stale instead once the
log has been quiet past the 10-minute stale threshold), and no wake-up message
is injected after a restart. Run ids are never reused (skip-to-next-free over the log
directory), so `delegations log d-N` stays unambiguous across restarts. One documented
limitation: `/tree` navigation away from the delegating branch hides that branch's
receipts — the log directory remains the way to find those runs.

## The monitor extension: predicate wake-ups

The `monitor` tool (TUI-only) arms one-shot predicate monitors over delegation
transitions. `register` takes a JS predicate expression (4 KB cap) evaluated as
`return (expr)` inside a function body (statements still fail at compile) in a fresh sandbox against `{ delegations, monitors }` on every
`delegation-transition` event — no wall-clock input, transitions are the only trigger. The
snapshot's `delegations` is the whole fleet this session has seen (terminal records stay),
so an "all settled" predicate sees every delegation's current state. The FIRST truthy
evaluation — including at registration, when the condition already holds — removes the
monitor and delivers one `monitor-event` follow-up (unbatched, wakes the agent). The
predicate must evaluate to a primitive: a promise or object is an error card that disarms
the monitor. At most 8 monitors are active (9th register rejects naming them); `list`
shows them, `cancel <id>` disarms. A monitor with no `timeoutMs` expires after 10 minutes
(max 60): the expiry delivers an `expired` card and removes it. A throwing predicate
delivers an `error` card once and is never retried. Outside the TUI every `monitor`
action rejects loudly — there is no idle session to wake.

For the human side, the **`/monitors` command** lists the armed monitors at a glance (id,
name, predicate excerpt, age, time left); `cancel <id>` disarms one, and argument
completion offers `cancel` plus the armed monitor ids. In headless modes it notifies
nothing.

The `wait` tool spends idle time without polling — and is allowed in every mode. It blocks
the turn (the pending-tool idiom) until the FIRST of: a watched delegation settles (pass
`ids` to scope the watch; the default is any live delegation), an armed monitor fires, the
user sends a message, or the timeout passes (default 120 s, max 600 s, clamped). The
tie-break is listener order (delegation → monitor → input → timeout) and the wait resolves
exactly once. With nothing live and nothing armed it resolves immediately with
`observed: "empty"` and guidance instead of idling. The result is a terse pointer
(`details: {observed, waitedMs, records?}`) — a monitor wake's payload rides the
monitor-event card and is never duplicated. A turn abort or session shutdown resolves the
wait as `observed: "aborted"`; nothing sends after shutdown.

The monitor extension also enforces the no-polling rule: a `tool_call` observer counts
`delegations list`/`log`/`results` calls (nothing else — `wait`, `abort`, `queue` and `monitor`
calls are exempt) and blocks the 4th call inside a sliding 120 s window with guidance to
use `wait` or a monitor instead; blocked attempts count too. `PI_BADGER_MONITOR_POLL_MAX`
is read per call and `0` disables the guard; state resets on session shutdown.

## One-time cleanup after the switch to directory installs (do once, by hand)

The old publish flow installed two flat files, and ai-badger's installer used a
different directory name for the subagent. After the first directory-model
publish, remove the stale user-scope leftovers — pi would otherwise load
duplicates (double hooks and tools):

```bash
rm ~/.pi/agent/extensions/session-signals.ts
rm ~/.pi/agent/extensions/shift-enter-newline.ts
rm -r ~/.pi/agent/extensions/ai-badger-subagent/   # old name; the generic rule installs it as subagent/
```

publish never deletes anything outside the directories it owns (the
per-extension dirs and the adapter dir it installs into) — stale neighbours are
left for you to remove.

## The three-copy model

1. **Canonical** — this repo. Edit here.
2. **Vendored** — ai-badger's `features/pi/adjustments/adapter/`. ai-badger's
   scaffold-freshness gates require the shipping copy in-repo, so the adapter is vendored
   back and committed there. ai-badger's own test suite (`bun test features/pi`) runs
   against this vendored copy — the artifact its scaffolds actually ship.
3. **User scope** — `~/.pi/agent/extensions/`, which pi loads into every session.

`--check` compares canonical against user scope only — it never writes, and it cannot be
combined with `--ai-badger` (checking never writes; vendoring always does). The adapter
target enforces **exact file-set equality**: missing, extra
and byte-differing files all fail — ai-badger's installer ships any `.ts`/`.json` with no
cleanup, so a renamed canonical file would otherwise leave a stale extra that breaks every
fresh pi session.

## Flow (the reviewed order — do not skip the vendoring step)

1. Edit canonical source here; keep tests green: `bun test`.
2. `bun run publish -- --ai-badger /Users/arasz/RiderProjects/ai-badger` — vendors the
   adapter into that checkout (vendor-ONLY: user scope is not touched in this step; refuses
   if the vendored dir does not exist; cannot be combined with `--check`).
3. In the ai-badger checkout: `bun test features/pi` — its tests exercise the freshly
   vendored artifact — then commit.
4. `bun run publish` — installs canonical to user scope.
5. `bun run check` — must exit 0.

A user-scope-only publish is **transient**: the next real scaffold of any project
re-copies ai-badger's vendored adapter over it. Step 2 is what makes a change durable.

## Why not a symlink

ai-badger's installer (`adjust_hooks.py`) `copy2`s files into
`~/.pi/agent/extensions/ai-badger/`. Through a symlinked directory that would write into
this repo during scaffolds of unrelated projects — and a scaffold from an older ai-badger
checkout would push stale bytes into canonical source. Copies plus `--check` are the safe
shape.

## Concurrency note

Installs write to a temp file then rename — no partially written file ever appears at a
destination. The rename is per-FILE, not per-set: a pi session starting inside the
sub-millisecond window between two adapter-file renames could observe a mixed set.
Already-running sessions are unaffected (their modules are loaded). ai-badger's freshness
gates run `--no-install`, so CI activity never races the user-scope install.

## Commands

```bash
bun install        # one-time
bun test           # every extension this repo owns, fully unit-covered
bun run check      # drift report, exit 1 on any
bun run publish    # install canonical → user scope
bunx tsc --noEmit -p .
```

## Provenance

- Adapter imported byte-identical from ai-badger @ `f07ff473` (0.145.0), which carried the
  PostToolUse arm work verified live that day.
- shift-enter-newline imported byte-identical from user scope
  (`~/.pi/agent/extensions/shift-enter-newline.ts`, 2026-08-29); its tests came from the
  temporary home `~/RiderProjects/shift-enter-newline-tests` (10 passing tests) — that repo
  is superseded by this one and safe to archive once this suite is green.
