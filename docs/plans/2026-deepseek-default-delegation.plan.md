# Plan — DeepSeek V4.1 Flash as the medium+high delegation default

Task: `pbi-deepseek-v41-flash-delegation-default` (pbi) + companion `aib-deepseek-v41-flash-medium-default` (ai-badger).
Effort: **high**. Scope confirmed: **B — pbi + ai-badger**.
Research: `docs/plans/2026-deepseek-default-delegation.research.md`.
Lane annexes: `.plan-framework.md` (canonical rotation + 0.172.0 release), `.plan-pbi.md` (frozen + ADR + tests + refresh),
`.plan-verification.md` (acceptance, falsification, failure modes, local-vs-CI).

Plan-level acceptance criterion: **every package's ACs are checked and met**, where each AC is evidenced by the exact
command/probe named in the annexes — not by a claim.

## Packages

| Pkg | Repo / worktree | Deliverable | Owned files |
|---|---|---|---|
| **PKG-F** | ai-badger `.ai-badger/worktrees/aib-deepseek-v41-flash-medium-default` | canonical `medium` rotation to `openrouter/deepseek/deepseek-v4.1-flash`, tests, changelog, **VERSION 0.172.0**, self-scaffold, PR → merge → tag | `features/common/data/model-groups.json`, `tests/test_model_groups_registry.py`, `tests/test_model_tiers_integration.py`, `VERSION`, `docs/changelog/0.172.0-*.md`, `docs/changelog/README.md`, `index.json`, `.claude-plugin/*`, the self-scaffolded managed tree |
| **PKG-P** | pbi worktree `pbi-deepseek-v41-flash-delegation-default` | `FROZEN_MODEL_GROUPS` medium+high re-pin, ADR provenance, level/queue test expectations | `extensions/subagent/delegation-core.ts`, `docs/work/2026-09-06-pkg5-level-registry-adr.md`, `tests/subagent-model-level.test.ts`, `tests/subagent-level-integration.test.ts`, `tests/subagent-queue-model-level.test.ts` |
| **PKG-I** (integration) | same pbi worktree, after PKG-F merged + tagged | `den-refresh` to 0.172.0 (activates the repo's live registry), runtime probes, full suite, publish + installed-extension check | the refreshed `.ai-badger/**`, `AGENTS.override.md`, `CLAUDE.md`, `.hermes.md`, `.pi/**`, probe records |

**Parallelism.** PKG-F ∥ PKG-P — different repos and worktrees, disjoint files. PKG-I depends on **both**:
on PKG-F's released 0.172.0 (refresh content) and on PKG-P's frozen edit (same pbi branch/PR). Wave 1 = F + P;
wave 2 = I.

## Package acceptance criteria

### PKG-F
1. Canonical `medium[0]` and `high[0]` id = `openrouter/deepseek/deepseek-v4.1-flash`; displaced
   `muse-spark-1.3-contributor` is medium's demoted tail (`status: demoted`, `revisionWatch: true`); the
   now-false HIGH-tail evidence sentence is corrected; `registryVersion` stays 1.
2. `python3 tooling/validate.py --all` exit 0 (preferred-first, price order, demoted-tail, weights-identity).
3. `python3 -m pytest tests/test_model_groups_registry.py tests/test_model_tiers_integration.py -q` green **after**
   a recorded RED run of the changed expectations (before the content edit) and **after** the self-scaffold (the
   delivered-registry tests cannot be green while the mirror lags VERSION/seed — FOLD-2). Paste both runs.
4. Changelog `docs/changelog/0.172.0-medium-tier-prefers-deepseek-v41-flash.md` carries the advisory table that
   `test_model_tiers_integration.py` parses; `CHANGELOG` constant repointed; `changelog_index.py` regenerated.
5. Self-scaffold runs **after** `version_sync.py`; delivered `.ai-badger/model-groups.json` groups == canonical
   and `frameworkVersion == VERSION == 0.172.0`.
6. Release gates green (`validate --all`, `version_sync --check`, `changelog_index --check`, `index_build --check`,
   `release_guard`, `scaffold_freshness_guard`, `docs_guard`); **CI green on the PR (all workflows)** is the full-suite
   pass condition (local budget: focused registry+tiers pytest + the pre-push lane set); PR merged; tag
   `ai-badger--v0.172.0` verified on the remote.

### PKG-P
1. `FROZEN_MODEL_GROUPS` medium and high = `openrouter/deepseek/deepseek-v4.1-flash` (low unchanged); docstring +
   `source` note name the ai-badger canonical, not the retired `tiers/pkg1-registry` branch, and the docstring no
   longer claims the `frozen: true` flag feeds telemetry (FOLD-12); the `source` string is pinned by a new assertion
   in `tests/subagent-model-level.test.ts`.
2. ADR `## Frozen fallback provenance` names the new medium/high pins and the framework-canonical provenance;
   join-7a prose test (`tests/subagent-level-integration.test.ts:73-78`) passes against it.
3. RED-first evidence: with the test literals updated but `FROZEN_MODEL_GROUPS` reverted, the frozen-pin tests fail
   (model-level `:123-126`, queue `:26/:117/:142`); restored → green.
4. `bun test tests/subagent-model-level.test.ts tests/subagent-level-integration.test.ts tests/subagent-queue-model-level.test.ts`
   green (baseline 57 pass) and `bun run typecheck` exit 0.

### PKG-I
1. Precondition gate passes first **on the merged, tagged tree**: `git -C "$FW_ROOT" fetch --tags && git -C "$FW_ROOT" pull --ff-only`,
   `git -C "$FW_ROOT" describe --tags --exact-match` == `ai-badger--v0.172.0`, `$FW_ROOT/VERSION` reads `0.172.0`,
   canonical medium/high preferred = deepseek (FOLD-8). Refresh runs with explicit `--root "$FW_ROOT"`; `$FW_ROOT`
   is the main framework checkout pulled to the tag.
2. Pass condition on the materialized file: `frameworkVersion == "0.172.0"`, `medium[0] == high[0] ==
   openrouter/deepseek/deepseek-v4.1-flash`; refresh committed **separately** from the PKG-P commit.
3. Runtime probes (falsifiable, `source` asserted): frozen path (extension from the worktree, empty cwd) resolves
   deepseek for medium+high; project path (refreshed worktree root; throwaway scaffolded project) resolves
   deepseek with `source === "project"` and `frameworkVersion === "0.172.0"`.
4. `bun run test` green once; CI green; PR merged; `bun publish.ts` + `bun run check` in sync; post-`/reload`
   delegation log shows `--model openrouter/deepseek/deepseek-v4.1-flash`.

## Sequencing

1. Wave 1 dispatch — PKG-F lane and PKG-P lane in parallel (separate worktrees), TDD per package.
2. PKG-F PR: draft → ready → review round → squash-merge → verify tag. PKG-P committed/pushed on its branch
   (draft PR #26 exists; it may show CI green before the refresh).
3. Wave 2 — PKG-I after the framework tag exists: gate → refresh → probes → full suite → push; then merge PR #26
   once CI green and no review findings remain.
4. Publish + activation note (`/reload`) + bus `merged` broadcast.

## Synthesis of lane deltas (consolidation decisions)

- **Tail placement**: append the demoted contributor last (index 9), mirroring 0.168.0's "displaced preferred goes
  last". Both lanes confirmed either placement validates; append is the precedent-matching call.
- **Version**: 0.172.0, minor class (scaffold-affecting content rotation), no `BREAKING_VERSIONS` entry.
- **Frozen `registryVersion` stays 1** (an index rotation, no member/price change — same reasoning as 0.168.0).
- **`measuredAt`**: framework top level rotates to 2026-09-21; pricing evidence stays the 2026-09-11 measurement;
  per-entry `measuredAt` for the new preferred is 2026-09-21 and for the demoted tail stays 2026-09-05.
- **HIGH-tail evidence** at `features/common/data/model-groups.json:218` must lose the "remains medium's preferred"
  clause — nothing tests it, so it is an explicit checklist item for PKG-F.
- **Verification lane correction**: research F6's line cite for `validate_registry` is `model_groups.py:77`, not
  `:104`; the annexes carry the corrected cite.
- **Suite gap acknowledged**: no pbi test reads the repo's own `.ai-badger/model-groups.json`, so only the PKG-I
  probes can catch a stale/wrong refreshed file. That makes probe 3 a required gate, not optional corroboration.

## Plan-review folds (binding — override any conflicting annex text)

Three reviewers (code-reviewer ×2, test-engineer) returned READY-WITH-FOLDS. Folds, all binding on the implementation
lanes:

| id | source | fold |
|---|---|---|
| FOLD-1 | d-1334 MUST / d-1336 SHOULD | **Drop the L0-5 edit entirely.** Its fixture is synthetic; the planned `deciding[-1] == sonnet-5` assertion is false (sonnet-5 is demoted there; `deciding[-1]` is `gpt-5.6-sol`). Leave `tests/test_model_groups_registry.py:165-175` untouched — it still validates the demoted-tail exemption. |
| FOLD-2 | d-1334 MUST | **Reorder the release sequence:** RED witness → content+tests → `VERSION` + changelog → `changelog_index.py` → `version_sync.py` → **self-scaffold** → focused green run → gates. The delivered-registry tests (`frameworkVersion == VERSION`, shipped groups == canonical) cannot be green before the self-scaffold; never report a green focused run before it. |
| FOLD-3 | d-1336 MUST | **Drop falsification row F3c** — the same constants feed both the fixture registry and the matrix expectations, so that mutation cannot red. Residual recorded: project-path coverage rests on join-7a's DISTINCT sentinel plus the PKG-I `source === "project"` probe. |
| FOLD-4 | d-1336 MUST | `plan-pbi.md`'s "probe is corroboration, not a gate" is overridden: PKG-I AC3's probes (including the `(c)` refreshed-repo probe) are **required gates**. |
| FOLD-5 | d-1334 SHOULD | L0-11 adds `assert groups["medium"][0]["id"] == groups["high"][0]["id"]` and equal `pricing` (kills the "tiers rotated to different models" coordinated edit); keep sonnet-5's `status`/`revisionWatch` assertions at `medium[-2]`. |
| FOLD-6 | d-1334 SHOULD | PKG-F AC6 now requires CI green (folded above). |
| FOLD-7 | d-1336 SHOULD | F4's mutation is rewritten: reverting only the medium id while leaving the demoted tail reds via duplicate-id/weights errors, not via preferred-first/price-order. |
| FOLD-8 | d-1335 SHOULD | Precondition gate runs on the merged+tagged tree, tag exact-match asserted (folded above); `FW_ROOT` defined once = the main framework checkout pulled to the tag. |
| FOLD-9 | d-1335 SHOULD | Join-7a's ADR check is strengthened: assert the exact `- medium → \`openrouter/deepseek/deepseek-v4.1-flash\`` and `- high → …` bullet lines, not just id presence (medium==high makes the old loop blind to a half-edit). |
| FOLD-10 | d-1335 SHOULD | Refresh recovery: `git revert <refresh-commit>` is primary; managed roots for uncommitted churn are `.ai-badger/ .claude/ .github/ .pi/ AGENTS.override.md CLAUDE.md HERMES.md .hermes.md`; the review diff explicitly includes `.claude/` and `.github/`. |
| FOLD-11 | d-1335 SHOULD | Publish runs from the task worktree after `git fetch origin main && git reset --hard origin/main` (post-merge), recording `git rev-parse HEAD`; the dirty main checkout is never touched. |
| FOLD-12 | d-1335 SHOULD | Frozen docstring drops the unsubstantiated telemetry claim; state that the degraded load is marked by `source: "frozen"` plus the warning. Add `expect(FROZEN_MODEL_GROUPS.source).toContain("ai-badger canonical")`. |
| FOLD-13 | d-1334 INFO | `measuredAt`: top level `2026-09-21` (rotation date, named in `source`); the new preferred entry `2026-09-11` (the price-measurement date, mirroring 0.168.0); demoted tail stays `2026-09-05`. |
| FOLD-14 | d-1334 INFO | Expected churn list includes `.ai-badger/config.json`; L0-11 medium price list anchor is `:315-316`. |
| FOLD-15 | d-1334 INFO | Framework lane interpreter = system `python3` (worktree has no `.venv`); CI owns full `pytest`+`pylint` per test economy. |
| FOLD-16 | d-1334 INFO | Reword the 7b fixture docstring in `tests/test_model_tiers_integration.py:278-281` (it is content-blind; rotation detection lives in the advisory-table test). |
| FOLD-17 | d-1336 SHOULD | Claim-shaped ACs get cheap oracles where they matter: the L0-11 `registryVersion == 1` assertion; the FROZEN `source` assertion (FOLD-12). The HIGH-tail evidence correction and docstring truth remain explicit checklist items verified by diff inspection in the lane report. |

## Falsification plan (summary — full table in `.plan-verification.md`)

Every new/changed pin must be seen red before it is trusted: F1/F2 (frozen source reverted → model-level + queue
tests red), F3a/F3b/F3c (frozen vs project vs ADR-prose oracles fail independently), F4/F5 (framework seed oracle
and fixture oracle red on revert, `validate --all` red), F6/F7 (changelog/version lineage red), F8 (publish skip →
installed probe red). RED output is pasted into each lane's report; gates are broken on purpose once and restored.

## Risk register (merged)

| id | risk | mitigation / detection |
|---|---|---|
| R1 | Refresh before 0.172.0 exists → stale content churn | precondition gate; PKG-I starts only after tag verified |
| R2 | Frozen half inert in-repo until refresh | PKG-I is part of the same pbi PR; probes prove activation |
| R3 | Ids must move atomically across 5 files | one commit for PKG-P; join-7a prose test is the tripwire |
| R4 | Two harnesses test two sources | change `MED_PREF`/`HIGH_PREF` in both test files in the same commit |
| R5 | Refresh churn breadth (whole managed tree) | review report + diff by directory; commit refresh separately; revert path documented |
| R6 | No hand-patching generated files | guard enforced; fix forward in framework and re-refresh |
| R7 | Silent model fallback at runtime | assert argv in run logs; check `modelFallback` note |
| R8 | Frozen drift returns on future rotations | keep ADR/manual contract; no guard added without a decided cadence |
| R9 | Framework full-suite local flakes | CI is the arbiter; attribute only after comparing with baseline |
