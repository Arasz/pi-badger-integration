# Contributing to pi-badger-integration

Thanks for looking. One maintainer, no committee, so this is short. The gates are real anyway: `bun test` and typecheck must pass before anything lands.

If something here does not match what the repository actually does, that is a bug in this file. Open an issue.

## Setup

Bun (any recent version) and pi.

```bash
git clone https://github.com/Arasz/pi-badger-integration
cd pi-badger-integration
bun install
```

## Gates (run before every push)

```bash
bun test
bunx tsc --noEmit -p .
bun run check
```

`bun test` runs every extension suite. `bun run check` compares canonical source against your installed user scope and fails on drift. CI (`.github/workflows/ci.yml`) runs `bun test` plus the typecheck on every push and PR — `bun run check` stays local-only, since a fresh CI machine has no installed user scope by definition.

## Workflow

Work on `main` directly for small changes, or on a `task/<id>-<slug>` branch for anything tracked through the `/task` skill. Either way, land it the same way:

1. Write the failing test first for behavior changes. TDD is the norm here; the suites are fully unit-covered and a behavior change without a test stands out immediately.
2. Keep commits small and scoped. One extension per commit when a change touches several.
3. If you touched an extension under `extensions/`, run `bun run publish` and confirm `bun run check` exits 0.
4. If you touched `features/pi/adjustments/adapter/`, the change is not durable until it is vendored into the ai-badger checkout and committed there too. The exact order is in [Publish flow](docs/explanation/publish-flow.md); skipping the vendoring step means the next scaffold silently overwrites your fix.
5. Push. Merging without touching `VERSION` cuts a patch release automatically (see Releasing); bump it by hand in the PR when the change deserves more than a patch.

## Releasing (VERSION → tag → GitHub release)

Releases follow the ai-raccoon mechanism: a `VERSION` file holds the bare semver, and automation derives everything else.

- `auto-bump.yml`: a push to `main` that does not touch `VERSION` runs the tests, and on green pushes a patch-bump commit. A red suite bumps nothing.
- `release.yml`: any push that changes `VERSION` validates the format, tags `v<VERSION>` (lightweight, never moved — re-runs are no-ops), and cuts a GitHub release with generated notes.
- A push that already touched `VERSION` stands the automation down: a hand-picked version always wins, and the bump's own VERSION-only commit terminates the chain instead of looping it.
- Releases are user-visible: the update-check extension reads `releases/latest`, so cutting a release is what makes other checkouts notice.

## Conventions worth knowing

- Directory name is install name. `extensions/<name>/` installs as `~/.pi/agent/extensions/<name>/`; renaming a directory renames the install.
- `node_modules` is derived state. It ships with the install but never counts as drift.
- Never log or persist provider key values. Notices and reasons name the variable (`GROQ_API_KEY`), never its content. A guard test pins this over `extensions/router-fallback/`; keep it green.
- Sample values in docs and fixtures must be obviously fake (`gsk-...`, never a real-shaped key).
- Read the scoped instruction in `.ai-badger/instructions/` before editing matching files (docs, TypeScript, Node packaging, pi agent files).

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
