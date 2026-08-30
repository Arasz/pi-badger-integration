/**
 * Manually-driven stand-in for a spawned delegation child (tests doc flake conventions).
 *
 * Two properties make the P2 rows testable and are contractual for every fixture:
 *
 *   1. `kill()` RECORDS the signal and never auto-exits — tests decide death. This is what
 *      makes the escalation rows (35/36) and T63/T64 work at all: pi's own subagent example
 *      gates its SIGKILL on `proc.killed`, which is already true after a successful
 *      kill("SIGTERM"), so that guard can never fire; the runner must gate on its own
 *      saw-close state instead, and only a child that ignores kills can witness that.
 *   2. `exit()`/`fail()` emit `close`/`error` SYNCHRONOUSLY from the drive call — a test's
 *      next line observes every runner reaction (note delivery, queue dequeue-spawn) without
 *      awaiting a tick.
 */

import { EventEmitter } from "node:events";
import type { ChildLike } from "../../extensions/subagent/delegation-runner.ts";

export class FakeChild extends EventEmitter implements ChildLike {
  static nextPid = 4200;

  readonly pid: number;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;

  exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  killed = false;
  /** Every signal passed to `kill()`, in arrival order (rows 35/36, T63/T64). */
  signals: string[] = [];
  spawnError: Error | undefined;

  constructor(pid: number = ++FakeChild.nextPid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  /** Raw bytes onto the child's stdout — what the runner's line buffer consumes. */
  write(chunk: string): void {
    this.stdout.emit("data", chunk);
  }

  /** One JSON event line on stdout. */
  emitEvent(event: unknown): void {
    this.write(JSON.stringify(event) + "\n");
  }

  /** One JSON event line delivered as two stdout chunks — line-buffering discipline (row 28). */
  emitSplit(event: unknown): void {
    const line = JSON.stringify(event);
    const cut = Math.max(1, Math.floor(line.length / 2));
    this.write(line.slice(0, cut));
    this.write(line.slice(cut) + "\n");
  }

  /** Raw bytes onto the child's stderr. */
  stderrWrite(text: string): void {
    this.stderr.emit("data", text);
  }

  /** Asynchronous spawn failure (`error` event path); row 33's throw path is a throwing spawnFn. */
  fail(error: string | Error): void {
    const err = typeof error === "string" ? new Error(error) : error;
    this.spawnError = err;
    this.emit("error", err);
  }

  /** Record the signal and keep running — tests decide death (flake conventions). */
  kill(signal: string = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    this.emit("kill", signal);
    return true;
  }

  /** Synchronous death: `exit` then `close` fire before exit() returns. */
  exit(code: number | null, signal: string | null = null): void {
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
