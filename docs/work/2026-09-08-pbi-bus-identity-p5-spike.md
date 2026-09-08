# Spike report — P5 delegation-skip advisory guard seam (pbi-bus-identity-delegation-skip-fix)

Date: 2026-09-08 · Session: 01a08155 · Worktree: `pbi-bus-identity-delegation-skip-fix-p5`
(spike branch `task/pbi-bus-identity-delegation-skip-fix-p5-spike`, base `453bfc8`) ·
Scope: spike only — NO implementation. Read-only on implementation files; this report is
the single file written.

Question from report F6 (`docs/work/2026-09-08-bus-identity-and-delegation-skip-report.md`):
plan-review (d-611/d-612/d-613) ruled PKG-5 / P5 a wish until a spike quotes the payload.
P5 proposes an advisory guard — bash commands matching a `pi`-spawn pattern notify
"spawning pi directly — prefer `delegate`" (advisory only, never block) and record the skip.
This spike proves or disproves the seam, measures the pattern's precision, and specifies
the guard so tests become writable. Abort criterion was: if `pi.on("tool_call")` does not
exist in this repo's pi API, stop and report DEFER. It exists — three in-repo precedents
plus the pi-core emission site plus a live firing through pi's real dispatch code.

Grades: **MEASURED** (ran it, pasted output), **READ** (source, path:line), **INFERRED**
(reasoned, hedged). Scratch scripts lived in `/tmp/p5-spike/` (outside the worktree —
no repo files touched); their outputs are pasted verbatim below.

---

## AC1 — Hook payload quoted from a REAL firing

### AC1a. The seam exists in this repo's pi API (READ + MEASURED)

pi-coding-agent 0.84.4 (pinned in root `package.json:14`; `@earendil-works/pi-coding-agent": "*"`
in `extensions/subagent/package.json:9`):

- Type declaration (bun cache `dist/core/extensions/types.d.ts:939`):
  `on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void`
  — so the abort criterion is NOT met; the spike proceeds.
- `BashToolCallEvent` (`types.d.ts:677-680`): `{ type: "tool_call"; toolName: "bash";
  toolCallId: string; input: BashToolInput }`. `BashToolInput` (`dist/core/tools/bash.d.ts:14`,
  schema `bash.js:30-33`): `{ command: string; timeout?: number }`.
- The built-in shell tool is literally named `"bash"` (`dist/core/tools/bash.js:390`
  `name: "bash"`) — not `exec`, not `run_command`. Field path of the command string:
  **`event.input.command`**.
- `ToolCallEventResult` (`types.d.ts:818-827`): `{ block?: boolean; reason?: string;
  terminate?: boolean }` — advisory-only proof shape: a handler that returns `undefined`
  lets the tool run; only a truthy `{ block: true }` stops it.
- In-repo precedents (all three cited files use the seam):
  `extensions/session-signals/index.ts:163` (`pi.on("tool_call", …)` watching
  delegation tool names), `extensions/monitor/index.ts:873` (`pi.on("tool_call", …)`
  with the `block:true` shell-guard pattern at :882 and the bash/powershell command
  extractor `shellCommandOf` at :857-858 matching `/^(bash|powershell)$/i` on
  `event.toolName` and reading `event.input.command`),
  `extensions/subagent/delegation-status.ts:539` (`pi.on("tool_call", …)` watching
  the `delegate` tool).

### AC1b. Real emission site (READ — pi core, not this repo's tests)

`dist/core/agent-session.js:224-237` (`_installAgentToolHooks`, `beforeToolCall`):

```js
return await runner.emitToolCall({
    type: "tool_call",
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    input: args,
});
```

So for a bash invocation the wire payload is exactly
`{ type: "tool_call", toolName: "bash", toolCallId: "<id>", input: { command: "<shell>" } }`.
Two further READ facts from the same site: `emitToolCall` (`runner.js:745-763`) iterates
extensions × handlers and **the first truthy `{ block: true }` wins** — every handler runs
until one blocks; and the `catch` in `beforeToolCall` **rethrows handler errors**
(`throw new Error("Extension failed, blocking execution: …")`) — i.e. a THROWING
`tool_call` handler blocks the tool call. The advisory guard MUST therefore be fail-open
(try/catch around notify+record, never throw) — this is load-bearing, not stylistic.

### AC1c. REAL firing through pi's actual dispatch code (MEASURED)

`/tmp/p5-spike/real-fire.mjs` (scratch, outside repo) imported the REAL
`ExtensionRunner` from the installed 0.84.4 package, mounted a probe extension, and fired
`emitToolCall` with the payload built verbatim per AC1b. Verbatim output (`bun`, plus
unrelated highlight.js deprecation warnings elided):

```
advisory result (expect undefined): undefined
handler saw payload: {"type":"tool_call","toolName":"bash","toolCallId":"call_scratch1","input":{"command":"nohup pi run --task hi &"}}
blocking result (expect block:true): {"block":true,"reason":"nope"}
hasHandlers(tool_call): true
```

Proven: (1) event name `"tool_call"`; (2) bash toolName `"bash"`; (3) command string at
`input.command`; (4) an advisory handler returning `undefined` lets the tool run while a
`{ block: true }` result blocks — the exact contract the P5 guard relies on.

### AC1d. No self-trigger from the delegation runner itself (READ)

`extensions/subagent/delegation-runner.ts:16` spawns pi children via
`node:child_process` (`import { spawn as nodeSpawn } from "node:child_process"`).
Runner-spawned pi children never pass through the `bash` TOOL, so they never emit a
bash `tool_call` event — the guard cannot nag about the runner's own children, and a
`ps` observation of those children (F6's INFERRED reading of the owner's "pi in
background via bash" sighting) stays out of scope by construction.

**AC1 verdict: seam PROVEN.** Event `tool_call`; `toolName === "bash"` (also
`"powershell"`, same `input.command` shape); payload
`{ type, toolName, toolCallId, input: { command } }`.

---

## AC2 — Proposed pi-spawn regex + true/false-positive matrix (MEASURED, 33/33)

House pattern to mirror: `SHELL_WAIT_COMMAND` in `extensions/monitor/monitor-core.ts`
(command word at a command boundary + optional `VAR=x` env prefixes + strict trailing
boundary; pins `cat sleep` / `npm run sleep-test` silent — the same discipline P5 needs
for `pip` / `publish.ts`).

Proposed pure predicate (name/shape mirror `manualWaitDecision`):

```ts
const PI_SPAWN_COMMAND =
  /(?:^|[;|&()\n{}`!]|\b(?:elif|else|then|do|while|until|for|if|in)\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|nohup|npx|bunx|uvx|timeout\s+\S+)\s+)*(?:[\w.+-]*\/)*pi(?:[^\w-]|$)/;

export type PiSpawnDecision = { readonly action: "notify" } | { readonly action: "silent" };
export function piSpawnDecision(command: string | undefined): PiSpawnDecision {
  if (command === undefined || command.trim() === "") return { action: "silent" };
  return PI_SPAWN_COMMAND.test(command) ? { action: "notify" } : { action: "silent" };
}
```

Design notes: command-position matching (deliberately NOT bare-token matching, so
`echo pi` / `grep pi README.md` / `pip install pi` stay silent); optional env-prefix,
`sudo`/`nohup`/`npx`/`bunx`/`uvx`/`timeout <arg>` runner prefixes, and multi-segment
path prefixes (`./pi`, `/usr/local/bin/pi`); trailing `[^\w-]` so `pip`/`pi3`/`my-pi`
are silent while `pi run`, `pi;`, `pi&`, `pi)` fire. Case-sensitive (`PI run` silent —
unix binary is lowercase). Powershell shares the predicate (`pi run` / `pi.exe run`
tokenise identically; the `.` in `pi.exe` satisfies the trailing boundary).

Matrix run (`/tmp/p5-spike/matrix.mjs`, `bun` — all rows passed after one measured
iteration: the first draft used a single-segment path prefix and missed
`/usr/local/bin/pi`; widening to `(?:[\w.+-]*\/)*` fixed it with no negative regressions):

| command | verdict | result |
|---|---|---|
| `pi run --task 'x'` | MUST detect | DETECT |
| `pi --help` | MUST detect | DETECT |
| `pi` | MUST detect | DETECT |
| `nohup pi run --task hi &` | MUST detect | DETECT |
| `nohup pi &` | MUST detect | DETECT |
| `a && pi run --task x` | MUST detect | DETECT |
| `VAR=x pi run` | MUST detect | DETECT |
| `npx pi run --task x` | MUST detect | DETECT |
| `./pi run` | MUST detect | DETECT |
| `/usr/local/bin/pi --help` | MUST detect | DETECT |
| `sudo pi run` | MUST detect | DETECT |
| `if true; then pi run; fi` | MUST detect | DETECT |
| `$(pi run)` | MUST detect | DETECT |
| ``timeout 60 pi run --task x`` | MUST detect | DETECT |
| `FOO=1⏎pi run` (newline) | MUST detect | DETECT |
| `pip install requests` | MUST NOT fire | silent |
| `pip install pi` | MUST NOT fire | silent |
| `happy` / `echo happy` | MUST NOT fire | silent ×2 |
| `spin up` / `cat spin` | MUST NOT fire | silent ×2 |
| `bun publish.ts` | MUST NOT fire | silent |
| `nohup bun publish.ts &` | MUST NOT fire | silent |
| `nohup bun run scripts/test-gate.ts &` | MUST NOT fire | silent |
| `nohup git push &` | MUST NOT fire | silent |
| `npm run sleep-test` / `sleep 30` | MUST NOT fire | silent ×2 |
| `echo pi` | MUST NOT fire (arg-position, by design) | silent |
| `grep pi README.md` | MUST NOT fire (arg-position, by design) | silent |
| `echo "pi run"` | MUST NOT fire (quoted prose) | silent |
| `my-pi run` / `pi3 run` / `PI run` | MUST NOT fire | silent ×3 |

Score: **15/15 positives, 18/18 negatives (33/33)**. Every F6 legitimate line from the
report (`nohup bun run scripts/test-gate.ts`, `nohup git push`, `nohup bun publish.ts`,
plus `pip`/`happy`/`spin`/`publish.ts` near-misses) is silent.

Known residual limitations (documented, advisory-tolerable — the guard never blocks):
`xargs pi …` and `command pi …` are silent (pi in argument position — same conservative
trade-off as `echo pi`); `PI` uppercase silent; `sh -c "pi run"` silent (quoted).
None appears in the F6 evidence; each is one matrix row if the implementer wants it.

**AC2 verdict: pattern PROVEN with measured precision (33/33).**

---

## AC3 — File target + registration + notify/record surface + advisory-only proof shape

- **New file (exact path): `extensions/subagent/delegation-skip-guard.ts`** — pure
  `piSpawnDecision` + `PI_SPAWN_COMMAND` (named export for tests) + a thin
  `registerDelegationSkipGuard(pi)` factory that wires `pi.on("tool_call", …)`.
  NOT a mini-extension dir: per derive-or-delete, a new dir under `extensions/`
  would require an `EXTENSION_DIRS` entry to ship at all.
- **Registration — NO `publish.ts` change.** `publish.ts:70`
  (`const EXTENSION_DIRS = [ … "subagent", … ]`) already ships the whole `subagent`
  directory via `directoryTarget("subagent")`; a new module inside it ships
  automatically. Registration text is one line in the existing factory
  (`extensions/subagent/index.ts:761`
  `export default function (pi: ExtensionAPI, deps: SubagentDeps = {})`), beside the
  sibling surfaces (`registerDelegationStatus(pi, registry, …)` at :984,
  `registerDelegationQueue(…)` at :1026):
  ```ts
  registerDelegationSkipGuard(pi);
  ```
  Env kill-switch shape follows house precedent (`PI_BADGER_WAIT_GUARD` /
  `PI_BADGER_MONITOR_POLL_MAX` in monitor; `PI_BADGER_DELEGATION_TOOLS` in
  session-signals): read per call, `"0"` disables, unset/invalid → enabled.
- **Notify surface:** `ctx.ui.notify("ai-badger: spawning pi directly — prefer
  \`delegate\` (this notice is advisory; the command still runs)", "warning")`,
  guarded by `ctx.hasUI` (session-signals precedent; the real ctx gates `ui` behind
  `assertActive`, and headless sessions have no UI). Fires on the `tool_call` event
  (pre-execution) so the nudge lands before the spawn, exactly like the monitor's
  wait-guard redirect.
- **Record sink:** `pi.appendEntry("delegation-skip", { command, toolCallId, ts })`
  — the house record surface (`pi.appendEntry(RECONSTRUCTION_ENTRY_TYPE, …)` at
  `extensions/subagent/index.ts:960`; monitor's `pi.appendEntry(SHUTDOWN_ENTRY_TYPE,
  …)`). A custom entry type keeps the skip queryable in the session transcript; no
  new DB table, no adapter dependency, no protocol change.
- **Advisory-only proof shape (two halves, both pinned by tests in AC4):**
  (a) the handler returns `undefined` on EVERY path — match path (after
  notify+record) and non-match path alike — never `{ block: true }` (real-dispatch
  proof in AC1c: `undefined` → tool runs); (b) fail-open: the notify+record block is
  wrapped in try/catch that swallows (a throwing `tool_call` handler BLOCKS the tool
  per AC1b's `beforeToolCall` catch — so an unguarded recorder would convert an
  advisory guard into a blocking one on any `appendEntry`/UI failure).

**AC3 verdict: fully specified — file, registration line, surfaces, and proof shape.**

---

## AC4 — Owning suite path + 5 test stubs (no implementation)

**Suite path: `tests/subagent/delegation-skip-guard.test.ts` (new file).**
Confirmed: the guard lives in the subagent extension, so `tests/subagent/` owns it;
today that dir holds only `tests/subagent/subagent.test.ts` (229 lines, pure-logic
tests over `extensions/subagent/index.ts`). `tests/message-bus/` is the WRONG layer
(P1–P4 territory; the guard never touches the bus). Wiring-test shape mirrors
`tests/monitor/wait-guard.test.ts` (fake-pi `fireToolCall(pi, "bash", { command })`
through handler arrays) and `tests/helpers/fake-pi.ts` (`createFakePi`).

Stubs (names carry the acceptance criterion; pure-decision rows go through the
exported `piSpawnDecision`, wiring rows through `fireToolCall` on a fake pi with a
recording `ui.notify` / `appendEntry`):

1. `D-S1 positives notify+record+undefined` — for each of `pi run --task x`,
   `nohup pi … &`, `/usr/local/bin/pi --help`, `npx pi run`: `fireToolCall(pi,
   "bash", { command })` returns `undefined` AND `notify` got the
   "prefer `delegate`" warning AND `appendEntry` got `"delegation-skip"` with the
   command. (Behaviour radius: asserts the secondary observables, not just the
   return.)
2. `D-S2 near-miss negatives stay silent` — property-intersection rows:
   `pip install requests`, `nohup bun run scripts/test-gate.ts &`,
   `nohup git push &`, `nohup bun publish.ts &`, `happy`, `spin up`,
   `my-pi run`: result `undefined` AND `notify`/`appendEntry` NOT called. (Pins the
   AC2 matrix at the wiring level, including the F6 legitimate lines.)
3. `D-S3 firing path is advisory-only (mutation: block-the-call)` — force the
   notify path (stub `ui.notify` to throw is D-S5; here simply fire on
   `pi run …`) and assert the tool still runs (handler result `undefined`, no
   `{ block: true }` anywhere in handler results). Kills the mutant "guard blocks
   the spawn". (This is the AC3 proof-shape half (a).)
4. `D-S4 non-shell tools and non-string commands never reach the predicate` —
   `fireToolCall(pi, "delegations", { action: "list" })`, `fireToolCall(pi, "read",
   { path: "pi" })`, and `bash` with `{}` / `{ command: 42 }`: all `undefined`,
   no notify/record. (Guards the `input.command` field-path assumption from AC1.)
5. `D-S5 recorder/notify failure fails open` — `ui.notify` throws AND
   `appendEntry` throws on `pi run …`: handler still returns `undefined` (tool
   runs, no exception escapes — the AC1b rethrow finding made test-first).
   Plus the env kill-switch row (`PI_BADGER_DELEGATION_SKIP_GUARD=0` → `pi run …`
   silent) folded into this stub file as the sixth row.

**AC4 verdict: suite placed, 5 (+1 kill-switch) stubs specified; implementation untouched.**

---

## AC5 — Verdict: IMPLEMENTABLE

| AC | question | evidence | result |
|---|---|---|---|
| 1 | seam exists, payload quotable | real `ExtensionRunner.emitToolCall` firing pasted (§AC1c) + emission site `agent-session.js:224-237` + `types.d.ts:939` + 3 in-repo precedents | PROVEN |
| 2 | pattern precision | 33-row matrix, 15/15 + 18/18, all F6 lines silent | PROVEN |
| 3 | file + registration + surfaces + advisory proof | `extensions/subagent/delegation-skip-guard.ts`, 1-line registration at `index.ts:761` factory, `ctx.ui.notify` + `pi.appendEntry`, `undefined` + try/catch | SPECIFIED |
| 4 | suite + stubs | `tests/subagent/delegation-skip-guard.test.ts`, 5 stubs | SPECIFIED |
| 5 | implement or defer | — | **IMPLEMENTABLE** |

**Verdict: IMPLEMENTABLE** — the seam (`pi.on("tool_call")`, `BashToolCallEvent`
`{ type, toolName: "bash", toolCallId, input: { command } }`) and the pattern
(33/33 measured) are both proven, so tests are writable today per the stubs above.

Two honest caveats travel with the verdict (neither demotes it to DEFER):

1. **Base rate is zero.** F6 measured zero bash-spawned pi over ~22 sessions — the
   guard is a tripwire that will most likely never fire, and the observed "pi via
   bash" sighting is INFERRED to be the runner's own `node:child_process` children
   (§AC1d, out of the guard's reach by design). Its value is making the NEXT skip
   visible, not catching an ongoing behaviour. Cost is one module + one test file,
   advisory-only, kill-switched — proportionate to a tripwire.
2. **The guard does not fix the sanctioned fallback.** F6's actual gap is
   `SKILL.md:154` (other repo, out of scope) permitting silent in-session fallback
   with no announcement obligation. Cross-repo follow-up text for that repo:
   > "Tighten `features/common/skills/task/SKILL.md:154` (fallback: 'cannot spawn
   > subagents → work directly in-session') to require a message-bus announcement
   > before falling back (1:1 to the orchestrator or project broadcast: delegation
   > unavailable, reason, working in-session), and chase the router-fallback
   > persona-pin silent-hang that forces the fallback path."
   The P5 guard and this follow-up are complementary (one watches undeclared
   `pi`-via-bash spawns here; the other closes the sanctioned silent path there) —
   P5 must NOT be folded out: the seam is real and the spec is complete.

Recommended implementation order (for the implementing task, not this spike):
pure `piSpawnDecision` + matrix tests first (no mocking), then
`registerDelegationSkipGuard` wiring over fake-pi (leaf → mid-layer per pipeline
discipline), then publish `--check` to confirm the new module ships under the
existing `subagent` target with zero `publish.ts` drift.
