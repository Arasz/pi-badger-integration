# Research record — pbi-retire-pi-mcp-tools-native (2026-09-30)

Task (owner-ratified scope): adjust the pi integrations to pi's new built-in features —
**item 1 only: native MCP replaces `pi-mcp-tools`, complete retirement of the extension**
(low-effort loop). Decision record: `docs/work/2026-09-30-retire-pi-mcp-tools-native-mcp-adr.md`.

Legend: [MEASURED] observed by command this session · [READ] read from a source file (path
given) · [HYPOTHESIS] plausible but unverified — must be checked before it is load-bearing.

## What had to be checked vs guessed

| Point | Needed research? | Where it landed |
|---|---|---|
| Fork's full surface (tools, commands, config files, settings keys) | yes | F2 |
| Consumers/references outside the extension | yes | F3 |
| Native MCP replacement surface + parity gaps | yes | F1, F6 |
| Config conversion semantics (`${VAR}`, `~`, cwd) | yes | F4 |
| User-scope migration hazards (stale installed dir) | yes | F5 |
| ai-badger coupling (capability marker gate) | yes | F7 |
| Whether cards/tool names have in-repo consumers | yes | F3, F6 |
| Whether the fork blocks built-in MCP (the `/mcp` replacement rule) | yes | F5 |

## Findings

### F1 — pi 0.99.1 has built-in MCP; the "no MCP support" instruction line is stale [MEASURED/READ]
- Installed pi: 0.99.1 (`@earendil-works/pi-coding-agent/package.json`), with built-in
  `mcp`, `codemode`, `tool-search` extensions (`dist/extensions/mcp/`, `docs/mcp.md`).
- Native config: `~/.pi/agent/mcp.json` (global) or project `.pi/mcp.json`, `mcpServers` shape,
  project entries override global by name, project file read only after project trust
  (`docs/mcp.md` "Configure servers"; `dist/core/trust-manager.js`).
- Tools register as `mcp__<server>__<tool>` with `exposure`/`toolExposure`
  (codemode / codemode-deferred / deferred / direct / hidden), `/mcp` manager, `pi mcp
  add|remove|list|login|logout`, `~/.pi/agent/mcp.log`, resource tools, OAuth
  (`docs/mcp.md` throughout).
- Stale claim: `.github/instructions/pi.instructions.md:34` — *"pi core has no MCP support …
  That key is read solely by the `pi-mcp-tools` extension"*, explicitly "Measured against pi
  0.84.3. Re-measure … after a pi upgrade." Source of truth: `.ai-badger/instructions/
  pi.instructions.md` (and ai-badger's `features/pi/instructions/pi.instructions.md`).

### F2 — fork surface inventory [READ]
`extensions/pi-mcp-tools/` (2,494 lines, 10 files):
- `index.ts` (590): `--mcp-debug` flag; commands `/mcp-status`, `/mcp-reconnect`,
  `/mcp-toggle`, `/mcp-list`, `/mcp-tools`; tool `mcp_list_servers` ("merge ledger");
  per-MCP-tool `pi.registerTool` (`index.ts:397`); `pi.setActiveTools()` filter
  (`index.ts:581-590`); `armSession` loads config at `session_start`, re-arms on reload.
- `McpToolAdapter.ts:43-47`: pi name = `mcp_${serverName}_${mcpTool.name}` with `-`→`_`
  (single underscores, e.g. `mcp_ai_raccoon_memory_search`, `mcp_task_graph_plan_get`);
  configurable `toolPrefix`.
- `ConfigLoader.ts`: global config from the settings `mcp` key (`loadFromSettingsJson`),
  project config from claude-format `.mcp.json` (trust-gated warn at `ConfigLoader.ts:139`),
  project-over-global merge with skip reporting; **disabled-tools persistence** back to
  settings (`saveDisabledTools`).
- `claudeMcpConfig.ts` (221): claude-format parsing/conversion (incl. `tools` filter arrays —
  see F4).
- `McpCardRenderers.ts` (671→524 lines post-`99e20b4` reformat): collapsed human cards keyed
  on the bare tool name; `McpClient.ts`/`McpRegistry.ts`: own MCP client + reconnect
  (`MAX_RECONNECT_ATTEMPTS`); `SchemaConverter.ts`: JSON-Schema→TypeBox; `toolFilter.ts`:
  `tools` allowlist patterns.
- Capability marker pair `CAPABILITY_PROJECT_SCOPE_MCP` /
  `.ai-badger-capability-project-scope-mcp` (see F7).

### F3 — consumers to touch [MEASURED]
- **Zero code imports** of the fork outside itself (grepped `extensions/**`,
  `tests/integration`, `tests/adapter`, `tests/helpers`, `features/**`).
- References to update: `publish.ts:38,69,304`; `tests/publish/publish.test.ts:403-437`
  (marker-file shipping cases); `tests/pi-mcp-tools/` (8 files incl.
  `fork-canonical-parity.test.ts` → `~/RiderProjects/pi-mcp-tools-fork`); `.github/workflows/
  ci.yml:33` comment; `README.md:45`; `docs/reference/extension-catalog.md:345-380`;
  `docs/howto/install-extensions.md:55`; summary lines: `.ai-badger/config.json`
  (`project.summary`), `CLAUDE.md:5`, `.ai-badger/CLAUDE.md:3`, `HERMES.md:5`, `.hermes.md:5`,
  `.github/copilot-instructions.md:5`, `.ai-badger/HERMES.md:3`.
- Historical records (`docs/plans/2026-extension-directory-packages.md`, `docs/work/*`) stay
  as-is — they describe past states.

### F4 — config conversion semantics, verified in pi source [MEASURED/READ]
`dist/extensions/mcp/runtime.js` `createDefaultTransport` (source map source read verbatim):
- `command: expandHome(config.command)`, `args: config.args?.map(expandHome)`,
  `cwd: resolve(cwd, expandHome(config.cwd ?? "."))` — **`~/` and `~` expansion ONLY** on
  command/args/cwd; no `${VAR}` substitution there.
- `env` values via `resolveConfigValueOrThrow`, `headers` via `resolveHeadersOrThrow`
  (`core/resolve-config-value.ts`) — `${NAME}` env references and `!command` resolve there.
- Consequences for this repo's `.mcp.json` (5 servers, all with fork `tools: ["*"]`):
  `${HOME}/…` in `command` → `~/…`; `task-graph`'s `${CLAUDE_PROJECT_DIR}/…` arg →
  **relative** `.ai-badger/skills/task-decomposition/scripts/task_graph_server.py`
  (child cwd = `resolve(sessionCwd, …)` per docs "Relative `cwd` resolves against the session
  directory"); `tools` arrays dropped (native `toolExposure` only where a real filter is
  wanted). `env.SEMANTICA_DISABLE_PROGRESS` unchanged.

### F5 — user-scope migration hazard: the stale installed dir [MEASURED/READ]
- pi discovers `~/.pi/agent/extensions/<name>/index.ts` for every subdirectory
  (`.github/instructions/pi.instructions.md`, user-scope loading rule) — nothing uninstalls the
  fork when `EXTENSION_DIRS` drops it, so a stale dir keeps loading (fork tools + its
  `pi.setActiveTools()` fights) next to native MCP.
- The fork does **not** register the `/mcp` command (commands are `mcp-*` per F2), so the
  docs/mcp.md "Other MCP extensions" replacement rule does not fire today — built-in MCP and
  the fork coexist (built-in idles: measured no `~/.pi/agent/mcp.json`, no `.pi/mcp.json`, no
  settings `mcp` key on this machine).
- Therefore retirement needs publish-side cleanup (install removes the stale dir, `--check`
  flags it) — recorded as ADR Decision §2.

### F6 — capability parity: what native gives up vs the fork [READ]
- Lost: human cards (`McpCardRenderers`), `mcp_list_servers` merge-ledger card,
  `/mcp-toggle`/`/mcp-reconnect` one-liners, `--mcp-debug`, disabled-tools persistence in
  settings, fork `tools` filter arrays, custom `toolPrefix` (tool names become
  `mcp__<server>__<tool>` — no in-repo name consumers [MEASURED]).
- Gained: OAuth + `/mcp` manager + `pi mcp` CLI + `toolExposure`/`exposure` granularity +
  resource tools + server logs (`~/.pi/agent/mcp.log`) + `tools/list_changed` handling +
  reconnect-on-call + `pi.registerMcpServer()` (docs/mcp.md).
- >20 KB text results are truncated Codex-style to a temp file natively (docs/mcp.md) —
  relevant to ai-raccoon envelopes, acceptable (ADR Consequences).

### F7 — ai-badger coupling (out-of-repo, follow-up) [READ/MEASURED]
- `CAPABILITY_PROJECT_SCOPE_MCP`: ai-badger's migration adjustments gate on the marker
  `~/.pi/agent/extensions/pi-mcp-tools/.ai-badger-capability-project-scope-mcp`, "never on a
  version number".
- ai-badger checkout (`~/RiderProjects/ai-badger`) touches this in
  `features/pi/adjustments/adjust_mcp.py`, `adjust_skills.py`, `pi_settings.py`,
  `adjustment.json`, `tests/test_pi_adjustments.py`, `tests/test_stack_mcp_servers.py`,
  `features/common/skills/welcome-ai-badger/scripts/mcp_tools.py`.
- After retirement the gate goes inert → follow-up ai-badger task (native `.pi/mcp.json` +
  trust IS the capability). Not blocking this repo's change.

### F8 — baseline is post-`99e20b4`, main moved mid-task [MEASURED]
- Worktree rebased onto `20a3c54` (1.1.33) per owner `f:` — includes `99e20b4` (PR #38,
  prettier byte-parity of `McpCardRenderers.ts`, 524/524 lines, pure formatting) and
  `6b85b31` (#37, identifier-safe pi tool names — the `-`→`_` rule now canonical upstream too).
- The pbi-fork-sync session greened the fork↔canonical parity gate (174 pass) and retired both
  sync branches (bus msgs #1577/#1578, acked). The gate and the sync twin are retired by this
  task in the same stroke (ADR Consequences).

## Still open

- [HYPOTHESIS] `StdioTransport` env merges config `env` over `process.env` (rather than
  replacing it) — decides nothing for the five converted entries (no `env` needs PATH-relative
  resolution) but confirm in `@earendil-works/pi-mcp` before documenting `env` behavior.
- [HYPOTHESIS] Project trust prompt behavior in headless (`-p`/json/rpc) sessions for
  `.pi/mcp.json` — `defaultProjectTrust` applies per pi.instructions.md; verify before
  claiming headless sessions load project MCP config.
- ai-badger follow-up task text (marker-gate replacement) — drafted in ADR Consequences, filed
  at close.
- Exact wording pass for `docs/howto/update-integrations.md` migration note (implementation).
