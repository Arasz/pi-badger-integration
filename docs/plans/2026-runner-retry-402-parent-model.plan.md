# Plan — widen the delegation runner's retry predicate to a 402, respawn on the parent model

> Task: `pbi-runner-retry-402-parent-model`. Loop: low. Research record:
> `docs/plans/2026-runner-retry-402-parent-model.research.md` (cited as R§n below).
>
> **As shipped** (PR #59, plus the test-only PR #60). Two refinements the review round forced
> over the design below, and one the plan left open:
>
> - `beginFallbackRetry` takes a `RetryFailure` (the class **and** the reason), not the reason
>   alone — the two classes must read differently on the card ("was rejected" vs "hit a
>   provider billing failure"), so the class travels with the reason.
> - the respawn marks an **attempt boundary** (`state.attemptStart`): the settled answer is the
>   respawned attempt's, never the failed attempt's partial text. The plan's D1 (respawn even
>   when the child had produced output) stands, and the duplication of side effects is
>   documented in the extension catalog.
> - D1 is decided: respawn even when the child produced output — one respawn, from the start,
>   under the same run id.

**Objective.** A delegated child that ends on a provider **402** (billing exhaustion) respawns
**once** on the **parent (session) model** — the machinery that already exists, one decision
point, **no schema change**.

**Acceptance (top level).** Every step's criteria below are checked and met; the gates are
`bunx tsc --noEmit -p .` and `bun test tests/subagent-model-fallback.test.ts tests/subagent/`.

---

## 1. The design (decided)

### 1.1 Where the 402 lives

The child's **stdout event stream**, on the assistant turn that failed: an event of type
`message_end` whose `message` is `{role: "assistant", stopReason: "error", errorMessage: "402: {…}"}`
(R§1 F1). The child's **stderr** never carries it (F2) and the child **exits 0** (F3) while
still emitting progress events (F4) — so the current startup arm cannot see it.

### 1.2 The status-prefix rule (mirrors the sibling, copied narrowly)

`extensions/router-fallback/router-fallback-core.ts:197-209` already proves the two shapes
`formatProviderError` produces. The subagent extension is published as its own package
(`publish.ts` copies extension directories one by one), so it cannot import that core — it
carries its own narrow copy of the same **rule**, and its doc comment names the sibling rule it
mirrors so the two cannot drift silently.

```ts
/** `"<status>: <body>"` — the `formatProviderError` no-prefix shape. */
const STATUS_PREFIX = /^\s*(\d{3})\s*:/;
/** `"<provider> (<status>): <body>"` — the `formatProviderError` prefixed shape. */
const PROVIDER_STATUS_PREFIX = /^\s*[A-Za-z][\w+.~-]*(?:\s+[A-Za-z][\w+.~-]*)*\s*\((\d{3})\)\s*:/;
```

Provider-prefixed first, then bare — the sibling's order. **402 only**: a 401/429/5xx must not
arm the retry. The rule is the **status**, not the billing wording: a 402 is unambiguous, and
matching free-form text ("insufficient credits") inside a child's own output would be a
false-positive magnet.

### 1.3 The one decision point

`DelegationRunner.shouldRetryOnModelFailure` (extensions/subagent/delegation-runner.ts:517-529)
becomes the single place that answers "does this failed child respawn on the parent model?" —
two failure classes, each with its own guards:

| arm | trigger | guards | reason text |
|---|---|---|---|
| **startup** (unchanged) | the d-324 class: the child died exit-1 with the startup signature on stderr | `code === 1`, no progress event parsed, stderr matches `MODEL_STARTUP_FAILURE_RE` | the stderr's first non-empty line (as today) |
| **billing** (new) | the child's **last** assistant turn ended on a 402 | no fallback argv · the fallback argv differs from the primary · the retry is not spent · the child was not killed by a signal | the 402 error message, capped like today's 160 chars |

**The billing arm deliberately ignores the exit code and the progress guard** (D1). A 402 is an
API error *inside a live child*: the run ended in a billing failure, and a respawn on the
parent model is the only chance for an answer. The startup arm's "no progress event" rule
exists because a half-finished child must not silently restart; the billing arm restarts a run
that produced **no final answer**, and the reason is recorded on the record (never silent).

**The last assistant turn, not any 402** (D2). With the `router-fallback` extension loaded in
the child, a 402 can be **recovered in-child** (the child switches model and continues). The
arm therefore reads the **last** `message_end` with `role: "assistant"`: if that turn is not a
failed turn, the run did not end on a 402 and no retry happens. Source: `message_end` — the same
event `extractAnswer` already treats as the assistant turn boundary.

### 1.4 What is reused (no schema change)

- `RunRequest.fallbackArgs` → already the **parent model**: `fallbackArgsFor`
  (extensions/subagent/index.ts:406-450) swaps the primary argv's `--model` value for the
  session model (or drops the `--model` pair when the parent model is unknown). For a
  `level:`-pinned persona it verifies the argv's `--model` equals the level-resolved id first.
- `beginFallbackRetry` (delegation-runner.ts:531-562) — respawns **once** under the same run
  id, one log header, one exit line, one note. It gains **one parameter**: the reason text
  (today it derives it from stderr).
- `record.modelFallback` / `note.modelFallback` — the existing free-text channel. The 402
  reason rides the existing shape:
  `--model <pin> was rejected (402: …) — retried on --model <parent model>`.
- `notificationVerdict` — already appends `modelFallback` to the verdict line.

**No** new record field, note field, tool parameter, config knob, or public tool-schema change.

### 1.5 D3 / D4 — the recorded reason and the final report

- **D3.** The reason is the 402 error message, first 160 chars — the same cap the stderr
  reason uses today. The `modelFallback` string keeps its current shape, so the card needs no
  new vocabulary.
- **D4.** Attempt-1's events **stay** in `state.events` (the runner never resets them today).
  `extractAnswer` walks backwards, so attempt 2's answer wins when there is one; when attempt 2
  also ends on a 402 the run settles as it does today (`completed`, exit 0, no answer → the
  "silent-JSON variant" reason) **plus** the `modelFallback` line that names the 402 and the
  retried model. The log keeps attempt 1's stdout (flushed before the respawn) followed by
  attempt 2's, under one header and one exit line — the existing invariant.

### 1.6 One type widening

`ChildMessage` (extensions/subagent/delegation-core.ts:38-42) declares `role`, `content`,
`usage`. Reading the failed turn's `stopReason` and `errorMessage` adds two optional fields
to that interface — a type widening, not a schema change (the interface is documented as "the
parts of this core reads").

---

## 2. The step DAG

Two steps touch code; they are **serialised** (step 1's failing tests define step 2's contract,
and both live in the same test file / module family). Step 3 is docs and is independent of the
code steps but runs after them so the wording matches the shipped behaviour.

### Step 1 — `s1-red-tests` (effort medium, files: `tests/subagent-model-fallback.test.ts`)

**Goal:** the failing tests that pin the 402 arm, written before any production change.

**Instructions.** Add a new `describe` block to the existing fallback test file, following its
house style (header doc comment naming the failure modes, behaviour-focused assertions, no
tautologies). Use the existing `FakeChild` fixture: `emitEvent` for a stdout event,
`stderrWrite` for stderr, `exit(code, null)` for the close. A 402 child looks like:

```ts
function billingFailure(text: string): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: text } };
}
```

**Acceptance criteria**

| id | criterion | check |
|---|---|---|
| s1.1 | The suite contains a test that fails on today's code: a child whose last assistant turn is a 402 (exit 0) must respawn on the fallback argv | `bun test tests/subagent-model-fallback.test.ts` — the new test is RED before step 2, and the failure names the missing respawn |
| s1.2 | Every new test names the failure mode it targets and the mutation that proves it real (in the test's name or a comment) | review of the test file: each new test has both |
| s1.3 | The existing startup-failure tests are untouched and still green | `bun test tests/subagent-model-fallback.test.ts` — the pre-existing block passes |
| s1.4 | The red test is genuinely red for the right reason | the failure output points at "no second child was spawned" (the retry never fires), not at a compile error |

**Test list (each row = failure mode → mutation that proves the test is real)**

| # | test | failure mode it targets | mutation that must redden it |
|---|---|---|---|
| T1 | a 402 child respawns on the fallback argv and completes on the parent model | the 402 arm does not exist | delete the billing arm → T1 red |
| T2 | the billing arm ignores the exit code (exit 0) and the progress guard (a progress event was parsed) | the startup arm's guards applied to the billing arm | move the startup guards ahead of the billing arm → T2 red |
| T3 | a 401 / 429 / 500 assistant error does **not** respawn | the status check widened to any 4xx/5xx | accept any 3-digit status → T3 red |
| T4 | the provider-prefixed shape `OpenRouter (402): …` respawns | the prefixed shape unhandled | drop `PROVIDER_STATUS_PREFIX` → T4 red |
| T5 | a child that **recovered** from a 402 (its last assistant turn is a normal answer) does not respawn | "any 402 in the stream" instead of "the last turn failed" | scan all events for a 402 → T5 red |
| T6 | a 402 without `fallbackArgs` does not respawn | the missing-fallback guard | pass `fallbackArgs: undefined` → T6 red |
| T7 | a 402 whose fallback argv equals the primary argv does not respawn | the identical-argv guard | drop the equality guard → T7 red |
| T8 | a 402 respawns **at most once** (a second 402 settles the run) | the one-retry guard | drop `state.retried` → T8 red |
| T9 | the recorded `modelFallback` names the pin, the 402 and the parent model | the reason is not recorded | record an empty reason → T9 red |
| T10 | a child killed by a signal does not respawn | the signal guard | drop the `signal !== null` guard → T10 red |

### Step 2 — `s2-green-implementation` (effort medium, files: `extensions/subagent/delegation-runner.ts`, `extensions/subagent/delegation-core.ts`)

**Depends on:** `s1-red-tests` (the tests define the contract).

**Goal:** the widened predicate — one decision point, reusing the existing respawn.

**Instructions.**

1. `delegation-core.ts`: widen `ChildMessage` with `stopReason?: string` and
   `errorMessage?: string` (both optional; the interface is "the parts this core reads").
2. `delegation-runner.ts`:
   - add the two status-prefix regexes and a small `parseStatusPrefix` (provider shape first,
     then bare) plus an exported pure predicate
     `isBillingExhaustionFailure(errorMessage: string): boolean` (402 only), whose doc comment
     names the sibling rule it mirrors (the router-fallback core's status-prefix rule) and says
     why the copy exists (the extension is published as its own package);
   - add a module-private helper that returns the child's **last** assistant turn's error
     message when that turn failed on a 402 (else undefined);
   - rewrite `shouldRetryOnModelFailure` as the single decision point with the two arms
     (§1.3): the startup arm keeps its exact guards; the billing arm adds none beyond the
     shared ones (no fallback · different argv · retry not spent · not signalled);
   - give `beginFallbackRetry` the reason text as a parameter (the startup arm passes the
     stderr's first non-empty line as today; the billing arm passes the capped 402 message) so
     one respawn path serves both arms;
   - keep the `modelFallback` string shape exactly as today.

**Acceptance criteria**

| id | criterion | check |
|---|---|---|
| s2.1 | The full fallback test file is green | `bun test tests/subagent-model-fallback.test.ts` → 0 fail |
| s2.2 | The subagent suite is green | `bun test tests/subagent/` → 0 fail |
| s2.3 | The repo typechecks | `bunx tsc --noEmit -p .` → exit 0 |
| s2.4 | The startup arm's behaviour is byte-identical | the pre-existing block of `tests/subagent-model-fallback.test.ts` is unmodified and green |
| s2.5 | No public surface grew | `git diff` shows no new exported tool parameter, no new field on `DelegationRecord`/`DelegationNote`, no new config key |
| s2.6 | The 402 reason is visible to the user | the settled note's `modelFallback` and the verdict line carry the 402 text (asserted in T9) |

### Step 3 — `s3-docs` (effort low, files: `docs/reference/extension-catalog.md`)

**Depends on:** `s2-green-implementation` (the wording must match what shipped).

**Goal:** the user-visible behaviour is documented where the repo documents extension behaviour.

**Instructions.** The catalog's subagent section (docs/reference/extension-catalog.md:83ff)
does not mention the model-pin fallback at all today. Add a short paragraph (3-5 sentences)
covering **both** arms of the one retry: a child that cannot START on its pinned/level-resolved
model, and a child that ends on a **402**, are respawned **once** on the parent (session)
model, and the respawn is recorded on the result note (`modelFallback`) and the card verdict.
Do not document internals (the regexes, the event names) — the contract only.

**Acceptance criteria**

| id | criterion | check |
|---|---|---|
| s3.1 | The catalog names the 402 respawn and the recorded reason | read §"The subagent extension" — the paragraph is present and names both arms |
| s3.2 | The catalog claims nothing the code does not do | each claim maps to a test in `tests/subagent-model-fallback.test.ts` |
| s3.3 | No other doc is stale because of this change | `grep -rn "402" README.md docs/` shows no contradicting statement |

---

## 3. Risks and rejected alternatives

| option | verdict | why |
|---|---|---|
| import the router-fallback core's matcher | rejected | the subagent extension is published as its own package (`publish.ts` copies extension dirs one by one) — a cross-package import would not ship |
| widen the matcher to any 4xx/5xx | rejected | only 402 is billing exhaustion; a 401 (auth) or 429 (throttle) is not fixed by another model, and the sibling rule treats them as different classes |
| match free-form billing wording ("insufficient credits") | rejected for now | a status prefix is unambiguous; free-form text in a child's own output is a false-positive magnet. The sibling core keeps both because it classifies, not retries |
| retry on ANY provider error | rejected | the retry re-runs the whole task; it must be reserved for failures the parent model can actually fix |
| change the model-groups registry (the `high` group's preferred id is a paid model) | out of scope | a registry change is a different task with its own validation rules |
| change the account's credit balance | out of scope | not a code change |
| add a new note field ("retryReason: billing") | rejected | the owner asked for no schema change; the existing free-text `modelFallback` carries the reason |
| add a config switch to enable/disable the 402 retry | rejected | one behaviour, no knob — the owner's "one predicate, machinery that exists" |
| reset `state.events` on the respawn | rejected | the events are the record of what the child did; `extractAnswer` walks backwards, so attempt 2 wins anyway, and the log keeps both attempts |
| let the in-child `router-fallback` handle it | insufficient | the sibling chain's first entry is a **paid** OpenRouter id — the child switched and 402'd again (measured). The parent model can be a free tier; the child's chain stays on the provider |

## 4. Out of scope

- The model-groups registry, the account balance, the `router-fallback` chain order.
- Any change to the child-side extension set.
- A `402` that arrives **before** the child starts (that is the startup class, exit 1).
