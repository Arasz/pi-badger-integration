# ADR — Retire pi-mcp-tools; pi's built-in MCP support is the integration

Status: **ratified by owner** (task pbi-retire-pi-mcp-tools-native, 2026-09-30 — "low loop,
item 1 only, complete retirement of pi-mcp-tools").
Scope: `extensions/pi-mcp-tools/` (deletion) + `tests/pi-mcp-tools/`, `publish.ts`
(`EXTENSION_DIRS` + retired-dir cleanup), `tests/publish/publish.test.ts`, project/user MCP
config migration (`.mcp.json` → `.pi/mcp.json`), and the docs/instruction files named below.
Facts below are anchored to source paths; the companion research record is
`docs/plans/2026-09-30-pbi-retire-pi-mcp-tools-native.research.md`.

## Context

`pi-mcp-tools` (fork of tickernelz/pi-mcp-tools) exists because pi had no MCP support:
`.github/instructions/pi.instructions.md` (measured against pi 0.84.3) states *"pi core has no
MCP support and no consumer for the `mcp` settings key … That key is read solely by the
`pi-mcp-tools` extension"*. That premise is obsolete. The installed pi (0.99.1) ships MCP as a
built-in extension (`docs/mcp.md`): config at `~/.pi/agent/mcp.json` or a project `.pi/mcp.json`
(trust-gated), tools named `mcp__<server>__<tool>`, an exposure model
(`codemode`/`codemode-deferred`/`deferred`/`direct`/`hidden` + per-tool `toolExposure`),
OAuth sign-in, resources, the `/mcp` manager, the `pi mcp add|remove|list|login|logout` CLI,
and `pi.registerMcpServer()` for extensions.

Today both stacks run in one session: the fork arms from the claude-format project `.mcp.json`
plus the settings `mcp` key (`extensions/pi-mcp-tools/index.ts` `armSession`;
`CAPABILITY_PROJECT_SCOPE_MCP`) and registers `mcp_<server>_<tool>` tools
(`extensions/pi-mcp-tools/McpToolAdapter.ts:43-47`), `mcp_list_servers`, the
`/mcp-status|/mcp-reconnect|/mcp-toggle|/mcp-list|/mcp-tools` commands, a `--mcp-debug` flag and
`pi.setActiveTools()` filtering (`index.ts:581-590`), while native MCP idles with empty config
(measured 2026-09-30: no `~/.pi/agent/mcp.json`, no `.pi/mcp.json`, no `mcp` key in
`~/.pi/agent/settings.json`). Divergent tool names, duplicated connection stacks, and a
maintained fork whose whole reason to exist is gone.

Mid-task, main moved: PR #38 (`99e20b4`, prettier byte-parity of `McpCardRenderers.ts`) and the
1.1.33 release bump landed after the fork↔canonical parity gate was greened by the pbi-fork-sync
session. That parity machinery is retired wholesale by this decision (see Consequences).

## Decision

### 1. Complete deletion — extension, tests, parity gate

- Delete `extensions/pi-mcp-tools/` (all 10 files, incl. `McpCardRenderers.ts`,
  `CAPABILITY_PROJECT_SCOPE_MCP`, `.ai-badger-capability-project-scope-mcp`, `package.json`,
  `bun.lock`, `node_modules` derived state) and `tests/pi-mcp-tools/` (8 files, incl.
  `fork-canonical-parity.test.ts` and its `~/RiderProjects/pi-mcp-tools-fork` coupling).
- Nothing else imports the fork (measured: zero references from `extensions/**` outside itself,
  `tests/integration`, `tests/adapter`, `tests/helpers`, `features/**`) — this is a clean
  extraction.

### 2. publish.ts: drop from the set, and clean up the installed dir

- Remove `"pi-mcp-tools"` from `EXTENSION_DIRS` (`publish.ts:69`) and its two doc comments
  (`publish.ts:38`, `publish.ts:304`) that name it as the dependency-warning example.
- **Add retired-dir cleanup**: `bun run publish` deletes a leftover
  `~/.pi/agent/extensions/pi-mcp-tools/` (announced, never silent); `bun run check` reports its
  presence as drift. Rationale: pi discovers **any** `~/.pi/agent/extensions/<name>/index.ts`
  (`.github/instructions/pi.instructions.md`, user-scope loading rule), so a stale installed dir
  keeps the fork armed forever alongside native MCP — its `pi.setActiveTools()` calls would keep
  mutating the active tool set. Removal is mandatory, not advisory.

### 3. Config migration: `.mcp.json` stays for Claude, `.pi/mcp.json` is pi's

- **Keep** the repo `.mcp.json` — Claude Code reads that path (repo `agents` includes claude).
  **Add** a tracked `.pi/mcp.json` with the same five servers converted to pi's schema.
- Conversion rules, verified against pi 0.99.1 `dist/extensions/mcp/runtime.js`
  (`createDefaultTransport`):
  - `command`/`args`/`cwd` receive **`~`/`~/…` home expansion only** (`expandHome`) — no
    `${VAR}` substitution. So `${HOME}/.dotnet/tools/ai-raccoon` → `~/.dotnet/tools/ai-raccoon`
    (same for `~/.local/bin/semantica-mcp`, `~/.local/bin/uv`).
  - `${NAME}` and `!command` resolve in `env`/`headers` values only
    (`resolveConfigValueOrThrow`/`resolveHeadersOrThrow`) — `SEMANTICA_DISABLE_PROGRESS: "1"`
    passes through unchanged.
  - `task-graph`'s `${CLAUDE_PROJECT_DIR}/.ai-badger/skills/…` in `args` has no native
    equivalent; the arg becomes a **relative script path** — `.ai-badger/skills/
    task-decomposition/scripts/task_graph_server.py` — resolved against the server cwd, which
    `runtime.js` computes as `resolve(sessionCwd, expandHome(config.cwd ?? "."))` (docs:
    *"Relative `cwd` resolves against the session directory"*).
  - Drop the fork-only `tools: ["*"]` filter arrays (all five entries are `["*"]`). A real
    allowlist maps to native `exposure: "hidden"` + `toolExposure` overrides.
- **User scope**: the fork also read the settings `mcp` key
  (`ConfigLoader.loadFromSettingsJson`) and any claude global config
  (`claudeMcpConfig.ts`) — that key moves to `~/.pi/agent/mcp.json` (native global file,
  same `mcpServers` shape). This machine has no `mcp` key (measured), so the migration note in
  `docs/howto/install-extensions.md` + `docs/howto/update-integrations.md` covers it; no data
  mover is shipped.

### 4. Docs and instruction files

- `README.md:45` catalog row, `docs/reference/extension-catalog.md:345-380` (pi-mcp-tools
  section), `docs/howto/install-extensions.md:55` (the "pi-mcp-tools warning matters most"
  paragraph), `.github/workflows/ci.yml:33` comment ("without this pi-mcp-tools et al. fail…").
- `.github/instructions/pi.instructions.md` MCP section is rewritten (it currently asserts pi
  has no MCP support): native config paths, tool naming, exposure, `/mcp` + `pi mcp` CLI. Same
  for its source of truth `.ai-badger/instructions/pi.instructions.md`.
- Command mapping recorded for users: `/mcp-list`, `/mcp-tools`, `/mcp-toggle`,
  `/mcp-reconnect`, `/mcp-status`, `mcp_list_servers`, `--mcp-debug` → `/mcp` (manager with
  per-server tools/exposure/reconnect/enable), `pi mcp list`, `~/.pi/agent/mcp.log`.
- Summary lines listing `pi-mcp-tools` (`.ai-badger/config.json` `project.summary`,
  `CLAUDE.md`, `.ai-badger/CLAUDE.md`, `HERMES.md`, `.hermes.md`, `.github/copilot-instructions.md`,
  `.ai-badger/HERMES.md`) — updated in one pass **at the end of the task** (always-loaded
  context files are cache-prefix-sensitive; one rewrite beats five).

## Consequences

- **Human cards are gone.** `McpCardRenderers.ts` collapsed envelope JSON into one-line
  summaries (`memory_search: 5 hits (3 memory, 2 code)`); native renders tool results plainly
  and truncates text over 20 KB Codex-style to a temp file (docs/mcp.md). Accepted with the
  retirement; a standalone card extension is a possible follow-up, out of this task's scope.
- **Tool names change**: `mcp_<server>_<tool>` → `mcp__<server>__<tool>` (double underscore).
  No in-repo consumers (measured); external prompts naming `mcp_ai_raccoon_*` etc. must update.
  Bare-name references (`memory_search`) are unaffected.
- **`mcp_list_servers` and the `mcp-*` commands disappear** — `/mcp` + `pi mcp` replace them
  with strictly more (OAuth, per-tool exposure, enable/disable persisted to `mcp.json`,
  connection errors with stdio stderr tails).
- **Disabled-tools persistence** (`ConfigLoader.saveDisabledTools` → settings) is replaced by
  the native `toolExposure` map in `mcp.json`.
- **ai-badger's migration adjustments gate goes inert**: it keys on the marker
  `.ai-badger-capability-project-scope-mcp` inside `~/.pi/agent/extensions/pi-mcp-tools/`
  (`CAPABILITY_PROJECT_SCOPE_MCP`; ai-badger `features/pi/adjustments/adjust_mcp.py`,
  `adjustment.json`, `pi_settings.py`). A follow-up ai-badger task replaces the marker gate with
  a pi-version/native-capability check — the project `.pi/mcp.json` + trust model **is** the
  capability the marker declared.
- **The fork↔canonical parity machinery dies with the extension**: the fork repo sync
  (pi-mcp-tools PR #2), the prettier byte-parity twin (`99e20b4`, PR #38) and
  `fork-canonical-parity.test.ts` all served a fork being kept in lockstep. Retired in the same
  change; re-raising curated code upstream (tickernelz) becomes moot for pi with native MCP.

## Alternatives

- **Version-gated fork** (keep `pi-mcp-tools` for old pi, native for new): rejected — the owner
  chose complete retirement; two stacks with divergent tool names is exactly the state being
  exited, and no supported pi line predates the built-in support in this project's audience.
- **Port `McpCardRenderers` to a standalone extension in this task**: rejected — scope is item 1
  (retirement) only; recorded as a follow-up idea, not a commitment.
- **Single `.mcp.json` shared with Claude Code** (copy/symlink into `.pi/mcp.json`): rejected —
  the two clients read different paths by design; a tracked `.pi/mcp.json` is explicit,
  trust-gated, and the five-entry duplication has a documented conversion.
- **Auto-migrate user settings (`mcp` key → `~/.pi/agent/mcp.json`) from publish**: rejected —
  publish installs extensions and never rewrites user config; the one affected machine is
  measured clean, and the migration note is enough.
