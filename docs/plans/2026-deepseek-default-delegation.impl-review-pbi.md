## Verdict

**SHIP-WITH-FIXES** — one MUST (a one-line ADR truth fix inside PKG-P's own edit surface). Everything else in the diff is correct against the post-#492 canonical, the tests are green and structurally sound, and I found nothing that breaks the wave-2 PKG-I refresh/probes.

## Findings

**MUST — ADR marker sentence contradicts the code docstring this same commit wrote, and the flag it credits is dead at runtime**
`docs/work/2026-09-06-pkg5-level-registry-adr.md:46` — "Marked `{ frozen: true }` so telemetry (`registryVersion` surfacing per contract §4.10) distinguishes degraded resolutions."

- Evidence: `delegation-core.ts:1073-1074` now states the degraded marker is `source: "frozen"` plus its warning; the commit message states "the frozen type flag is inert". Verified: `grep -rn "\.frozen\b"` across `extensions/**/*.ts` matches only the declaration/type at `delegation-core.ts:1076,1078` — nothing reads it. The loader emits `source: "frozen"` + `warning` (`extensions/subagent/index.ts:133,143,150`). `registryVersion` surfacing exists only on the pure result (`delegation-core.ts:1215`) and is never consumed by either tool layer (`grep registryVersion extensions/subagent/index.ts delegation-queue.ts` → no hits); `ModelGroupsLoad` does not carry it at all.
- The plan (`docs/plans/2026-deepseek-default-delegation.plan-pbi.md:57`) said "keep the marker sentence", but the code edit in this commit deliberately retired the flag's telemetry role, so keeping it verbatim now records a falsehood in the decision record — exactly what the join-7a prose tripwire exists to prevent.
- Concrete fix (PKG-P, same commit or a follow-up commit on this branch; join-7a only asserts the bullets, so it stays green either way):

  ```
  Carries a `{ frozen: true }` marker (type-level residue; nothing reads it). The observable
  degrade signal is `ModelGroupsLoad.source: "frozen"` plus the warning the loader emits.
  ```
- On "must PKG-I fold it?": PKG-I can carry it, but that moves a truth fix out of the surface that falsified it. Defer only if the deferral is recorded; otherwise fold now.

**SHOULD — the test literals are now correct but the cross-repo join they claim is manual**
`tests/subagent-level-integration.test.ts:39-44` — MED_PREF/HIGH_PREF are now literals independent of `FROZEN_MODEL_GROUPS` (good: a frozen-constant mutation cannot keep them green), but nothing in-repo ties them to the framework canonical. A stale literal here passes 100% green. This exact gap is acknowledged in `plan.md:89` and assigned to the PKG-I probes, so it is correctly out of scope — flagging so the fold is not silently forgotten.

**INFO — FOLD-9 assertions are independent of the constants; one residual blind spot remains (low)**
`tests/subagent-level-integration.test.ts:81-82` hardcode the medium/high bullet lines (not `MED_PREF`/`HIGH_PREF`), so they catch a half-edit of the two deepseek bullets and don't drift with the constants. The loop at `:79-80` is still constant-bound, so a half-edit of the *low* bullet alone would not be caught — `low` is single and unchanged this commit, so this is acceptable, but a future low rotation should get the same exact-bullet treatment.

**INFO — FOLD-12 holds and the docs/test moves describe the actual runtime**
`tests/subagent-model-level.test.ts:123` asserts `source` contains "ai-badger canonical" — true at `delegation-core.ts:1079`; mildly change-detector-shaped (a legitimate source reword would red), but it is specific and anchored to real runtime text. `delegation-core.ts:1070-1075` docstring: canonical provenance, delivered path, `source: "frozen"` + warning — matches `loadModelGroups` behavior. The absence-rule parenthetical names only "no usable registry file" while the loader also degrades on unparseable/structurally-unusable files (`index.ts:143,150`); minor, pre-existing style, not worth a change here.

## Checked-clean

- **(1) FROZEN pins / docstring / pattern.** `delegation-core.ts:1082-1083`: medium/high = `openrouter/deepseek/deepseek-v4.1-flash`, low unchanged (canonical low is still `openrouter/z-ai/glm-5.3-flash`). Both ids satisfy `MODEL_ID_PATTERN` (`:1048`) — `[A-Za-z0-9_.-]` covers `-` and `.`; `deepseek` and `deepseek-v4.1-flash` each match one segment. Frozen carries preferred pins only, no pricing — correct per PR #492 ("materialized content rotates"; frozen is a pin source, not a pricing source), and no test or probe consumes frozen pricing/staleness/`frameworkVersion`. `registryVersion: 1` truthfully mirrors the canonical (PR #492 kept it at 1).
- **(2) ADR bullets + rotation note.** `:38-44` provenance/prose match the canonical verbatim; `:48-50` rotation note (0.168.0/0.172.0) matches the framework changelog history. Only the `:46` sentence is wrong (MUST above).
- **(3) Tests.** FOLD-9 exact-bullet assertions are literal and not vacuous; FOLD-12 source assertion holds; `subagent-queue-model-level.test.ts:26,117,142` pins the medium id via the frozen registry (the harness project dir has no registry file, so the absence rule is the source — verified `makeHarness` writes only `.pi/agents`), so the queue medium pin is real and constant-driven, no vacuity; `subagent-model-level.test.ts:106-107,148-152` muse-spark fixtures are intentional synthetic fixtures testing the resolver, not stale pins.
- **(4) Framework-consistency after PR #492** (`6502b0ea` / `7718b7d5`, on `origin/main`, local checkout not yet pulled): canonical `medium[0].id = high[0].id = openrouter/deepseek/deepseek-v4.1-flash`, pricing `inputPerM 0.15 / outputPerM 0.6`, `registryVersion 1`, `frameworkVersion 0.172.0`, displaced `muse-spark-1.3-contributor` demoted with `revisionWatch: true` — frozen pins match index 0 exactly; no divergence.
- **(5) Wave-2 PKG-I.** No test reads the repo's own `.ai-badger/model-groups.json` (grep: tests reference the ids only as fixtures/constants), so the still-muse-spark live registry (`.ai-badger/model-groups.json`, still `frameworkVersion 0.167.1`) does not make the narrow suite red — the worktree suite is green on frozen/constants alone. The local ai-badger clone is at `0.171.0` HEAD (`4ed2e34b`) and missing #492 until fetched; PKG-I's precondition gate (`git fetch --tags`, `describe --exact-match == ai-badger--v0.172.0`, FOLD-8) already covers this. Transient mixed state pre-refresh (project registries still serve muse-spark for medium, frozen serves deepseek) is intentional per the plan (R2/“live registry still resolves muse-spark until wave-2”). Nothing in the diff touches `delegationArgs`' default-frozen behavior used by the spawn matrix, and the `--model` value alone is the observable probe signal (the `registryVersion` telemetry the ADR names is not wired, per the MUST).
- **Narrow suite, observed (run in the worktree at `4bf2717`, `git status` clean):**

  ```
  $ bun test tests/subagent-model-level.test.ts tests/subagent-level-integration.test.ts tests/subagent-queue-model-level.test.ts
  57 pass
  0 fail
  179 expect() calls
  Ran 57 tests across 3 files. [689.00ms]
  ```

  Per file: `subagent-model-level.test.ts` 36 pass / 0 fail; `subagent-level-integration.test.ts` 9 pass / 0 fail; `subagent-queue-model-level.test.ts` 12 pass / 0 fail. Includes join 7a (both tests), all 7b spawn-matrix cells, and the frozen-pins test. `tsc --noEmit` in this worktree reports 10 errors, all missing optional deps in `extensions/pi-mcp-tools` (`@modelcontextprotocol/sdk`, `@sinclair/typebox`) and pre-existing (main checkout: 0 errors) — zero errors in `extensions/subagent/**` or `tests/subagent*`; unrelated to this diff (worktree `node_modules` lacks the mcp-tools deps).
- **Worktree contents vs scope:** diff is limited to the five files named in the request — no stray edits, no registry refresh smuggled into the PKG-P commit (required separately by plan PKG-I.2).