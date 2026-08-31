# Spec: Scaffold freshness guard must be blind-spot-proof (F2 + `--skills ''` trap)

| | |
|---|---|
| **Status** | Draft — ready for ai-badger task intake |
| **Date** | 2026-08-30 |
| **Target repo** | [Arasz/ai-badger](https://github.com/Arasz/ai-badger) (main @ `19e28a7b`, v0.149.1) |
| **Origin** | Independent review d-16 finding F2 + in-session incident during PR #455 (0.149.0) |
| **Evidence log** | `~/.pi/agent/subagent-logs/d-16.jsonl` (review record), commits `50f09b11`, `d6e7975f`, PR #455 disposition comment |
| **Raised by** | pi-badger-integration session, 2026-08-30 |

---

## Background

The scaffold freshness guard (`gates/scaffold_freshness_guard.py`, wired into the lefthook
pre-commit/pre-push lanes) enforces the repo's core promise: **re-scaffolding ai-badger
against itself changes 0 paths.** It compares the working tree against the paths recorded in
`.ai-badger/manifest.json` (`entries` — the managed set) and fails when a re-scaffold would
differ.

Two defects break that promise. Both were witnessed live during 0.149.0 preparation; both
currently pass every gate in CI.

## Problem 1 (F2): the guard passes a stale tree when the manifest under-reports the managed set

**Witnessed.** Two consecutive runs of

```bash
AI_BADGER_MCP_AVAILABILITY=all python3 features/common/skills/welcome-ai-badger/scripts/scaffold.py \
  --config .ai-badger/config.json --target . --root . --no-install
```

on the same unchanged tree produced **different managed sets** (reviewer recorded a 42-path
delta and "11 of 32 skills reused" between runs; `PYTHONHASHSEED` was eliminated as the
cause). A scaffold run that under-produces the skill set removes those mirrors from
`manifest.json`'s `entries` — and the guard compares **only** what `entries` claims. Result:
a hand-edited skill mirror on a tree with an under-produced manifest **passes the guard
green**. The blindness compounds: once entries lose a path, no later guard run can ever
regain it.

**Why this matters.** `50f09b11` (the 0.148.0 merge repair) existed precisely because this
under-production had already happened in-repo. The guard's provocation tests
(`tests/test_scaffold_freshness_guard.py`) do not cover the under-produced-manifest scenario
— they pass while the guard is broken.

**Open question (part of the work).** *Why* the scaffolder under-produces
nondeterministically. The reuse/fingerprint path in
`features/common/skills/welcome-ai-badger/scripts/scaffold.py` decides per-skill whether to
regenerate; that decision is flaky across runs. Root cause must be identified, not worked
around.

## Problem 2: the guard's own remediation recommends a blinding command

`gates/scaffold_freshness_guard.py` L128–137:

```python
def rescaffold_argv(...) -> List[str]:
    """The scaffolder command line — one builder, so the printed advice is what the guard ran."""
    return [python, scaffold, "--config", config, "--target", target, "--root", root,
            "--no-install", "--skills", ""]

def remediation() -> str:
    """The command that makes a stale tree fresh: the guard's own, environment included."""
```

The guard's failure output tells the user to fix staleness with a command carrying
**`--skills ''`**. That flag regenerates the tree *without* the skill set and writes a
manifest whose `entries` exclude the skill mirrors — the exact narrowing from Problem 1,
self-inflicted. The docstring "The command that makes a stale tree fresh" is false for any
skill-mirror staleness, which is the most common staleness in this repo (witnessed again at
`d6e7975f`, where a parser edit required an in-commit mirror regen to pass the guard).

Note: `--skills ''` itself is a legitimate, tested mode (`tests/test_scaffold_empty_skills.py`)
— the defect is the **guard recommending it as the staleness remediation**.

## Required changes

- **R1 — Determinism (root cause).** Fix the scaffolder so two consecutive runs on an
  unchanged tree produce byte-identical manifests. Identify why the reuse/fingerprint logic
  under-produces (candidate: per-skill fingerprint computed from inputs that vary between
  runs). The fix must be pinned by a determinism test, not asserted in a comment.
- **R2 — Guard detects narrowing.** The guard must fail — with a distinct, named message —
  when the managed set it is comparing against is smaller than the full generated set. Do not
  rely on manifest entries alone: derive the expected set independently (e.g. run the
  scaffolder into a temp dir during the guard run and diff its manifest's entries against the
  repo's) or carry a count/signature baseline that survives narrowing.
- **R3 — Remediation message.** `remediation()` must never advise a command that can shrink
  the managed set: drop `--skills ''` from `rescaffold_argv()` (keep the builder shared, keep
  the "printed advice is what the guard ran" property) or emit the full-command form. If
  `--skills ''` remains reachable for intentional partial scaffolds, it must be documented as
  dangerous-for-remediation.
- **R4 — Repair the current manifest.** Regenerate so `entries` once again covers the full
  generated set (re-scaffold changes 0 paths on the fixed tree). Confirm whether the 42-path
  loss from the 0.148.0 era is still present at v0.149.1 and repair it.
- **R5 — Maintainer documentation.** One gotcha note (README or the welcome-ai-badger skill):
  *never* remediate freshness-guard failures with `--skills ''`; regenerated mirrors ride in
  the same commit as their source edit.

## Acceptance criteria

RED-first discipline applies: every provocation AC (AC2–AC4) must be **witnessed failing**
against the pre-fix code, with the red output pasted in the task record, before the fix lands.

- **AC0 (north star).** On the fixed tree, running the full scaffold command twice
  consecutively leaves `git status` clean after both runs, and the freshness guard passes.
- **AC1 (determinism, pinned).** A test asserts: scaffold → snapshot `manifest.json` →
  scaffold again → manifests are byte-identical (or differ only in explicitly-normalized
  stamp fields). Fails on pre-fix code (the witnessed flake).
- **AC2 (blind-spot provocation).** A test constructs the F2 scenario: hand-edit a skill
  mirror + use a manifest whose `entries` exclude that path → the guard must **exit
  non-zero** with a message naming the narrowing. Fails (guard exits 0) on pre-fix code.
- **AC3 (trap provocation).** A test runs the guard, captures its printed remediation,
  executes it verbatim, then re-runs the guard on a tree with a hand-edited skill mirror →
  the second guard run must still fail. Fails on pre-fix code (remediation + `--skills ''`
  produces a green guard on a stale tree).
- **AC4 (message audit).** The guard's failure output contains no command string that
  omits the skills set; a test greps the rendered remediation for `--skills` followed by an
  empty value and fails if present.
- **AC5 (repair verified).** `manifest.json` `entries` covers the complete generated set;
  evidenced by AC0 passing on the merged fix branch.
- **AC6 (gates).** Full pytest + pylint 10.00 + `verify.sh pre-push` green on the fix branch.
  `gates/` is shipped surface → version bump + changelog entry per the release gate.

## Out of scope

- Consumer-repo scaffolding behavior (pi-badger-integration, jsaa) — fixed by re-running
  den-refresh after this lands.
- The concurrent-session user-scope install drift (tracked separately in the
  interactive-subagent-delegation plan, point 2).
- Renaming or relocating the guard; changing the release-lane version policy.

## References

- Guard: `gates/scaffold_freshness_guard.py` (`differences_a_rescaffold_would_introduce` L276,
  `rescaffold_argv` L128–133, `remediation` L135–137)
- Scaffolder: `features/common/skills/welcome-ai-badger/scripts/scaffold.py` (skill reuse logic)
- Tests: `tests/test_scaffold_freshness_guard.py` (extend), `tests/test_scaffold_empty_skills.py`
  (the legitimate `--skills ''` mode — do not break it)
- Manifest: `.ai-badger/manifest.json` (`entries` = managed set)
- In-session incidents: `d6e7975f` (mirror regen required in-commit), `50f09b11` (prior
  managed-set repair), PR #455 disposition comment (F2 filing)
- Related memory: ai-raccoon entry `7d10048b22d8f364095d9812ff71b2a5cace6578f5da03c88db9db51e8af7da3`
