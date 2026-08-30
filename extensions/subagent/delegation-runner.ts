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
  DEFAULT_TEE_CAP_BYTES,
  elideTeeStream,
  emptyUsage,
  extractAnswer,
  parseChildEvent,
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
  usage?: DelegationUsage;
  durationMs?: number;
  /** Absent when no sink was configured or the sink failed mid-run (T62). */
  logFile?: string;
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
  /** Synchronous terminal callback — the registry releases admission and dequeues here (row 39). */
  onSettle?: (record: DelegationRecord) => void;
}

/** The runner's exported clock boundary — the one Date.now() in the module. */
export const defaultNow = (): number => Date.now();

export interface RunRequest {
  id: string;
  agent: string;
  task: string;
  /** Full child argv; the runner never builds argv (that is the tool layer's job, row 1). */
  args: string[];
  command?: string;
  cwd: string;
  sessionId?: string;
  toolCallId?: string;
  /** Request time — queued runs keep it so start-order sorting is stable (R7). */
  startedAt: number;
  /** Caller's abort signal; already-aborted → the run settles aborted without spawning (row 37). */
  signal?: AbortSignal;
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
  events: ChildEvent[];
  activity?: string;
  child: ChildLike | undefined;
  sawClose: boolean;
  settled: boolean;
  settleKind: "exit" | "spawnError" | "aborted" | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  tee: TeeState | undefined;
  stdoutAccum: string;
  rawStderr: string;
  buffer: string;
  warned: boolean;
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

/** One-line activity label from the live stream (R9's `currentActivity`). */
function deriveActivity(event: ChildEvent): string | undefined {
  if (event.type === "tool_execution_start" && typeof event.toolName === "string" && event.toolName.trim()) {
    return event.toolName;
  }
  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;
    if (typeof ame === "object" && ame !== null) {
      const { type, delta, toolName } = ame as { type?: unknown; delta?: unknown; toolName?: unknown };
      if (type === "toolcall_start" && typeof toolName === "string" && toolName.trim()) return toolName;
      if (typeof delta === "string" && delta.trim()) {
        const tail = delta.trim().slice(-80);
        return delta.trim().length > 80 ? `…${tail}` : tail;
      }
    }
  }
  return undefined;
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
      events: [],
      child: undefined,
      sawClose: false,
      settled: false,
      settleKind: undefined,
      graceTimer: undefined,
      tee: undefined,
      stdoutAccum: "",
      rawStderr: "",
      buffer: "",
      warned: false,
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
    this.writeHeader(state, child.pid);

    child.stdout?.on("data", (chunk) => this.feedStdout(state, chunk));
    child.stderr?.on("data", (chunk) => this.feedStderr(state, chunk));
    child.on("close", (code, signal) => this.onClose(state, code, signal));
    child.on("error", (error) => this.onChildError(state, error));

    if (request.signal) {
      const onAbort = () => this.abortRun(state);
      state.onAbort = onAbort;
      request.signal.addEventListener("abort", onAbort, { once: true });
    }

    return handle;
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
    state.events.push(event);
    applyUsage(state.usage, event);
    state.record.usage = { ...state.usage }; // live usage for status surfaces
    const activity = deriveActivity(event);
    if (activity) state.record.activity = activity;
    if (isProgressEvent(event)) {
      this.deps.onUpdate?.({
        id: state.record.id,
        agent: state.record.agent,
        state: "running",
        startedAt: state.record.startedAt,
        ...(state.record.activity !== undefined ? { activity: state.record.activity } : {}),
        usage: { ...state.usage },
      });
    }
  }

  private onClose(state: RunState, code: number | null, signal: string | null): void {
    state.sawClose = true; // the runner's own close flag — never the child's `killed` (rows 35/36)
    if (state.graceTimer !== undefined) {
      clearTimeout(state.graceTimer);
      state.graceTimer = undefined;
    }
    if (state.buffer.length > 0) {
      // Row 29: a trailing line without its newline is flushed on close.
      const tail = state.buffer;
      state.buffer = "";
      this.handleLine(state, tail);
    }
    this.writeTeeStreams(state); // final output belongs to the log even when already settled
    if (!state.settled) this.settleExit(state, code, signal);
  }

  private onChildError(state: RunState, error: Error): void {
    if (state.settled) return;
    // Asynchronous spawn failure (ENOENT et al.) — same treatment as a throwing spawnFn (row 33).
    this.settleSpawnError(state, error instanceof Error ? error.message : String(error));
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

  // ------------------------------------------------------------------ log tee (R4)

  private openTee(state: RunState): TeeState | undefined {
    if (!this.deps.logSink) return undefined;
    try {
      const sink = this.deps.logSink({ id: state.record.id, agent: state.record.agent, task: state.record.task });
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
    this.finishSettle(state, "aborted");
  }

  private finishSettle(state: RunState, kind: "exit" | "spawnError" | "aborted"): void {
    if (state.settled) return; // exactly one settle per run (double-close, late close after abort)
    state.settled = true;
    state.settleKind = kind;
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
    const answer = extractAnswer(state.events, exitCode);
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
    if (record.spawnError !== undefined) note.spawnError = record.spawnError;
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
