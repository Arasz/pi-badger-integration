# Research: project-local delegation ids, /delegations completion fix, extension console capture

Date: 2026-09-22. Task: `pbi-project-local-ids-console-hygiene` (worktree
`.ai-badger/worktrees/pbi-project-local-ids-console-hygiene`).

Requested by the user, three items:

1. Make the delegation id project-local; if a global id is needed, add a second one as a
   GUID v7 that can be queried by the local id.
2. Autocompletion is broken: `/delegations log {id}` → pressing Tab replaces `log` with the id.
3. Debug logs / errors from extensions leak into the TUI input; eliminate that.

Grades: **MEASURED** = ran it / read the exact line; **READ** = read source/docs (not executed);
**INFERRED** = reasoned, unverified; **UNVERIFIED** = hypothesis.

---

## F1 — Current delegation-id scheme is machine-global (MEASURED)

- `extensions/subagent/delegation-core.ts:826-853` — `RUN_ID_PATTERN = /^d-(\d+)$/`,
  `RUN_ID_PREFIX = "d-"`, and `allocateRunId(existing, exists?)` scans a list of log
  filenames and returns `d-<highest+1>` skipping taken ids.
- `extensions/subagent/index.ts:931-947` — the live allocator closure lists
  `readdirSync(logDir)` (flat `*.jsonl`), excludes live registry records and
  `allocatedIds`, and calls `allocateRunId`. Comment says "T73: ids allocate over the LIVE
  log dir listing, past the highest id ever seen — a restarted session never reuses an id".
- `extensions/subagent/index.ts:179` — `DEFAULT_LOG_DIR = join(homedir(), ".pi", "agent", "subagent-logs")`.
- `extensions/subagent/index.ts:890-902` — `logSink` writes `<logDir>/<id>.jsonl`.
- `extensions/subagent/index.ts:674-712` — `reconstructFromLogDir(logDir, now)` scans that
  flat dir; `session_start` (line ~952) reconstructs every project's runs into this
  session's status surfaces. That is the observed pain: ids grow machine-wide
  (live evidence: `~/.pi/agent/subagent-logs/d-1359.jsonl` exists, docs/work/2026-09-21-...),
  and a session sees other projects' runs.
- `DelegationRecord` (`delegation-core.ts:152-183`) has no global id field.
- Receipt/blocking details (`index.ts:463-495`) expose only `id`.

## F2 — Log dir is overridable in tests only (MEASURED)

- `SubagentDeps.logDir` (`index.ts:457-458`) is the test seam; production uses
  `DEFAULT_LOG_DIR`. Tests pass temp dirs (`tests/monitor/monitor-extension.test.ts:98`
  comment "never the real ~/.pi/agent/subagent-logs").
- The extension factory is `export default function (pi, deps = {})` (`index.ts:775`); pi
  calls it without deps. `process.cwd()` is available at factory time.

## F3 — pi's argument-completion contract: `value` replaces the WHOLE argument text (MEASURED)

Read from the shipped bundle `@earendil-works/pi-coding-agent@0.84.4`
(`node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OMWWHBTG.js`,
class `CombinedAutocompleteProvider`):

- `getSuggestions(...)`: for `/command args...` it computes
  `argumentText = textBeforeCursor.slice(spaceIndex + 1)`, calls
  `command.getArgumentCompletions(argumentText)` and returns `{ items, prefix: argumentText }`.
- `applyCompletion(...)`: `beforePrefix = currentLine.slice(0, cursorCol - prefix.length)`,
  then `newLine = beforePrefix + item.value + afterCursor`.

Consequence (MEASURED by reading both): when the argument text is `log d` and an item
returns `value: "d-3"`, the result is `/delegations d-3` — `log` is replaced. This is exactly
the user's report. The fix is that every completion item's `value` must be the **full argument
text** for the position (`log d-3`), not just the token.

- `extensions/subagent/delegation-status.ts:608-628` — id branch returns `{ value: record.id, ... }`
  for prefixes `log|abort|peek`. BUG.
- `extensions/monitor/index.ts:1156-1170` — cancel branch returns `{ value: view.id, ... }`.
  Same class of bug.
- All other extension completions only offer first-token verbs (`value: verb`), which is
  correct: prefix is the whole argument text and `replace verb-prefix with verb` works.
- Existing tests assert the buggy values and must change:
  `tests/subagent-status.test.ts:759-780` (`ids.map(value) === ["d-2","d-0"]`),
  `tests/monitor/monitor-extension.test.ts:590-597` (`{ value: "m-1", ... }`).

## F4 — Console leak mechanism (READ + INFERRED)

- pi does **not** patch `console.*` in TUI mode. In RPC mode only, `takeOverStdout()`
  reroutes `process.stdout.write` to stderr (bundle, `function takeOverStdout`), so JSON-RPC
  integrity is protected there; TUI mode has no equivalent.
- `InteractiveMode.init()` starts the TUI at
  `dist/modes/interactive/interactive-mode.js:698` (`this.ui.start()`), then binds
  extensions later at `interactive-mode.js:1451` (`await this.session.bindExtensions({...})`).
  Therefore every `console.*` from an extension at load time, `session_start`, or later is
  written while the TUI owns the terminal (INFERRED from that order: raw stderr/stdout writes
  interleave with the renderer, which is what surfaces inside the input area).
- pi's own pre-TUI `console.log` (`interactive-mode.js:660`, "Model scope:") happens before
  `ui.start()`, so it is not part of the leak.
- pi's `uncaughtCrash` (`interactive-mode.js:3272-3281`) stops the UI, then calls
  `console.error("pi exiting due to uncaughtException:")` + `console.error(error)` before
  `process.exit(1)`. Any global console patch must not swallow those two calls.
- Extension errors thrown through pi's runner are rendered by the TUI itself
  (`interactive-mode.js:1513-1515` → `showExtensionError`), not by console.
- Existing console call sites in this repo: 49 across 11 extensions (counted with grep).
  Hot ones: `extensions/subagent/index.ts:951` (every `session_start`),
  `extensions/pi-mcp-tools/ConfigLoader.ts:139` (untrusted-project warning, every session),
  `extensions/message-bus/index.ts` (18 fail-open `console.error` lines).
- Precedent in-repo: `extensions/session-signals/silence-vertex-debug.ts` already
  monkey-patches `console.debug/warn/error` to drop known Vertex SDK chatter "to prevent
  Vertex AI debug chatter from corrupting Pi's interactive prompt" (its own header), and
  `setBackend(null)`s `google-logging-utils`. `session-signals` is installed to user scope
  (MEASURED: `~/.pi/agent/extensions/session-signals/` exists).

## F5 — Project identity sources (MEASURED)

- `extensions/message-bus/index.ts:177-197` — `resolveProjectId(cwd, env)`:
  `AI_BADGER_PROJECT_ID` env override, else walk up from cwd to the nearest `.ai-badger/`;
  that dir's `project-id` file wins; a `.ai-badger` without the file returns null and stops
  the walk.
- `.ai-badger/project-id` exists in this repo: `50a8bb05-4ba6-4002-94be-f8988ecc3b58`
  (UUID v4-shaped, READ).
- The subagent extension must also work in projects **without** `.ai-badger` (it is a
  user-scope extension; personas come from `<cwd>/.pi/agents`), so a fallback key is required:
  nearest `.git` root else cwd (INFERRED design choice, not user-stated).

## F6 — GUID v7 availability (MEASURED)

- Node in this environment is v26.9.0 and `require("node:crypto").randomUUIDv7` is a function
  (MEASURED by running node). pi's minimum Node may be lower; `@types/node` here declares
  `randomUUIDv7`. A ~10-line local implementation (timestamp + `randomBytes`, version/variant
  bits) removes the version dependency and is testable; either is acceptable — decide in plan.

## F7 — Test surfaces (MEASURED)

- `bun run test` = `bun test`; typecheck = `bunx tsc --noEmit -p .` (`package.json`).
- Relevant suites: `tests/delegation-core.test.ts` (T53 `allocateRunId`, line 568),
  `tests/subagent-status.test.ts` (completions at 759), `tests/subagent-extension.test.ts`,
  `tests/monitor/monitor-extension.test.ts` (completions at ~583),
  `tests/session-signals/silence-vertex-debug.test.ts`.
- `tests/setup.ts` exists at the tests root; helpers in `tests/helpers/` (`fake-pi.ts`,
  `fake-child.ts`).
- Publish/install: `bun publish.ts` copies each extension dir to
  `~/.pi/agent/extensions/<name>/`; `bun publish.ts --check` is the drift gate
  (`publish.ts` header). Past tasks end by publishing and reporting `--check` in sync.

## Open design questions (recommendations in brackets)

- **D1 project key**: `.ai-badger/project-id` when present, else `p-<sha256(root).slice(0,12)>`?
  [yes; walk `.ai-badger` → `.git` → cwd, mirroring `resolveProjectId`]
- **D2 log layout**: `<DEFAULT_LOG_DIR>/projects/<key>/d-N.jsonl` + global index
  `<DEFAULT_LOG_DIR>/index.jsonl`. [yes]
- **D3 global index**: written per run so `resolve <guid>` works across projects; entry
  `{globalId, id, projectKey, projectRoot, logFile, at}`; written at allocation or at log
  sink creation (avoids entries for rejected runs)? [decide: sink creation is cleaner]
- **D4 surface**: expose `globalId` on the record + run header; add `delegations resolve
  <d-N|guid>` (tool action + `/delegations resolve`) and print `global id:` in `log` output.
  [yes — without a queryable surface the global id is dead weight]
- **D5 legacy flat logs**: leave them untouched; new sessions no longer see them.
  [yes; document]
- **D6 console capture host**: `session-signals` (already patches console for Vertex).
  [yes, unless review prefers a dedicated extension]
- **D7 capture gate**: activate only when `ctx.mode === "tui"` at `session_start`; pass
  through otherwise; env kill-switch `PI_BADGER_CONSOLE_CAPTURE=0`; log file
  `<getAgentDir()>/badger-console.log`; size-capped rotation. [yes]
- **D8 fatal carve-out**: pass through pi's `uncaughtException` console pair. [yes]