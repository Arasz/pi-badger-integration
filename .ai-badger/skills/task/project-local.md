# Project-local: bus identity in the task loop (prose-beats-wire lesson)

- Phase 1 step 5 / Phase 3 dispatch: any session that will broadcast on the
  message bus verifies identity first with the `message-bus` action `whoami`
  (the intentional full-id pull; `list`/`check` headers stay truncated)
  and never announces an id copied from files, transcripts, tracking entries,
  or message content — stale bindings strand 1:1 mail at dead ids
  (see `docs/work/2026-09-08-bus-identity-and-delegation-skip-report.md:F2`).
- Lane briefs for lanes that broadcast carry the same rule; the reply-by-id
  mechanism (`message-bus` action `reply`) replaces every hand-copied session id.
