# ADR — Monitor bash-predicate execution (predicateKind, stdin, exit mapping, kill escalation)

Status: **ratified in-lane** (task pbi-monitor-register-bash-predicate, 2026-09-08).
Scope: `extensions/monitor/bash-predicate.ts` (spawn core) + `extensions/monitor/index.ts`
wiring (`MonitorDeps` seams, `ArmedMonitor`, register/drain/disarm paths). All numbers and
behaviors below are quoted verbatim from those two files; no other source is normative.

## Context

The monitor extension arms one-shot predicate monitors over delegation transitions. JS
predicates (`predicateKind: "js"`) evaluate synchronously in a `node:vm` sandbox against
`{ delegations, monitors }`. Bash predicates exist for checks the sandbox cannot express
(JSON scans without jq, file probes, CLI gates) and run **unsandboxed** as `bash -c`
with the user's full privileges — only register what the agent itself wrote. The design
must answer four questions: how the snapshot reaches the script, what each termination
means, how a hung script dies without orphans, and how the two predicate kinds are told
apart everywhere they surface.

## Decision

### 1. Snapshot transport: stdin, never argv/env; env/cwd inherit

- The per-drain snapshot is stringified **once** (`serializeBashSnapshot`: `JSON.stringify`,
  circular input → typed `{ kind: "error" }`, caller error+disarms, never throws) and the
  resulting JSON is handed to **every** bash child of that drain as its stdin bytes.
- Spawn is `spawn(executable, ["-c", predicate], { shell: false, stdio: ["pipe","pipe","pipe"],
  detached: platform !== "win32" })`. The script travels as **one argv element** to
  `bash -c`, never interpolated into a shell string. Nothing is passed for env/cwd, so
  both **inherit** — part of the unsandboxed trust model.
- Stdin write is `stdin.end(json)` in try/catch with an `'error'` swallow: a predicate
  that exits early (or closes stdin, `exec <&-`) EPIPEs the pipe and that must not throw —
  the exit code still decides the outcome. Snapshots can exceed `ARG_MAX` and argv leaks
  into process listings, so argv/env transport was rejected on those two grounds.
- The compile gate (`bash -n`) likewise takes the script on **stdin** (`startRun(["-n"],
  predicate, …)`), because a string argument to `bash -n` would be a file path.

### 2. Exit-code mapping: 0 / 1 / ≥2 + signal + timeout + spawn

`startBashPredicate` never throws and `done` never rejects — every termination maps to
`{ kind: "fired", value } | { kind: "idle" } | { kind: "error", reason }`:

- **exit 0 → fired.** Value is the trimmed stdout head-capped at
  `BASH_PREDICATE_VALUE_MAX_CHARS` (1024); empty output means `true`. Output reads
  top-down (head cap), unlike the snapshot digest which tail-caps.
- **exit 1 → idle.** The monitor stays armed; the next transition drains again (plus the
  SHOULD-1 re-drain below).
- **exit ≥2 → error+disarm.** Reason is `bash predicate exited N (0 fires, 1 is idle).`
  plus the stderr head-capped at `BASH_PREDICATE_STDERR_MAX_CHARS` (1024) when present.
- **signal death → error+disarm.** Reason is `bash predicate died on signal <NAME>
  (external kill — expiry/shutdown/cancel/abort — or the script killed itself).` plus
  capped stderr. Neutral by construction: the helper cannot tell an external kill from a
  self-inflicted one (`kill -KILL $$`), so it names both.
- **timeout → error+disarm.** Reason is `bash predicate timed out after <timeoutMs> ms —
  killed (SIGTERM, then SIGKILL after <graceMs> ms).` plus capped stderr.
- **spawn failure (ENOENT and friends) → error+disarm, never a crash.** Both the gate
  and the run map `spawnError` to `bash is not available (<detail>) — bash predicates
  need a bash executable on PATH (on Windows: Git Bash or WSL bash on PATH; that
  prerequisite is documented on the monitor tool). Register a JS predicate instead, or
  install bash.`
- Retention guard: chunks past `OUTPUT_RETAIN_MAX_CHARS` (8192) are dropped while
  collecting, so a runaway `yes` cannot OOM the host before the timeout kill lands; the
  1024-char head caps apply on top.

### 3. Timeout and kill escalation: 5 s, SIGTERM→SIGKILL 500 ms, group kill, in-flight sets

- Budgets (all overridable via `MonitorDeps`, all `positiveMs`-guarded, tests run 50–100 ms
  against real short-lived children): one-evaluation `BASH_PREDICATE_TIMEOUT_MS` (5000),
  escalation grace `BASH_PREDICATE_GRACE_MS` (500), compile-gate `BASH_COMPILE_TIMEOUT_MS`
  (2000). The catalog's `~2s + 5s` is gate + one evaluation budget.
- Escalation is one shared `escalate()` (timeout expiry, abort signal, `handle.kill()`):
  SIGTERM now, SIGKILL after the grace. Grace/timeout timers are helper-owned **real**
  timers (`pendingTimers` set, cleared on child exit) — bash children are OS processes
  outside the injected manual-scheduler world.
- Portable kill (`killChildProcess`, never throws): POSIX signals the whole process
  **group** (`killFn(-pid)`, possible because the child spawns `detached`) and falls back
  to `child.kill` when the group kill throws; **win32 never uses a negative-pid kill** —
  `child.kill` only.
- Liveness tracking is two sets: the helper-global `inFlight: Set<ChildProcess>` (every
  live bash child; `bashInFlightCount()`/`bashPendingTimerCount()` are the orphan-proof
  surfaces, asserted 0 in `afterEach`) and the wiring's `bashHandles: Map<id, Set<BashHandle>>`
  (per-monitor handles for targeted kills).
- Disarm-before-await (`ArmedMonitor.epoch`): expiry, cancel and shutdown delete the
  record **and** bump `epoch` before the async kill lands; completions re-check map
  membership + epoch and suppress stale outcomes (fire/error paths delete without a bump —
  the map miss alone suppresses a second completion). Kill alone is not the guard because
  SIGTERM delivery races the child's own exit.

### 4. predicateKind discriminator: `js` default, `bash` opt-in, echoed everywhere

- `predicateKind?: "js" | "bash"`, default `"js"`. Unknown values reject loudly
  (`predicateKind must be "js" or "bash"`). Empty/missing predicate rejects with a
  kind-specific hint (JS: bare expression, no `return`; bash: script on stdin, exit
  0 fires / exit 1 idle).
- **Gate split (M6):** `bash` skips `normalizePredicate`/`compilePredicate` entirely —
  `if...fi` and `return 0` survive verbatim. Its only registration checks are the shared
  4096-char cap (`BASH_PREDICATE_MAX_CHARS`, mirrors the JS cap so card-budget math stays
  4 KB predicate + 1 KB value + tail-capped digest ≤ 8 KB) and the `bash -n` gate, which
  runs **before** the monitor-cap check (9th-register rejects naming the 8 active ids).
- **Evaluation split (M2):** each drain runs JS first and synchronously (fire/error cards
  send in the same tick); bash follows concurrently on the one serialized snapshot,
  fire-and-forget (`Promise.all` of `settleBashEvaluation`, never rejects). Registration
  `armed.set`s first (self visible in `snapshot.monitors`), then: JS evaluates once inline;
  bash serializes once and **awaits** its immediate evaluation (register blocks up to one
  evaluation budget) so the receipt names the real outcome (`armed` / `fired`+value /
  `error`+reason; disarm-mid-flight → loud throw, never a phantom receipt).
- **Value split (M8):** bash fires carry `value` (stdout head or `true`) in receipt
  details, on the card details, and in the card body; JS fires omit `value`.
- **Echo:** receipt details, `list` rows (`[js]`/`[bash]`), and the `/monitors` panel all
  carry `predicateKind`; JS armed without the key echoes `"js"`. The idle-fleet
  `wait-timer` monitor is always `predicateKind: "js"` (`false` predicate, never a bash
  child — pinned by test with `bashInFlightCount() === 0` throughout).
- **Re-drain (SHOULD-1):** a bash monitor with a child in flight skips concurrent drains
  but marks `needsRedrain`; its idle completion re-drains that monitor **once** against
  `currentSnapshot()` (still one child at a time; flag clears first so a quiescent fleet
  settles idle). Fire/error completions never re-drain (disarmed).

## Consequences

- Registering a bash monitor awaits its immediate evaluation (compile gate plus up to one
  evaluation budget, defaults ~2s + 5s); transition drains never block — bash evaluates
  concurrently on one frozen snapshot while JS cards send synchronously.
- Expiry, cancel and shutdown kill in-flight bash children (SIGTERM→grace→SIGKILL,
  group kill on POSIX) and their late completions are suppressed, never delivered — one
  card per monitor at most (fired *or* error *or* expired; cancel/shutdown send none).
- Operators need `bash` on PATH (Git Bash or WSL on Windows); otherwise every bash path
  fails loud with the JS-fallback guidance above.
- Tests pay real-process time: helper legs use 50–100 ms budgets, wiring legs use short
  real sleeps (`sleep 0.2/0.3`) plus `pause()` — deterministic because in-flight state is
  asserted synchronously after `fireTransition` and quiescence via the zero-counters.

## Alternatives

- **Snapshot via argv/env:** rejected — snapshots can exceed `ARG_MAX` and argv leaks into
  process listings; stdin is the only channel with neither failure.
- **Exit-1-as-error / nonzero-fires:** rejected — the 0/1/≥2 split mirrors `grep` (`-q`
  probes compose directly: `grep -q '"state":"completed"'`), and collapsing idle into
  error would disarm monitors on the expected not-yet-true case.
- **Timeout without escalation (SIGKILL at once) or without group kill:** rejected — a
  `sleep` grandchild survives a bare `child.kill` on POSIX (orphan), and SIGTERM-first
  gives well-behaved scripts a grace window before SIGKILL.
- **Vendored bash-executable seam (`bashExecutable` dep):** rejected for this loop
  (accepted as-is) — the `executable`/`platform` seams live on the helper options where
  the ENOENT/win32 tests need them; wiring tests drive real `bash` with time seams only.
- **Coalescing by documenting loss (no re-drain):** rejected in favor of the one-shot
  re-drain above — a firing transition landing mid-flight must still fire without further
  transitions; the flag+recurse keeps one-child-at-a-time while closing the loss window.
