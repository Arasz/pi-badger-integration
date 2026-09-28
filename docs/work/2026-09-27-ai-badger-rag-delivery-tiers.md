# Research: three delivery tiers for carrying mem-based-rag's logic into ai-badger

**Date:** 2026-09-27
**Question:** Which of three delivery tiers — ai-badger invoking pi, an ai-badger-native
reimplementation, or a shared universal core consumed by both the ai-badger plugin and the pi
extension — is the viable way to bring mem-based-rag's logic to ai-badger skills/hooks?

**Grading convention used here** (stated up front so no finding reads stronger than it is):
`MEASURED` is reserved for behaviour I observed by running something — a test suite, the guard,
a timer. Claims about what a source file *contains* are `READ`, even where I got there by `grep`
or `wc` rather than by eye, and the Evidence line names the file. That is the conservative
reading of the grades: a grep has no "machine and conditions" to report, and the red flag is a
`MEASURED` on something I read rather than ran.

```chart:range
title: cold process spawn, ms (n=20, Apple M4 / Darwin arm64)
python3 -c pass: 17.9..18.9..37.3
bun -e 0: 6.2..6.9..24.3
node -e 0: 81.3..85.0..102.7
```

```chart:matrix
title: the three tiers against what each one costs
tier, card fidelity, one implementation, per-turn cost, drift risk
1 ai-badger calls pi, full, yes, full agent spawn, none
2 ai-badger-native, string only, no, hook-local, high
3 shared core, string only, near, hook-local, low
```

## Findings

### F1 — The extension's "main logic" is already isolated in a 472-line module with zero imports. [READ]

`rag-core.ts` holds the enrichment decision, the thinness gate, the noise dictionary, hit
pruning/dedupe and all block formatting, and imports nothing at all — no pi, no `node:`, no
`process`, no `require`. The file's own header states the boundary: *"Pure core of the
mem-based-rag extension... No pi imports, no processes, no env reads here — the wiring
(index.ts) owns all of that."*

Tier 3's precondition is therefore already satisfied by construction. "Just the main logic" is
not a refactor someone has to perform — it is a file boundary that already exists, exporting
11 functions and 5 types.

**Evidence:** `extensions/mem-based-rag/rag-core.ts` (whole file, 472 lines). Import/purity
claim verified by `grep -nE "^\s*(import|const .*= require)"` and
`grep -nE "process\.|require\(|from \"|from '|node:|@earendil"` over that file, both returning
zero lines. Export list from `grep -nE "^export (function|const|interface|type)"`.

### F2 — That core is 27% of mem-based-rag and 14% of the whole RAG stack. [READ]

Line counts: `rag-core.ts` 472, `index.ts` 1262, `query-pipeline/` 1703 across 8 files. So the
shareable "main logic" is a small, sharply bounded slice, and the other 86% is transport,
child-process management, pi command wiring and the multi-query planner. This matters for how
the tiers should be scoped: none of the three needs to touch the query-pipeline to deliver the
single-search behaviour.

**Evidence:** `wc -l` over `extensions/mem-based-rag/rag-core.ts`, `extensions/mem-based-rag/index.ts`,
`extensions/query-pipeline/*.ts` (1703 lines, 8 files). Percentages are those counts divided by
1734 (mem-based-rag only) and 3357 (full stack).

### F3 — The core runs and is behaviourally pinned without any pi runtime. [MEASURED]

The core's test file imports only `rag-core.ts` and passes standalone. 43 tests pin the gate
order, the noise dictionary, the skill-prefix rules, hit pruning, both block formats and the
card parser. This is the strongest asset tier 3 has: the spec already lives in executable form
in a language-neutral-to-pi sense.

**Evidence:** `bun test tests/mem-based-rag/rag-core.test.ts` → `43 pass, 0 fail, 148 expect()
calls`, wall time 51.00 ms. Machine: Darwin arm64, Apple M4, bun. No pi runtime loaded — the
test file imports `./rag-core.ts` only.

### F4 — ai-badger already implements this exact shape — enrich the prompt, inject context — for the MCP tool index instead of the memory bank. [READ]

ai-badger's retrieval layer reads the raw user prompt, ranks candidates, gates on whether
anything is worth saying, and prepends a hint to the turn; on no match it stays silent. The
docstring calls it *"MCP-tool-recommendation logic shared by every agent's context-enrichment
hook"*, and `docs/retrieval.md` frames the whole layer around *"knowing when to say nothing"* —
which is precisely what `shouldEnrich` does.

So tier 2 is not "invent prompt enrichment in ai-badger". It is "point an existing, shipping,
per-agent enrichment subsystem at a different corpus." The blocking gates map across
one-for-one.

**Evidence:** `~/RiderProjects/ai-badger/features/common/retrieval/context_enrichment.py:1-8`
(module docstring); `~/RiderProjects/ai-badger/docs/retrieval.md` §1–2;
`pi-badger-integration/.ai-badger/skills/mcp-index/scripts/context_enrichment_hook.py:1-14`
(*"emits the top matches as `additionalContext`... Silent (exit 0, no output) when: ... nothing
clears the coverage gate"*).

### F5 — ai-badger already ships a shared core with thin per-agent adapters, copied beside the hooks at scaffold time. [READ]

`context_enrichment.py` exists specifically so the Claude/Copilot adapter *"does not have to
duplicate index-loading, near-miss scoring and hint formatting"*, and its modules are *"copied
flat, beside each other, at scaffold time (RETRIEVAL_MODULES in the Hermes/Claude/Copilot
adjustments)"*. `docs/retrieval.md` §2 draws one `context_enrichment.py` box feeding two
different callers — Hermes's `ai_badger_hooks.py pre_llm_inject_context` and Claude/Copilot's
`context_enrichment_hook.py`.

This is the precedent tier 3 would extend, with one important caveat: it shares across *agents*,
not across *languages*. Every consumer is Python.

**Evidence:** `~/RiderProjects/ai-badger/features/common/retrieval/context_enrichment.py:1-12`;
`~/RiderProjects/ai-badger/docs/retrieval.md` §2 ("The caller — one per agent").

### F6 — Tier 1's shape is already implemented inside the extension: `/ask` re-invokes pi as an isolated child. [READ]

`askPiInvocation` re-runs the current process's own script, falling back to `pi` on PATH, and
the child is launched with `--no-session --no-tools --no-skills --no-extensions
--no-prompt-templates` plus an excluded-tools list and a 90 s budget. So "ai-badger calls pi" is
not a novel mechanism — there is shipped code that spawns pi to do bounded work and parse its
JSONL answer back out.

**Evidence:** `extensions/mem-based-rag/index.ts:183-200` (`askPiInvocation`), `:1068-1100`
(child argv and spawn), `:93` (`ASK_CHILD_TIMEOUT_MS = 90000`).

### F7 — ai-badger's pi adapter already sits on the very seam the extension uses. [READ]

The adapter registers `before_agent_start`, and its bridge maps that event to Claude's
`UserPromptSubmit` spelling so one set of hook scripts serves both. Delivery seams are named
explicitly as `before_agent_start` and `session_shutdown`.

This is the strongest structural argument that tiers 2 and 3 have a landing site: the hook
slot mem-based-rag would occupy is already wired on both sides.

**Evidence:** `~/RiderProjects/ai-badger/features/pi/adjustments/adapter/index.ts:729`
(`pi.on("before_agent_start", ...)`), `:578-748` (the full event set);
`~/RiderProjects/ai-badger/features/pi/adjustments/adapter/hook-bridge.ts:312-327`
(`PiDeliveryEvent`, `PI_DELIVERY_EVENT_MAP`).

### F8 — But that seam carries a plain string; the extension's output is a typed custom message with structured details and a TUI card. [READ]

The bridge's whole advice surface is `additionalContext?: string` plus a `systemMessage` line —
the latter documented as *"for the user, never for the model"* — and post-hook context is
explicitly advisory, appended to the tool result. The extension instead returns
`{ message: { customType, content, display: true, details } }`, with `details` carrying parallel
`memDisplay` / `codeDisplay` arrays that the renderer uses to show cwd-relative paths and rounded
ranks while the model still sees absolute paths.

This is the real cost of tiers 2 and 3, and it is a presentation cost rather than a retrieval
one. A shared core can reproduce the *block* byte-for-byte; it cannot reproduce the *card*,
because there is no channel for the structured `details` an ai-badger hook could use.

**Evidence:** `~/RiderProjects/ai-badger/features/pi/adjustments/adapter/hook-bridge.ts:58`,
`:64`, `:640-643`; versus `extensions/mem-based-rag/index.ts:845-856` and `:1184-1185`
(`toCardLines(body, details?.memDisplay, details?.codeDisplay)`).

### F9 — A guard in this repo blocks the bash tool from spawning pi at all. [MEASURED]

`extensions/subagent/delegation-skip-guard.ts` refuses a bash `tool_call` whose command spawns
`pi`, returning `spawning pi directly is blocked — use \`delegate\` instead`. It is deliberately
absolutist — the source states *"there is intentionally no env kill switch"*.

For tier 1 this is a direct constraint on how "ai-badger calls pi" may be delivered: if the
delivery is an ai-badger *skill* that instructs the agent to run a command, that command is a
`tool_call` and is refused.

**Evidence:** Ran `echo "(pi wiring word)" > /tmp/guard-c.txt` in this project's bash tool;
output was `ai-badger: spawning pi directly is blocked — use \`delegate\` instead`, exit was not
a shell result. Source: `extensions/subagent/delegation-skip-guard.ts:25-27`, `:38-42`;
`docs/reference/extension-catalog.md:171-182`.

### F10 — That guard matches raw command text, so quoted strings and prose trip it; wrappers are documented as a silent gap. [MEASURED]

Nothing was spawned by `echo "(pi wiring word)"`. Three of my own read-only commands were
refused during this research, none of which spawned anything: a `printf` whose format string
contained `(pi wiring)`, and an `echo "=== ... model in pi ==="` where the English word `in`
acted as the regex's keyword separator. The predicate is command-position `pi` with
`(|;|&|{newline}|{}` `` `!` `` or keyword separators and no word-boundary check on the string's
quoting.

The same source records the opposite failure: *"Spawning through wrappers (`sh -c`, `pnpm dlx`)
is a known silent gap."* So the guard is simultaneously over- and under-broad. It is friction on
tier 1 and it is a reason to prefer tiers 2 and 3, where no `pi` spawn is ever needed.

**Evidence:** Reproduction is `echo "(pi wiring word)"` in this project. Source:
`extensions/subagent/delegation-skip-guard.ts:38-52` (`PI_SPAWN_COMMAND`,
`PI_INVOCATION_ARGS_GLOBAL`, case-sensitivity note) and `docs/reference/extension-catalog.md:181-182`.

### F11 — A hook-side shell-out to the shared core would cost 6–103 ms per turn depending on runtime. [MEASURED]

Cold spawn of an empty program, 20 runs each: `bun` 6.2 / 6.9 / 24.3 ms, `python3` 17.9 / 18.9 /
37.3 ms, `node` 81.3 / 85.0 / 102.7 ms (min / median / max). Spread is recorded rather than a
single figure because the tail is the risk for a per-turn hook.

Against the search itself this is small: the extension documents steady searches at ~0.4–0.5 s
and amortised spawn at ~0.3 s, so a 7 ms bun call is noise and even node's 85 ms is under a
quarter of one search. The figure is still decisive between tier-3 variants — `node` makes a
per-turn shell-out unattractive and `bun` makes it acceptable.

**Evidence:** `subprocess.run(argv)` timed with `time.perf_counter()`, 20 iterations each, of
`["python3","-c","pass"]`, `["node","-e","0"]`, `["bun","-e","0"]`. Machine: Darwin arm64,
Apple M4. Note these are empty-program starts — a real CLI would add module load.

### F12 — ai-badger is Python-first, so a TypeScript canonical core adds a runtime its consumers do not otherwise need. [READ]

Under `features/` there are 143 Python files and 12 TypeScript files once `node_modules` is
excluded. The 12 TypeScript files are pi's adapter and its tests. Every hook script ai-badger
delivers is Python and describes itself as *"Standalone, stdlib-only."*

**Evidence:** `find features -name '*.py' | wc -l` → 143;
`find features -name '*.ts' -not -path '*/node_modules/*' | wc -l` → 12 (listed: the 4
`features/pi/adjustments/adapter/` files and 8 `features/pi/tests/` files). Stdlib-only claim:
`.ai-badger/skills/mcp-index/scripts/context_enrichment_hook.py:5`.

### F13 — This codebase's established idiom for sharing logic without runtime coupling is copy-with-test-pinned-parity. [READ]

`ASK_CHILD_EXCLUDED_TOOLS` is documented as a *"Literal copy of the subagent
CHILD_EXCLUDED_TOOLS... read-only reference, NO cross-extension runtime import so the two
extensions never couple at load. Pinned equal by tests/mem-based-rag/ask.test.ts (8)."*

So when the tier-3 question is "how do two modules share one definition without importing each
other", the repo has already answered it twice over: ai-badger copies `context_enrichment.py`
beside each hook at scaffold time, and the extension copies a constant and pins equality in a
test. Neither is a third language runtime.

**Evidence:** `extensions/mem-based-rag/index.ts:83-90`;
`~/RiderProjects/ai-badger/features/common/retrieval/context_enrichment.py:9-12`.

### F14 — The extension hand-rolls its own MCP client because pi extensions cannot call MCP tools; the wire is newline-delimited JSON. [READ]

The transport is a persistent bare `ai-raccoon` child on the default proxy transport — *"thin
stdio JSON-RPC, line-delimited, forwarded to the single shared `serve` on 7721"* — spawned
lazily and reaped at session boundaries. The reader buffers stdout and parses whole lines as
JSON with `id` / `result.content[].text` shapes.

This is the one part of the extension that any tier must still reach, and it is deliberately
thin.

**Evidence:** `extensions/mem-based-rag/index.ts:8-19` (header transport note, including
*"pi extensions cannot invoke MCP tools"* and *"Do NOT pass `--transport stdio`"*), `:296-345`
(`ensureStarted`, `onData`).

### F15 — A stdlib-only Python client for that transport looks feasible. [INFERRED]

Reasoned from F14's protocol shape as I read it in `onData`: line-delimited JSON-RPC with an
integer `id`, `result.content[]` text parts, and a simple `initialize` handshake. Newline framing
plus `json` plus `subprocess` is exactly what Python's standard library covers, matching the
stdlib-only constraint F12 establishes for ai-badger hooks.

The inputs this reasons from are F12 (stdlib-only is the hook convention) and F14 (the wire
shape). I did not write such a client or run it against a live `serve`.

### F16 — End-to-end enrichment against a live ai-raccoon bank was not exercised. [UNVERIFIED]

No `memory_search` was issued, no `serve` on 7721 was confirmed running, and no enriched block
was produced through the real transport in this session. Everything above about the retrieval
*path* describes code as written.

### F17 — Whether ai-badger's pi adapter can be widened to carry a typed custom message is untested. [UNVERIFIED]

F8's fidelity gap closes only if the bridge grows a channel for `customType` + `details`. I read
the current surface as string-only but did not test whether pi's extension API would accept such
a message from the adapter, nor whether Claude/Copilot/Hermes have any equivalent of a custom
message type at all.

## Tier reading

**Tier 1 — ai-badger calls pi.** Feasible and already prototyped *inside* the extension (F6), but
it is the wrong shape for a prompt-enrichment hook: it puts a full agent spawn behind a per-turn
seam to run pure text transforms (F1, F11), and a skill-shaped delivery is actively blocked by
the delegation-skip guard (F9, F10). Where it *is* right is the parts that genuinely need pi —
`/ask`'s isolated answer — and note that F6 shows the extension already treats those as a
separate, budgeted call site.

**Tier 2 — equivalent implementation in ai-badger.** Lowest conceptual cost because the subsystem
already exists and only needs a new corpus (F4), with the hook seam already wired on pi and
Claude (F7). Its real price is drift: two implementations of one decision procedure, with the
spec currently living in 43 TS tests (F3) that a Python port would have to re-express (F13).

**Tier 3 — shared main logic.** The core is already isolated and pure (F1), already small (F2),
and already test-pinned (F3); and this repo already has two idioms for sharing without coupling
(F13). The honest reading is that "common implementation used by plugin and extension" splits
into three concrete variants — TS core called from Python (F11 makes bun cheap and node
expensive), Python core called from TypeScript, or a rules-as-data artifact read by thin
adapters — and none of them solves the card-fidelity loss in F8, which is orthogonal to where
the code lives.

The tier that F8 does *not* discriminate between 2 and 3 is the retrieval block itself; the one
that F13 does discriminate is the drift risk, which is the whole reason to prefer 3.

## Still open

- **Card fidelity, the real blocker.** Can ai-badger's pi adapter carry `customType` + `details`
  (F8/F17)? Until that is answered, tiers 2 and 3 both land a plain string and lose the TUI card
  and the relative display paths. Settled by reading pi's extension contract for `before_agent_start`
  message injection and by one spike sending a custom message from the adapter.
- **Which tier-3 variant.** The range in F11 (6 ms vs 85 ms) is only the shell-out; the deciding
  factor may be who owns the canonical copy. Settled by picking an owner and measuring one real
  hook turn end to end, including the search.
- **Copilot's injection seam is unverified.** F7 covers pi and Claude. Hermes has
  `pre_llm_inject_context` per `docs/retrieval.md` §2, but I did not confirm Copilot has any
  prompt-injection hook at all, which would decide whether "universal" can include it.
- **Protocol stability of the `ai-raccoon` proxy** (F15/F16). Settled by writing the 30-line
  Python client and running it against a live `serve`; that single test would convert F15 from
  INFERRED to MEASURED and close F16.
- **Would `/rag` and `/ask` survive the move?** A skill/hook delivery has no custom message
  types and no per-session command surface in the way the extension does. Whether `/rag status`
  and the mode override can be expressed as ai-badger state (F12 points at `badger_store`) is
  unanswered.
- **Guard friction on tier 1 is two-sided** (F10). I confirmed the over-broad side directly and
  took the under-broad side (`sh -c` wrappers) from the source's own admission; I did not test
  the wrapper gap.
