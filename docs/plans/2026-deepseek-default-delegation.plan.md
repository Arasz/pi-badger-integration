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
   a recorded RED run of the changed expectations (before the content edit) — paste both.
4. Changelog `docs/changelog/0.172.0-medium-tier-prefers-deepseek-v41-flash.md` carries the advisory table that
   `test_model_tiers_integration.py` parses; `CHANGELOG` constant repointed; `changelog_index.py` regenerated.
5. Self-scaffold runs **after** `version_sync.py`; delivered `.ai-badger/model-groups.json` groups == canonical
   and `frameworkVersion == VERSION == 0.172.0`.
6. Release gates green (`version_sync --check`, `changelog_index --check`, `index_build --check`, `release_guard`,
   `scaffold_freshness_guard`, `docs_guard`), full `pytest` + `pylint` green; PR merged; tag
   `ai-badger--v0.172.0` verified on the remote.

### PKG-P
1. `FROZEN_MODEL_GROUPS` medium and high = `openrouter/deepseek/deepseek-v4.1-flash` (low unchanged); docstring +
   `source` note name the ai-badger canonical, not the retired `tiers/pkg1-registry` branch.
2. ADR `## Frozen fallback provenance` names the new medium/high pins and the framework-canonical provenance;
   join-7a prose test (`tests/subagent-level-integration.test.ts:73-78`) passes against it.
3. RED-first evidence: with the test literals updated but `FROZEN_MODEL_GROUPS` reverted, the frozen-pin tests fail
   (model-level `:123-126`, queue `:26/:117/:142`); restored → green.
4. `bun test tests/subagent-model-level.test.ts tests/subagent-level-integration.test.ts tests/subagent-queue-model-level.test.ts`
   green (baseline 57 pass) and `bun run typecheck` exit 0.

### PKG-I
1. Precondition gate passes first: framework `VERSION` reads `0.172.0` and canonical medium/high preferred =
   deepseek. Refresh then runs with explicit `--root`.
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
