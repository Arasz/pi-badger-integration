# Research: pi 1.0.3 — what changed and what it touches here

**Date:** 2026-10-05
**Task:** `pbi-pi-v103-changelog-integration-adjust` (low loop)
**Question:** What exactly changed in pi 1.0.3 (installed) relative to the pinned 1.0.2, and which changes require edits to this repo's extensions, tests, pin or docs?

**Predecessor record:** `docs/howto/update-integrations.md` §"Moving to pi 1.0.0" and §"pi 1.0.1 / 1.0.2" (the same exercise run for those releases), task `pbi-pi-v1-changelog-integration-adjust` (PR #40).

**Method:** read the shipped `CHANGELOG.md` for 1.0.3, then compare the pinned dependency tree (repo `node_modules`, pi 1.0.2) against the installed tree (`~/.bun/install/global/node_modules`, pi 1.0.3) file by file, and grep this repo for every changed surface. Grades: `[MEASURED]` command output, `[READ]` code/docs, `[INFERRED]`, `[UNVERIFIED]`.

## A. What 1.0.3 changed relative to 1.0.2

**A1 — The extension-facing packages, by file diff [MEASURED].** `diff -rq` on every `@earendil-works/*` package in the pinned tree vs the installed tree, excluding sourcemaps:

| package | pinned / installed | dist changes 1.0.2 → 1.0.3 |
|---|---|---|
| pi-coding-agent | 1.0.2 / 1.0.3 | `config.{js,d.ts}` (new `detectInstallChange`), `core/keybindings.d.ts`, `core/model-resolver.js` (azure key), `core/bash-executor.js`, `core/tools/output-accumulator.js`, `extensions/codemode/{execute,tool}.js`, `extensions/mcp/tools.js`, `modes/interactive/interactive-mode.{js,d.ts}`, new `utils/output-files.{js,d.ts}` (generated `dist/bundle/**` chunks also differ by name; excluded here because nothing in this repo imports the bundle)
| pi-ai | 1.0.2 / 1.0.3 | `api/azure-openai-responses.*` (rewritten), new `api/azure-openai-config.*`, `auth/resolve.*`, `env-api-keys.js`, `models.js`, `models.generated.*`, `providers/all.js`, provider dir renames (`providers/azure-openai-responses.{js,d.ts,.models.*}` → `providers/azure.*`, `providers/data/azure-openai-responses.json` → `azure.json`, `.manifest.json`), provider data JSON (amazon-bedrock, opencode-go, openrouter, vercel-ai-gateway), `types.d.ts` (`KnownProvider` rename) |
| pi-tui | 1.0.2 / 1.0.3 | `dist/keybindings.{js,d.ts}` only |
| pi-mcp | 1.0.2 / 1.0.3 | none (package.json/CHANGELOG only) |
| chord, pi-agent-core, pi-codemode, pi-telemetry | 1.0.2 / 1.0.3 | none — `dist/` byte-identical |
| pi-client, pi-protocol | 0.84.4 / 0.85.0 | stale 0.84.4 leftovers in the repo tree, **not dependencies of pi-coding-agent 1.0.x**; no extension source imports them (only `extensions/subagent/bun.lock` mentions them) — out of scope |

*Evidence:* `diff -rq node_modules/@earendil-works/<pkg> ~/.bun/install/global/node_modules/@earendil-works/<pkg>` (run from the repo root, 2026-10-05); per-package versions read from each `package.json`.

**A2 — The extension API surface is byte-identical [MEASURED].** `dist/index.d.ts` and `dist/core/extensions/types.d.ts` compare equal between 1.0.2 and 1.0.3 (`cmp` exit 0), so no handler, event, registration or context type changed.

**A3 — pi-ai retry/overflow signal sets are byte-identical [MEASURED].** `cmp node_modules/@earendil-works/pi-ai/dist/utils/retry.js ~/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/utils/retry.js` exit 0; same for `overflow.js`. The 1.0.2 re-sync the repo shipped in PR #42 therefore stays current with 1.0.3.

**A4 — 1.0.3 changelog items that could plausibly touch this repo [READ].** From `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` §1.0.3:

| changelog item | surface |
|---|---|
| Azure provider renamed `azure-openai-responses` → `azure`; Foundry Chat Completions added | `KnownProvider` union, provider dir, provider data |
| Codemode `image()` saves each image to a temp file and names the path | `extensions/codemode/execute.js` |
| Output files (truncated tool output, binary MCP resources, codemode images) are user-only readable | new `utils/output-files.js`, used by bash-executor, output-accumulator, mcp tools, codemode |
| `Home`/`End` always move the editor cursor; fullscreen transcript top/bottom moved to `Ctrl+Home`/`Ctrl+End` | `pi-tui` keybindings table, `core/keybindings.d.ts` |
| Fixed: OAuth refresh cancel, codemode after a pnpm global update (new install-change detection), interactive `EIO` crash | `config.detectInstallChange`, `interactive-mode.js` |

## B. Impact on this repo's extensions

**B1 — Azure rename: no code reference anywhere [MEASURED].** `rg -n "azure|azure-openai" extensions tests` returns nothing; the remaining checkout hits are unrelated framework scaffolding prose under `.ai-badger/skills/`. **No edit required; changelog note only.**

**B2 — router-fallback: no re-sync needed [MEASURED].** Its inline pattern sets are [in `router-fallback-core.ts`](../../extensions/router-fallback/router-fallback-core.ts) and were re-synced to 1.0.2 in #42 (`22d27bb`). Since pi-ai's `retry.js`/`overflow.js` are unchanged in 1.0.3 (A3), the copies can stay as they are. Re-verify by diff as part of this task's gates, not by editing.

**B3 — shift-enter-newline: keybinding defaults changed under it, but it never reads them [MEASURED].** The extension binds `Shift+Enter` via the editor path (`extensions/shift-enter-newline/index.ts:126-165`). Its only keybinding read is `getKeybindings()` for its own `/shift-enter-debug` command, which reads `tui.input.newLine`/`tui.input.submit` (`:174-176`); it never reads the moved `tui.editor.cursorLine*` or `tui.altScreen.*` defaults. `rg -n "altScreen|defaultKeys|\"home\"|\"end\"" extensions tests` finds no reference to the moved bindings (the `action: "end"` hits are router-fallback's own enum). The pi-tui change is a `defaultKeys` literal move only (fullscreen top/bottom `home`/`end` → `ctrl+home`/`ctrl+end`). **No edit required; changelog note only.**

**B4 — codemode/output-file changes: no consumer here [MEASURED].** No extension imports `saveToTempFile` or the new `utils/output-files.js` (the helper is pi-internal). `console-capture` writes its own rotating log (`extensions/console-capture/index.ts`), not pi's temp files. `decision-router` consumes tool *declarations* (`exposure`), unchanged in 1.0.3 (A2). **No edit required.**

**B5 — `detectInstallChange` is additive [READ].** A new exported function in `config.d.ts`; nothing that exists changed shape. **No edit required.**

**B6 — update-check deliberately does not track pi's version [READ].** `docs/howto/update-integrations.md` §What it does: "it does not check pi's version" — the check compares this repo's release, not pi's. **No edit required.**

## C. Open hypotheses for this task's gates

- **H1 [VERIFIED by the s1 gate]** — `bun run test` = 1824 pass / 8 skip / 0 fail and `bun run typecheck` exit 0 with the devDependency at 1.0.3.
- **H2 [VERIFIED by the s3 gate]** — `bun run publish` then a real pi 1.0.3 print-mode session (`-p ... --no-session`) exited 0 with no extension diagnostics; transcripts at `/var/folders/k9/gxjyv0q50tn0_sngj8zg30140000gn/T/tmp.008DACBkM2/`.
- **H3 [VERIFIED by the s1 gate]** — the refreshed `bun.lock` moved only the `@earendil-works/*` family, and typecheck is green, so no transitive breakage; `typebox@1.3.7` stayed as-is.
- **H4 [VERIFIED]** — CI run 37377078462's test job is green on branch head `6bc7542`.

## D. Process mechanics verified

**D1 — CI and the global install follow the pin [READ].** `.github/workflows/ci.yml` installs pi globally with `PI_VERSION` read from `package.json` `devDependencies`, and `tests/setup.ts:19-41` resolves pi, pi-tui and jiti from that global install. Bumping the pin is therefore the switch for both CI and local suite runs.

**D2 — Releases are automatic, and a VERSION touch overrides them [READ].** `.github/workflows/auto-bump.yml`: a push to main that does not touch `VERSION` runs tests and patch-bumps + tags + releases; a push that touches `VERSION` stands down in favour of the hand-picked version. `release.yml` tags on a VERSION-only push. So this task can either let the merge auto-bump or bump `VERSION` deliberately; the doc-update precedent (PR #40/#42) let main's automation carry the release.

**D3 — The locally installed user scope is `~/.pi/agent/extensions/` [READ].** `publish.ts:80` (`USER_EXTENSIONS_DIR`); `bun run publish` writes it, `bun run check` verifies it read-only. The end-to-end extension-load check (H2) runs after publish on the real machine, from the task worktree.

**D4 — Pre-existing stray worktree, not this task's [MEASURED].** `.ai-badger/worktrees/pbi-post-merge-hardening` is clean, on `fix/pbi-post-merge-hardening` (tip `1e995e6`, 1.1.20 era) and has no tracker row. Left untouched; noted so `finish` cleanup is not blamed for it.