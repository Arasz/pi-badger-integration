# Plan: directory packages for every pi extension; ai-badger reduced to minimal pi layer

**Verified baseline (re-checked 2026-):** repo A HEAD is `1ea120b` (two commits past `7044d45`), clean; `bun test` = 62 pass / 14 fail / 1 error (RED as expected); `~/.pi/agent/extensions/` holds `ai-badger/`, `pi-cron/`, `pi-mcp-tools/`, **stale flat `session-signals.ts` + `shift-enter-newline.ts`, and `ai-badger-subagent/`** (old repo-B-installed name). pi 0.84.4 docs confirm discovery of `~/.pi/agent/extensions/<name>/index.ts` only. Repo A root has **no `typebox` devDep**, but `extensions/subagent/index.ts` imports `typebox` — ported tests will not resolve it without a fix (P3).

## (a) Objective

Make every child of `extensions/` a proper directory package (manifest + `index.ts`), rewrite `publish.ts` to install whole extension directories generically (preserving every reviewed semantic: temp-rename atomicity, `--check` purity, `--ai-badger` vendor-only, adapter exact-set equality), mirror `tests/` to `tests/<extension>/` covering all five extensions, and strip repo B to a minimal translation layer (adapter + persona delivery only) — repo A becomes the sole canonical owner/installer of the pi extensions.

## Settled questions

- **R1 manifests**: metadata only (pi discovers `index.ts` regardless). Model on `pi-cron/package.json`: private, type module, main, description, dep on `@earendil-works/pi-coding-agent`. Entries renamed to `index.ts` (git mv, no content change).
- **R2 node_modules**: `--check` treats missing destination `node_modules` as a **warning line, exit 0** — it is derived state re-creatable via `bun install` from shipped `package.json`+`bun.lock`; making it drift would exit 1 on a correct-but-not-bun-installed machine. Extra-file check on `ownedDir` **exempts the whole `node_modules` subtree** (same reason) and walks **recursively**, so nested stale files are caught and nested canonical files are not misflagged as extras. `drifts()` returns `{ problems, warnings }` — `main()` prints warnings unconditionally but exits non-zero only on `problems` (review finding F4: the old `string[]` shape had no non-fatal channel). Install copies local `node_modules` when present; prints a loud warning when absent (pi-mcp-tools needs `@modelcontextprotocol/sdk` at runtime). Rejected: hardcoding a per-extension allowlist of files — the generic recursive rule is simpler and self-maintaining (trade-off, accepted: editor strays like `.DS_Store` ship too).
- **Test naming**: `tests/<extension>/<topic>.test.ts` (matches existing `session-signals.test.ts` style; allows multiple files per extension, e.g. pi-mcp-tools).
- **Subagent install name**: generic rule "dir name = install name" wins → installs as `~/.pi/agent/extensions/subagent/`. Repo B's old `ai-badger-subagent/` becomes a stale orphan; handled by one-time README cleanup note (publish must NOT auto-delete anything outside its `ownedDir`s). Same note covers the stale flat `session-signals.ts`/`shift-enter-newline.ts` — leaving them would make pi load duplicates (double hooks/tools).
- **Sequencing answer**: **repo A fully green first, then repo B surgery, then cross-repo verification.** The repos are independent until P6 (copies already byte-identical on both sides); making repo A green first gives repo B's moved-out tests a green destination, and repo B's runtime behaviour doesn't change until its surgery lands.

## (b) Packages in merge order

### P1 — Manifests + entry renames (repo A)
- **Purpose**: satisfy requirement 1; make all five extensions pi-discoverable directory packages.
- **Files**: create `extensions/session-signals/package.json`, `extensions/shift-enter-newline/package.json` (modelled on pi-cron's); `git mv extensions/session-signals/session-signals.ts extensions/session-signals/index.ts`; same for shift-enter-newline.
- **AC**: each of the five `extensions/*` dirs contains `package.json` + `index.ts`; no flat `*.ts` files remain at `extensions/` top level outside dirs; `git status` shows renames.
- **Gate**: `git status --porcelain extensions/` + `bunx tsc --noEmit -p .` — **tsc is red at baseline** (dead flat imports in `tests/`, fixed only in P3): P1's gate is "tsc errors limited to the known dead-import lines in tests/", not a clean tsc (review finding F1).
- **Parallel**: no — P2/P3 depend on final paths. Serial after P1: P2 and P3.

### P2 — publish.ts generic directory model (repo A)
- **Purpose**: requirement 2; single generic installer for all extension dirs.
- **Files**: edit `publish.ts`; edit `README.md` (one-time user-scope cleanup section: delete stale flat `session-signals.ts`, `shift-enter-newline.ts`, and `ai-badger-subagent/` dir); create `tests/publish/publish.test.ts`.
- **Edit shape**: replace `singleFileTarget`/`shiftEnterTarget`/`sessionSignalsTarget`/their constants with `directoryTarget(name, { root = ROOT, userDir = USER_EXTENSIONS_DIR } = {})` — **source root and user dir injectable** so tests aim at temp fixture trees instead of the developer's real user scope (review finding F3): pairs = every file recursively under `<root>/extensions/<name>/` **except the `node_modules` subtree**; `ownedDir = <userDir>/<name>/`. `drifts()` returns `{ problems, warnings }` (F4): problems = missing/extra/byte-differing canonical files (extra-file walk recursive, `node_modules` subtree exempt); warnings = missing destination `node_modules`. Targets = adapter (unchanged) + the five dir names. Install: adapter unchanged; per-file temp-rename for canonical pairs; copy `node_modules` recursively when present locally (same `install()` per file), loud warning when absent. `--check`: exit 1 on any problem line; warning lines printed, never fatal. `--ai-badger`: untouched (vendor-only, refuses with --check, exact-set equality, ADAPTER_FILES unchanged). Export `directoryTarget`/`drifts` for tests.
- **AC**: `bun publish.ts --check` never writes and exits 1 on drift, 0 when in sync; `--ai-badger` combined with `--check` exits 1; vendoring refuses a nonexistent repo-B adapter dir; install writes every non-node_modules file of each extension dir with `.publishing-<pid>` staging; README documents the stale-file cleanup.
- **Gate**: `bun test tests/publish/publish.test.ts` + `bun publish.ts --check` (read-only; **any unrelated pre-existing user-scope drift is out of scope — report, don't fix**).
- **Parallel**: yes, with P3 (disjoint files; both depend on P1).

### P3 — Test tree restructure + full extension coverage (repo A)
- **Purpose**: requirement 3; tests mirror directory structure, cover every extension.
- **Prerequisite**: `@sinclair/typebox` (pi-mcp-tools' schema dep — a DIFFERENT package from pi's `typebox`) resolves only from the gitignored `extensions/pi-mcp-tools/node_modules`; run `bun install` inside `extensions/pi-mcp-tools/` before the new tests, and note the fresh-clone asymmetry in that test file's header (review finding F7).
- **Files**: `git mv tests/session-signals.test.ts tests/session-signals/session-signals.test.ts` (fix import → `../../extensions/session-signals/index.ts`); `git mv tests/shift-enter.test.ts tests/shift-enter-newline/shift-enter.test.ts`; edit `tests/setup.ts` (`EXTENSION_PATH` → `extensions/shift-enter-newline/index.ts`; **no typebox alias** — review finding F2: nothing jiti-loaded imports typebox, the hoisted global sits at `~/.bun/install/global/node_modules/typebox` anyway, and the root devDep resolves direct imports); add `typebox: "1.3.7"` to root `package.json` devDeps + `bun install` (needed because ported tests import extension sources directly, not via jiti); copy `features/pi/tests/cron-schedule.test.ts` + `subagent.test.ts` into `tests/pi-cron/cron-schedule.test.ts` / `tests/subagent/subagent.test.ts` with imports re-pointed to `../../extensions/pi-cron/index.ts` / `../../extensions/subagent/index.ts`; create `tests/pi-mcp-tools/toolFilter.test.ts`, `tests/pi-mcp-tools/schema-converter.test.ts` (JSON-schema→typebox mapping incl. fallback branches), `tests/pi-mcp-tools/config-loader.test.ts` — **scoped to `loadFromFile`/`validateConfig`/`getEnabledServers` only** (review finding F12: `loadDisabledTools`/`saveDisabledTools` hardcode the real `~/.pi/agent/settings.json` at import; a misfiring test would write the developer's live settings — never import-exercise those two).
- **Honesty line**: `McpClient`/`McpRegistry`/`McpToolAdapter` need a live MCP server or heavy stubbing — **no faked coverage**; state in the test files' header comment that they are integration-flavoured and out of unit scope. (If during implementation `McpToolAdapter` proves pure, an optional 4th file may cover it.)
- **AC**: `tests/<name>/` exists for all five extensions; no test imports a dead flat path; cron+subagent tests pass against repo A's canonical copies; root devDeps pin typebox 1.3.7 (pi's aliased version).
- **Gate**: `bun test` (expect 0 fail / 0 error) + `bunx tsc --noEmit -p .`.
- **Parallel**: yes, with P2.

### P4 — Repo A integration package
- **Purpose**: repo A green as a whole before repo B is touched.
- **Files**: none (verification only); fixes go back into P2/P3 scope.
- **AC**: full `bun test` green; `tsc --noEmit` clean; `bun publish.ts --check` exit code justified line-by-line (any unrelated user-scope drift listed as out of scope); `bun publish.ts --ai-badger /Users/arasz/RiderProjects/ai-badger` followed by `git -C /Users/arasz/RiderProjects/ai-badger status --porcelain features/pi/adjustments/adapter` shows **no changes** (proves byte-identity of the untouched adapter).
- **Gate**: `bun test && bunx tsc --noEmit -p .` clean, PLUS `bun publish.ts --check` **run with every reported line classified** — zero task-caused lines required; unrelated pre-existing user-scope drift is listed as out of scope (review finding F8: `--check` exits 1 until the operator's real install, so a bare exit-code gate would short-circuit on correct work). **Then merge this task branch to main.**

### P5 — Repo B surgery (branch `task/pbi-minimal-pi-layer`)
- **Purpose**: requirement 4; minimal translation layer.
- **Files**: delete `features/pi/cron/`, `features/pi/subagent/`, `features/pi/adjustments/adjust_cron.py`; edit `adjustment.json` (remove the cron entry); edit `adjust_agents.py` (strip the user-half `_install_subagent_extension` + `USER_EXTENSIONS_DIR` + `SUBAGENT_DIR`; keep persona delivery; reword docstring: personas delivered project-scope, reader shipped by pi-badger-integration's publish flow); edit `features/pi/tsconfig.json` (drop `cron/**/*.ts`, `subagent/**/*.ts` — **found during verification, not in the original list**); edit `features/pi/package.json` (drop `typebox` devDep; `bun install` in features/pi to refresh its bun.lock); reword `features/common/support.json` personas mechanism/scaffoldedBy to point at pi-badger-integration; `git mv` `cron-schedule.test.ts`+`subagent.test.ts` out (deleted — now canonical in repo A); edit `tests/test_pi_adjustments.py` (fixture at ~line 36 keeps loading adjust_hooks — tests 252/323 survive — but drops the adjust_cron load; delete the **six** `test_adjust_cron_*` tests **by name** at ~184, ~192, ~291, ~351, ~380, ~397 — review finding F6: they are interleaved with `test_pi_session_source_*` (205–236) and the adjust_hooks tests (252, 323), which MUST survive; a line-range delete would kill live tests); edit `tests/test_pi_agents.py` (review finding F5, wider than the plan draft: strip the `USER_EXTENSIONS_DIR` monkeypatch from the `agents_arm` fixture ~line 44 — it raises AttributeError collection-wide once the attribute is gone; delete the user-half tests at ~247 and ~264 AND the missing-subagent ERROR test ~line 274; fix line ~197 docstring referencing adjust_cron); edit repo B's `index.json` pi stack entry (~lines 938–939) to drop `adjust_cron` — review finding F14.
- **AC**: `grep -rn "features/pi/cron\|features/pi/subagent\|adjust_cron" tests/ features/` returns **zero non-historical hits** (docs/ is explicitly out of scope for this check — review finding F11); `features/pi/` contains only `adjustments/` (adapter + py adjusters minus cron) + harness files; no pytest import of the deleted module; `test_support_scaffolded_by.py` still passes (support.json rewording must not name any script absent from adjustment.json — adjust_agents.py survives, adjust_cron.py must not be named — review finding F15).
- **Gate**: `python3 -m pytest -q` green + `bun test features/pi` green (3 files: adapter-entry, away-mode, hook-bridge).
- **Parallel**: could have run beside P2/P3 (independent repo), but P6 ordering makes serial-after-P4 the safe default.

### P6 — Cross-repo integration (LAST)
- **Purpose**: prove the whole task, both repos.
- **Files**: none (verification); fixes go back into owning package.
- **AC**: repo A: full `bun test`, `tsc`, `publish --check` all clean/justified; repo B on its branch: `pytest -q` and `bun test features/pi` green; adapter byte-identity re-verified (`diff -r` both directions); `support.json` wording names pi-badger-integration as the extension source.
- **Gate**: `cd repo-A && bun test && bunx tsc --noEmit -p . && bun publish.ts --check`; `cd repo-B && python3 -m pytest -q && bun test features/pi`.
- **Operator step (after P6, user's call)**: run `bun publish.ts` for real, then execute the README one-time cleanup (stale flat files + `ai-badger-subagent/`).

## (c) Test list (failing-first order per package)

- **P2** `tests/publish/publish.test.ts` (all against **injected** temp trees, never the real user scope): ① `directoryTarget("pi-cron", { root, userDir })` derives one pair per non-node_modules file recursively (temp fixture tree incl. a nested subdir); ② `node_modules` in the destination is exempt from extra-file drift, nested non-node_modules strays are NOT; ③ missing/extra/byte-differing canonical file each land in `problems`; absent destination `node_modules` lands in `warnings`; ④ `--check`+`--ai-badger` CLI refusal (call `main([...])`) and warnings-don't-fatal exit behaviour. Write ①–④ against current code first (they fail — old signature + `string[]` shape), then implement.
- **P3**: ported `session-signals.test.ts`/`shift-enter.test.ts` fail on dead imports until paths fixed; ported cron/subagent tests fail (module not found) until copies + typebox devDep land; mcp-tools tests are new (write against spec, then run — logic is pre-existing, so these should pass immediately; that's acceptable, they guard pure logic).
- **P5**: `pytest tests/test_pi_adjustments.py tests/test_pi_agents.py` fails on missing `adjust_cron.py` until its tests are deleted — deletion order: tests first, then module.

## (d′) Budget cut order (review finding F10)

If the session tightens, defer in this order: ① the three NEW pi-mcp-tools test files (additive coverage of pre-existing pure logic — not part of R3's tree-mirror core), ② SchemaConverter fallback-branch depth (keep the main mapping cases). NOT deferrable: publish tests, the two ported test files, P5 surgery, both gate suites.

## (d) Risks and mitigations (max 5)

1. **Duplicate extension loading from stale user-scope copies** (flat files; `ai-badger-subagent/`) → README one-time cleanup note in P2 + P6 operator step; publish never auto-deletes outside `ownedDir`.
2. **pi-mcp-tools ships without runtime deps** if local `node_modules` absent at install → loud install warning (P2) + warning in `--check`; never silent.
3. **Repo B pytest has unknown additional couplings** to deleted files → pre-flight `grep` (done: only `test_pi_adjustments.py`, `test_pi_agents.py`, `support.json`, `adjustment.json`, `features/pi/tsconfig.json`; changelogs historical) + P5 gate greps for residue before declaring done.
4. **typebox version drift** between repo A root (1.3.7 pin) and pi's runtime alias → pin exact `1.3.7`; alias in `setup.ts` points at pi's own copy for jiti-loaded code.
5. **--check against live user scope reports unrelated pre-existing drift** → plan-level rule: implementers classify every drift line as "caused by this task" or "out of scope"; only the former may block P4/P6.

## (e) Out of scope

- Any edit to the adapter (`features/pi/adjustments/adapter/**`, both repos) — already the minimal translation layer.
- PR/CI machinery for repo B (local branch only) and any remote for repo A.
- Auto-deleting anything in `~/.pi/agent/extensions/` outside publish's documented commands; fixing unrelated user-scope drift.
- Unit tests requiring a live MCP server (`McpClient`, `McpRegistry`); publishing any extension to npm; pi project-scope extension support; `adjust_hooks.py`/`adjust_mcp.py`/`adjust_skills.py`/`adjust_task.py` beyond what the adjustment.json edit forces (nothing).
