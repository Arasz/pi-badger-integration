# Report — bus delivery "broken", delegation skip, and the identity hole behind both

Date: 2026-09-08 · Investigator: pi session 01a08155 (ai-raccoon / cfe47dab) · Scope: `e:`-extended
mid-investigation to cover reply-to-sender tooling and session-id control.

Grades: **MEASURED** (ran the command, quote the output), **READ** (source/spec, path:line),
**INFERRED** (reasoned from evidence, hedged), **UNVERIFIED** (claimed, not checked).

---

## Part 1 — Findings

### F1 — Five direct messages are stranded at a dead session id · MEASURED

`c64f540b-b36a-400a-883e-27d3f88e8be6` was the 1:1 target of messages **#682, #683, #684**
(from adversarial reviewer 15f4b1a0) and **#687, #688** (from replacement agent 01a080a8 —
the owner's two diagnosis-redos reports). Verified in `~/.ai-badger/ai-badger.db`:

- `SELECT * FROM cursors WHERE session_id LIKE 'c64f%'` → **no row** (never consumed, never checked).
- No row in the `sessions` table; no live pi process matches (live set on 2026-09-08 ~14:30Z:
  98127/41778/40851 = 01a08155, 01a08098, 01a080a8). The session is **dead**.
- Consequence: the mail is unreachable now and unrecoverable later — a resumed session gets a
  fresh id, and even a first read on the old id would silently discard anything older than the
  30-minute first-read window (cursor lands past MAX).

### F2 — Root cause of F1: identity travels in prose, never on the wire · MEASURED + READ

Session 01a08098's transcript (`~/.pi/agent/sessions/--…-ai-raccoon--/2026-09-08T10-37-36-086Z_01a08098*.jsonl`)
contains a task-tracking entry `{"taskId": "air-mmr-diversity-rerank-implementation-plan", "state":
"STARTED", "sessionId": "c64f540b-…"}` — a **stale id binding from the dead orchestrator** — and
01a08098 then *presents that id as its own* in every announcement: "I am orchestrator session
c64f540b-b36a-400a-883e-27d3f88e8be6", "REPORT BACK: message-bus 1:1 send to session c64f540b-…"
(#685, #686 carried those instructions; recipients obeyed, and their mail stranded per F1).

The extension's actual wire identity (`resolveSessionId`, `extensions/message-bus/index.ts:143`) is
never shown to the agent unless it happens to be in prose. **Nothing in the tool surface lets an
agent reply to a message's sender without copying an id out of prose.**

### F3 — The send tool accepts undeliverable targets silently · MEASURED

- `#672` (2026-09-06): `target_project` is the literal string `$(cat /U…` — an unexpanded shell
  substitution stored verbatim, undeliverable by construction, send reported success.
- Any `send` with `sessionId=<dead-id>` succeeds ("sent N (direct)") with no warning that the id
  is unknown to the system. Write-only success is the F1 failure mode's API shape.

### F4 — Live-session delivery works; measured latencies · MEASURED (n=1 each, 2026-09-08)

Probes sent from this session (01a08155) to the two live TUI sessions in ai-raccoon:

| probe | send | consumed by target | ack/reply |
|---|---|---|---|
| #691 direct → 01a08098 | 14:27:07Z | 14:27:23Z (**~16 s**) | ack #692 + direct reply #693 by ~14:27:37 (**~30 s**) |
| #694 project bcast (cfe47dab) | ~14:29:12Z | 14:29:57Z (~45 s) | acks #695/#696 (~45–60 s) |
| #697 machine bcast | 14:30:55Z | 14:32:56Z (~2 min; all three cursors advanced within 100 ms of each other) | none requested |
| #698 self-direct | 14:30:55Z | **never** | **self-sends are excluded by the store's `sender_session <> ?` filter — "sent" is a silent no-op** |

Mechanism verified by reading: the ai-badger adapter (`features/pi/adjustments/adapter/index.ts:704-714`)
arms a 2 s per-session timer (tui/rpc + delivery script present + wake policy ≠ off), probes the
user-DB fingerprint (`bus-store.ts`), spawns `python3 .ai-badger/hooks/message_delivery_hook.py`
(present in all five projects — MEASURED), and wakes idle sessions `followUp + triggerTurn` for
addressed mail (`bus-prefilter.ts wakeRoute`). The ~2 min machine-broadcast latency is the prefilter's
60 s staleness re-probe plus tick alignment — **n=1, re-measure before optimizing** (INFERRED).

### F5 — The on-start change (3041231) created three silent-consumption modes · READ

`feat(message-bus): startup reads directs only behind user confirm gate (#5)`:

1. **First read ≥30 min old directs are silently discarded** (`deliverDirectForSession`: window +
   cap, cursor lands past MAX — python parity, but it is mail loss; F1's stranded mail would die
   here even if the id were resumed).
2. **A "no" on the startup confirm marks directs read without the agent ever seeing them** (by
   design, user-gated — but indistinguishable from "delivery broken" after the fact).
3. **Broadcasts are consumed silently on startup** (cursor past MAX) — a fresh session will never
   see project/machine mail that predates it; combined with F4's broadcast-only-no-wake-under-
   `addressed` routing, broadcasts are the weakest channel end to end.

### F6 — Delegation "skip": no bash-spawned pi found; the sanctioned fallback is the gap · MEASURED

Scanned the last 10 sessions (and looser patterns over ~22): **zero** bash invocations spawning a
`pi` task process. `delegate` is used heavily (6 calls in 01a08098, 6 in 01a07ce7, 1 in 01a07cba).
What the scan did find:

- **Sanctioned in-session fallback**: `features/common/skills/task/SKILL.md:154` — "If you cannot
  spawn subagents, work directly in-session. Note reduced rigor in your summary." No announcement
  obligation, no bus notification. Session 01a0735d declared exactly this after "6 pi re-dispatches
  failed (persona opus/sonnet unresolvable env-wide, fallback session race)"; 01a07352 recorded
  "subagent delegation down box-wide: opus/sonnet rejected, no bedrock key; 4 consecutive exit-1".
- **Backgrounded shell work** (`nohup bun run scripts/test-gate.ts … &`, `nohup git push … &`,
  `nohup bun publish.ts &`) — legitimate long-command backgrounding, *looks* like "task in the
  background using bash" in a live TUI. Also: the delegate runner itself spawns `pi` children via
  `node:child_process` (`delegation-runner.ts:16`) — a `ps` observation of that child can read as
  "pi spawned via bash" (INFERRED — matches the owner's observation better than agent misbehaviour).
- **No guard exists** that would notice or record an agent spawning `pi` through bash; the skip
  would be invisible by construction.

**Hypothesis (stated per the debug-issue discipline):** execution reaches "task ran without the
delegation extension" via the skill-sanctioned fallback path (delegate outage → SKILL.md:154 →
in-session work), not via agents hiding work in bash; the "pi in background via bash" observation
is the delegation runner's own child process or nohup'd shell gates. A specific recent change is
not implicated — the fallback language and the persona-pin failure mode both predate this week.

### F7 — Ack bodies echo the original's full text and read as live requests · MEASURED (post-report addendum)

The ack of the implementation task's review request (#701, a project broadcast) carried the
original request text after an `ack: ` prefix (`buildAckContent`, `message-bus-core.ts:79-85` —
truncation is a char cap, not a title). Project sibling 01a08098 consumed it (cursor=701 at
14:50:30.44Z) and within the same second sent a decline direct (#703): the echoed second-person
text ("you authored … please reply with feedback") reads like a live, addressed request to any
sibling without the sender's context. One wasted turn here; the same shape could make a sibling
act on an echoed work-request. Protocol note: "never reply to an ack" assumed acks are
recognizable — the wire format does not guarantee it.

---

## Part 2 — Plan (implementation, this repo)

Derived from F2/F3 (identity), F1 (dead targets), F3 (silent no-ops), F5 (startup semantics),
F6 (skip visibility). Ordered; each item is independently shippable and test-first in
`tests/message-bus/`.

### P1 — `reply` action: answer the sender, never a copied id (fixes F2's failure mode)

- `message-bus-core.ts`: pure `buildReplyTargets(original: BusMessage)` →
  `{ targetSession: original.senderSession, targetProject: original.senderProject }` (ack stays a
  project broadcast — protocol unchanged).
- `index.ts`: new `reply` action — `reply` + `id` + `content`; refuses when the original is the
  session's own send; result names the resolved target id explicitly (`replied to #N from <sid8>`).
- Tool description gains the rule: **"never copy a session id from message content — reply by id"**.
- Ack body becomes a stub (F7): `ack: #<id> (<title prefix>) — terminal, no reply expected`,
  never the original body. Tests: reply targets the original sender (direct); reply to own
  message refused; reply to unknown id errors; ack stub contains no request-shaped second-person
  body; ack path otherwise untouched.

### P2 — Identity surfacing: the agent must be able to know who it is (completes F2)

- `whoami` action returning session id + project id + cursor.
- `list`/`check` output carries a `you are <sid8> in project <pid8>` header line so every bus
  interaction re-anchors identity on the wire.
- Tests: output shapes pin the identity line; whoami resolves through the same deps seams.

### P3 — Loud, fail-open target validation (fixes F3; shrinks F1)

- Registry-lite: extension records its own session id at `session_start` into a new
  `bus_identities(session_id, project_id, ts)` table in the same user DB (writable; the store
  already opens RW). No adapter dependency, no sessions-table ownership change.
- `send`/`reply` with an explicit `sessionId` that has **no identity row** returns success *plus a
  warning in the tool result and `details`: "target unknown — never seen on this machine; prefer
  `reply id:<n>`". Never blocks (D31 fail-open); a machine-broadcast-style flood is impossible
  because the check only runs on direct targets.
- Validate target shape (reject whitespace/`$(`-bearing ids with an error before insert — #672).
- Self-send: warn "self-send is never deliverable (sender-exclusion filter)" in the result.
- Tests: unknown-id warning, shape rejection, self-send warning, identity upsert on start.

### P4 — Startup-gate semantics: make silent consumption visible (bounded fix for F5)

- The startup summary (`appendEntry`) already reports directs; extend it to state **what was
  silently consumed**: "n older directs and m broadcasts were marked read without delivery
  (30-min window / startup gate)". User-only, same entry, no LLM leak.
- Tests: summary text carries the consumed-counts when window/cap drop mail.

### P5 — Delegation-skip visibility (bounded fix for F6; cross-repo item noted)

- Small advisory guard in this repo (subagent extension `tool_call` or a standalone mini-extension):
  bash commands matching a `pi` spawn pattern notify "spawning pi directly — prefer `delegate`"
  (advisory only, never block; records the skip so it is no longer invisible).
- Cross-repo (ai-badger, not here — file a follow-up task): tighten `SKILL.md:154` to require a
  bus announcement on fallback ("cannot spawn subagents → announce on message-bus, then work
  in-session"), and chase the persona-pin silent-hang in router-fallback.

### Explicitly out of scope

- Push-wake redesign (F4 shows live delivery healthy), python-side store changes (P3's new table is
  created by the TS extension DDL, same pattern as `messages`/`cursors`), and any protocol change
  to ack semantics.

## Verification baseline for the implementation task

- `bun test tests/message-bus/` green before/after; new tests named per P1–P4.
- Live re-probe after P1–P3 ship: repeat the F4 matrix; machine-broadcast latency measured twice.
- The five stranded messages (F1) are **not** recoverable — recorded here as the accepted loss;
  P3 prevents the next occurrence.
