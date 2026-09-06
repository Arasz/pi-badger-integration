# Extension catalog

Deep reference for the extensions this repo ships. For install steps see [Install extensions](../howto/install-extensions.md).

## The mem-based-rag extension: memory-based prompt enrichment on the ai-raccoon bank

Substantive user prompts gain a labelled `Memory context:` block injected via
`before_agent_start` — top-3 memory snippets plus top-2 code snippets from
`memory_search`, each with its hash so the agent can `memory_get`/`code_get` the
full entry. The prompt itself is never rewritten: the `input` handler only
captures the raw pre-expansion text (so a `/skill:task <words>` call is queried
by `<words>`, never by expanded skill content), and enrichment arrives as a
separate message with its own card.

Skip list (filters, not a score floor, kill meaningless prompts): empty input,
single-token slash commands, control words (`stop`, `continue`, …), bare skill
calls, `<20` chars, and fewer than 8 unique words longer than 3 chars. Modes:
`default` (search snippets) and `expanded` (a `memory_get`/`code_get` per kept
hit, with path + chunk/line provenance, per-hit snippet fallback). Transport is
a persistent `ai-raccoon --transport stdio` child (pi extensions cannot invoke
MCP tools): spawn+init ~0.3 s amortized, first search ~4.5 s model warm-up,
steady ~0.4–0.5 s, every call timeout-bounded (default 8 s) and fail-open — a
slow or dead bank skips enrichment, never the turn. Agent memory is untouched:
same server, separate call site.

Config (env defaults, read per call; `/context` for session scope):
`PI_BADGER_MEM_RAG=0` disables, `PI_BADGER_MEM_RAG_MODE`
(default|expanded), `PI_BADGER_MEM_RAG_MIN_WORDS` (default 8),
`PI_BADGER_MEM_RAG_MIN_CHARS` (default 20),
`PI_BADGER_MEM_RAG_TIMEOUT_MS` (default 8000),
`PI_BADGER_MEM_RAG_SNIPPET_CHARS` (default 300). `/rag status`
reports enriched/skipped counts and the last reason; `/rag mode
default|expanded|off` overrides for the session.

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
arrive on their own — **never poll** for them (repeated `delegations list`/`log` polling is
blocked by the monitor's enforcement). To keep a strict order, queue work with the
**`queue` tool**: `add` (serial group — members run one at a time, in order),
`add-parallel` (members run concurrently once they all fit), `clear` (cancel every queued
task; running ones untouched), `list` (the queued groups with live positions). The whole
queue tool is TUI-only. The `background` parameter is gone — mode alone decides: the TUI
always backgrounds with a receipt, and a stale `background` key replayed from an old session
is stripped before schema validation. Ordering, idle waiting, and stopping runs work as above
(`queue`, the monitor extension's `wait` tool, `delegations abort`). Every delegation enters the queue as a
one-element serial group — on an idle system it starts immediately, otherwise it waits its
turn behind a blocked queue head (cap full, a mid-flight serial group, or a parallel group that cannot use a slot); the queue is the only admission path. In headless modes (`-p`, json, rpc) delegation stays **blocking** — the result
is the tool result, byte-compatible with the pre-background contract, plus `details.usage`;
there is no background opt-in to degrade, so the result carries no `degraded` key and no
degrade line. There is no automatic wall-clock timeout: runs
are unbounded unless the `delegate` call passes `timeoutMs` (clamped to 1 s–24 h; on expiry
the run is aborted and settles as `aborted (timeout)`). The inactivity watchdog is
automatic: a child that emits no stream events for 10 minutes (default) is aborted and
settles as `aborted (lost)`.

Checking on delegations:

- **`delegations` tool** (LLM-facing): `list` (state, elapsed, current activity, usage),
  `log <id>` (bounded tail + full path), `abort <id|all>`, `results [id]` (the cached
  structured result — `{parent_id, delegation_id, task_summary, persona, input, output,
  timestamp}` — of one delegation, or, without an id, every result this session parented;
  an in-memory cache of the LAST 8 results that dies with the session). Results also
  arrive on their own — never poll: to spend idle waiting time, use the monitor
  extension's `wait` tool (user input interrupts it) or register a monitor.
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
| 1 | OpenRouter (`openrouter`) | `z-ai/glm-5.2:free` → `poolside/laguna-s-2.1:free` → `minimax/minimax-m3:free` → `thinkingmachines/inkling-small:free` | `OPENROUTER_API_KEY` | first — one-key breadth (owner order 2026-09-06; `:free` is burst-only ≈50 req/day without credits, so heavy fallback days burn this budget first and fall through below) |
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

Verification notes: pi 0.84.4 (repo pin) vs 0.85.1 (installed) shapes re-verified
identical (`setModel` false-on-missing-auth, `{messages}`-only `agent_end`,
`model_select{source:"set"}`); the keyless custom-overlay path passes pi's own
`validateExtensionProvider` offline; the pinned `:free` chain was confirmed present on
the live OpenRouter roster 2026-09-05. No valid provider key exists in this environment
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
  read as unset). Sender identity is mandatory: the session manager's id plus
  the nearest `.ai-badger/project-id` above the session cwd
  (`AI_BADGER_PROJECT_ID` wins).
- `list` renders the inbox grouped by scope — direct (1:1), project
  broadcast, machine broadcast — last 3 per group, rows marked received (✓)
  or new (●). Never raw JSON; the same text backs the delivery card
  (`message-bus-event` via `registerMessageRenderer`).
- `check` delivers new mail now (cursor advances exactly-once; first read has
  the 30-minute gate + 16-cap and lands past `MAX(id)`).
- `ack id` sends `ack: <original>` once as a project broadcast; acking an ack
  or a message outside your inbox refuses.
- Hooks on `session_start` (wakes with a card when mail is waiting) and
  `turn_start` (quiet context for the starting turn). The idle-session wake
  stays with the adapter's poll timer — these hooks never arm their own.
  `PI_BADGER_MESSAGE_BUS=0` disables the hooks; tools stay. Every backend
  failure is fail-open: an error result, a command notify, or a silent hook
  skip — a broken bus never breaks a session, and a missing DB file is never
  created as a side effect.


## The pi-mcp-tools extension: human cards, never raw JSON

Every MCP tool result is an `ApiEnvelope` serialized as JSON text, and the
`mcp_list_servers` payload is a JSON blob too — without renderers both show
as raw JSON dumps. `extensions/pi-mcp-tools/McpCardRenderers.ts` attaches a
`renderCall`/`renderResult` card to every registered tool instead:

- Collapsed: a one-line human summary with zero JSON tokens (`memory_search:
  5 hits (3 memory, 2 code)`, `memory_write: stored abc123… — notes.md`).
  The `mcp_list_servers` card collapses the merge ledger the same way
  (`MCP 1/2 connected: ✓ hermes — project:.mcp.json · ✗ dead — global
  settings`). Never raw JSON — the same rule as the message-bus delivery card.
- Expanded: the key fields (the collapsed line) plus the full JSON trimmed to
  ~4 KB with a visible `[+N chars trimmed]` marker.
- Fail-open: garbage, truncated JSON, `data: null`, missing content, and the
  adapter's own non-envelope strings (`Tool call cancelled`, `not connected`,
  `MCP Error: …`, `No content returned`, `[image/resource content received]`,
  `[Unserializable data]`) all render the generic fallback and never throw.

Cards key on the BARE MCP tool name (`memory_search`, never the prefixed
`mcp_ai-raccoon_memory_search`) — the prefix is configurable per server, so
the adapter closes over the bare name at registration time and a custom
`toolPrefix` cannot break dispatch. The descriptor table covers all 29
ai-raccoon tools plus `mcp_list_servers`; unknown names get the fallback.
`execute`/`content`/`details` are byte-identical — rendering never touches
the tool result, only how it displays.
