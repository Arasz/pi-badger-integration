/**
 * Shared fake-pi harness (plan v2 ★Harness — M-4/M2; extracted from tests/subagent-extension.test.ts).
 *
 * A Map-backed stand-in for the `pi` extension API whose `on` stores handler ARRAYS per event
 * (single-slot storage once let session_shutdown's widget cleanup silently overwrite the
 * registry kill-all — the documented regression), plus an EventEmitter-backed ROUTING bus for
 * `pi.events` with real pi bus semantics (dist/core/event-bus.js: `emit(channel, data)`
 * dispatches synchronously to registered handlers; `on` wraps the handler so a throw is
 * contained; an unsubscribe function is returned).
 *
 * API surface (lane B consumes this helper from P6 on — import { createFakePi } here):
 *
 *   const pi = createFakePi({ now?: number });   // mutable injected clock, see below
 *
 *   pi.registerTool(tool)                  → captured into pi.tools (keyed by tool.name)
 *   pi.registerCommand(name, opts)         → captured into pi.commands
 *   pi.registerMessageRenderer(type, fn)   → captured into pi.renderers
 *   pi.on(name, handler)                   → appended to pi.handlers.get(name) (ARRAYS per event)
 *   pi.sendMessage(message, options?)      → pushed onto pi.sent (assert with exact options)
 *   pi.appendEntry(customType, data?)      → pushed onto pi.entries
 *
 *   pi.events.emit(channel, data)          → records into pi.transitions AND dispatches
 *                                            synchronously to subscribers
 *   pi.events.on(channel, handler)         → subscribes (data is the single argument, as on the
 *                                            real bus), records into pi.subscriptions, returns
 *                                            the unsubscribe function
 *   pi.fireTransition(channel, data)       → shorthand for pi.events.emit — simulate a
 *                                            delegation-transition (or any channel) arriving
 *
 *   pi.transitions                         → every emission, in order (the T60 recording surface;
 *                                            existing assertions read it unchanged)
 *   pi.subscriptions                       → every bus subscription {channel, handler}, in order
 *   pi.clock                               → mutable injected clock: pass `now: () => pi.clock.now`
 *                                            as the factory dep, then move time with
 *                                            pi.clock.set(ms) / pi.clock.advance(ms) — no
 *                                            fake-timer library needed for elapsed-time logic.
 */

import { EventEmitter } from "node:events";

export interface FakePiSentMessage {
  message: { customType?: string; content: unknown; display?: boolean; details?: Record<string, unknown> };
  options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
}

export type FakePiHandler = (event: unknown, ctx: unknown) => unknown;
export type FakePiBusHandler = (data: unknown) => unknown;
export type FakePiRenderer = (message: any, options: any, theme: any) => unknown;

export interface FakePiEmission {
  channel: string;
  data: unknown;
}

export interface FakePiSubscription {
  channel: string;
  handler: FakePiBusHandler;
}

/** Mutable injected clock: tests move time; factory deps read it through a closure. */
export class FakeClock {
  constructor(public now: number = 1_700_000_000_000) {}
  set(ms: number): void {
    this.now = ms;
  }
  advance(ms: number): void {
    this.now += ms;
  }
}

export interface FakePiEvents {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: FakePiBusHandler): () => void;
}

export interface FakePi {
  // capture surfaces
  handlers: Map<string, FakePiHandler[]>;
  tools: Map<string, { name: string } & Record<string, unknown>>;
  commands: Map<string, unknown>;
  renderers: Map<string, FakePiRenderer>;
  entryRenderers: Map<string, FakePiRenderer>;
  sent: FakePiSentMessage[];
  entries: Array<{ customType: string; data: unknown }>;
  /** Every events.emit, in order — the T60 recording surface. */
  transitions: FakePiEmission[];
  /** Every events.on subscription, in order, per channel. */
  subscriptions: FakePiSubscription[];
  /** Mutable injected clock — the `now` dep becomes settable. */
  clock: FakeClock;
  /** The routing bus (pi.events). */
  events: FakePiEvents;
  /** Shorthand for events.emit — fire a transition (or any channel) at subscribers. */
  fireTransition(channel: string, data: unknown): void;

  // the pi API surface extensions receive
  registerTool(tool: { name: string } & Record<string, unknown>): void;
  registerCommand(name: string, opts: unknown): void;
  registerMessageRenderer(customType: string, renderer: FakePiRenderer): void;
  registerEntryRenderer(customType: string, renderer: FakePiRenderer): void;
  on(name: string, handler: FakePiHandler): void;
  sendMessage(message: FakePiSentMessage["message"], options?: FakePiSentMessage["options"]): void;
  appendEntry(customType: string, data?: unknown): void;
}

export function createFakePi(options: { now?: number } = {}): FakePi {
  const handlers = new Map<string, FakePiHandler[]>();
  const tools = new Map<string, { name: string } & Record<string, unknown>>();
  const commands = new Map<string, unknown>();
  const renderers = new Map<string, FakePiRenderer>();
  const entryRenderers = new Map<string, FakePiRenderer>();
  const sent: FakePiSentMessage[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const transitions: FakePiEmission[] = [];
  const subscriptions: FakePiSubscription[] = [];
  const clock = new FakeClock(options.now);
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // a fake must not warn a test suite that subscribes widely
  // original handler → wrapped handler, so unsubscribe removes exactly what was registered
  const wrapped = new Map<FakePiBusHandler, FakePiBusHandler>();

  const pi: FakePi = {
    handlers,
    tools,
    commands,
    renderers,
    entryRenderers,
    sent,
    entries,
    transitions,
    subscriptions,
    clock,
    events: {
      emit: (channel, data) => {
        transitions.push({ channel, data }); // record first: handlers observe the emission logged
        bus.emit(channel, data); // synchronous dispatch — real pi bus semantics
      },
      on: (channel, handler) => {
        const safeHandler: FakePiBusHandler = async (data) => {
          try {
            await handler(data);
          } catch (error) {
            console.error(`Event handler error (${channel}):`, error);
          }
        };
        wrapped.set(handler, safeHandler);
        subscriptions.push({ channel, handler: safeHandler });
        bus.on(channel, safeHandler);
        return () => {
          bus.off(channel, safeHandler);
          wrapped.delete(handler);
        };
      },
    },
    fireTransition: (channel, data) => pi.events.emit(channel, data),
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name, opts) => {
      commands.set(name, opts);
    },
    registerMessageRenderer: (customType, renderer) => {
      renderers.set(customType, renderer);
    },
    registerEntryRenderer: (customType, renderer) => {
      entryRenderers.set(customType, renderer);
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    sendMessage: (message, opts) => {
      sent.push({ message, options: opts });
    },
    appendEntry: (customType, data) => {
      entries.push({ customType, data });
    },
  };
  return pi;
}
