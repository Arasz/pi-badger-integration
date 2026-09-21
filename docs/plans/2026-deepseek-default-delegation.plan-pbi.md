## pbi plan

Blueprint for the pbi lane (`task/pbi-deepseek-v41-flash-delegation-default`, worktree `.ai-badger/worktrees/pbi-deepseek-v41-flash-delegation-default`; paths below are relative to that worktree unless absolute). Two independent halves, deliberately sequenced: the **code+ADR+test** changes ship and pass standalone; the **refresh** is what actually activates DeepSeek in this repo, and it is gated on framework 0.172.0 existing. Label key: VERIFIED = read this session at the cited location; HYPOTHESIS = to be confirmed by execution.

### Frozen edit

Target — `extensions/subagent/delegation-core.ts`, docstring `L1068–1074`, const `L1075–1084`:

- `L1080` low stays `openrouter/z-ai/glm-5.3-flash` (VERIFIED, `delegation-core.ts:1080`).
- `L1081–1082` medium and high change to `openrouter/deepseek/deepseek-v4.1-flash` (VERIFIED current values, `delegation-core.ts:1081-1082`).
- `registryVersion: 1` (`L1076`) stays. Precedent: a preferred-index rotation with no member add/remove keeps `registryVersion` at 1 — `~/RiderProjects/ai-badger/docs/changelog/0.168.0-high-tier-prefers-deepseek-v41-flash.md:9` (VERIFIED). The frozen `registryVersion` is surfaced into resolution output (`delegation-core.ts:1214`), so it is observable — keep it truthful rather than bumping it (bumping would claim a new registry shape the frozen object does not carry).
- The new id passes `MODEL_ID_PATTERN` (`delegation-core.ts:1049`, `^openrouter/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; dots allowed) (VERIFIED by pattern inspection). Frozen carries preferred pins only, no demoted tails (VERIFIED, `delegation-core.ts:1079-1083`), so the framework demotion tale of `muse-spark-1.3-contributor` does not need mirroring here.

Frozen source note — two places, both currently claim PKG-1 provenance that will be false after the re-pin:

- Docstring `L1069–1073`: "copied from the PKG-1 canonical (`tiers/pkg1-registry:.ai-badger/model-groups.json`, read-only)" and "re-pin against the PKG-1 canonical" (VERIFIED). Replace with the framework canonical + delivery path: `features/common/data/model-groups.json` in the ai-badger checkout, delivered as `<cwd>/.ai-badger/model-groups.json` by scaffold/den-refresh (mechanism per research F4b, VERIFIED in research record `docs/plans/2026-deepseek-default-delegation.research.md:44-47`).
- `source` string `L1078`: `"tiers/pkg1-registry canonical preferred pins (frozen fallback, revisit on rotation)"` (VERIFIED). Recommend `"ai-badger canonical preferred pins (frozen fallback, revisit on rotation)"`. It is inert today — no extension code reads `FROZEN_MODEL_GROUPS.source` (grep `\.source\b` in `extensions/subagent/*.ts` matches only `delegation-status.ts:513`, a different carrier; tests assert `loaded.source` only, `tests/subagent-model-level.test.ts:60,73,91,111`, `tests/subagent-level-integration.test.ts:93`) (VERIFIED) — so the update is documentation correctness, not behavior.

Proposed final shape (L1068–1084):

```ts
/**
 * Frozen fallback (router degrade-on-stale precedent): preferred pins only, copied from
 * the ai-badger canonical (`features/common/data/model-groups.json`, delivered to a
 * project by scaffold/den-refresh as `.ai-badger/model-groups.json`, read-only). Served
 * when the target project has no usable registry file (absence rule — the warning rides
 * `ModelGroupsLoad.warning`). `{ frozen: true }` marks degraded resolutions in telemetry;
 * re-pin against the framework canonical when preferreds rotate (G1 follow-up).
 */
export const FROZEN_MODEL_GROUPS: LevelRegistry & { readonly frozen: true } = {
  registryVersion: 1,
  frozen: true,
  source: "ai-badger canonical preferred pins (frozen fallback, revisit on rotation)",
  groups: {
    low: [{ id: "openrouter/z-ai/glm-5.3-flash", preferred: true }],
    medium: [{ id: "openrouter/deepseek/deepseek-v4.1-flash", preferred: true }],
    high: [{ id: "openrouter/deepseek/deepseek-v4.1-flash", preferred: true }],
  },
};
```

Verification: `bun test tests/subagent-model-level.test.ts` (the frozen pins test at `:121-126` is the gate) and `bun test tests/subagent-queue-model-level.test.ts` (frozen medium path). Neither test reads the repo registry — see Test impact.

### ADR

File: `docs/work/2026-09-06-pkg5-level-registry-adr.md`. Exact section: `## Frozen fallback provenance` at `L36`; pins at `L41–43`; provenance sentence `L38–39`; refresh sentence `L45–47` (all VERIFIED by read).

Mandatory coupling — join 7a reads this file as text and asserts it contains all three pinned ids: `tests/subagent-level-integration.test.ts:45` (`ADR_PATH`), `:73-78` (test reads `Bun.file(ADR_PATH)` and loops `toContain(LOW_PREF/MED_PREF/HIGH_PREF)`). The ADR must change in the same commit as the constants, or that test stays red.

Proposed edits:

- `L38–39` → provenance now names the framework canonical, not `tiers/pkg1-registry`:
  `Preferred pins only, copied from the ai-badger canonical (`features/common/data/model-groups.json`, delivered to each project as `.ai-badger/model-groups.json` by the scaffold/refresh path):`
- `L42` → `- medium → \`openrouter/deepseek/deepseek-v4.1-flash\``
- `L43` → `- high → \`openrouter/deepseek/deepseek-v4.1-flash\``
- `L41` (low) unchanged.
- `L45–47` → keep the marker sentence; refresh the re-pin source wording, e.g. append: "Re-pins follow the framework canonical's preferred index (medium/high rotated to deepseek-v4.1-flash by 0.168.0/0.172.0)."
- Grep evidence that no other prose pin exists outside ADR/tests/code/research: `grep -rn "pkg1-registry|PKG-1 canonical"` matches only `delegation-core.ts:1070,1073,1078`, the ADR `:38,39,46`, and the test prose at `tests/subagent-model-level.test.ts:122`, `tests/subagent-level-integration.test.ts:6,39,66` (VERIFIED). The research record itself (`docs/plans/2026-deepseek-default-delegation.research.md:18-24,39-41`) is a dated record — do not rewrite it.

### Test impact

Classification from reading the three named files plus a repo-wide grep for `muse-spark|glm-5.3-flash|deepseek-v4.1-flash` (`.ts/.md/.json`, excluding worktrees/node_modules).

**Must change (frozen-pin expectations):**

| Site | Action | Evidence |
|---|---|---|
| `tests/subagent-model-level.test.ts:124` | literal → `openrouter/deepseek/deepseek-v4.1-flash` | VERIFIED `:124` |
| `tests/subagent-model-level.test.ts:125` | literal → `openrouter/deepseek/deepseek-v4.1-flash` | VERIFIED `:125` |
| `tests/subagent-model-level.test.ts:123` | stays (low) | VERIFIED `:123` |
| `tests/subagent-level-integration.test.ts:42` | `MED_PREF` → deepseek id | VERIFIED `:42` |
| `tests/subagent-level-integration.test.ts:43` | `HIGH_PREF` → deepseek id | VERIFIED `:43` |
| `tests/subagent-level-integration.test.ts:41` | stays (`LOW_PREF`) | VERIFIED `:41` |
| `tests/subagent-queue-model-level.test.ts:26` | `MED_PREF` → deepseek id | VERIFIED `:26` |

Constants-derived assertions — text unchanged, behavior follows the constants (all VERIFIED):
- `tests/subagent-level-integration.test.ts:59-61` (`canonicalProjectFile`), `:68-70` (frozen trio), `:75-77` (ADR prose loop), `:88-89` (project-wins temp registry), `:180-182` (spawn matrix expected values).
- `tests/subagent-queue-model-level.test.ts:117` and `:142` (`MED_PREF` assertions). The harness writes no registry file — `makeHarness` creates only `<tmp>/.pi/agents` (`tests/subagent-queue-model-level.test.ts:49-70`; `AGENTS_DIR = [".pi","agents"]`, `extensions/subagent/index.ts:100`), and the queue resolves via `opts.loadModelGroups(toolCtx.cwd)` (`extensions/subagent/delegation-queue.ts:330`, wired at `extensions/subagent/index.ts:1003`) which degrades to frozen on a missing file (`extensions/subagent/index.ts:123-135`) — so these assertions exercise the **frozen medium** pin (VERIFIED). Low assertions `:102`, `:136` unchanged.

Test prose naming the old provenance (no assertion; update for truthfulness in the same commit): `tests/subagent-model-level.test.ts:122` ("source: tiers/pkg1-registry canonical"), `tests/subagent-level-integration.test.ts:6,39,66` ("PKG-1 canonical"). Optional but recommended — leaving them makes the suite name a source that no longer matches the pins.

**Stays fixture-only (no change):**

- `tests/subagent-model-level.test.ts` FIXTURE and its consumers: fixture members `:105-108`, `:143-151`; resolver assertions `:174-176`, `:209`, `:228`, `:269-310`; fallback assertions `:351-354`. These drive an explicit `FIXTURE` object (`:140-155`) or use only low — the arbitrary muse-spark strings there are fixture ids, never frozen pins (VERIFIED by reading; a repo-wide grep shows no incidental dependency on the frozen ids in these lines).
- `tests/subagent-model-fallback.test.ts:55,56,65,66,72,77,114,341` and `tests/subagent-tool.test.ts:132,137,138` — literal `glm-5.3-flash` strings, no pin coupling (low unchanged) (VERIFIED by grep + read of call sites).
- No test reads the repo's own `.ai-badger/model-groups.json`: every `loadModelGroups` call passes a tmp dir (`tests/subagent-model-level.test.ts:59,72,90,110`; `tests/subagent-level-integration.test.ts:92`) (VERIFIED). Consequence: the whole suite is green before the refresh — the refresh is not a test dependency.
- Non-test: `.ai-badger/model-groups.json` medium/high preferred lines `:67`/`:175` are **managed** (manifest entry `target: .ai-badger/model-groups.json`, `seedOnce: false`, `.ai-badger/manifest.json:1205-1210`) and must change only via refresh, never by hand (see Risks R6).

### Refresh

This is the activation step; the frozen edit alone changes nothing in this repo (project registry wins: research F3, `extensions/subagent/index.ts:123-158`, VERIFIED).

**Precondition gate (run before touching the repo — currently FAILS, VERIFIED):**
```bash
export AI_BADGER=~/RiderProjects/ai-badger          # env is unset today (VERIFIED)
cat "$AI_BADGER/VERSION"                            # must print 0.172.0
python3 -c "import json;d=json.load(open('$AI_BADGER/features/common/data/model-groups.json'));print(d['frameworkVersion'], d['groups']['medium'][0]['id'], d['groups']['high'][0]['id'])"
# must print: 0.172.0 openrouter/deepseek/deepseek-v4.1-flash openrouter/deepseek/deepseek-v4.1-flash
```
Today `~/RiderProjects/ai-badger/VERSION:1` = `0.171.0`; canonical `medium[0]` = `openrouter/meta/muse-spark-1.3-contributor` (`features/common/data/model-groups.json:67`) while `high[0]` is already deepseek (`:175`); the framework task worktree `~/RiderProjects/ai-badger/.ai-badger/worktrees/aib-deepseek-v41-flash-medium-default` is identical (`frameworkVersion 0.171.0`, canonical medium still muse-spark, clean) — all VERIFIED. Refreshing now delivers 0.171.0 content with medium=muse-spark: pass condition fails while still churning the tree.

**Exact command (from `.ai-badger/skills/den-refresh/SKILL.md:48`):**
```bash
python3 "$AI_BADGER/features/common/skills/den-refresh/scripts/refresh.py" --target . --root "$AI_BADGER"
```
No `--prune-cache` / `--prune-namespaces` (both delete from `$HOME`; `~/.ai-badger/framework` is absent anyway, VERIFIED); no `--force` unless recovering (`SKILL.md:51-52`, `:249-260`).

**Expected changes to review:**
- `.ai-badger/model-groups.json` rewritten from the canonical: `frameworkVersion 0.172.0`, `medium[0] = high[0] = openrouter/deepseek/deepseek-v4.1-flash`, with `muse-spark-1.3-contributor` demoted to medium's tail (`status: "demoted"`, `revisionWatch: true`) per the framework's own invariants (research F6; HYPOTHESIS for the exact tail shape until the framework 0.172.0 canonical exists).
- `.ai-badger/config.json:3` `frameworkVersion` advances 0.167.1 → 0.172.0, and `.ai-badger/manifest.json` version stamps + the model-groups hash (`manifest.json:1208-1209`) update — `drift.versionChanged` (VERIFIED current values; SKILL.md:64 describes the field).
- Root/managed agent discovery files (`AGENTS.override.md`, `CLAUDE.md`, `.hermes.md`, `.pi/agents/**`) are re-rendered and re-stamped; project-authored content survives only inside keep markers (`SKILL.md` Rules/Gotchas). Broader churn — new default-scope skills from 0.169.0, archify from 0.171.0 — is HYPOTHESIS (research H1), to be confirmed by the diff.
- Seed-once files (`state.json`, `markers-context.json`, `model.json`) must not appear in the diff (`SKILL.md` Rules/Gotchas, VERIFIED).

**Review commands:**
```bash
git status --short
git diff --stat
git diff -- .ai-badger/model-groups.json
git diff -- .ai-badger/config.json .ai-badger/manifest.json AGENTS.override.md CLAUDE.md .hermes.md .pi
```
Read the JSON report first: `drift.changed`, `drift.locallyModified`, `drift.proseReview`, `reScaffolded`, `frameworkCopies` (`SKILL.md:64-120`); present `skillUsage` prune candidates but never prune (`SKILL.md` step 3b).

**Pass condition (observable, exact):**
```bash
python3 -c "import json;d=json.load(open('.ai-badger/model-groups.json'));assert d['frameworkVersion']=='0.172.0';assert d['groups']['medium'][0]['id']=='openrouter/deepseek/deepseek-v4.1-flash';assert d['groups']['high'][0]['id']=='openrouter/deepseek/deepseek-v4.1-flash';print('refresh pass')"
```

**Re-verification:**
```bash
bun test tests/subagent-model-level.test.ts tests/subagent-level-integration.test.ts tests/subagent-queue-model-level.test.ts
bun run test          # package.json:8
bun run typecheck     # package.json:11
bun run check         # package.json:10 — local-only by design, ci.yml:3-6
```
Optional runtime probe (research H3, HYPOTHESIS until run): a medium/high `queue`/`delegate` call in a registry-less temp project resolves deepseek; in this repo it resolves via project registry. The unit/queue suites already cover both code paths, so the probe is corroboration, not a gate.

**If refresh churn breaks something:**
- `refresh.py` exit ≠ 0 or JSON `error`: parse the structured error, apply the fix-table (`references/error-recovery.md`), re-run; `--force` is recovery-only (SKILL.md:51-52, :249-260). If it stays broken, offer the framework-bug path from `reporting-a-framework-bug.md` — never without approval.
- Tests red after a green refresh: **do not hand-edit generated files** — the generated-file guard denies edits to manifest-managed files and its override is env-only (research F5, VERIFIED). Fix forward in the framework source and re-refresh, or decline the offending item via `exclude` in the project-owned `config.json` (SKILL.md Notes). 
- Catastrophic churn: `git restore .ai-badger/ AGENTS.override.md CLAUDE.md .hermes.md .pi/` (or revert the refresh commit), correct the `--root`/framework version, re-run once. If a `drift.locallyModified` skill was overwritten, restore its content into `project-local.md` before re-running.
- Commit the refresh separately from the frozen/ADR/test commit, so a refresh revert never rolls back the code change.

### Risks

- **R1 — Sequencing (highest).** Refresh before framework 0.172.0 lands delivers 0.171.0 content and fails the pass condition (VERIFIED current versions above). The framework rotation + release is a separate lane (research F4c/F7); gate on the precondition command and nothing else.
- **R2 — The frozen half is inert in-repo until refresh.** Project registry precedence (`extensions/subagent/index.ts:123-158`, research F3) means in-repo medium/high still resolve muse-spark between the pbi merge and the refresh. Both halves must be tracked to completion; the pbi PR alone changes only the degraded-mode default. (VERIFIED code path; outcome HYPOTHESIS only in that the refresh will be run.)
- **R3 — Atomicity of ids across five files.** The frozen literals, two constant sets, ADR prose and test prose must move together; join 7a (`tests/subagent-level-integration.test.ts:73-78`) fails if the ADR lags the constants. This is intentional coupling (prose == registry) — keep it, don't weaken it.
- **R4 — Two harnesses test two sources.** Join 7b spawns through a project file built from constants (`tests/subagent-level-integration.test.ts:56-63`, `:84-91`), while the queue suite exercises frozen (no registry file, `tests/subagent-queue-model-level.test.ts:49-70`). Updating only one constant set yields a suite that no longer triangulates frozen vs project — change `MED_PREF`/`HIGH_PREF` in both files in the same commit (VERIFIED by reading both harnesses).
- **R5 — Refresh churn breadth.** Whole managed tree re-scaffold (HYPOTHESIS, research H1): new default skills, version re-stamps, possible dropped content outside keep markers. Mitigation: read the report's `locallyModified`/`proseReview` before applying, review the diff by directory, commit separately.
- **R6 — No hand-patching the registry.** `.ai-badger/model-groups.json` is manifest-managed and guard-protected (research F5; `.ai-badger/manifest.json:1205-1210`); a wrong refresh output is a framework bug, not a local edit. The env override is not available mid-session from tool calls (research F5).
- **R7 — Runtime resolution remains HYPOTHESIS (H3) until probed.** Tests cover frozen + project paths, but the live delegate/queue resolution after refresh should be spot-checked with the probe above.
- **R8 — Drift returns.** The frozen re-pin is manual by contract (ADR `:45-47`; G1 follow-up). A future framework preferred rotation re-stales it. A longer-term guard (test comparing frozen pins to the repo registry) would be red between framework release and refresh — do not add one without a decided cadence; keep the tripwire as the model-level freeze test plus this ADR note.
- **R9 — Low tier and cross-level rules untouched.** `glm-5.3-flash` stays at frozen low and is unchanged in both fixtures and constants; no framework or resolver rule requires distinct ids across levels (framework validator invariants are per-group, research F6; resolver reads `groups[level][0].id` only, research F3) — medium == high is legal (VERIFIED).