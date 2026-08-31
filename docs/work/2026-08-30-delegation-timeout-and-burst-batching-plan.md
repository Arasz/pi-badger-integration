# Plan: pbi-delegation-timeout-and-burst-batching

**Status: PLANNED.** Author: architect (low-effort loop, single agent; a second agent reviews
this plan before implementation). Implements the two items the parent plan deferred
(`docs/plans/2026-interactive-subagent-delegation.md` §10 ledger item 3, L124): optional
per-run `timeoutMs` (review A12) and followUp burst batching for near-simultaneous
completions (review CR11, threshold "panels exceed ~6"). Both live in `extensions/subagent/`.

Parent rulings inherited: R4 (frozen log contract), R5 (exactly one notification per run,
8 KB card cap T71, double-close pin T70), R6 (tool surface), R8 (kill paths), R10
(reconstruction), CR10 (shutdown drops notifications). Nothing in this plan reopens them.

## 1. Rulings (the four unknowns, decided)

### RR1: `timeoutMs` param shape

`timeoutMs?: number` on the `delegate` tool only. `delegations wait` keeps its existing
`timeoutMs` with its existing meaning (give up waiting, resolve snapshots); overloading the
name with a third meaning on that tool would confuse callers for zero gain, and `wait`
already covers "bound how long I block".

Validation lives in one pure helper, `clampRunTimeoutMs`, exported from `index.ts` next to
the schema it serves: `undefined`, non-finite, or `<= 0` means no timeout (default behavior
is unchanged); any positive value is raised to a 1000 ms floor and capped at
`RUN_TIMEOUT_MAX_MS = 86_400_000` (24 h) — an upper bound is mandatory because `setTimeout`
clamps delays above 2^31-1 ms to 1 ms (review-verified in Bun: `setTimeout(fn, 2**32)` fires
in ~62 ms), so an uncapped "5e9 ms" timeout would silently miskill the child instantly. The
floor/cap are clamped, not rejected, matching the two numeric bounds the status surface
already clamps (`clampWaitMs`, `clampLogTailBytes`); the applied value is observable on the
record, so a raised floor or capped value is never silent. The same clamp runs at the
timer-creation site in the runner (S5: the runner also accepts `RunRequest.timeoutMs`
directly — test and registry paths must not bypass the bound). The param description states
the floor, the cap, the kill path, and that the clock starts at spawn.

### RR2: timeout settle semantics

The timeout reuses the existing `aborted` terminal state, `settleKind "aborted"`, and the
R5 aborted shape (no `exitCode`). It is distinguished only by new additive optional fields:
`DelegationRecord.abortReason?: "timeout"`, `DelegationRecord.timeoutMs?: number` (the
applied, clamped value), and `DelegationNote.abortReason?: "timeout"`. No new
`DelegationState`: the R4 log format is frozen, so reconstruction could never recover a new
state from a log, and a state that exists only until the session ends is not a state.

Surfaces (durations render through `formatDuration`, which zero-pads seconds — `60000` is
`"1m00s"`, never `"1m0s"`; the verdict names the applied **limit**, not the elapsed runtime,
because `durationMs` includes queue wait — `record.startedAt` is request time by design
(delegation-registry `start()` L231) — so a run queued 10 min then timing out 1 min after
spawn must not render "timed out after 11m00s" against a 1m00s limit):

- verdict line (notification): `Delegation d-2 (architect) timed out (limit 1m00s) and was
  aborted.`
- `describeRecord` (list/wait output): `aborted (timeout)`; **and** `DelegationStatusRun`
  gains `abortReason?` so `renderRunLine` (delegation-core) renders the same — the panel and
  session_start reconstruction go through core, not `describeRecord`; without this the panel
  would keep plain `aborted` while list/wait says `(timeout)`.
- blocking result content: `delegation to "X" timed out (limit 1m00s) and was aborted`.
- description text: the sentence "There is no automatic per-run timeout" is removed from all
  three places it appears today (delegate tool description, `delegations` tool description,
  and the `background` param description, where it never belonged) and replaced with the
  real semantics.

Reconstruction after a restart classifies a timed-out run's log as `lost`, identical to a
user abort. Documented, pinned by T105, not "fixed".

### RR3: batching trigger, latency, and message shape

Lead-immediate + fixed coalesce window + batch size cap. The first note of a quiet period is
delivered immediately (zero added latency; the v1 single-completion path is byte-identical).
A window of `BATCH_WINDOW_MS = 2000` opens after that lead; notes arriving while it is open
are held. Held notes flush when the window expires or the batch reaches
`BATCH_MAX_CARDS = 6`, whichever comes first. A capacity flush does not close the window.
Both constants are injectable via `SubagentDeps` (`batchWindowMs`, `batchMaxCards`; a 0 ms
window is legal and is the test fixture idiom, mirroring `escalateAfterMs: 0`).

Burst math: n near-simultaneous completions produce `1 + ceil((n-1)/6)` messages. A 7-panel
burst costs 2 turns instead of 7, which is what CR11 asked for.

A count threshold on *arming* was rejected: the first ~6 deliveries would already have fired
as their own turns before any threshold noticed them, so it collapses nothing. The "~6"
belongs on batch size, not on the trigger. A pure debounce (hold everything, including
singles) was rejected because it taxes every isolated completion and would rewrite the
committed T69/T70/T71 notification rows for no benefit.

Batched message: same `customType: "delegation-result"`; content is the per-card contents
joined with `"\n\n———\n\n"`; `details: { batched: true, notes: [...] }`. Each card is capped
to `floor((NOTIFICATION_CAP_CHARS - (n-1) * sep.length) / n)` via a budget parameter added to
`notificationContent`/`capIntoBudget` (single-card calls keep the current default). Together
with the 6-card cap this keeps the whole message at or under 8 KB (T71) for any n. A flush
of exactly one held note renders as a normal single card with no batch flag.

The renderer branches on `details.batched`: one box, each card's verdict line styled by that
card's own state using the **same classification as the single-card path** (`state ===
"failed" || (state === "completed" && exitCode !== 0)` -> error, aborted -> warning, else
success — a `completed, exitCode 1` card in a batch must render error-styled, not success),
divider between cards. Without details it falls back to the plain body box. `capIntoBudget`'s
degenerate-fallback wording ("over the 8 KB card budget") is parameterized on the budget so
it stays truthful under the ~1.3 KB per-card batch budgets.

### RR4: where the timeout timer lives

In the runner. `RunRequest` gains `timeoutMs?`; the value is re-clamped at the timer-creation
site (never trust the caller's clamp — direct-runner and registry paths both land here);
the timer arms after a successful spawn and
expiry calls `abortRun`, which is R8's existing kill path (SIGTERM -> grace -> SIGKILL).
There is no second kill implementation. The timer is cleared in `onClose` and in
`finishSettle`. The registry change is pass-through only: `StartRequest.timeoutMs` rides
`queuedRequests` into `runner.run`. The clock starts when the child spawns, not while queued;
the timeout guards a runaway child, queue wait is admission's business and already visible
on the receipt.

Shutdown cannot race the timer (CR10): `shutdown()` aborts every live run before any timer
can matter, the settled guard absorbs a late fire, `finishSettle` clears the timer, and the
registry's stopped guard drops any shutdown-era notify. Test determinism: fixtures pass a
small positive `timeoutMs` and drain macrotasks, exactly the `escalateAfterMs: 0` idiom; no
fake-timer library.

### RR5: R4 accounting consequence (decided and documented)

A timed-out run is killed through `abortRun`, so its log ends with the run header, the tee'd
stream, and any stderr lines, but no `exit` line. The recording contract — implemented by
ai-badger 0.149.0's `pi_session_source.delegation_usage` (PR #455; it records iff an `exit`
OR `agent_settled` line exists, the M1 settled-marker ruling) — therefore records **no
tokens for a timed-out run; timeout behaves exactly like abort for accounting**. Caveat: the
spent tokens stay readable in the log file only while the child actually closes (the stdout
tee is written in `onClose`); real children always die to SIGKILL, so this is a
fixture-only caveat. Accepted. The log format and the parser are not touched. The
consequence is stated as the contract in the `index.ts` header comment and pinned by T105.

### RR6: R5 uniqueness under batching

Batching sits in `index.ts`'s `deliverNote`, below the registry's notification wire. The
runner's settled guard (one note per run) and the registry's stopped guard are untouched.
The hold buffer is keyed by note id, and each note is delivered exactly once: as the lead
card or inside exactly one batch. T70's double-close pin is unaffected.

No ADR is filed: no cross-cutting dependency, no layering change, no tech swap. This
document is the decision record.

## 2. Context map

| Pkg | Primary files | Tests | Patterns to follow |
|-----|---------------|-------|--------------------|
| P1 | `delegation-runner.ts` (`RunRequest.timeoutMs`, `RunState.timeoutTimer`, arm/clear/expiry, record + note `abortReason`), `delegation-registry.ts` (`StartRequest.timeoutMs` pass-through) | `tests/delegation-runner.test.ts` | FakeChild records signals, sync close; `escalateAfterMs: 0`; injected `now`; additive optional fields like `spawnError` |
| P2 | `index.ts` (`clampRunTimeoutMs`, `DelegateParams.timeoutMs`, description strings, `notificationVerdict`, `blockingContent`), `delegation-status.ts` (`describeRecord`, `delegations` description), `delegation-core.ts` (`DelegationStatusRun.abortReason?`, `renderRunLine`) | `tests/subagent-extension.test.ts`, `tests/subagent-status.test.ts`, `tests/delegation-core.test.ts` | fake-pi handlers-map harness; description-string pins (T75 style); verdict functions are exported and pure |
| P3 | `index.ts` (`deliverNote` batch machine, budget param on `notificationContent`/`capIntoBudget`, `composeBatchContent`, renderer batch branch, `session_shutdown` flush) | `tests/subagent-extension.test.ts` | `notes` ring buffer untouched; `pi.sendMessage` capture assertions; macrotask drains |
| P4 | cross-feature tests in both suites; docs (see §6) | both suites + `tests/delegation-core.test.ts` | classifyFromLogDir pins (rows 14-17) |

Edit sequence: P1 -> P2 -> P3 -> P4, each ending in a commit with its tests green. Every NEW
row is witnessed RED before its implementing commit (house protocol from the tests doc).

## 3. Serialisation

Both features touch `index.ts`, so P2 and P3 must never run in parallel. Recommended order
for the single-agent loop is strictly serial P1 -> P2 -> P3 -> P4. P1 and P3 are
file-disjoint (runner/registry vs `index.ts`) and may run in parallel if two lanes exist.
P2 lands before P3 because P3's card-content assertions build on P2's timeout verdict
strings. P4 last, as the integration gate.

## 4. Packages, ACs, and the test list

New rows continue the committed table's numbering (T79+) and are appended to
`docs/plans/2026-interactive-subagent-delegation.tests.md` as a "deferral rows" section in
the same commit as the code that satisfies them.

### Pkg P1: timeout core (runner + registry pass-through)

ACs:
- **AC-T1** Expiry reuses the R8 kill machinery exactly; no second kill implementation. Proven by T79.
- **AC-T2** A timed-out run settles `aborted` with `abortReason: "timeout"`, no `exitCode`, exactly one note; a user abort still wins and carries no marker. Proven by T80, T82.
- **AC-T3** No late timer effect after a natural close. Proven by T81.
- **AC-T4** Shutdown settles beat the timer and notify nothing (CR10). Proven by T83.
- **AC-T5** `timeoutMs` passes through the queue; the clock starts at spawn; a pre-aborted signal arms nothing. Proven by T84, T85.

| id | file | test | arrange -> act -> assert | red-first |
|----|------|------|--------------------------|-----------|
| T79 | runner suite | timeout expiry kills through the abort path | run `timeoutMs: 5`, `escalateAfterMs: 0`, child ignores kills -> drain -> signals `["SIGTERM","SIGKILL"]`, state aborted | NEW; mutation: direct settle or a second kill path -> signals missing/wrong -> red |
| T80 | runner suite | timeout settles aborted with marker, no exitCode, one note | `timeoutMs: 5` -> drain -> one note, `state "aborted"`, `abortReason "timeout"`, no `exitCode` key; record mirrors both fields | NEW; mutation: plain abort without marker -> red |
| T81 | runner suite | natural close clears the timer | `exit(0)` before expiry -> drain past expiry -> completed note, `signals: []` | NEW; two separate mutations, one at a time: (a) remove clearTimeout -> late kill -> red; (b) remove the settled guard alone -> red |
| T82 | runner suite | user abort wins; late timeout fire is a no-op | `abort()` first, `timeoutMs: 5` -> drain -> one aborted note without `abortReason`, SIGTERM once | PIN (green now; mutation-validate against the new path) |
| T83 | runner suite (registry) | shutdown with an armed timeout notifies nothing | registry, start `timeoutMs: 5`, `shutdown()` pre-expiry -> drain -> notes empty, no sends | NEW; mutation: timeout path bypassing the stopped guard -> red |
| T84 | runner suite (registry) | queued run inherits timeout; clock starts at spawn | cap 1; second request `timeoutMs: 5` queued; settle first -> second spawns -> drain -> second aborted with marker; first child never signaled | NEW; mutation: timer armed at `start()` -> queued run aborted before spawning -> red |
| T85 | runner suite | record carries the applied timeout; pre-aborted signal arms nothing | running `record.timeoutMs` equals the request value; already-aborted signal + `timeoutMs` -> aborted note, spawnFn never called, no signals | NEW |

### Pkg P2: timeout surfaces (tool schema, descriptions, rendering)

ACs:
- **AC-T6** `delegate` accepts optional `timeoutMs`, floored at 1000 ms, 0/omitted = off, default unchanged. Proven by T86, T87.
- **AC-T7** Every settled-run surface distinguishes a timeout: verdict line, list/wait line, blocking content. Proven by T88, T89, T90.
- **AC-T8** The "no automatic per-run timeout" claims are gone; both descriptions and the schema describe the real semantics. Proven by T91.

| id | file | test | arrange -> act -> assert | red-first |
|----|------|------|--------------------------|-----------|
| T86 | extension suite | clamp bounds | undefined/NaN/Infinity/0/(-5) -> undefined; 100 -> 1000; 90000 -> 90000; 2**32 -> RUN_TIMEOUT_MAX_MS (timer-overflow guard, review M1) (pure) | NEW |
| T87 | extension suite | schema accepts and clamps at the boundary | execute with `timeoutMs: 100` -> registry receives 1000 (`record.timeoutMs`) | NEW |
| T88 | extension suite | timeout verdict line | note `{state:"aborted", abortReason:"timeout", durationMs:60000}` -> exact string `Delegation d-2 (architect) timed out (limit 1m00s) and was aborted.` (formatDuration zero-pads: `60000` is `1m00s`; verdict names the limit, not elapsed — durationMs includes queue wait) | NEW |
| T89 | status + core suites | list/wait and panel render the timeout | record with `abortReason "timeout"` -> describeRecord line ends `aborted (timeout)`; `renderRunLine` on a `DelegationStatusRun` with `abortReason` renders the same (panel + reconstruction path) | NEW |
| T90 | extension suite | blocking result names the timeout | `background:false`, `timeoutMs`, drive expiry -> content contains `timed out (limit 1m00s) and was aborted` | NEW |
| T91 | both suites | description text updated | delegate + delegations descriptions no longer contain "no automatic per-run timeout"; both name `timeoutMs`; background param sentence removed; new param description states floor, kill path, queued clock | NEW (red immediately: the old strings are live) |

### Pkg P3: burst batching (notification wire)

ACs:
- **AC-T9** An isolated completion behaves exactly as v1. Proven by T92.
- **AC-T10** Bursts collapse to `1 + ceil((n-1)/6)` messages with the lead immediate; capacity flush keeps the window; dep overrides make fixtures deterministic. Proven by T93, T94, T96, T100.
- **AC-T11** A batched message never exceeds 8 KB (per-card budgets + count cap). Proven by T95.
- **AC-T12** Per-run uniqueness survives batching (R5/T70 at note level). Proven by T97.
- **AC-T13** Shutdown flushes the held batch once, then silence. Proven by T98.
- **AC-T14** The renderer draws batches correctly; the single-card path is untouched. Proven by T99.

| id | file | test | arrange -> act -> assert | red-first |
|----|------|------|--------------------------|-----------|
| T92 | extension suite | isolated completion unchanged | one child exit -> one sendMessage, v1 customType/content/deliverAs/triggerTurn | PIN (must stay green through the change) |
| T93 | extension suite | second same-tick completion held, flushed as a normal card | two exits same tick -> 1 send before drain, 2 after; second has no batch flag, is a single-note card | NEW |
| T94 | extension suite | three-note burst -> lead + batched message | three exits same tick -> 2 sends; second `details.batched`, `details.notes` ids = runs 2,3 in settle order | NEW |
| T95 | extension suite | batch content capped at 8 KB | 6 held notes, each with a 10 KB answer -> flush -> `content.length <= 8192`, every card carries a drop marker, 6 verdict lines each exactly once | NEW |
| T96 | extension suite | capacity flush keeps the window open | 8-note burst -> 3 sends: lead, batch of 6 (batched), single tail card | NEW |
| T97 | extension suite | per-run uniqueness across lead and batches | 8-note burst -> collect ids over all sends -> each id exactly once | NEW |
| T98 | extension suite | shutdown flushes once, then silence; empty expiry is a no-op | one lead + one held; session_shutdown -> batch send observed; further child exit -> no send; window timer cleaned; a window expiry over an empty buffer sends nothing (no empty batch message) | NEW |
| T99 | extension suite | batch renderer + fallback | batch message with one failed card and one `completed, exitCode 1` card -> both styled error (single-path classification incl. exited-N), aborted card warning, clean card success; message without details -> plain body box | NEW |
| T100 | extension suite | dep overrides | `batchWindowMs: 0` batches same-tick arrivals; `batchMaxCards: 2` -> 5-burst -> lead + 2 + 2 | NEW |

### Pkg P4: integration + documentation (mandatory last)

ACs:
- **AC-T15** Timeout and batching compose: a timeout fires inside an open window and its card rides the batch; a mixed burst carries exactly one timeout verdict. Proven by T101, T102.
- **AC-T16** `wait` resolves at a timeout settle; its own bound is unaffected. Proven by T103.
- **AC-T17** The shutdown race is closed across both features. Proven by T104.
- **AC-T18** The RR5 accounting consequence is documented and pinned. Proven by T105 plus the doc deliverables in §6.
- **AC-T19** Gates green; the committed tests doc carries rows T79-T105. Proven by the gate run.

| id | file | test | arrange -> act -> assert | red-first |
|----|------|------|--------------------------|-----------|
| T101 | extension suite | timeout fires during an open batch window | child A exits (lead), child B times out inside the window -> flush carries B's card with the timeout verdict | NEW |
| T102 | extension suite | mixed 7-run burst with one timeout -> 2 messages | 7 exits same tick, one via its own `timeoutMs` -> lead + batch of 6; exactly one "timed out" verdict among the 7 cards | NEW |
| T103 | runner suite | wait + timeout interplay | `registry.wait([id])` pending -> timeout fires -> snapshot `aborted` + `abortReason`; a second wait still resolves snapshots on its own timer | NEW |
| T104 | extension suite | shutdown race end-to-end | armed timeout + pending batch + session_shutdown -> held batch flushed exactly once, no timeout notes after, no sends post-shutdown | NEW |
| T105 | core suite | timed-out run's log classifies lost (RR5 pin) | header + stream lines, no `exit` line, pid dead -> `classifyFromLogDir` -> `lost` | PIN of the documented consequence |

## 5. Size and gates

Roughly 250-350 implementation LOC and 600-700 test LOC against the existing suites. Every
package: `bun run test` + `bun run typecheck` green at its commit, then commit (local
commits; sourceControl.platform=none). No publish-surface change: no new tool names, no new
`--exclude-tools` entries, no new files in the extension dir, so `publish.ts` needs no edit.

## 6. Documentation deliverables (land with P4)

1. `extensions/subagent/index.ts` header: one paragraph stating RR5 (timed-out runs settle
   aborted, write no `exit` line, and are therefore not recorded by ai-badger's
   `delegation_usage`; tokens remain readable in the log file).
2. `docs/plans/2026-interactive-subagent-delegation.tests.md`: append the T79-T105 rows as a
   deferral section (the committed table stays the single source of truth).
3. `docs/plans/2026-interactive-subagent-delegation.md` §10 ledger item 3: mark landed,
   pointing at this file.
4. `docs/plans/2026-interactive-subagent-delegation.manual-evidence.md`: append a manual row
   for batched-card rendering in a real TUI (unit-pins cannot see the actual renderer box) —
   trigger a 3-run burst in a live session and witness one batched message.

## 7. Non-goals

- No change to `delegations wait` semantics or its `timeoutMs`.
- No queue-starvation timeout; queue position and abort already cover it.
- No new terminal state; no log-format or parser change.
- No batching of receipts or queued-position notices; completion notes only.
- No user-facing config for the two batching constants; dep overrides are for tests.

## 8. Risks

- Window timers in tests rely on macrotask drains; `batchWindowMs: 0` keeps them
  deterministic under the existing no-fake-timer convention.
- The batched `details` shape is new under an existing `customType`; the renderer branches
  on `details.batched` and falls back to the plain body, so a details-less message degrades
  safely.
- Blocking mode plus `timeoutMs` resolves the pending execute at the settle; existing
  blocking rows (23-25, T59) are untouched, and T90 drives the full path to confirm.
