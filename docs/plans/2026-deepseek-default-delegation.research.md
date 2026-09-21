# Research record — DeepSeek V4.1 Flash as the medium+high delegation default

Task: `pbi-deepseek-v41-flash-delegation-default` (pbi) + `aib-deepseek-v41-flash-medium-default` (framework).
Date: 2026-09-21. Every finding below carries its source; anything not yet executed is marked HYPOTHESIS.

## Request (verbatim scope)

> use DeepSeek V4.1 Flash as a default delegation model for high / medium

Confirmed by the user as scope **B, high effort, pi and badger**: the pbi extension default **and**
the ai-badger canonical registry medium rotation, so both repos' delegations resolve DeepSeek V4.1 Flash
for `high` and `medium`.

## Findings

### F1 — Live registry this repo resolves against (pbi)
- `pi-badger-integration/.ai-badger/model-groups.json` (framework 0.167.1, registryVersion 1, measuredAt 2026-09-05):
  - `medium[0]` = `openrouter/meta/muse-spark-1.3-contributor` (preferred)
  - `high[0]` = `openrouter/meta/muse-spark-1.3-contributor` (preferred)
- Source: the file itself. This is the file `delegate` reads at `<cwd>/.ai-badger/model-groups.json`.

### F2 — pbi frozen fallback (shipped default)
- `extensions/subagent/delegation-core.ts:1075` `FROZEN_MODEL_GROUPS`:
  `low` = `openrouter/z-ai/glm-5.3-flash`; `medium` = `high` = `openrouter/meta/muse-spark-1.3-contributor`.
- `{ frozen: true }` marks degraded resolutions in telemetry.

### F3 — Resolution path (which store actually wins)
- `extensions/subagent/index.ts:123` `loadModelGroups(cwd)` reads `<cwd>/.ai-badger/model-groups.json`;
  missing/unreadable/unparseable/structurally-unusable → `FROZEN_MODEL_GROUPS` + warning (`source: "frozen"`).
- A usable project registry **wins**: `source: "project"` (index.ts:123-158).
- Resolver reads `groups[level][0].id` only, re-validated against `MODEL_ID_PATTERN`
  (`^openrouter/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`) before argv (`delegation-core.ts:1035-1055`, ADR §M8).
- G-6 precedence: tool-override (queue group `model:`) > frontmatter `model:` > `level:`-resolved > session model.
- Consequence: **editing the frozen fallback alone does not change this repo's delegations** — the project
  registry file wins here. The two halves are independent deliverables.

### F4 — ai-badger canonical registry (framework truth)
- `~/RiderProjects/ai-badger/features/common/data/model-groups.json` @ main 4ed2e34b (0.171.0):
  - `medium[0]` = `openrouter/meta/muse-spark-1.3-contributor` (preferred, 0.1/0.2)
  - `high[0]` = `openrouter/deepseek/deepseek-v4.1-flash` (preferred, 0.15/0.6) — rotated in **0.168.0**, PR #483, commit c835effc
  - `high` tail demotes the displaced muse-spark-contributor (`status: demoted`, `revisionWatch: true`).
- F4b — deliver mechanism: `features/common/skills/welcome-ai-badger/scripts/model_registry.py` copies the
  canonical to `<target>/.ai-badger/model-groups.json` on **every** scaffold (`seedOnce: false`); docstring:
  "Consumer projects never edit it".
- F4c — framework `state.json` `next` still carries "consumer den-refresh for the rotated high-tier pin"
  (this repo never consumed 0.168.0; it is scaffolded at 0.167.1).

### F5 — Generated-file guard
- `.ai-badger/skills/welcome-ai-badger/scripts/generated_file_guard.py` (PreToolUse `Edit|Write|MultiEdit|NotebookEdit`)
  denies edits to manifest-managed files; `.ai-badger/model-groups.json` is such an entry
  (`.ai-badger/manifest.json`: target `.ai-badger/model-groups.json`, source `features/common/data/model-groups.json`,
  `seedOnce: false`). Override is env-only (`AI_BADGER_ALLOW_GENERATED_EDITS`), not settable mid-session from a tool call.
- Consequence: the only legitimate local activation is a `den-refresh` after the framework canonical changes.

### F6 — Registry machine invariants (validator, framework)
- `features/common/skills/task/scripts/model_groups.py:104` `validate_registry`:
  exactly one `preferred`, at index 0; active members non-decreasing in `(inputPerM, outputPerM)`;
  demoted members tail-only and each needs `revisionWatch: true`; entries sharing a `weightsId` must name it
  in `evidence`; `frameworkVersion` must equal `VERSION`; `measuredAt` a real `YYYY-MM-DD`.
- This is why the medium rotation must **demote** `muse-spark-1.3-contributor` (0.1/0.2 sorts before
  deepseek's 0.15/0.6, so it cannot stay active ahead of it) and pin it last, exactly as high did in 0.168.0.

### F7 — Framework tests pinning registry content
- `tests/test_model_groups_registry.py` (shipped-seed test, ~L279-339): pins the medium id ORDER, medium price
  tuple list, preferred flags, `resolve("medium") == muse-spark`, `preferred("high") == deepseek-v4.1-flash`,
  and `frameworkVersion == VERSION`.
- `tests/test_model_tiers_integration.py`: line 43 pins `CHANGELOG = docs/changelog/0.168.0-high-tier-prefers-deepseek-v41-flash.md`;
  ~L205 asserts the delivered registry's `frameworkVersion` equals VERSION (release lineage).
- Framework release ritual (RELEASING.md "Cutting a release"): edit `VERSION`; add
  `docs/changelog/{version}-{slug}.md`; `tooling/changelog_index.py`; `tooling/version_sync.py`;
  checks (`--check` variants + `gates/release_guard.py`); `pytest` + `pylint`; PR; **tag is automatic** on merge.
- Self-scaffold last (CONTRIBUTING.md ~L220):
  `AI_BADGER_MCP_AVAILABILITY=all .venv/bin/python3 features/common/skills/welcome-ai-badger/scripts/scaffold.py --config .ai-badger/config.json --target . --root . --no-install --skills ''`.

### F8 — pbi tests and prose pinning the frozen pins
- `tests/subagent-model-level.test.ts:121-126` — frozen pin test (low/medium/high literals).
- `tests/subagent-level-integration.test.ts:42-43` — `MED_PREF`/`HIGH_PREF` constants; join 7a frozen test;
  join 7a ADR-prose test (asserts the ADR text contains all three ids); join 7b spawn matrix.
- `tests/subagent-queue-model-level.test.ts:26` — `MED_PREF` asserted at L117/L142; the harness writes **no**
  registry file, so this exercises `FROZEN_MODEL_GROUPS` medium.
- `docs/work/2026-09-06-pkg5-level-registry-adr.md` ("Frozen fallback provenance") names the three frozen pins;
  the ADR-prose test reads this file.
- Not pinned: `tests/subagent-model-level.test.ts` `FIXTURE` registry (arbitrary fixture ids — safe either way,
  but the lane should confirm no incidental dependency).

### F9 — Model facts for `openrouter/deepseek/deepseek-v4.1-flash`
- Source: `~/.pi/agent/models-store.json` (pi catalog): provider openrouter, `cost.input 0.15`,
  `cost.output 0.6`, contextWindow 1048576, maxTokens 384000, reasoning true.
- Framework canonical high entry uses the same 0.15/0.6 with "pi models-store and the OpenRouter models API agree"
  (measured 2026-09-11, PR #483). Reuse that evidence; do not re-derive.

### F10 — pbi release mechanics
- Root `VERSION` = 1.1.11. `.github/workflows/auto-bump.yml`: a push to main NOT touching VERSION gets
  test-gated then auto-bumped (patch) + tagged + released. Merging the pbi PR therefore needs no manual bump.
- `bun publish.ts` installs the extension to pi user scope; `bun publish.ts --check` is the repo's `bun run check`.

### F11 — Workspace state
- pbi main checkout has unrelated uncommitted `extensions/session-signals/silence-vertex-debug.ts` work
  (not this task; left untouched). Both task worktrees are clean branches cut from fresh `main`.
- Paths: pbi worktree `.ai-badger/worktrees/pbi-deepseek-v41-flash-delegation-default`
  (branch `task/pbi-deepseek-v41-flash-delegation-default`);
  framework worktree `~/RiderProjects/ai-badger/.ai-badger/worktrees/aib-deepseek-v41-flash-medium-default`
  (branch `task/aib-deepseek-v41-flash-medium-default`).

## Hypotheses (to verify, not assumed)

- **H1**: `den-refresh` in pbi (0.167.1 → 0.172.0) re-scaffolds the whole managed tree — new default-scope
  skills from 0.169.0, archify from 0.171.0, refreshed agents/skills/manifest — not just `model-groups.json`.
  The diff must be reviewed and `bun run test` + `typecheck` green before merge.
- **H2**: after refresh, pbi `.ai-badger/model-groups.json` carries `frameworkVersion 0.172.0` with
  `medium[0] = high[0] = openrouter/deepseek/deepseek-v4.1-flash`. Verified by diffing the file, not by trust.
- **H3**: live resolution after refresh: a `delegate`/`queue` call at level medium/high in this repo resolves
  deepseek (project registry), and in a registry-less temp project resolves the new frozen pins. Verified by a
  runtime probe against the built extension, not by reading code.
- **H4**: the framework's Copilot review round behaves as it did on PR #483 (draft → ready → review → squash).
  Not verified for the current repo state; fall back to the documented loop.

## Open questions

1. Framework version for the release: **0.172.0** (minor — delivered registry content changes; the precedent is
   0.168.0, also a registry rotation). No `BREAKING_VERSIONS` entry (re-scaffold recommended, not required).
2. Should the framework changelog note also cover pbi's frozen re-pin? No — separate repos, separate records;
   the framework entry covers the canonical rotation only.
3. pbi docs beyond the ADR: `grep muse-spark` found no other prose pin outside tests/ADR; the howto/config docs do
   not restate tier pins (verified 2026-09-21).
