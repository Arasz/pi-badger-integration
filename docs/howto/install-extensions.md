# Install extensions

Goal: install the extension set from this repo into pi's user scope, verify the install, and know how to update or remove it later.

## Prerequisites

Bun and pi installed. Clone the repo somewhere stable (the path does not matter after install, since publish copies files out).

```bash
git clone https://github.com/Arasz/pi-badger-integration
cd pi-badger-integration
bun install
```

## Install

```bash
bun run publish
```

This copies every directory under `extensions/` to `~/.pi/agent/extensions/<name>/` and the adapter to `~/.pi/agent/extensions/ai-badger/`. `node_modules` ships too when present; when an extension has a `package.json` but no `node_modules`, publish runs one automatic `bun install` first. Installs write through temp files, so pi never loads a half-written file.

## Verify

```bash
bun run check
```

`check` compares canonical source against user scope and exits 1 on any missing, extra, or byte-differing file. It never writes. A missing destination `node_modules` is a warning only. If `check` is green, restart pi (running sessions keep their loaded modules) and confirm the tools and commands show up (`/delegations`, `/monitors`, `/fallback`).

If you edit extension source here, publish again and re-run `check`. Extension changes also need the adapter vendoring step when they touch `features/pi/adjustments/adapter/`; that full order is documented in [Publish flow](../explanation/publish-flow.md).

## Update

```bash
git pull
bun run publish
bun run check
```

## Remove one extension

```bash
rm -r ~/.pi/agent/extensions/<name>
```

Publish never deletes outside the directories it owns, so removal is manual and safe. After removing the old flat-file leftovers once (listed in [Publish flow](../explanation/publish-flow.md#one-time-cleanup-after-the-switch-to-directory-installs-do-once-by-hand)), there is nothing else to clean.

## Troubleshooting

`check` reports drift right after publish. Another pi session or scaffold wrote into user scope between the two commands, or the publish failed partway. Re-run publish, then check again.

A fresh pi session reports unknown tools after install. The session started before the publish finished, or pi loaded from a different `PI_CODING_AGENT_DIR`. Restart pi from a normal shell and check the env override is unset.

`bun run publish` warns about shipping without dependencies. The automatic `bun install` failed (offline, or bun missing). Run `bun install` by hand in the extension directory and publish again. The `pi-mcp-tools` warning matters most, since it needs its SDK at runtime.
