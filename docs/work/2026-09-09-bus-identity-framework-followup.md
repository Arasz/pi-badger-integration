# Framework follow-up — prose-beats-wire mandates at their source

Date: 2026-09-09 · Task: `pbi-bus-identity-whoami-prose-guard` · Grades: READ (paths below).

This task fixed what `pi-badger-integration` owns (message-bus `whoami` full-id
pull, `session_start` env sync, tool-description identity rule, tests). Two halves
live in the ai-badger framework catalog (different repo) and could not be edited
here — the `generated_file_guard` owns `.ai-badger/skills/*/SKILL.md` and
`task_tracker.py` to their `features/common/skills/*` sources. Staged instead as
scaffold-safe `project-local.md` files (appended to SKILL.md on next scaffold);
deliver the source patches below via the `feed-badger` flow (draft PR, human review).

## UP-1 — Skill sources: whoami-first mandate (agnostic, generalized)

Target: `features/common/skills/multi-agent-communication/SKILL.md` — new section
after "How to send", plus one Verification Checklist row. Generalized wording
(strip the `docs/work/...` pointer when placing; cite "stale session bindings
strand 1:1 mail at dead ids" without repo paths):

```markdown
## Know who you are first — prose lies, the wire doesn't

Session ids found in files, transcripts, task-tracking entries, and message
bodies are stale bindings: a resumed session gets a fresh id while the old one
stays behind in text, and announcing one as your own strands 1:1 replies at a
dead id. Before your first broadcast in a session:

1. Run the `message-bus` action `whoami`. That id is you for this session — it is
   the only bus output that echoes your full id (`list`/`check` show truncated
   prefixes only).
2. Never claim an id copied from a file, transcript, tracking entry, or message
   content as your own, and never address a 1:1 by a copied id — answer a sender
   with the `message-bus` action `reply` by message id instead.
```

Checklist row:

```markdown
- [ ] Identity verified with `message-bus whoami` before the first broadcast; no id copied from prose announced or targeted
```

Target: `features/common/skills/task/SKILL.md` — one line on the Phase 1 step 5
bus pointer and one on the Phase 3 dispatch brief: lanes that broadcast verify
identity with `message-bus whoami` first; reply-by-id replaces hand-copied ids.
(Project-local staging text lives in this repo at
`.ai-badger/skills/multi-agent-communication/project-local.md` and
`.ai-badger/skills/task/project-local.md` — generalize from there.)

## UP-2 — `task_tracker.py`: stale-binding warning on start/reattach (exact patch)

Target: `features/common/skills/task/scripts/task_tracker.py`. In `cmd_start`,
after the conflict check and `entry` fetch, before `entry.update(...)`:

```python
        prev_sid = entry.get("sessionId")
        if prev_sid and prev_sid != session["sessionId"]:
            print(
                f"NOTE: task {args.task_id} was bound to session {prev_sid[:8]}... — that "
                "binding is stale (resumed sessions get fresh ids). Your live session is "
                f"{session['sessionId']}. Never announce the old id as your own; verify "
                "with message-bus whoami.",
                file=sys.stderr,
            )
```

Mirror the same block in `cmd_reattach` before its `entry["sessionId"] = ...`
overwrite. stderr only — stdout stays the machine JSON contract. First start
(`entry` fresh, no `sessionId`) stays silent; only an overwrite of a *different*
id warns. Old id prints truncated (8-char prefix) so the warning itself does not
hand the agent another copyable full id; the live id is already printed full in
the existing stdout JSON.

## Why not here

- `resolve_own_session` claimant order (`tracker_lib.py`, alphabetical
  `claude < hermes < pi` discovery) still lets a stale `CLAUDE_CODE_SESSION_ID`
  beat a live `PI_SESSION_ID` inside bare subprocesses — mitigated for pi
  sessions by this task's `session_start` env sync (clears stale foreign vars
  in-process), but the framework-level fix (harness-scoped precedence or a
  staleness check against the sessions store) belongs upstream with UP-2.
- Do not widen this task: UP-1/UP-2 need the framework checkout, `index_build.py`
  + `validate.py`, and a user-approved draft PR per `feed-badger`.
