# Docs

Map of the documentation in this repo. Plans and research records live alongside; this page lists what a user or contributor actually needs.

## How-to (do X)

- [Install extensions](howto/install-extensions.md), install, verify, update, remove.
- [Configure provider keys](howto/configure-provider-keys.md), Groq, Gemini, and OpenRouter keys for the router-fallback chain.
- [Update integrations](howto/update-integrations.md), release notices and the update path.
- [Wait for mail](howto/wait-check-loop.md), wake sources and aborting wait deadlines.

## Explanation (why it is shaped this way)

- [Publish flow](explanation/publish-flow.md), canonical source, user scope, and the ai-badger vendoring step; the three-copy model and the reviewed order.

## Reference (look facts up)

- [Extension catalog](reference/extension-catalog.md), subagent, monitor, and router-fallback in depth.

## Plans and work logs

- [plans/](plans/), architecture plans and research records (router-failure fallback series, delegation series).
- [work/](work/), session work logs.
- [Aborting delegation wait timeouts ADR](work/2026-10-06-aborting-delegation-wait-timeouts-adr.md), cancellation scope, compatibility, and timeout races.
