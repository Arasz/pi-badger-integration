# Update integrations

Goal: know when this repo ships a newer release, and update a pi install to it. The `update-check` extension watches; you decide.

## What it does

Shortly after a pi session starts, the extension compares the installed version (a marker file publish writes) against the latest GitHub release on `Arasz/pi-badger-integration`. When the release is newer, the session gets one notice card with the exact update commands. That is all it does. It never downloads, installs, or changes anything on its own. Offline sessions, failed fetches, and up-to-date installs stay silent.

Two things it deliberately does not do. It cannot hook into `pi update`: pi exposes no update lifecycle event to extensions, so `pi update` stays the path for pi itself. And it does not check pi's version, for the same reason. No API surface, no check, documented instead of faked.

## Commands

```text
/update-check status
/update-check check
```

`status` shows the installed version, the last remote version seen, and the last conclusion. `check` runs a check right now and reports verbosely, including fetch errors the background check stays silent about. Set `PI_BADGER_UPDATE_CHECK=0` to disable the background check; the command keeps working.

## Update

When a notice names a newer release:

```bash
cd pi-badger-integration
git pull
bun run publish
bun run check
```

`publish` refreshes the installed-version marker, so the next session compares against the new release and stays quiet.

## Migrating from pi-mcp-tools to pi's built-in MCP

pi 0.99.1 ships MCP support, so the `pi-mcp-tools` extension is retired. `bun run publish` removes a stale `~/.pi/agent/extensions/pi-mcp-tools/` and announces it; restart pi so the old tools and `mcp-*` commands are gone.

The repo's `.mcp.json` stays where it is: Claude Code reads that path. pi reads its own files: `~/.pi/agent/mcp.json` (global) and `.pi/mcp.json` (project). A project `mcp.json` is read only after the project is trusted; with `defaultProjectTrust: "ask"` (this machine's setting, and no `~/.pi/agent/trust.json` saved) a non-interactive session (print, JSON, RPC) skips it, so pass `--approve` or approve the project once interactively to save a decision.

The old surface maps to native replacements:

| retired (`pi-mcp-tools`) | pi built-in |
|---|---|
| `/mcp-list`, `/mcp-tools`, `/mcp-toggle`, `/mcp-reconnect`, `/mcp-status`, `mcp_list_servers`, `--mcp-debug` | `/mcp` (per-server manager), `pi mcp list`, `~/.pi/agent/mcp.log` |
| tool names `mcp_<server>_<tool>` | `mcp__<server>__<tool>` |

Human cards, the merge-ledger card, settings-persisted disabled tools, and the fork's `tools` filter arrays are gone; per-server `exposure` and `toolExposure` in `mcp.json` replace the filter. Dropping `tools: ["*"]` leaves each server at pi's `codemode` default (tools reachable from scripts, not declared to the model); set `"exposure": "direct"` on a server to have its tools declared to the model again.

## Moving to pi 1.0.0

The repo builds and tests against pi 1.0.0 (`devDependencies` pinned `@earendil-works/pi-coding-agent` at `1.0.0` for that move), and every extension loaded in a print-mode session with no warnings. Four changes from the 0.84.4 → 1.0.0 changelog touch this integration. One of them needed a fix (see "pi 1.0.1 / 1.0.2" below for the later releases):

| pi change | Effect here |
|---|---|
| MCP tool names replace `-` with `_` (0.99.2): `mcp__ai-raccoon__memory_search` is now `mcp__ai_raccoon__memory_search` | The adapter's post hooks still fire. The shipped matchers accept any `mcp__<server>__` prefix, and a test pins the new spelling. |
| Tools carry an `exposure`, and MCP tools default to `codemode` (0.99) | `decision-router` now offers the classifier only tools pi declares to the model (`direct`, `model-only`). Before the fix it could promote a codemode-only MCP tool to a direct declaration. |
| `--no-extensions` also turns off pi's built-in extensions (0.99.0) | The `/ask` child in `mem-based-rag` passes it to stay isolated, so it loses the built-in MCP and codemode too, which it wants. It also loses the built-in llama.cpp provider: if your default model is a llama.cpp model, `/ask` has no model to run. `subagent` children don't pass the flag, so they load the built-ins and connect your MCP servers in the background. |
| `--provider` without `--model` is an error (1.0.0) | `subagent` never passes `--provider`; it passes `--model` or nothing. |

The TUI now starts fullscreen. If you prefer the terminal's own scrollback, set `"tuiMode": "regular"` in `~/.pi/agent/settings.json`.

## pi 1.0.1 / 1.0.2

The repo now pins `@earendil-works/pi-coding-agent` at `1.0.2`; `bun run test` and `bun run typecheck` pass against it. Two changes from these releases touch this integration:

| pi change | Effect here |
|---|---|
| "Selected model is at capacity" errors are retried instead of ending the turn (1.0.1); pi-ai `retry.js` gained `model is at capacity`, `currently experiencing high demand`, `520`, and the ChatGPT `subscription_sharing_*` signals (1.0.2) | `router-fallback` keeps inline copies of those pattern sets (plus `overflow.js`'s). They are re-synced to 1.0.2: at-capacity/demand text now classifies as `throttle` (cooldown-only) instead of `not-fallback`, `subscription_sharing_usage_limit_exceeded` is billing (hours-scale, non-retryable), the `*_unavailable` twins are retryable, and z.ai's `Prompt too long` / `Prompt exceeds max length` overflow texts match again. |
| Project overrides for MCP servers: a `.pi/mcp.json` entry without `command`/`url` sets only `enabled`/`exposure`/`toolExposure` of a user-level server, and `/mcp` can enable/disable a server per project (1.0.1) | No code change here — the tracked `.pi/mcp.json` carries full server definitions. Useful when one project should tweak a global server's exposure without duplicating it. |

Also new in 1.0.2 and unrelated to this repo's extensions: `samplingParamsByThinkingLevel` in `models.json` sets per-thinking-level sampling parameters on OpenAI-compatible APIs.

## Behavior matrix

Every combination holds without erroring a session. Session start stays silent unless a newer release is confirmed; the `check` subcommand reports everything.

| Network | Installed marker | Remote release | Session start | `check` reports |
|---|---|---|---|---|
| off | anything | anything | silent | the fetch error |
| on | missing | anything | guidance (publish once) | same guidance |
| on | corrupt | anything | guidance (re-publish) | same guidance |
| on | known | none published yet | silent | no releases yet |
| on | known | malformed tag | silent | the tag problem, silently |
| on | known | fetch failed | silent | the error |
| on | known | same or newer than remote | silent | up to date |
| on | known | newer than installed | update notice | the update |

## For maintainers: cutting a release

Releases are GitHub releases with `vX.Y.Z` tags. Prerelease suffixes and non-semver tags are ignored by the check (silently, by design).

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "Summary of what changed."
```

`VERSION` at the repo root is the version of record, so a hand-chosen version goes there too: the version-bump step edits it, `release.yml` tags `main` from it, and `auto-bump.yml` patch-bumps it when a push to main does not touch it. The extension manifests carry their own versions. After pushing the tag, verify the check end to end with a stale marker against the live API before announcing.
