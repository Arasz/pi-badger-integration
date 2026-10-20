# Research — widen the delegation runner's retry predicate to a 402, respawn on the parent model

> Task: `pbi-runner-retry-402-parent-model`. Loop: low. Sources below are cited by path (and
> line where the file is local). Claims marked HYPOTHESIS are not measured.

## 1. The failure, measured

A real delegation run whose child died on a billing error, from the runner's own log tee
(`~/.pi/agent/subagent-logs/projects/cfe47dab-5dfc-4749-9551-6a81f51c7beb/d-83.jsonl`):

| log line | what it carries |
|---|---|
| `run` | the child argv: `--model openrouter/deepseek/deepseek-v4.1-flash` (level-resolved, see §3) |
| `message_start` / `message_end` (index 8, 9) | `role: assistant`, `stopReason: "error"`, `errorMessage: "402: {\"message\":\"This request requires more credits, or fewer max_tokens. You requested up to 887478 tokens, but can only afford 1252. …\",\"code\":402,…}"` |
| `message_start` / `message_end` (index 16, 17) | the in-child `router-fallback` custom event: `switched openrouter/deepseek/deepseek-v4.1-flash → openrouter/inclusionai/ling-3.1-flash (billing-exhaustion); billing-exhaustion: status-prefix 402` |
| `message_start` / `message_end` (index 18, 19) | the SECOND 402 — same shape, on the router-fallback's replacement model (same provider, same account) |
| `stderr` (index 24) | only `ai-badger subagent extension v1.4.0: session started — delegation registry live` — **nothing about the 402** |
| `exit` (index 25) | `exitCode: 0` |

**Load-bearing facts (measured, not inferred):**

- **F1.** The 402 is in the child's **stdout event stream**, on an assistant message with
  `stopReason: "error"`, in `message.errorMessage`, prefixed `"402: "`.
- **F2.** The child's **stderr carries no 402** — the runner's current predicate reads stderr
  only, so it can never see this failure.
- **F3.** The child **exits 0** — the runner's current guard `code !== 1` would reject the retry
  even if the text were visible.
- **F4.** The child **emits progress events** (`message_start`/`message_end` are parsed events) —
  the current guard "no progress event was parsed" would also reject the retry.
- **F5.** The account is out of credit: `total_credits 830.95` vs `total_usage 831.1487` → −0.199 USD
  (owner-measured, 2026-10-19). A paid OpenRouter model cannot start; a free one can.

## 2. Why the current predicate cannot fire

`extensions/subagent/delegation-runner.ts:517-529` — the one retry decision point:

```ts
private shouldRetryOnModelFailure(state, code, signal): boolean {
  const fallbackArgs = state.request.fallbackArgs;
  if (!fallbackArgs || state.retried) return false;
  if (JSON.stringify(fallbackArgs) === JSON.stringify(state.request.args)) return false;
  if (code !== 1 || signal !== null) return false;          // ← F3 kills it
  if (state.events.some((event) => isProgressEvent(event))) return false;  // ← F4 kills it
  return isModelStartupFailure(state.rawStderr);            // ← F2 kills it
}
```

The stderr signature it matches (`extensions/subagent/delegation-runner.ts:76-81`) is the
d-324 startup class (`no api key found for`, `model "…" not found`, `is ambiguous across
providers`, `unknown provider`, `no models available`) — a **startup** failure, not a billing one.

## 3. The traced path: persona → argv → 402

1. `.pi/agents/architect.md` carries `level: high` and **no** `model:` (the delivered personas
   were rewritten by `features/pi/adjustments/adjust_agents.py`, which keeps `model:` only when
   provider-qualified).
2. `extensions/subagent/index.ts:1246` → `resolveDelegationModel(registry, {frontmatterModel,
   persona.model, level: persona.level, sessionModel})`; a bare alias never reaches argv
   (`admitExplicitModel`, `extensions/subagent/delegation-core.ts:1180`), so the **level decides**.
3. Level `high` → `groups["high"][0].id` → `openrouter/deepseek/deepseek-v4.1-flash`
   (`.ai-badger/model-groups.json`; the preferred entry of the high group).
4. `delegationArgs` emits `--model openrouter/deepseek/deepseek-v4.1-flash`; the child spawns and
   the provider answers **402** (§1).
5. `withProviderAffinity` is a no-op here: the resolved id and the session model share the
   `openrouter` provider, and the session's own working id
   (`openrouter/minimax/minimax-m3.1-flash:free`) is a free-tier id no group lists.

## 4. The machinery that already exists (and must be reused, not rebuilt)

- **Fallback argv.** `fallbackArgsFor(args, persona, model, registry)`
  (`extensions/subagent/index.ts:406-450`) derives the fallback argv **from the primary argv**:
  for a level-resolved pin it verifies the argv's `--model` equals `resolveLevel(...)` and then
  **swaps that value for the parent (session) model** — or drops the `--model` pair when the
  parent model is unknown. It is already wired into the delegate path
  (`extensions/subagent/index.ts:1256`) and the queue path (`:1094-1101`).
  For the traced persona it yields `--model openrouter/minimax/minimax-m3.1-flash:free` — the
  parent's own free-tier model, which works while the paid one 402s.
- **The respawn.** `beginFallbackRetry` (`extensions/subagent/delegation-runner.ts:531-562`)
  respawns **once** under the same run id, keeps one log header and one exit line, and records
  the reason on `record.modelFallback` — a free-text field already carried by the note
  (`DelegationNote.modelFallback`) and the card verdict (`notificationVerdict`).
- **The plumbing.** `RunRequest.fallbackArgs` → `StartRequest.fallbackArgs` →
  `DelegationRecord` — no new field is needed anywhere.

## 5. The proven 402 rule in this repo

`extensions/router-fallback/router-fallback-core.ts:197-209, 254-256` — the in-child extension
already classifies this exact failure:

- `STATUS_PREFIX = /^\s*(\d{3})\s*:/` (the `formatProviderError` shape) and
  `PROVIDER_STATUS_PREFIX = /^\s*[A-Za-z][\w+.~-]*(?:\s+[A-Za-z][\w+.~-]*)*\s*\((\d{3})\)\s*:/`
  (the `"OpenRouter (402): …"` shape) — `parseStatusPrefix` tries the provider shape first.
- `statusPrefix === 402` → `billing-exhaustion: status-prefix 402`.

The subagent extension is published as its own package (`publish.ts` copies extension
directories one by one), so it **cannot import** the router-fallback core; it needs its own
narrow copy of the same *rule*. The two must not drift silently — the doc comment has to name
the sibling rule it mirrors.

## 6. What the run reports today (and after)

`extractAnswer` (`extensions/subagent/delegation-core.ts:874-894`) walks the events backwards for
an assistant message **with text**; the 402 message carries `content: []`, so today the run
settles `completed`, exit 0, with the `silent-JSON variant` reason — a completed delegation with
no answer and no hint that the child was out of credit.

## 7. Scope boundaries

- **In:** the runner's retry predicate (widen it to a 402) and the respawn-on-parent-model path
  that already exists; the recorded reason on `modelFallback`; the tests that pin both.
- **Out:** the model-groups registry (the preferred `high` id is a paid model — changing the
  registry is a different task); the router-fallback extension's own model switch (it stays on
  the provider and 402s again); the account's credit balance.
- **Open question for the plan:** whether a 402 retry is allowed when the child already made
  progress (the startup arm forbids it) — the 402 arm's guard set must be decided explicitly.
