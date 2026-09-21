## Verdict

**COMPOSES-WITH-FOLDS** — the two implementation halves join exactly: the pbi frozen pins equal the framework 0.172.0 canonical, the 0.172.0 tag exists on the merge commit, and both suites are green. What is missing is the activation half (pbi's den-refresh) — PR #26 merged without it — plus two prose/precondition folds. No code-level incompatibility found.

---

**MUST — The wave-2 refresh never landed; pbi main still resolves muse-spark, so PR #26's deliverable list is not satisfied**

Evidence (observed):
- `gh pr view 26`: `state MERGED`, `mergeCommit 833b885a`, `mergedAt 2026-09-21T20:29:28Z`, `headRefOid 4bf2717`. Its file list contains only plan docs, the ADR, `extensions/subagent/delegation-core.ts`, and the three test files — no `.ai-badger/model-groups.json`, no `.ai-badger/config.json`, no refresh commit.
- PR #26 body lists as a deliverable: "`den-refresh` of this repo to the new framework release so the live registry resolves deepseek".
- `git show origin/main:.ai-badger/model-groups.json` → `frameworkVersion 0.167.1`, `medium[0] openrouter/meta/muse-spark-1.3-contributor`, `high[0]` same. Project-path probe on merged main: `source = project | frameworkVersion = 0.167.1`, `medium -> muse-spark-1.3-contributor`, `high -> muse-spark-1.3-contributor`.
- The commit message is honest about this ("the repo's live registry still resolves muse-spark until the wave-2 den-refresh") — the claim mismatch is in the PR body, not the commit.

Fold: run PKG-I now as a follow-up branch from current `origin/main` (PR #26 is squash-merged; its head `4bf2717` is **not** an ancestor, so do not cut from the task branch tip — FOLD-11's `git reset --hard origin/main` already anticipates this). The refresh's pass condition is observed-satisfiable: canonical at the tag delivers exactly `frameworkVersion 0.172.0`, `medium[0] == high[0] == openrouter/deepseek/deepseek-v4.1-flash`. Commit the refresh separately, re-run the project-path probe (expect `source=project`, `frameworkVersion=0.172.0`, deepseek), then publish + `/reload`.

**SHOULD — The FOLD-8 precondition gate is satisfiable only while `origin/main`'s tip equals the tag; `pull --ff-only` cannot pull to a tag**

Evidence (observed now): framework main checkout is clean, on `main` at `6502b0ea`, `origin/main` is the same commit, and `git describe --tags --exact-match` prints `ai-badger--v0.172.0` — so PKG-I AC1 passes today. But the gate as written in `plan.md` is `git -C "$FW_ROOT" fetch --tags && git -C "$FW_ROOT" pull --ff-only`, then exact-match. `pull --ff-only` moves `main` to `origin/main`'s tip; the moment any framework PR merges after #492, the exact-match assertion fails despite the tag still existing. The assertion discriminates trees correctly — the PKG-F worktree at `7718b7d5` gives `fatal: no tag exactly matches '7718b7d5…'` — which is exactly why the gate must pin the tree rather than ride `main`.

Fold (before wave 2, or run wave 2 before main advances): `git -C "$FW_ROOT" fetch --tags origin && git -C "$FW_ROOT" checkout --detach ai-badger--v0.172.0`, then assert exact-match and `VERSION`, and pass that tree as `--root`. That keeps FOLD-8's intent (merged+tagged tree) without a moving `main`.

**SHOULD — The ADR still carries the `{ frozen: true }` telemetry claim that FOLD-12 removed from the docstring**

Evidence (observed):
- ADR on main (`docs/work/2026-09-06-pkg5-level-registry-adr.md`): "Marked `{ frozen: true }` so telemetry (`registryVersion` surfacing per contract §4.10) distinguishes degraded resolutions."
- The merged docstring now says: "The degraded load is marked by `source: \"frozen\"` plus its warning", and commit 4bf2717's message states outright "(the frozen type flag is inert)".
- Grep over `extensions/ tests/*.ts` (node_modules excluded): `frozen:` appears only at its definition `delegation-core.ts:1078`; no consumer reads it. The degraded discriminator the loader actually produces is `source: "frozen"` (`extensions/subagent/index.ts:134,144,151`).
- The fold was scoped to the docstring + a `FROZEN_MODEL_GROUPS.source` assertion (FOLD-12), which shipped; the ADR sentence is the residual copy of the same claim.

Fold: reword the ADR sentence to "the degraded load is marked by `source: \"frozen\"` plus its warning; the type flag is inert" in the refresh PR. Join-7a pins only the three bullets, so the tripwire stays green. Everything else in the ADR is true after refresh (pins match canonical; the 0.168.0/0.172.0 rotation note matches observed history).

**INFO — Merge order, tag, squash, and CI are clean; framework claims all check out**

Observed: framework merged `20:29:03Z`; tag `ai-badger--v0.172.0` created `20:29:11Z` (annotated, dereferences to `6502b0ea`); pbi merged `20:29:28Z`. Framework PR checks 8/8 pass (`Analyze`, `CodeQL`, `Install ai-badger the way a consumer does`, `gates`, `gitleaks`, `label`, `lint (3.10)`, `tests (3.10)`); pbi's single `test` job (bun test + typecheck per `ci.yml`) passes. `git diff 4bf2717 833b885 -- <owned files>` is empty (squash content identical). The ordering constraint the task named ("framework 0.172.0 before pbi's refresh") is still open only for the follow-up refresh, and the tag it needs now exists. Note the pbi main checkout is dirty (` M extensions/session-signals/index.ts`, untracked silence-vertex files) — FOLD-11's "publish from a reset task worktree, never the dirty checkout" remains the right rule.

---

## Checked-clean

- **(a) Frozen pins vs framework 0.172.0 canonical — exact on every axis.** At the tag: `medium[0] == high[0] == openrouter/deepseek/deepseek-v4.1-flash`, `pricing 0.15 in / 0.60 out`, entry `measuredAt 2026-09-11`; `registryVersion 1`; `frameworkVersion 0.172.0 == VERSION`; `delivered.groups == canonical.groups`. Frozen carries `low = openrouter/z-ai/glm-5.3-flash`, none of the old muse-spark pins; no pricing/tail is claimed for frozen ("preferred pins only" still true), and the canonical medium tail is `[-2] claude-sonnet-5 (demoted, revisionWatch)`, `[-1] muse-spark-1.3-contributor (demoted, revisionWatch)` — the displaced-preferred-last shape PR #492 claimed. Frozen `registryVersion 1` matches canonical, and frozen intentionally has no `frameworkVersion` (the B4 discriminator).
- **Runtime join observed on merged pbi main:** empty-cwd probe → `source = frozen`, `low -> glm-5.3-flash`, `medium -> deepseek-v4.1-flash`, `high -> deepseek-v4.1-flash`. The fallback half is live and correct; only the project-registry half is stale (MUST above).
- **Framework PR #492 claims verified against the tag:** HIGH evidence sentence corrected (`"remains medium's preferred"` → `"now a demoted tail pin in both high and medium"`, plus a new medium demotion evidence); L0-5 untouched (no diff hunk); L0-4 renamed `test_preferred_is_deepseek_v41_flash_medium_and_high`; L0-11 carries the deepseek id list with sonnet-5 at `[-2]` and contributor last; FOLD-5 (`medium[0].id == high[0].id` + equal pricing) and FOLD-17 (`registryVersion == 1`) present; `CHANGELOG` repointed to `docs/changelog/0.172.0-medium-tier-prefers-deepseek-v41-flash.md`; advisory medium row `deepseek-v4.1-flash → terra`.
- **Locally re-run, observed green:** pbi `bun test tests/subagent-model-level.test.ts tests/subagent-level-integration.test.ts tests/subagent-queue-model-level.test.ts` → `57 pass, 0 fail`; framework `pytest tests/test_model_groups_registry.py tests/test_model_tiers_integration.py` → `111 passed in 0.99s`.
- **pbi test/ADR joins:** `FROZEN_MODEL_GROUPS.source` contains `ai-badger canonical`; join-7a asserts the exact `- medium → …` and `- high → …` bullet lines (FOLD-9), and those bullets plus the low bullet exactly match the canonical three.
- **Provenance claims:** ADR "copied from the ai-badger canonical (`features/common/data/model-groups.json`, delivered … by the scaffold/refresh path)" and the `0.168.0/0.172.0` rotation note are both true of the shipped tag; the suite-gap claim also holds — no pbi test reads the repo's own `.ai-badger/model-groups.json` (all `loadModelGroups` call sites pass tmp dirs), so after refresh the project-path probe remains the only oracle for the committed file.