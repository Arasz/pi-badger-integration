# Publish flow

How canonical source becomes running pi extensions, and why the steps run in this order.

## One-time cleanup after the switch to directory installs (do once, by hand)


The old publish flow installed two flat files, and ai-badger's installer used a
different directory name for the subagent. After the first directory-model
publish, remove the stale user-scope leftovers — pi would otherwise load
duplicates (double hooks and tools):

```bash
rm ~/.pi/agent/extensions/session-signals.ts
rm ~/.pi/agent/extensions/shift-enter-newline.ts
rm -r ~/.pi/agent/extensions/ai-badger-subagent/   # old name; the generic rule installs it as subagent/
```

publish never deletes anything outside the directories it owns (the
per-extension dirs and the adapter dir it installs into) — stale neighbours are
left for you to remove.


## The three-copy model


1. **Canonical** — this repo. Edit here.
2. **Vendored** — ai-badger's `features/pi/adjustments/adapter/`. ai-badger's
   scaffold-freshness gates require the shipping copy in-repo, so the adapter is vendored
   back and committed there. ai-badger's own test suite (`bun test features/pi`) runs
   against this vendored copy — the artifact its scaffolds actually ship.
3. **User scope** — `~/.pi/agent/extensions/`, which pi loads into every session.

`--check` compares canonical against user scope only — it never writes, and it cannot be
combined with `--ai-badger` (checking never writes; vendoring always does). The adapter
target enforces **exact file-set equality**: missing, extra
and byte-differing files all fail — ai-badger's installer ships any `.ts`/`.json` with no
cleanup, so a renamed canonical file would otherwise leave a stale extra that breaks every
fresh pi session.


## Flow (the reviewed order — do not skip the vendoring step)


1. Edit canonical source here; keep tests green: `bun test`.
2. `bun run publish -- --ai-badger /Users/arasz/RiderProjects/ai-badger` — vendors the
   adapter into that checkout (vendor-ONLY: user scope is not touched in this step; refuses
   if the vendored dir does not exist; cannot be combined with `--check`).
3. In the ai-badger checkout: `bun test features/pi` — its tests exercise the freshly
   vendored artifact — then commit.
4. `bun run publish` — installs canonical to user scope.
5. `bun run check` — must exit 0.

A user-scope-only publish is **transient**: the next real scaffold of any project
re-copies ai-badger's vendored adapter over it. Step 2 is what makes a change durable.


## Why not a symlink


ai-badger's installer (`adjust_hooks.py`) `copy2`s files into
`~/.pi/agent/extensions/ai-badger/`. Through a symlinked directory that would write into
this repo during scaffolds of unrelated projects — and a scaffold from an older ai-badger
checkout would push stale bytes into canonical source. Copies plus `--check` are the safe
shape.


## Concurrency note


Installs write to a temp file then rename — no partially written file ever appears at a
destination. The rename is per-FILE, not per-set: a pi session starting inside the
sub-millisecond window between two adapter-file renames could observe a mixed set.
Already-running sessions are unaffected (their modules are loaded). ai-badger's freshness
gates run `--no-install`, so CI activity never races the user-scope install.


## Provenance


- Adapter imported byte-identical from ai-badger @ `f07ff473` (0.145.0), which carried the
  PostToolUse arm work verified live that day.
- shift-enter-newline imported byte-identical from user scope
  (`~/.pi/agent/extensions/shift-enter-newline.ts`, 2026-08-29); its tests came from the
  temporary home `~/RiderProjects/shift-enter-newline-tests` (10 passing tests) — that repo
  is superseded by this one and safe to archive once this suite is green.
