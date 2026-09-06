/**
 * Pure core for interactive background subagent delegation (plan §2 R11 module map).
 *
 * Everything the runner (P2), the extension wiring (P3) and the status surface (P4) need that
 * can be decided without a process, a filesystem or a clock lives here: JSON-line parsing of
 * the child's `--mode json` stream, the usage accumulator, log-dir reconstruction and
 * classification, the status renderer, the admission policy, run-id allocation, answer
 * extraction, log-dir pruning and the per-run tee byte cap.
 *
 * Purity rules (task gate, flake conventions in the tests doc):
 *   - no imports at all — in particular nothing that could start a child process;
 *   - no wall-clock reads, no ambient `process` access — elapsed time is `(now - startedAt)`
 *     with both injected;
 *   - fs-adjacent decisions take injected data: pid liveness is a predicate, the log-dir
 *     listing and mtimes are parameters. Callers own every side effect.
 *
 * The child event stream is pi's JSON event stream (`pi --mode json`, docs/json.md): a
 * `{"type":"session",…}` header line, then `agent_start`/`message_end`/`agent_end` lines. The
 * per-run log tee (written by the runner, R4) wraps that stream in two extra line types:
 * `{"type":"run",…}` first and `{"type":"exit",…}` last. That file format is a de-facto
 * cross-repo contract (ai-badger's `pi_session_source.delegation_usage` parses it) — field
 * names below are the contract, do not rename them casually.
 */

// ------------------------------------------------------------------ child events

/** One `message_end` usage block as pi's JSON stream reports it (`cost.total` is nested). */
export interface ChildUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  totalTokens?: number;
}

/** The parts of a child message this core reads; everything else passes through untouched. */
export interface ChildMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: ChildUsage;
}

/**
 * One parsed stdout line of the child. Deliberately loose: pi's event vocabulary is large and
 * moving, and every consumer here keys off `type` plus a couple of fields. Unknown-but-valid
 * event types (tool execution, stderr tee lines, tee-elision markers) parse fine and are
 * ignored by the logic that does not care about them.
 */
export interface ChildEvent {
  type: string;
  message?: ChildMessage;
  [key: string]: unknown;
}

/**
 * Parse one stdout line of the child into an event, or undefined for anything that is not a
 * JSON object with a string `type` (rows 8–10). Never throws: a child that interleaves
 * compiler noise, segfaults or half-flushed lines with its JSON stream must not kill the run.
 */
export function parseChildEvent(line: string): ChildEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  return parsed as ChildEvent;
}

// ------------------------------------------------------------------ usage accumulation

/** Totals for one delegation, across every assistant turn (same fields as pi's own example). */
export interface DelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Latest provider-reported context size (`usage.totalTokens`), not a sum. */
  contextTokens: number;
  /** Assistant turns completed. */
  turns: number;
}

/** A zeroed accumulator (rows 11–13 start from this; counters stay 0, never NaN). */
export function emptyUsage(): DelegationUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Fold one child event into the usage accumulator (rows 11–13). Only assistant `message_end`
 * events count: turns bump by one, counters sum, `contextTokens` tracks the latest
 * `totalTokens`. Events without a usage block still bump turns; non-assistant ends and every
 * non-`message_end` event touch nothing. Mutates and returns `acc` — it is an accumulator.
 */
export function applyUsage(acc: DelegationUsage, event: ChildEvent): DelegationUsage {
  const message = event.message;
  if (event.type !== "message_end" || !message || message.role !== "assistant") return acc;
  acc.turns += 1;
  const usage = message.usage;
  if (usage) {
    acc.input += usage.input || 0;
    acc.output += usage.output || 0;
    acc.cacheRead += usage.cacheRead || 0;
    acc.cacheWrite += usage.cacheWrite || 0;
    acc.cost += usage.cost?.total || 0;
    acc.contextTokens = usage.totalTokens || 0;
  }
  return acc;
}

/**
 * Live-usage floor from pi's `message_update` top-level usage (cumulative provider-reported
 * values, json.md) — per-field max into `live`, so long first turns show input/cache/cost
 * before any `message_end` lands instead of rendering `↓only` for minutes. Monotone: a
 * smaller later report never clobbers. Display-only — the settled record stays the
 * `message_end` sum (applyUsage); `turns` is never touched here.
 */
export function applyLiveUsage(live: DelegationUsage, event: ChildEvent): DelegationUsage {
  if (event.type !== "message_update") return live;
  const usage = event.usage;
  if (typeof usage !== "object" || usage === null) return live;
  const u = usage as ChildUsage;
  live.input = Math.max(live.input, u.input || 0);
  live.output = Math.max(live.output, u.output || 0);
  live.cacheRead = Math.max(live.cacheRead, u.cacheRead || 0);
  live.cacheWrite = Math.max(live.cacheWrite, u.cacheWrite || 0);
  live.cost = Math.max(live.cost, u.cost?.total || 0);
  live.contextTokens = Math.max(live.contextTokens, u.totalTokens || 0);
  return live;
}

// ------------------------------------------------------------------ lifecycle states

/**
 * Every delegation phase a UI may have to render. `lost` exists only on reconstruction from
 * the log dir (R10) — a live record never enters it; `stale` likewise exists only on
 * reconstruction (RR4): a pid-dead, terminal-line-less log whose mtime is older than the
 * threshold. `aborted` is terminal (plan §4).
 */
export type DelegationState = "queued" | "running" | "completed" | "failed" | "aborted" | "lost" | "stale";

/**
 * The registry record shape (plan §4 sketch: `sessionId` added, `aborted` terminal, `logFile`
 * absent when the sink was disabled). Structurally also a `DelegationStatusRun`, so P2/P3 can
 * render records directly. Kept additive: every field except the identity five is optional.
 */
export interface DelegationRecord {
  id: string;
  agent: string;
  task: string;
  toolCallId: string;
  sessionId?: string;
  state: DelegationState;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  usage?: DelegationUsage;
  activity?: string;
  logFile?: string;
  queuePosition?: number;
  spawnError?: string;
  /** RR2: "timeout" on a run killed by its per-run timeout, "lost" on a run killed by the
   * liveness watchdog; a user abort carries no marker. */
  abortReason?: "timeout" | "lost";
  /** The applied (clamped) per-run timeout — observable while running and at settle (T85). */
  timeoutMs?: number;
  /** RR2: the applied watchdog threshold, stamped on a lost settle — the verdict names it. */
  watchdogMs?: number;
  /** Model-pin fallback (f: 2026-09-02): present when the persona's `model:` pin failed to
   * start the child (exit 1 + model-startup stderr + no progress event) and the run retried
   * once on the fallback argv. The card names the rejection and the retry target. */
  modelFallback?: string;
}

// ------------------------------------------------------------------ per-run timeout clamp

/**
 * Upper bound of a per-run timeout: 24 h. `setTimeout` clamps delays above 2^31-1 ms to 1 ms,
 * so an uncapped "5e9 ms" request would miskill the child instantly — the cap is mandatory,
 * not cosmetic (review M1).
 */
export const RUN_TIMEOUT_MAX_MS = 86_400_000;

/** Floor of a per-run timeout: 1 s — a positive request is never a near-instant kill. */
export const RUN_TIMEOUT_MIN_MS = 1000;

/**
 * Default liveness watchdog (RR2): 10 min without a parsed stream event. Generous — thinking
 * streams continuously and long tool calls still emit events — and also the default stale
 * threshold (RR4): one number, one meaning, "how long without evidence before a run is dead".
 */
export const RUN_WATCHDOG_MS = 600_000;

/**
 * Clamp a per-run `timeoutMs` request (RR1): undefined, non-finite or ≤ 0 means "no timeout"
 * (default behavior unchanged); any positive value is raised to the 1 s floor and capped at
 * 24 h. Clamped, never rejected — the applied value is observable on the record (T85), so a
 * raised floor or capped value is never silent. Runs at the tool-schema boundary AND at the
 * runner's timer-creation site (S5: registry and direct-runner callers must not bypass it).
 */
export function clampRunTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.min(RUN_TIMEOUT_MAX_MS, Math.max(RUN_TIMEOUT_MIN_MS, timeoutMs));
}

/**
 * Resolve a per-run liveness watchdog value (RR2): undefined → the 10 min default; 0 or
 * negative → off (no timer, the test-fixture idiom); any positive value is raised to the 1 s
 * floor and capped at 24 h — the same clamp as `timeoutMs`, because the watchdog arms through
 * the same `setTimeout` whose >2^31−1 ms clamp fires in ~1 ms (M1: an uncapped injectable
 * "3e9" would instantly abort every run lost). Runs at the runner's timer-creation site (S5:
 * registry and direct-runner callers must not bypass it).
 */
export function clampRunWatchdogMs(runWatchdogMs: number | undefined): number | undefined {
  if (runWatchdogMs !== undefined && (!Number.isFinite(runWatchdogMs) || runWatchdogMs <= 0)) return undefined;
  return clampRunTimeoutMs(runWatchdogMs ?? RUN_WATCHDOG_MS);
}

// ------------------------------------------------------------------ log-dir classification

/** One run's log file as the caller read it: its id, the raw lines of `<id>.jsonl`, and the
 * file's mtime when the caller has it (RR4 staleness needs it; absent = never stale). */
export interface LogRunFile {
  id: string;
  lines: string[];
  mtimeMs?: number;
}

/**
 * What reconstruction knows about one past run (row 14: identity comes from the run header,
 * not from any session receipt — the log dir is the single source of truth, R10).
 */
export interface LogRunSummary {
  id: string;
  state: "running" | "completed" | "failed" | "lost" | "stale";
  exitCode?: number | null;
  agent?: string;
  task?: string;
  startedAt?: number;
  pid?: number;
  sessionId?: string;
  spawnError?: string;
  /** The log file the summary was reconstructed from; stamped by the reconstructing caller. */
  logFile?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Classify the log dir's runs without touching the filesystem (rows 14–17, R10 log-dir-only
 * reconstruction; RR4 adds staleness).
 *
 * Per run, in precedence order (M2: the tee writes only the header at spawn and the tail at
 * close — stderr is held in memory — so a live run's log mtime ≈ spawn time; mtime alone
 * would brand every healthy long cross-session run stale, hence the pid gates come first):
 *   - `exit` line present → `completed` (the exit code rides along, row 15) — never stale;
 *   - `spawnError` marker → `failed` (the child never ran, row 16);
 *   - header without exit, pid probe dead (or header has no pid at all) → `stale` when the
 *     file's mtime age exceeds `staleThresholdMs` (both mtime and `now` must be supplied),
 *     else `lost`;
 *   - header without exit, pid alive → `running`, NEVER stale.
 * A file whose lines hold no readable `run` header is `lost` with only its id — a partial
 * write is a run we lost, not something to hide.
 *
 * `pidAlive` is the caller's probe (kill(pid, 0), corroborated per R16) — this function only
 * decides on its answer.
 */
export function classifyFromLogDir(
  files: LogRunFile[],
  pidAlive: (pid: number) => boolean,
  opts?: { now?: number; staleThresholdMs?: number },
): LogRunSummary[] {
  const staleThresholdMs = opts?.staleThresholdMs ?? RUN_WATCHDOG_MS;
  const summaries: LogRunSummary[] = [];
  for (const file of files) {
    let header: ChildEvent | undefined;
    let exit: ChildEvent | undefined;
    let spawnError: ChildEvent | undefined;
    for (const line of file.lines) {
      const event = parseChildEvent(line);
      if (!event) continue;
      if (event.type === "run") header ??= event;
      else if (event.type === "exit") exit ??= event;
      else if (event.type === "spawnError") spawnError ??= event;
    }

    if (!header) {
      summaries.push({ id: file.id, state: "lost" });
      continue;
    }

    const base = {
      id: file.id,
      // R4 names the header field `persona`, the rows read `agent` — accept both spellings.
      agent: optionalString(header.agent) ?? optionalString(header.persona),
      task: optionalString(header.task),
      startedAt: optionalNumber(header.startedAt),
      pid: optionalNumber(header.pid),
      sessionId: optionalString(header.sessionId),
    };

    if (spawnError) {
      summaries.push({ ...base, state: "failed", spawnError: optionalString(spawnError.error) });
    } else if (exit) {
      summaries.push({ ...base, state: "completed", exitCode: typeof exit.exitCode === "number" ? exit.exitCode : null });
    } else if (base.pid === undefined || !pidAlive(base.pid)) {
      // M2 precedence: staleness is decided only among pid-dead, terminal-line-less logs.
      const mtimeMs = file.mtimeMs;
      const now = opts?.now;
      if (mtimeMs !== undefined && now !== undefined && now - mtimeMs > staleThresholdMs) {
        summaries.push({ ...base, state: "stale" });
      } else {
        summaries.push({ ...base, state: "lost" });
      }
    } else {
      summaries.push({ ...base, state: "running" });
    }
  }
  return summaries;
}

// ------------------------------------------------------------------ status rendering

/** One line of the delegation status panel: a live record or a reconstructed run summary. */
export interface DelegationStatusRun {
  id: string;
  agent: string;
  state: DelegationState;
  /** Request time (queued runs keep their request time, so start-order sorting is stable). */
  startedAt?: number;
  exitCode?: number | null;
  activity?: string;
  usage?: DelegationUsage;
  queuePosition?: number;
  spawnError?: string;
  /** RR2: "timeout" on a run killed by its per-run timeout, "lost" on a watchdog kill; a user
   * abort carries no marker. */
  abortReason?: "timeout" | "lost";
}

/** `92_000` ms → `1m32s`; sub-minute stays bare (`3s`); hours roll into `1h01m32s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${String(rest).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** One-decimal with a trailing ".0" trimmed — shared by pct and fmtTokens. */
function fmt1(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

/** Render a fraction (0–1) as e.g. "60.1%". */
function pct(fraction: number): string {
  return `${fmt1(fraction * 100)}%`;
}

/** Compact token counts: 18014 → "18k", 1500 → "1.5k", 1_250_400 → "1.3m"; < 1000 verbatim. */
function fmtTokens(n: number): string {
  if (n >= 999_950) return `${fmt1(n / 1_000_000)}m`;
  if (n >= 1000) return `${fmt1(n / 1000)}k`;
  return String(n);
}

/**
 * Compact one-line usage, same glyph order as pi's own subagent example; empty when zero.
 * `CR` is the cache-read share of prompt tokens (cacheRead / input+cacheRead+cacheWrite) as a
 * percent — a raw cached-token count said nothing about hit rate. `ctx` is the share of the
 * model's context window when `contextWindow` is known (the delegating session's model — an
 * approximation when a run overrides the model), absolute tokens otherwise.
 */
export function formatUsage(usage: DelegationUsage | undefined, contextWindow?: number): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${fmtTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${fmtTokens(usage.output)}`);
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (usage.cacheRead && promptTokens > 0) parts.push(`CR${pct(usage.cacheRead / promptTokens)}`);
  if (usage.cacheWrite) parts.push(`W${fmtTokens(usage.cacheWrite)}`);
  if (usage.contextTokens) {
    parts.push(contextWindow ? `ctx:${pct(usage.contextTokens / contextWindow)}` : `ctx:${fmtTokens(usage.contextTokens)}`);
  }
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

// ------------------------------------------------------------------ activity labels (R9)

/** Longest activity label the status surfaces render; keeps the line constant-width. */
export const MAX_ACTIVITY_LEN = 40;

/** Known tools → short present-participle verbs (the keywords the label matches on). */
const TOOL_VERBS: Record<string, string> = {
  read: "reading",
  edit: "editing",
  write: "writing",
  bash: "running",
  powershell: "running",
  grep: "searching",
  find: "searching",
  ls: "searching",
  glob: "searching",
  delegate: "delegating",
  webfetch: "fetching",
};

/** Arg keys a tool's primary target usually rides; only path-shaped targets are shown. */
const TARGET_KEYS = ["path", "file_path", "file"];

/** Trailing ellipsis is the in-progress marker; caps the whole label. */
function clampLabel(label: string): string {
  const ellipsis = "…";
  const budget = MAX_ACTIVITY_LEN - ellipsis.length;
  const body = label.length > budget ? label.slice(0, budget) : label;
  return `${body}${ellipsis}`;
}

/** Basename of a path-shaped target, itself capped, or undefined when arg-less/odd. */
function targetFromArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  for (const key of TARGET_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value !== "string" || !value.trim()) continue;
    // Path-like or nothing: a prose word ("them") must never become the label (R9 hygiene).
    if (!value.includes("/") && !value.includes(".")) continue;
    const base = value.replaceAll("\\", "/").split("/").filter(Boolean).pop();
    if (base) return base.length > 18 ? base.slice(0, 18) : base;
  }
  return undefined;
}

/**
 * One stable activity label from a live child event (R9's `currentActivity`).
 *
 * Keyword-matched, deliberately NOT the raw stream text: a text delta maps to the constant
 * `responding…`, thinking to `thinking…`, and a tool start to its verb (plus a short
 * path basename when the tool is file-shaped — `reading util.ts…`). Every label ends in
 * `…` (the in-progress marker) and fits MAX_ACTIVITY_LEN, so the status line stops
 * flickering with the child's JSON stream. Unknown event types return undefined — the
 * caller keeps the previous label. The delta content never surfaces here.
 */
export function deriveActivity(event: ChildEvent): string | undefined {
  const toolName =
    event.type === "tool_execution_start" && typeof event.toolName === "string" && event.toolName.trim()
      ? event.toolName.trim()
      : undefined;
  const ame =
    event.type === "message_update" && typeof event.assistantMessageEvent === "object" && event.assistantMessageEvent !== null
      ? (event.assistantMessageEvent as { type?: unknown; toolName?: unknown })
      : undefined;
  const callToolName =
    ame?.type === "toolcall_start" && typeof ame.toolName === "string" && ame.toolName.trim() ? ame.toolName.trim() : undefined;

  const name = toolName ?? callToolName;
  if (name) {
    const verb = TOOL_VERBS[name.toLowerCase()];
    if (!verb) return clampLabel(`using ${name}`);
    if (verb === "reading" || verb === "editing" || verb === "writing") {
      const target = targetFromArgs(event.args);
      return clampLabel(target ? `${verb} ${target}` : verb);
    }
    return clampLabel(verb);
  }
  if (ame?.type === "thinking_delta") return clampLabel("thinking");
  if (ame?.type === "text_delta") return clampLabel("responding");
  return undefined;
}

function renderRunLine(run: DelegationStatusRun, now: number, contextWindow?: number): string {
  const segments: string[] = [`${run.id} ${run.agent}`];
  switch (run.state) {
    case "queued":
      segments.push(run.queuePosition !== undefined ? `queued (position ${run.queuePosition})` : "queued");
      break;
    case "running":
      segments.push(run.startedAt === undefined ? "running" : formatDuration(now - run.startedAt));
      if (run.activity) segments.push(run.activity);
      {
        const usage = formatUsage(run.usage, contextWindow);
        if (usage) segments.push(usage);
      }
      break;
    case "completed":
      segments.push(run.exitCode != null && run.exitCode !== 0 ? `exited ${run.exitCode}` : "done");
      break;
    case "failed":
      segments.push(run.spawnError ? `failed (${run.spawnError})` : "failed");
      break;
    case "aborted":
      segments.push(
        run.abortReason === "timeout" ? "aborted (timeout)" : run.abortReason === "lost" ? "aborted (lost)" : "aborted",
      );
      break;
    case "lost":
      segments.push("lost");
      break;
    case "stale":
      segments.push("stale");
      break;
  }
  return segments.join(" — ");
}

/**
 * The delegation status panel, one line per run, oldest start first (rows 18–21). Queued runs
 * show their phase, never a clock (row 19). `undefined` when there is nothing to show — the
 * caller clears its widget/footer with it, mirroring session-signals' `renderStatus`.
 */
export function renderDelegationStatus(runs: DelegationStatusRun[], now: number, contextWindow?: number): string | undefined {
  if (runs.length === 0) return undefined;
  const sorted = [...runs].sort(
    (a, b) => (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY),
  );
  return sorted.map((run) => renderRunLine(run, now, contextWindow)).join("\n");
}

// ------------------------------------------------------------------ admission policy

/** R7's caps: ≤4 running, ≤16 queued FIFO, beyond that both call types are rejected. */
export const DEFAULT_ADMISSION_CAP = 4;
export const DEFAULT_QUEUE_CAP = 16;

export interface AdmissionCaps {
  cap: number;
  queueCap: number;
}

export interface AdmissionState {
  running: string[];
  queue: string[];
}

export type AdmissionDecision =
  | { action: "admit" }
  | { action: "queue"; queuePosition: number }
  | { action: "reject"; reason: string };

// ------------------------------------------- one queue of groups (plan v2 R2/R3/R4)

/** Env override that lifts the running cap (R3); the oversize-parallel rejection names it. */
export const PARALLEL_GROUP_CAP_ENV = "PI_BADGER_SUBAGENT_MAX_CONCURRENT";

export type GroupMode = "serial" | "parallel";

/**
 * One queue entry (plan v2 R2): every queued delegation belongs to a group. A serial group
 * runs its members one at a time, in order; a parallel group is admitted atomically or not at
 * all. The next group dequeues only when the whole previous group settled. A plain single
 * delegation is a one-element serial group.
 */
export interface QueueGroup {
  groupId: string;
  mode: GroupMode;
  /** Members currently admitted (running). */
  members: string[];
  /** Members still waiting to be admitted, in order. */
  pending: string[];
}

/**
 * Admission state with the group FIFO. Invariant: `queue` is the flat pending list in group
 * order — `queue === groups.flatMap(g => g.pending)` — maintained in lockstep by every function
 * below, so `liveQueuePosition` is always the live flat index. Every mutation of this state
 * MUST go through these functions; hand-edited copies silently drop `groups`.
 */
export interface GroupAdmissionState extends AdmissionState {
  groups: QueueGroup[];
}

export function emptyAdmission(): GroupAdmissionState {
  return { running: [], queue: [], groups: [] };
}

/** The waiting line starts at the first group with pending members — the queue head. */
function queueHeadIndex(groups: QueueGroup[]): number {
  return groups.findIndex((g) => g.pending.length > 0);
}

/**
 * Whether the waiting line's head cannot proceed right now (plan v2 R2 ★ run-now rule):
 * a serial head mid-flight (a member is running) or with no free slot is blocked; a parallel
 * head whose pending members do not all fit is blocked. Fully-running groups are not queue
 * entries and never block — a run-now delegate may use a free slot behind one, which is what
 * keeps single-run behavior (row 22) unchanged. A head that could admit right now cannot
 * persist: every mutation drains.
 */
function waitingHeadBlocked(state: GroupAdmissionState, caps: AdmissionCaps): boolean {
  const head = state.groups.find((g) => g.pending.length > 0);
  if (!head) return false;
  if (head.mode === "serial") return head.members.length > 0 || state.running.length >= caps.cap;
  return state.running.length + head.pending.length > caps.cap; // parallel: waits for a full fit
}

/**
 * Apply one request to the admission state (row 22). Pure: returns the next state rather than
 * mutating, so the registry stays free to drop rejected requests. Rejection carries the
 * guidance the caller surfaces verbatim to blocking and background calls alike (T58).
 *
 * The request is a run-now single = a one-element serial group appended at the FIFO tail. It
 * admits iff a slot is free AND the waiting head is not slot-blocked (plan v2 R2 ★ M2): a head
 * waiting for members-to-settle or for a full parallel fit blocks run-now too. With an empty
 * queue this is exactly the row-22 behavior.
 */
export function admitRequest(
  state: GroupAdmissionState,
  id: string,
  caps: AdmissionCaps,
): { state: GroupAdmissionState; decision: AdmissionDecision } {
  if (state.running.length < caps.cap && !waitingHeadBlocked(state, caps)) {
    return {
      state: {
        running: [...state.running, id],
        queue: state.queue,
        groups: [...state.groups, { groupId: id, mode: "serial", members: [id], pending: [] }],
      },
      decision: { action: "admit" },
    };
  }
  if (state.queue.length < caps.queueCap) {
    return {
      state: {
        running: state.running,
        queue: [...state.queue, id],
        groups: [...state.groups, { groupId: id, mode: "serial", members: [], pending: [id] }],
      },
      decision: { action: "queue", queuePosition: state.queue.length + 1 },
    };
  }
  return {
    state,
    decision: { action: "reject", reason: `delegation queue is full (${caps.cap} running, ${caps.queueCap} queued)` },
  };
}

/**
 * Pop fully-settled head groups, then admit from the head of the waiting line per its mode
 * (plan v2 R2): a serial group admits its next member only when none of that group is running
 * and a slot is free; a parallel group admits all pending members atomically only when every
 * one fits. Fully-running groups are not queue entries — the waiting line starts at the first
 * group with pending members, which is what keeps single-run release behavior (row 22) intact.
 * If the waiting head cannot proceed, nothing behind it admits — later groups never overtake.
 * Admission is committed to the returned state in full before the caller spawns anything (the
 * batch-commit-before-spawn invariant, Q-B2): a synchronous settle inside a spawn finds every
 * admitted id already in `running`.
 */
function drainAdmission(
  state: GroupAdmissionState,
  caps: AdmissionCaps,
): { state: GroupAdmissionState; admitted: string[] } {
  let { running, groups } = state;
  let queue = state.queue;
  const admitted: string[] = [];
  for (;;) {
    while (groups.length > 0 && groups[0]!.members.length === 0 && groups[0]!.pending.length === 0) {
      groups = groups.slice(1); // a fully-settled head group collapses (Q-A5, and the all-aborted collapse Q-A6)
    }
    const headIndex = queueHeadIndex(groups);
    if (headIndex === -1) break;
    const head = groups[headIndex]!;
    if (head.mode === "serial") {
      if (head.members.length > 0 || running.length >= caps.cap) break;
      const next = head.pending[0]!;
      groups = [
        ...groups.slice(0, headIndex),
        { ...head, members: [next], pending: head.pending.slice(1) },
        ...groups.slice(headIndex + 1),
      ];
      running = [...running, next];
      queue = queue.filter((q) => q !== next);
      admitted.push(next);
      break; // a serial group runs one member at a time
    }
    if (running.length + head.pending.length > caps.cap) break;
    const batch = head.pending;
    groups = [
      ...groups.slice(0, headIndex),
      { ...head, members: [...head.members, ...batch], pending: [] },
      ...groups.slice(headIndex + 1),
    ];
    running = [...running, ...batch];
    queue = queue.filter((q) => !batch.includes(q));
    admitted.push(...batch);
    break;
  }
  return { state: { running, queue, groups }, admitted };
}

/**
 * Release one finished run and drain admission (row 22 generalized, plan v2 R2). The released
 * id leaves `running` and its group; settled head groups pop and the next group admits per its
 * mode. `admitted` lists every id the drain admitted, in order — for singles that is zero or
 * one id, for a parallel head up to the whole group. The registry spawns each admitted id after
 * the whole admission state is committed.
 */
export function releaseRun(
  state: GroupAdmissionState,
  id: string,
  caps: AdmissionCaps,
): { state: GroupAdmissionState; admitted: string[] } {
  const running = state.running.filter((r) => r !== id);
  const groups = state.groups
    .map((g) => ({
      ...g,
      members: g.members.filter((m) => m !== id),
      pending: g.pending.filter((m) => m !== id),
    }))
    .filter((g) => g.members.length > 0 || g.pending.length > 0); // a fully-settled group collapses (Q-A6)
  return drainAdmission({ running, queue: groups.flatMap((g) => g.pending), groups }, caps);
}

/**
 * Remove one QUEUED member (a member-level abort, plan v2 R4 ★): the group continues with its
 * remaining members, and a group left with neither running nor pending members collapses — the
 * drain then lets the next group dequeue (Q-A6). `admitted` lists ids promoted by the collapse;
 * the registry spawns them (unless it is shut down).
 */
export function removePending(
  state: GroupAdmissionState,
  id: string,
  caps: AdmissionCaps,
): { state: GroupAdmissionState; admitted: string[] } {
  const queue = state.queue.filter((q) => q !== id);
  const groups = state.groups
    .map((g) => (g.pending.includes(id) ? { ...g, pending: g.pending.filter((m) => m !== id) } : g))
    .filter((g) => g.members.length > 0 || g.pending.length > 0); // an all-aborted group collapses (Q-A6)
  return drainAdmission({ running: state.running, queue, groups }, caps);
}

export type GroupEnqueueDecision =
  | { action: "accepted"; admittedNow: string[]; queued: Array<{ id: string; queuePosition: number }> }
  | { action: "reject"; reason: string };

/**
 * Enqueue one whole group all-or-nothing (plan v2 R2/R3). Rejections leave the state untouched
 * (same reference): a parallel group larger than the running cap (R3 — the reason names the
 * cap, the env override and the split remedy), a group whose pending members would push the
 * flat queue past `queueCap` (R2 ★ serial-overflow — names the cap and the split remedy), or a
 * malformed member list. An accepted group dequeues immediately only on an idle system (empty
 * group FIFO — Q-B4); behind any existing group it waits entirely for the next release — later
 * groups never overtake, and an explicitly queued group never starts while it is being
 * enqueued. `admittedNow` and `queued` (with the flat 1-based position each member holds at
 * enqueue) are the per-member receipt inputs.
 */
export function enqueueGroup(
  state: GroupAdmissionState,
  groupId: string,
  mode: GroupMode,
  memberIds: string[],
  caps: AdmissionCaps,
): { state: GroupAdmissionState; decision: GroupEnqueueDecision } {
  if (memberIds.length === 0) {
    return { state, decision: { action: "reject", reason: "delegation group is empty" } };
  }
  if (new Set(memberIds).size !== memberIds.length) {
    return { state, decision: { action: "reject", reason: "delegation group has duplicate members" } };
  }
  if (mode === "parallel" && memberIds.length > caps.cap) {
    return {
      state,
      decision: {
        action: "reject",
        reason: `parallel delegation group of ${memberIds.length} members exceeds the running cap of ${caps.cap} (raise ${PARALLEL_GROUP_CAP_ENV} to lift it) — split it into groups of at most ${caps.cap} members`,
      },
    };
  }
  const idle = state.groups.length === 0; // nothing running, nothing pending (Q-B4's idle system)
  const appended: GroupAdmissionState = {
    running: state.running,
    queue: [...state.queue, ...memberIds],
    groups: [...state.groups, { groupId, mode, members: [], pending: [...memberIds] }],
  };
  const finalState = idle ? drainAdmission(appended, caps).state : appended;
  if (finalState.queue.length > caps.queueCap) {
    return {
      state,
      decision: {
        action: "reject",
        reason: `delegation group would push the queue past its cap of ${caps.queueCap} pending delegations — split it into smaller groups or wait for the queue to drain`,
      },
    };
  }
  const group = finalState.groups.find((g) => g.groupId === groupId)!;
  const admittedNow = memberIds.filter((id) => !group.pending.includes(id));
  const queued = memberIds
    .filter((id) => group.pending.includes(id))
    .map((id) => ({ id, queuePosition: finalState.queue.indexOf(id) + 1 }));
  return { state: finalState, decision: { action: "accepted", admittedNow, queued } };
}

/**
 * The live flat 1-based position of a pending member over the whole queue (plan v2 R2: `queue
 * list` renders the LIVE recomputed index; receipts snapshot the index at enqueue). Undefined
 * for ids that are not pending (running, settled or unknown).
 */
export function liveQueuePosition(state: GroupAdmissionState, id: string): number | undefined {
  const index = state.queue.indexOf(id);
  return index === -1 ? undefined : index + 1;
}

// ------------------------------------------------------------------ run-id allocation

const RUN_ID_PATTERN = /^d-(\d+)$/;
export const RUN_ID_PREFIX = "d-";

/**
 * Next run id over the existing log-dir listing (T53, R10 review CR1): always past the
 * highest id ever seen, never into a gap — `d-1,d-3` allocates `d-4`, not `d-2`, so an id is
 * never reused after its log was pruned and `delegations log d-2` stays unambiguous.
 * `exists` re-checks the chosen name against the live directory (allocation race); it
 * receives the bare candidate id. Ids sort lexicographically == numerically only below
 * d-10; callers should not rely on ordering — `startedAt` is the ordering.
 */
export function allocateRunId(existing: string[], exists?: (id: string) => boolean): string {
  const takenIds = new Set<string>();
  let highest = 0;
  for (const name of existing) {
    const base = name.replace(/\.jsonl$/, "");
    const match = RUN_ID_PATTERN.exec(base);
    if (!match) continue;
    takenIds.add(base);
    const n = Number(match[1]);
    if (n > highest) highest = n;
  }
  let candidate = highest + 1;
  while (takenIds.has(RUN_ID_PREFIX + candidate) || exists?.(RUN_ID_PREFIX + candidate)) {
    candidate += 1;
  }
  return RUN_ID_PREFIX + candidate;
}

// ------------------------------------------------------------------ answer extraction

export type ExtractedAnswer = { kind: "text"; text: string } | { kind: "silent"; reason: string };

/**
 * The delegation's answer: the last assistant text in the parsed event stream (T54), walking
 * back over toolCall-only assistant messages, joining a message's text blocks with newlines.
 *
 * The silent-JSON variant (R3 fallback, review CR4) is a child that exited 0 having emitted a
 * valid `session` header but no assistant output — H2's quiet failure mode. It requires the
 * session header so plain non-JSON stdout (an invocation bug, not a silent variant) never
 * triggers it. Non-zero exits are not silent: the caller builds the failure verdict from the
 * exit code and stderr, with whatever partial answer tail this returns (`""` when none).
 */
export function extractAnswer(events: ChildEvent[], exitCode: number | null | undefined): ExtractedAnswer {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (!message || message.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return { kind: "text", text };
  }
  if (exitCode === 0 && events.some((event) => event.type === "session")) {
    return {
      kind: "silent",
      reason:
        "silent-JSON variant: the child exited 0 with a session header but no assistant output — no answer exists; attach the capped raw stdout for diagnosis",
    };
  }
  return { kind: "text", text: "" };
}

// ------------------------------------------------------------------ log-dir pruning

/** R4: logs older than 14 days are pruned on session_start. */
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** R4: and the dir is capped, oldest-first, so a burst of runs cannot grow it without bound. */
export const LOG_DIR_CAP = 200;

export interface LogDirEntry {
  name: string;
  mtimeMs: number;
}

export interface PrunePlan {
  delete: string[];
  keep: string[];
}

/**
 * Which log files to unlink, decided purely (T55): strictly older than `maxAgeMs` (measured
 * against the injected `now`) go first, then a cap overage trims oldest-first. Age ties break
 * by name so the plan is deterministic. The caller performs the unlinks — this only plans.
 */
export function pruneLogFiles(
  files: LogDirEntry[],
  now: number,
  opts?: { maxAgeMs?: number; cap?: number },
): PrunePlan {
  const maxAgeMs = opts?.maxAgeMs ?? LOG_MAX_AGE_MS;
  const cap = opts?.cap ?? LOG_DIR_CAP;
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const del: string[] = [];
  const keep: string[] = [];
  for (const file of sorted) {
    if (now - file.mtimeMs > maxAgeMs) del.push(file.name);
    else keep.push(file.name);
  }
  while (keep.length > cap) del.push(keep.shift()!);
  return { delete: del, keep };
}

// ------------------------------------------------------------------ per-run tee byte cap

/** R4: the per-run tee is byte-capped (review CR14 dropped the "lossless" claim). */
export const DEFAULT_TEE_CAP_BYTES = 1024 * 1024;

export const TEE_ELIDED_TYPE = "tee-elided";

/**
 * The final content of one run's log file (T56): the run header always survives, and so does
 * the tail of the child's stream — the answer lives at the end. When the stream exceeds
 * `capBytes`, the elided middle is replaced by one `{"type":"tee-elided","droppedBytes":N}`
 * marker line, and the tail is snapped forward to the next line boundary so every kept line
 * still parses. Within the cap the stream is verbatim.
 *
 * The cap counts string length, which equals bytes for the ASCII JSONL pi emits and errs
 * smaller for multibyte content — under a cap, "smaller" is the safe direction.
 */
export function elideTeeStream(headerLine: string, stream: string, capBytes: number): string {
  if (stream.length <= capBytes) {
    return stream ? `${headerLine}\n${stream.replace(/\n$/, "")}\n` : `${headerLine}\n`;
  }
  let tail = stream.slice(-capBytes);
  const newline = tail.indexOf("\n");
  if (newline >= 0) tail = tail.slice(newline + 1);
  const droppedBytes = stream.length - tail.length;
  const marker = JSON.stringify({ type: TEE_ELIDED_TYPE, droppedBytes });
  return `${headerLine}\n${marker}\n${tail.replace(/\n$/, "")}\n`;
}

// ------------------------------------------------------------------ model-tier (level) registry (PKG-5)

/**
 * Model-tier vocabulary (PKG-5, ADR docs/work/2026-09-06-pkg5-level-registry-adr.md).
 *
 * The resolver consumes a VALIDATED registry object — never the filesystem. Ordering
 * invariants (preferred-first, lexicographic price order, intra-group uniqueness, the
 * demoted-tail exemption) are PKG-1 validator territory; this half reads
 * `groups[level][0].id` only and re-validates the resolved id against MODEL_ID_PATTERN
 * before emit (M8: the file is project-writable, the argv is not). Same purity rules as
 * the rest of this file: no imports, no clock, no fs — decisions take injected data.
 */

/** Closed level set (contract §1 inv 6): exactly low|medium|high. */
export const VALID_LEVELS = ["low", "medium", "high"] as const;

/** One of the closed levels. */
export type ModelLevel = (typeof VALID_LEVELS)[number];

/**
 * Tight model-id shape (M8): `openrouter/` + two bounded segments — no whitespace, no
 * leading dash, no shell metacharacters. A resolved id that fails this is refused, never
 * emitted into `--model` argv.
 */
export const MODEL_ID_PATTERN = /^openrouter\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Minimal structural view of one registry member. Member-objects only (T-FAKESHAPE: never
 * string lists) — the resolver reads `.id` and nothing else; `aliases`/`weightsId` are
 * refresh-time metadata the resolver must never dereference (T-ALIAS).
 */
export interface LevelRegistryMember {
  readonly id: string;
  readonly preferred?: boolean;
  readonly [key: string]: unknown;
}

/** Minimal structural view of the registry — `groups[level][0].id` is the only read. */
export interface LevelRegistry {
  readonly groups: Record<ModelLevel, readonly LevelRegistryMember[]>;
  readonly registryVersion?: number;
  readonly [key: string]: unknown;
}

/**
 * Frozen fallback (router degrade-on-stale precedent): preferred pins only, copied from
 * the PKG-1 canonical (`tiers/pkg1-registry:.ai-badger/model-groups.json`, read-only).
 * Served when the target project has no usable registry file (absence rule — the warning
 * rides `ModelGroupsLoad.warning`). `{ frozen: true }` marks degraded resolutions in
 * telemetry; re-pin against the PKG-1 canonical when preferreds rotate (G1 follow-up).
 */
export const FROZEN_MODEL_GROUPS: LevelRegistry & { readonly frozen: true } = {
  registryVersion: 1,
  frozen: true,
  source: "tiers/pkg1-registry canonical preferred pins (frozen fallback, revisit on rotation)",
  groups: {
    low: [{ id: "openrouter/z-ai/glm-5.3-flash", preferred: true }],
    medium: [{ id: "openrouter/meta/muse-spark-1.3-contributor", preferred: true }],
    high: [{ id: "openrouter/meta/muse-spark-1.3-contributor", preferred: true }],
  },
};

/**
 * Structural gate for an imported registry file (loader side): every closed level present
 * as a non-empty list whose first entry bears a non-empty string id. Lifecycle invariants
 * (preferred-first, price order, uniqueness) belong to PKG-1's validator, not this gate —
 * this only refuses what the resolver cannot consume without guessing (§4 step 8: an
 * empty group never auto-picks).
 */
export function isUsableModelRegistry(value: unknown): value is LevelRegistry {
  if (typeof value !== "object" || value === null) return false;
  const groups = (value as { groups?: unknown }).groups;
  if (typeof groups !== "object" || groups === null) return false;
  for (const level of VALID_LEVELS) {
    const group = (groups as Record<string, unknown>)[level];
    if (!Array.isArray(group) || group.length === 0) return false;
    const first = group[0] as { id?: unknown } | null;
    if (typeof first !== "object" || first === null || typeof first.id !== "string" || !first.id) return false;
  }
  return true;
}

// ------------------------------------------------------------------ level resolution (PKG-5 5b)

/**
 * RFC 7807 §5 invalid-level error (contract §5): `message` is the `detail` sentence
 * (echoes the received value + the valid set — the fail-loud requirement), with the
 * extension fields `invalidLevel`/`validLevels` and the stable `type`/`status` pair.
 * No fuzzy match, no prefix match, no case folding — `Low` is invalid (T-CASE).
 */
export class InvalidLevelError extends Error {
  readonly invalidLevel: string;
  readonly validLevels: readonly string[] = [...VALID_LEVELS];
  readonly status = 400;
  readonly type = "https://github.com/Arasz/ai-badger/problems/invalid-level";
  constructor(invalidLevel: string) {
    super(`Unknown level "${invalidLevel}". Valid levels are ${VALID_LEVELS.join(", ")}.`);
    this.name = "InvalidLevelError";
    this.invalidLevel = invalidLevel;
  }
}

/** Two-source pin: the level to resolve plus the explicit model that wins verbatim over it. */
export interface ResolveLevelOptions {
  readonly level?: unknown;
  readonly model?: unknown;
}

/** What a resolution decided: the `--model` value (absent = no pin, inherit) + how it won. */
export interface ResolvedLevelPin {
  /** The `--model` value, or undefined for no pin (omit `--model`, inherit session/parent). */
  readonly model?: string;
  /** The level that resolved, when a valid level decided (telemetry per §4 step 10). */
  readonly resolvedLevel?: ModelLevel;
  /** The registry the id resolved from, when a level decided. */
  readonly registryVersion?: number;
  /**
   * S5 non-deciding-pin warning: the level was invalid but an explicit model overrode it,
   * so the call proceeds on the explicit model — validated, never silent. The caller
   * surfaces this (ui.notify); the pure half only reports it.
   */
  readonly levelWarning?: string;
  /** G-6 explicit-wins record: a valid level this explicit model overrode (note, like modelFallback). */
  readonly overriddenLevel?: ModelLevel;
  /** The explicit model that won (verbatim), when one did. */
  readonly overridingModel?: string;
}

/** Non-empty trimmed string, or undefined — blank ≡ absent at every rank (T-EMPTY). */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The preferred id of one group — throws naming the rule instead of guessing (§4 step 8). */
function readPreferredId(registry: LevelRegistry, level: ModelLevel): string {
  const group = registry.groups[level];
  if (!Array.isArray(group) || group.length === 0) {
    throw new Error(
      `ai-badger: model registry has no usable "${level}" group (missing or empty) — ` +
      `refusing to guess; valid levels are ${VALID_LEVELS.join(", ")}.`,
    );
  }
  const id = group[0]?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`ai-badger: model registry "${level}" preferred entry has no usable id — refusing to guess.`);
  }
  return id;
}

/**
 * Pure `resolveLevel(registry, {level, model})` (contract §4, ADR §consumer-posture).
 *
 * 1. Blank level ≡ absent (inherit); surrounding whitespace stripped, case-sensitive.
 * 2. Invalid level with an explicit model → the model wins verbatim + `levelWarning`
 *    (S5: validated, never silent). Invalid level deciding → `InvalidLevelError` (§5).
 * 3. Valid level + explicit model → the model wins verbatim + `overriddenLevel` (G-6).
 * 4. Valid level alone → `groups[level][0].id`, re-validated against MODEL_ID_PATTERN
 *    before emit (M8: refusal, never a dirty `--model`).
 * 5. Neither → no pin (inherit — the caller omits `--model`).
 * 6. Never falls back silently: empty groups and id-less entries throw (step 8).
 * 7. Never follows `aliases`/`weightsId` — only `.id` is read (T-ALIAS).
 */
export function resolveLevel(registry: LevelRegistry, opts: ResolveLevelOptions = {}): ResolvedLevelPin {
  const explicit = nonBlank(opts.model);
  const rawLevel = opts.level;
  const trimmedLevel = typeof rawLevel === "string" ? rawLevel.trim() : undefined;
  if (rawLevel === undefined || trimmedLevel === "") return explicit === undefined ? {} : { model: explicit, overridingModel: explicit };
  if (trimmedLevel === undefined || !(VALID_LEVELS as readonly string[]).includes(trimmedLevel)) {
    const received = trimmedLevel ?? String(rawLevel);
    if (explicit !== undefined) {
      return {
        model: explicit,
        overridingModel: explicit,
        levelWarning: `Unknown level "${received}". Valid levels are ${VALID_LEVELS.join(", ")}.`,
      };
    }
    throw new InvalidLevelError(received);
  }
  const level = trimmedLevel as ModelLevel;
  const id = readPreferredId(registry, level);
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error(
      `ai-badger: model registry "${level}" preferred id "${id}" fails ${String(MODEL_ID_PATTERN)} — ` +
      `refusing to emit it into --model argv.`,
    );
  }
  if (explicit !== undefined) return { model: explicit, overridingModel: explicit, overriddenLevel: level };
  return {
    model: id,
    resolvedLevel: level,
    ...(registry.registryVersion !== undefined ? { registryVersion: registry.registryVersion } : {}),
  };
}

/**
 * What the registry loader resolved: the project's file, or the frozen fallback with
 * the reason it degraded (absence rule — the caller surfaces `warning` via ui.notify,
 * so the degrade is loud, never silent). Shape lives here (pure) so both tool layers
 * can name it without importing each other.
 */
export interface ModelGroupsLoad {
  registry: LevelRegistry;
  /** "project" = the target project's file; "frozen" = degrade-on-stale fallback. */
  source: "project" | "frozen";
  /** Present exactly when `source` is "frozen": names the file + the rule that forced it. */
  warning?: string;
}

/**
 * The four G-6 model sources, highest precedence first. Blank ≡ absent at every rank.
 * The delegate tool has no call-time override (toolModel stays undefined there); the queue
 * tool's group `model:` is the tool-override rank.
 */
export interface DelegationModelSources {
  /** Call-time tool override (queue group `model:`) — G-6 rank 1. */
  readonly toolModel?: unknown;
  /** Persona frontmatter `model:` pin — G-6 rank 2. */
  readonly frontmatterModel?: unknown;
  /** Effective level (queue `level:` param ?? persona `level:`) — G-6 rank 3. */
  readonly level?: unknown;
  /** Delegating session model — G-6 rank 4 (fallback). */
  readonly sessionModel?: unknown;
}

/**
 * G-6 implemented verbatim, once: tool-override > frontmatter `model:` > `level:`-resolved
 * > session model. Both tool layers (delegate, queue) resolve through here, so the order
 * cannot drift between them. `level` is validated even when overridden (A7: deciding pin
 * raises, non-deciding pin warns per S5).
 */
export function resolveDelegationModel(registry: LevelRegistry, sources: DelegationModelSources = {}): ResolvedLevelPin {
  const explicit = nonBlank(sources.toolModel) ?? nonBlank(sources.frontmatterModel);
  const resolved = resolveLevel(registry, { level: sources.level, model: explicit });
  if (resolved.model !== undefined) return resolved;
  const session = nonBlank(sources.sessionModel);
  return session === undefined ? {} : { model: session };
}

/**
 * The G-6 explicit-wins sentence for a resolution (`explicit model "X" overrode level
 * "low"`), or undefined when no valid level lost to an explicit model. ONE builder so the
 * delegate tool, the queue tool, receipts, and cards record it byte-identically — the
 * modelFallback pattern (acceptance 3: recorded, never silent).
 */
export function levelOverrideSentence(resolved: ResolvedLevelPin): string | undefined {
  if (resolved.overriddenLevel === undefined || resolved.overridingModel === undefined) return undefined;
  return `explicit model "${resolved.overridingModel}" overrode level "${resolved.overriddenLevel}"`;
}
