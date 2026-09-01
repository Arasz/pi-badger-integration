/**
 * Registry for interactive background subagent delegation (plan §2 R11 module map: "records,
 * queue, wait, abortAll, pi.events transition snapshots").
 *
 * The registry owns admission (P1's pure `admitRequest`/`releaseRun` — one policy for every
 * call, R7), the queued-run bookkeeping (T59/T61), the `DelegationRecord` map, `wait()` (R6:
 * timeout resolves with per-id snapshots, never a timeout error — T65), abort/abortAll/shutdown
 * (R8: queued aborts without a kill, dequeue re-checks the aborted flag, shutdown drops
 * notifications) and one serializable transition snapshot per state change through an
 * injectable `emit` hook (T60; P3 wires it to pi.events).
 *
 * This module never touches processes — spawning and killing go through `DelegationRunner` —
 * and imports neither pi nor node:child_process directly.
 */

import {
  admitRequest,
  DEFAULT_ADMISSION_CAP,
  DEFAULT_QUEUE_CAP,
  emptyAdmission,
  enqueueGroup as enqueueGroupInCore,
  releaseRun,
  removePending,
  type AdmissionCaps,
  type DelegationRecord,
  type DelegationState,
  type GroupMode,
} from "./delegation-core.ts";
import { DelegationRunner, defaultNow, type DelegationNote, type RunnerDeps, type RunHandle } from "./delegation-runner.ts";

// ------------------------------------------------------------------ public shapes

/** Sketch §4 shape plus the additive hooks P2 needs (warn/now/emit/allocateId). */
export type DelegationDeps = Omit<RunnerDeps, "onSettle"> & {
  /** ≤ cap running. Default 4 (R7, env-wired by P3). */
  cap?: number;
  /** ≤ queueCap queued FIFO; beyond it every call is rejected loudly (T58). */
  queueCap?: number;
  /** Injectable pi.events wire (P3): one serializable snapshot per state transition (T60). */
  emit?: (transition: DelegationTransition) => void;
  /** Run-id allocation; default is an in-memory `d-<n>` counter (P3 injects the log-dir-aware allocator, T53/T73). */
  allocateId?: () => string;
};

/** Frozen at P2 landing (plan §4 freeze point 2): serializable snapshot per state transition. */
export interface DelegationTransition {
  id: string;
  agent: string;
  task: string;
  state: DelegationState;
  /** Previous emitted state; absent on the first transition of a run. */
  previousState?: DelegationState;
  at: number;
  record: DelegationRecord;
}

export interface StartRequest {
  agent: string;
  task: string;
  /** Full child argv (tool layer builds it; row 1). */
  args: string[];
  command?: string;
  cwd: string;
  toolCallId?: string;
  sessionId?: string;
  /** Caller's abort signal (the tool execute signal; row 37). */
  signal?: AbortSignal;
  /** Per-run timeout request, ms (RR1): pass-through — the runner re-clamps at the timer site;
   * the clock starts when the child spawns, not while queued. */
  timeoutMs?: number;
  /** Explicit run id (P3 allocates over the log dir); default is registry-allocated. */
  id?: string;
}

export interface DelegationReceipt {
  ok: true;
  id: string;
  /** Snapshot at start: `running`, `queued` (with queuePosition) or `aborted` (row 37). */
  record: DelegationRecord;
  /** Blocking callers await this; resolves with the terminal snapshot (T59). */
  done: Promise<DelegationRecord>;
}

export type StartOutcome = DelegationReceipt | { ok: false; reason: string };

/** One member's receipt from `enqueueGroup`: the group and mode the member was enqueued under. */
export interface DelegationGroupReceipt extends DelegationReceipt {
  groupId: string;
  mode: GroupMode;
}

export type GroupMemberOutcome = DelegationGroupReceipt | { ok: false; reason: string };

export function snapshotRecord(record: DelegationRecord): DelegationRecord {
  return { ...record, usage: record.usage ? { ...record.usage } : undefined };
}

// ------------------------------------------------------------------ registry

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

function isTerminal(state: DelegationState): boolean {
  return state === "completed" || state === "failed" || state === "aborted";
}

interface Waiter {
  ids: string[];
  resolve(snapshots: DelegationRecord[]): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class DelegationRegistry {
  private readonly deps: DelegationDeps;
  private readonly caps: AdmissionCaps;
  private readonly runner: DelegationRunner;
  private readonly now: () => number;

  private admission = emptyAdmission();
  private readonly records = new Map<string, DelegationRecord>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly deferreds = new Map<string, Deferred<DelegationRecord>>();
  private readonly queuedRequests = new Map<string, StartRequest>();
  private readonly previousStates = new Map<string, DelegationState>();
  private readonly waiters: Waiter[] = [];
  private counter = 0;
  private groupCounter = 0;
  private stopped = false;

  /** The one notification wire: R5 delivers on every terminal transition except
   * shutdown-initiated ones (row 38) — the runner's settles and the registry's queued-abort
   * note both go through here, so the guard cannot be bypassed. */
  private readonly notify = (note: DelegationNote): void => {
    if (!this.stopped) this.deps.notifyComplete?.(note);
  };

  constructor(deps: DelegationDeps = {}) {
    this.deps = deps;
    this.caps = { cap: deps.cap ?? DEFAULT_ADMISSION_CAP, queueCap: deps.queueCap ?? DEFAULT_QUEUE_CAP };
    this.now = deps.now ?? defaultNow;
    this.runner = new DelegationRunner({
      ...deps,
      onSettle: (record) => this.onSettle(record),
      notifyComplete: deps.notifyComplete ? this.notify : undefined,
    });
  }

  async start(request: StartRequest): Promise<StartOutcome> {
    if (this.stopped) {
      return { ok: false, reason: "the delegation runner is shut down — no new delegations can start" };
    }
    if (request.id !== undefined && this.records.has(request.id)) {
      return { ok: false, reason: `duplicate delegation id "${request.id}"` };
    }
    const id = request.id ?? this.deps.allocateId?.() ?? this.nextInternalId();
    const step = admitRequest(this.admission, id, this.caps);
    if (step.decision.action === "reject") {
      // T58: loud rejection with guidance, for background and blocking callers alike (blocking
      // rejection renders as an error result in P3 — never a receipt).
      return {
        ok: false,
        reason: `${step.decision.reason} — wait for a running delegation to finish (delegations wait) or abort one (delegations abort <id>), then retry`,
      };
    }
    this.admission = step.state;
    const deferred = createDeferred<DelegationRecord>();
    this.deferreds.set(id, deferred);

    if (step.decision.action === "queue") {
      const record: DelegationRecord = {
        id,
        agent: request.agent,
        task: request.task,
        toolCallId: request.toolCallId ?? "", // P1 requires the identity field; P3 always supplies one
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        state: "queued",
        startedAt: this.now(), // request time — start-order sorting stays stable (R7)
        exitCode: null,
        queuePosition: step.decision.queuePosition,
      };
      this.records.set(id, record);
      this.queuedRequests.set(id, request);
      this.emitTransition(record);
      return { ok: true, id, record: snapshotRecord(record), done: deferred.promise };
    }

    return this.spawnNow(id, request);
  }

  /**
   * Enqueue one whole group (plan v2 R2/R4 — the queue tool's add/add-parallel backing, P3).
   * Returns one outcome per member: a receipt sharing the group's `groupId` (record state
   * `running` for members the idle drain admitted, `queued` with the flat 1-based
   * `queuePosition` snapshot for waiting members) or, when the admission policy rejects the
   * group all-or-nothing, the same rejection reason for every member. Ids are allocated for
   * every member up front (★M3: 3 members, 3 distinct ids) — `request.id` is ignored on this
   * path, the registry owns allocation.
   *
   * Batch-commit-before-spawn (★B5/Q-B2): the pure enqueue's whole admission state is committed
   * before any member spawns, so a synchronous settle inside an earlier member's spawn can
   * never re-admit a later member.
   */
  async enqueueGroup(requests: StartRequest[], mode: GroupMode): Promise<GroupMemberOutcome[]> {
    if (requests.length === 0) return [];
    if (this.stopped) {
      const reason = "the delegation runner is shut down — no new delegations can start";
      return requests.map(() => ({ ok: false as const, reason }));
    }
    // Allocate-then-register: every id exists before any registration or spawn.
    const ids = requests.map(() => this.deps.allocateId?.() ?? this.nextInternalId());
    const groupId = `g-${++this.groupCounter}`;
    const step = enqueueGroupInCore(this.admission, groupId, mode, ids, this.caps);
    if (step.decision.action === "reject") {
      // All-or-nothing: nothing was registered — every member gets the rejection verbatim
      // (with the same guidance start() appends, surfaced to callers unchanged).
      const reason = `${step.decision.reason} — wait for a running delegation to finish (delegations wait) or abort one (delegations abort <id>), then retry`;
      return requests.map(() => ({ ok: false as const, reason }));
    }
    this.admission = step.state; // the whole drain committed before any spawn (Q-B2)
    const admittedNow = new Set(step.decision.admittedNow);
    const positionOf = new Map(step.decision.queued.map((queued) => [queued.id, queued.queuePosition]));
    const outcomes: GroupMemberOutcome[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const request = requests[i]!;
      const deferred = createDeferred<DelegationRecord>();
      this.deferreds.set(id, deferred);
      if (admittedNow.has(id)) {
        const spawned = this.spawnNow(id, request);
        outcomes.push({ ok: true, id, groupId, mode, record: spawned.record, done: spawned.done });
      } else {
        const record: DelegationRecord = {
          id,
          agent: request.agent,
          task: request.task,
          toolCallId: request.toolCallId ?? "", // P3 always supplies one; "" marks none
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          state: "queued",
          startedAt: this.now(), // request time — start-order sorting stays stable (R7)
          exitCode: null,
          queuePosition: positionOf.get(id),
        };
        this.records.set(id, record);
        this.queuedRequests.set(id, request);
        this.emitTransition(record);
        outcomes.push({ ok: true, id, groupId, mode, record: snapshotRecord(record), done: deferred.promise });
      }
    }
    return outcomes;
  }

  /**
   * Queued-only flush (plan v2 R4 — the queue tool's clear backing, P3): every queued member is
   * aborted through the queued-abort path (no kill — there is no child), running members are
   * untouched, and exactly one aborted notification per member rides the existing notify wire.
   * A member promoted mid-clear (a collapse drained it into running) is spared and reported in
   * `stillRunning`. An empty queue reports `{cancelled: [], stillRunning: [...]}` — loud, not an
   * error (Q-C3 is the tool-level wording).
   */
  clearQueue(): { cancelled: string[]; stillRunning: string[] } {
    const queuedIds = [...this.admission.queue]; // snapshot: abort() mutates the queue
    const cancelled: string[] = [];
    for (const id of queuedIds) {
      const record = this.records.get(id);
      if (record?.state !== "queued") continue; // promoted mid-clear — running now, spared
      this.abort(id);
      cancelled.push(id);
    }
    const cancelledSet = new Set(cancelled);
    const stillRunning = [...this.records.values()]
      .filter((record) => !isTerminal(record.state) && !cancelledSet.has(record.id))
      .map((record) => record.id);
    return { cancelled, stillRunning };
  }

  /** Abort one run: queued → removed with state `aborted` and no kill (T61); running → kill path + aborted. */
  abort(id: string): void {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`ai-badger: unknown delegation id "${id}" — use delegations list for current ids`);
    }
    if (isTerminal(record.state)) return; // idempotent — exactly one notification per run
    if (record.state === "queued") {
      // removePending repairs the group FIFO too (plan v2 R4): a member-level abort lets the
      // group continue; an all-aborted group collapses so the next group can dequeue.
      const removed = removePending(this.admission, id, this.caps);
      this.admission = removed.state;
      record.state = "aborted"; // no kill — there is no child (T61, review CR2)
      record.endedAt = this.now();
      this.queuedRequests.delete(id);
      this.emitTransition(record);
      this.deferreds.get(id)?.resolve(snapshotRecord(record));
      this.deferreds.delete(id);
      this.notify(this.noteForAborted(record)); // R5: aborted-before-start notifies (dropped after shutdown)
      this.checkWaiters();
      if (!this.stopped) {
        for (const promoted of removed.admitted) this.spawnQueued(promoted); // the collapse promoted the next group (Q-A6)
      }
      return;
    }
    this.handles.get(id)?.abort(); // SIGTERM → grace → SIGKILL, settles aborted, releases via onSettle
  }

  /** Abort every live run (queued first, so a synchronous settle cannot spawn fresh work). */
  abortAll(): void {
    for (const record of [...this.records.values()]) {
      if (record.state === "queued") this.abort(record.id);
    }
    for (const record of [...this.records.values()]) {
      if (!isTerminal(record.state)) this.handles.get(record.id)?.abort();
    }
    this.checkWaiters(); // T65: pending waits resolve with terminal states
  }

  /** R8: SIGKILL every live child synchronously — the process-exit hook's path (T64). */
  killAllImmediate(): void {
    for (const record of [...this.records.values()]) {
      if (!isTerminal(record.state)) this.handles.get(record.id)?.killImmediate();
    }
  }

  /** R8: kill everything, drop notifications from here on, resolve pending waits, empty the registry (row 38). */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true; // first — every notification from here on is dropped (row 38)
    this.abortAll();
    this.records.clear();
    this.handles.clear();
    this.deferreds.clear();
    this.queuedRequests.clear();
    this.checkWaiters();
  }

  /** R6/T65: resolve with per-id state snapshots — never a timeout error. */
  async wait(ids?: string[], timeoutMs?: number): Promise<DelegationRecord[]> {
    const targetIds = ids ?? [...this.records.keys()];
    const snapshotNow = (): DelegationRecord[] => targetIds.map((id) => this.snapshotFor(id));
    if (targetIds.every((id) => this.isSettled(id))) return snapshotNow();
    return new Promise<DelegationRecord[]>((resolve) => {
      const waiter: Waiter = { ids: targetIds, resolve, timer: undefined };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(snapshotNow()); // snapshots, never a timeout error (R6/CR10)
        }, timeoutMs);
      }
      this.waiters.push(waiter);
      this.checkWaiters();
    });
  }

  get(id: string): DelegationRecord | undefined {
    const record = this.records.get(id);
    return record ? snapshotRecord(record) : undefined;
  }

  list(): DelegationRecord[] {
    return [...this.records.values()].map(snapshotRecord);
  }

  // ------------------------------------------------------------------ internals

  /** Always admits — admission was committed by the caller; the receipt shape is unconditional. */
  private spawnNow(id: string, request: StartRequest, startedAt?: number): DelegationReceipt {
    // The deferred already exists; a run that settles inside runner.run() (pre-aborted signal,
    // spawn error) fires onSettle synchronously — which resolves AND deletes the deferred — so
    // the promise is captured before spawning.
    const done = this.deferreds.get(id)?.promise ?? Promise.resolve(this.snapshotFor(id));
    const handle = this.runner.run({
      id,
      agent: request.agent,
      task: request.task,
      args: request.args,
      ...(request.command !== undefined ? { command: request.command } : {}),
      cwd: request.cwd,
      ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      startedAt: startedAt ?? this.now(),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
    this.records.set(id, handle.record);
    this.handles.set(id, handle);
    if (handle.record.state === "running") this.emitTransition(handle.record);
    // a run that already settled emitted its terminal transition via onSettle
    return { ok: true, id, record: snapshotRecord(handle.record), done };
  }

  private emitTransition(record: DelegationRecord): void {
    const previousState = this.previousStates.get(record.id);
    this.previousStates.set(record.id, record.state);
    if (!this.deps.emit) return;
    this.deps.emit({
      id: record.id,
      agent: record.agent,
      task: record.task,
      state: record.state,
      ...(previousState !== undefined ? { previousState } : {}),
      at: this.now(),
      record: snapshotRecord(record),
    });
  }

  /** Terminal callback from the runner — synchronous, so the queue dispatch is too (row 39). */
  private onSettle(record: DelegationRecord): void {
    if (this.stopped) return; // late exits after shutdown produce nothing (row 38)
    this.emitTransition(record);
    const release = releaseRun(this.admission, record.id, this.caps);
    this.admission = release.state;
    this.deferreds.get(record.id)?.resolve(snapshotRecord(record));
    this.deferreds.delete(record.id);
    this.checkWaiters();
    for (const admitted of release.admitted) this.spawnQueued(admitted); // zero/one for singles, the whole batch for a parallel head
  }

  /** Spawn one queued member the admission drain already promoted (plan v2 R2): the queue →
   * running move happened inside the pure drain BEFORE this call, so a synchronous settle
   * inside runner.run() releases through releaseRun and finds the id in `running`. */
  private spawnQueued(id: string): void {
    const record = this.records.get(id);
    const request = this.queuedRequests.get(id);
    if (!record || !request) return;
    if (record.state !== "queued") return; // aborted while queued — never spawned
    this.queuedRequests.delete(id);
    // Queued runs keep their request time so start-order sorting stays stable (R7).
    this.spawnNow(id, request, record.startedAt);
  }

  private snapshotFor(id: string): DelegationRecord {
    const record = this.records.get(id);
    if (record) return snapshotRecord(record);
    return { id, agent: "", task: "", toolCallId: "", state: "lost", startedAt: 0 }; // unknown ids are terminal-lost, never an error
  }

  private isSettled(id: string): boolean {
    const record = this.records.get(id);
    return !record || isTerminal(record.state); // unknown ids resolve immediately as lost
  }

  private checkWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (!waiter.ids.every((id) => this.isSettled(id))) continue;
      this.waiters.splice(i, 1);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(waiter.ids.map((id) => this.snapshotFor(id)));
    }
  }

  private noteForAborted(record: DelegationRecord): DelegationNote {
    return {
      id: record.id,
      agent: record.agent,
      task: record.task,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      state: "aborted", // no exitCode — R5's aborted shape (T69)
      answer: "",
      ...(record.usage ? { usage: { ...record.usage } } : {}),
      ...(record.endedAt !== undefined ? { durationMs: Math.max(0, record.endedAt - record.startedAt) } : {}),
      ...(record.logFile !== undefined ? { logFile: record.logFile } : {}),
    };
  }

  private nextInternalId(): string {
    let candidate: string;
    do {
      candidate = `d-${++this.counter}`;
    } while (this.records.has(candidate));
    return candidate;
  }
}
