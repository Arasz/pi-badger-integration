## Verdict

**READY-WITH-FOLDS** — the plan can prove the user's claim if executed from the consolidated plan + verification annex (where the (c) probe is a required gate), but the falsification table has one oracle that cannot fail as written (F3c), the pbi annex demotes the only oracle for (c) to "corroboration", the verification annex's test-impact list contradicts the chosen index-9 tail placement (L0-5), and F4's `validate --all` clause is false for the natural mutation. All are correctable without redesign.

Paths: `PBI` = `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-deepseek-v41-flash-delegation-default`, `FW` = `/Users/arasz/RiderProjects/ai-badger/.ai-badger/worktrees/aib-deepseek-v41-flash-medium-default`.

---

**MUST — F3c is a change-detector; its mutation cannot red the matrix as claimed.**
Evidence: `PBI/tests/subagent-level-integration.test.ts:42-43` defines `MED_PREF/HIGH_PREF`; the **same constants** feed both the project registry written by `canonicalProjectFile` (`:56-63`) and the matrix expectations (`:178-186`). Mutating the constants moves fixture and oracle in lockstep → green, always. Post-change this is worse: frozen medium/high will equal the constants (deepseek), so even a production regression that ignores the project file and resolves from `FROZEN_MODEL_GROUPS` produces the same argv → still green. The only project-vs-frozen discriminator is join-7a's DISTINCT-low sentinel (`:84-89`), which calls `delegationArgs(..., loaded.registry)` directly and never goes through the delegate tool's own `loadModelGroups(toolCwd)` path.
Concrete change: replace F3c with a mutation that is observable — e.g. extend `runDelegate`'s project file with a DISTINCT low id and assert the spawn carries it (a fallback-to-frozen bug then reds), or derive matrix expected values from literals/ADR rather than the same constants. Otherwise drop F3c and record that project-path coverage rests on 7a + B4's `source === "project"`.

**MUST — the pbi annex calls the only oracle for deliverable (c) optional; the consolidated plan calls it required.**
Evidence: `plan-pbi.md` (Refresh): "…the probe is corroboration, not a gate." Same annex earlier concedes "No test reads the repo's own `.ai-badger/model-groups.json` … the refresh is not a test dependency." Versus `plan-verification.md` B4: "This is the only check of pbi's *committed* `.ai-badger/model-groups.json`"; `plan.md` synthesis: "That makes probe 3 a required gate, not optional corroboration"; `plan.md` PKG-I AC3. Verified: `PBI/tests/` writes only tmp-dir registries (grep `model-groups` in tests shows only `:52`, `:50:50` writes; no repo-file read).
Concrete change: delete the "not a gate" sentence in `plan-pbi.md` and cross-reference PKG-I AC3; or promote the probe to a committed pbi test (the R8 "red between framework release and refresh" trade-off noted).

**SHOULD — verification annex's L0-5 "needs no change" is false under the chosen index-9 tail.**
Evidence: `plan-verification.md` A2: "`:166` L0-5 is fixture-only and needs no change". But the chosen placement (plan.md synthesis; framework annex step 4) appends the demoted contributor at index 9, so `FW/tests/test_model_groups_registry.py:175` `assert groups["medium"][-1]["id"].endswith("claude-sonnet-5")` reds. `plan-framework.md` already prescribes the fix (`deciding = [...]; deciding[-1]`), matching the high L0-6 shape. The two annexes disagree because the verification list was written for the alternative insert-before-sonnet-5 placement.
Concrete change: update A2 to mirror the framework annex (or state the placement assumption explicitly in A2).

**SHOULD — F4's `validate --all` clause is wrong for the natural mutation.**
Evidence (ran in-memory, no file writes, `FW/features/common/skills/task/scripts/model_groups.py`): proposed doc → 0 medium errors; clean revert of medium to today's order → **0 total errors**; duplicate-reorder variant (id reverted at [0], demoted tail left) → duplicate id + weights-evidence errors. The validator's preferred-first check only tests `flags[0]` and `_validate_order` skips demoted members (`model_groups.py:117-144, 214-244`), so "preferred-first/price-order" is not what reds. The L0-11 claim (hand-written literal list, independent of the JSON) holds.
Concrete change: rewrite the mutation as "revert the id but leave the demoted tail → expect duplicate-id red", or drop the validator clause; keep the L0-11 assertion claim.

**SHOULD — three ACs are claims, not commands, in violation of the plan's own rule.**
Evidence: (1) `plan.md` PKG-F AC1 "the now-false HIGH-tail evidence sentence is corrected" — grep finds the sentence only in the two `model-groups.json` files, no test; the framework annex itself says "nothing tests it". (2) same AC "`registryVersion` stays 1" — validator only requires int ≥ 1; no test asserts 1. (3) `plan.md` PKG-P AC1 "docstring + `source` note name the ai-badger canonical" — tests assert `loaded.source` (`PBI/tests/subagent-model-level.test.ts:60,73,91,111`), never `FROZEN_MODEL_GROUPS.source`.
Concrete change: add three cheap assertions — e.g. in L0-11 `assert groups["medium"][-1]["evidence"]` names the weightsId and `"remains medium's preferred" not in groups["high"][-1]["evidence"]`, `assert json.loads(seed)["registryVersion"] == 1`, and `expect(FROZEN_MODEL_GROUPS.source).toContain("ai-badger canonical")` — or restate these ACs as explicit checklist items outside the command-evidence rule.

**INFO — F7 understates its red set, and copy parity is groups-only.**
Evidence: mutation 1 ("bump VERSION, not canonical frameworkVersion") also reds `FW/tests/test_model_groups_registry.py:341-342` (canonical version vs VERSION), not just `:204`. `:212` compares `shipped["groups"] == seed["groups"]` only, so `measuredAt`/`source`/`registryVersion` drift between the two copies is unpinned unless `validate` cares (it doesn't). Note both in the row; decide whether full-doc parity is intended.

**INFO — the 7b fixture docstring claims rotation detection it does not have.**
Evidence: `FW/tests/test_model_tiers_integration.py:278-281` — "The REAL delivered registry — no fixtures; a rotated pin reds this file." The four `test_matrix_*` rows (`:283-303`) are content-blind (`resolve == preferred`, explicit pin, absent, unknown); a rotated pin keeps them all green. Rotation detection in that file comes from the advisory-table test, not this fixture. Change: reword the docstring or add one content assertion.

**INFO — (c) has only a one-shot oracle.**
The B4 probe is sufficient for this task's claim (asserts `source`, `frameworkVersion`, both ids) but leaves no durable guard after merge; `plan-pbi.md` R8 already arbitrates against adding a frozen↔repo test without a cadence. Record explicitly that (c) is proven once, and that B5's `git diff` review is inspection, not a command.

**INFO — minor row nits.** F9's true precedence site is `PBI/extensions/subagent/delegation-core.ts:1254` (`resolveDelegationModel`); the queue `:339-347` only consumes it — the mutation is executable, the cite suggests the wrong edit site. F5's "revert the fixture's preferred" is ambiguous between a clean pre-change fixture (assertion red, as claimed) and an id-swap that leaves the appended demoted tail (duplicate → `_load` raises, a red for a different reason). The advisory spend column is not parsed (`:193-201` captures only tier/shorts), so the proposed `$0.027 → $0.44` cells are unchecked.

---

## Checked-clean

- **F1/F2 executable and exact**: `PBI/tests/subagent-model-level.test.ts:124-125` (2 literal assertions) and `PBI/tests/subagent-queue-model-level.test.ts:117,142` are the only id assertions on the mutated values; queue harness writes no registry (`:49-70`), confirming the frozen path. Baseline confirmed: `bun test` → **57 pass**.
- **F3a/F3b executable and exact**: frozen-only mutation reds the 2 medium/high assertions of 7a (`:68-70`) with 7b/ADR/DISTINCT green; ADR-only revert reds only the prose loop (`:73-78`).
- **F4's core independence claim holds**: L0-11 (`:277-344`) carries hand-written id/price literals against the JSON — a real seed oracle.
- **F6 mechanics correct**: `0.168.0` medium row `spark-contributor → terra`; with the rotated registry, `hits[0]` is the demoted tail and `expected` is `deciding[0]` → red at `:251-255`. Mutation is executable.
- **F7 oracles exist and are separate**: `:204` shipped==VERSION, `:212` shipped==canonical (groups).
- **F8 negative control is real**: installed copy still carries old pins at `~/.pi/agent/extensions/subagent/delegation-core.ts:1081-1082`; B3 with `source === "frozen"` is the loaded-artifact oracle.
- **F9 executable**: precedence centralized at `delegation-core.ts:1254`; queue `:120-133` asserts explicit-wins + `levelOverride`.
- **F10 is honest**: coordinated source+literal edits stay green; the external anchors (ADR prose partial-edit tripwire, framework literals, plan probes written outside the repo) are correctly identified.
- **medium==high cross-level reuse**: no cross-group distinctness rule (`model_groups.py:106-113`; only `_validate_weights_identity` is cross-group); `test_cross_group_id_reuse_is_legal` (`:386-396`) covers it; pbi fixtures already use medium==high (`subagent-model-level.test.ts:147,151`; L1-D1 asserts both). The only differing expectation is L0-4 `:161-162`, and the plan updates it in lockstep. No targeted consumer oracle exists, and none is needed — the regression net is the full suites + consumer journey.
- **Framework baseline confirmed**: `python3 -m pytest tests/test_model_groups_registry.py tests/test_model_tiers_integration.py -q` → **111 passed**.
- **Suite gap statement is accurate**: no pbi test reads the repo's own `.ai-badger/model-groups.json`; the current file is 0.167.1 / muse-spark, and B4(i) today yields `source=project` + muse-spark, so the probe's before/after is falsifiable.
- **ACs with commands where it matters**: PKG-F AC2/AC3/AC5/AC6, PKG-P AC2/AC3/AC4, PKG-I AC1/AC2(file)/AC3/AC4 all name runnable commands or committed tests; only the four claim-shaped clauses above fall outside.