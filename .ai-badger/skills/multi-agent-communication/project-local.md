# Project-local: bus identity discipline (prose-beats-wire lesson)

## Know who you are first — prose lies, the wire doesn't

Session ids found in files, transcripts, task-tracking entries, and message
bodies are stale bindings: a resumed session gets a fresh id while the old one
stays behind in text, and announcing one as your own strands 1:1 replies at a
dead id (see `docs/work/2026-09-08-bus-identity-and-delegation-skip-report.md:F2`).

Before your first broadcast in a session:

1. Run the `message-bus` action `whoami`. That id is you for this session — it is
   the only bus output that echoes your full id (`list`/`check` show truncated
   prefixes only).
2. Never claim an id copied from a file, transcript, tracking entry, or message
   content as your own, and never address a 1:1 by a copied id — answer a sender
   with the `message-bus` action `reply` by message id instead.
