# Plan: project-local delegation ids, `/delegations` completion fix, extension console capture

Date: 2026-09-22. Task: `pbi-project-local-ids-console-hygiene`.
Input: `docs/plans/2026-09-22-project-local-ids-console-hygiene.research.md` (all F1–F7 facts
and line anchors below are from that record or re-read in this worktree).
Status: ready to implement; no code changed by this plan.

## 1. Final decisions (D1–D8)

- **D1 project key** — `.ai-badger/project-id` when present, else `p-<sha256(root).slice(0,12)>`;
  walk `.ai-badger` → `.git` → cwd, honour `AI_BADGER_PROJECT_ID` first, sanitize to
  `[A-Za-z0-9._-]`. Why: mirrors the message-bus resolver, works in projects without ai-badger.
- **D2 log layout** — `<logDir>/projects/<key>/d-N.jsonl`; index at `<logDir>/index.jsonl`.
  Why: one base dir, per-project namespaces, existing `logDir` test seam still the base.
- **D3 global index** — written **at log-sink creation** (the run actually starts), not at
  allocation; entry `{globalId,id,projectKey,projectRoot,logFile,at}`; bounded to the newest
  500 entries. Why: rejected/queued-then-aborted runs get no entry; allocation stays pure.
- **D4 surface** — `globalId` on the record, run header and receipt details; `log` prints
  `global id:`; new `resolve <d-N|guid>` tool action + `/delegations resolve`. Why: without a
  queryable surface the global id is dead weight; local ids stay the normal path.
- **D5 legacy flat logs** — untouched, never read by new sessions, no migration; documented.
  Why: migration buys nothing and risks deleting evidence; flat ids may be reused per project.
- **D6 console host** — new dedicated `extensions/console-capture/`, not `session-signals`.
  Why: console hygiene must not vanish when an unrelated feature is disabled; the vertex filter
  stays in session-signals and composes as nested pass-through wrappers.
- **D7 capture gate** — env kill-switch `PI_BADGER_CONSOLE_CAPTURE=0`; installed at factory
  (the TUI owns the terminal before extension bind — F4), confirmed TUI-only at
  `session_start` (disarm otherwise); log `<getAgentDir()>/badger-console.log`, rotate at 1 MiB
  to `.1`. Why: catches load-time chatter, never writes to the terminal in non-TUI modes.
- **D8 fatal carve-out** — permanent disarm on `process.on("uncaughtExceptionMonitor")`, so
  pi's `console.error` crash pair (`interactive-mode.js:3280-3281`) reaches the terminal.
  Why: no string matching; uses the platform event that fires before pi's handler.

### ADR (draft) — project-local ids with a queryable global GUID

- **Context**: `allocateRunId` scans one flat machine-global dir (`index.ts:931-947`,
  `DEFAULT_LOG_DIR` at `index.ts:179`), so ids grow machine-wide and every session reconstructs
  every project's runs (`index.ts:948-952`, `673-712`).
- **Decision**: local `d-N` per project root; a second GUID v7 minted per run and indexed at
  run start; `resolve` bridges both directions.
- **Consequences**: positive — project isolation, ids restart per project, cross-project
  lookup survives restarts; negative — two projects share `d-1`, so global ids must be used
  for cross-project work, and the index is a new file to bound; neutral — legacy flat logs
  become invisible.
- **Alternatives**: keep machine-global ids (rejected: the reported pain); per-project ids with
  no global id (rejected: no cross-project query, and the user asked for one); UUID-only ids
  (rejected: worse TUI ergonomics).

### ADR (draft) — dedicated console-capture extension

- **Context**: extensions write 49 `console.*` call sites into a terminal owned by the TUI
  (F4); `session-signals` already patches console for Vertex only and can be disabled.
- **Decision**: a dedicated TUI-only capture extension writing to a bounded log file, with an
  env kill-switch and a fatal carve-out.
- **Consequences**: positive — one systemic fix, per-site edits unnecessary; negative — a new
  extension to publish and one more wrapper in the console chain, and disabling it (kill-switch
  or extension off) silently restores the leak by design — documented, not free (review S5);
  neutral — vertex chatter lands in the capture file when session-signals is off.
- **Alternatives**: host in `session-signals` (rejected: disableable, wrong ownership);
  per-site removal (rejected: 49 sites, recurs); patch `process.stdout.write` (rejected: pi's
  RPC `takeOverStdout` owns that surface).

## 2. Id scheme (final)

- **Root/key**: `resolveProjectKey(cwd, env)` in new `extensions/subagent/project-key.ts`:
  env override → nearest `.ai-badger` with `project-id` (value) → `.ai-badger` without it
  (hash of that dir) → nearest `.git` (hash of that dir) → hash of cwd. Key sanitized to
  `[A-Za-z0-9._-]`, trimmed, capped 64; unusable value falls back to the hash.
  `projectLogDir(base, key) = join(base, "projects", key)`.
- **Layout**: run logs `<base>/projects/<key>/<d-N>.jsonl`; prune (`LOG_MAX_AGE_MS`,
  `LOG_DIR_CAP=200`) applies per project dir. `DEFAULT_LOG_DIR` unchanged.
- **Global index**: `<base>/index.jsonl`, append at sink creation in `index.ts:891-902`,
  fail-open (an index failure never disables the run's log), compacted to the newest 500 lines.
- **`resolve`**: accepts `d-N` (registry → current project's log dir → error) or a GUID v7
  (global index). Returns `{id, globalId, projectKey, projectRoot, logFile, source}`; unknown
  input throws the existing loud unknown-id error extended with the `resolve` hint. `log`,
  `peek`, `abort` keep local ids.
- **Surfaces**: `DelegationRecord.globalId?`; header `globalId`; `ReceiptDetails.globalId?`;
  `delegations log` prints `global id: <guid>`; `resolve` is the only global entry point.
- **Legacy**: flat `<base>/d-N.jsonl` untouched and unread; no migration; ids may repeat
  across the layouts.

## 3. Console-capture scheme (final)

Host: `extensions/console-capture/`. Gate: install at factory unless
`PI_BADGER_CONSOLE_CAPTURE` is `0|false|off`; at `session_start`, disarm when
`ctx.mode !== "tui"`; uninstall at `session_shutdown` (the factory re-runs next session).
**Factory arming + exit flush (review M1)**: factories load before the TUI starts
(`dist/main.js:653` vs `interactive-mode.js:698`), so factory-window output is pre-TUI and
cannot corrupt the input, but pi's extension-load-failure diagnostics (`dist/main.js:475,725`)
print there and `process.exit(1)` before `session_start` — the capture must therefore
register `process.on("exit")` and, when `session_start` never confirmed a TUI session,
synchronously flush the capture file tail to the original stderr so startup diagnostics reach
the terminal. Arming at capture's own `session_start` handler instead (Shape B) is REJECTED:
pi iterates extensions unsorted, and `subagent` logs on every `session_start`
(`extensions/subagent/index.ts:951`) — a late handler leaves that line leaking.
Log: `PI_BADGER_CONSOLE_CAPTURE_LOG` or `<getAgentDir()>/badger-console.log`; rotate at 1 MiB
to `.1` (one generation). Wrapped set: `log|info|warn|error|debug` (Node 26 has
`console.info !== console.log`); `dir|trace|table` are documented as outside the wrapper
(review S2). The wrapper must never throw into a caller: a throwing append sink falls back to
the original method once and never rethrows. Composition: capture wraps and restores exactly
the functions it captured, so it nests with `installVertexDebugFilter` in either order; it
never touches `google-logging-utils`. Fatal: `uncaughtExceptionMonitor` disarms permanently
(pi's crash pair prints at `interactive-mode.js:3280-3281` after the monitor fires). Tested
without a TUI by injecting the append sink and calling the install/gate/rotate/flush/fatal
functions directly with swapped `console` methods.

## 4. Packages

### PKG-1 — completion fix (bug 2) — standalone, hotfix-sized

**Goal**: every completion item returns the full argument text, so Tab never deletes a verb.
**Files**: `extensions/subagent/delegation-status.ts:606-629`; `extensions/monitor/index.ts:1156-1170`;
tests `tests/subagent-status.test.ts:759-780`, `tests/monitor/monitor-extension.test.ts:583-599`;
new test helper `tests/helpers/apply-completion.ts` (pi's whole-argument algorithm from F3).
**Deltas**: capture the verb (`/^(log|abort|peek)\s+(\S*)$/`) and return `value` as
`verb + " " + record.id`; monitor returns `value` as `"cancel " + view.id`.
**Acceptance**: A1.1 id items are `log d-2` / `abort d-2` / `peek d-2`; A1.2 applying any item
through pi's algorithm keeps the verb (GUARD ONLY — the helper mirrors pi's algorithm, so it
cannot falsify a misreading of the contract; review S1); A1.3 first-token verb lists unchanged;
A1.4 monitor items are `cancel m-1`; A1.5 the independent evidence is a manual TUI check
recorded in the task notes (`/delegations log d`, Tab → `/delegations log d-2`, Enter runs it) —
the helper's header cites the bundle line it mirrors as a future-drift guard.
**Tests first**: `tests/subagent-status.test.ts` — `"completion: id items carry the verb
(value === 'abort d-2')"`, `"completion: applying an item through pi's whole-argument
replacement keeps the verb"`, `"completion: first-token verbs are unchanged"`;
`tests/monitor/monitor-extension.test.ts` — `"B-C8: cancel completions carry the verb (value
=== 'cancel m-1')"`, `"B-C8: applying a cancel completion keeps the verb"`. The existing
assertions (which pin the buggy values) flip first and must go red.
**Prove**: `bun test tests/subagent-status.test.ts tests/monitor/monitor-extension.test.ts` +
`bunx tsc --noEmit -p .`.

### PKG-2 — project-local ids and log layout (bug 1a)

**Goal**: runs live under the project root's key; sessions see only their own project.
**Files**: new `extensions/subagent/project-key.ts`; `extensions/subagent/index.ts:454-470`
(`SubagentDeps`), `:776` (`logDir`), `:891-902` (sink path), `:931-947` (allocator scan),
`:948-952` (`session_start` reconstruction), `:991` (status `staleRuns`). Harnesses that pass
`logDir`: `tests/subagent-extension.test.ts:68-111`, `tests/subagent-level-integration.test.ts`,
`tests/subagent-model-level.test.ts`, `tests/subagent-queue-model-level.test.ts`,
`tests/subagent-queue-tool.test.ts`, `tests/subagent-real-child.test.ts`,
`tests/subagent/delegation-skip-guard.test.ts`, `tests/monitor/cross-extension-queue.test.ts`,
`tests/monitor/monitor-extension.test.ts`, `tests/monitor/wait-tool.test.ts`, plus the
review-found additions `tests/router-fallback/router-fallback-extension.test.ts:931-933`
(passes `logDir`; breaks silently otherwise) and `tests/monitor/poll-guard.test.ts:23` (passes
NO `logDir` today — PKG-2 must give it one so it stops reading/writing the real home).
`tests/subagent-real-child.test.ts:47-63,114` does not use the extension's `logDir` at all
(its own `logSink`) and is unaffected.
**Deltas**: add `SubagentDeps.projectKey?`; compute
`const runLogDir = projectLogDir(logDir, deps.projectKey ?? resolveProjectKey(process.cwd()))`;
point sink, allocator scan, reconstruction and `staleRuns` at `runLogDir`. `allocateRunId`
(`delegation-core.ts:826-853`) and `reconstructFromLogDir` (`index.ts:673-712`) unchanged.
**Acceptance**: A2.1 key resolution rules per §2; A2.2 logs at
`projects/<key>/d-1.jsonl`; A2.3 two keys on one base both allocate `d-1`; A2.4 a session
reconstructs only its own project; A2.5 a legacy flat `d-9.jsonl` is invisible to allocation
and reconstruction.
**Tests first**: new `tests/subagent/project-key.test.ts` — `"project key: AI_BADGER_PROJECT_ID
wins and is sanitized"`, `"project key: .ai-badger/project-id is the key; missing file falls
back to a stable hash"`, `"project key: no .ai-badger walks to .git; no .git hashes cwd"`,
`"project log dir: base/projects/<key>"`; `tests/subagent-extension.test.ts` —
`"project-local logs: two project keys sharing a base dir both allocate d-1"`,
`"project-local logs: a session reconstructs only its own project's runs"`,
`"project-local logs: a legacy flat d-9.jsonl is invisible to allocation and reconstruction"`.
**Prove**: `bun test tests/subagent tests/subagent-extension.test.ts` + `bunx tsc --noEmit -p .`.

### PKG-3 — global GUID v7, index, and resolve (bug 1b)

**Goal**: every run carries a queryable GUID v7 beside its local id.
**Files**: new `extensions/subagent/global-id.ts`, `extensions/subagent/global-index.ts`;
`delegation-core.ts:152-183` (`DelegationRecord`), `:243-260` (`LogRunSummary`);
`delegation-runner.ts:98-110` (`LogSinkInit`), `:186-213` (`RunRequest`), `:305-317` (record),
`:605-609` (`openTee`), `:627-644` (`writeHeader`);
`delegation-registry.ts:33-45` (deps), `:168`/`:223` (allocation), `:183-196`/`:247-260`
(queued records), `:401-427` (`spawnNow`), `:458-467` (`spawnQueued`);
`index.ts:477-490` (`ReceiptDetails`), `:891-902` (index write at sink creation),
`:931-947` (allocator mints the GUID), `:1232-1270` (receipt);
`delegation-status.ts:364-417` (`log` output), `:579-600` (tool action union), `:606-660`
(command verb + completions).
**Deltas**: `newGlobalId(now?)` = 48-bit ms timestamp + `randomBytes`, version 7/variant 10
(no Node-version dependency); `GLOBAL_ID_PATTERN`; index helpers `appendIndexEntry` /
`readIndex` / `findIndexEntry` / `compactIndex(entries, 500)` with threshold-triggered
atomic compaction (temp file + rename; append-only otherwise — review S4);
`DelegationDeps.allocateId?: () => string | {id: string; globalId?: string}` normalized by one
`allocationOf(value)` helper at BOTH call sites (`delegation-registry.ts:168` and `:223`),
`nextInternalId` (`:503`) migrated to the richer return, and an explicit `request.id` run
(path that bypasses the allocator) still mints a GUID via `mintGlobalId`/`newGlobalId`
(review M3); registry sets `record.globalId` and passes it through `RunRequest` →
`LogSinkInit` → header; the sink factory writes the index entry from its `id → globalId` map
at sink creation (fail-open; `openTee` runs before the pre-aborted check at
`delegation-runner.ts:350` vs `:353`, so an aborted-at-spawn run IS indexed — D3's
"aborted-while-queued" wording does not cover it); `resolve` joins the action union and the
command and consults the live registry by `globalId` before the index (review S3);
completions for `resolve` reuse the id branch.
**Acceptance**: A3.1 GUID matches the v7 pattern (version/variant) and is ordered by the
injected clock; A3.2 record, header and receipt details carry `globalId` for allocator-ALLOCATED
and explicit-id runs alike (review M3/S6 — explicit ids mint a GUID after the fact); A3.3 the
index entry appears when the sink opens, and an allocation-time implementation fails because
no entry exists for a queue-cap-rejected run or a run aborted while queued (review M2 — the
test asserts the NEGATIVE too); A3.4 `resolve d-N` returns its GUID, `resolve <guid>` checks
the live registry by `globalId` before the index (queued runs have a GUID but no index entry,
review S3), a GUID from another project returns its `projectKey`/`projectRoot`/`logFile`, and
unknown input is loud; A3.5 the index compacts only above a threshold via temp-file + atomic
rename (append-only otherwise, last-writer-wins documented — two live sessions share it,
review S4), keeping the newest 500 entries.
**Tests first**: new `tests/subagent/global-id.test.ts` — `"global id: is a v7 UUID (version
and variant nibbles)"`, `"global id: the timestamp prefix orders ids by the injected clock"`,
`"global id: two ids in the same millisecond differ"`; new
`tests/subagent/global-index.test.ts` — `"global index: append writes one JSONL entry with
project and log path"`, `"global index: lookup by guid returns the newest entry"`,
`"global index: compaction keeps the newest N entries"`, `"global index: append-only below the
threshold, atomic rename above it"`; `tests/subagent-extension.test.ts` — `"run header carries
globalId and the receipt details expose it"`, `"run header carries globalId for an explicit-id
run too"`, `"the global index entry is written when the run's log sink opens, not at
allocation"` PLUS the negative half `"a queue-cap-rejected run and a run aborted while queued
leave no index entry"`; `tests/subagent-status.test.ts` — `"resolve accepts a local id and
returns its global id"`, `"resolve accepts a guid from another project"`, `"resolve <guid>
answers a queued run from the live registry before the index"`, `"resolve of an unknown id or
guid is loud"`; `tests/delegation-groups.test.ts:110-130` fixture updated to the richer
`allocateId` return (rename to `"Q-B1: ids and global ids are allocated before any spawn"`).
**Prove**: `bun test tests/subagent tests/subagent-status.test.ts tests/subagent-extension.test.ts
tests/delegation-core.test.ts tests/delegation-groups.test.ts` + `bunx tsc --noEmit -p .`.

### PKG-4 — console capture (bug 3) — parallel lane

**Goal**: no extension console output reaches the TUI; it lands in a bounded log file.
**Files**: new `extensions/console-capture/index.ts` (factory: env gate, install, TUI gate at
`session_start`, uninstall at `session_shutdown`), new
`extensions/console-capture/console-capture.ts` (install/gate/format/rotate/fatal helpers);
`publish.ts:70` (`EXTENSION_DIRS`); `README.md:36` table; `docs/reference/extension-catalog.md`
(new section). Optional one-line cleanup: remove the unused `uninstallFilter` binding at
`extensions/session-signals/index.ts:127`.
**Deltas**: capture wraps `log|info|warn|error|debug` (review S2), formats one line per call
(`<iso> <level> <text>`), appends via an injectable sink, rotates at 1 MiB; kill-switch and
path override env; a throwing sink falls back to the original method once, never rethrows;
`process.on("exit")` flushes the capture tail to the original stderr when `session_start`
never confirmed a TUI session (review M1 — pi's load-failure diagnostics otherwise disappear);
`uncaughtExceptionMonitor` → disarm permanently; `uninstall` restores exactly the captured
functions (vertex-filter composition is order-independent).
**Acceptance**: A4.1 console levels reach the log and not the terminal; A4.2 the env
kill-switch leaves console untouched; A4.3 non-TUI `session_start` disarms; A4.4 rotation keeps
one `.1` generation; A4.5 the fatal monitor restores console and never re-arms; A4.6 composed
with the vertex filter in either order, neither message reaches the terminal; A4.7 a throwing
sink falls back to the original console and never throws; A4.8 a pre-`session_start` failure
flush reaches the original stderr and the file keeps the line.
**Tests first**: new `tests/console-capture/console-capture.test.ts` — `"capture: routes
console levels to the log and not the terminal"`, `"capture: the env kill-switch leaves console
untouched"`, `"capture: uninstall restores exactly the captured functions"`, `"capture:
rotation at the byte cap keeps one generation"`, `"capture: the fatal guard restores console
and never re-arms"`, `"capture: a throwing sink falls back to the original console and does
not throw"`, `"capture: composed with the vertex filter in either order, neither writes
to the terminal"`; new `tests/console-capture/console-capture-extension.test.ts` —
`"extension: installs on load and stays armed in tui"`, `"extension: disarms at session_start
when the mode is not tui"`, `"extension: a failure exit before session_start flushes captured
diagnostics to the original stderr"`.
**Prove**: `bun test tests/console-capture tests/session-signals` + `bunx tsc --noEmit -p .`.

### PKG-5 — integration (last package, cross-package tests)

**Goal**: prove the three requests end-to-end on the merged result.
**Files**: new `tests/integration/project-local-ids-console-hygiene.test.ts`;
`docs/reference/extension-catalog.md:90` (log path + id scheme + `resolve` + capture section);
`README.md` extension table.
**Tests first**: `"completion round-trip: /delegations log + Tab yields the full argument"`,
`"project isolation end-to-end: two projects, one base dir, both d-1, no cross-project list
leakage"`, `"global round-trip: resolve d-1 → guid → resolve guid across projects"`,
`"console capture: a leaky extension error never reaches the terminal and the log has it"`,
`"legacy flat logs stay invisible to new sessions"`.
**Acceptance**: A5.1–A5.4 above pass on the merged branch; A5.5 `bun publish.ts` followed by
`bun publish.ts --check` reports in sync for all owned extensions including `console-capture`.
**Prove**: `bun test tests/integration` then the touched-suite run once
(`bun test tests/subagent tests/subagent-status.test.ts tests/monitor tests/console-capture
tests/session-signals`), `bunx tsc --noEmit -p .`, `bun publish.ts && bun publish.ts --check`.

## 5. Parallelism and shared files

- **Parallel**: PKG-1 ∥ PKG-2 ∥ PKG-4 (disjoint files; PKG-1 touches
  `delegation-status.ts` only in the completion function, PKG-4 owns `publish.ts`).
- **Serial**: PKG-2 → PKG-3 (shared `index.ts`, `delegation-core.ts`,
  `delegation-registry.ts`, `delegation-runner.ts`); PKG-3 after PKG-1 (shared
  `delegation-status.ts`).
- **Always last**: PKG-5.
- A merge of PKG-1 before PKG-3 means PKG-3 rebases onto it; the reverse means PKG-1 rebases.
  One implementer per package; no two packages edit `index.ts` concurrently.

## 6. Test-plan table

| Criterion | Test file | Test name | Run |
|---|---|---|---|
| A1.1 | tests/subagent-status.test.ts | completion: id items carry the verb (value === 'abort d-2') | `bun test tests/subagent-status.test.ts` |
| A1.2 | tests/subagent-status.test.ts | completion: applying an item through pi's whole-argument replacement keeps the verb | same (guard only; A1.5 manual TUI check is the independent evidence) |
| A1.3 | tests/subagent-status.test.ts | completion: first-token verbs are unchanged | same |
| A1.4 | tests/monitor/monitor-extension.test.ts | B-C8: cancel completions carry the verb (value === 'cancel m-1') | `bun test tests/monitor/monitor-extension.test.ts` |
| A2.1 | tests/subagent/project-key.test.ts | project key: AI_BADGER_PROJECT_ID wins and is sanitized | `bun test tests/subagent/project-key.test.ts` |
| A2.1 | tests/subagent/project-key.test.ts | project key: .ai-badger/project-id is the key; missing file falls back to a stable hash | same |
| A2.1 | tests/subagent/project-key.test.ts | project key: no .ai-badger walks to .git; no .git hashes cwd | same |
| A2.2 | tests/subagent-extension.test.ts | project-local logs: logFile is projects/<key>/d-1.jsonl and exists | `bun test tests/subagent-extension.test.ts` |
| A2.2 | tests/subagent/project-key.test.ts | project log dir: base/projects/<key> | `bun test tests/subagent/project-key.test.ts` |
| A2.3 | tests/subagent-extension.test.ts | project-local logs: two project keys sharing a base dir both allocate d-1 | `bun test tests/subagent-extension.test.ts` |
| A2.4 | tests/subagent-extension.test.ts | project-local logs: a session reconstructs only its own project's runs | same |
| A2.5 | tests/subagent-extension.test.ts | project-local logs: a legacy flat d-9.jsonl is invisible | same |
| A3.1 | tests/subagent/global-id.test.ts | global id: is a v7 UUID (version and variant nibbles) | `bun test tests/subagent/global-id.test.ts` |
| A3.1 | tests/subagent/global-id.test.ts | global id: the timestamp prefix orders ids by the injected clock | same |
| A3.1 | tests/subagent/global-id.test.ts | global id: two ids in the same millisecond differ | same |
| A3.2 | tests/subagent-extension.test.ts | run header carries globalId and the receipt details expose it | `bun test tests/subagent-extension.test.ts` |
| A3.2 | tests/subagent-extension.test.ts | run header carries globalId for an explicit-id run too | same |
| A3.3 | tests/subagent-extension.test.ts | the global index entry is written when the run's log sink opens, not at allocation | same |
| A3.3 | tests/subagent-extension.test.ts | a queue-cap-rejected run and a run aborted while queued leave no index entry | same |
| A3.4 | tests/subagent-status.test.ts | resolve accepts a local id and returns its global id | `bun test tests/subagent-status.test.ts` |
| A3.4 | tests/subagent-status.test.ts | resolve accepts a guid from another project | same |
| A3.4 | tests/subagent-status.test.ts | resolve <guid> answers a queued run from the live registry before the index | same |
| A3.4 | tests/subagent-status.test.ts | resolve of an unknown id or guid is loud | same |
| A3.5 | tests/subagent/global-index.test.ts | global index: compaction keeps the newest N entries | `bun test tests/subagent/global-index.test.ts` |
| A4.1 | tests/console-capture/console-capture.test.ts | capture: routes console levels to the log and not the terminal | `bun test tests/console-capture` |
| A4.2 | tests/console-capture/console-capture.test.ts | capture: the env kill-switch leaves console untouched | same |
| A4.3 | tests/console-capture/console-capture-extension.test.ts | extension: disarms at session_start when the mode is not tui | same |
| A4.4 | tests/console-capture/console-capture.test.ts | capture: rotation at the byte cap keeps one generation | same |
| A4.5 | tests/console-capture/console-capture.test.ts | capture: the fatal guard restores console and never re-arms | same |
| A4.6 | tests/console-capture/console-capture.test.ts | capture: composed with the vertex filter in either order | same |
| A4.7 | tests/console-capture/console-capture.test.ts | capture: a throwing sink falls back to the original console and does not throw | same |
| A4.8 | tests/console-capture/console-capture-extension.test.ts | extension: a failure exit before session_start flushes captured diagnostics to the original stderr | same |
| A5.1 | tests/integration/project-local-ids-console-hygiene.test.ts | completion round-trip | `bun test tests/integration` |
| A5.2 | tests/integration/project-local-ids-console-hygiene.test.ts | project isolation end-to-end | same |
| A5.3 | tests/integration/project-local-ids-console-hygiene.test.ts | global round-trip | same |
| A5.4 | tests/integration/project-local-ids-console-hygiene.test.ts | console capture: leaky error never reaches the terminal | same |
| A5.5 | (manual) publish gate | — | `bun publish.ts && bun publish.ts --check` |

## 7. Out of scope

- Migrating or deleting legacy flat logs; re-homing live runs across the upgrade.
- Removing/rerouting the 49 `console.*` call sites (capture is the systemic fix).
- Direct `process.stdout.write` bypasses (pi's RPC `takeOverStdout` surface).
- A cross-project `delegations list` (only `resolve` queries the index).
- Changing admission, queueing, result cache, or the delegate/queue tool schemas.
- Per-project quotas beyond the existing 200-log cap now applied per project dir.

## 8. Risks and rollback

- **Mid-run upgrade**: a child running at upgrade time keeps its flat log path; after restart
  it is invisible (accepted, documented). Rollback: revert PKG-2/PKG-3; flat logs remain.
- **Wide test churn**: 10+ harness files reference `logDir` paths. Only
  `tests/subagent-extension.test.ts:410-411` (explicit `join(logDir, "d-1.jsonl")`) and
  `:587/:605` (flat logs written then reconstructed) fail LOUDLY; the rest pass `logDir` only
  to avoid the real home and assert nothing about the path, so PKG-2 adds one nested-path
  assertion to a second harness (monitor-extension or cross-extension-queue) and fixes
  `tests/monitor/poll-guard.test.ts:23` (no `logDir` today). `tests/subagent-real-child.test.ts`
  is unaffected (own sink).
- **Index growth/corruption**: bounded at 500 lines, malformed lines skipped on read, writes
  fail-open; a corrupt index never affects run logging.
- **Capture swallowing a diagnostic**: log file + `PI_BADGER_CONSOLE_CAPTURE=0` +
  `uncaughtExceptionMonitor` disarm; no revert needed to disable.
- **Ordering regressions in the console chain**: capture restores exactly what it captured;
  the vertex filter test asserts both orders.
- Each package is one commit, independently revertible; PKG-5 has no production changes.

## 9. Unknowns resolved

- **Factory deps in production**: `ExtensionFactory = (pi) => ...` and the loader calls
  `factory(load.api)` (`core/extensions/types.d.ts:1153`, `core/extensions/loader.js:463`), so
  `deps` is test-only; production derives `process.cwd()` at factory time.
- **Index write vs runner**: the sink factory owns the `id → globalId` map, so the index write
  needs no runner change; the header does, so `globalId` rides record → `RunRequest` →
  `LogSinkInit` (one line per seam).
- **`resolve` schema fit**: one literal added to the existing action union; the "local id or
  global GUID" sentence goes into the existing `id` description, not a new paragraph.
- **session-signals host**: rejected for the reason in D6; capture alone removes the leak even
  with session-signals disabled.
