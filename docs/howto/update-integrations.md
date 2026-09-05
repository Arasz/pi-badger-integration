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

Bump nothing else: there is no VERSION file, and the extension manifests carry their own versions. After pushing the tag, verify the check end to end with a stale marker against the live API before announcing.
