/**
 * ai-badger subagent for pi: one delegation tool over the personas ai-badger scaffolds into
 * `<cwd>/.pi/agents/*.md` (written by `features/pi/adjustments/adjust_agents.py`).
 *
 * Installed user-scope at `~/.pi/agent/extensions/subagent/index.ts`, and it reads the
 * project's agent files ITSELF through `node:fs`. That is the whole trick, and it must not be
 * "simplified" into pi's own resource loader later: project-local resources are trust-gated, and
 * pi's settings docs state that `-p`, `--mode json` and `--mode rpc` ignore project resources
 * entirely without a saved trust decision. A user-scope extension reading files with `fs` is not
 * subject to that gate, which is what makes the personas live in the headless runs ai-badger's
 * delegation map depends on.
 *
 * Delegation lifecycle (plan §2 R2/R3/R5/R6/R10): every child runs `pi -p --mode json` through
 * the P2 runner/registry, so `delegation-core.ts` parses its event stream. In a TUI the tool
 * returns immediately with a receipt and the completion rides one `delegation-result` followUp
 * message (R5); headless modes stay fully blocking (R2). Every delegation tees its raw JSONL to
 * `~/.pi/agent/subagent-logs/<runId>.jsonl` (R4) — that dir is the single source of truth for
 * restart reconstruction (R10) and run-id allocation (T73).
 *
 * Every failure is loud and degrades to a reported result — a missing agents directory, an
 * unreadable or unparseable persona, an unknown agent name, an invalid `cwd`, or a failed child.
 * Silent failure is the defect class this extension exists to end.
 *
 * Accounting consequence of a per-run timeout (RR5): a timed-out run is killed through the
 * runner's abort path, so its log ends with the run header, the tee'd stream and any stderr
 * lines but NO `exit` line. ai-badger's `pi_session_source.delegation_usage` (0.149.0) records a
 * run iff an `exit` or `agent_settled` line exists — a timed-out run is therefore NOT recorded:
 * timeout
 * behaves exactly like abort for accounting. The spent tokens remain readable in the log file
 * itself (the stdout tee is written when the child closes; real children always die to SIGKILL).
 * This is the contract, not an oversight — pinned by T105 in the tests doc's deferral section.
 *
 * Liveness (delegation-liveness plan, RR2/RR3/RR4): every run also arms an inactivity watchdog
 * beside its optional timeout, 10 minutes of stream silence by default (RUN_WATCHDOG_MS,
 * injectable via deps.runWatchdogMs, 0 = off). A child that dies without ever closing (the
 * d-28 class: pid gone, log frozen, no exit line) is killed through the normal abort path and
 * settles aborted with abortReason "lost"; its card says so plainly ("stopped responding (no
 * output for 10m00s) and was aborted"). Silent child death is the defect class this extension
 * exists to end; the watchdog turns it into a normal terminal transition instead of a run that
 * stays `running` in every surface forever. Around the watchdog: the delegations tool probes
 * the pid of every running record (alive / unknown / lost (dead pid), report-only, RR3) and,
 * when the registry is empty, reconstructs stale runs from the log dir so a dead runner
 * generation still leaves a trace (RR4). A lost run's log has no `exit` line, so it is
 * unrecorded spend for accounting, exactly like a timeout (the RR5 contract above).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  allocateRunId,
  classifyFromLogDir,
  clampRunTimeoutMs,
  formatDuration,
  formatUsage,
  FROZEN_MODEL_GROUPS,
  isUsableModelRegistry,
  pruneLogFiles,
  renderDelegationStatus,
  resolveDelegationModel,
  resolveLevel,
  RUN_TIMEOUT_MAX_MS,
  type DelegationState,
  type DelegationUsage,
  type LevelRegistry,
  type LogDirEntry,
  type LogRunFile,
  type LogRunSummary,
  type DelegationRecord,
} from "./delegation-core.ts";
import {
  DelegationRegistry,
  type DelegationReceipt,
  type DelegationTransition,
  type StartOutcome,
} from "./delegation-registry.ts";
import type { DelegationNote, DelegationProgress, SpawnFn } from "./delegation-runner.ts";
import { registerDelegationStatus } from "./delegation-status.ts";
import { DelegationResultCache } from "./result-cache.ts";
import { registerDelegationQueue, type DelegationQueueOpts } from "./delegation-queue.ts";
import { type AgentToolUpdateCallback, type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The tool the LLM calls. Also excluded from the child, so a delegation cannot re-delegate. */
export const TOOL_NAME = "delegate";

/** The plural status tool P4 registers (`delegation-status.ts`); excluded from children too. */
export const TOOL_NAME_PLURAL = "delegations";

/** `--exclude-tools` value for children (R5, FINAL): a child can neither recurse delegation
 * nor reach the queue, monitor or wait surfaces. monitor/wait land with the monitor extension;
 * the value is final now per plan v2 R5 (six pin sites migrated in the same commit). */
export const CHILD_EXCLUDED_TOOLS = `${TOOL_NAME},${TOOL_NAME_PLURAL},queue,monitor,wait`;

/** Where adjust_agents.py writes, relative to the project root. */
export const AGENTS_DIR = [".pi", "agents"];

/**
 * Where the target project keeps its model-tier registry, relative to the project root
 * (PKG-5 5a ADR: import-from-target-project — the same root `scanPersonas` reads, one
 * root predicate). Never the ai-badger repo, never a vendored copy.
 */
export const MODEL_GROUPS_FILE = [".ai-badger", "model-groups.json"];

/**
 * What `loadModelGroups` resolved: the project's registry file, or the frozen fallback
 * with the reason it degraded (absence rule — the caller surfaces `warning` via
 * ui.notify, so the degrade is loud, never silent).
 */
export interface ModelGroupsLoad {
  registry: LevelRegistry;
  /** "project" = the target project's file; "frozen" = degrade-on-stale fallback. */
  source: "project" | "frozen";
  /** Present exactly when `source` is "frozen": names the file + the rule that forced it. */
  warning?: string;
}

/**
 * Read the model-tier registry for one delegation (PKG-5 5a, impure wiring half — the
 * caller owns the project root, usually the tool context cwd). Missing, unreadable,
 * unparseable, or structurally unusable files degrade to `FROZEN_MODEL_GROUPS` with a
 * warning (router degrade-on-stale precedent) — delegation never bricks for lack of a
 * registry file. Lifecycle validation (preferred-first, price order) is PKG-1's validator;
 * this gate only refuses what the resolver cannot consume without guessing.
 */
export function loadModelGroups(
  cwd: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): ModelGroupsLoad {
  const file = join(cwd, ...MODEL_GROUPS_FILE);
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    return {
      registry: FROZEN_MODEL_GROUPS,
      source: "frozen",
      warning: `${file} could not be read (${String(error)}) — using frozen model tiers`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      registry: FROZEN_MODEL_GROUPS,
      source: "frozen",
      warning: `${file} could not be parsed as a registry (${String(error)}) — using frozen model tiers`,
    };
  }
  if (!isUsableModelRegistry(parsed)) {
    return {
      registry: FROZEN_MODEL_GROUPS,
      source: "frozen",
      warning:
        `${file} has no usable low|medium|high groups ` +
        `(each needs a non-empty list with an id-bearing first entry) — using frozen model tiers`,
    };
  }
  return { registry: parsed, source: "project" };
}

/** Output kept from the child, so one runaway subagent cannot flood the parent's context. */
export const MAX_OUTPUT_CHARS = 64 * 1024;

/** The delegation-result followUp's custom message type (R5); the renderer below draws it. */
export const RESULT_CUSTOM_TYPE = "delegation-result";

/** Answer-tail budget of the delegation-result card: the whole message content stays ≤ 8 KB (T71). */
export const NOTIFICATION_CAP_CHARS = 8 * 1024;

/** RR3: the coalesce window opened after a lead card, ms — held notes flush when it expires. */
export const BATCH_WINDOW_MS = 2000;

/** RR3: batch size cap — a capacity flush fires at this many held notes (the window stays open). */
export const BATCH_MAX_CARDS = 6;

/** RR3: separator between cards in a batched delegation-result message (content and renderer). */
export const BATCH_SEPARATOR = "\n\n———\n\n";

/** R4: the durable per-run log dir, outside every git repo. Injectable via deps for tests. */
export const DEFAULT_LOG_DIR = join(homedir(), ".pi", "agent", "subagent-logs");

/** Custom entry type of the session_start reconstruction report (R10, row 47). */
export const RECONSTRUCTION_ENTRY_TYPE = "delegation-reconstruction";

/** pi.events channel carrying the registry's serializable transition snapshots (T60). */
export const TRANSITION_CHANNEL = "delegation-transition";

/** R7: env override for the running cap (queue cap stays at the P1 default). */
export const MAX_CONCURRENT_ENV = "PI_BADGER_SUBAGENT_MAX_CONCURRENT";

/** RR1: the per-run timeout clamp lives next to the schema it serves (pure impl in the core). */
export { clampRunTimeoutMs, RUN_TIMEOUT_MAX_MS } from "./delegation-core.ts";

export interface Persona {
  name: string;
  description: string;
  /**
   * The persona's `model:` frontmatter pin, verbatim, or undefined when the file pins none.
   * It is NOT resolved here: the pin is passed through as the child's `--model`, so pi's own
   * CLI resolution (the same matcher `PI_MODEL` / `pi --model` use) maps an alias like
   * `opus` to a concrete provider/model.
   *
   * f: 2026-09-02 (owner ruling — supersedes the former LOUD-failure contract): the model
   * part is FULLY OPTIONAL — a pin must never fail a delegation. pi's alias resolution is
   * credential-blind on its fuzzy path (the d-324 class: bare `opus` resolved to
   * amazon-bedrock, which has no credentials, and the child died at the auth gate), so the
   * runner retries once on the parent model when a pin fails to START
   * (`fallbackArgsFor` + the runner's model-fallback retry) and RECORDS the fallback on the
   * result note — never silent, never fatal.
   */
  model?: string;
  /**
   * The persona's `level:` frontmatter pin (PKG-5, dual-key per G-2/G-3): routing intent
   * (`low`|`medium`|`high`), resolved at delegation time against the target project's
   * `.ai-badger/model-groups.json` preferred id (import + frozen fallback). Raw here —
   * validated at resolve time, where the override context exists (A7/S5): a deciding
   * invalid level throws naming the valid levels; a non-deciding one warns. An explicit
   * `model:` pin always wins (G-6) and the override is recorded on the result note.
   */
  level?: string;
  /** The file body below the frontmatter — appended to the child's system prompt. */
  systemPrompt: string;
  filePath: string;
}

/** What one agents directory holds: the personas that parsed, and a line per file that did not. */
export interface PersonaScan {
  personas: Persona[];
  errors: string[];
  /** Set when the directory itself is absent — a different failure from an unparseable file. */
  missingDir?: string;
  /**
   * One line per persona shadowed by an earlier file with the same `name`. pi resolves agents
   * by name, so the shadowed file is dead weight; the line exists because a silent shadow is
   * exactly the kind of thing this extension's audit trail exists to end.
   */
  duplicates?: string[];
}

type PersonaFrontmatter = { name?: unknown; description?: unknown; model?: unknown; level?: unknown };

/**
 * One persona file, or the reason it is not one.
 *
 * `parseFrontmatter` is pi's own reader, imported rather than reimplemented so this and the
 * files adjust_agents.py writes cannot drift apart over a YAML detail. `name` and `description`
 * are required because a delegation names an agent and the model picks one from descriptions.
 * `model` is optional and only taken when it is a non-empty string — any other value leaves the
 * persona without a pin rather than invalidating the file (the pin is a routing preference, not
 * part of the persona's identity). `level` loads under the same rule (PKG-5 dual-key): raw and
 * unvalidated here — resolution validates it, where the explicit-model context exists.
 */
export function parsePersona(text: string, filePath: string): Persona | { error: string } {
  const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(text);
  if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
    return { error: `${basename(filePath)} has no \`name\` in its frontmatter` };
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    return { error: `${basename(filePath)} has no \`description\` in its frontmatter` };
  }
  const model = typeof frontmatter.model === "string" && frontmatter.model.trim()
    ? frontmatter.model.trim()
    : undefined;
  const level = typeof frontmatter.level === "string" && frontmatter.level.trim()
    ? frontmatter.level.trim()
    : undefined;
  return {
    name: frontmatter.name.trim(),
    description: frontmatter.description.trim(),
    ...(model !== undefined ? { model } : {}),
    ...(level !== undefined ? { level } : {}),
    systemPrompt: body,
    filePath,
  };
}

/** Read `<cwd>/.pi/agents/*.md`. `.md` is the suffix pi's own agent discovery matches. */
export function scanPersonas(cwd: string): PersonaScan {
  const dir = join(cwd, ...AGENTS_DIR);
  if (!existsSync(dir)) {
    return { personas: [], errors: [], missingDir: dir };
  }

  const scan: PersonaScan = { personas: [], errors: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return { personas: [], errors: [`${dir} could not be read (${String(error)})`] };
  }

  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf-8");
    } catch (error) {
      scan.errors.push(`${name} could not be read (${String(error)})`);
      continue;
    }
    let parsed: Persona | { error: string };
    try {
      parsed = parsePersona(text, filePath);
    } catch (error) {
      // pi's parseFrontmatter has no internal guard: one malformed-YAML file would otherwise
      // kill the whole delegate call instead of degrading to this line.
      scan.errors.push(`${name} could not be parsed (${String(error)})`);
      continue;
    }
    if ("error" in parsed) {
      scan.errors.push(parsed.error);
      continue;
    }
    const shadowed = scan.personas.find((p) => p.name === parsed.name);
    if (shadowed) {
      scan.duplicates ??= [];
      scan.duplicates.push(
        `${parsed.name}: ${basename(filePath)} is shadowed by ${basename(shadowed.filePath)} ` +
        `and will never be delegated to`,
      );
      continue;
    }
    scan.personas.push(parsed);
  }
  return scan;
}

/** `name: description` for every persona, or "none" — what an unknown agent name is answered with. */
export function personaList(personas: Array<{ name: string; description: string }>): string {
  if (personas.length === 0) return "none";
  return personas.map((p) => `${p.name}: ${p.description}`).join("\n");
}

/**
 * The unknown-persona message — ONE builder so the delegate and queue tools answer an unknown
 * agent name byte-for-byte identically (Q-C1).
 */
function unknownPersonaMessage(agent: string, agentsDir: string, personas: Array<{ name: string; description: string }>): string {
  return `ai-badger: no persona named "${agent}" in ${agentsDir}.\nAvailable:\n${personaList(personas)}`;
}

/**
 * The argv for the delegated `pi -p` run (row 1).
 *
 * `--mode json` turns the child's stdout into the JSON event stream delegation-core parses —
 * that is what makes live progress, usage and answer extraction possible (R3). `--no-session`
 * keeps a delegation out of the session store; `--exclude-tools delegate,delegations` removes
 * both call types from the child so delegation cannot recurse; `--append-system-prompt` carries
 * the persona's body (pi appends it to the coding-assistant prompt rather than replacing it, so
 * the child keeps its tool guidance); `--` ends option parsing so a task starting with `-` is a
 * task.
 *
 * The `model` argument is the delegating session's model — the child's fallback. The persona's
 * own `model:` pin (Persona.model) takes precedence when present, and a persona `level:`
 * (PKG-5) resolves against the registry between the two: frontmatter `model:` >
 * `level:`-resolved > session model (G-6; the queue tool's group `model:` outranks both —
 * see its buildInvocation). `registry` is the loaded project registry (frozen fallback when
 * the project has none); an invalid deciding level throws naming the valid levels (L1-D3),
 * a non-deciding one is reported through `resolveDelegationModel` by the caller — this
 * argv builder stays pure and returns the argv only.
 *
 * f: 2026-09-02: the pin is best-effort, not a hard requirement — when the pinned model cannot START the child (the
 * d-324 class: pi's credential-blind alias resolution picked an unauthenticated provider),
 * the runner retries once on the parent model via `fallbackArgsFor` and records the fallback
 * on the result note. A pin therefore never fails a delegation, and the fallback is never
 * silent.
 */
export function delegationArgs(persona: Pick<Persona, "systemPrompt" | "model" | "level">, task: string, model?: string, registry: LevelRegistry = FROZEN_MODEL_GROUPS): string[] {
  const args = ["-p", "--mode", "json", "--no-session", "--exclude-tools", CHILD_EXCLUDED_TOOLS];
  const { model: resolvedModel } = resolveDelegationModel(registry, {
    frontmatterModel: persona.model,
    level: persona.level,
    sessionModel: model,
  });
  if (resolvedModel) args.push("--model", resolvedModel);
  if (persona.systemPrompt.trim()) args.push("--append-system-prompt", persona.systemPrompt);
  args.push("--", task);
  return args;
}

/**
 * The model-pin fallback argv (f: 2026-09-02), derived FROM the primary argv — one argv
 * builder, no drift. Returns undefined when there is nothing to fall back FROM: the persona
 * pins no model (the primary argv already runs the parent model), or the pinned value is not
 * the argv's `--model` value (defensive — the tool layer is the only argv builder). With a
 * parent model the pin value is swapped; without one the `--model` pair is dropped and the
 * child picks its own default. Pure: the primary argv is never mutated.
 *
 * PKG-5: a persona `level:` arms the same retry for its level-resolved pin (L1-D4) — the
 * `--model` value is verified against the registry resolution, so a foreign argv never
 * arms a fallback. An undecidable level (invalid with no explicit model — the argv build
 * already threw for the deciding case) yields no fallback instead of throwing.
 */
export function fallbackArgsFor(
  args: string[],
  persona: Pick<Persona, "model" | "level">,
  model: string | undefined,
  registry: LevelRegistry = FROZEN_MODEL_GROUPS,
): string[] | undefined {
  let pin: string | undefined;
  if (persona.model) {
    pin = persona.model;
  } else if (persona.level) {
    let expected: string | undefined;
    try {
      expected = resolveLevel(registry, { level: persona.level }).model;
    } catch {
      return undefined;
    }
    const index = args.indexOf("--model");
    const actual = index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
    pin = actual === expected ? actual : undefined;
  } else {
    return undefined;
  }
  const index = args.indexOf("--model");
  if (index < 0 || index + 1 >= args.length || args[index + 1] !== pin) return undefined;
  const fallback = [...args];
  if (model) fallback[index + 1] = model;
  else fallback.splice(index, 2);
  return fallback;
}

/**
 * How to re-invoke pi for the child process.
 *
 * Re-running this process's own script keeps the child on the same pi build; the `pi` on PATH is
 * the fallback when pi runs from a compiled binary whose script path is virtual.
 */
export function piInvocation(
  args: string[],
  proc: { argv: string[]; execPath: string } = process,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  const script = proc.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && exists(script)) {
    return { command: proc.execPath, args: [script, ...args] };
  }
  if (!/^(node|bun)(\.exe)?$/.test(basename(proc.execPath).toLowerCase())) {
    return { command: proc.execPath, args };
  }
  return { command: "pi", args };
}

/** Keep the last `MAX_OUTPUT_CHARS` characters of a child's output; the tail is the answer. */
export function capOutput(text: string, limit: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `[...${text.length - limit} earlier characters dropped]\n${text.slice(-limit)}`;
}

// ------------------------------------------------------------------ lifecycle wiring (R5/R8/R10)

/** Injectable seams for tests: everything else is wired from pi and the environment. */
export interface SubagentDeps {
  /** Defaults to the real `node:child_process` spawn via the P2 runner. */
  spawnFn?: SpawnFn;
  /** R4 log dir override (tests). Default `~/.pi/agent/subagent-logs`. */
  logDir?: string;
  /** Injected clock for records and rendering. */
  now?: () => number;
  /** SIGTERM → SIGKILL grace for the session_shutdown kill path (R8). Default 5000. */
  escalateAfterMs?: number;
  /** R7 running cap override; default reads `PI_BADGER_SUBAGENT_MAX_CONCURRENT`, then 4. */
  cap?: number;
  /** R7 queue cap override; default 16. */
  queueCap?: number;
  /** RR3 batching window override, ms (tests). Default 2000. 0 is legal: same-tick arrivals
   * still batch, because the window timer is a macrotask. */
  batchWindowMs?: number;
  /** RR3 batch size cap override (tests). Default 6. */
  batchMaxCards?: number;
  /** RR2: per-run liveness watchdog, ms of child silence. Default 600_000 (10 min); 0 = off. */
  runWatchdogMs?: number;
}

/** Receipt details (row 45, §4): the background tool result's `details`. */
export interface ReceiptDetails {
  id: string;
  agent: string;
  state: DelegationState;
  queuePosition?: number;
  toolCallId: string;
  logFile?: string;
  /** PKG-5: the G-6 explicit-wins sentence, when an explicit model overrode a valid level. */
  levelOverride?: string;
}

/** Blocking result details: today's shape (rows 2–7 oracle) + `usage` + optional `degraded`. */
export interface BlockingDetails {
  agent: string;
  exitCode: number | null;
  agentsDir: string;
  errors: string[];
  usage?: DelegationUsage;
  /** Set when an explicit `background:true` degraded to full blocking outside tui (T67). */
  degraded?: boolean;
  /** PKG-5: the G-6 explicit-wins sentence, when an explicit model overrode a valid level. */
  levelOverride?: string;
}

/** B-A1 rejection details (R1): an explicit `background:false` in the TUI, where blocking no
 * longer exists. Nothing was spawned and nothing was enqueued. */
export interface BlockingRemovedDetails {
  reason: "blocking-removed";
  agent: string;
}

function envCap(): number | undefined {
  const raw = process.env[MAX_CONCURRENT_ENV];
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The extension version from this directory's package.json (RR1/R0): the session_start log
 * line carries it, so a stale loaded instance generation identifies itself in its own output.
 */
function extensionVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * A completion note carrying the G-6 explicit-wins record (PKG-5 acceptance 3):
 * `levelOverride` is the sentence for a valid level beaten by an explicit model
 * (`explicit model "X" overrode level "low"`), merged onto the runner's note at deliverNote
 * and rendered on the card verdict — the modelFallback pattern, never silent.
 */
export type DelegationNoteWithLevel = DelegationNote & { levelOverride?: string };

/**
 * The completion verdict line of a delegation-result card (R5). State-driven: completed with a
 * non-zero exit renders "exited N"; the silent-JSON variant names itself loudly (R3/CR4).
 * f: 2026-09-02: a model-pin fallback appends its recorded reason — the card says the pin was
 * rejected and what the run retried on, so the fallback is never silent.
 * PKG-5: a G-6 explicit-model-over-level override appends its recorded sentence the same way.
 */
export function notificationVerdict(note: DelegationNoteWithLevel): string {
  const verdict = notificationStateVerdict(note);
  const withFallback = note.modelFallback !== undefined ? `${verdict} ${note.modelFallback}.` : verdict;
  return note.levelOverride !== undefined ? `${withFallback} ${note.levelOverride}.` : withFallback;
}

function notificationStateVerdict(note: DelegationNote): string {
  const duration = note.durationMs !== undefined ? ` in ${formatDuration(note.durationMs)}` : "";
  switch (note.state) {
    case "aborted":
      // RR2: the timeout verdict names the applied LIMIT, never the elapsed runtime —
      // durationMs counts from the request, so it includes queue wait.
      if (note.abortReason === "timeout") {
        return `Delegation ${note.id} (${note.agent}) timed out (limit ${formatDuration(note.timeoutMs ?? 0)}) and was aborted.`;
      }
      // RR2: the watchdog-lost verdict likewise names the configured silence threshold.
      if (note.abortReason === "lost") {
        return `Delegation ${note.id} (${note.agent}) stopped responding (no output for ${formatDuration(note.watchdogMs ?? 0)}) and was aborted.`;
      }
      return `Delegation ${note.id} (${note.agent}) aborted${duration}.`;
    case "failed":
      return `Delegation ${note.id} (${note.agent}) failed to start${duration}: ${note.spawnError ?? "unknown error"}.`;
    default:
      if (note.silentReason) {
        return `Delegation ${note.id} (${note.agent}) finished without an answer${duration} — ${note.silentReason}`;
      }
      if (note.exitCode != null && note.exitCode !== 0) {
        return `Delegation ${note.id} (${note.agent}) exited ${note.exitCode}${duration}.`;
      }
      return `Delegation ${note.id} (${note.agent}) completed${duration}.`;
  }
}

/**
 * Cap `text` into a budget: what remains of `NOTIFICATION_CAP_CHARS` after `used` characters.
 * Truncation keeps the TAIL (the answer lives at the end) and marks the drop capTail-style, so
 * marker + tail together fit the room exactly and the whole card stays ≤ 8 KB (T71).
 */
/**
 * The one card-tone classification (T99): failed, or completed with a non-zero exit ("exited N"),
 * renders error; aborted renders warning; everything else success. Shared by the single-card
 * and batched renderer branches so the two paths can never drift.
 */
function cardTone(note: DelegationNote | undefined): "error" | "warning" | "success" {
  if (note?.state === "failed" || (note?.state === "completed" && (note.exitCode ?? 0) !== 0)) return "error";
  if (note?.state === "aborted") return "warning";
  return "success";
}

/**
 * Cap `text` into a budget: what remains of `budget` after `used` characters (default: the
 * whole-card NOTIFICATION_CAP_CHARS). Truncation keeps the TAIL (the answer lives at the end)
 * and marks the drop capTail-style, so marker + tail together fit the room exactly and the
 * whole card stays ≤ budget (T71; the batch path passes per-card budgets, T95).
 */
function capIntoBudget(text: string, used: number, budget: number = NOTIFICATION_CAP_CHARS): string {
  const room = budget - used;
  if (text.length <= room) return text;
  const marker = (dropped: number) => `[...${dropped} earlier characters dropped]\n`;
  let tailLength = room - marker(text.length).length;
  if (tailLength <= 0) {
    // Budget-honest degenerate fallback (review SHOULD-1): never append beyond the caller's
    // remaining room — a fixed string here overran batched messages past the 8 KB cap (T106).
    if (room <= 0) return "";
    return `(over the ${Math.max(1, Math.floor(budget / 1024))} KB card budget — see the run log)`.slice(0, room);
  }
  let head = marker(text.length - tailLength);
  if (head.length + tailLength > room) {
    tailLength = room - head.length;
    head = marker(text.length - tailLength);
  }
  return head + text.slice(-tailLength);
}

/**
 * The delegation-result card body (R5): verdict line, usage + log path meta line, then the
 * answer tail capped so the WHOLE content stays ≤ NOTIFICATION_CAP_CHARS (T71).
 */
export function notificationContent(
  note: DelegationNote,
  budget: number = NOTIFICATION_CAP_CHARS,
  contextWindow?: number,
): string {
  const lines: string[] = [notificationVerdict(note)];
  const meta: string[] = [];
  const usage = formatUsage(note.usage, contextWindow);
  if (usage) meta.push(usage);
  if (note.logFile) meta.push(note.logFile);
  if (meta.length > 0) lines.push(meta.join(" — "));

  let used = lines.join("\n").length;
  const answer = note.answer.trim();
  if (answer) {
    const capped = capIntoBudget(answer, used + 2, budget);
    if (capped) {
      lines.push("", capped);
      used = lines.join("\n").length;
    }
  }
  const stderr = note.stderrTail?.trim();
  if (stderr) {
    const capped = capIntoBudget(`stderr: ${stderr}`, used + 2, budget);
    if (capped) lines.push("", capped); // empty cap = no room — pushing it would add a trailing newline past the budget
  }
  return lines.join("\n");
}

/**
 * The batched message body (RR3): per-card contents joined by BATCH_SEPARATOR, each card capped
 * to floor((NOTIFICATION_CAP_CHARS - (n-1) * separator) / n) so the WHOLE message stays ≤ 8 KB
 * (T71/T95) for any n within the BATCH_MAX_CARDS count cap.
 */
export function composeBatchContent(notes: DelegationNote[], budget?: number, contextWindow?: number): string {
  const n = notes.length;
  const perCard = budget ?? Math.floor((NOTIFICATION_CAP_CHARS - (n - 1) * BATCH_SEPARATOR.length) / n);
  return notes.map((note) => notificationContent(note, perCard, contextWindow)).join(BATCH_SEPARATOR);
}

// ------------------------------------------------------------------ log dir (R4/R10)

function readLogLines(file: string): string[] {
  try {
    return readFileSync(file, "utf-8").split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return []; // unreadable log: classifyFromLogDir marks the run lost (a partial write is lost, not hidden)
  }
}

/**
 * R10 reconstruction, pure-decision side: prune (plan from P1, unlinks performed here — the
 * caller of a pure function owns the side effects), then classify the surviving logs with P1's
 * classifier and a kill(pid,0)-style probe. Reconstruction never spawns, never notifies (T47).
 */
export function reconstructFromLogDir(
  logDir: string,
  now: number,
  opts?: { prune?: boolean },
): LogRunSummary[] {
  let entries: LogDirEntry[];
  try {
    entries = readdirSync(logDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, mtimeMs: statSync(join(logDir, name)).mtimeMs }));
  } catch {
    return []; // no log dir yet — nothing to reconstruct
  }

  // d-52 SHOULD-1: a report-shaped query must not retire evidence logs. Pruning is the
  // caller's policy (session_start); the delegations stale query classifies prune-free.
  let kept: LogDirEntry[] = entries;
  if (opts?.prune !== false) {
    const plan = pruneLogFiles(entries, now);
    for (const name of plan.delete) {
      try {
        rmSync(join(logDir, name));
      } catch {
        // an unlink failure leaves the file; classification below still reads it
      }
    }
    kept = entries.filter((entry) => !plan.delete.includes(entry.name));
  }

  const mtimes = new Map(kept.map((entry) => [entry.name, entry.mtimeMs]));
  const files: LogRunFile[] = kept.map((entry) => ({
    id: entry.name.replace(/\.jsonl$/, ""),
    lines: readLogLines(join(logDir, entry.name)),
    mtimeMs: mtimes.get(entry.name), // RR4: staleness needs the file's mtime — a frozen log is the evidence
  }));
  return classifyFromLogDir(files, pidAlive, { now }).map((summary) => ({
    ...summary,
    logFile: join(logDir, `${summary.id}.jsonl`),
  }));
}

/** kill(pid, 0) probe: EPERM means the process exists but is not ours — still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ------------------------------------------------------------------ tool schemas and results

const DelegateParams = Type.Object({
  agent: Type.String({ description: "Name of the ai-badger persona to delegate to" }),
  task: Type.String({ description: "The task, stated so the persona can act on it alone" }),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Compatibility only. In the TUI delegation is always background: an explicit background:false is rejected at execution time (reason 'blocking-removed') — use the queue tool for ordered work or the monitor extension's wait tool (user input interrupts it) to spend idle time until results land. Outside the TUI an explicit background:true degrades to full blocking (details.degraded); headless modes block by default.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Optional per-run timeout in ms. The clock starts when the child spawns — queue wait does not count. Values are clamped: below 1 s raised to 1000 ms, above 24 h capped at 86400000 ms; 0 or omitted means no timeout. On expiry the run is aborted through the normal kill path (SIGTERM, then SIGKILL if the child ignores it) and settles as aborted with abortReason 'timeout'; the result surfaces say 'timed out (limit …)'.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Absolute working directory for the delegated child. Personas are still read from this project's .pi/agents. Validated with stat; must be an existing directory.",
    }),
  ),
});

/** The one content shape tool results return. */
function text(body: string) {
  return [{ type: "text" as const, text: body }];
}

interface DelegateToolContext {
  cwd: string;
  mode: string;
  model?: { provider: string; id: string } | undefined;
  signal?: AbortSignal | undefined;
  sessionManager?: { getSessionId(): string };
  ui: { notify(message: string, level?: string): void };
}

/** T74 (review CR13): `cwd` must be an absolute, statable directory — the failure reason otherwise. */
function validateChildCwd(cwd: string): string | undefined {
  if (!isAbsolute(cwd)) return "it must be an absolute path";
  try {
    if (!statSync(cwd).isDirectory()) return "it is not a directory";
  } catch (error) {
    return `it could not be accessed (${String(error)})`;
  }
  return undefined;
}

export default function (pi: ExtensionAPI, deps: SubagentDeps = {}) {
  if (typeof pi?.registerTool !== "function") {
    console.error(
      "ai-badger: pi.registerTool is not a function — this pi build's extension API has moved; the delegation tool is not installed.",
    );
    return;
  }

  const logDir = deps.logDir ?? DEFAULT_LOG_DIR;
  const now = deps.now ?? Date.now;
  const batchWindowMs = deps.batchWindowMs ?? BATCH_WINDOW_MS;
  const batchMaxCards = deps.batchMaxCards ?? BATCH_MAX_CARDS;

  /** Notes and per-run progress subscribers key by run id. Notes: the blocking path reads the
   * run's note (answer/stderr tails) after awaiting `done`; capped, because background runs
   * never consume theirs. Progress: the registry-level onUpdate routes to the one blocking
   * execute subscribed to that run id (the widget in P4 polls the registry instead); the
   * latest-progress buffer replays anything that fired between start and subscribe.
   */
  const notes = new Map<string, DelegationNoteWithLevel>();
  /**
   * G-6 explicit-wins record, run id → override sentence (PKG-5 acceptance 3). Remembered
   * at start (the tool layer knows the resolution then) and merged onto the runner's note
   * at deliverNote — the modelFallback pattern. Capped like notes; entries are consumed
   * exactly once, at delivery.
   */
  const levelOverrides = new Map<string, string>();
  /** Remember one run's G-6 override sentence for deliverNote (capped — same discipline as notes). */
  function rememberLevelOverride(id: string, sentence: string): void {
    levelOverrides.set(id, sentence);
    if (levelOverrides.size > 64) {
      const oldest = levelOverrides.keys().next().value;
      if (oldest !== undefined) levelOverrides.delete(oldest);
    }
  }
  /** Run ids this session has already handed out — group batches allocate all member ids
   * before any of them registers, so the allocator needs its own memory (★M3). */
  const allocatedIds = new Set<string>();
  const latestProgress = new Map<string, DelegationProgress>();
  const progressSubscribers = new Map<string, (progress: DelegationProgress) => void>();
  /** RR3: notes held inside an open batch window; each is delivered exactly once (T97). */
  let heldNotes: DelegationNote[] = [];
  let batchWindowTimer: ReturnType<typeof setTimeout> | undefined;

  const closeBatchWindow = (): void => {
    if (batchWindowTimer !== undefined) {
      clearTimeout(batchWindowTimer);
      batchWindowTimer = undefined;
    }
  };

  /** One followUp for 1..n cards: a single card is the v1 shape byte-identical (T92); 2+ cards render as one batched message with per-card notes in details (RR3). Empty input sends
   * nothing — a window expiry over an empty buffer is a no-op, never an empty batch (T98).
   * f: 2026-09-02 (option c): each card also carries its structured result — the SINGLE shape
   * on `details.result`, the batched shape on `details.notes[i].result` — read back from the
   * result cache (never re-built, so a card's entry is byte-identical to the cached one).
   * This function never puts: the cache was filled at each note's deliverNote entry. */
  const sendCards = (cards: DelegationNote[]): void => {
    if (cards.length === 0) return;
    if (cards.length === 1) {
      const note = cards[0]!;
      const entry = resultCache.byId(note.id);
      pi.sendMessage(
        { customType: RESULT_CUSTOM_TYPE, content: notificationContent(note, undefined, statusApi.contextWindow()), display: true, details: { ...note, ...(entry ? { result: { ...entry } } : {}) } },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }
    pi.sendMessage(
      {
        customType: RESULT_CUSTOM_TYPE,
        content: composeBatchContent(cards, undefined, statusApi.contextWindow()),
        display: true,
        details: { batched: true, notes: cards.map((card) => {
          const entry = resultCache.byId(card.id);
          return { ...card, ...(entry ? { result: { ...entry } } : {}) };
        }) },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushHeldNotes = (): void => {
    const cards = heldNotes;
    heldNotes = [];
    sendCards(cards);
  };

  /** R5's single notification wire: exactly one followUp per terminal transition (row 38: the
   * registry drops notifications after shutdown, so this is never called for those). Batching
   * (RR3/RR6) sits BELOW that wire: the lead card of a quiet period is delivered immediately
   * (zero added latency, T92); notes arriving while the window is open are held and flush when
   * the window expires or the batch reaches BATCH_MAX_CARDS, whichever comes first — a capacity
   * flush does not close the window (T96). Each note is delivered exactly once, as the lead or
   * inside exactly one batch (T97); T70's double-close pin is upstream and unaffected. */
  const deliverNote = (note: DelegationNote): void => {
    const levelOverride = levelOverrides.get(note.id);
    if (levelOverride !== undefined) levelOverrides.delete(note.id);
    const enriched: DelegationNoteWithLevel =
      levelOverride !== undefined ? { ...note, levelOverride } : note;
    notes.set(note.id, enriched);
    if (notes.size > 64) {
      const oldest = notes.keys().next().value;
      if (oldest !== undefined) notes.delete(oldest);
    }
    // f: 2026-09-02 (option c): the structured result is cached at the delivery ENTRY, before
    // the batch-window branch — a note held inside an open window is already queryable via
    // `delegations results`, and a sendMessage failure still leaves the result cached.
    // flushHeldNotes/sendCards never put; they only read the cache back onto the cards.
    resultCache.put(enriched, { now });
    if (batchWindowTimer === undefined) {
      sendCards([enriched]);
      batchWindowTimer = setTimeout(() => {
        batchWindowTimer = undefined;
        flushHeldNotes();
      }, batchWindowMs);
    } else {
      heldNotes.push(enriched);
      if (heldNotes.length >= batchMaxCards) flushHeldNotes();
    }
  };

  /** R4's per-run log sink factory: `~/.pi/agent/subagent-logs/<runId>.jsonl`, dir 0o700, file 0o600. */
  const logSink = (init: { id: string; agent: string; task: string }) => {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const file = join(logDir, `${init.id}.jsonl`);
    return {
      logFile: file,
      appendLine: (line: string) => {
        appendFileSync(file, `${line}\n`, { mode: 0o600 });
      },
    };
  };

  const registry = new DelegationRegistry({
    ...(deps.cap !== undefined ? { cap: deps.cap } : {}),
    ...(deps.queueCap !== undefined ? { queueCap: deps.queueCap } : {}),
    ...(deps.escalateAfterMs !== undefined ? { escalateAfterMs: deps.escalateAfterMs } : {}),
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    ...(deps.now ? { now } : {}),
    ...(deps.runWatchdogMs !== undefined ? { runWatchdogMs: deps.runWatchdogMs } : {}),
    logSink,
    notifyComplete: deliverNote,
    onUpdate: (progress) => {
      latestProgress.set(progress.id, progress);
      if (latestProgress.size > 64) {
        const oldest = latestProgress.keys().next().value;
        if (oldest !== undefined) latestProgress.delete(oldest);
      }
      progressSubscribers.get(progress.id)?.(progress);
    },
    ...(typeof pi.events?.emit === "function"
      ? { emit: (transition: DelegationTransition) => pi.events.emit(TRANSITION_CHANNEL, transition) }
      : {}),
    // T73: ids allocate over the LIVE log dir listing, past the highest id ever seen — a
    // restarted session never reuses an id, so `delegations log d-N` stays unambiguous. The
    // closure also excludes the registry's live records: a queued run has no log file yet, so
    // without that check, concurrent queueing (a 7-panel burst) would allocate the same id
    // twice — exposed by T95–T97 and fixed here, not in the frozen core allocator.
    // enqueueGroup (plan v2 R4) allocates a whole batch BEFORE any member registers, so the
    // closure additionally remembers every id it has handed out this session — consecutive
    // calls in one batch must be distinct (★M3), which neither the log dir nor the live
    // records can guarantee yet.
    allocateId: (): string => {
      const live: Set<string> = new Set(registry.list().map((record: DelegationRecord) => record.id));
      const id = allocateRunId(
        (() => {
          try {
            return readdirSync(logDir).filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/\.jsonl$/, ""));
          } catch {
            return [];
          }
        })(),
        (candidate) => existsSync(join(logDir, `${candidate}.jsonl`)) || live.has(candidate) || allocatedIds.has(candidate),
      );
      allocatedIds.add(id);
      return id;
    },
  });

  pi.on("session_start", () => {
    // RR1/R0: the instance identifies itself at startup, so a stale loaded extension
    // generation is diagnosable from its own output when the registry disagrees with reality.
    console.error(`ai-badger subagent extension v${extensionVersion()}: session started — delegation registry live`);
    const summaries = reconstructFromLogDir(logDir, now());
    if (summaries.length === 0) return;
    // Row 47: reconstruction only MARKS runs (status surfaces show them); it never notifies
    // (R10: no auto-followUp after restart). The entry is the report; P4's surfaces may read it.
    const rendered = renderDelegationStatus(
      summaries.map((summary) => ({
        id: summary.id,
        agent: summary.agent ?? "?",
        state: summary.state,
        ...(summary.startedAt !== undefined ? { startedAt: summary.startedAt } : {}),
        ...(summary.exitCode !== undefined ? { exitCode: summary.exitCode } : {}),
        ...(summary.spawnError !== undefined ? { spawnError: summary.spawnError } : {}),
      })),
      now(),
    );
    pi.appendEntry(RECONSTRUCTION_ENTRY_TYPE, { runs: summaries, rendered });
  });

  /** f: 2026-09-02 (option c): the in-memory result cache — ring of the LAST 8 structured
   * results, dual-indexed by delegation_id and parent_id. Filled at deliverNote's entry; read
   * by the cards (details.result) and by the delegations tool's `results` action through the
   * status seam below. In-memory only: it dies with the session. */
  const resultCache = new DelegationResultCache();

  // R8: session_shutdown = SIGTERM → grace → SIGKILL via the registry, which also drops every
  // notification from here on (row 38) and empties the records. The held batch rides out FIRST
  // — those notes were accepted through the wire before the shutdown (T98/T104). Delegations do
  // not outlive the session; the runtime teardown re-runs this factory with a fresh registry.
  pi.on("session_shutdown", () => {
    closeBatchWindow();
    flushHeldNotes();
    registry.shutdown();
  });

  // W3 merge wiring (plan §5 interface freeze): the delegations tool, the /delegations command
  // and the background-run widget are P4's delegation-status.ts, wired here against its
  // frozen signature — the one instance of the registry this session constructed. RR4: the
  // status surface consults the log dir through the same reconstruction session_start uses,
  // so an empty registry still surfaces stale runs (the net that survives a dead runner).
  const statusApi = registerDelegationStatus(pi, registry, { staleRuns: () => reconstructFromLogDir(logDir, now(), { prune: false }), resultCache });

  // Plan v2 R4: the `queue` tool (delegation-queue.ts) rides the SAME registry instance. Its
  // opts extract everything it shares with the delegate tool — the persona scan, the
  // byte-identical unknown-persona message, cwd validation and the argv builder — so the new
  // module never imports this one (no cycle).
  const queueOpts: DelegationQueueOpts = {
    scanPersonas: (cwd) => scanPersonas(cwd),
    agentsDirFor: (cwd) => join(cwd, ...AGENTS_DIR),
    unknownPersonaMessage: (agent, agentsDir, personas) => unknownPersonaMessage(agent, agentsDir, personas),
    validateChildCwd,
    buildInvocation: (persona, task, model) => {
      const args = delegationArgs(persona, task, model);
      const invocation = piInvocation(args);
      return { command: invocation.command, args: invocation.args, fallbackArgs: fallbackArgsFor(invocation.args, persona, model) };
    },
  };
  registerDelegationQueue(pi, registry, queueOpts);

  // T72: the compact card the delegation-result followUp renders through in the transcript.
  // Batched messages (RR3) render as ONE box whose per-card verdict lines are styled by each
  // card's own state using the SAME classification as the single-card path (T99) — a completed
  // exitCode-1 card is error-styled, not success. A message without batch details falls back
  // to the plain body box, so unknown senders degrade safely.
  pi.registerMessageRenderer(RESULT_CUSTOM_TYPE, (message, options, theme) => {
    const body = typeof message.content === "string" ? message.content : "";
    if (!body) return undefined;
    const details = message.details as (DelegationNote & { batched?: boolean; notes?: DelegationNote[] }) | undefined;
    const box = new Box(options.outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
    if (details?.batched && Array.isArray(details.notes) && details.notes.length > 0) {
      const cardBodies = body.split(BATCH_SEPARATOR);
      // Positional-pairing guard (review NIT-2): an answer containing the separator string
      // shifts bodies across verdicts — degrade to the plain box instead of mispairing (T107).
      if (cardBodies.length === details.notes.length) {
        const blocks = details.notes.map((card, index) => {
          const lines = (cardBodies[index] ?? "").split("\n");
          const head = theme.fg(cardTone(card), lines[0] ?? "");
          return [head, ...lines.slice(1)].join("\n");
        });
        box.addChild(new Text(blocks.join(BATCH_SEPARATOR), 0, 0));
        return box;
      }
    }
    const lines = body.split("\n");
    const head = theme.fg(cardTone(details), lines[0] ?? "");
    box.addChild(new Text([head, ...lines.slice(1)].join("\n"), 0, 0));
    return box;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Delegate",
    description: [
      "Delegate a task to one of this project's ai-badger personas, each of which runs as a",
      `separate pi process with its own context. Personas live in ${AGENTS_DIR.join("/")}/*.md;`,
      "call this with an unknown agent name to get the list of available ones.",
      "In the TUI the tool returns a receipt immediately and the result arrives as a followUp",
      "message on its own — never poll for it (repeated delegations list/log is blocked). EVERY",
      "delegation enters the queue as a one-element serial group: on an idle system it starts",
      "immediately, otherwise it queues behind a blocked queue head (cap full, a mid-flight serial",
      "group, or a parallel group that cannot use a slot) — there is no other admission path; to",
      "spend idle time until results land, use the monitor extension's wait",
      "tool (user input interrupts it) or register a monitor; to stop a run, delegations abort.",
      "Headless modes still block: there the result IS the tool result. A run is unbounded unless",
      "you pass timeoutMs, which bounds the run's wall-clock time and aborts it on expiry; use",
      "the delegations tool to inspect or abort running delegations.",
    ].join(" "),
    parameters: DelegateParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const toolCtx = ctx as unknown as DelegateToolContext;
      const scan = scanPersonas(toolCtx.cwd);
      const agentsDir = scan.missingDir ?? join(toolCtx.cwd, ...AGENTS_DIR);

      if (scan.missingDir) {
        const message = `ai-badger: no personas — ${scan.missingDir} does not exist. Run welcome-ai-badger in this project to scaffold them.`;
        toolCtx.ui.notify(message, "warning");
        return {
          content: text(message),
          details: { agent: params.agent, exitCode: null, agentsDir, errors: [] } satisfies BlockingDetails,
        };
      }
      for (const error of scan.errors) {
        toolCtx.ui.notify(`ai-badger: persona skipped — ${error}`, "warning");
      }
      for (const duplicate of scan.duplicates ?? []) {
        toolCtx.ui.notify(`ai-badger: duplicate persona — ${duplicate}`, "warning");
      }

      const persona = scan.personas.find((p) => p.name === params.agent);
      if (!persona) {
        const message = unknownPersonaMessage(params.agent, agentsDir, scan.personas);
        toolCtx.ui.notify(message, "warning");
        return {
          content: text(message),
          details: { agent: params.agent, exitCode: null, agentsDir, errors: scan.errors } satisfies BlockingDetails,
        };
      }

      // T74 (R6): personas always scanned from ctx.cwd; the CHILD runs in params.cwd, which is
      // validated loudly (stat + isDirectory) before anything spawns.
      let childCwd = toolCtx.cwd;
      if (params.cwd !== undefined) {
        const problem = validateChildCwd(params.cwd);
        if (problem) {
          const message = `ai-badger: invalid cwd "${params.cwd}" — ${problem}`;
          toolCtx.ui.notify(message, "warning");
          return {
            content: text(message),
            details: { agent: persona.name, exitCode: null, agentsDir, errors: scan.errors } satisfies BlockingDetails,
          };
        }
        childCwd = params.cwd;
      }

      // R1 (plan v2): blocking was removed from the TUI — delegate always receipts and the
      // result arrives as a followUp on its own. An explicit background:false here is rejected
      // at execute time, BEFORE anything spawns or enqueues; the guidance redirects each
      // former blocking use to the tool that replaces it (B-A1).
      if (toolCtx.mode === "tui" && params.background === false) {
        const message =
          "ai-badger: blocking delegation was removed in the TUI — delegate returns a receipt immediately and the result arrives as a followUp message on its own. " +
          "To run work in a strict order, queue it with the queue tool (actions add/add-parallel). " +
          "To spend idle time until results land, use the monitor extension's wait tool (user input interrupts it) or register a monitor. " +
          "To stop a running delegation, use delegations abort <id> (or delegations abort all).";
        toolCtx.ui.notify(message, "warning");
        return {
          content: text(message),
          details: { reason: "blocking-removed", agent: persona.name } satisfies BlockingRemovedDetails,
        };
      }

      // R2: auto = background iff ctx.mode === "tui" (NOT hasUI — rpc has UI and still blocks);
      // an explicit value always wins. An explicit background:true outside tui degrades to FULL
      // blocking with the warning riding the tool result content AND details.degraded — never
      // ui.notify alone, which is a no-op in print/json. (background:false in tui never reaches
      // here — rejected above; background:false outside tui IS the blocking default.)
      const wantsBackground = params.background ?? toolCtx.mode === "tui";
      const degraded = wantsBackground && toolCtx.mode !== "tui";

      const model = toolCtx.model ? `${toolCtx.model.provider}/${toolCtx.model.id}` : undefined;
      // PKG-5: the registry belongs to the project (toolCtx.cwd — the same root personas scan
      // from), never to the child's cwd. Resolution runs twice (here for warnings + the
      // override record, inside delegationArgs for the argv) — pure and cheap, one G-6 order.
      const loaded = loadModelGroups(toolCtx.cwd);
      if (loaded.warning) toolCtx.ui.notify(`ai-badger: ${loaded.warning}`, "warning");
      const resolution = resolveDelegationModel(loaded.registry, {
        frontmatterModel: persona.model,
        level: persona.level,
        sessionModel: model,
      });
      if (resolution.levelWarning) toolCtx.ui.notify(`ai-badger: ${resolution.levelWarning}`, "warning");
      const args = delegationArgs(persona, params.task, model, loaded.registry);
      const invocation = piInvocation(args);
      const fallbackArgs = fallbackArgsFor(invocation.args, persona, model, loaded.registry);
      let sessionId: string | undefined;
      try {
        sessionId = toolCtx.sessionManager?.getSessionId();
      } catch {
        sessionId = undefined;
      }

      // f: 2026-09-02 — queue-only admission: EVERY delegation enters the ONE queue as a
      // one-element serial group through the run-now single rule (registry.start →
      // admitRequest): on an idle system it dequeues on enqueue (identical UX to the old
      // start-now path); behind a slot-blocked head — the cap is full, or a serial group is
      // mid-flight, or a parallel head cannot use the free slot — it queues its turn. There
      // is no other admission path. A fully-running group is not a queue entry and never
      // blocks (row 22 unchanged); enqueueGroup's wait-behind-any-group semantics are the
      // queue tool's explicit add/add-parallel groups, not delegate's (design pin:
      // "queue add/add-parallel keep explicit group semantics").
      const outcome = await registry.start({
        agent: persona.name,
        task: params.task,
        args: invocation.args,
        ...(fallbackArgs !== undefined ? { fallbackArgs } : {}),
        command: invocation.command,
        cwd: childCwd,
        toolCallId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        // The execute signal is the turn's own; ctx.signal is the fallback for a build that only
        // populates the context. Either one aborting kills the child rather than orphaning it.
        signal: signal ?? toolCtx.signal,
        ...(params.timeoutMs !== undefined ? { timeoutMs: clampRunTimeoutMs(params.timeoutMs) } : {}),
      });

      if (!outcome.ok) {
        // R7: admission rejection (cap and queue both full) — loud guidance, never a receipt.
        const message = `ai-badger: delegation rejected — ${outcome.reason}`;
        toolCtx.ui.notify(message, "warning");
        return {
          content: text(message),
          details: { agent: persona.name, exitCode: null, agentsDir, errors: scan.errors } satisfies BlockingDetails,
        };
      }

      // PKG-5 acceptance 3: a valid level beaten by an explicit model is recorded for the
      // result note (deliverNote merges it like modelFallback) and the receipt details.
      if (resolution.overriddenLevel !== undefined && resolution.overridingModel !== undefined) {
        rememberLevelOverride(
          outcome.id,
          `explicit model "${resolution.overridingModel}" overrode level "${resolution.overriddenLevel}"`,
        );
      }

      if (wantsBackground && !degraded) {
        return receiptResult(outcome, toolCallId);
      }
      return blockingResult(outcome, { personaName: persona.name, agentsDir, errors: scan.errors, degraded, onUpdate });
    },
  });

  // The single registry instance for this runtime — reachable for the P4 status surface, which
  // the orchestrator wires here at merge: registerDelegationStatus(pi, registry).
  return { registry };

  // ------------------------------------------------------------------ result builders

  /** Row 45 / T68 (§4): the receipt — running and queued variants, details { id, agent, state,
   * queuePosition?, toolCallId, logFile? }.
   *
   * PKG-5: when an explicit model overrode a valid level, the override sentence rides
   * details.levelOverride (read, not consumed — deliverNote consumes it at settle). */
  function receiptResult(outcome: DelegationReceipt, toolCallId: string) {
    const record = outcome.record;
    const override = levelOverrides.get(record.id);
    const tail = "the result will arrive as a followUp message when it completes.";
    const line =
      record.state === "queued"
        ? `Delegation ${record.id} queued (position ${record.queuePosition}) (${record.agent}) — ${tail}`
        : record.state === "running"
          ? `Delegation ${record.id} started (${record.agent}) — ${tail}`
          : `Delegation ${record.id} ${record.state} (${record.agent}).`;
    return {
      content: text(line),
      details: {
        id: record.id,
        agent: record.agent,
        state: record.state,
        ...(record.queuePosition !== undefined ? { queuePosition: record.queuePosition } : {}),
        toolCallId,
        ...(record.logFile !== undefined ? { logFile: record.logFile } : {}),
        ...(override !== undefined ? { levelOverride: override } : {}),
      } satisfies ReceiptDetails,
    };
  }

  /** Blocking path: await the run's done; today's result shape + details.usage (AC6). */
  async function blockingResult(
    outcome: DelegationReceipt,
    context: { personaName: string; agentsDir: string; errors: string[]; degraded: boolean; onUpdate: AgentToolUpdateCallback<unknown> | undefined },
  ) {
    const { id } = outcome;
    if (context.onUpdate) {
      const replay = latestProgress.get(id);
      if (replay) context.onUpdate({ content: text(progressLine(replay, now())), details: { ...replay } });
      progressSubscribers.set(id, (progress) => {
        context.onUpdate!({ content: text(progressLine(progress, now())), details: { ...progress } });
      });
    }
    let record: DelegationRecord;
    try {
      record = await outcome.done;
    } finally {
      progressSubscribers.delete(id);
      latestProgress.delete(id);
    }
    const note = notes.get(id);
    notes.delete(id);

    const body = blockingContent(record, note, context.personaName);
    return {
      // T67: the degrade warning rides the tool result content AND details.degraded — never
      // ui.notify alone (a no-op in print/json).
      content: text(
        context.degraded
          ? `[ai-badger] background was requested outside tui mode — running fully blocking instead.\n${body}`
          : body,
      ),
      details: {
        agent: context.personaName,
        exitCode: record.exitCode ?? null,
        agentsDir: context.agentsDir,
        errors: context.errors,
        ...(record.usage !== undefined ? { usage: record.usage } : {}),
        ...(context.degraded ? { degraded: true } : {}),
        // PKG-5: the merged note carries the G-6 override sentence when one was recorded.
        ...(note?.levelOverride !== undefined ? { levelOverride: note.levelOverride } : {}),
      } satisfies BlockingDetails,
    };
  }
}

function progressLine(progress: DelegationProgress, nowMs: number): string {
  return renderDelegationStatus([progress], nowMs) ?? `${progress.id} ${progress.agent} running`;
}

/**
 * Blocking content: today's verdict shapes (the rows 2–7 oracle's caller) fed from the note's
 * extracted answer instead of raw stdout — headless consumers get content-equivalent answers
 * (AC6) plus the R3 fallbacks: silent-JSON loud error with capped raw stdout, failure verdict
 * with the partial answer tail and stderr.
 */
function blockingContent(
  record: {
    state: DelegationState;
    exitCode?: number | null;
    spawnError?: string;
    abortReason?: "timeout" | "lost";
    timeoutMs?: number;
    watchdogMs?: number;
  },
  note: DelegationNote | undefined,
  personaName: string,
): string {
  if (record.spawnError !== undefined) {
    return `ai-badger: delegation to "${personaName}" could not run (${record.spawnError})`;
  }
  if (record.state === "aborted") {
    if (record.abortReason === "timeout") {
      return `ai-badger: delegation to "${personaName}" timed out (limit ${formatDuration(record.timeoutMs ?? 0)}) and was aborted`;
    }
    return `ai-badger: delegation to "${personaName}" was aborted before it finished`;
  }
  const exitCode = record.exitCode ?? null;
  if (exitCode !== null && exitCode !== 0) {
    const lines = [
      `ai-badger: delegation to "${personaName}" exited ${exitCode}: ${(note?.stderrTail ?? "").trim() || "(no stderr)"}`,
    ];
    const partial = note?.answer.trim();
    if (partial) lines.push("", `Partial answer before the failure:`, partial);
    return lines.join("\n");
  }
  if (note?.silentReason) {
    const lines = [`ai-badger: ${note.silentReason}`];
    const stdout = note.stdoutTail?.trim();
    if (stdout) lines.push("", `Raw child stdout (capped):`, stdout);
    return lines.join("\n");
  }
  return note?.answer.trim() || "(the delegated run printed nothing)";
}
