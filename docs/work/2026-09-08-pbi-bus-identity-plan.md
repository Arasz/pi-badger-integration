# Plan — pbi-bus-identity-delegation-skip-fix (reviewed, v2)

Task: Bus identity + delegation-skip fixes P1–P5. High-effort.
Research: docs/work/2026-09-08-bus-identity-and-delegation-skip-report.md (F1–F6, P1–P5).
Baseline (measured 2026-09-08, worktree): `bun test tests/message-bus/` 45 pass / 0 fail / 90 expects (~43 ms) green;
`bun run typecheck` red at baseline — 9–10 errors ALL in extensions/pi-mcp-tools/* (missing @sinclair/typebox, @modelcontextprotocol/sdk).
Message-bus files typecheck clean. Full `bun run test` NOT a gate (delegator measured 5 fail pi-mcp-tools + 3 typebox errors at baseline).
Live F4 re-probe (direct/project/machine/self) is post-ship manual evidence ×2, explicitly NON-GATING (n=1 flaky).

## MoE history
- Plan MoE: architect d-608 (6 pkgs, serial lane, test files per P) + code-reviewer d-609 (3A/3B split, S1–S8 map, fail-open) + qa d-610 (~30-test table, RED/gate-break).
- Plan-review MoE: delegator d-611 NOT-READY + architect d-612 READY-WITH-FOLDS + test-engineer d-613 READY-WITH-FOLDS.
- Verdict after folds: READY. Collaborator 01a08155 (jsaa) pinged #700, no reply yet — fold if arrives before impl review.

## MUST folds applied (all three reviewers)
1. P1-error vs P3-warn (arch MUST-1): numeric-id lookup miss → error `no message #<n>`; resolved direct target with no identity row → success + warning. Includes reply-to-dead-sender (F1 replay #682-style) warns, does not error; ack path untouched.
2. Shared result contracts (arch MUST-2): `details` additive-only (existing keys stable, warning additive; assert with toMatchObject); identity header lives in wiring OUTSIDE `formatList` (core tests frozen); co-order fixed: header first, warning line, then body.
3. PKG-4 store contract (arch MUST-3 + qa MUST-4): `deliverDirectForSession` (real + fake + sqlite helper) returns dropped counts or exposes them; `composeDirectStartNotice(messages, stats?)` backward-compat (absent stats → today's text); summary oracle names both counts; gates cover window-drop, cap-drop, broadcasts-only. Broadcasts-only startup NOW appends a user-only entry (no agent card, no turn) — intentional change to existing `broadcasts only: silent` test, flagged in-PR with reason.
4. P5 spike-or-cut (all three): NO P5 implementation until seam spike proves hook + pattern + sink. PKG-5 is a SPIKE (concurrent, isolated), not a gate for integration.
5. PKG-6 row list (arch MUST-5): happy-path triangle (reply→warn+header); warn+header co-present; fail-open under broken DB; ack-terminal unchanged with reply present; past-MAX landing preserved with upsert+counts on same start.
6. Gates re-scoped (delegator MUST + qa MUST-6): per-package `bun test tests/message-bus/` + verify no NEW typecheck errors in message-bus files (whole-project tsc stays red at baseline, pi-mcp-tools exempted). Full suite only at integration for info, never a gate. RED-proof + break-every-gate obligations stay.
7. Real-line anchors (delegator MUST): ToolParams index.ts:517-531, execute 533-575, runDirectStart 445-492, BUS_DDL 162-183, BusStore 96-110, core:162 (formatList). No fictional S-labels in ACs. S0 shared helper (fakeStore + sqlite helper: identity rows, dropped counts, whoami seam) lands FIRST in P3; lanes consume, never fork.
8. P3 single package (delegator MUST): fold 3A+3B → one PKG-3 with subpackages 3A (DDL/store/upsert) + 3B (wiring warnings/shape/self-send). 3A alone is NOT shippable. recordIdentity/hasIdentity OPTIONAL with specified fallback + fallback test proving old fake (extension.test.ts:24) still sends. Upsert best-effort inside deliver transaction where possible, never a second blocking open; upsert-throw still delivers (fail-open test).
9. Reply guards (delegator MUST + qa MUST-1): refuse reply-to-ack (terminal parity with buildAckContent) + reply-to-own; buildReplyTargets session-wins (targetProject NULL per D3 normalizeSendTargets); own-refusal test plants own-row in fakeStore.inbox (not sqlite); receipt asserted by contains + details, never exact-equality; pure + wiring pair for buildReplyTargets.
10. P2 honesty (qa MUST-2): whoami empty-identity case; header asserted by contains; two-value or sid8-truncation anti-tautology; details.cursor secondary asserted.
11. P3 tests (qa MUST-3): unknown-id + self-send assert rowId + warning text + details triple with sent.length pinned; shape rejection scoped to sessionId AND projectId, blank→unset vs $(…)→error distinguished; sqlite-backed upsert/lookup; broadcast-does-not-hit-registry; registry-write-failure fail-open.
12. isValidBusId rules: after normalizeSendTargets; reject whitespace / `$(` / backtick / newline; blanks → unset (NULL). #672 `$(cat…` regression pinned. Unknown-project warnings OUT of scope.

## Packages (final)
- PKG-1 P1 reply: core buildReplyTargets + index reply literal (517-531) + reply case (533-575) reusing P3 warning helper. Tests: message-bus-reply.test.ts (C-P1-1..3 pure + E-P1-1..5 wiring). Gate: scoped test + no-new-tsc.
- PKG-2 P2 identity: core header helper + whoami + list/check prepend. Tests: message-bus-identity.test.ts (C-P2-1 + E-P2-1..4). Gate: same.
- PKG-3 P3 validation (3A+3B single lane): BUS_DDL bus_identities (162-183) + BusStore recordIdentity/hasIdentity optional + sqlite impl + isValidBusId + send shape/self/unknown warnings + session_start upsert + publish.ts untouched (no new ext). Tests: message-bus-validation.test.ts (C-P3-1 + E-P3-1..5) + sqlite S-P3-1..2. Gate: same. OWNS S0 helper.
- PKG-4 P4 startup: runDirectStart (445-492) + MessageBusStartCardData (:35) + core stats? param. Tests: message-bus-startup-counts.test.ts (C-P4-1..2 + E-P4-1..2 + S-P4-1..2). Gate: same + existing broadcasts-silent test updated with cited reason.
- PKG-5 P5 SPIKE (isolated, concurrent, non-gating): quote tool_call payload for bash spawn (event name, bash toolName, command-string field) from extensions/session-signals/index.ts:163, monitor/index.ts:873, subagent/delegation-status.ts:539; propose pi-spawn regex + true/false-positive matrix (must NOT fire on pip/publish.ts/nohup legitimate per F6); name file target + EXTENSION_DIRS (publish.ts:70) entry + notify/record surface + advisory-only proof. Output: spike report, NO implementation unless seam proven. Tests: none writable until spike (qa MUST-5).
- PKG-6 integration LAST: message-bus-integration.test.ts (5 rows §MUST-5) + scoped suite + no-new-tsc. Depends: PKG-1..4. PKG-5 explicitly NOT a dependency.

## Parallelism / ownership
- Shared index.ts (715 lines) wiring serial: land order 3 → 1 → 2 → 4 → 6 (delegator SHOULD; signature/header-first justification: P3 helper + S0 unblock all; P4 last touches different section 445-492/:35).
- Disjoint test files may be written ahead (parallel test-design), but wiring lands serial — one impl lane owns index.ts at a time.
- PKG-5 spike concurrent anytime (own worktree/branch, new files or read-only; names isolation).
- Out-of-scope: python store changes, ack semantics (except the F7 ack-body stub: `ack: #<id> — terminal, no reply expected`, metadata-only, zero body bytes), push-wake redesign, SKILL.md:154 tightening (cross-repo follow-up to file), unknown-project warnings.

## Per-package AC × verifier (excerpt — full table in qa d-610 + folds above)
- P1: reply targets sender (pure swap→red) + wiring ignores decoy id in content (content-parsed→red) + receipt contains sid8 + details + own/unknown/ack refusals with zero inserts.
- P2: whoami sid+pid+cursor (constant→red) + list/check first-line header contains + empty-identity fail-open + deps-injectable (hardcode→red).
- P3: shape table both directions + unknown success+warning triple + known silent + shape-reject pre-insert zero-inserts + self-send warn triple + upsert idempotent + sqlite DDL round-trip + broadcast-no-registry + registry-failure fail-open.
- P4: exact-count oracle `n older directs and m broadcasts` + zero-drop byte-identical + clock-controlled wiring counts + ids semantics pinned (delivered directs only) + confirm-no pi.sent empty + non-degenerate fixtures (>16, mixed ages).
- Integration: 5 rows listed above, all green on combined tree.

Top-level AC: all packages' ACs checked + met (each with command output, not claims).
