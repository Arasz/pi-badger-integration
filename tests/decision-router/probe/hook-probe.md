# Hook probe: `setModel` / `setActiveTools` inside async `before_agent_start`

Manual-only. Do NOT run in-pipeline: spawning `pi` is blocked by the
delegation-skip guard, so this probe runs on a dev machine with the extension
installed to user scope. Source-verified API surface (plan v2 F2, re-checked
against the pinned 0.84.4 `types.d.ts`): `BeforeAgentStartEvent.prompt` at
`:539`, async-capable `ExtensionHandler` at `:902`, `before_agent_start`
registration at `:923`, `ToolInfo` at `:1192`, `ctx.getModel` at `:1261`,
`prompt()` awaiting `emitBeforeAgentStart` in `agent-session.js:915`,
`setActiveToolsByName` at `:659-672`, extension `setModel` at `:2043-2048`
(false-without-auth), handler containment in `runner.js:881-930`.

## Setup

1. `bun run publish` (installs `decision-router` to `~/.pi/agent/extensions/`).
2. Export a real key: `OPENROUTER_API_KEY=...`. Optional tier overrides:
   `PI_BADGER_JEV_TIER_LOW_MODEL`, `PI_BADGER_JEV_TIER_MEDIUM_MODEL`,
   `PI_BADGER_JEV_TIER_HIGH_MODEL` (each `provider/model-id`; unset means
   the tier question can never move the session model).
3. Start `pi` in a scratch checkout (no important session state).

## P1 — tools actuation

1. Send: `Fix the failing build in the deploy pipeline, touching bash and grep`.
2. Expected: the turn proceeds (no visible pause beyond ~1 Jev call);
   `/decisions status` shows `last turn: decided`, `last tools: actuate [...]`,
   `cache: 1 entries, 0 hits`, and a nonzero `cost` line.
3. Repeat the exact prompt. Expected: no new cost/activity;
   `cache: 1 entries, 1 hits`.

## P2 — model pre-flight

1. With tier overrides set, send: `Design the new multi-region failover
   architecture from scratch`.
2. Expected: `last model: upgrade → <high-model> (thinking high)`; the TUI
   model indicator shows the high model for subsequent turns.
3. Send a rename-level task. Expected: a demote only at confidence ≥ 0.85
   (usually `hold (neutral-tier)` / `hold (below-gate)`); the model stays put.
4. Run `/decisions off`, send any prompt, confirm `last turn: skip
   (session-off)`; run `/decisions on` to resume.

## P3 — non-interference with router-fallback

1. Force a router failure (or `/fallback status` to watch the episode), then
   send the P1 prompt again. Expected: a fresh fetch (`cache` grows — the
   `switched` notice invalidated it) and, while latched,
   `last model: hold (upgrade-latched)` on upgrade-shaped prompts.
2. Let one episode settle cleanly, then retry the upgrade prompt.
   Expected: the latch cleared (`latch: none`) and the upgrade actuates.

## P4 — kill switch and privacy

1. `PI_BADGER_DECISION_ROUTER=0 pi` (fresh process), send any prompt.
   Expected: `skip (master-kill)`, zero cost, tool set untouched.
2. Eyeball `/decisions status` + `/decisions shadow`: the key value and the
   prompt text must appear nowhere (hashes only).

## Fallback if `setModel` misbehaves

`setModel` from inside `before_agent_start` is the one seam F2 could not
prove live (agent-session `:2043-2048` returns false without auth; nothing
states the in-hook behaviour explicitly). If the upgrade path declines
(`hold (set-model-declined)`) or throws (`hold (apply-failed)`) while tools
and shadow still work, take the thinking-level-only path: keep Jev tier
answers wired to `setThinkingLevel` alone (low/medium/high per the frozen
map) and record the `setModel` decline in the ADR follow-ups. The wiring
already isolates that step — no other capability changes.
