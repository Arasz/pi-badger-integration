# Research: merge the `delegate` tool and the `delegations` tool into one unified tool

**Date:** 2026-10-06
**Task:** `pbi-merge-delegate-delegations-tools` (branch `task/pbi-merge-delegate-delegations-tools`, base `main` @ `1e22b80`)
**Question:** where are both tools declared/registered/executed, which pin sites consume their names, and what is the smallest correct change that merges them under an explicit `action` parameter while keeping `delegate` behaviour and every pin working?
**Method:** read-only source reads and greps in this worktree only. Grades: `[MEASURED]` = command output (grep/git) in this tree; `[READ]` = source read; `[INFERRED]`; `[UNVERIFIED]`/`[HYPOTHESIS]` where noted.

Worktree state at time of writing: `git status --porcelain` empty, `HEAD == origin/main == 1e22b80` `[MEASURED]`.

## A. Where each tool lives

**F1 — Both tools are registered by the same extension factory (subagent).** `delegate` is registered in `extensions/subagent/index.ts:1133` (`name: TOOL_NAME`, `TOOL_NAME = "delegate"` at `:94`); `delegations` is registered in `extensions/subagent/delegation-status.ts:715` (`name: DELEGATIONS_TOOL_NAME`, `:50`), which index.ts calls at `:1048` via `registerDelegationStatus(pi, registry, {...})`. There is no second extension to delete. `[MEASURED]` (grep) + `[READ]`.

**F2 — `delegate` schema.** `DelegateParams` at `extensions/subagent/index.ts:754-771`: required `agent: string`, required `task: string`, optional `timeoutMs: number`, optional `cwd: string`. Registration at `:1133-1152`; `prepareArguments` at `:1158-1165` strips the legacy `background` key before validation; `execute` at `:1166`. `[READ]`.

**F3 — `delegate` execute path (full).** `:1167` persona scan/loud no-personas and unknown-persona returns → `:1207` `cwd` validation (`validateChildCwd`) → `:1219` `wantsBackground = toolCtx.mode === "tui"` (mode-only; `background` param is gone) → `:1225-1240` model-group resolution + `delegationArgs` + fallback args → `:1253` `registry.start(...)` (queue-only admission) → admission rejection at `:1277` → override note at `:1285` → `:1289` `receiptResult(outcome, toolCallId)` (`:1307`) or `:1292` `blockingResult(...)` (`:1336`). `[READ]`.

**F4 — `delegations` schema and union.** `DelegationsParams` at `extensions/subagent/delegation-status.ts:580-589`: required `action` = `Type.Union` of the six literals `list | log | abort | results | peek | resolve` (`:581-584`), optional `id: string | string[]`, optional `bytes: number`, optional `lines: number`. `[READ]`.

**F5 — `delegations` execute path.** Registered execute at `:730-734` sets `currentCtx = ctx` then delegates to the closure `runAction(params)` at `:595-713`: array-id guard at `:596`, `switch (params.action)` at `:599`, per-action arms (`list` `:601`, `log` `:622`, `abort` `:635`, `results` `:654`, `peek` `:688`, `resolve` `:701`), unknown action throw at `:711`. `runAction` reads registry + `opts.resultCache` + `opts.staleRuns` + `opts.resolveContext`; `currentCtx` is used by `results` (`:678-687`) and by the command twin. `[READ]`.

**F6 — the human `/delegations` command is separate and must stay.** `pi.registerCommand(DELEGATIONS_COMMAND_NAME, {...})` at `extensions/subagent/delegation-status.ts:743` (`DELEGATIONS_COMMAND_NAME = "delegations"`, `:53`), handler at `:773-812`, completions at `:744-772`. It shares `runAction`'s helpers, not the tool. `[READ]`.

## B. The four mandated pin sites

**F7 — Pin site 1, the child denylist.** Definition: `extensions/subagent/index.ts:102` `CHILD_EXCLUDED_TOOLS = \`${TOOL_NAME},${TOOL_NAME_PLURAL},queue,monitor,wait\`` (`TOOL_NAME_PLURAL = "delegations"`, `:97`); consumed into argv at `:381`. A second literal copy: `extensions/mem-based-rag/index.ts:90` `ASK_CHILD_EXCLUDED_TOOLS = "delegate,delegations,queue,monitor,wait"` (documented as a deliberate copy at `:85-90`), consumed at `:1078`. Test pins of the literal: `tests/subagent-tool.test.ts:69,88,108`; `tests/subagent/subagent.test.ts:157`; `tests/subagent-real-child.test.ts:41`; `tests/mem-based-rag/ask.test.ts:247-251, 519-522, 533`. `[MEASURED]`.

**F8 — Pin site 2, monitor's nested `executeTool`.** Exactly one runtime call site: `extensions/monitor/index.ts:665` `toolCtx.executeTool("delegations", { action: "abort", id: targets })` inside `abortWaitScope` (`:650-688`), guarded by the runtime-detected member shape at `:656-663`. Test pin of the name: `tests/monitor/wait-tool.test.ts:247` `expect(calls).toEqual([{ name: "delegations", args: { action: "abort", id: ["d-1"] } }])`; the cross-extension join resolves the nested call dynamically by name via `tool(h.pi, name)` (`tests/monitor/cross-extension-queue.test.ts:109-115, 135-139`). `[MEASURED]`.

**F9 — Pin site 3, the poll guard identity.** `extensions/monitor/index.ts:74` `POLL_GUARD_TOOL_NAME = "delegations"`; the wiring at `:1269-1270` (`deps.pollGuard?.toolName ?? POLL_GUARD_TOOL_NAME`) and the handler at `:1296-1318` block only when `call.toolName === pollToolName` and `call.input.action` ∈ `{list, log, results}` (`:1308-1310`); decisions are pure in `extensions/monitor/monitor-core.ts:429-497` (window 120 s, max 3, reason text at `:491`). If the merged tool is named `delegate`, the guard must key on `delegate` and the action test keeps working because a delegate *start* has no `action` (F2/F4). Tests that fire the old name: `tests/monitor/poll-guard.test.ts:96-158` (name discovered generically from the action union at `:79-87`, so only the drift-guard comment needs care), `tests/monitor/wait-guard.test.ts:94-97, 112-119` (the exact literal `"delegations"` and the reason substring `delegations list/log call #4`), `tests/monitor/cross-extension-queue.test.ts:305-335` (fires `toolName: "delegations"` at `:328`). `[MEASURED]` + `[READ]`.

**F10 — Pin site 4, other internal name references (no other `executeTool`).** A repo-wide grep for `executeTool` finds only `extensions/monitor/index.ts:656,661,665` plus tests `tests/monitor/wait-tool.test.ts:214,234` and `tests/monitor/cross-extension-queue.test.ts:109` `[MEASURED]`. Two further name consumers: `extensions/session-signals/index.ts:110-116` defaults its footer watch list to `["delegate", "delegations"]` (pinned by `tests/session-signals/session-signals.test.ts:138-146` and `tests/subagent-status.test.ts:764-767`); `extensions/subagent/delegation-status.ts:826-845` watches `DELEGATE_TOOL_NAME` (`:56`) + `"queue"` tool events for the background/blocking widget classification. `[MEASURED]`.

## C. Reference inventory (literal tool name `delegations`)

Categories that are **not** tool-name references and stay unchanged: the monitor snapshot field `delegations` (`extensions/monitor/monitor-core.ts:49,136,177,186`; `extensions/monitor/index.ts:15,336,885-886`), the `/delegations` command and its completion/usage strings (`extensions/subagent/delegation-status.ts:216,743-812`; `tests/helpers/apply-completion.ts:12,28`; `tests/subagent-status.test.ts` command rows), and the widget key `"pi-badger-delegations"` (`extensions/subagent/delegation-status.ts:59`). `[MEASURED]`.

| path:line | classification |
|---|---|
| `extensions/subagent/index.ts:97,102,381` | tool name constant + denylist definition/consumption |
| `extensions/subagent/index.ts:356,501,913,978,1043-1150` | prose/description/comment guidance ("delegations list/log", "delegations abort", "delegations tool") |
| `extensions/subagent/delegation-status.ts:50` | tool-name constant (registration name) |
| `extensions/subagent/delegation-status.ts:8,17,49,67,191,216,282` | comments (module map, clamp docs, usage line) |
| `extensions/subagent/delegation-status.ts:220,406,528,597,628,641,647,666,683,694,698,705,711` | action guidance/error strings ("use delegations list for current ids", "… peek …", etc.) |
| `extensions/subagent/delegation-status.ts:719-727` | tool description (LLM-facing) |
| `extensions/subagent/delegation-registry.ts:195,253,341,374` | admission/unknown-id guidance strings ("delegations abort <id>", "use delegations list") |
| `extensions/subagent/delegation-core.ts:183,837,903` | comments |
| `extensions/monitor/index.ts:74,97,1109,1123-1125` | poll-guard counted name + descriptions/prose |
| `extensions/monitor/index.ts:665` | nested `executeTool` call site |
| `extensions/monitor/monitor-core.ts:444,491` | poll-guard doc comment + block reason |
| `extensions/session-signals/index.ts:110,114,116` | default watch list (consumer) |
| `extensions/mem-based-rag/index.ts:90,1078` | denylist literal + consumption |
| `tests/subagent-status.test.ts:35,232,485-486,670,690,755,1053` | test pin (import name, fixture lookup, name assertion, description rows) |
| `tests/subagent-extension.test.ts:495,975,1034,1311,1392,1601` | test pin (execute via `h.tools.get("delegations")`; one description row at `:975`) |
| `tests/integration/project-local-ids-console-hygiene.test.ts:141-142,163-173` | test pin (`delegationsTool` helper) |
| `tests/monitor/poll-guard.test.ts:2-4,72-87,96-158` | test pin (drift guard discovers the registered name; rows fire it) |
| `tests/monitor/wait-guard.test.ts:94-97,112-119` | test pin (fires `"delegations"`, asserts reason substring) |
| `tests/monitor/cross-extension-queue.test.ts:159,305,328` | test pin (fires `"delegations"`; join uses dynamic lookup) |
| `tests/monitor/wait-tool.test.ts:247` | test pin (nested call name) |
| `tests/session-signals/session-signals.test.ts:138-146` | test pin (default watch list) |
| `tests/subagent/subagent.test.ts:157` | test pin (argv denylist) |
| `tests/subagent-tool.test.ts:69,88,108` | test pin (argv denylist, 3 rows) |
| `tests/subagent-real-child.test.ts:41` | test pin (smoke argv denylist) |
| `tests/mem-based-rag/ask.test.ts:247-251,519-522,533` | test pin (copy-equality + literal) |
| `tests/delegation-groups.test.ts:543` | not a pin: fake-pi routing-bus fixture registers a fake `"delegations"` command |
| `README.md:36` | doc (extension table lists `delegate`, `delegations`, `queue`) |
| `docs/reference/extension-catalog.md:93,94,102,114,116,131,146,155,156,169,196,198,226,238,254` | doc (the canonical tool reference) |
| `docs/howto/wait-check-loop.md:17,18,69,70` | doc |
| `docs/howto/install-extensions.md:29` | doc, `/delegations` command only — stays |
| `docs/plans/**`, `docs/work/**` (older records) | historical docs — do not rewrite |

**F11 — The canonical user-facing doc is `docs/reference/extension-catalog.md`** (`[READ]`): it documents `delegations` as an LLM-facing tool at `:116` and carries trust-stamp comments (e.g. `:251`, `:254`). Any merge must update it.

## D. Test files and exact rows that pin the two tools

**F12 — `tests/subagent-extension.test.ts` pins the delegate identity and the delegations surface in one full-factory harness.** Rows: `describe("row 43 — registration shape")` — `"registers the delegate tool, the session handlers, and the delegation-result renderer"` (`:226-239`, note at `:234-235` explicitly defers the delegations tool to the status module); `describe("background removal — no schema property, stale keys strip, mode alone decides")` (`:333-414`, schema-removal proof at `:334-339`, `prepareArguments` rows at `:341-361`, mode matrix in `describe("T66 — mode-only matrix (background iff mode tui)")` `:270-331`); `describe("B-A3 — delegate + delegations descriptions pin the R1 redirect wording")` (`:960-978`); PKG-3 resolve row using `h.tools.get("delegations")` (`:495-511`); results rows at `:1034`, `:1311`, `:1392`, `:1601`. `[MEASURED]` + `[READ]`.

**F13 — `tests/subagent-status.test.ts` pins the `delegations` tool via a fixture that calls `registerDelegationStatus` directly, not the factory.** Import at `:35`; fixture `makeFixture` calls `registerDelegationStatus(harness.pi, registry, {...})` at `:172`; helper `delegationsTool(fx)` at `:230-236` wraps `fx.harness.tools.get(DELEGATIONS_TOOL_NAME).execute(...)`; direct tool lookups at `:670,690,755,1053`; name assertion row `"the tool is registered under the exact name the child denylist names"` at `:483-487`; description rows at `:753-758` and `:1051-1058`; unknown-action row at `:746-751`; T76 contract describes at `:445`; T114/T115/T118 rows at `:1309+`; T77 watch-list row at `:764-767`. `[READ]`.

**F14 — the fake-pi seam is name-based tool lookup.** `tests/helpers/fake-pi.ts:156-158` stores tools in a `Map` keyed by `tool.name`; tests execute via `pi.tools.get(name).execute(toolCallId, params, signal, onUpdate, ctx)` (e.g. `tests/integration/project-local-ids-console-hygiene.test.ts:147,165,173`; `tests/subagent-status.test.ts:235`). It has no `executeTool`; production nested calls are simulated by ad-hoc ctx stubs (`tests/monitor/cross-extension-queue.test.ts:109-115`). `[READ]`.

**F15 — other test pins that change with the merge:** `tests/monitor/wait-guard.test.ts:119` (reason substring), `tests/monitor/cross-extension-queue.test.ts:328` and join describe `"wait timeout cancels delegation work through delegations abort"` (`:159`), `tests/monitor/wait-tool.test.ts:247`, `tests/session-signals/session-signals.test.ts:138-146`, the four denylist files in F7. `[MEASURED]`.

## E. Version and publish/install flow

**F16 — nothing in the publish flow names tools.** `publish.ts` has no `delegate`/`delegations` string; it ships whole extension directories via `EXTENSION_DIRS` (`publish.ts:77`) with `node_modules` as derived state. `[MEASURED]`.

**F17 — version convention.** `VERSION` holds the repo release (currently `1.1.49`) and is auto-bumped by `.github/workflows/auto-bump.yml` for a push that does not touch it; a hand-picked bump is allowed for changes deserving more than a patch (`CONTRIBUTING.md:35,39-43`). Per-extension `extensions/subagent/package.json` is bumped by hand on feature commits (`1.1.0 → 1.2.0 → 1.3.0`; `git log -- extensions/subagent/package.json`), currently `1.3.0`. `[MEASURED]`.

## F. Design findings for the merge

**F18 — the merged tool should be named `delegate`.** The name is already the child-denylist entry, the `delegate` description is pinned by tests, sessions and docs already say "use delegate", and the plain-call behaviour must be preserved. A new name would invalidate F7, F12 and the existing receipts for no gain. `[INFERRED]`.

**F19 — schema shape that preserves delegate byte-for-byte while admitting actions.** Merge as one `Type.Object` containing `DelegateParams`' four properties plus the action properties: `agent`/`task` become `Type.Optional` (a management call cannot be forced to carry them), `action` optional union of the six literals, `id`/`bytes`/`lines` optional (copied from `DelegationsParams`). Dispatch must be strictly `params.action === undefined || params.action === ""` → delegate path; any populated `action` → management path. This is the only shape that avoids the ruled-out loose dispatch: a persona named `list` arrives as `agent`, never as `action`. `[INFERRED]`.

**F20 — an action-absent call missing `agent`/`task` needs a new loud guard.** Today pi's schema validation rejects it before `execute`; with optional fields the merged `execute` must return/throw a usage error naming both parameters and spawning nothing. This is the one unavoidable delegate behaviour delta (a malformed call gets a tool-level error instead of a schema error) and must be covered by a test row. `[INFERRED]`.

**F21 — the clean registration seam is index.ts, with delegation-status returning its action runner.** `registerDelegationStatus` already documents an additive return ("the return amends additively", `:277-280`; the `contextWindow()` return at `:862-868`). Change it to stop calling `pi.registerTool` and return `{ contextWindow(), runAction(params, ctx) }` (the closure at `:595`, setting `currentCtx` first). `extensions/subagent/index.ts:1048` captures that seam, then the single `pi.registerTool` at `:1133` dispatches action → `statusApi.runAction`, else the existing delegate path. The `/delegations` command, widget, transition subscription and tool-event handlers stay in delegation-status.ts untouched. `[INFERRED]`.

**F22 — the poll guard is the only identity that must change, and it stays correct by construction.** With the tool named `delegate`, `POLL_GUARD_TOOL_NAME` (`extensions/monitor/index.ts:74`) becomes `"delegate"`; the handler's `action ∈ {list,log,results}` test (`:1309-1310`) still excludes delegate starts (no `action` key) and abort/peek/resolve. The drift guard `registeredDelegationsName` (`tests/monitor/poll-guard.test.ts:79-87`) finds the registered tool by its `action` union, so it discovers the merged tool automatically as long as `action` stays a TypeBox `Type.Union` (in `properties.action.anyOf`). `[READ]` + `[INFERRED]`.

**F23 — a thin `delegations` alias is possible on pi 1.0.3, but it splits the identity again.** pi 1.0.3's `ToolExposure` supports `deferred`: registered, callable via `ctx.executeTool()`, findable by tool search, not declared to the model (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:379-388`; callable rule in `dist/core/agent-session.js:1102-1112`). An alias registered with `exposure: "deferred"` would keep the monitor's nested call and any external caller working without a second model-facing tool. Cost: the poll guard and session-signals must then count/pin two names (or accept a deferred-alias bypass of the 4th-call guard via tool search), and `CHILD_EXCLUDED_TOOLS` keeps both names. `[READ]` (installed 1.0.3 types; the pinned copy at `extensions/subagent/node_modules/@earendil-works/pi-coding-agent` is 0.84.4 and has no `exposure` — see H2).

**F24 — recommendation: remove the `delegations` tool registration and code-update all callers; keep the `/delegations` command.** All executable callers are in this repo and enumerated (F8, F9, F10, F12-F15); the runtime monitor call site is one line; a second registration keeps either a second model-facing tool or a second name for the poll guard/session-signals to chase. Removing it delivers the actual merge (one tool in the model's tool list) with a bounded, grep-auditable diff. `[INFERRED]` — this is the main open decision (see Open decisions in the reply).

**F25 — guidance-string sweep is required.** Action error/guidance strings that say `delegations list` / `delegations abort` / `delegations peek` (F's inventory, `delegation-status.ts:220…711`, `delegation-registry.ts:195…374`, `monitor-core.ts:491`, `monitor/index.ts:1109,1125`, `index.ts:1141`) would name a tool that no longer exists. Policy: tool hints become `delegate list` / `delegate abort <id>` / `delegate peek <id>`; `/delegations` command hints stay as they are. Pin to update: `tests/subagent-status.test.ts:742` (exact text), `tests/monitor/wait-guard.test.ts:119` (reason substring). `[MEASURED]` + `[INFERRED]`.

**F26 — version bump.** This is a tool-surface change (one tool removed/merged): hand-bump `VERSION` `1.1.49 → 1.2.0` and `extensions/subagent/package.json` `1.3.0 → 1.4.0` in the PR (F17). `[INFERRED]`.

## G. Unverified / hypotheses

- **H1 [HYPOTHESIS]** — Nested `executeTool` invocations may or may not fire the extension `tool_call`/`tool_result` hooks; the merged poll guard only needs LLM-issued calls, so this does not change the plan, but it is the reason the alias option (F23) is harder to reason about.
- **H2 [UNVERIFIED]** — Whether the published extension directory's nested `extensions/subagent/node_modules` (0.84.4) is ever what a pi host resolves for types at install time; repo root `node_modules` and `package.json` pin 1.0.3. If an older host without `exposure` runs the alias, the alias would be declared to the model (no hidden flag), weakening F23. Verify before choosing the alias.
- **H3 [UNVERIFIED]** — No external (outside this repo) caller of `executeTool("delegations", …)` is known; the inventory is repo-scoped by constraint. The alias decision should account for that if external callers exist.
- **H4 [HYPOTHESIS]** — `pi.registerTool` with `exposure` is ignored gracefully by older hosts (unknown fields), but this was not tested.

## Appendix: acceptance-criteria seed for the plan

Behaviour rows the merge must add/keep (test-first): one registered delegation tool named `delegate`; plain `{agent,task}` → receipt/blocking exactly as today; `action:"list"|"log"|"abort"|"results"|"peek"|"resolve"` → management result, no spawn; `{agent:"list", task:"…"}` with no action → delegate path (no verb dispatch); `{action:"list"}` from a context without a sessionManager still answers; merged description carries all substrings pinned by B-A3; `prepareArguments` still strips `background`; poll guard counts `delegate` `list`/`log`/`results` and never counts starts/abort/peek; wait timeout still aborts via the nested call; denylist strings and the mem-based-rag copy stay equal; `/delegations` command rows stay green.