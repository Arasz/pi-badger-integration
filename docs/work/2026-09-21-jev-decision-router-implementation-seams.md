# Research: implementation seams for a Jev decision-router pi extension

**Date:** 2026-09-21
**Question:** What does this repository's pinned pi API and test/build wiring already provide for an extension that calls a decision model for tool selection, model selection and prompt routing — and what has to be built around it?

## Findings

### F1 — The repo-pinned pi 0.84.4 exposes every API the three uses need [READ]

`getActiveTools(): string[]`, `getAllTools(): ToolInfo[]`, `setActiveTools(toolNames: string[]): void`, `setModel(model): Promise<boolean>`, and `setThinkingLevel(level): void` all exist on the extension API in the repo's pinned version. The same declarations exist in the installed 0.85.x docs, so the surface is stable across the two versions in play.

**Evidence:** `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:995-1007` (also `:1247-1254` for the handler table); `package.json` devDependency pins `@earendil-works/pi-coding-agent` at `0.84.4`, and the installed package reports `0.84.4`.

### F2 — `before_agent_start` is async-capable and carries the raw prompt [READ]

`BeforeAgentStartEvent` exposes `prompt` (plus `systemPrompt` and structured `systemPromptOptions`), and `ExtensionHandler` may return a promise. A handler can therefore await a decision call before the agent loop starts. `BeforeAgentStartEventResult` is the mutation surface for the turn.

**Evidence:** `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:540-548` (`BeforeAgentStartEvent`), `:902` (`ExtensionHandler` returns `Promise<R | void> | R | void`), `:923` (`on("before_agent_start", ...)`), `:845` (`BeforeAgentStartEventResult`).

### F3 — Install registration is one array in `publish.ts` [READ]

Every extension directory under `extensions/` is installed to `~/.pi/agent/extensions/<name>/`; the owned set is the `EXTENSION_DIRS` constant. A new directory package must be appended there and carry a `package.json` whose `main` is `index.ts` (metadata only — pi discovers the entry itself).

**Evidence:** `publish.ts:69-70` (`EXTENSION_DIRS`, 11 names) and `publish.ts:14-17` (the install rule); `extensions/router-fallback/package.json` (the directory-package shape and its "manifest records metadata only" note).

### F4 — The shared test harness does not model tool/model mutation; the repo's own precedent injects them [READ]

`tests/helpers/fake-pi.ts` implements `on` (handler arrays), tool/command/renderer registration, message capture, an events bus and a clock — but no `setActiveTools`, `getActiveTools`, `getAllTools`, `setModel` or `setThinkingLevel`. `router-fallback` already handles this by taking the mutation calls as factory dependencies (`setModelFn`, `setThinkingLevelFn`) and falling back to the bound `pi` method only when present.

**Evidence:** `tests/helpers/fake-pi.ts` (181 lines, full read — the API list in its header comment and the implementation); `extensions/router-fallback/index.ts:157-160` (dep types) and `:381-390` (bound fallback).

### F5 — HTTP in an extension has an injectable-fetch precedent [READ]

`update-check` defines its own fetch function type, takes `fetchFn` as a dependency defaulting to `globalThis.fetch`, and the tests stub it; session-start fetch failures are silent by design. No extension currently calls the network from a per-turn hook.

**Evidence:** `extensions/update-check/index.ts:63-66` (fetch types), `:78-81` (`deps.fetchFn`), `:129-131` (default binding), `:18` (offline/failure stance).

### F6 — Test layout and verification commands are fixed [READ]

Tests live at `tests/<extension-name>/*.test.ts` with shared helpers at `tests/helpers/`; `tsconfig.json` includes `extensions/**/*.ts` and `tests/**/*.ts`; `bun run test` is `bun test`; `bun run typecheck` is `bunx tsc --noEmit -p .` (the `lint` gate).

**Evidence:** `tests/monitor/` layout and `tests/helpers/fake-pi.ts`; `tsconfig.json` `include`; `package.json` scripts.

### F7 — Docs conventions: one catalog entry per extension, ADRs as dated work records [READ]

Each shipped extension has a deep-reference section in `docs/reference/extension-catalog.md`; ADRs in this repo are dated files under `docs/work/` with an `-adr.md` suffix (`2026-09-08-monitor-bash-predicate-adr.md`, `2026-09-06-pkg5-level-registry-adr.md`). There is no `docs/adr/` directory.

**Evidence:** `docs/reference/extension-catalog.md` (sections per extension); `ls docs/work/` filtered for `*adr*`.

### F8 — A fully hermetic extension test is reachable without extending the shared harness [INFERRED]

Reasoning from F4 (mutation calls are injectable) and F6 (fake-pi already covers `on`, commands, messages and the bus): if the factory takes `fetchFn`, `getActiveToolsFn`, `getAllToolsFn`, `setActiveToolsFn` and `setModelFn` as deps with `pi`-bound fallbacks, every decision path can be exercised with stubs on top of `createFakePi`, and no live key or network is needed in unit tests. Extending `fake-pi.ts` becomes optional, not required.

### F9 — Whether the documented dispatch gate will block parallel write-capable lanes here is unchecked [UNVERIFIED]

`.ai-badger/delegation.md` describes a `dispatch-gate` hook that denies a write-capable dispatch naming no isolation while a sibling lane is live, but the hook is not present in this repo's adapter files; read-only planning lanes are exempt by that description, so the plan uses read-only lanes with `/tmp` outputs and defers the question until implementation lanes are dispatched.

**Evidence:** none — admission only.

## Still open

- Whether the delegate harness here accepts an isolation parameter at all; if not, parallel implementation lanes must serialise or use hand-made worktrees.
- How `setModel` behaves when called from inside an async `before_agent_start` handler on the pinned 0.84.4 (the 0.85.x docs do not state it explicitly); the plan should treat this as a probe with a fallback to acting at `turn_end`/command level.
- Token cost of describing the full tool catalogue to a 32K-context decision model when a session activates every extension tool; the plan needs a measured or bounded answer before enabling catalogue-wide questions.
