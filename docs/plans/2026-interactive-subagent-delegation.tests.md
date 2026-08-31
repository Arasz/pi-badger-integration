# Test table — pbi-interactive-background-subagent-delegation

Companion to `docs/plans/2026-interactive-subagent-delegation.md` §6 (qa review finding 1: the
table must live in the repo, re-based to the plan's package order, original ids preserved).

RED-first protocol (qa finding 3): every row targeting a not-yet-existing export is witnessed
RED (failure output recorded in the task log) before its implementing package lands; the suite
is green at every commit. P0 commits rows 2–7 green; row 1 is authored in P0, witnessed RED,
and committed green in P3 together with the argv change that satisfies it (expected argv
amended in the same commit as the `--exclude-tools delegate,delegations` denylist change).

Flake conventions (qa finding 7): FakeChild emits `close` synchronously from drive calls; no
test awaits the widget's 5 s tick (widget rows assert `setWidget` calls on registry
transitions); pi.events assertions capture the emitted-snapshot list after driven transitions;
row 42 is bounded by bun's ~5 s per-test timeout (no second watchdog); `escalateAfterMs:0` in
all runner fixtures; time-in-parameters everywhere, no fake-timer library.

| id | pkg | file | test | arrange → act → assert | AC |
|----|-----|------|------|------------------------|-----|
| 1 | P0/P3 | tests/subagent-tool.test.ts | ⚠ argv carries JSON mode + new denylist | persona + task → `delegationArgs` → contains `["-p","--mode","json","--no-session","--exclude-tools","delegate,delegations"]`, `--` before task | AC1 |
| 2 | P0 | tests/subagent-tool.test.ts | argv keeps persona prompt and model | persona with body, model → args → `--append-system-prompt` + `--model`, empty body omitted | AC1 |
| 3 | P0 | tests/subagent-tool.test.ts | argv escapes a task starting with `-` | task `"--danger"` → args → task after `--` unparsed | AC1 |
| 4 | P0 | tests/subagent-tool.test.ts | scanPersonas degrades loudly, never throws | dir with valid/no-name/no-desc/unparseable/unreadable/duplicate/non-md files → scan → personas parsed, one error line each, duplicates listed, `.missingDir` only when absent | AC1 |
| 5 | P0 | tests/subagent-tool.test.ts | capOutput keeps tail, marks drop | string > limit → capped → ≤ limit, dropped-count marker | AC2 |
| 6 | P0 | tests/subagent-tool.test.ts | piInvocation picks script/execPath/fallback | bunfs / real script / node / other → per documented rule | AC1 |
| 7 | P0 | tests/subagent-tool.test.ts | parsePersona rejects missing fields | frontmatter missing name/description → `{error}` with basename | AC1 |
| 8 | P1 | tests/delegation-core.test.ts | session header line parses | `{"type":"session",…}` → `parseChildEvent` → `{type:"session"}` | AC2 |
| 9 | P1 | tests/delegation-core.test.ts | message_end with usage parses intact | assistant `message_end` line → usage fields preserved | AC2 |
| 10 | P1 | tests/delegation-core.test.ts | blank/garbage lines return undefined, never throw | `""`, `"Segmentation fault"`, `"{oops"` → `undefined` ×3 | AC2 |
| 11 | P1 | tests/delegation-core.test.ts | usage accumulator bumps turns + counters | usage `{input:10,output:2,cacheRead:3,cacheWrite:1,cost.total:.01,totalTokens:99}` → sums match, turns 1, contextTokens 99 | AC2 |
| 12 | P1 | tests/delegation-core.test.ts | zero-usage assistant end still bumps turns | assistant end without usage → turns 1, counters 0, no NaN | AC2 |
| 13 | P1 | tests/delegation-core.test.ts | non-assistant message_end touches nothing | tool/user role end → unchanged | AC2 |
| 14 | P1 | tests/delegation-core.test.ts | **(rev: log-dir reconstruction, review fold)** lost-run classification | log dir: header present, no `exit` line, pid dead → `lost/orphaned` with agent/task/startedAt from header | AC5 |
| 15 | P1 | tests/delegation-core.test.ts | **(rev)** exit line present → completed regardless of session receipts | header + `exit` line → `completed` (log dir is the single source of truth) | AC5 |
| 16 | P1 | tests/delegation-core.test.ts | **(rev)** spawn-failed run is `failed`, not lost | header + spawnError marker → `failed` | AC5 |
| 17 | P1 | tests/delegation-core.test.ts | empty log dir → no orphans | dir empty → `[]` | AC5 |
| 18 | P1 | tests/delegation-core.test.ts | status renderer: one running run | startedAt 0, activity, usage, now=92s → label + `1m32s` + activity + usage in one line | AC2 |
| 19 | P1 | tests/delegation-core.test.ts | status renderer: three runs sort by start; queued shows phase not clock | 3s/2s/1s, third queued → start order, `queued` | AC2 |
| 20 | P1 | tests/delegation-core.test.ts | exited/orphaned phases render distinctly | exitCode 1 run + lost run → `exited 1` / `lost` markers | AC2/AC5 |
| 21 | P1 | tests/delegation-core.test.ts | empty status renders undefined | no runs → `undefined` | AC2 |
| 22 | P1 | tests/delegation-core.test.ts | admission policy: cap then FIFO | cap 2, three requests → 2 admitted, 1 queued; release → queued admitted FIFO | AC1 |
| T53 | P1 | tests/delegation-core.test.ts | runId allocation: skip-to-next-free (review CR1) | log dir containing `d-1`,`d-3` → next id `d-2`? no — next-free `d-4`; existing file at chosen name → skip to free | AC5 |
| T54 | P1 | tests/delegation-core.test.ts | extractAnswer: last assistant text; silent-JSON detection (review CR4) | canned events → last assistant text; zero agent events + exit 0 → silent-variant marker | AC2/AC3 |
| T55 | P1 | tests/delegation-core.test.ts | log-dir prune: 14 days + dir cap oldest-first (review Q2c) | injected file list + now → old deleted, young kept, cap trims oldest | AC4 |
| T56 | P1 | tests/delegation-core.test.ts | per-run tee byte-cap elision shape (review CR14/Q2c) | stream > cap → header+tail kept, middle elided with marker | AC2 |
| 23 | P2 | tests/delegation-runner.test.ts | execute returns before child exits | FakeChild held open → promise resolves `{state:"running",exitCode:null}` while `child.exited===false` | AC1 |
| 24 | P2 | tests/delegation-runner.test.ts | order log: returned precedes completed | event array → `["execute-returned","completed"]` | AC1 |
| 25 | P2 | tests/delegation-runner.test.ts | three parallel starts resolve, no child closed | cap 4 → 3 promises resolve, 3 children, none exited | AC1 |
| 26 | P2 | tests/delegation-runner.test.ts | live progress before close | `message_update` delta → onUpdate spy called pre-exit | AC2 |
| 27 | P2 | tests/delegation-runner.test.ts | usage accumulates across turns into note | 2 assistant ends → exit(0) → summed totals, turns 2 | AC2/AC3 |
| 28 | P2 | tests/delegation-runner.test.ts | JSON split across chunks parses once | emitSplit → exactly 2 events | AC2 |
| 29 | P2 | tests/delegation-runner.test.ts | trailing line without newline flushed on close | event no `\n` + exit(0) → flushed | AC2 |
| 30 | P2 | tests/delegation-runner.test.ts | garbage skipped, preserved in log | garbage + valid → run continues, logSink has raw garbage | AC2 |
| 31 | P2 | tests/delegation-runner.test.ts | success note: output, exit 0, agent id | happy timeline → one note, final text, exitCode 0 | AC3 |
| 32 | P2 | tests/delegation-runner.test.ts | non-zero exit: failure note, capped stderr | 90KB stderr, exit(2) → note exitCode 2, stderr tail capped | AC3 |
| 33 | P2 | tests/delegation-runner.test.ts | spawn error delivered loudly | spawnFn throws → note with spawnError, state failed | AC3 |
| 34 | P2 | tests/delegation-runner.test.ts | output capping on note text | >64KB text → ≤ cap with dropped marker | AC3 |
| 35 | P2 | tests/delegation-runner.test.ts | SIGTERM then SIGKILL when child ignores kill (mutation trap) | abort, escalateAfterMs 0, never exit → `["SIGTERM","SIGKILL"]` | AC4 |
| 36 | P2 | tests/delegation-runner.test.ts | early close cancels escalation | abort then exit(0) pre-grace → `["SIGTERM"]` only | AC4 |
| 37 | P2 | tests/delegation-runner.test.ts | already-aborted signal never spawns | aborted signal → failure note, spawnFn not called | AC4 |
| 38 | P2 | tests/delegation-runner.test.ts | no completion notification after shutdown | stop runner, exit(0) → notifyComplete not called | AC3/AC4 |
| 39 | P2 | tests/delegation-runner.test.ts | cap and FIFO dispatch | cap 2, three runs → two children; exit first → third spawns synchronously | AC1 |
| 40 | P2 | tests/delegation-runner.test.ts | out-of-order completion: notes cross-wire-free | exit order 2,3,1 → each note matches its own run | AC1/AC3 |
| 41 | P2 | tests/delegation-runner.test.ts | per-run log ordering under interleaving | two runs alternate → each logSink has own lines in order | AC2 |
| 42 | P2 | tests/delegation-runner.test.ts | hermetic real process (ungated) | real spawn `bun -e` printing one JSON line + stderr → note delivered, one event | AC1/AC3 |
| T58 | P2 | tests/delegation-runner.test.ts | queue-cap-16 loud rejection, both call types (review CR3/Q2d) | 4 running + 16 queued → 17th request (background AND blocking) rejected with guidance | AC1 |
| T59 | P2 | tests/delegation-runner.test.ts | admission pin: blocking call enqueues when slots full (review A9) | 4 running, queue room → blocking call enqueued and awaits; queue full → rejected | AC1 |
| T60 | P2 | tests/delegation-runner.test.ts | pi.events transition snapshots (review Q2e) | driven transitions → event bus captured serializable snapshots per phase | AC2 |
| T61 | P2 | tests/delegation-runner.test.ts | queued-abort: removes without kill; dequeue skips aborted (review CR2) | abort while queued → state aborted, no child; admission never spawns it | AC3/AC4 |
| T62 | P2 | tests/delegation-runner.test.ts | log-sink failure isolated (review CR6) | sink throws mid-run → one warning, run completes, no throw, logFile reported unavailable | AC4 |
| T63 | P2 | tests/delegation-runner.test.ts | ESRCH / double-kill tolerated (review CR5) | kill twice, dead pid → no throw | AC4 |
| T64 | P2 | tests/delegation-runner.test.ts | exit-path kill is sync SIGKILL, no timers (review CR5) | process exit handler → SIGKILL recorded with no macrotask flush | AC4 |
| T65 | P2 | tests/delegation-runner.test.ts | wait(): resolves with snapshots; shutdown resolves pending waits (review CR10) | wait on running ids + timeout → per-id snapshots not error; shutdown mid-wait → terminal states | AC1/AC2 |
| 43 | P3 | tests/subagent-extension.test.ts | registration shape | factory → delegate + delegations tools, /delegations command, session handlers | AC1/AC2 |
| 44 | P3 | tests/subagent-extension.test.ts | unknown agent answers immediately with list | `"nope"` → persona list, no child | AC1 |
| 45 | P3 | tests/subagent-extension.test.ts | tool result while running says running | FakeChild open → receipt with id/toolCallId in details | AC1/AC5 |
| 46 | P3 | tests/subagent-extension.test.ts | completion rides sendMessage followUp + triggerTurn | spy → exit(0) → custom message with note, `deliverAs:"followUp"`, `triggerTurn:true` | AC3 |
| 47 | P3 | tests/subagent-extension.test.ts | **(rev: log-dir reconstruction)** session_start marks lost runs; no notification (review Q2j) | log dir with lost run → session_start → status shows lost; **notifyComplete never called** | AC5 |
| 48 | P3 | tests/subagent-extension.test.ts | session_shutdown kills every live child | two running → shutdown → SIGTERM both, registry empty, later exits produce no notifications | AC4 |
| T66 | P3 | tests/subagent-extension.test.ts | background auto-resolution matrix (review A1/CR7) | mode tui → receipt; mode print → blocking result; mode rpc → blocking result; explicit values win | AC1/AC6 |
| T67 | P3 | tests/subagent-extension.test.ts | degrade warning rides the tool result (review CR7/A6) | background:true in print mode → blocking result with degrade line in content / `details.degraded` | AC6 |
| T68 | P3 | tests/subagent-extension.test.ts | receipt queued variant (review CR2) | cap full → receipt says "queued (position N)", not "started" | AC1 |
| T69 | P3 | tests/subagent-extension.test.ts | abort-queued fires exactly one aborted notification (review CR2) | queued + abort → one `delegation-result` state aborted, no exitCode | AC3 |
| T70 | P3 | tests/subagent-extension.test.ts | double-close fires one notification (review Q2f) | exit(0) twice → one sendMessage | AC3 |
| T71 | P3 | tests/subagent-extension.test.ts | notification content 8 KB cap (review Q2f) | huge final text → message content ≤ 8 KB with marker | AC3 |
| T72 | P3 | tests/subagent-extension.test.ts | delegation-result renderer registered (review Q2h) | factory → registerMessageRenderer called with compact card | AC2 |
| T73 | P3 | tests/subagent-extension.test.ts | ids never reused across restart (review CR1) | log dir with d-1..d-3 → new session_start → next delegation gets d-4 | AC5 |
| T74 | P3 | tests/subagent-extension.test.ts | cwd validation (review CR13/Q2g) | relative / missing / file path → loud error; personas scanned from ctx.cwd, child cwd = params.cwd | AC1 |
| 49 | P4 | tests/subagent-status.test.ts | status command with mixed fleet | 1 running + 1 queued + 1 exited → three correctly-phased lines | AC2 |
| 50 | P4 | tests/subagent-status.test.ts | widget key distinct from session-signals status key | run live → setWidget key ≠ `"pi-badger"` | AC2 |
| T75 | P4 | tests/subagent-status.test.ts | widget renders background/queued only (review CR17) | blocking-mode delegation → no widget line; background → line; empty → cleared | AC2 |
| T76 | P4 | tests/subagent-status.test.ts | delegations tool contract details (review CR10) | wait timeout → snapshots; unknown id → loud error; terminal id → immediate; abort without id → usage error | AC2 |
| T77 | P4 | tests/subagent-status.test.ts | session-signals tick-defer (review A3/Q2i) | background receipt lands before first tick → footer never rendered; blocking run → rendered at tick; `delegations` in default watch list (wait visible) | AC2 |
| T78 | P4 | tests/subagent-status.test.ts | /delegations shares registry path with tool (review Q2) | command abort d-3 → same registry transition as tool abort | AC2 |
| 51 | P5 | tests/subagent-real-child.test.ts | gated smoke: full real delegation (H2) | `PI_BADGER_SMOKE=1`, real persona, "Reply with exactly: ok", 60s watchdog → exit 0, usage > 0, note delivered | AC1-3, H2 |
| 52 | P5 | tests/subagent-real-child.test.ts | gated smoke: real SIGTERM kills real child (H4) | abort mid-run → process gone within grace, no zombie in afterAll | AC4, H4 |

Smoke honesty protocol (qa finding 4): P5's definition of done includes running
`PI_BADGER_SMOKE=1 bun test tests/subagent-real-child.test.ts` and recording the summary —
including `0 skipped` — in the task log; skip reason must be loud
(`SKIPPED: PI_BADGER_SMOKE unset — H2/H4 unverified`); AC4 may not be checked while row 52
reports skipped. Real children in the smoke run execute in a temp dir scaffolded with a
minimal `.pi/agents` so the `git status --porcelain` clause of AC4 is structural (qa finding 5).

Manual-evidence checklist (qa finding 5, architect finding 2): a committed file with one row
per manual check — H1 idle-TUI wake, H5 widget/footer visual coexistence, e2e "three
background delegations while the user keeps typing; followUps land; mid-run abort", e2e
restart scenario, e2e MoE-panel-style run in TUI — each with exact command, observable pass
condition, and an evidence slot (transcript path/screenshot). The task cannot finish with an
empty evidence slot.

---

## Deferral rows (pbi-delegation-timeout-and-burst-batching — plan §4, landed per package)

Rows T79–T105 implement the two deferred items (per-run `timeoutMs`, review A12; followUp burst
batching, review CR11) from `docs/work/2026-08-30-delegation-timeout-and-burst-batching-plan.md`.
Numbering continues the committed table; each package's rows are committed with the code that
satisfies them. Clamp note: the 1 s floor / 24 h cap re-clamps at the runner's timer site (S5),
so a fixture's small `timeoutMs: 5` is applied as 1000 ms and the drains wait it out in real time
(no fake-timer library). Red-first: T79/T80/T84/T85 witnessed RED pre-implementation (no timer
existed); T81/T83 were vacuously green pre-implementation — nothing arms a timer yet to leak —
and their bite is witnessed by the post-implementation mutations below; T82 and T105 are PIN rows
(validated green-then-mutation-checked). Witnessed mutations: T81 — removing the clearTimeout
discipline AND the settled guard turns T81 (and T82) red; either single removal is absorbed by
the other defense, so the plan's "one at a time" red is unreachable in any implementation that
also passes T82 (defense-in-depth symmetry, recorded here instead of weakening a defense). T82 —
stamping `abortReason` on every abort turns T82 (and T85) red. T83 — removing the registry's
stopped guard turns T83 (and row 38) red.

| id | pkg | file | test | arrange → act → assert | AC |
|----|-----|------|------|------------------------|-----|
| T79 | P1 | tests/delegation-runner.test.ts | timeout expiry kills through the abort path | run `timeoutMs: 5`, `escalateAfterMs: 0`, child ignores kills → drain → signals `["SIGTERM","SIGKILL"]`, note state aborted | AC-T1 |
| T80 | P1 | tests/delegation-runner.test.ts | timeout settles aborted with marker, no exitCode, one note | `timeoutMs: 5` → drain → one note, state aborted, `abortReason "timeout"`, no `exitCode` key, `timeoutMs` = applied 1000; record mirrors both fields | AC-T2 |
| T81 | P1 | tests/delegation-runner.test.ts | natural close clears the timer | `exit(0)` before expiry → drain past expiry → completed note, `signals: []` | AC-T3 |
| T82 | P1 | tests/delegation-runner.test.ts | user abort wins; late timeout fire is a no-op (PIN) | `abort()` first, `timeoutMs: 5` → drain → one aborted note without `abortReason`, SIGTERM once | AC-T2 |
| T83 | P1 | tests/delegation-runner.test.ts | shutdown with an armed timeout notifies nothing | registry, start `timeoutMs: 5`, `shutdown()` pre-expiry → drain → notes empty | AC-T4 |
| T84 | P1 | tests/delegation-runner.test.ts | queued run inherits timeout; clock starts at spawn | cap 1; second request `timeoutMs: 5` queued; drain (still queued) → settle first → second spawns → drain → second aborted with marker; first child never signaled; exactly one note | AC-T5 |
| T85 | P1 | tests/delegation-runner.test.ts | record carries the applied timeout; pre-aborted signal arms nothing | running `record.timeoutMs` equals the request value; already-aborted signal + `timeoutMs` → aborted note, spawnFn never called, no marker, no `timeoutMs` | AC-T5 |

### Pkg P2 rows — timeout surfaces (committed with the P2 code)

Witnessed red: T86–T91 failed to even load the extension suite pre-implementation
(`Export named 'clampRunTimeoutMs' not found`); T89/T91 witnessed red in the status and core
suites (old rendering/claim live). T90 deviation: the row's literal "limit 1m00s" would cost a
60 s real wait, so T90 drives `timeoutMs: 1000` and asserts "timed out (limit 1s) and was
aborted" — the 1m00s zero-pad shape stays pinned exactly by T88 at the pure-function level.

| id | pkg | file | test | arrange → act → assert | AC |
|----|-----|------|------|------------------------|-----|
| T86 | P2 | tests/subagent-extension.test.ts | clamp bounds (pure) | undefined/NaN/Infinity/0/(-5) → undefined; 100 → 1000; 90000 → 90000; 2**32 → RUN_TIMEOUT_MAX_MS | AC-T6 |
| T87 | P2 | tests/subagent-extension.test.ts | schema accepts and clamps at the boundary | execute `timeoutMs: 100` → `record.timeoutMs` = 1000 | AC-T6 |
| T88 | P2 | tests/subagent-extension.test.ts | timeout verdict line (pure) | note `{aborted, abortReason "timeout", timeoutMs 60000, durationMs 610000}` → exactly `Delegation d-2 (architect) timed out (limit 1m00s) and was aborted.` (limit, not elapsed); user abort keeps the plain verdict | AC-T7 |
| T89 | P2 | tests/subagent-status.test.ts + tests/delegation-core.test.ts | list/wait and panel render the timeout | record with `abortReason "timeout"` → describeRecord `aborted (timeout)`; renderRunLine renders the same; user-aborted runs render plain `aborted` | AC-T7 |
| T90 | P2 | tests/subagent-extension.test.ts | blocking result names the timeout | `background:false`, `timeoutMs: 1000`, drive expiry → content contains `timed out (limit 1s) and was aborted`, `details.exitCode` null | AC-T7 |
| T91 | P2 | tests/subagent-extension.test.ts + tests/subagent-status.test.ts | description text updated | delegate + delegations descriptions drop "no automatic per-run timeout", both name `timeoutMs`; background param sentence gone; param description states floor (1000 ms), cap (86400000), kill path (SIGTERM), spawn-started clock | AC-T8 |

### Pkg P3 rows — burst batching (committed with the P3 code)

Witnessed red: T93–T100 failed pre-implementation — every same-tick completion sent its own
message immediately (2-burst → 2 sends, 3-burst → 3, 5-burst → 5) and the renderer had no batch
branch; T92 (PIN) was green by construction and mutation-validated (forcing the batch shape onto
single sends turns T92 — and rows 46/T69/T93/T96/T100 — red). Plan conflict recorded: the
7–8-run burst fixtures exposed a pre-existing T73 wiring race — `allocateId` read only the log
dir, and a QUEUED run has no log file yet, so concurrent queueing re-allocated the same id and
the registry overwrote its record/request (T95–T97 unpassable). Fixed minimally in the index.ts
allocateId closure (live registry records join the exists check); the frozen core allocator is
untouched. T97's uniqueness assertion is the pin for that fix.

| id | pkg | file | test | arrange → act → assert | AC |
|----|-----|------|------|------------------------|-----|
| T92 | P3 | tests/subagent-extension.test.ts | isolated completion unchanged (PIN) | one child exit → one sendMessage, v1 customType/content/display/details-spread/deliverAs/triggerTurn, no batch flag | AC-T9 |
| T93 | P3 | tests/subagent-extension.test.ts | second same-tick completion held, flushed as a normal card | two exits same tick → 1 send before drain, 2 after; second has no batch flag | AC-T10 |
| T94 | P3 | tests/subagent-extension.test.ts | three-note burst → lead + batched message | three exits same tick → 2 sends; second `details.batched`, `details.notes` ids = d-2, d-3 in settle order, divider in content | AC-T10 |
| T95 | P3 | tests/subagent-extension.test.ts | batch content capped at 8 KB | 7 runs (lead + 6 held), 10 KB answers → capacity flush → content ≤ 8192, 6 drop markers, 6 verdict lines each exactly once | AC-T11 |
| T96 | P3 | tests/subagent-extension.test.ts | capacity flush keeps the window open | 8-note burst → 3 sends: lead, batch of 6 (batched), single tail card | AC-T10 |
| T97 | P3 | tests/subagent-extension.test.ts | per-run uniqueness across lead and batches | 8-note burst → ids over all sends → each id exactly once (also pins the allocateId live-record fix) | AC-T12 |
| T98 | P3 | tests/subagent-extension.test.ts | shutdown flushes once, then silence; empty expiry is a no-op | lead + 2 held + 1 live → session_shutdown → one batched flush, further exits silent, no phantom sends after drain; a window expiry over an empty buffer sends nothing | AC-T13 |
| T99 | P3 | tests/subagent-extension.test.ts | batch renderer + fallback | batch message: failed + completed-exit-1 cards styled error, aborted warning, clean success (single-path classification); details-less message → plain body box | AC-T14 |
| T100 | P3 | tests/subagent-extension.test.ts | dep overrides | `batchWindowMs: 0` batches same-tick arrivals; `batchMaxCards: 2` → 5-burst → lead + 2 + 2, empty expiry silent | AC-T10 |
