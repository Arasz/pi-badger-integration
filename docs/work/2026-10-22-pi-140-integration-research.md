# Research: pi 1.4.0 — does this repo's extension set need to change for it?

**Date:** 2026-10-22
**Question:** Which changes in pi 1.4.0 (the version installed on this machine) require edits to this repo's extensions, tests, pin or docs?

**Predecessor record:** `docs/work/2026-10-05-pi-103-integration-research.md` (the same exercise for pi 1.0.3, task `pbi-pi-v103-changelog-integration-adjust`, PR #44) and `docs/howto/update-integrations.md` §"pi 1.0.0" / §"pi 1.0.3".

**Method:** read the shipped `CHANGELOG.md` for 1.4.0, then compare the 1.3.0 and 1.4.0 packages file by file (`npm pack` of both versions against the bun-global install), then grep this repo for every surface the changelog and the diffs touch. Grades: `[MEASURED]` command output, `[READ]` code/docs, `[INFERRED]`, `[UNVERIFIED]`.

## Findings

### F1 — The installed pi is 1.4.0 while the repo pinned 1.3.0 [MEASURED]

The bun-global install this machine runs is pi 1.4.0; the repo's `devDependencies` pinned `@earendil-works/pi-coding-agent` at 1.3.0, and the root `node_modules` held a stale 1.0.2 tree even though `bun.lock` said 1.3.0. So the local test suite ran against a mix: the harness resolved pi from the global install (1.4.0), while `tsc` resolved types from the stale root tree (1.0.2).

**Evidence:** `grep '"version"' ~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/package.json` → `1.4.0`; `pi --version` → `1.4.0`; `git show origin/main:package.json` → `"@earendil-works/pi-coding-agent": "1.3.0"`; `grep '"version"' node_modules/@earendil-works/pi-coding-agent/package.json` before `bun install` → `1.0.2`. macOS, 2026-10-22.

### F2 — The extension-facing type surface is byte-identical between 1.3.0 and 1.4.0 [MEASURED]

No extension needed an API-shape edit: `dist/index.d.ts`, `dist/core/extensions/types.d.ts`, `dist/core/extensions/loader.d.ts` and `dist/core/sdk.d.ts` compare equal between the two releases. The `.d.ts` files that do differ are `core/agent-session.d.ts`, `core/compaction/compaction.d.ts`, `core/model-config.d.ts`, `core/provider-composer.d.ts`, `core/utils/pi-user-agent.d.ts` and `modes/interactive/interactive-mode.d.ts` — none of them an extension contract, and the `index.d.ts` that re-exports the public surface did not change.

**Evidence:** `npm pack @earendil-works/pi-coding-agent@1.3.0` extracted to `/tmp/pi140/v130`, compared with `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent` (1.4.0): `cmp` on the four files above → IDENTICAL; `diff -rq v130/dist <global>/dist` → the `.d.ts` differences listed above (no `core/extensions/types.d.ts`, no `index.d.ts`).

### F3 — pi-ai changed both signal files between 1.3.0 and 1.4.0 [MEASURED]

`utils/retry.js` and `utils/overflow.js` both differ between pi-ai 1.3.0 and 1.4.0. `retry.js` gained the ChatGPT Business workplace usage-limit signal (non-retryable), four gateway/stream retryable signals, a node-fetch transport signal, the Codex mid-stream disconnect signal, and a rewrite of the status-code alternative so a code inside a request id or byte count no longer matches. `overflow.js` gained an HTTP 413 pattern (request-size overflow). pi-ai 1.3.0 had already changed `retry.js` relative to 1.0.2.

**Evidence:** `npm pack @earendil-works/pi-ai@1.3.0 @earendil-works/pi-ai@1.4.0`, extracted to `/tmp/pi140/ai130` and `/tmp/pi140/ai140`; `cmp` on `dist/utils/retry.js` → DIFFERS, `dist/utils/overflow.js` → DIFFERS; `diff -u` output shows the added patterns listed above.

### F4 — `router-fallback`'s inline copies of those two files were still the 1.0.2 sets [MEASURED]

The extension keeps its own copies of pi-ai's signal sets, and the module header says so: "inline copies of pi-ai `utils/retry.js` (installed 1.0.2)". The copies had therefore drifted from the installed pi in two steps, 1.0.2 → 1.3.0 → 1.4.0, and the drift was behavioral, not cosmetic. Nine new test rows written before the fix failed 8 of 9 against the old copies: "stream disconnected before completion", "upstream request failed", "The service is temporarily unavailable" and "servers are currently busy" were not recognized as retryable, the ChatGPT Business workplace usage-limit signal was not recognized as billing, a `429` inside a request id was read as a throttle, and a 413 fold missed the overflow pre-check. The re-sync in this change makes all nine pass.

**Evidence:** `extensions/router-fallback/router-fallback-core.ts:34-38` (provenance comment) and the R1-R9 rows in `tests/router-fallback/router-fallback-core.test.ts`; before the fix `bun test tests/router-fallback/router-fallback-core.test.ts` → `8 fail`, after the fix → `0 fail`.

### F5 — The overflow copy only drifted in 1.4.0; the retry copy had already drifted in 1.3.0 [MEASURED]

`utils/overflow.js` is byte-identical between pi-ai 1.0.2 and 1.3.0 and differs only in 1.4.0, so the overflow half of the drift was one release old while the retry half was two. The repo's re-sync record for 1.0.2 (`22d27bb`, PR #42) therefore held until pi-ai 1.3.0 shipped, and the 2026-10-17 pin bump to pi 1.3.0 did not re-sync it.

**Evidence:** `cmp node_modules/@earendil-works/pi-ai/dist/utils/overflow.js` (the 1.0.2 tree) against `/tmp/pi140/ai130/dist/utils/overflow.js` → IDENTICAL; the same `cmp` for `retry.js` → DIFFERS (`server_busy`, `servers are currently busy`, the `service is temporarily unavailable` wording, `provider returned an error`, `unable to forward upstream`, `pending stream has been canceled` all missing from 1.0.2).

### F6 — pi's extension loader aliases the pi packages to the host's own dist [READ]

The copy of `pi-coding-agent` inside each extension's `node_modules` is inert at runtime: pi's loader builds a jiti alias map that points `@earendil-works/pi-coding-agent` at the host's own `dist/index.js`, and the same for `pi-tui`, `pi-agent-core` and the `pi-ai` subpaths. So an extension's runtime import of `CustomEditor` (the class `shift-enter-newline` extends) or `getAgentDir` (`console-capture`) resolves to the host's 1.4.0 copy, not the bundled one. The bundled copy is a type source only, which is why its 1.3.0 `.d.ts` files are still valid for a 1.4.0 host.

**Evidence:** `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:53-86` (the alias map: `"@earendil-works/pi-coding-agent": piCodingAgentEntry`, `piCodingAgentEntry = path.resolve(__dirname, "../..", "index.js")`).

### F7 — The 1.4.0 catalog retires model ids, and none of them is one this repo names [MEASURED]

Comparing the pi-ai provider data between 1.3.0 and 1.4.0, 1.4.0 removes ids including `gpt-5.4`, `gpt-5.5`, `gpt-5.3-codex-spark` (openai-codex), `mimo-v2.5`, `mimo-v2.5-pro` (xiaomi), `claude-opus-4.7`, `gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.7-flash` (github-copilot), `claude-sonnet-4` and `deepseek-v4-flash-vision-exp` (opencode). `router-fallback`'s frozen chain (`openrouter/free`, `inclusionai/ling-3.1-flash`, `groq/llama-3.3-70b-versatile`, `google/gemini-3.1-flash-lite`, `google/gemini-3.1-pro-preview`) is not among them: every id is still in the 1.4.0 provider data, and no repo source or test names a retired id.

**Evidence:** a Python pass over `/tmp/pi140/ai130/dist/providers/data/*.json` and `/tmp/pi140/ai140/dist/providers/data/*.json` comparing the model id sets per provider file (output lists the removals above); `rg "gpt-5\.4|gpt-5\.5|mimo-v2\.5|claude-opus-4\.7|claude-sonnet-4\b" extensions features tests` → only `tests/subagent-queue-model-level.test.ts:249` (`anthropic/claude-sonnet-4-5`, a fixture, not a retired id).

### F8 — The suite passes against the installed 1.4.0 with the pin moved to 1.4.0 [MEASURED]

After the pin bump and `bun install` (root `node_modules` now at 1.4.0, so `tsc` checks the 1.4.0 types), the full suite is green and the typecheck is clean.

**Evidence:** `bun test` → `2259 pass, 9 skip, 0 fail` (94 files, 73 s) and `bunx tsc --noEmit -p .` → exit 0, both on this machine with `node_modules/@earendil-works/pi-coding-agent` at 1.4.0.

### F9 — One full-suite run failed a 2 s-timeout subprocess test, and it passes in isolation [MEASURED]

The first full-suite run under 1.4.0 failed `runHook: stdin and stdout > payload arrives byte-for-byte` after 2004 ms, which is that test's own `timeoutMs: 2000`. The file passes on its own (17 pass, 0 fail), and the same test file is green in the later full run. Another session reported the same suite at 2250 pass / 9 skip / 0 fail on the same tree. This is a load-dependent flake, not a 1.4.0 regression.

**Evidence:** `/tmp/pi140/test-140.log` (first run: `1 tests failed`, the row above) versus `bun test tests/rtk/rtk-hook-runner.test.ts` → `17 pass, 0 fail`, and the later full run in F8.

### F10 — The attribution-header change does not reach this repo's one header handler [READ]

pi 1.4.0 moved provider attribution headers into pi-ai's client identity, so a `before_provider_headers` handler no longer sees the OpenRouter, NVIDIA NIM and OpenCode attribution headers. The only handler here is `rtk`'s, and it adds its own proxy headers for the `anthropic` provider only, so the removed headers never belonged to it.

**Evidence:** `extensions/rtk/index.ts:161-168` (the handler adds `proxyHeaders(...)` and returns early unless `ctx.model?.provider === "anthropic"`); the 1.4.0 changelog entry "Provider attribution headers now come from pi-ai's client identity".

### F11 — The 1.4.0 tool-activation fix changes what a resumed session sees, in the wanted direction [READ]

pi 1.4.0 makes extension tools active again on resume and on `/tree` navigation unless the extension registers them with `defaultActive: false`. The tools this repo registers (`delegate` in `subagent`, the message-bus tool, the monitor and wait tools) are meant to be available, and none of them opts out of the default, so the fix restores the intended behavior rather than changing it.

**Evidence:** the 1.4.0 changelog entry "Fixed resumed sessions and `/tree` navigation leaving extension tools inactive"; `rg "defaultActive" extensions features tests` → no match; the four `pi.registerTool({` call sites are `extensions/subagent/index.ts:1138`, `extensions/subagent/delegation-queue.ts:465`, `extensions/message-bus/index.ts:927`, `extensions/monitor/index.ts:1096` and `:1117`.

### F12 — The 1.1.0 to 1.3.0 releases were pinned without a changelog pass [READ]

The pin moved from 1.0.3 to 1.3.0 in the 2026-10-17 maintenance sweep, whose diff shows no change to the router-fallback signal copies and no new section in `docs/howto/update-integrations.md` for those three releases. One of them did touch this repo: 1.2.0 turned `before_agent_start` into a union on `messageType`, which the sweep fixed in `mem-based-rag` by narrowing before reading `event.prompt`.

**Evidence:** `git show 2a4953b --stat` (the sweep commit, "chore(deps): bump pi-coding-agent 1.3.0 ... refresh extension locks", with the commit body naming the `mem-based-rag` narrowing); `docs/howto/update-integrations.md` had sections for 1.0.0, 1.0.1/1.0.2 and 1.0.3 only.

### F13 — A live pi 1.4.0 session loading the published extensions was not run [UNVERIFIED]

The end-to-end smoke of the 1.0.3 record (a real print-mode pi session against the published user scope) was not repeated: this project's own ai-badger hook blocks spawning `pi` from a bash tool call ("ai-badger: spawning pi directly is blocked — use `delegate` instead"), and a delegated child would hit the same hook. The nearest substitute is the repo's own suite, which loads extensions through pi's real loading mechanism (jiti plus the package alias) against the global 1.4.0 install, plus `bun run publish` writing the user scope without an error. What is missing is a live interactive or print-mode session with the published extensions under pi 1.4.0.

## Still open

- The live print-mode smoke against pi 1.4.0 (see F13) would be run by an operator with the hook allowance, or from a session where the hook does not block `pi`.
- The extension `node_modules` trees still carry pi-coding-agent 1.3.0. F6 says that copy is type-only, so nothing breaks, but the locks and the root pin now name different versions of the same package; a future pi release that changes an extension `.d.ts` would make those bundled types stale, and a lock refresh would be the fix.
- The router-fallback copies will drift again on the next pi-ai release that touches `retry.js` or `overflow.js`. The module header names the drift check (diff both files against the installed pi-ai), but nothing enforces it; a test that compares the copies against the installed pi-ai would catch the next drift automatically.
- pi 1.1.0 to 1.3.0 were reviewed here in one pass (F12). Only the `before_agent_start` union and the retry.js signal additions touched this repo, but that pass was a reading of the changelog and the diffs, not a release-by-release gate like the 1.0.3 record.
