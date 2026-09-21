# Verification & risk plan — DeepSeek V4.1 Flash as the medium+high delegation default

> **Superseded in part (2026-09-21):** the framework released `0.172.0` for this rotation, then `0.172.1`
> (registry evidence erratum, PR #493). The pbi refresh therefore shipped `frameworkVersion 0.172.1`
> (PR #28). Probes below that assert `0.172.0` (A5, B4, B6, the PKG-I pass condition) were executed
> against `0.172.1` — assert `frameworkVersion == <framework VERSION>` (or the live registry stamp) rather
> than the literal `0.172.0`.

Legend: **VERIFIED** = read/executed in this session against the worktrees named in the task; **HYPOTHESIS** = not yet executed. Baselines measured today: framework worktree `4ed2e34b` (VERSION 0.171.0), pbi worktree `26d953a` (VERSION 1.1.11), both clean. All paths below are under those two worktrees unless absolute.

Correction to the research record: F6 cites `model_groups.py:104` for `validate_registry`; the actual definition is `features/common/skills/task/scripts/model_groups.py:77` (VERIFIED). Everything else I re-checked in F1–F11 held, with one nuance added in case M6: a live delegation log (`~/.pi/agent/subagent-logs/d-1331.jsonl`) shows deepseek in this repo *today*, but only because this very QA lane was queued with an explicit `model:` override — the receipt records `levelOverride: explicit model ... overrode level "high"` (VERIFIED). The level path itself still resolves muse-spark here.

**Hard prerequisite (ordering).** The framework's canonical registry is copied verbatim on scaffold (`features/common/skills/welcome-ai-badger/scripts/model_registry.py`, `seedOnce: false`), and the delivered file's `frameworkVersion` is whatever the canonical carries. The pbi refresh must therefore run *after* the framework edit + `VERSION` bump (planned 0.172.0 — HYPOTHESIS), or pbi will commit a registry whose stamp is already stale.

## Acceptance

### A. Framework leg — canonical registry, delivered copy, tests, gates

**A1. Registry machine invariants.** Command (linked worktree has no `.venv`; use the main checkout's interpreter — same resolution as `.lefthook/pre-push/verify.sh:104-110`):
`cd <framework-worktree> && /Users/arasz/RiderProjects/ai-badger/.venv/bin/python3 tooling/validate.py --all`
Expected: exit 0 and `ok  model-groups registry invariants` (exit 0 VERIFIED on the clean tree). This is the only enforcer of preferred-first, price order with demoted-tail exemption, tail position and weights-identity evidence (`tooling/validate.py:331-376`, leaf `model_groups.py:77/117/214/248`). The validator globs `features/*/data/model-groups.json` only, so it checks the canonical, not the delivered copy.

**A2. Registry + tiers tests.**
`/Users/arasz/RiderProjects/ai-badger/.venv/bin/python3 -m pytest tests/test_model_groups_registry.py tests/test_model_tiers_integration.py -q`
Expected: all green. Baseline today: **111 passed in 3.93 s** (VERIFIED). The assertions this change must move:
- `test_model_groups_registry.py:142` L0-4 — currently "high AND medium prefer deepseek/spark" resp. must become "medium and high prefer deepseek" with the fixture updated (it currently asserts `mg.preferred("medium") == muse-spark`).
- `:277` L0-11 — hand-written medium id list, medium price-tuple list and `resolve("medium")` assertion (`:294-305`, `:337-338`) must name deepseek-v4.1-flash; the medium tail assertion (`:331-332`, currently sonnet-5) must match the chosen demoted-tail order.
- `:166` L0-5 is fixture-only and needs no change; `:192` L0-6 stays valid ("last *deciding*" formulation already handles a demoted tail).
- `test_model_tiers_integration.py:204` — delivered `frameworkVersion == VERSION`; `:212` — delivered `groups ==` canonical `groups`; `:236` — advisory table shorts resolve into the registry, read from the `CHANGELOG` constant at `:43`, which must be repointed to the new `0.172.0-<slug>.md` (precedent: c835effc repointed 0.165.0 → 0.168.0).
- Expected new medium advisory row: preferred `deepseek-v4.1-flash` → dearest deciding `terra` (deciding[-1] after the rotation). Token-uniqueness in that tier holds (VERIFIED against the current id set).

**A3. Refreshed registry inspection (canonical + delivered).** From the framework worktree:
```
/Users/arasz/RiderProjects/ai-badger/.venv/bin/python3 - <<'PY'
import json, pathlib
fw = pathlib.Path(".")
canon = json.loads((fw/"features/common/data/model-groups.json").read_text())
ship  = json.loads((fw/".ai-badger/model-groups.json").read_text())
ver = (fw/"VERSION").read_text().strip()
D = "openrouter/deepseek/deepseek-v4.1-flash"
for name, d in (("canonical", canon), ("delivered", ship)):
    print(name, d["frameworkVersion"], d["registryVersion"], d["measuredAt"])
    print("  medium[0]", d["groups"]["medium"][0]["id"], "high[0]", d["groups"]["high"][0]["id"])
    print("  medium demoted tail", [(i, m["id"], m.get("status"), m.get("revisionWatch"))
                                    for i, m in enumerate(d["groups"]["medium"]) if m.get("status")=="demoted"])
    assert d["frameworkVersion"] == ver
    assert d["groups"]["medium"][0]["id"] == d["groups"]["high"][0]["id"] == D
assert canon["groups"] == ship["groups"]
print("VERSION", ver, "OK")
PY
```
Expected: `frameworkVersion == VERSION` (0.172.0 planned — HYPOTHESIS until bumped), `medium[0] == high[0] == openrouter/deepseek/deepseek-v4.1-flash`, and `muse-spark-1.3-contributor` still present in medium as `demoted` + `revisionWatch: true`. Its evidence already names `weightsId muse-spark-1.3-weights` (VERIFIED at `features/common/data/model-groups.json`, medium[0] evidence), satisfying the cross-group weights check once demoted — but re-run A1 because the checker is non-local (a shared `weightsId` needs the string in *each* twin's evidence). Current medium[0] sits at line 67, the high demoted twin at line 211 (VERIFIED).

**A4. Framework release gates.** Commands (from `RELEASING.md:20-44`; `git fetch --tags origin` is precautionary — the precedent c835effc needed it, and locally `release_guard` passes today without it — VERIFIED):
```
git fetch --tags origin
python3 tooling/version_sync.py --check && python3 tooling/changelog_index.py --check && \
python3 tooling/index_build.py --check && python3 gates/release_guard.py && \
python3 gates/scaffold_freshness_guard.py
```
Expected: all exit 0; `release_guard` moves from today's `no shipped-surface changes since ai-badger--v0.171.0 — PASS` (VERIFIED) to a PASS naming the new in-flight release; delivered copy regenerated by the self-scaffold, not by hand:
`AI_BADGER_MCP_AVAILABILITY=all /Users/arasz/RiderProjects/ai-badger/.venv/bin/python3 features/common/skills/welcome-ai-badger/scripts/scaffold.py --config .ai-badger/config.json --target . --root . --no-install --skills ''` then `python3 tooling/version_sync.py` again (version stamps manifest-derived agent files; CONTRIBUTING.md:507-514).

**A5. Newly scaffolded project (the "(c)" leg).** Targeted local check (the framework's own config is a deliberate throwaway target; the real consumer shape is A6):
```
tmp=$(mktemp -d); cd "$tmp" && git init -q .
/Users/arasz/RiderProjects/ai-badger/.venv/bin/python3 <fw>/features/common/skills/welcome-ai-badger/scripts/scaffold.py \
  --config <fw>/.ai-badger/config.json --target . --root <fw> --no-install
python3 -c "import json;d=json.load(open('.ai-badger/model-groups.json'));print(d['frameworkVersion'],d['groups']['medium'][0]['id'],d['groups']['high'][0]['id'])"
```
Expected: `0.172.0 openrouter/deepseek/deepseek-v4.1-flash openrouter/deepseek/deepseek-v4.1-flash`. Keep `$tmp` for the pbi probe B4; this is what proves the *cross-repo* join (framework deliverer + pbi resolver).

**A6. Consumer journey (CI-owned).** `gates/consumer_journey.py` is the detect→config→scaffold→guard end-to-end (`.github/workflows/consumer-journey.yml`, CI-only lane per `verify.sh:80`). Expected green on the PR. Locally, A5 is the substitute only if CI is unavailable.

### B. pbi leg — frozen fallback, tests, probes, publish

**B1. Pin tests (unit + level-integration + queue).**
`bun test tests/subagent-model-level.test.ts tests/subagent-level-integration.test.ts tests/subagent-queue-model-level.test.ts`
Expected: all green. Baseline today: **57 pass in ~1.6 s** (VERIFIED). Files that must change: `extensions/subagent/delegation-core.ts:1081-1082` (frozen medium/high); `docs/work/2026-09-06-pkg5-level-registry-adr.md:42-43`; `tests/subagent-model-level.test.ts:123-125`; `tests/subagent-level-integration.test.ts:42-43`; `tests/subagent-queue-model-level.test.ts:26`. Optional consistency: the loader fixture at `tests/subagent-model-level.test.ts:105-107` (it asserts only `source === "project"` and the low id, so it cannot fail on a stale medium literal — VERIFIED).

**B2. Typecheck.** `bun run typecheck` (package.json → `bunx tsc --noEmit -p .`). Expected exit 0.

**B3. Runtime probe — frozen path.** Mechanics VERIFIED today against the installed extension: importing `~/.pi/agent/extensions/subagent/{index,delegation-core}.ts` resolves its own `node_modules` and runs. Point `<EXT>` at the worktree `extensions/subagent` first (pre-publish source), then at `~/.pi/agent/extensions/subagent` after publish:
```
cd /tmp && bun -e '
import { loadModelGroups } from "<EXT>/index.ts";
import { resolveLevel } from "<EXT>/delegation-core.ts";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const empty = mkdtempSync(join(tmpdir(), "probe-"));
try {
  const l = loadModelGroups(empty);
  if (l.source !== "frozen") throw new Error("expected frozen, got " + l.source);
  for (const level of ["medium","high"]) {
    const m = resolveLevel(l.registry, { level }).model;
    if (m !== "openrouter/deepseek/deepseek-v4.1-flash") throw new Error(level + " -> " + m);
  }
} finally { rmSync(empty, { recursive: true, force: true }); }'
```
Expected post-change: no throw; today it resolves muse-spark for both levels (VERIFIED — the "before" state). Asserting `source === "frozen"` prevents the leg passing off a stray project registry.

**B4. Runtime probe — project-registry path.** Same script, cwd argument = (i) the refreshed pbi worktree root, (ii) `$tmp` from A5, (iii) after merge, `/Users/arasz/RiderProjects/pi-badger-integration` (requires the main checkout pulled). Assert:
- `l.source === "project"`,
- `l.registry.frameworkVersion === "0.172.0"` (frozen has no `frameworkVersion` — a discriminator beyond the id),
- medium/high resolve to deepseek.
Today (i) yields `source=project`, medium/high muse-spark (VERIFIED). This is the only check of pbi's *committed* `.ai-badger/model-groups.json`: no pbi test reads it — every test writes its own fixture (`tests/subagent-level-integration.test.ts:52-62`; the queue harness writes no registry at all) — so a stale or wrong refreshed file is invisible to `bun run test` (VERIFIED by reading; this is a real suite gap, not a hypothetical).

**B5. Refreshed registry inspection (pbi).** `python3 -` one-liner asserting `frameworkVersion == framework VERSION`, `medium[0] == high[0] == deepseek`, plus `git diff -- .ai-badger/model-groups.json` showing only stamp fields + the medium/high rotation, no hand edits. Current state 0.167.1 / muse-spark (VERIFIED).

**B6. den-refresh application.** Prefer the framework worktree's own refresh script with an explicit root (the pbi copy at 0.167.1 is byte-identical today — VERIFIED — but the locator order makes an explicit `--root` the safe form):
```
AI_BADGER=<fw> /Users/arasz/RiderProjects/ai-badger/.venv/bin/python3 \
  "$AI_BADGER/features/common/skills/den-refresh/scripts/refresh.py" --target . --root "$AI_BADGER"
```
Expected report: `reScaffolded: true`, `drift.changed` includes `.ai-badger/model-groups.json`, `frameworkVersion` 0.172.0, `frameworkCopies` absent or naming only the intended tree. Then review `git status`/`diff --stat` (H1: this is a whole-tree 0.167.1→0.172.0 re-scaffold crossing new default skills and archify — HYPOTHESIS until run) and re-run B1+B2.

**B7. Publish + installed-extension check (operator step, after merge).** From the merged main checkout: `bun publish.ts` then `bun run check` (= `bun publish.ts --check`). Expected: install lines then `in sync: canonical source == user scope for all owned extensions`, exit 0 (`publish.ts:377`). Negative control: without publish, `--check` prints `OUT OF SYNC (n):` with `differs: .../extensions/subagent/delegation-core.ts` and exits 1 (`publish.ts:359,371`). Then re-run B3 with `<EXT>=~/.pi/agent/extensions/subagent`. Today the installed copy still carries the old pins (VERIFIED at `~/.pi/agent/extensions/subagent/delegation-core.ts:1075-1082`), so this check is currently the *failing* state — exactly the falsification witness for B7.

**B8. Live end-to-end watch (local only).** After `/reload` or a fresh session in the refreshed repo, delegate `api-engineer` (`level: medium`, `.pi/agents/api-engineer.md:5`) and `architect` (`level: high`, `.pi/agents/architect.md:6`); read `~/.pi/agent/subagent-logs/<runId>.jsonl` first line (`delegation-runner.ts:636` records `argv`):
`head -1 <log> | grep -o '"--model","[^"]*"'` → `openrouter/deepseek/deepseek-v4.1-flash`.
Negative control (G-6): `queue add-parallel` with an explicit `model:` must spawn the explicit id and the receipt must carry `levelOverride: explicit model ... overrode level "high"` — VERIFIED live today in session `01a0c55a…` and by `tests/subagent-queue-model-level.test.ts:120-133`. If the child dies at startup, the runner records `modelFallback` in the note/log (`delegation-runner.ts:512-560`) — read it, or the delegation silently ran on the session model.

**B9. Full pbi suite once before push.** `bun run test` exit 0. CI re-runs it (`ci.yml:48`) and auto-bump re-runs it after merge (`auto-bump.yml:66`); a merge needs no manual pbi version bump (`auto-bump.yml`, VERIFIED).

## Falsification

"Red for the wrong reason is worth nothing" (`T0-01`): each mutation below is applied as a real edit, the narrow command is run, red is observed, the edit is reverted, and green is re-confirmed.

| # | pin test | mutation (apply, run, revert) | expected red | notes |
|---|---|---|---|---|
| F1 | `tests/subagent-model-level.test.ts:123-125` | revert `FROZEN_MODEL_GROUPS` medium/high to muse-spark (`delegation-core.ts:1081-1082`); keep test literals deepseek | 2 assertions fail | baseline "before" state; proves the test constrains the source |
| F2 | `tests/subagent-queue-model-level.test.ts:26,117,142` | same source mutation | L117/L142 fail | exercises the **frozen** path: `makeHarness` writes no `.ai-badger/model-groups.json` (VERIFIED `:74-98`) |
| F3a | `tests/subagent-level-integration.test.ts:68-70` | mutate `FROZEN` only | 7a frozen test red; 7b spawn matrix still green (it writes its own registry via `canonicalProjectFile :52-62`) | proves the two paths are independently covered |
| F3b | same file, `:75-79` ADR-prose | revert only the ADR bullets (`docs/work/2026-09-06-pkg5-level-registry-adr.md:42-43`) to muse-spark | prose test red, all else green | the cross-artifact tripwire for a partial edit |
| F3c | same file, `:178-186` spawn matrix | mutate `MED_PREF/HIGH_PREF` constants only | matrix red (`--model` mismatch) | project-registry path |
| F4 | `tests/test_model_groups_registry.py:277` (L0-11) | revert canonical medium[0] to muse-spark (line 67), leave the demoted reorder | medium id list + `resolve("medium")` red; `validate --all` also reds (preferred-first/price-order) | the seed oracle is a hand-written literal list, independent of the JSON |
| F5 | `tests/test_model_groups_registry.py:142` (L0-4) | revert the fixture's medium preferred to muse-spark | assertion red | fixture-based: pins semantics, not the seed |
| F6 | `tests/test_model_tiers_integration.py:236` + `:43` | rotate the registry but leave `CHANGELOG` at 0.168.0 (or write the 0.172.0 table with the old medium row) | "table/registry forked" red: `spark-contributor` resolves to the demoted tail, not `deciding[0]` | new changelog entry + index regeneration is part of the change |
| F7 | `tests/test_model_tiers_integration.py:204,212` | bump `VERSION` but not canonical `frameworkVersion`; or edit canonical but not the self-scaffolded delivered copy | `:204` red resp. `:212` red | version lineage and copy parity are separate oracles |
| F8 | B3/B4 runtime probes | do all source edits but skip `bun publish.ts` | installed probe prints muse-spark and throws | the only oracle that is the actually-loaded artifact |
| F9 | precedence (`delegation-core.ts:1254`, queue `delegation-queue.ts:339-347`) | flip trust so `level:` beats the queue group `model:` | queue `:120-133` red, live receipt loses `levelOverride` | do not "fix" by touching frozen constants |
| F10 | residual | coordinated double-edit of source constant + pbi test literals | stays green | they are change-detectors, not independent oracles. Independent constraints are the ADR-prose test (F3b), the framework seed test (F4), and the probes (F8); only the fresh-scaffold probe (A5→B4) separates a full coordinated edit across repos |

Record RED *before* implementation (the framework precedent did: c835effc's message notes "RED recorded before the fact"), then green.

## Failure modes

| id | failure | mechanism (VERIFIED unless marked) | detection |
|---|---|---|---|
| M1 | **Publish not run / stale installed extension** | pi auto-discovers only user/project scope (`docs/extensions.md:117-118`); publish is local-only by design (`ci.yml:17-20`). Installed copy still has old pins today (`~/.pi/agent/extensions/subagent/delegation-core.ts:1081-1082`). | `bun run check` → `OUT OF SYNC` naming `differs: ~/.pi/agent/extensions/subagent/delegation-core.ts`; installed probe B3 prints muse-spark. Fix: `bun publish.ts` from merged main, re-probe. |
| M2 | **Session not reloaded (in-memory stale module)** | publish deliberately leaves running sessions alone; jiti already loaded them (`publish.ts:37-40`); `/reload` re-runs discovery (`docs/extensions.md:7,1397-1416`). | fresh-process probe (B3) passes while the next in-session delegation log still shows the old pin (B8). Fix: `/reload`/restart, then re-read a new run log. |
| M3 | **Stale/misresolved framework root (cache)** | `refresh.py` locator order: `--root` > ancestor walk > `$AI_BADGER` > manifest-recorded > `~/.ai-badger/framework` (`refresh.py:31-33,112-120`). An ambient stale tree silently drives the refresh. | pass `--root` explicitly; read the report's `frameworkVersion` and `frameworkCopies`; assert the delivered file's `frameworkVersion` equals the intended worktree's `VERSION` (not merely "a number"). |
| M4 | **den-refresh partial application** | whole-tree re-scaffold (H1, HYPOTHESIS); a failed run can refresh model-groups.json while manifest/config/agent stamps stay 0.167.1, or vice versa. | `git diff --stat` review; assert `.ai-badger/config.json` and `.ai-badger/manifest.json` both stamp the new version; re-run refresh and require no further drift (`reScaffolded: false` or empty `drift.changed`); re-run B1+B2. |
| M5 | **Generated-file guard / hand edit** | `.ai-badger/model-groups.json` is manifest-managed `seedOnce:false` (`manifest.json:1634-1637`); the guard denies Edit/Write on it — VERIFIED by piping a Write payload to `generated_file_guard.py` in both worktrees (deny JSON returned). Override comes from the hook process env (`:20,:155-157`), not settable from a tool call. | the deny reason itself; after any hand edit the manifest hash no longer matches the file, so the next scaffold reverts it / `scaffold_freshness_guard` reds. Legitimate path is den-refresh (scaffolder writes, not an edit tool). |
| M6 | **Queue/frozen precedence wrong for right-looking reasons** | three registries can disagree (frozen / pbi project / framework canonical) and four ranks override (tool model > frontmatter > level > session, `delegation-core.ts:1254`, `delegation-queue.ts:339-347`). | queue tests deliberately exercise frozen (no file), level-integration 7b the project path; join-7a's DISTINCT sentinel (`:90-101`) catches frozen leaking into a project read; live `levelOverride` proves rank-1 precedence; B3/B4 assert `source`. |
| M7 | **Version-stamp skew** | canonical bumped but pbi refreshed from an older root; or `frameworkVersion != VERSION`. | A3/B5 assertions; `test_model_tiers_integration.py:204` and L0-11 (`:341-342`, seed vs repo `VERSION`). |
| M8 | **Pin accepted but model rejected → silent retry** | on exit 1 with no progress event and a model-startup stderr, the runner respawns on the session model and records `modelFallback` (`delegation-runner.ts:512-560`). The delegation still "works" on a different model. | read the run log/note for `modelFallback: --model … was rejected`; `deepseek/deepseek-v4-flash` price/availability in pi's catalog is not in doubt — `deepseek/deepseek-v4.1-flash` is present in `~/.pi/agent/models-store.json` (VERIFIED) — but assert the argv, not the run's success. |
| M9 | **Wrong cwd basis** | resolution reads `toolCtx.cwd` (`index.ts:1157`, `delegation-queue.ts:330`) while the child runs at `params.cwd`; a probe from the wrong directory reports `frozen` and "proves" the wrong leg. | every probe prints `source` and fails unless it is the expected one; never accept a bare id. |

## Local vs CI

Selection mechanisms, per repo: pbi `commands.test = bun run test` (`.ai-badger/config.json`) = `bun test` (`package.json`); framework `commands.test = python3 -m pytest -q` (`.ai-badger/config.json`).

**pbi.** Per edit: B1 narrow (3 files, baseline 57 tests) + B2 typecheck — not per micro-edit, and never the full suite repeatedly. Once per branch, before push: `bun run test` (B9). **CI owns** `bun test` + typecheck on PR (`.github/workflows/ci.yml:48,51`) and the same pair in auto-bump after merge (`auto-bump.yml:66,69`) — do not re-run locally after push. **Local/operator only by design:** B7 `bun publish.ts` + `bun run check` (ci.yml header says `--check` is local-only because CI has no user scope), B8 live delegation watch, the B6 refresh diff review.

**framework.** Per edit: A1 `validate --all` + A2 narrow (baseline 111 tests) + the touched lanes (`version-sync index docs release scaffold`; the pre-push hook runs them automatically — `verify.sh:61,232-247`). Once per branch before push: full `python3 -m pytest tests/ -q` + pylint (RELEASING.md step 6). **CI owns and the push skips:** `verify.sh pytest`, `verify.sh pylint` (`.github/workflows/pylint.yml`) and `gates/consumer_journey.py` (`.github/workflows/consumer-journey.yml`) — `CI_ONLY_LANES` at `verify.sh:80`. The self-scaffold + `version_sync/changelog_index/index_build` regeneration is local, committed with the PR; the journey (A6) is CI's executable form of A5.

**One manual full run per repo per change-set**, then leave repeats to CI; the probes (B3/B4/B8) are not suite runs and are per-verification, not per-edit.