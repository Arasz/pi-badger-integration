# Extension catalog

Deep reference for the extensions this repo ships. For install steps see [Install extensions](../howto/install-extensions.md).

## The mem-based-rag extension: memory-based prompt enrichment on the ai-raccoon bank

Substantive user prompts gain a labelled `Memory context:` block injected via
`before_agent_start` — top-5 memory snippets plus top-5 code snippets from
`memory_search`, each with its hash so the agent can `memory_get`/`code_get` the
full entry. The block is agent-side only: it is injected with `display: false`,
so the terminal renders no memory card while the model still receives the
context. The prompt itself is never rewritten: the `input` handler only
captures the raw pre-expansion text (so a `/skill:task <words>` call is queried
by `<words>`, never by expanded skill content), and enrichment arrives as a
separate message with its own card.

Skip list (filters, not a score floor, kill meaningless prompts): empty input,
any leading-`/` command line, control words (`stop`, `continue`, …), bare skill
calls, `<20` chars, fewer than 6 unique words (≥3 chars outside a noise
dictionary), and empty results (no-hits skip). The block carries a
trust-boundary header: retrieved snippets are untrusted background, never
instructions. Modes:
`default` (search snippets) and `expanded` (a `memory_get`/`code_get` per kept
hit, with path + chunk/line provenance, per-hit snippet fallback). Transport is
a persistent bare `ai-raccoon` child on the default proxy transport (pi extensions cannot invoke
MCP tools): thin stdio JSON-RPC forwarded to the single shared serve — spawn+init ~0.3 s amortized, first search ~4.5 s model warm-up,
steady ~0.4–0.5 s, every call timeout-bounded (default 20 s) and fail-open — a
slow or dead bank skips enrichment, never the turn. Agent memory is untouched:
same server, separate call site.

Config (env defaults, read per call; `/rag` for session scope):
`PI_BADGER_MEM_RAG=0` disables, `PI_BADGER_MEM_RAG_MODE`
(default|expanded), `PI_BADGER_MEM_RAG_MIN_WORDS` (default 6),
`PI_BADGER_MEM_RAG_MIN_CHARS` (default 20),
`PI_BADGER_MEM_RAG_TIMEOUT_MS` (default 20000),
`PI_BADGER_MEM_RAG_SNIPPET_CHARS` (default 300). `/rag status`
reports enriched/skipped counts and the last reason; `/rag mode
default|expanded|off` overrides for the session.

Auto-enrichment routes through the query-pipeline extension (plan -> per-query
search -> Jev scoring -> document-aware merge). `PI_BADGER_QUERY_PIPELINE=0`
keeps the single-search behaviour above; any planner or scoring failure degrades
to that same single search, so a dead bank still reports `bank error` and a turn
is never failed by retrieval.

## The query-pipeline extension: multi-query retrieval behind mem-based-rag

One prompt becomes several focused queries. The `group` stage sends the query
(the `/skill:<id>`-stripped prompt) to the session model — or
`PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` — with the delegator persona as the
system prompt, and parses a `{"concepts":[{"name","queries"}]}` plan
(normalizing over-long plans to at most 6 queries rather than rejecting them).
The `split` stage runs one `memory_search` per query, sequentially through
mem-based-rag's single-flight transport. The `rank` stage scores every candidate
with Jev (`type:"score"` questions, batches of 12, copied by contract from the
decision-router client). The `merge` stage fills **five slots total**: the best
chunk per distinct document first, and only when fewer than five documents match
does it backfill with the next-best chunks of the already-included documents.
The result is the bank's own `memory_search` envelope, so the injected block and
its card are unchanged.

While the pipeline runs, the footer shows `[query-pipeline · planning queries]`,
`[query-pipeline · searching i/n · "…"]`, `[query-pipeline · scoring N candidates · B batches]`,
`[query-pipeline · merging N candidates]` and clears when the block is injected (Esc does not cancel it — the hook is not
cancellable, and the budget bounds it).

Config (read per call): `PI_BADGER_QUERY_PIPELINE=0` disables,
`PI_BADGER_QUERY_PIPELINE_TOTAL_MS` (default 90000, 5000–300000), `_PLANNER_MS`
(15000, 1000–60000), `_SEARCH_MS` (15000, 500–60000), `_SCORE_MS` (8000,
1000–60000), `_SEARCH_LIMIT` (5, 1–20), `_PLANNER_MODEL` (unset -> the session
model), and `PI_BADGER_JEV_SCORE_TIMEOUT_MS` (15000, 1000–120000) plus the shared
`PI_BADGER_JEV_ENDPOINT` / `PI_BADGER_JEV_MODEL` / `OPENROUTER_API_KEY`. A missing
key skips scoring and merges by server rank.

Data egress: the query text goes to the planner model provider, and the query
text plus up to 500 characters of each candidate excerpt go to OpenRouter for
Jev scoring. `PI_BADGER_QUERY_PIPELINE=0` keeps everything local.

This extension ships as a pair with mem-based-rag, which statically imports it —
installing mem-based-rag alone fails at extension load (the publish flow installs
all owned directories together).

## The subagent extension: background delegation


The `delegate` tool runs a persona as a separate `pi -p --mode json` child. In an
interactive TUI session (`ctx.mode === "tui"`) delegation is **always background** —
blocking was removed there: the tool returns immediately with a receipt (`d-<n>`, state
running/queued) and the main agent loop stays interactive — the user can keep typing, the
agent can keep working. When the child settles, its result lands in exactly one
`delegation-result` follow-up message (exit code, answer tail capped at 8 KB, duration,
token usage, log path — the structured result rides the message's `details.result`) and
wakes the agent; completions arriving inside a 2 s coalesce
window share one batched message (lead card immediate, up to 6 cards per batch). Results
arrive on their own — **never poll** for them (repeated `delegate list`/`log` polling is
blocked by the monitor's enforcement; `delegate peek` is the sanctioned live-check
and is not counted). To keep a strict order, queue work with the
**`queue` tool**: `add` (serial group — members run one at a time, in order),
`add-parallel` (members run concurrently once they all fit), `clear` (cancel every queued
task; running ones untouched), `list` (the queued groups with live positions). The whole
queue tool is TUI-only. The `background` parameter is gone — mode alone decides: the TUI
always backgrounds with a receipt, and a stale `background` key replayed from an old session
is stripped before schema validation. Ordering, idle waiting, and stopping runs work as above
(`queue`, the monitor extension's `wait` tool, `delegate abort`). Every delegation enters the queue as a
one-element serial group — on an idle system it starts immediately, otherwise it waits its
turn behind a blocked queue head (cap full, a mid-flight serial group, or a parallel group that cannot use a slot); the queue is the only admission path. In headless modes (`-p`, json, rpc) delegation stays **blocking** — the result
is the tool result, byte-compatible with the pre-background contract, plus `details.usage`;
there is no background opt-in to degrade, so the result carries no `degraded` key and no
degrade line. A `delegate` call can set `timeoutMs` (clamped to 1 s–24 h, counted
from child spawn); expiry aborts that run as `aborted (timeout)`. A `wait` timeout
also aborts its watched live runs, including queued work, using the normal abort
path. Without either deadline there is no wall-clock limit. The inactivity watchdog is
automatic: a child that emits no stream events for 10 minutes (default) is aborted and
settles as `aborted (lost)`.

**One retry, on the parent model.** A child that fails on its model is respawned **once**
under the same run id on the **parent (session) model** — the retry is not a second
delegation (one log header, one exit line, one result note). Three failures arm it: the
persona's `model:` pin (or its `level:`-resolved id) could not **start** the child — pi's own
resolution error on stderr (unknown provider, no API key, ambiguous model) **or** the provider
refusing that id inside the turn (`model_not_supported`, "the requested model is not
supported") — and the provider answered **402**, which is an API error inside a live child, so
it arrives in the child's event stream rather than on its stderr. The respawn is never silent:
the reason (the rejected model, the 402) rides the result note and the card verdict, and the
retry fires at most once per run. The respawn re-runs the task from the start, so a child
that had already produced output repeats it on the parent model; the answer a run reports
is always the respawned attempt's.

Checking on delegations:

- **`delegate` tool — management actions** (LLM-facing; pass `action` explicitly — a call without
  an `action` is a delegation): `list` (state, elapsed, current activity, usage,
  trailing `session <id>` when known), `log <id>` (bounded tail + full path; a RUNNING
  run's file holds only its `run` header, so `log` answers from the in-memory live preview
  until the run settles),
  `peek <id> [--lines N]` (last N lines of the delegated task output, default 20, 1-100;
  settled runs read the cached answer, live runs read the in-memory preview, queued runs
  report position), `abort <id|all>` (the tool also accepts an array of IDs for atomic
  scoped cancellation), `results [id]` (the cached
  structured result — `{parent_id, delegation_id, task_summary, persona, input, output,
  timestamp}` — of one delegation, or, without an id, every result this session parented;
  an in-memory cache of the LAST 8 results that dies with the session), and
  `resolve <d-N|guid>` (a local run id's global GUID, or a GUID's run, project and log file —
  the cross-project lookup; `log`/`peek`/`abort` keep local ids). Results also
  arrive on their own — never poll: to spend idle waiting time, use the monitor
  extension's `wait` tool (user input interrupts it) or register a monitor.
- **`/delegations [log <id>] [peek <id> [--lines N]] [resolve <id|guid>] [abort <id|all>]`**
  (human-facing command).
- **Widget** above the editor: one line per background running run (id, agent, elapsed,
  current activity, usage, trailing `session <id>` when known) plus a queued count, cleared
  when the session's runs end. Completion cards and delegate receipts likewise carry
  `session <id>` when the delegating session is known.
- **Logs**: every child's raw JSONL event stream is teed to
  `~/.pi/agent/subagent-logs/projects/<projectKey>/<runId>.jsonl` — a `run` header (runId,
  globalId, sessionId, persona, task, argv, cwd, pid, startedAt), the child's events
  verbatim, stderr as `{"type":"stderr",…}` lines, and a final `exit` line. The project
  key is `.ai-badger/project-id` when present (env `AI_BADGER_PROJECT_ID` wins), else a
  stable hash of the nearest `.ai-badger`/`.git` root (cwd when neither exists), so each
  project owns its own `d-N` namespace and its ids restart at `d-1`. Byte-capped per run
  (header + tail
  kept, middle elided). While a run is LIVE the file holds only its `run` header — the
  child's buffered stream lands at close — so `delegate log` falls back to the in-memory
  live preview (the same source `peek` reads) and never prints an empty "showing the tail"
  marker. Logs live at user scope deliberately: they survive reboots and never touch any
  project's git status. Retention: >14 days pruned at `session_start`, capped
  oldest-first per project directory.
- **Global ids and the index**: every run also mints a UUID v7 `globalId` (on the record, in
  its `run` header and in the receipt details). When the run's log sink opens, the extension
  appends `{globalId, id, projectKey, projectRoot, logFile, at}` to
  `~/.pi/agent/subagent-logs/index.jsonl`, compacted to the newest 500 entries. A GUID from
  another project is answered by `delegate resolve <guid>` from that index; a local
  `delegate resolve <d-N>` answers from the live registry (or the settled run's header) with
  its GUID. Two projects may both hold a `d-1` — the GUID is the cross-project handle.
- **Legacy flat logs** (`~/.pi/agent/subagent-logs/d-N.jsonl`, written before this layout)
  are left untouched but never read: new sessions neither reconstruct them nor allocate around
  them, so a flat `d-9` does not reserve `d-9` in any project. There is no migration.

Lifecycle: at most 4 children run at once (env `PI_BADGER_SUBAGENT_MAX_CONCURRENT`), 16
queued FIFO, loud rejection beyond. `session_shutdown` SIGTERMs running children (SIGKILL
after a 5 s grace). Delegations do not
outlive the session — after a restart the log dir is the durable truth: finished runs are
classified from their `exit` line, receipt-only runs report as lost (stale instead once the
log has been quiet past the 10-minute stale threshold), and no wake-up message
is injected after a restart. Run ids are never reused within a project (skip-to-next-free
over that project's log directory), so `delegate log d-N` stays unambiguous across
restarts; ids restart at `d-1` in a project that has never run a delegation, and two
projects may both hold a `d-1`. One documented
limitation: `/tree` navigation away from the delegating branch hides that branch's
receipts — the log directory remains the way to find those runs.

Delegation-skip guard: a `tool_call` listener matches bash commands that spawn `pi`
directly (command-position pattern with env/sudo/nohup/npx/timeout/path prefixes;
16/16 prompt-like must-block, 23/23 near-miss silent including `pip`, `publish.ts`,
the `nohup` gates and quoted data, 9/9 help/version must-allow) and returns `{ block: true }` with
`spawning pi directly is blocked — use delegate instead` plus an append-only
record. Quoted spans are read as DATA (blanked before matching), so a grep pattern
(`"...|features/pi"`) or a multi-line `git commit -m` message never fakes command
position — except a double-quoted span containing `$(` or backticks, which is left
verbatim because substitutions execute inside double quotes (that span can
over-block, never miss). Help/version reads (`pi --help`, `-h`, `--version`, `-v`, including
`pi <subcommand> --help`) stay silent — documentation, not delegation skips.
Blocking with fail-open on predicate crash (a record failure still blocks);
there is intentionally no env kill switch — the guard always enforces. Spawning through wrappers
(`sh -c`, `pnpm dlx`) is a known silent gap.


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
shows them (each row names its `predicateKind`), `cancel <id>` disarms. Register also accepts
`predicateKind: "bash"` (default `"js"`). A bash predicate is a script, not an expression,
and it runs unsandboxed as `bash -c` with your full user privileges, so only register what
your own agent wrote. The monitor snapshot JSON arrives on stdin (never argv or env, while
env and cwd inherit), e.g. `grep -q '"state":"completed"'`. Exit 0 fires and the trimmed
stdout (capped at 1 KB) becomes the fire value, with empty output meaning true. Exit 1 is
idle. Any other exit, signal death, timeout kill after 5 s or spawn failure delivers an
`error` card and disarms. JS monitors evaluate synchronously inside the transition dispatch
while bash monitors evaluate concurrently on one frozen per-drain snapshot, so a slow script
never delays a JS card. Registering a bash monitor awaits its immediate evaluation (compile gate plus up to one evaluation budget, defaults ~2s + 5s); transition drains never block — bash evaluates concurrently on one frozen snapshot while JS cards send synchronously. Expiry, cancel and shutdown kill in-flight bash children and their late
completions are suppressed, never delivered. On Windows bash must be on PATH (Git Bash or WSL). A monitor with no `timeoutMs` expires after 10 minutes
(max 60): the expiry delivers an `expired` card and removes it. A throwing predicate
delivers an `error` card once and is never retried. Outside the TUI every `monitor`
action rejects loudly — there is no idle session to wake.

For the human side, the **`/monitors` command** lists the armed monitors at a glance (id,
name, predicate excerpt, age, time left); `cancel <id>` disarms one, and argument
completion offers `cancel` plus the armed monitor ids. In headless modes it notifies
nothing.

The `wait` tool is allowed in every mode. Its pending promise resolves on the first
watched delegation settling, monitor event, user input, bus mail, or timeout
(default 5 min, maximum 600 s, clamped). **Timeout aborts watched live delegations.**
Pass `ids` to limit both the watch and cancellation; omit it to target all live
runs in this session at expiry, including work started after the wait began.
Queued tasks are removed atomically before admission resumes. Running children
receive SIGTERM, followed by SIGKILL if they do not close within the runner's grace
period. Other wake sources do not cancel work.

A timeout claims the wake before sending the abort request, so its own abort
transitions cannot relabel the result as a delegation wake. It returns
`details: {observed: "timeout", waitedMs, records, abortedIds, abortErrors}`;
`records` is the post-request fleet snapshot, and `abortedIds` acknowledges
accepted aborts, not OS process reaping. Cancellation uses pi's nested
`delegate abort` tool call, preserving validation and permission hooks.
Pi 1.0.3 supplies that API; an unavailable, blocked, or failed abort is reported
in `abortErrors` and a warning in the result, never as successful cancellation.

In TUI mode, an empty fleet with no monitors arms a visible `wait-timer` monitor
and keeps waiting. Its expiry is still a timeout, even if it wins the timer race.
Outside TUI, an empty fleet resolves immediately with `observed: "empty"`.
Non-timeout results retain `{observed, waitedMs, records?}`. Monitor payloads
ride their own cards. Turn abort and shutdown resolve as `observed: "aborted"`;
new bus mail wakes the wait through its internal 1 s check.

See [Wait for mail](../howto/wait-check-loop.md) and the
[aborting-timeouts ADR](../work/2026-10-06-aborting-delegation-wait-timeouts-adr.md).
<!-- trust:trustchecked evidence=extensions/monitor/index.ts:645 evidence=extensions/subagent/delegation-registry.ts:370 -->

The monitor extension also enforces the no-polling rule: a `tool_call` observer counts
`delegate list`/`log`/`results` calls (nothing else — `wait`, `abort`, `peek`, `queue` and `monitor`
calls are exempt) and blocks the 4th call inside a sliding 120 s window with guidance to
use `wait` or a monitor instead; blocked attempts count too. `PI_BADGER_MONITOR_POLL_MAX`
is read per call and `0` disables the guard; state resets on session shutdown. The same
observer enforces the no-manual-wait rule (f: 2026-09-02): a shell `sleep`/`Start-Sleep` in a
bash/powershell tool call parks the main loop and is blocked before it runs, redirected to
`wait` or a monitor registration; the env kill switch `PI_BADGER_WAIT_GUARD=0` disables it,
and blocked sleeps never count into the polling window.


## The router-fallback extension: free-model fallback on router failure


When the session's primary provider fails with billing-exhaustion (402 / out-of-credits
wording), an auth failure with somewhere else to go (401), or a dead model route (503 /
no-provider), the extension advances the session model ONCE per episode over the pinned
fallback chain below and posts a `router-fallback-event` notice naming the provider that
now serves. Throttle (429 / rate-limit without billing text) never switches models — it
holds silently and pi's native retry owns the wait (the selector's `wait` branch stays
unit-tested policy, never a live path). Request-side failures (400/403/404) and
context overflow never trigger anything. Detection reads the folded
`AssistantMessage.errorMessage` plus the last `after_provider_response` status (substring +
status-prefix matching only — bodies truncate, so exact shapes are never matched); the
switch itself happens at `agent_end`/`agent_settled`, never mid-turn.

Fallback chain (array order = priority; all three are pi built-ins, never re-registered):

| # | Provider (pi id) | Model(s) | Key (name only, never a value) | Role |
|---|---|---|---|---|
| 1 | OpenRouter (`openrouter`) | `openrouter/free` → `inclusionai/ling-3.1-flash` | `OPENROUTER_API_KEY` | first — one-key breadth (owner order 2026-09-06); the head is OpenRouter's **Free Models Router** (`openrouter/free` — the provider's own id for "any free model"), because a billing failure parks the whole entry and then serves its head — a head that needs credits answers 402 on an empty account (measured 2026-10-20) and the switch lands on a model that cannot serve either, so the paid id sits last; one id that always resolves to a free model, where a hand-kept list of `:free` ids rots (the chain's `minimax/minimax-m3:free` is gone from the catalog) |
| 2 | Groq (`groq`) | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | workhorse — absorbs sustained load |
| 3 | Gemini (`google`, native built-in) | `gemini-3.1-flash-lite` → escalation `gemini-3.1-pro-preview` | `GEMINI_API_KEY` | last |

An entry serves only when its key is set AND pi reports its provider auth configured;
a `--models` session scope restricts every entry to its in-scope candidates (an entry with
none is skipped). Stale ids resolve-or-skip — the chain degrades, never throws. Numbers:
cooldown default 60 s (capped at 1 h), per-entry retry budget 1 rotation, per-attempt
timeout 30 s carried for the follow-up (v1 never times — the live `/models` re-fetch is
likewise a specified follow-up; v1 ships pinned-chain + `modelRegistry.find` filter),
1 switch per episode, notices capped at 8 KB, `Retry-After` waits
`max(retryAfter, cooldownMs)`. Limitation: deployments that emit a single `agent_end`
per run always resolve head-or-hold — deeper chain positions engage only when pi emits
more than one `agent_end` per episode (chain depth latent, H1).

The **`/fallback` command**: `status` (episode, serving provider, last failure),
`reset` (open a fresh episode), `off`/`on` (session override of the kill-switch below).
Kill-switches (read per call, never cached): `PI_BADGER_ROUTER_FALLBACK=0` disables
entirely; `PI_BADGER_ROUTER_FALLBACK_MAX_SWITCHES` sets the per-episode budget (`0` = off).
The fallback is **session-only and never persisted**: the extension-level `setModel(model)`
takes no options, so the session-level `{persist:true}` path is structurally unreachable
— the persisted default is never touched (pinned by test).

Verification notes: pi 0.84.4 (pin at the time) vs 0.85.1 (installed) shapes re-verified
identical (`setModel` false-on-missing-auth, `{messages}`-only `agent_end`,
`model_select{source:"set"}`); the keyless custom-overlay path passes pi's own
`validateExtensionProvider` offline; the chain's head was confirmed present on
the live OpenRouter roster 2026-09-05 (as `openrouter/free`, the provider's
"Free Models Router" — the chain's head since 2026-10-20, when it replaced a
hand-kept list of `:free` ids). No valid provider key exists in this environment
(the checked-in-shape env placeholders are rejected by all three providers), so live
generation on a free entitlement stays an explicitly BLOCKED follow-up — the defaults
above stand flagged, never fabricated.


## The message-bus extension: native pi bus on the ai-badger backend

The `message-bus` tool and the **`/messages` command** speak the same SQLite bus
the `send-message` skill writes (`messages` + `cursors` in the user DB) — no new
transport, the protocol is `multi-agent-communication` (ack every non-ack once
as a project broadcast, never reply to an ack, only ack what is in your inbox).

- `send content` (+`sessionId` for 1:1, +`projectId` for project broadcast,
  neither for machine broadcast; session wins over project at write, blanks
  read as unset). Direct ids pass a shape gate (whitespace/`$(`/backtick/newline
  reject pre-insert — the #672 class); sends to an unknown session id or to self
  succeed with a warning in the result (`never seen on this machine` /
  `never deliverable`), never a block. `/messages send-to` shares the same gate.
  Sender identity is mandatory: the session manager's id plus
  the nearest `.ai-badger/project-id` above the session cwd
  (`AI_BADGER_PROJECT_ID` wins).
- `list` renders the inbox grouped by scope — direct (1:1), project
  broadcast, machine broadcast — last 3 per group, rows marked received (✓)
  or new (●). Every `list`/`check`/`whoami` output opens with a
  `you are <sid8> in project <pid8>` identity line so announcements carry wire
  truth. Never raw JSON; the same text backs the delivery card
  (`message-bus-event` via `registerMessageRenderer`).
- `check` delivers new mail now (cursor advances exactly-once; first read has
  the 30-minute gate + 16-cap and lands past `MAX(id)`).
- `reply id content` answers the original's sender as a direct message — never
  copy a session id from message content. Refuses the session's own sends,
  acks, and unknown ids.
- `whoami` returns the wire identity (session id, project id, cursor) through
  the same seams; fail-open to identity-without-cursor on a broken backend.
- `ack id` sends a stub (`ack: #<id> — terminal, no reply expected`) once as a
  project broadcast — never the original body (F7: echoed bodies read as live
  requests). Acking an ack or a message outside your inbox refuses.
- Hooks on `session_start` (directs only behind a user confirm gate; the summary
  is user-only via `appendEntry`, never LLM context) and
  `turn_start` (quiet context for the starting turn). The startup summary states
  what was silently consumed (`n older directs and m broadcasts`, window/cap causes);
  broadcasts-only startups append the user-only entry with no agent card. `session_start`
  also upserts the session into `bus_identities` (fail-open, never creates a missing DB).
  The idle-session wake
  stays with the adapter's poll timer — these hooks never arm their own.
  A wait-blocked turn still wakes on new mail via the wait's internal 1 s check;
  `check` delivers on demand outside waits. See `docs/howto/wait-check-loop.md`.
  `PI_BADGER_MESSAGE_BUS=0` disables the hooks; tools stay. Every backend
  failure is fail-open: an error result, a command notify, or a silent hook
  skip — a broken bus never breaks a session, and a missing DB file is never
  created as a side effect.


## The pi-mcp-tools extension: retired in favour of built-in MCP

`pi-mcp-tools` was retired in favour of pi's built-in MCP: tools are named
`mcp__<server>__<tool>`, with config in `~/.pi/agent/mcp.json` or `.pi/mcp.json`.
The human result cards are gone: pi renders results natively and truncates text
results over 20 KB Codex-style to a temp file. Config and command mapping:
[Update integrations](../howto/update-integrations.md).

## The decision-router extension: one Jev call per turn for tools, tier and shadow routing

An enabled turn gets one pre-flight decision call before the agent loop: a
single `POST` to the TypeSafe Jev 1.13 decisions endpoint carrying the task and
up to three questions — which tools the task needs, which model tier is
sufficient, and which skill should handle it (plus a `needs_subagent` noul
companion). The three answers ride one body; only enabled capabilities are
asked, and the tools question is dropped (hold, no priced work) when the
catalogue is empty or cannot fit the 8 KB state budget. Every turn is gated
first — kill switches, session override, missing key, an armed `429` cooldown,
slash-prefixed prompts, marker-prefixed prompts once the predicate is wired
(provisional, plan F18 — the shipped default never marks), fewer than 12
non-whitespace characters, an in-flight call, and the session cache all skip
without a request. The cache is an LRU of 50 keyed by prompt hash + catalogue hash +
model id with no TTL; a catalogue change, a foreign `model_select`, a
`router-fallback` switch, `/decisions reset` or shutdown invalidates it.

Policy is deliberately asymmetric. Tool selection is **additive**: the winner
must be a live catalogue entry, confidence must clear 0.7, and the applied set
is the active set plus every catalogue entry at probability ≥ 0.2 — an unknown
winner rejects the whole question and tools are never removed. The tier
question upgrades only on `high` ≥ 0.6 and demotes only on `low` ≥ 0.85 (the
measured medium answer holds), targets come from
`PI_BADGER_JEV_TIER_LOW_MODEL`/`_MEDIUM_MODEL`/`_HIGH_MODEL`, and while a
router-fallback switch latch is armed upgrades hold. Routing is
**shadow-only, with no enforce path at all**: the record
`{question, choice, confidence, promptHash}` goes to a 20-entry ring that
`/decisions shadow` prints, and actuation does not exist in the action type.
The model step is session-only — `setModel` takes a single positional full
registry model resolved from the configured `provider/model-id` target through
`ctx.modelRegistry.find`, thinking level follows the landed model — and a
larger async `before_agent_start` can never change `systemPromptOptions`, so
the tool set is moved through `setActiveTools` alone.

Failure posture: the alpha endpoint sits behind an injected classifier seam,
and every transport/status/parse failure degrades to a deterministic
observe-only fallback (bounded word-part tool match, tier hold, route none)
while the tool set and model stay untouched; a missing or empty
`OPENROUTER_API_KEY` is a silent no-op with no request. `429` arms the
`Retry-After` cooldown clamped 60 s–1 h. The frozen error vocabulary
(`misrouted-refusal`, `auth`, `billing`, `rate-limited`, `server`,
`transport-timeout`, `malformed`, `missing-key`) and a 120-char `lastError` cap
are the only error text that surfaces; the key, headers, bodies and prompt
text never reach a log or the ring (hashes only). Kill switches are read per
call and only the literal `"0"` disables: `PI_BADGER_DECISION_ROUTER` (master)
and `PI_BADGER_DECISION_ROUTER_TOOLS`/`_MODEL`/`_ROUTING` (per capability),
with per-capability kills winning over the master, which wins over the
`/decisions off` session override — `/decisions on` never lifts an env kill.

Probe note: the in-hook `setModel`/`setActiveTools` semantics are source-
verified against the then-pinned pi 0.84.4 (hook-probe evidence recorded in the
ADR and the script at `tests/decision-router/probe/hook-probe.md`) but the
probe is **not run in-pipeline** — spawning `pi` is blocked by the
delegation-skip guard. If a live run ever shows `setModel` declining inside the
hook, the documented fallback is the thinking-level-only path; the wiring
already isolates that step from tools and routing.

## The console-capture extension: extension console output out of the TUI

pi does not reroute `console.*` in TUI mode, so extension output written at load, at
`session_start`, or later renders inside the input area. `console-capture` wraps
`console.log|info|warn|error|debug` at factory time and appends one
`<iso> <level> <text>` line per call to `PI_BADGER_CONSOLE_CAPTURE_LOG` or
`~/.pi/agent/badger-console.log`, rotating at 1 MiB to `.1` (exactly one generation).
`dir`, `trace` and `table` are deliberately outside the wrapper.

Lifecycle: armed from load, because extension-load-failure diagnostics print before
`session_start`; a `session_start` with `ctx.mode !== "tui"` disarms it so headless output
still reaches the terminal, and `session_shutdown` uninstalls it. If pi exits before a TUI
session_start confirms — the load-failure `process.exit(1)` path — the captured tail is
flushed to the original stderr on `process.on("exit")`, so startup diagnostics stay
visible. `process.on("uncaughtExceptionMonitor")` restores console permanently, so pi's
crash pair reaches the terminal. A throwing sink falls back to the original method once and
never throws into the caller. `uninstall` restores exactly the functions it captured, so it
nests with session-signals' vertex filter in either order.

Kill switch: `PI_BADGER_CONSOLE_CAPTURE=0|false|off` leaves `console` untouched and
registers no handlers. Caveat, by design: disabling the extension or the kill switch means
the leak returns — nothing else reroutes those call sites.

## The rtk extension: rewritten commands, compressed tool output, savings in the footer

`rtk` connects pi to the [rtk](https://www.rtk-ai.app) binary in three ways. It rewrites
bash commands before they run. It sends tool output through the user's rtk pipeline after
the tool finishes. And it puts the proxy state and the project's savings in the footer. It
started as rtk's stock pi extension (`hooks/pi/rtk.ts` in github.com/rtk-ai/rtk, pinned in
the file header); every rule still lives in the rtk binary and in `~/.config/rtk`. The
extension only carries verdicts across. It never edits Claude Code's settings.

### Before a bash call: `rtk rewrite`

Every bash tool call goes to `rtk rewrite`, so `git status` runs as `rtk git status` and
returns filtered output. The exit code decides: 0 or 3 with output rewrites the command in
place, 1 passes it through, 2 with a message blocks the call with that message (2 without
one passes through), and a timeout (2 s) or any other code passes through. Commands
already in `rtk` form and `RTK_DISABLED=1` skip the call. Every error path passes the
command through, because pi blocks a tool whose `tool_call` handler throws.

Changes from the stock file: the `rtk --version` probe runs in the background instead of
delaying pi's startup, and exit 2 with a message blocks, as `rtk rewrite --help` documents
(the stock file passes it through). rtk's current source prints nothing on exit 2, which
means a Claude Code deny rule from `~/.claude` matched; pi has no native deny to defer to,
so those commands run, as they do with the stock file. A command with leading whitespace
before `rtk` is not sent for rewriting again. A missing or older-than-0.23.0 binary
disables the extension and shows `[rtk disabled · <reason>]` in the footer.

### After a tool call: the rtk pipeline (`rtk hook claude`)

Before this, pi only ever asked rtk before a command ran. The after-tool half of the
user's pipeline (`hook.after_tool.*` rules in `~/.config/rtk/pipeline.toml`, such as a
Haiku digest for shell output over 5,000 tokens) never saw pi's output. Now a
`tool_result` handler hands each eligible result to `rtk hook claude` as a Claude-shaped
`PostToolUse` payload and swaps in the `updatedToolOutput` rtk sends back.

| pi tool | sent to rtk as | what comes back |
|---|---|---|
| `bash`, `powershell` | `Bash` (`stdout`, with the rewritten command) | compressed `stdout` |
| `read` | `Read` (`file.content`) | compressed content (by default only lockfiles) |
| `grep` | `Grep` (`mode: "content"`) | matches grouped by file |
| `mcp__*` | the same name, text blocks | compressed text |
| `find`, `ls` | not sent: rtk has no filter for file lists (`Glob` passes through) | |
| `edit`, `write` | not sent: rtk never processes them | |

A result is skipped when it holds an image, when its text is under 512 characters (rtk's
own `min_size`), when a codemode script made the call (`parentToolCallId`; the script
reads the raw data), when a bash call was aborted or timed out, and when `RTK_DISABLED=1`
is set. A bash command that `rtk rewrite` already turned into `rtk …` is sent only when its
output is 20,000 characters or more: below that rtk's terminal filter skips rtk commands
and the run would only add a 0% row, while above it the size rules (the Haiku digest) can
still act. That oversized case is the one the old setup missed.

pi's own trailers (`Command exited with code N`, `[Showing lines …]` and the read and grep
limit notices) are cut off before the text goes to rtk and put back afterwards, so the model
still sees the exit code and the continuation hint. `structuredContent` is passed through
untouched, so codemode scripts keep the raw output and `exit_code`. `details.rtk` records
the character counts before and after.

rtk runs in the session's cwd, which is where `rtk gain -p` looks for the project. The call
times out after 3 s, or after 20 s when the text is 20,000 characters or more, since the
pipeline may make a paid model call there. A timeout, a non-zero exit, empty or unparseable
output, or a reply longer than the original all keep pi's result unchanged; the handler
never throws. Expect the same latency and cost the pipeline already adds for Claude Code.

One side effect: a pi bash call that ran as `rtk grep` and then goes through the pipeline
records two rows in rtk's history, so `rtk gain` counts it twice.

### The footer

The extension writes one `rtk` status, in square brackets so it stays distinct from other extensions' statuses on the same footer row:

| footer | meaning |
|---|---|
| `[rtk ⇄proxy · cmd 62% · proxy 18% · compressed 3/5]` | pi's anthropic traffic goes through rtk-proxy |
| `[rtk proxy up · pi direct · cmd 62%]` | the proxy runs, pi does not use it |
| `[rtk proxy off · cmd 62%]` | no proxy is running |
| `[rtk proxy down! · cmd 62%]` | pi is pointed at the proxy, but it does not answer |

A project proxy figure that was measured earlier also shows while pi is direct, for example
`rtk proxy up · pi direct · cmd 62% · proxy 4%`.

`cmd` is the project's command savings from `rtk gain -p -f json`, as total saved over
total input. `proxy` is the project's proxy savings, read-only from the proxy's
`usage_records` (rows tagged with this project or a directory under it). It shows `–` when
pi is routed but nothing has been measured yet. `compressed` counts this session's tool
results sent to the after-tool pipeline and how many of them came back shortened
(`compressed/sent`) — it is the direct sign the after-tool pipeline is working. The line
refreshes on `session_start` and `model_select`, and on `turn_end` at most every 10 s.

`rtk gain` lists "Excluded: N oversized outputs" for commands whose raw input passed about
30,000 characters. It counts raw size, not failures, so it keeps rising even when rtk cuts
those outputs by 99%. Use `post` and `rtk gain --by-pipeline` to see whether compression
happens.

### Routing pi through rtk-proxy

When `rtk llm-proxy status` reports the proxy running and the active model is pi's built-in
`anthropic` provider on its stock `https://api.anthropic.com` URL, the extension points
that provider at the proxy (`pi.registerProvider("anthropic", { baseUrl })`, in memory only,
for this pi process). `RTK_PI_PROXY=0` turns this off. A custom or gateway anthropic URL is
never replaced. The proxy is checked again before every agent turn: when it no longer
answers, the extension puts the stock URL back (it re-registers that URL rather than
unregistering, so another extension's anthropic settings survive) and pi talks to Anthropic
directly. The same restore runs on `session_shutdown`, so a `/reload` or `/new` never leaves
pi pointed at a proxy nobody watches.

Only API-key authentication (`x-api-key`) was measured through the proxy. A Claude
subscription login (OAuth bearer token) has not been tried; set `RTK_PI_PROXY=0` if it
misbehaves.

Through the proxy, pi's requests are not byte-identical to direct ones. Measured with pi's
request shape (streaming, thinking, `cache_control`), everything worked and prompt caching
held. But the proxy merges the pipeline's directives (`rtk-awareness`, and `terse-output`
in the reference setup), about 320 uncached input tokens per request, and compresses large
tool results already in the conversation (CCR). This is what Claude Code gets when it runs
through the same proxy.

Routed requests carry `x-rtk-project: <cwd>` and `x-rtk-session: <pi session id>`. rtk's
proxy configuration docs (www.rtk-ai.app/docs/proxy/configuration, "Attribution headers")
say both are consumed by the proxy and never forwarded upstream; they are what makes the
footer's `proxy` figure project-scoped. HTTP header values must be plain ASCII, so a project
path with other characters (`/Users/łukasz/…`) is sent without the project header: those
requests still work, but their savings are not attributed to the project. `RTK_PROXY_BIND` (default `127.0.0.1:8080`) names the proxy
address and `RTK_PROXY_DB` an explicit usage database; otherwise the extension reads
`~/Library/Application Support/rtk/llm-proxy/rtk-proxy.db` on macOS and
`$XDG_DATA_HOME/rtk/llm-proxy/rtk-proxy.db` (default `~/.local/share`) elsewhere.

### Publishing

Publish removes a loose `~/.pi/agent/extensions/rtk.ts` (what `rtk init --agent pi
--global` installs), since both would register a handler. Re-running that `rtk init`
puts the file back; `bun run check` then reports it.

## The ai-badger hooks adapter: the project's gates, in pi

The adapter — canonical at `features/pi/adjustments/adapter/`, vendored into
ai-badger and installed to `~/.pi/agent/extensions/ai-badger/` — runs the
project's own Claude-shaped hooks inside a pi session. Every `PreToolUse` entry
in `.ai-badger/hooks/hooks.json` runs before the tool call and may block it;
every `PostToolUse` entry runs after the result and may add context to it. pi's
tool names are translated to Claude's (`bash` → `Bash`, `read` → `Read`,
`grep` → `Grep`, `find` → `Glob`), and the decision comes back as pi's
`{ block, reason }`.

### Memory first: text search

The memory-first gate (ai-badger's `memory_first_gate_hook.py`) answers a repo
text search with the memory result instead of blocking it. On the first
sighting of a pattern the gate runs the search itself and hands the hits to the
model as `additionalContext`; in pi the adapter delivers that as a custom
message with `display: false`, so the agent gets the data and the user sees
nothing. The gate's record is a `textSearchInput` array of `{pattern,
rawResultHash}` pairs — one entry per searched pattern, and a hash only where
the raw output was captured — plus the memory block. The same object is
appended as one line to
`~/.ai-badger/memory-first-search/searches.jsonl` (a private rolling log,
bounded to 1 MiB). For a shell grep the gate also starts the original command
in the background and keeps its raw output for about two minutes: the
`get-raw-text-search` skill fetches it with `--pattern-hash <hash>` (or
`--pattern <pattern>`), so the model can read the raw output without running
the search twice.

In pi the text-search tools are `grep` (file contents), `find` (file names) and
greps inside bash. The adapter maps them to Claude's `Grep`/`Glob`/`Bash`, which
is what the shipped gate's matcher covers — so the redirect works on pi's own
search tools, not only on shell greps. A native tool call has no background
capture (the capture re-runs a command, and a native tool call is not one):
the agent re-issues the call to get the raw output.

`read` is a file view, not a text search, and is deliberately not the gate's
subject: a read of a known path is not a query the bank can answer better than
the file itself.

The adapter also counts the gate's work for the footer: how many text searches the gate
answered, how many of them it captured raw output for, and how many of those raw results
the agent fetched back with the `get-raw-text-search` skill. The segment is
`[mem <searched> <pct>%]` — twelve searches whose ten captures were fetched back nine times
read `[mem 12 90%]`. The share is a percentage, not a fraction: a fraction (`9/10`) is a ratio
the reader has to divide, and a share with no captures (`0/0`) is a division by zero dressed
up as a number. A search the gate answered without a capture still counts: the capture
re-runs one literal shell grep, so a native search tool and a compound shell command answer
the search without one. A session in which the gate searched nothing shows no segment at all.

## Footer statuses

pi prints every extension status on one footer row, joined by a single space. Each extension
here writes its status as one bracketed segment, `[<name> <state> · <field> · <field>]`, so
neighbours stay apart:

| extension | example |
|---|---|
| pi-cron | `[cron jobs · pi 2/3 · system 1]` (each backend shown only when it has jobs) |
| session-signals | `[delegate · architect 1m32s · qa 7s]` |
| query-pipeline | `[query-pipeline · scoring 24 candidates · 2 batches]` |
| rtk | `[rtk ⇄proxy · cmd 62% · proxy 18%]` |
| ai-badger (memory gate) | `[mem 12 90%]` (searches · fetched share of the captures) |
