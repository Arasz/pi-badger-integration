# Plan review — project-local delegation ids, completion fix, console capture

Date: 2026-09-22. Reviewer: independent plan review (second lane; first lane timed out).
Scope: `docs/plans/2026-09-22-project-local-ids-console-hygiene.plan.md` against
`...research.md` and the cited anchors only. No code, tests, or plan were edited.

## (a) VERDICT

**GO-WITH-FOLDS** — the plan's direction is right and the anchors check out, but three
MUST findings need folds before implementation starts (M1 console arming window, M2 test
honesty for A3.3, M3 allocator-shape completeness), plus M4 on A2.2's evidence.

---

## (b) MUST findings

### M1 — Capture armed at factory swallows pi's own pre-session_start diagnostics
Evidence chain:
- `extensions/console-capture` (planned) installs at factory. Extension factories run
  inside `createAgentSessionFromServices` — `dist/main.js:653` — which is **before**
  `InteractiveMode.init()` starts the TUI (`dist/modes/interactive/interactive-mode.js:698`
  `this.ui.start()`; session_start/bind is later at `:1451`).
- `dist/main.js:717-726`: when any extension failed to load, pi calls
  `reportDiagnostics(startupDiagnostics)` (`console.error`, `dist/main.js:475`) and
  `console.error(EXTENSION_LOAD_FAILURE_HINT)` (`:725`), then `process.exit(1)` — with the
  capture wrapper already armed. Those messages go to `badger-console.log` and the user
  sees nothing.
- Same class in print mode: `dist/main.js:730` no-models error; session_start (where D7
  disarms) may never run before exit.

Exact fold (two viable shapes; do not use the naive "install in capture's own session_start handler" alone):
- **Shape A (preferred): keep factory arming, add an early-exit flush.** Capture at factory as
  planned, but register `process.on("exit", ...)`: if `session_start` never armed/disarmed
  the wrapper (i.e. pi exited during startup, as the diagnostics path does), synchronously
  re-read the capture file tail and write it to the original stderr before exit. The
  diagnostic path is pre-TUI and pre-exit, so the flush reaches the terminal without any
  corruption, and factory arming still covers every extension's `session_start` handler.
- **Shape B (simpler, but only if handler order is guaranteed): arm at the first
  `session_start` with `ctx.mode === "tui"`.** This fails if another extension's
  `session_start` handler runs first — handler order is extension load order
  (`discoverExtensionsInDir` iterates `readdirSync`, unsorted), and `subagent` logs at
  `extensions/subagent/index.ts:951` on every `session_start`; if `console-capture` is
  appended last in `EXTENSION_DIRS` it loads last and its handler runs last, so that line
  leaks. Only take Shape B with a guaranteed-first registration or a mechanism that flips
  the wrapper before any handler runs.
Add one test: with a runtime-diagnostics-style `console.error` before `session_start` and
an exit without bind, the message reaches the original console (Shape A) or was never
captured (Shape B).

### M2 — A3.3's named test passes with an allocation-time implementation
The test name "the global index entry is written when the run's log sink opens, not at
allocation" only asserts the positive unless it also asserts the negative. An
implementation writing the index inside `allocateId` (`extensions/subagent/index.ts:931`)
would satisfy "entry exists after a run" and pass. Exact fold: add the negative half —
after a `registry.start()` rejected by `queueCap` (allocation happens before admission,
`delegation-registry.ts:168`) and after a run aborted while queued
(`delegation-registry.ts:458-467` returns before `spawnNow`), assert the index contains no
entry for that run's `globalId`; and assert no entry between `allocateId` and sink open.
Also note `openTee` runs before the pre-aborted check (`delegation-runner.ts:350` vs
`:353`), so an "aborted at spawn" run **does** create a log and an index entry — D3's
"aborted-while-queued" wording must not be read as covering it.

### M3 — Allocator-shape change is incomplete: `nextInternalId` and the union normalization
`allocateId: () => string` is at `delegation-registry.ts:42`; call sites are `:168`
(`request.id ?? this.deps.allocateId?.() ?? this.nextInternalId()`) and `:223`
(`enqueueGroup` map). The plan names both call sites and `index.ts:931`, but not:
- `delegation-registry.ts:503 nextInternalId()` — must return `{id}` (or the normalization
  must accept `string | {id; globalId?}`), or the default allocator breaks;
- the `request.id ??` union at both sites — an explicit-id run bypasses the allocator and
  gets **no** `globalId`, so the header/receipt A3.2 path is untested for that shape.
- `tests/subagent-status.test.ts:761-765` starts runs with explicit `id` — those records
  will have no `globalId`; decide and document that, or mint a GUID for explicit-id runs
  too.

Grep-verified: no other `allocateId` caller or test fixture exists besides
`tests/delegation-groups.test.ts:115` (named) and `index.ts:931` (named). Fold: one
normalization helper `allocationOf(value: string | {id; globalId?}): {id; globalId?}` used
at both call sites, `nextInternalId` migrated, and the explicit-id decision recorded.

### M4 — A2.2 is mapped to a helper-only test; the risk claim "fails loudly" is false
The test-plan table maps A2.2 ("logs at `projects/<key>/d-1.jsonl`") only to
`tests/subagent/project-key.test.ts` "project log dir: base/projects/<key>" — a test of
`projectLogDir`, which passes even if `index.ts` never calls it. The extension-level
assertion that proves wiring is `tests/subagent-extension.test.ts:410-411`
(`expect(result.details.logFile).toBe(join(h.logDir, "d-1.jsonl"))`), which the plan
implies flips but does not map to A2.2. Exact fold: map A2.2 to the flipped
`subagent-extension.test.ts` assertion (and the `existsSync` on the nested path), keeping
the helper test as A2.1 support.

Harness classification (answer to question B):
- **Loud**: `tests/subagent-extension.test.ts:410-411` (explicit join) and `:587/:605`
  (flat logs written then reconstruction asserted).
- **Silent** (pass `logDir` only to avoid the real home; never assert a path):
  `subagent-level-integration.test.ts`, `subagent-model-level.test.ts`,
  `subagent-queue-model-level.test.ts`, `subagent-queue-tool.test.ts`,
  `subagent/delegation-skip-guard.test.ts`, `monitor/cross-extension-queue.test.ts`,
  `monitor/monitor-extension.test.ts`, `monitor/wait-tool.test.ts`, and the **missed**
  `router-fallback/router-fallback-extension.test.ts:931-933`.
- **Mischaracterized**: `tests/subagent-real-child.test.ts:47-63,114` does not pass
  `logDir` to the extension at all — it builds a `DelegationRunner` with its own
  `logSink`; PKG-2 cannot break it and it proves nothing about the new layout.
- **Missed, real-home risk**: `tests/monitor/poll-guard.test.ts:23` calls
  `subagent(pi, { now, escalateAfterMs })` with **no** `logDir`, so it reads/writes the
  real `~/.pi/agent/subagent-logs`; PKG-2 changes which real subdirectory it reconstructs.
  Add `logDir` there.

Fold: correct §8's "a missed harness fails loudly, not silently" to name the two loud
files, and add one nested-path assertion to a second harness (e.g. monitor-extension or
cross-extension-queue) so the layout is double-covered.

---

## (c) SHOULD findings

### S1 — Tautology helper: acceptable as a guard, not as independent evidence (question A)
`tests/helpers/apply-completion.ts` re-implements the algorithm it is meant to verify, so
A1.2/A5.1 cannot falsify a misreading of pi's contract. It is acceptable as a regression
guard **provided** the load-bearing gates stay direct: A1.1 (`value === "log d-2"`) and
A1.4 (`value === "cancel m-1"`) are exact-value assertions and are honest. There is no
public API to import instead: pi's `package.json` exports only `.`, `./rpc-entry`,
`./client`; `CombinedAutocompleteProvider` is internal to
`dist/bundle/chunks/chunk-OMWWHBTG.js`. Exact alternative if independent evidence is
demanded: record a manual TUI check (`/delegations log d`, Tab → `/delegations log d-2`)
as A1.2's evidence and keep the helper only as a future-drift guard, with its header citing
the bundle line it mirrors.

### S2 — Console wrapper coverage and failure behaviour
- `console.info`, `console.dir`, `console.trace`, `console.table` are **not** patched by
  wrapping `log|warn|error|debug` (verified on Node 26: `console.info !== console.log`).
  No current extension uses them (grep: 48 error / 8 warn / 4 debug), so this is a
  forward-looking gap — wrap them or document the limit.
- The wrapper must never throw into the calling extension: if the append sink throws
  (unwritable `badger-console.log`), catch once, fall back to the original method, and
  never rethrow. The plan's tests inject a sink but do not test a throwing sink.

### S3 — Resolve semantics for a queued run's GUID are unspecified (question D)
- (a) queued run with a minted `globalId` and no log: `resolve d-N` works **in-session**
  (registry holds `record.globalId`); `resolve <guid>` fails, because D3 writes the index
  only at sink creation. The plan does not say this is intended.
- (b) live run before the sink opens: no observable window — `openTee` is called
  synchronously inside `runner.run` at `delegation-runner.ts:350`, before spawn at `:373`.
  A pre-aborted run still opens the sink, so it is indexed; only a **throwing** sink
  factory leaves a live run unindexed (fail-open).
Fold: `resolve <guid>` checks the live registry by `globalId` before the index, and the
plan states the queued-run behaviour explicitly with a test.

### S4 — Index compaction is a cross-session write race
Two live sessions append to `<base>/index.jsonl`; a read-modify-write compaction can drop
a concurrently appended line. Fold: compact only when the file exceeds a threshold, via
temp-file + rename (last-writer-wins documented), and keep append-only otherwise.

### S5 — New 13th extension is justified, but the D6 rationale needs the counter-cost
D6 (disable-ability of session-signals) is sound; add the counter-cost to the ADR: when
console-capture itself is disabled, the leak silently returns — the kill-switch and
disable paths should be documented as "leak returns by design", not presented as free.

### S6 — A3.2 explicit-id path untested
Covered by M3: record whether explicit-`id` runs (tests and any production caller) get a
minted GUID; if not, A3.2's "record, header and receipt carry `globalId`" holds only for
allocator-allocated runs and the criterion should say so.

---

## (d) Verified sound

- **Completion contract (PKG-1)**: `value` must be the whole argument text; the buggy
  sites are exactly `delegation-status.ts:606-629` and `monitor/index.ts:1156-1170`; the
  existing tests at `tests/subagent-status.test.ts:759-780` and
  `tests/monitor/monitor-extension.test.ts:583-599` pin the buggy values and must flip.
  The regex/verb additions for `resolve` are covered by PKG-3's
  `delegation-status.ts:606-660` anchor.
- **PKG-2 wiring anchors**: sink `index.ts:890-902`, allocator scan `:931-947`,
  reconstruction `:673-712`, `staleRuns` `:991` — all real and all named; the `logDir`
  test seam (`SubagentDeps.logDir`, `:457-458`) remains the base.
- **D3 index timing**: allocation precedes admission (`delegation-registry.ts:168`), so
  rejected runs never reach a sink and get no entry; queued runs get none until spawn —
  as intended.
- **Fatal carve-out ordering**: `uncaughtExceptionMonitor` fires before pi's
  `uncaughtException` listener (`interactive-mode.js:3323-3325`), which prints at
  `:3280-3281`; restoring on the monitor makes pi's crash pair visible.
- **No load-order leak pre-session_start**: factories load at `main.js:653`, TUI starts at
  `interactive-mode.js:698`; extension factory output cannot corrupt the input before
  session_start. (Pre-session_start output therefore needs no capture at all; the only
  constraint is that capture's `session_start` handler must not rely on running first —
  see M1 Shape B.)
- **Vertex-filter composition is order-independent**: `silence-vertex-debug.ts:66-98`
  captures and forwards to the previously captured function; console-capture restoring
  exactly what it captured nests cleanly either way.
- **Publish surface**: `publish.ts:70` `EXTENSION_DIRS` + `--check` gate; the 13th entry
  is required and named.

---

## (e) Criterion honesty (question F)

| Criterion | Honest? | Note |
|---|---|---|
| A1.1 | YES | direct exact-value assertion |
| A1.2 | GUARD ONLY | helper re-implements pi's algorithm (S1) |
| A1.3 | YES (by design) | passes with the bug — it asserts "unchanged" |
| A1.4 | YES | direct exact-value assertion |
| A2.1 | YES | direct unit tests of the new resolver |
| A2.2 | **NO** | helper-only mapping; passes if wiring is missing (M4) |
| A2.3 | YES | extension-level allocation per key |
| A2.4 | YES | extension-level reconstruction filter |
| A2.5 | YES | extension-level invisibility |
| A3.1 | YES | direct GUID shape/order |
| A3.2 | PARTIAL | allocator path only; explicit-id path unstated (M3/S6) |
| A3.3 | **NO (as named)** | positive-only test; needs the negative half (M2) |
| A3.4 | YES | direct resolve assertions |
| A3.5 | YES | direct compaction assertion |
| A4.1–A4.6 | YES | direct with injected sink; add throwing-sink case (S2) |
| A5.1 | GUARD ONLY | same helper as A1.2 (S1) |
| A5.2–A5.4 | YES | integration on the merged branch |
| A5.5 | YES | manual publish/`--check` gate |
