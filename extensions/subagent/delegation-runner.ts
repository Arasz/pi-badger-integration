/**
 * Streaming runner for interactive background subagent delegation (plan §2 R11 module map:
 * "ChildLike seam, spawn, parse wiring, escalation; escalateAfterMs injectable, 0 in tests").
 *
 * The runner is the only module that touches processes: it owns the child seam, the JSON-line
 * parse loop (via P1's `parseChildEvent`/`applyUsage`), the per-run log tee (R4, capped through
 * P1's `elideTeeStream`), answer extraction (`extractAnswer`), the two kill paths (R8 review
 * CR5: async SIGTERM → grace → SIGKILL with cancellation on close; synchronous SIGKILL for the
 * process-exit hook), and exactly one `DelegationNote` per run delivered through
 * `notifyComplete` (R5).
 *
 * Admission, records, wait and shutdown live in `delegation-registry.ts`; the runner is the
 * per-run machinery the registry drives. No pi imports — the process seam is `SpawnFn`/`ChildLike`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import {
  applyUsage,
  clampRunTimeoutMs,
  clampRunWatchdogMs,
  DEFAULT_TEE_CAP_BYTES,
  deriveActivity,
  applyLiveUsage,
  elideTeeStream,
  emptyUsage,
  extractAnswer,
  parseChildEvent,
  PEEK_PREVIEW_MAX_CHARS,
  previewTextFromEvent,
  type ChildEvent,
  type DelegationRecord,
  type DelegationUsage,
} from "./delegation-core.ts";

/** Output kept on a note (answer / stderr tail / silent-stdout tail) — one runaway subagent
 * cannot flood the parent's context. Same limit and marker format as the tool layer's
 * `capOutput` (row 5); duplicated here because that module imports pi and this one must not. */
export const MAX_NOTE_CHARS = 64 * 1024;

/** Keep the last `limit` characters; the tail is the answer (row 34). */
export function capTail(text: string, limit: number = MAX_NOTE_CHARS): string {
  if (text.length <= limit) return text;
  return `[...${text.length - limit} earlier characters dropped]\n${text.slice(-limit)}`;
}

// ------------------------------------------------------------------ process seam

/** The slice of a spawned child the runner reads. Never gates a kill on `killed` — that flag
 * is true after any successful kill(), which is exactly pi's example mutation trap (rows 35/36). */
export interface ChildLike {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): unknown } | null;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: string): boolean;
}

export interface SpawnOptions {
  cwd: string;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

/** Real process edge. The cast only widens ChildProcess to the seam the runner reads. */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildLike;

// ------------------------------------------------- model-pin failure signature (f: 2026-09-02)

/** The stderr signatures pi prints when the REQUESTED MODEL cannot start — the d-324 class
 * (pi's credential-blind alias resolution picked amazon-bedrock for the bare alias `opus`, so
 * a well-formed persona pin died at the auth gate before doing any work). The model-fallback
 * retry arms only on these, never on ordinary task stderr. */
const MODEL_STARTUP_FAILURE_RE =
  /no api key found for|model "[^"]*" not found|is ambiguous across providers|unknown provider|no models available/i;

export function isModelStartupFailure(rawStderr: string): boolean {
  return MODEL_STARTUP_FAILURE_RE.test(rawStderr);
}

// ------------------------------------------------- billing exhaustion (402) signature

/** `"<status>: <body>"` — the `formatProviderError` no-prefix shape. */
const STATUS_PREFIX = /^\s*(\d{3})\s*:/;

/** `"<provider> (<status>): <body>"` — the `formatProviderError` prefixed shape. */
const PROVIDER_STATUS_PREFIX = /^\s*[A-Za-z][\w+.~-]*(?:\s+[A-Za-z][\w+.~-]*)*\s*\((\d{3})\)\s*:/;

/** The status and the body a provider error carries, in either `formatProviderError` shape. */
function parseProviderError(text: string): { status: number | undefined; body: string } {
  const provider = PROVIDER_STATUS_PREFIX.exec(text);
  if (provider) return { status: Number(provider[1]), body: text.slice(provider[0].length).trim() };
  const bare = STATUS_PREFIX.exec(text);
  if (bare) return { status: Number(bare[1]), body: text.slice(bare[0].length).trim() };
  return { status: undefined, body: text.trim() };
}

/** The status a provider error carries, provider-prefixed shape first. */
function parseStatusPrefix(text: string): number | undefined {
  return parseProviderError(text).status;
}

/**
 * Whether a provider error is a billing exhaustion (HTTP 402) — the failure the parent
 * model can still answer, because the child's model ran out of credits.
 *
 * The rule is the STATUS, not the billing wording: pi folds a provider error into
 * `formatProviderError`'s "<status>: <body>" shape, and a 402 is unambiguous (a 401 is
 * auth, a 429 is a throttle — neither is fixed by another model). This mirrors the
 * status-prefix rule of the router-fallback core
 * (`extensions/router-fallback/router-fallback-core.ts`); the copy exists because each
 * extension ships as its own package and cannot import the sibling. The charset is the
 * sibling's on purpose — a provider prefix carrying a slash or a colon is not matched by
 * either rule, so the two stay in step.
 */
export function isBillingExhaustionFailure(errorMessage: string): boolean {
  return parseStatusPrefix(errorMessage) === 402;
}

/** The provider's own message inside a JSON error body, when the body carries one. */
function providerMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { message?: unknown; error?: { message?: unknown } };
  if (typeof record.message === "string") return record.message;
  if (typeof record.error?.message === "string") return record.error.message;
  return undefined;
}

/**
 * The reason a provider failure names: the status plus the provider's own words. The raw
 * JSON body is not a sentence a human reads, so the provider's `message` is preferred when
 * the body carries one.
 */
function providerReasonText(errorMessage: string): string {
  const { status, body } = parseProviderError(errorMessage);
  const message = providerMessage(body) ?? body;
  return `${status ?? "?"}: ${message}`.slice(0, 160);
}

// ------------------------------------------------- model-unavailable (provider rejection)

/** The machine codes providers use for "this model id cannot be used" (measured 2026-10-20). */
const MODEL_UNAVAILABLE_CODES = new Set([
  "model_not_supported",
  "model_not_found",
  "model_not_exist",
  "invalid_model",
]);

/** The wordings providers use for the same rejection. */
const MODEL_UNAVAILABLE_WORDINGS = [
  /model[^.]{0,80}?\b(?:is not supported|isn't supported|not supported|not found|does not exist|doesn't exist|is not available|is unavailable)\b/i,
  /\bunknown model\b/i,
  /\bno api key found for\b/i,
];

/** The error codes a provider body carries, at the top level or under `error`. */
function providerErrorCodes(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } };
  const codes = [record.code, record.type, record.error?.code, record.error?.type];
  return codes.filter((code): code is string => typeof code === "string").map((code) => code.toLowerCase());
}

/**
 * Whether a provider error says the MODEL ITSELF cannot be used — the provider rejected
 * the id the child was told to run.
 *
 * This is the startup class arriving through the other channel: pi's own resolution error
 * ("No API key found for …", "Model \"x\" not found") arrives on stderr with exit 1, while a
 * provider that refuses the id answers inside the turn ("The requested model is not
 * supported.", `model_not_found`) with exit 0 — the child never ran, and without this the
 * delegation died silently.
 *
 * The rule is a machine code where the provider gives one, else the wording — a provider
 * rejection is not a status the runner can key on (it is a 400, 404 or 401 depending on
 * the provider and the account).
 */
export function isModelUnavailableFailure(errorMessage: string): boolean {
  const { body } = parseProviderError(errorMessage);
  for (const code of providerErrorCodes(body)) {
    if (MODEL_UNAVAILABLE_CODES.has(code)) return true;
  }
  const message = providerMessage(body) ?? body;
  return MODEL_UNAVAILABLE_WORDINGS.some((pattern) => pattern.test(message));
}

/** The value a tool-built argv passed as `--model <value>`, or undefined. */
function modelFlagValue(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

/** The first line with content — the reason a startup failure names. */
function firstNonEmptyLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim().length > 0);
}

/** The failure class that arms the respawn — the wording of the recorded reason differs. */
type RetryClass = "model-startup" | "billing";

/** One respawn decision: the class that armed it and the reason it records. */
interface RetryFailure {
  cls: RetryClass;
  reason: string;
}

/**
 * The child's LAST assistant turn's provider failure, when that turn failed.
 *
 * The LAST turn, not any failure in the stream: with the router-fallback extension loaded
 * in the child, a failure can be recovered in-child (the child switches model and carries
 * on) — a run that ended on a normal turn has an answer and must not be respawned. A last
 * turn that failed for another reason is not a billing failure either.
 */
function lastAssistantFailure(events: ChildEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (!message || message.role !== "assistant") continue;
    if (message.stopReason !== "error") return undefined;
    const errorMessage = message.errorMessage;
    if (typeof errorMessage !== "string" || errorMessage === "") return undefined;
    return errorMessage;
  }
  return undefined;
}

/** The child's last assistant turn's provider failure, when that turn ended on a 402. */
function billingFailureReason(events: ChildEvent[]): string | undefined {
  const errorMessage = lastAssistantFailure(events);
  return errorMessage !== undefined && isBillingExhaustionFailure(errorMessage) ? errorMessage : undefined;
}

/** Whether the child did any work — produced an answer or ran a tool. */
function didAnyWork(events: ChildEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "tool_execution_start") return true;
    if (event.type !== "message_end") return false;
    const message = event.message;
    if (!message || message.role !== "assistant") return false;
    return (message.content ?? []).some(
      (part) => part?.type === "text" && typeof part.text === "string" && part.text !== "",
    );
  });
}

/**
 * The child's last assistant turn's provider failure, when the provider rejected the MODEL
 * itself and the child never did any work.
 *
 * The no-work guard is what separates this from the billing arm: a provider refusal that
 * reaches a child which already produced output is a failure of the FALLBACK chain, not of
 * the child's own model, and respawning would repeat that work.
 */
function modelUnavailableReason(events: ChildEvent[]): string | undefined {
  const errorMessage = lastAssistantFailure(events);
  if (errorMessage === undefined) return undefined;
  if (!isModelUnavailableFailure(errorMessage)) return undefined;
  if (didAnyWork(events)) return undefined;
  return errorMessage;
}

// ------------------------------------------------------------------ log tee seam

/**
 * One run's log sink (R4's `~/.pi/agent/subagent-logs/<runId>.jsonl`). The registry/P3 layer
 * supplies the factory; the runner only appends lines. Every sink operation is try/catch
 * wrapped — the first failure warns exactly once (injectable `warn`), disables the sink for
 * that run, and leaves the delegation state untouched (T62, review CR6).
 */
export interface RunLogSink {
  /** Where the log lives; surfaced in records/notes only while the sink stays healthy. */
  readonly logFile?: string;
  appendLine(line: string): void;
}

export interface LogSinkInit {
  id: string;
  agent: string;
  task: string;
  /** PKG-3: the run's global GUID — the sink factory writes the index entry from it at
   * creation, so a rejected or queued-then-aborted run (no sink) is never indexed. */
  globalId?: string;
}

export type LogSinkFactory = (init: LogSinkInit) => RunLogSink | undefined;

// ------------------------------------------------------------------ notes and progress

/**
 * The single completion notification payload (R5): exactly one per run, delivered through
 * `notifyComplete` on every terminal transition — success, non-zero exit, silent-JSON variant,
 * spawn error, abort — except shutdown-initiated settles (row 38, enforced by the registry's
 * wrapper).
 */
export interface DelegationNote {
  id: string;
  agent: string;
  task: string;
  sessionId?: string;
  state: "completed" | "failed" | "aborted";
  /** Present for natural exits (may be null when the child closed without a code); absent for aborts and spawn errors (R5: "no exitCode"). */
  exitCode?: number | null;
  spawnError?: string;
  /** Extracted final answer, or the partial answer tail on failure/abort; tail-capped at MAX_NOTE_CHARS. */
  answer: string;
  /** Silent-JSON variant (R3/CR4): exit 0 with a session header but no assistant output. */
  silentReason?: string;
  /** Capped raw stdout, attached when the silent variant fires so the quiet failure is diagnosable. */
  stdoutTail?: string;
  /** Capped stderr for non-zero exits (row 32). */
  stderrTail?: string;
  /** Model-pin fallback (f: 2026-09-02): the recorded rejection + retry target when the
   * persona's pin could not start the child. Rides the note so the card names it. */
  modelFallback?: string;
  usage?: DelegationUsage;
  durationMs?: number;
  /** Absent when no sink was configured or the sink failed mid-run (T62). */
  logFile?: string;
  /** RR2: present on a timeout settle ("timeout") or a watchdog-lost settle ("lost"). */
  abortReason?: "timeout" | "lost";
  /** The applied (clamped) per-run timeout; present when the timer armed (RR2/T85). */
  timeoutMs?: number;
  /** RR2: the applied watchdog threshold, present on a lost settle — the verdict names it. */
  watchdogMs?: number;
}

/** Live progress snapshot for `onUpdate` (rows 26); structurally a `DelegationStatusRun`. */
export interface DelegationProgress {
  id: string;
  agent: string;
  state: "running";
  startedAt: number;
  activity?: string;
  usage: DelegationUsage;
}

// ------------------------------------------------------------------ deps and requests

export interface RunnerDeps {
  /** Defaults to the real `node:child_process` spawn. */
  spawnFn?: SpawnFn;
  /** SIGTERM → SIGKILL grace, ms. Default 5000 (R8); 0 in every test fixture. */
  escalateAfterMs?: number;
  logSink?: LogSinkFactory;
  notifyComplete?: (note: DelegationNote) => void;
  onUpdate?: (progress: DelegationProgress) => void;
  /** Injectable warning hook — a log-sink failure warns exactly once per run (T62). */
  warn?: (message: string) => void;
  /** Injected clock; the only Date.now() boundary in this module. */
  now?: () => number;
  /** Liveness watchdog (RR2), ms of stream silence before the run aborts lost. Default
   * RUN_WATCHDOG_MS (600_000); 0 = off (the test-fixture idiom). Re-clamped at the arm site. */
  runWatchdogMs?: number;
  /** Synchronous terminal callback — the registry releases admission and dequeues here (row 39). */
  onSettle?: (record: DelegationRecord) => void;
}

/** The runner's exported clock boundary — the one Date.now() in the module. */
export const defaultNow = (): number => Date.now();

export interface RunRequest {
  id: string;
  /** PKG-3: the registry-minted global GUID, passed through to the record and run header. */
  globalId?: string;
  agent: string;
  task: string;
  /** Full child argv; the runner never builds argv (that is the tool layer's job, row 1). */
  args: string[];
  /** Model-pin fallback argv (f: 2026-09-02, owner ruling "the model part is fully optional
   * — never fail a delegation on it"): when the FIRST child closes exit-1 with a
   * model-startup failure on stderr and no progress event was parsed, the runner respawns
   * ONCE with these args under the SAME run id (one header, one exit line, one note — the
   * retry is not a second delegation). Built by the tool layer beside `args` (row 1);
   * absent or equal to `args` = no retry. The fallback is RECORDED (`record.modelFallback`),
   * never silent and never fatal. */
  fallbackArgs?: string[];
  command?: string;
  cwd: string;
  sessionId?: string;
  toolCallId?: string;
  /** Request time — queued runs keep it so start-order sorting is stable (R7). */
  startedAt: number;
  /** Caller's abort signal; already-aborted → the run settles aborted without spawning (row 37). */
  signal?: AbortSignal;
  /** Per-run timeout request, ms (RR1): re-clamped at the timer site; undefined/0 = no timeout.
   * The clock starts at spawn — queue wait is admission's business (RR4). */
  timeoutMs?: number;
}

export interface RunHandle {
  /** Live record — the runner mutates pid/usage/activity/state in place. */
  record: DelegationRecord;
  /** Resolves once with the terminal record snapshot. */
  done: Promise<DelegationRecord>;
  /** SIGTERM → escalateAfterMs grace → SIGKILL (cancelled when the child closes first); settles aborted (R8). */
  abort(): void;
  /** SIGKILL immediately, no timers — the process-exit hook's path (T64). */
  killImmediate(): void;
}

// ------------------------------------------------------------------ runner

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface TeeState {
  /** Undefined once failed (T62) or when no factory was configured. */
  sink: RunLogSink | undefined;
  headerLine: string;
  stderrLines: string[];
}

interface RunState {
  request: RunRequest;
  record: DelegationRecord;
  usage: DelegationUsage;
  /** Display floor from message_update cumulative reports; the settled record never uses it. */
  liveUsage: DelegationUsage;
  events: ChildEvent[];
  activity?: string;
  child: ChildLike | undefined;
  sawClose: boolean;
  settled: boolean;
  settleKind: "exit" | "spawnError" | "aborted" | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the per-run timeout fired — stamps abortReason "timeout" on the settle (RR2). */
  timedOut: boolean;
  watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  /** The applied (clamped) watchdog threshold; undefined = off — nothing arms or resets. */
  watchdogMs: number | undefined;
  /** Set when the watchdog fired — stamps abortReason "lost" + watchdogMs on the settle (RR2). */
  lostByWatchdog: boolean;
  tee: TeeState | undefined;
  stdoutAccum: string;
  rawStderr: string;
  buffer: string;
  warned: boolean;
  /** Model-pin fallback spent — the retry fires at most once per run (f: 2026-09-02). */
  retried: boolean;
  /** Where the CURRENT attempt's events start — the respawn appends after it, so the
   * settled answer is the respawned attempt's, never the failed attempt's. */
  attemptStart: number;
  deferred: Deferred<DelegationRecord>;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** Progress events worth pushing to onUpdate (rows 26; pi's example emits per message_end). */
function isProgressEvent(event: ChildEvent): boolean {
  return (
    event.type === "message_update" ||
    event.type === "message_end" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  );
}

export class DelegationRunner {
  private readonly deps: RunnerDeps;
  private readonly now: () => number;
  private readonly escalateAfterMs: number;
  private readonly spawnFn: SpawnFn;

  constructor(deps: RunnerDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? defaultNow;
    this.escalateAfterMs = deps.escalateAfterMs ?? 5000;
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
  }

  run(request: RunRequest): RunHandle {
    const deferred = createDeferred<DelegationRecord>();
    const record: DelegationRecord = {
      id: request.id,
      ...(request.globalId !== undefined ? { globalId: request.globalId } : {}),
      agent: request.agent,
      task: request.task,
      // P1's record requires toolCallId (identity field); P3 always supplies one — "" marks a
      // run that never had a tool call (registry-internal or direct-runner usage).
      toolCallId: request.toolCallId ?? "",
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      state: "running",
      startedAt: request.startedAt,
      exitCode: null,
    };
    const state: RunState = {
      request,
      record,
      usage: emptyUsage(),
      liveUsage: emptyUsage(),
      events: [],
      child: undefined,
      sawClose: false,
      settled: false,
      settleKind: undefined,
      graceTimer: undefined,
      timeoutTimer: undefined,
      timedOut: false,
      watchdogTimer: undefined,
      watchdogMs: undefined,
      lostByWatchdog: false,
      tee: undefined,
      stdoutAccum: "",
      rawStderr: "",
      buffer: "",
      warned: false,
      retried: false,
      attemptStart: 0,
      deferred,
      signal: request.signal,
      onAbort: undefined,
    };
    const handle: RunHandle = {
      record,
      done: deferred.promise,
      abort: () => this.abortRun(state),
      killImmediate: () => this.sendSignal(state, "SIGKILL"),
    };

    const tee = this.openTee(state);
    state.tee = tee;

    if (request.signal?.aborted) {
      // Row 37: an already-aborted signal never spawns — settle aborted, no child, loud note.
      this.writeHeader(state, undefined);
      this.settleAborted(state);
      return handle;
    }

    let child: ChildLike;
    try {
      child = this.spawnFn(request.command ?? "pi", request.args, { cwd: request.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.writeHeader(state, undefined);
      this.settleSpawnError(state, error instanceof Error ? error.message : String(error));
      return handle;
    }
    state.child = child;
    // The record is the status surface's source of truth: the widget, `delegate list` and
    // R8's orphan pid probe all read it. Smoke row 52 (real child) caught this — FakeChild
    // has no pid, so the ungated suite never could.
    if (child.pid !== undefined) state.record.pid = child.pid;
    this.writeHeader(state, child.pid);

    this.wireChild(state, child);
    this.armTimers(state, request);

    if (request.signal) {
      const onAbort = () => this.abortRun(state);
      state.onAbort = onAbort;
      request.signal.addEventListener("abort", onAbort, { once: true });
    }

    return handle;
  }

  /** Wire one spawned child's streams into the run state — shared by the first spawn and the
   * model-fallback retry (f: 2026-09-02); the retry is the same run, same handlers. */
  private wireChild(state: RunState, child: ChildLike): void {
    child.stdout?.on("data", (chunk) => this.feedStdout(state, chunk));
    child.stderr?.on("data", (chunk) => this.feedStderr(state, chunk));
    child.on("close", (code, signal) => this.onClose(state, code, signal));
    child.on("error", (error) => this.onChildError(state, error));
  }

  /** Arm the per-run timeout and the liveness watchdog after a successful spawn. Re-armed by
   * the model-fallback retry: the attempt clock restarts at the new spawn (RR4/S5 — "the
   * clock starts at spawn"; a retry IS a spawn). */
  private armTimers(state: RunState, request: RunRequest): void {
    // RR4/S5: the value is re-clamped (never trust the caller's clamp: registry and
    // direct-runner paths both land here); expiry rides abortRun (R8's one kill path — no
    // second kill implementation). finishSettle and onClose clear it; abortRun's settled
    // guard absorbs a late fire (T81/T82).
    const appliedTimeoutMs = clampRunTimeoutMs(request.timeoutMs);
    if (appliedTimeoutMs !== undefined) {
      state.record.timeoutMs = appliedTimeoutMs; // observable while running (T85)
      state.timeoutTimer = setTimeout(() => {
        state.timeoutTimer = undefined;
        state.timedOut = true;
        this.abortRun(state);
      }, appliedTimeoutMs);
    }

    // RR2: the watchdog arms beside the timeout — no activity (no parsed stream event) for N ms
    // kills through abortRun (R8's one kill path; the watchdog adds no kill implementation).
    // 0 = off; the value re-clamps here, never trusting the caller's clamp (S5).
    const appliedWatchdogMs = clampRunWatchdogMs(this.deps.runWatchdogMs);
    if (appliedWatchdogMs !== undefined) {
      state.watchdogMs = appliedWatchdogMs;
      this.armWatchdog(state);
    }
  }

  // ------------------------------------------------------------------ stream wiring

  private feedStdout(state: RunState, chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    state.stdoutAccum += text;
    state.buffer += text;
    let newline = state.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      this.handleLine(state, line);
      newline = state.buffer.indexOf("\n");
    }
  }

  private feedStderr(state: RunState, chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    state.rawStderr += text;
    state.tee?.stderrLines.push(JSON.stringify({ type: "stderr", text }));
  }

  private handleLine(state: RunState, line: string): void {
    const event = parseChildEvent(line);
    if (!event) return; // row 30: garbage is skipped from the event stream, the tee kept the raw line
    if (!state.settled) this.resetWatchdog(state); // S1: every parsed event is activity; the settled gate keeps the lost-settle close tail-flush path from re-arming an orphan watchdog (RR2)
    state.events.push(event);
    const previewChunk = previewTextFromEvent(event);
    if (previewChunk) {
      // P2 live preview: the capped tail stamped on the shared record BEFORE onUpdate (M3),
      // so peek rides registry.get/list with no new seams. O(cap). Settle/notify untouched.
      state.record.answerPreview = capTail(`${state.record.answerPreview ?? ""}${previewChunk}`, PEEK_PREVIEW_MAX_CHARS);
    }
    applyUsage(state.usage, event);
    applyLiveUsage(state.liveUsage, event); // display floor: cumulative provider reports (see core)
    state.record.usage = applyLiveUsage({ ...state.usage }, event); // live view — settle overwrites with the sum
    const activity = deriveActivity(event);
    if (activity) state.record.activity = activity;
    if (isProgressEvent(event)) {
      this.deps.onUpdate?.({
        id: state.record.id,
        agent: state.record.agent,
        state: "running",
        startedAt: state.record.startedAt,
        ...(state.record.activity !== undefined ? { activity: state.record.activity } : {}),
        usage: { ...state.record.usage }, // live merged view (sum ∨ cumulative floor)
      });
    }
  }

  private onClose(state: RunState, code: number | null, signal: string | null): void {
    state.sawClose = true; // the runner's own close flag — never the child's `killed` (rows 35/36)
    if (state.graceTimer !== undefined) {
      clearTimeout(state.graceTimer);
      state.graceTimer = undefined;
    }
    if (state.timeoutTimer !== undefined) {
      clearTimeout(state.timeoutTimer); // T81: a natural close beats the timer — no late kill
      state.timeoutTimer = undefined;
    }
    if (state.watchdogTimer !== undefined) {
      clearTimeout(state.watchdogTimer); // T111: a natural close beats the watchdog — no late kill
      state.watchdogTimer = undefined;
    }
    if (state.buffer.length > 0) {
      // Row 29: a trailing line without its newline is flushed on close.
      const tail = state.buffer;
      state.buffer = "";
      this.handleLine(state, tail);
    }
    if (!state.settled) {
      const failure = this.retryFailure(state, code, signal);
      if (failure !== undefined) {
        // The child failed on its model — the persona's pin could not START it (the d-324
        // class) or the provider ran out of credits (a 402). Respawn once on the fallback
        // argv under the same run id instead of failing the delegation.
        this.beginFallbackRetry(state, failure);
        return;
      }
    }
    this.writeTeeStreams(state); // final output belongs to the log even when already settled
    if (!state.settled) this.settleExit(state, code, signal);
  }

  private onChildError(state: RunState, error: Error): void {
    if (state.settled) return;
    // Asynchronous spawn failure (ENOENT et al.) — same treatment as a throwing spawnFn (row 33).
    this.settleSpawnError(state, error instanceof Error ? error.message : String(error));
  }

  // ------------------------------------------------------ model-pin fallback (f: 2026-09-02)

  /** The ONE retry decision: does this failed child respawn on the parent model, and why?
   *
   * Two failure classes arm it, each with its own guards:
   *  - a model STARTUP failure (the d-324 class): the child died a natural exit-1 with the
   *    startup signature on stderr and no PROGRESS event parsed (pi emits a session header
   *    on stdout BEFORE resolving auth — the d-324 log proves it — so "no events" would
   *    never fire). Ordinary task stderr never retries.
   *  - a BILLING failure (HTTP 402): the child's LAST assistant turn ended on a provider
   *    402. That is an API error inside a LIVE child — it exits 0 and its stderr says
   *    nothing — so neither the exit code nor a progress event can rule it out, and the
   *    parent's model may still serve the task. The respawn re-runs the task from the
   *    start, so a child that had already produced output repeats it on the parent model.
   *
   * The two classes cannot both apply: the startup class demands that NO progress event
   * was parsed, and a 402 turn is a `message_end` — a progress event. The startup class is
   * checked first because a child that never reached the provider has no 402 to report.
   *
   * Shared guards: a fallback argv must exist and differ from the primary argv, the retry
   * fires at most once, and a child killed by a signal is never respawned.
   *
   * Returns the failure (its class and the reason it records) or undefined for no respawn. */
  private retryFailure(state: RunState, code: number | null, signal: string | null): RetryFailure | undefined {
    const fallbackArgs = state.request.fallbackArgs;
    if (!fallbackArgs || state.retried) return undefined;
    if (JSON.stringify(fallbackArgs) === JSON.stringify(state.request.args)) return undefined;
    if (signal !== null) return undefined;
    if (code === 1 && !state.events.some((event) => isProgressEvent(event)) && isModelStartupFailure(state.rawStderr)) {
      return { cls: "model-startup", reason: (firstNonEmptyLine(state.rawStderr) ?? "model startup failure").slice(0, 160) };
    }
    const billing = billingFailureReason(state.events);
    if (billing !== undefined) return { cls: "billing", reason: providerReasonText(billing) };
    const unavailable = modelUnavailableReason(state.events);
    if (unavailable !== undefined) return { cls: "model-startup", reason: providerReasonText(unavailable) };
    return undefined;
  }

  /** Respawn ONCE on the fallback argv under the same run id: flush attempt-1's output to the
   * tee, reset the per-attempt buffers, record the reason on the record, and re-wire + re-arm.
   * The log keeps ONE run header and gets ONE exit line — the retry is not a second run, so
   * reconstruction and accounting see exactly what they always saw. */
  private beginFallbackRetry(state: RunState, failure: RetryFailure): void {
    const request = state.request;
    const fallbackArgs = request.fallbackArgs!;
    const pin = modelFlagValue(request.args);
    const target = modelFlagValue(fallbackArgs);
    const cause = failure.cls === "billing" ? "hit a provider billing failure" : "was rejected";
    state.retried = true;
    state.record.modelFallback = `--model ${pin ?? "?"} ${cause} (${failure.reason}) — retried on ${target ? `--model ${target}` : "the child's default model"}`;

    // Attempt-1 output lands in the log first; then the buffers reset so the final flush and
    // the failure-note tails describe the attempt that actually settled. The EVENTS of the
    // failed attempt stay in the log but not in the answer: the settled answer is the
    // respawned attempt's, so a failed attempt's partial text is never reported as the
    // run's answer.
    this.writeTeeStreams(state);
    if (state.tee) state.tee.stderrLines = [];
    state.stdoutAccum = "";
    state.rawStderr = "";
    state.buffer = "";
    state.attemptStart = state.events.length;
    this.teeAppend(state, JSON.stringify({ type: "stderr", text: `ai-badger: ${state.record.modelFallback}` }));

    try {
      const child = this.spawnFn(request.command ?? "pi", fallbackArgs, { cwd: request.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      state.child = child;
      if (child.pid !== undefined) state.record.pid = child.pid;
      this.wireChild(state, child);
      this.armTimers(state, request);
    } catch (error) {
      // The command spawned once already — this is near-impossible; settle honestly if it happens.
      this.settleSpawnError(state, error instanceof Error ? error.message : String(error));
    }
  }

  // ------------------------------------------------------------------ kill paths (R8, review CR5)

  private abortRun(state: RunState): void {
    if (state.settled) return; // idempotent — exactly one note per run; killing a dead child is skipped (T63)
    this.sendSignal(state, "SIGTERM");
    if (state.graceTimer !== undefined) return; // already escalating — no double timer (T63)
    state.graceTimer = setTimeout(() => {
      state.graceTimer = undefined;
      if (!state.sawClose) this.sendSignal(state, "SIGKILL");
    }, this.escalateAfterMs);
    this.settleAborted(state);
  }

  private sendSignal(state: RunState, signal: string): void {
    const child = state.child;
    if (!child) return;
    try {
      child.kill(signal);
    } catch {
      // ESRCH / already dead — tolerated (T63, review CR5)
    }
  }

  // ------------------------------------------------------------------ liveness watchdog (RR2)

  /** (Re)arm the inactivity deadline. Fires only while unsettled: the run is killed through
   * abortRun (R8's one kill path) and settles aborted + abortReason "lost" with watchdogMs. */
  private armWatchdog(state: RunState): void {
    state.watchdogTimer = setTimeout(() => {
      state.watchdogTimer = undefined;
      state.lostByWatchdog = true;
      this.abortRun(state);
    }, state.watchdogMs!);
  }

  /** Every parsed stream event pushes the deadline (S1, not just message_update); a no-op
   * when the watchdog is off or already fired. */
  private resetWatchdog(state: RunState): void {
    if (state.watchdogTimer === undefined) return;
    clearTimeout(state.watchdogTimer);
    this.armWatchdog(state);
  }

  // ------------------------------------------------------------------ log tee (R4)

  private openTee(state: RunState): TeeState | undefined {
    if (!this.deps.logSink) return undefined;
    try {
      const sink = this.deps.logSink({ id: state.record.id, agent: state.record.agent, task: state.record.task, ...(state.record.globalId !== undefined ? { globalId: state.record.globalId } : {}) });
      return { sink, headerLine: "", stderrLines: [] };
    } catch (error) {
      this.warnOnce(state, error); // the factory itself is a sink operation (T62)
      return undefined;
    }
  }

  private teeAppend(state: RunState, line: string): void {
    const tee = state.tee;
    if (!tee || !tee.sink) return;
    try {
      tee.sink.appendLine(line);
    } catch (error) {
      tee.sink = undefined; // first failure disables the sink for the run; state untouched (T62)
      if (state.record.logFile !== undefined) state.record.logFile = undefined;
      this.warnOnce(state, error);
    }
  }

  private writeHeader(state: RunState, pid: number | undefined): void {
    const tee = state.tee;
    if (!tee) return;
    tee.headerLine = JSON.stringify({
      type: "run",
      runId: state.record.id,
      ...(state.record.globalId !== undefined ? { globalId: state.record.globalId } : {}),
      agent: state.record.agent,
      persona: state.record.agent, // R4 names the field `persona`; both spellings ride the header
      task: state.record.task,
      argv: state.request.args,
      cwd: state.request.cwd,
      ...(pid !== undefined ? { pid } : {}),
      startedAt: state.record.startedAt,
      ...(state.record.sessionId !== undefined ? { sessionId: state.record.sessionId } : {}),
    });
    this.teeAppend(state, tee.headerLine);
    if (tee.sink && tee.sink.logFile) state.record.logFile = tee.sink.logFile;
  }

  private writeTeeStreams(state: RunState): void {
    const tee = state.tee;
    if (!tee || !tee.sink) return;
    if (state.stdoutAccum.length > 0) {
      // Cap discipline via the frozen core (T56): the header was already streamed at spawn,
      // so the elided section lands without it — the file keeps exactly one header line.
      const composed = elideTeeStream(tee.headerLine, state.stdoutAccum, DEFAULT_TEE_CAP_BYTES);
      const body = composed.slice(tee.headerLine.length + 1);
      if (body.trim().length > 0) this.teeAppend(state, body);
    }
    for (const line of tee.stderrLines) this.teeAppend(state, line);
  }

  private warnOnce(state: RunState, error: unknown): void {
    if (state.warned) return;
    state.warned = true;
    const detail = error instanceof Error ? error.message : String(error);
    const message = `ai-badger: delegation ${state.record.id}: log unavailable (${detail}) — continuing without a log; the delegation itself is unaffected`;
    if (this.deps.warn) this.deps.warn(message);
    else console.error(message);
  }

  // ------------------------------------------------------------------ settling

  private settleExit(state: RunState, code: number | null, signal: string | null): void {
    this.teeAppend(
      state,
      JSON.stringify({ type: "exit", exitCode: code, ...(signal ? { signal } : {}), endedAt: this.now() }),
    );
    state.record.exitCode = code;
    state.record.state = signal ? "aborted" : "completed"; // non-zero exits stay completed (row 20 renders "exited N")
    this.finishSettle(state, "exit");
  }

  private settleSpawnError(state: RunState, error: string): void {
    this.teeAppend(state, JSON.stringify({ type: "spawnError", error })); // row 16's reconstruction marker
    state.record.spawnError = error;
    state.record.state = "failed";
    this.finishSettle(state, "spawnError");
  }

  private settleAborted(state: RunState): void {
    state.record.state = "aborted"; // no exitCode — R5's aborted shape
    if (state.timedOut) state.record.abortReason = "timeout"; // RR2: the one distinguishing marker
    else if (state.lostByWatchdog) {
      state.record.abortReason = "lost"; // RR2: the watchdog's marker
      if (state.watchdogMs !== undefined) state.record.watchdogMs = state.watchdogMs;
    }
    this.finishSettle(state, "aborted");
  }

  private finishSettle(state: RunState, kind: "exit" | "spawnError" | "aborted"): void {
    if (state.settled) return; // exactly one settle per run (double-close, late close after abort)
    state.settled = true;
    state.settleKind = kind;
    if (state.timeoutTimer !== undefined) {
      clearTimeout(state.timeoutTimer); // RR4: the timer never outlives the settle (T81/T82/T83)
      state.timeoutTimer = undefined;
    }
    if (state.watchdogTimer !== undefined) {
      clearTimeout(state.watchdogTimer); // RR2: any settle clears both timers (T111/T112/T113)
      state.watchdogTimer = undefined;
    }
    if (state.onAbort && state.signal) {
      state.signal.removeEventListener("abort", state.onAbort);
      state.onAbort = undefined;
    }
    state.record.endedAt = this.now();
    state.record.usage = { ...state.usage };
    this.deps.onSettle?.(state.record); // synchronous: the registry releases admission and dequeues here (row 39)
    state.deferred.resolve({ ...state.record, usage: { ...state.usage } });
    this.notify(state);
  }

  private notify(state: RunState): void {
    if (!this.deps.notifyComplete) return;
    const record = state.record;
    const exitCode = record.exitCode ?? null;
    const answer = extractAnswer(state.events.slice(state.attemptStart), exitCode);
    const note: DelegationNote = {
      id: record.id,
      agent: record.agent,
      task: record.task,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      state: record.state as "completed" | "failed" | "aborted",
      answer: capTail(answer.kind === "text" ? answer.text : ""),
      usage: { ...state.usage },
      durationMs: record.endedAt !== undefined ? Math.max(0, record.endedAt - record.startedAt) : undefined,
      ...(record.logFile !== undefined ? { logFile: record.logFile } : {}),
    };
    if (state.settleKind === "exit") note.exitCode = exitCode;
    if (record.abortReason !== undefined) note.abortReason = record.abortReason;
    if (record.timeoutMs !== undefined) note.timeoutMs = record.timeoutMs;
    if (record.watchdogMs !== undefined) note.watchdogMs = record.watchdogMs;
    if (record.spawnError !== undefined) note.spawnError = record.spawnError;
    if (record.modelFallback !== undefined) note.modelFallback = record.modelFallback;
    if (answer.kind === "silent") {
      // R3/CR4: the quiet failure gets a loud marker plus the capped raw stdout.
      note.silentReason = answer.reason;
      note.stdoutTail = capTail(state.stdoutAccum);
    }
    if (state.settleKind === "exit" && exitCode !== 0 && state.rawStderr.length > 0) {
      note.stderrTail = capTail(state.rawStderr); // row 32: the capped stderr tail rides the failure note
    }
    this.deps.notifyComplete(note);
  }
}
