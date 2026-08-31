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
 * the log dir (R10) — a live record never enters it; `aborted` is terminal (plan §4).
 */
export type DelegationState = "queued" | "running" | "completed" | "failed" | "aborted" | "lost";

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
  /** RR2: "timeout" on a run killed by its per-run timeout; a user abort carries no marker. */
  abortReason?: "timeout";
  /** The applied (clamped) per-run timeout — observable while running and at settle (T85). */
  timeoutMs?: number;
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

// ------------------------------------------------------------------ log-dir classification

/** One run's log file as the caller read it: its id and the raw lines of `<id>.jsonl`. */
export interface LogRunFile {
  id: string;
  lines: string[];
}

/**
 * What reconstruction knows about one past run (row 14: identity comes from the run header,
 * not from any session receipt — the log dir is the single source of truth, R10).
 */
export interface LogRunSummary {
  id: string;
  state: "running" | "completed" | "failed" | "lost";
  exitCode?: number | null;
  agent?: string;
  task?: string;
  startedAt?: number;
  pid?: number;
  sessionId?: string;
  spawnError?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Classify the log dir's runs without touching the filesystem (rows 14–17, R10 log-dir-only
 * reconstruction).
 *
 * Per run, in precedence order:
 *   - `exit` line present → `completed` (the exit code rides along, row 15);
 *   - `spawnError` marker → `failed` (the child never ran, row 16);
 *   - header without exit, pid probe dead (or header has no pid at all) → `lost`;
 *   - header without exit, pid alive → `running` (another live session's run).
 * A file whose lines hold no readable `run` header is `lost` with only its id — a partial
 * write is a run we lost, not something to hide.
 *
 * `pidAlive` is the caller's probe (kill(pid, 0), corroborated per R16) — this function only
 * decides on its answer.
 */
export function classifyFromLogDir(files: LogRunFile[], pidAlive: (pid: number) => boolean): LogRunSummary[] {
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
      summaries.push({ ...base, state: "lost" });
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
  /** RR2: "timeout" on a run killed by its per-run timeout; a user abort carries no marker. */
  abortReason?: "timeout";
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

/** Compact one-line usage, same glyph order as pi's own subagent example; empty when zero. */
export function formatUsage(usage: DelegationUsage | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${usage.input}`);
  if (usage.output) parts.push(`↓${usage.output}`);
  if (usage.cacheRead) parts.push(`R${usage.cacheRead}`);
  if (usage.cacheWrite) parts.push(`W${usage.cacheWrite}`);
  if (usage.contextTokens) parts.push(`ctx:${usage.contextTokens}`);
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

function renderRunLine(run: DelegationStatusRun, now: number): string {
  const segments: string[] = [`${run.id} ${run.agent}`];
  switch (run.state) {
    case "queued":
      segments.push(run.queuePosition !== undefined ? `queued (position ${run.queuePosition})` : "queued");
      break;
    case "running":
      segments.push(run.startedAt === undefined ? "running" : formatDuration(now - run.startedAt));
      if (run.activity) segments.push(run.activity);
      {
        const usage = formatUsage(run.usage);
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
      segments.push(run.abortReason === "timeout" ? "aborted (timeout)" : "aborted");
      break;
    case "lost":
      segments.push("lost");
      break;
  }
  return segments.join(" — ");
}

/**
 * The delegation status panel, one line per run, oldest start first (rows 18–21). Queued runs
 * show their phase, never a clock (row 19). `undefined` when there is nothing to show — the
 * caller clears its widget/footer with it, mirroring session-signals' `renderStatus`.
 */
export function renderDelegationStatus(runs: DelegationStatusRun[], now: number): string | undefined {
  if (runs.length === 0) return undefined;
  const sorted = [...runs].sort(
    (a, b) => (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY),
  );
  return sorted.map((run) => renderRunLine(run, now)).join("\n");
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

export function emptyAdmission(): AdmissionState {
  return { running: [], queue: [] };
}

/**
 * Apply one request to the admission state (row 22). Pure: returns the next state rather than
 * mutating, so the registry stays free to drop rejected requests. Rejection carries the
 * guidance the caller surfaces verbatim to blocking and background calls alike (T58).
 */
export function admitRequest(
  state: AdmissionState,
  id: string,
  caps: AdmissionCaps,
): { state: AdmissionState; decision: AdmissionDecision } {
  if (state.running.length < caps.cap) {
    return { state: { running: [...state.running, id], queue: state.queue }, decision: { action: "admit" } };
  }
  if (state.queue.length < caps.queueCap) {
    return {
      state: { running: state.running, queue: [...state.queue, id] },
      decision: { action: "queue", queuePosition: state.queue.length + 1 },
    };
  }
  return {
    state,
    decision: { action: "reject", reason: `delegation queue is full (${caps.cap} running, ${caps.queueCap} queued)` },
  };
}

/**
 * Release one finished run and admit the queue head FIFO if a slot freed (row 22). At most
 * one run is admitted per release — a release frees exactly one slot; the registry repeats
 * the call if its own bookkeeping ever frees more.
 */
export function releaseRun(
  state: AdmissionState,
  id: string,
  caps: AdmissionCaps,
): { state: AdmissionState; admitted: string | undefined } {
  const running = state.running.filter((r) => r !== id);
  const queue = [...state.queue];
  const next = running.length < caps.cap ? queue.shift() : undefined;
  if (next !== undefined) running.push(next);
  return { state: { running, queue }, admitted: next };
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
