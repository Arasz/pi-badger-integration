## Framework plan

Scope: the ai-badger canonical `medium` rotation to `openrouter/deepseek/deepseek-v4.1-flash`, mirroring the verified HIGH precedent at commit `c835effc` / PR #483 (`git show c835effc` — VERIFIED). Framework worktree `~/RiderProjects/ai-badger/.ai-badger/worktrees/aib-deepseek-v41-flash-medium-default`, branch `task/aib-deepseek-v41-flash-medium-default`, clean from main `4ed2e34b`, `VERSION` 0.171.0 (VERIFIED: `git log --oneline -3`, `git status --porcelain`, `cat VERSION`). Report-only lane: no tracked file was edited; `git status --porcelain` is empty (VERIFIED) and the only probe artifacts are a gitignored `__pycache__` from the in-memory validator run.

Acceptance notes: the price-order walk is VERIFIED by executing the shipped validator (`features/common/skills/task/scripts/model_groups.py:validate_registry`, `:77`) in memory against the proposed document — no writes; cited facts are tagged VERIFIED (read/executed this session) or HYPOTHESIS (predicted, not executed).

### Registry edit

Target: `features/common/data/model-groups.json`. Order of operations (line anchors are the **current** file):

1. **Top level** (`features/common/data/model-groups.json:3-6`):
   - `frameworkVersion` line 3: `"0.171.0"` → `"0.172.0"` (assigned; research open question 1 — VERIFIED as the live value at line 3).
   - `measuredAt` line 5: `"2026-09-11"` → `"2026-09-21"` (machine UTC date `2026-09-21`, `date -u` — VERIFIED; same date as the research record header).
   - `source` line 6 → exactly:
     ```
     "task-brief 2026-09-21 (medium tier rotates to deepseek-v4.1-flash, matching the 0.168.0 high rotation; deepseek-v4.1-flash pricing measured 2026-09-11 against pi models-store and the OpenRouter models API; earlier pins per task-brief 2026-09-05)"
     ```
     Shape mirrors the 0.168.0 precedent string (`git show c835effc -- features/common/data/model-groups.json` — VERIFIED).
   - `registryVersion` line 4 stays `1`: no member added/removed, no price moved; only the preferred index rotated and one status changed (same reasoning as the 0.168.0 message — VERIFIED).

2. **Remove** the current `medium[0]` block, lines 66-77 (`openrouter/meta/muse-spark-1.3-contributor`, `preferred: true`, 0.1/0.2, `weightsId`, measured 2026-09-05).

3. **Insert as the new `medium[0]`** (immediately after `"medium": [` line 65):
   ```json
   {
     "id": "openrouter/deepseek/deepseek-v4.1-flash",
     "preferred": true,
     "pricing": {
       "inputPerM": 0.15,
       "outputPerM": 0.6,
       "currency": "USD"
     },
     "evidence": "Medium-tier preferred from 2026-09-21: performance-adequate flash pin at 0.15 in / 0.60 out per M; pi models-store and the OpenRouter models API agree (source: task-brief 2026-09-11 pricing; medium rotation 2026-09-21).",
     "measuredAt": "2026-09-21"
   }
   ```
   Pricing 0.15/0.6 reuses the HIGH entry's measured values (`features/common/data/model-groups.json:175-183`, measured 2026-09-11) and research F9 (`~/.pi/agent/models-store.json`: cost 0.15/0.6 — VERIFIED, no re-derivation).

4. **Append the displaced member as the group's final element**, after `claude-sonnet-5` (current lines 156-171; add the separating comma after the closing brace at line 171). This mirrors 0.168.0, where the displaced preferred became HIGH's last element (`git show c835effc -- features/common/data/model-groups.json` — VERIFIED):
   ```json
   {
     "id": "openrouter/meta/muse-spark-1.3-contributor",
     "preferred": false,
     "pricing": {
       "inputPerM": 0.1,
       "outputPerM": 0.2,
       "currency": "USD"
     },
     "evidence": "Demoted from medium-tier preferred on 2026-09-21 when deepseek-v4.1-flash took index 0; remains the contributor twin with identical weights (weightsId muse-spark-1.3-weights); display-only tail, never auto-failover; revisit before any other refresh (source: task-brief 2026-09-21 demotion; price measured 2026-09-05).",
     "weightsId": "muse-spark-1.3-weights",
     "status": "demoted",
     "revisionWatch": true,
     "measuredAt": "2026-09-05"
   }
   ```
   The evidence must name the `weightsId` string: the cross-group twin check (`model_groups.py:248-278`, `weights not in evidence` at :275-277) requires it for all three holders (medium tail, medium `muse-spark-1.3`, high tail). Tail placement with two demoted members (sonnet-5 then contributor) is legal: `_validate_order` skips demoted entries for price order and only requires them to be tail-only with `revisionWatch: true` (`model_groups.py:214-244`) — VERIFIED by code reading and by the executed probe below.

5. **Correct the now-false HIGH-tail evidence** at `features/common/data/model-groups.json:218`, which currently says "remains medium's preferred" — after this rotation that sentence is false. New text (keeping the weightsId mention and the N1 citation):
   ```
   "Demoted from high-tier preferred on 2026-09-11 when deepseek-v4.1-flash took index 0; now a demoted tail pin in both high and medium, and the contributor twin with identical weights (weightsId muse-spark-1.3-weights); display-only tail, never auto-failover; revisit before any other refresh (plan-review N1, matching the schema's revisionWatch clause) (source: task-brief 2026-09-11 demotion; medium demotion 2026-09-21; price measured 2026-09-05)."
   ```
   Unchanged: low (lines 8-64) and every other medium/high member. No `BREAKING_VERSIONS` entry — re-scaffold is recommended, not required, matching 0.168.0 (RELEASING.md semver section; research open question 1 — VERIFIED for the 0.168.0 precedent, HYPOTHESIS for classification being accepted by review).

**Resulting medium order and validator walk** — VERIFIED by invoking `validate_registry` in memory on the proposed document: `VALIDATOR ERRORS: NONE -> PASS`, i.e. exactly-one-preferred-first (`model_groups.py:117-144`), non-decreasing `(inputPerM, outputPerM)` over active members, demoted-tail-only with `revisionWatch` (`:214-244`), weights-identity evidence (`:248-278`), and the schema shape (`schemas/model-groups.schema.json:49,61-71`):

| idx | id (final segment) | key (in, out) | status | order check |
|---|---|---|---|---|
| 0 | deepseek-v4.1-flash | (0.15, 0.6) | preferred | last=None → set |
| 1 | mimo-v2.5-pro | (0.435, 0.87) | active | ok |
| 2 | deepseek-v4-pro-0813 | (0.57948, 1.73844) | active | ok |
| 3 | deepseek-v4-pro | (0.9918, 1.9836) | active | ok |
| 4 | muse-spark-1.3 | (1.25, 4.25) | active | ok |
| 5 | glm-5.3 | (1.4, 4.4) | active | ok |
| 6 | gpt-5.6-sol | (2, 10) | active | ok |
| 7 | gpt-5.6-terra | (2, 12) | active | ok |
| 8 | claude-sonnet-5 | (2, 10) | demoted, revisionWatch | skipped |
| 9 | muse-spark-1.3-contributor | (0.1, 0.2) | demoted, revisionWatch | skipped |

Alternative placement considered and logged: inserting the demoted contributor immediately before sonnet-5 (index 8) also passes `_validate_order` (both are demoted and tail-only) — VERIFIED by code reading, not executed — but index-9 append mirrors 0.168.0's "displaced preferred goes last" mechanics exactly and is the chosen call in this autonomous lane.

### Test impact

Every file that pins medium content or the release lineage, with the exact expectation change. Line numbers are current-file anchors. The precedent for the shape of this list is the 0.168.0 test diff (`git show c835effc -- tests/...` — VERIFIED).

`tests/test_model_groups_registry.py`

| Layer | Lines | Exact change |
|---|---|---|
| L0-4 heading/docstring | 141-145 | Rename heading to "L0-4 medium+high prefer deepseek-v4.1-flash"; docstring: medium no longer keeps the contributor; the displaced contributor is demoted tail in medium *and* high (provenance 2026-09-21 / 2026-09-11 pricing). |
| L0-4 function name | 142 | `test_preferred_is_deepseek_v41_flash_high_and_spark_medium` → `test_preferred_is_deepseek_v41_flash_medium_and_high`. |
| L0-4 medium fixture | 146-150 | Replace `_m("openrouter/meta/muse-spark-1.3-contributor", 0.1, 0.2, True)` at 147 with `_m("openrouter/deepseek/deepseek-v4.1-flash", 0.15, 0.6, True, evidence="Medium-tier preferred from 2026-09-21: performance-adequate flash pin (source: task-brief 2026-09-11 pricing; rotation 2026-09-21).")`; keep sonnet-5 demoted (148-149); append the contributor demoted (`0.1, 0.2, status="demoted", revisionWatch=True`) after line 149. Exact mirror of the high fixture change at `git show c835effc` — VERIFIED. |
| L0-4 assertion | 161 | `mg.preferred("medium", groups) == "openrouter/meta/muse-spark-1.3-contributor"` → `... == "openrouter/deepseek/deepseek-v4.1-flash"` (line 162's high assertion stays). |
| L0-5 heading/name | 165-166 | "L0-5 sonnet-5 last in medium" → "L0-5 sonnet-5 last deciding in medium"; `test_sonnet_5_is_last_in_medium` → `test_sonnet_5_is_last_deciding_in_medium` (mirrors 0.168.0's L0-6 rename — VERIFIED). |
| L0-5 fixture | 167-172 | Line 168 contributor-preferred → deepseek preferred (0.15/0.6, 2026-09-21 evidence); append contributor demoted after line 171. |
| L0-5 assertion | 175 | `assert groups["medium"][-1]["id"].endswith("claude-sonnet-5")` → `deciding = [m for m in groups["medium"] if m.get("status") != "demoted"]; assert deciding[-1]["id"].endswith("claude-sonnet-5")` (same shape as the high L0-6 assertion at lines 200-202). |
| L0-11 docstring | 278-280 | Drop "low/medium carry the 2026-09-05 measurement"; state: medium's and high's preferred pin is deepseek-v4.1-flash (pricing measured 2026-09-11), medium rotation measured 2026-09-21, remaining medium/low pins carry 2026-09-05. |
| L0-11 medium id order | 292-302 | Line 293 `openrouter/meta/muse-spark-1.3-contributor` → `openrouter/deepseek/deepseek-v4.1-flash`; append `"openrouter/meta/muse-spark-1.3-contributor",` after line 301. High list (303-308) unchanged. |
| L0-11 medium price list | 315-318 | `(0.1, 0.2), (0.435, 0.87), ...` → `(0.15, 0.6), (0.435, 0.87), (0.57948, 1.73844), (0.9918, 1.9836),` + `(1.25, 4.25), (1.4, 4.4), (2, 10), (2, 12), (2, 10), (0.1, 0.2),`. High tuple list (319-320) unchanged. |
| L0-11 tail block | 326-329 | `tail` → `medium_tail` aimed at `muse-spark-1.3-contributor` (status demoted, revisionWatch true); add `assert groups["medium"][-2]["id"].endswith("claude-sonnet-5")` — mirrors the high block at 330-334. |
| L0-11 medium resolve | 337-338 | `mg.resolve("medium", groups=groups) == "openrouter/meta/muse-spark-1.3-contributor"` → `... == "openrouter/deepseek/deepseek-v4.1-flash"`. |
| T-DUP docstring | 387-388 | "The shipped reuse is medium's preferred contributor, reused as high's demoted tail." → "The shipped reuse is the contributor: demoted tail in both medium and high." (`shared` fixture at 389-392 stays.) |
| Shape-only fixtures (no change) | 178-186 (mid-list rejection), 194-198 (high), 581-582, 593-596 | They validate validator rules with fixture registries, not the seed; leaving them matches the 0.168.0 precedent (VERIFIED: the 0.168.0 diff left the analogous fixtures untouched). |

`tests/test_model_tiers_integration.py`

| Pin | Lines | Exact change |
|---|---|---|
| Advisory-table source | 43 | `CHANGELOG = "docs/changelog/0.168.0-high-tier-prefers-deepseek-v41-flash.md"` → `"docs/changelog/0.172.0-medium-tier-prefers-deepseek-v41-flash.md"`. Required because `test_advisory_table_shorts_resolve_into_the_registry` (236) parses exactly this file; the 0.168.0 table's medium row (spark-contributor preferred) would fork from the rotated registry — VERIFIED by reading 236-259 and the 0.168.0 entry, and by the 0.168.0 diff which moved this constant from 0.165.0 to 0.168.0. |
| Comment | 245 | "The table names human truncations (spark-contributor)" → example `(deepseek-v4.1-flash)`; mechanism text unchanged. |
| Release-lineage reads (no code change) | 204-210, 212-219 | `test_shipped_registry_framework_version_equals_version` reads `.ai-badger/model-groups.json` + `VERSION`; `test_shipped_registry_matches_the_canonical_seed` compares shipped vs canonical groups. Both pass once the self-scaffold mirrors the new seed **after** `version_sync` (see Release sequence); the 0.167.1 incident is the precedent for this ordering (`docs/changelog/0.167.1-model-groups-frameworkversion-stamps.md`). |
| Matrix tests | 225-234, 279-303 | Parameterized over the real shipped registry; no expectation text changes, they follow the new preferred pins automatically — VERIFIED by reading. |

Other files (pins / lineage; not test files)

| File | Lines | Change |
|---|---|---|
| `features/common/data/model-groups.json` | 3, 5-6; 66-77; 171-172; 218 | The registry edit above. |
| `.ai-badger/model-groups.json` (delivered mirror) | mirrors 3, 5-6, 67, 211 | **Not hand-edited.** The generated-file guard denies edits (research F5); the manifest entry `.ai-badger/manifest.json:1631-1639` (`seedOnce: false`, hash at :1638) makes it a managed, rewritten-on-every-run copy (research F4b; `features/common/skills/welcome-ai-badger/scripts/model_registry.py` — VERIFIED). The self-scaffold regenerates it byte-for-byte from the seed; `tests/test_model_groups_registry.py:651-661` asserts that verbatim delivery. |
| `.ai-badger/manifest.json` | 1637-1638 (model-groups entry) plus all managed entries | Rewritten by the self-scaffold (frameworkVersion 0.172.0 + new hashes), as in the 0.168.0 diff. |
| `VERSION` | 1 | `0.171.0` → `0.172.0` (assigned; do not choose another). |
| `docs/changelog/0.172.0-medium-tier-prefers-deepseek-v41-flash.md` | new | See Release sequence for content; it is the new advisory-table source at integration-test line 43. |
| `docs/changelog/README.md` | 22 region | New 0.172.0 row, generated by `tooling/changelog_index.py`; never hand-edited (RELEASING.md:24). |
| `index.json` | 3 | `frameworkVersion` → 0.172.0, written by `version_sync.py` via `index_build.py` (RELEASING.md:25). |
| `.claude-plugin/plugin.json` | 3 | `version` → 0.172.0. |
| `.claude-plugin/marketplace.json` | 15 | plugin entry `version` → 0.172.0. |
| `.ai-badger/*.md`, `CLAUDE.md`, `HERMES.md`, `.hermes.md`, `.github/copilot-instructions.md`, `.ai-badger/delegation.md` | version stamps | Rewritten by the self-scaffold ("Scaffolded by ai-badger 0.172.0"), as in the 0.168.0 diff stat. |
| `.ai-badger/state.json` | 3 (`next`) | Not a RELEASING.md file; task-close should drop the carried "consumer den-refresh for the rotated high-tier pin" and record 0.172.0 (research F4c — VERIFIED as the live text). |
| Historical changelogs `docs/changelog/0.165.0-*.md:55`, `docs/changelog/0.168.0-*.md:25` | — | **Do not edit.** Their medium references were true for their release date; once line 43 moves to 0.172.0, no gate parses them (VERIFIED by reading the test). |

### Release sequence

Working directory for every command: the framework worktree root `/Users/arasz/RiderProjects/ai-badger/.ai-badger/worktrees/aib-deepseek-v41-flash-medium-default`. Interpreter: this worktree has no `.venv` (VERIFIED: `ls -d .venv` empty); system `python3` has pytest 9.1.1 and jsonschema, and the vendored `frontmatter` loads via `engine/` on `sys.path` (`engine/frontmatter.py`, `tests/conftest.py:22-24`) — VERIFIED. That is why the commands below say `python3` where RELEASING.md says `python3`; CONTRIBUTING.md's `.venv/bin/python3` is the main-checkout spelling, which is neither present nor writable here.

1. **Red-first witness** (mirror of the c835effc "RED recorded before the fact" — the failure set is HYPOTHESIS until executed):
   ```bash
   python3 -m pytest tests/test_model_groups_registry.py tests/test_model_tiers_integration.py -q
   ```
   Expected RED after only the test-expectation edits: `test_real_registry_satisfies_all_invariants` (medium id/price pins), `test_advisory_table_shorts_resolve_into_the_registry` (line 43 points at a not-yet-created 0.172.0 entry). `test_shipped_registry_framework_version_equals_version` stays green until the stamp files move — the same split c835effc recorded. **HYPOTHESIS** (predicted, not run in this plan lane).

2. **Apply content**: registry edit (above), `VERSION` → `0.172.0`, and add `docs/changelog/0.172.0-medium-tier-prefers-deepseek-v41-flash.md`:
   - H1 `# 0.172.0 — medium tier prefers deepseek-v4.1-flash`; classification line `**Minor** (scaffold-affecting) · 2026-09-21` (RELEASING.md:9-14; 0.168.0 entry as the template — VERIFIED).
   - Prose: medium[0] becomes deepseek-v4.1-flash ($0.15 in / $0.60 out per M); the displaced contributor stays visible as medium's demoted tail (`status: "demoted"`, `revisionWatch: true`); `registryVersion` stays 1; the contributor remains the `muse-spark-1.3-weights` twin; price evidence per 2026-09-11 measurement.
   - Advisory table (the integration test parses exactly these rows; the medium row's shorts were checked for unique dash-token resolution — VERIFIED in the probe):
     ```
     | tier | preferred → dearest deciding | advisory ref-unit spend |
     |---|---|---|
     | low | glm-5.3-flash → haiku-4.5 | $0.0125 → $0.20 |
     | medium | deepseek-v4.1-flash → terra | $0.027 → $0.44 |
     | high | deepseek-v4.1-flash → fable-5.1 | $0.027 → $2.00 |
     ```
   - Upgrade notes: personas/consumers pick up the pin on the next refresh; an explicit `model:` still wins verbatim.

3. **Green focused run** (same command as step 1) — expect all green, no count pinned (c835effc recorded 111 across the two files; this edit adds assertions, not test functions — HYPOTHESIS on the exact count).

4. **Regenerate and propagate** (RELEASING.md:24-25; CONTRIBUTING.md:209-214):
   ```bash
   python3 tooling/changelog_index.py
   python3 tooling/version_sync.py
   ```

5. **Self-scaffold LAST** (CONTRIBUTING.md:216-222 — only correct after step 4, because `index.json` is the version source):
   ```bash
   AI_BADGER_MCP_AVAILABILITY=all python3 features/common/skills/welcome-ai-badger/scripts/scaffold.py \
     --config .ai-badger/config.json --target . --root . --no-install --skills ''
   ```

6. **Gates** (RELEASING.md:26-27, plus the registry and freshness gates c835effc ran — VERIFIED in that commit message). `release_guard` reads local tags, so fetch first (the c835effc precondition: without it the guard reported `UNTAGGED RELEASES`):
   ```bash
   git fetch --tags origin
   python3 tooling/validate.py --all                      # baseline already green on this tree — VERIFIED this session
   python3 tooling/version_sync.py --check
   python3 tooling/changelog_index.py --check
   python3 tooling/index_build.py --check
   python3 gates/release_guard.py
   python3 gates/docs_guard.py
   python3 gates/scaffold_freshness_guard.py
   python3 -m pytest tests/ -q
   python3 -m pylint $(git ls-files '*.py' | grep -v '^tests/')
   ```
   One-shot alternative/backstop: `.lefthook/pre-push/verify.sh all` (CONTRIBUTING.md:226-232 — VERIFIED).

7. **Commit → PR → merge** (RELEASING.md:28-33): feature-style message naming the minor class and both phases as 0.168.0 did; push the branch, open the PR, draft→ready→review→squash; **tag is automatic** on merge, then verify it reached the remote:
   ```bash
   git ls-remote --tags origin | grep 'refs/tags/ai-badger--v0.172.0$'
   ```
   (RELEASING.md:24-33 — VERIFIED; do not repoint tags.)

### Risks

1. **Stale HIGH-tail evidence ships false** unless step 5 of the Registry edit runs: `features/common/data/model-groups.json:218` says "remains medium's preferred", which becomes untrue the moment medium rotates. No test pins that string, so CI alone would not catch it — VERIFIED by grep for the medium preferred id (no test reads line 218).
2. **Tail placement is a judgment call, not forced by the validator.** Append-at-end (chosen) moves sonnet-5 from `medium[-1]` to `medium[-2]`, requiring the L0-11 and L0-5 re-aiming above; insert-before-sonnet-5 would pass validation as well. The call is logged here because no user constraint exists in this autonomous lane — VERIFIED both placements satisfy `model_groups.py:214-244` by code reading.
3. **Advisory-table join is a single-file contract.** `tests/test_model_tiers_integration.py:43` selects exactly one changelog; the 0.172.0 entry must carry the parseable table (`_advisory_rows` regex at :193-201). A missing row reds `assert rows`; a forked short reds the unique-token check at :244-255. This plan's proposed medium row resolves uniquely to `deepseek-v4.1-flash`/`terra` — VERIFIED in the probe; the whole test's green outcome is HYPOTHESIS until run.
4. **Mirror lag repeats the 0.167.1 incident.** `tests/test_model_groups_registry.py:341-342` and `tests/test_model_tiers_integration.py:204-210` compare `frameworkVersion` to `VERSION`; if the self-scaffold is skipped or run before `version_sync`, `.ai-badger/model-groups.json` ships stale (precedent: `docs/changelog/0.167.1-model-groups-frameworkversion-stamps.md`). The generated-file guard means hand-fixing the mirror is not available mid-session (`generated_file_guard.py`, research F5) — VERIFIED.
5. **`release_guard` fetch-tags precondition.** Without `git fetch --tags origin`, the local clone can lack tags and the guard reports `UNTAGGED RELEASES`/exits 1 — witnessed in c835effc and documented at RELEASING.md:87-107 — VERIFIED.
6. **Known full-suite flakes must not be attributed to this change.** `.ai-badger/state.json:3` carries `test_badger_store_cli prune-status` and `test_workflow_lint` as locally flaky; CI is the arbiter — VERIFIED from the state text (HYPOTHESIS that they stay quiet this run).
7. **Cross-group reuse is intentional but broad.** After this change `openrouter/deepseek/deepseek-v4.1-flash` is preferred in both `medium` and `high`; the validator and the cross-group-reuse test (`tests/test_model_groups_registry.py:386-396`) allow it, and per-level resolution stays verbatim (`model_groups.py:314-350`). Consumers who pinned a single model per level via explicit `model:` are unaffected — VERIFIED by code reading.
8. **Consumer blast radius.** Every scaffolded project receives the rotated registry on the next scaffold/den-refresh (`seedOnce: false`, `.ai-badger/manifest.json:1639`; copy logic in `model_registry.py`) — VERIFIED. Downstream, the pbi repo's `den-refresh` to 0.172.0 is a separate deliverable (research H1/H2) and this release is its prerequisite — HYPOTHESIS as to timing.
9. **Version-order merge.** RELEASING.md:87-98: two PRs with different versions must merge in version order, and `VERSION` must not land below the highest tag; the current baseline tag is `ai-badger--v0.171.0` (VERIFIED: `git tag -l 'ai-badger--v0.17*'`), so 0.172.0 is a forward bump — VERIFIED.
10. **`measuredAt` date choice.** `2026-09-21` is the verified machine/task date; if implementation runs on a later date, the value should be the session date while the pricing evidence stays 2026-09-11 — HYPOTHESIS (date dependency, no constraint stated).