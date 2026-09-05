/**
 * Router-failure free-model fallback wiring (PKG-B): observers, switch, `/fallback`.
 *
 * The factory mirrors the subagent/monitor precedent — injected clock, scheduler and
 * env, per-call env reads — and reacts to pi's extension events without ever
 * rewriting them (react-over-rewrite: `message_end` returns `undefined` always).
 *
 * Observer contract:
 * - `after_provider_response` latches `{status, headers}` and NEVER acts;
 * - `message_end` on an assistant error runs the core classifier and NEVER acts;
 * - `agent_end` (payload `{messages}`-only) recomputes retryability from the last
 *   assistant message and switches at most once per episode via the provider seam;
 * - `agent_settled` reaps a latched retryable failure, then mints a fresh episode;
 * - `model_select{source:"set"}` confirms the landing;
 * - `before_provider_request` tags in-flight fallback attempts only.
 *
 * The entire provider seam (Lane C) arrives as injected factory deps typed per F2
 * (`decideNextTarget → {entry,model} | {none,reason}`, `getServingProvider`,
 * `requiredThinking`, `resolveTargets`, `isEligible`). Defaults are safe stubs
 * (empty-eligible, `{none}`); Lane E wires the real selector. PKG-B maps
 * env/config into the seam calls; tests inject seam behavior directly.
 *
 * Session-only: the extension-level `setModel(model)` takes no options, so the
 * session-level `{persist:true}` path is structurally unreachable from here.
 * Nothing is persisted, nothing arms before the first failure or command, and
 * `session_shutdown` flushes the one timer this wiring can hold (a seam `wait`).
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  capNoticeText,
  clampCooldownMs,
  classifyFailure,
  isDisabled,
  maxSwitchesPerEpisode,
  recomputeRetryability,
  shouldSwitch,
  type FailureClassification,
  type RouterFallbackEnv,
} from "./router-fallback-core.ts";

/** Shared `pi.events` channel carrying the N1 transition payload (F1-J8). */
export const ROUTER_FALLBACK_CHANNEL = "router-fallback";

/** The human command: `/fallback [status|reset|off|on]`. */
export const ROUTER_FALLBACK_COMMAND = "fallback";

/** Custom message type of the fallback notice cards. */
export const ROUTER_FALLBACK_CUSTOM_TYPE = "router-fallback-event";

/** Custom entry type of the shutdown report. */
export const ROUTER_FALLBACK_SHUTDOWN_ENTRY = "router-fallback-shutdown";

/** Usage line answered to unknown `/fallback` subcommands. */
export const ROUTER_FALLBACK_USAGE = "usage: /fallback [status|reset|off|on]";

/** The `/fallback` subcommands offered by argument completion. */
export const ROUTER_FALLBACK_SUBCOMMANDS = ["status", "reset", "off", "on"] as const;

/** Minimal model reference the seam trades in (provider + catalog id). */
export interface RouterFallbackModelRef {
  provider: string;
  id: string;
}

/** One ordered failover entry as the seam names it. */
export interface RouterFallbackTarget {
  id: string;
  label: string;
  model: string;
}

/** The seam's answer: a target to try, or a hold with a reason. */
export type DecideNextTargetResult =
  | { readonly entry: RouterFallbackTarget; readonly model: RouterFallbackModelRef }
  | { readonly none: true; readonly reason: string; readonly retryAfterMs?: number };

/** Who serves right now, as the seam reports it (feeds status + bus). */
export interface RouterFallbackServing {
  id: string;
  label: string;
  model: string;
}

/** What the wiring hands the seam per switch decision. */
export interface RouterFallbackDecisionEvent {
  readonly episodeId: string;
  readonly kind: string;
  readonly reason: string;
}

/** The Lane C provider seam (F2) — every member optional, safe stubs by default. */
export interface RouterFallbackSelector {
  isEligible?: (entry: RouterFallbackTarget) => boolean;
  resolveTargets?: (ctx: unknown) => RouterFallbackTarget[];
  decideNextTarget?: (event: RouterFallbackDecisionEvent) => DecideNextTargetResult;
  getServingProvider?: () => RouterFallbackServing | undefined;
  requiredThinking?: (model: RouterFallbackModelRef) => RouterFallbackThinking | undefined;
}

/** Thinking levels the seam may request (never `"off"` — see W5′). */
export type RouterFallbackThinking = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

/** Session-model parameter of the extension-level `setModel` (positional, single-arg). */
type PiModel = Parameters<ExtensionAPI["setModel"]>[0];

/** Session model shape for the N1 `from`/`to` legs. */
export interface RouterFallbackModelLeg {
  provider: string;
  model: string;
}

/** Frozen N1 bus payload (F1-J8). */
export interface RouterFallbackNotice {
  episodeId: string;
  kind: string;
  reason: string;
  from: RouterFallbackModelLeg;
  to: RouterFallbackModelLeg;
  servedBy: string[];
}

/** Injectable timer seam so tests fire the wait timer synchronously. */
export interface RouterFallbackScheduler {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Injectable seams: clock, scheduler, env, pi-function overrides, selector, minter. */
export interface RouterFallbackDeps {
  /** Injected clock for episode minting. Defaults to Date.now. */
  now?: () => number;
  /** Wait timers (seam `wait` answers only). Defaults to the globals. */
  scheduler?: RouterFallbackScheduler;
  /** Env record, read PER CALL. Defaults to process.env (live, never copied). */
  env?: RouterFallbackEnv;
  /** `pi.setModel` override (tests). Defaults to the bound pi function. */
  setModelFn?: (...args: unknown[]) => Promise<boolean>;
  /** `pi.setThinkingLevel` override (tests). Defaults to the bound pi function. */
  setThinkingLevelFn?: (level: RouterFallbackThinking) => void;
  /** Reserved for the Lane E custom/keyless path (F1-J1: defaults never call it). */
  registerProviderFn?: (...args: unknown[]) => void;
  /** The Lane C selector (F2). Defaults to safe stubs (empty-eligible, `{none}`). */
  selector?: RouterFallbackSelector;
  /** Episode-id minter (tests inject a counter). Defaults to clock+sequence. */
  mintEpisodeId?: () => string;
}

type SetModelFn = (model: RouterFallbackModelRef) => Promise<boolean>;

interface PendingFailure {
  classification: FailureClassification;
}

function legOf(model: { provider?: unknown; id?: unknown } | undefined): RouterFallbackModelLeg {
  if (model && typeof model.provider === "string" && typeof model.id === "string") {
    return { provider: model.provider, model: model.id };
  }
  return { provider: "unknown", model: "unknown" };
}

function lastAssistantOf(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Record<string, unknown>;
    if (message && message.role === "assistant") return message;
  }
  return undefined;
}

export default function (pi: ExtensionAPI, deps: RouterFallbackDeps = {}) {
  if (typeof pi?.registerCommand !== "function") {
    console.error(
      "ai-badger: pi.registerCommand is not a function — this pi build's extension API has moved; the fallback command is not installed.",
    );
    return;
  }

  const now = deps.now ?? Date.now;
  const scheduler: RouterFallbackScheduler = deps.scheduler ?? {
    setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const env: RouterFallbackEnv = deps.env ?? process.env;
  const selector: RouterFallbackSelector = deps.selector ?? {};
  const setModel: SetModelFn =
    (deps.setModelFn as SetModelFn | undefined) ??
    (typeof (pi as { setModel?: unknown }).setModel === "function"
      ? (model) => (pi as unknown as { setModel: (model: PiModel) => Promise<boolean> }).setModel(model as PiModel)
      : async () => false);
  const setThinkingLevel =
    deps.setThinkingLevelFn ??
    (typeof (pi as { setThinkingLevel?: unknown }).setThinkingLevel === "function"
      ? (level: RouterFallbackThinking) =>
          (pi as unknown as { setThinkingLevel: (level: RouterFallbackThinking) => void }).setThinkingLevel(level)
      : () => {});

  // ---- session state (all of it resets on episode mint / shutdown)
  let episodeSeq = 0;
  let episodeId = deps.mintEpisodeId?.() ?? `ep-${now()}-${episodeSeq++}`;
  let switchCount = 0;
  let switchEpisodeId: string | undefined;
  let exhausted = false;
  let sessionOverride: boolean | undefined;
  let lastStatus: number | undefined;
  let lastHeaders: Record<string, string> | undefined;
  let pending: PendingFailure | undefined;
  let waitTimer: unknown;
  let inFlight: RouterFallbackModelRef | undefined;
  let landed: RouterFallbackModelRef | undefined;
  let lastClassification: FailureClassification | undefined;
  let lastSwitch: { notice: RouterFallbackNotice } | undefined;

  const mintEpisode = (): void => {
    episodeId = deps.mintEpisodeId?.() ?? `ep-${now()}-${episodeSeq++}`;
    switchCount = 0;
    switchEpisodeId = undefined;
    exhausted = false;
    pending = undefined;
    inFlight = undefined;
  };

  const clearWaitTimer = (): void => {
    if (waitTimer === undefined) return;
    scheduler.clearTimeout(waitTimer);
    waitTimer = undefined;
  };

  const disabled = (): boolean => sessionOverride ?? isDisabled(env);

  const switchState = () => ({ episodeId, switchCount, switchEpisodeId, env });

  const servingOf = (): RouterFallbackServing | undefined => {
    try {
      return selector.getServingProvider?.();
    } catch {
      return undefined;
    }
  };

  const sendNotice = (content: string, details: Record<string, unknown>): void => {
    pi.sendMessage(
      { customType: ROUTER_FALLBACK_CUSTOM_TYPE, content: capNoticeText(content), display: true, details },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const servedByFor = (to: RouterFallbackModelRef, ctxModel: unknown): string[] => {
    const prior = servingOf();
    const ctxLeg = legOf(ctxModel as { provider?: unknown; id?: unknown } | undefined);
    const priorId = prior?.id ?? (ctxLeg.provider !== "unknown" ? ctxLeg.provider : undefined);
    if (priorId !== undefined && priorId !== to.provider) return [priorId, to.provider];
    return [to.provider];
  };

  /** The one advance-once switch sequence: try, on false/reject decide once more, then notice-only. */
  const attemptSwitch = async (
    classification: FailureClassification,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const decide = (reason: string): DecideNextTargetResult => {
      try {
        return (
          selector.decideNextTarget?.({ episodeId, kind: classification.kind, reason }) ?? {
            none: true as const,
            reason: "router-fallback: no fallback providers configured (Lane C selector pending)",
          }
        );
      } catch (error) {
        return { none: true as const, reason: `router-fallback: selector failed (${error instanceof Error ? error.message : String(error)})` };
      }
    };
    // Forward the session scope so the seam can prefer an in-scope target (W4).
    try {
      selector.resolveTargets?.(ctx);
    } catch {
      // A throwing scope probe must not break the switch — decide carries on.
    }

    const from = legOf((ctx as { model?: { provider?: unknown; id?: unknown } }).model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = decide(attempt === 0 ? classification.reason : "router-fallback: advancing after a failed attempt");
      if ("none" in decision && decision.none) {
        if (attempt === 0 && decision.retryAfterMs !== undefined) {
          clearWaitTimer();
          waitTimer = scheduler.setTimeout(() => {
            waitTimer = undefined;
          }, clampCooldownMs(decision.retryAfterMs));
        }
        if (attempt === 0) {
          const content = `router-fallback: hold — ${decision.reason} (episode ${episodeId})`;
          sendNotice(content, { kind: "hold", episodeId, reason: decision.reason });
        } else {
          const content = `router-fallback: no more targets this episode — ${decision.reason} (episode ${episodeId})`;
          sendNotice(content, { kind: "exhausted", episodeId, reason: decision.reason });
        }
        if (attempt > 0) exhausted = true;
        return;
      }
      const target = (decision as { entry: RouterFallbackTarget; model: RouterFallbackModelRef }).model;
      let ok = false;
      try {
        ok = await setModel(target);
      } catch {
        ok = false;
      }
      if (ok) {
        switchCount += 1;
        switchEpisodeId = episodeId;
        inFlight = target;
        const to = { provider: target.provider, model: target.id };
        const servedBy = servedByFor(target, (ctx as { model?: unknown }).model);
        const decisionReason =
          attempt === 0
            ? `switch: ${classification.kind} in episode ${episodeId} (${classification.reason})`
            : `switch: ${classification.kind} in episode ${episodeId} after advancing (${classification.reason})`;
        const notice: RouterFallbackNotice = { episodeId, kind: classification.kind, reason: decisionReason, from, to, servedBy };
        lastSwitch = { notice };
        pi.events.emit(ROUTER_FALLBACK_CHANNEL, notice);
        const thinking = selector.requiredThinking?.(target);
        if (thinking !== undefined) setThinkingLevel(thinking);
        const content =
          `router-fallback: switched ${from.provider}/${from.model} → ${to.provider}/${to.model} ` +
          `(${classification.kind}) in episode ${episodeId}; served by ${servedBy.join(" → ")}; ${classification.reason}`;
        sendNotice(content, {
          kind: "switched",
          episodeId,
          failureKind: classification.kind,
          from,
          to,
          servedBy,
          reason: decisionReason,
        });
        return;
      }
      // false/reject: loop once for the single advance, then fall to notice-only.
    }
    exhausted = true;
    const content = `router-fallback: no more targets this episode — setModel declined every target (episode ${episodeId})`;
    sendNotice(content, { kind: "exhausted", episodeId });
  };

  /** Shared agent_end/settled switch gate: retryable holds (pi retries), else one-shot. */
  const considerSwitch = async (
    classification: FailureClassification,
    lastAssistant: Record<string, unknown>,
    ctx: ExtensionContext,
    action: "end" | "settled",
  ): Promise<void> => {
    lastClassification = classification;
    if (disabled()) return;
    if (exhausted) return;
    const ctxModel = (ctx as { model?: { contextWindow?: unknown } }).model;
    const retryable = recomputeRetryability({
      stopReason: lastAssistant.stopReason as string | undefined,
      errorMessage: lastAssistant.errorMessage as string | undefined,
      usage: lastAssistant.usage as { input?: number; cacheRead?: number; output?: number } | undefined,
      contextWindow:
        ctxModel && typeof ctxModel.contextWindow === "number" ? (ctxModel.contextWindow as number) : undefined,
    });
    if (retryable && action === "end") {
      pending = { classification };
      return;
    }
    pending = undefined;
    const verdict = shouldSwitch(switchState(), classification, now());
    if (verdict.action !== "switch") return;
    await attemptSwitch(classification, ctx);
  };

  // ---------------------------------------------------------------- observers

  pi.on("after_provider_response", (event) => {
    const response = event as { status?: unknown; headers?: unknown };
    if (typeof response.status === "number") lastStatus = response.status;
    if (response.headers !== undefined && typeof response.headers === "object" && response.headers !== null) {
      lastHeaders = response.headers as Record<string, string>;
    }
    void lastHeaders;
    return undefined;
  });

  pi.on("message_end", (event) => {
    const message = (event as { message?: unknown }).message as Record<string, unknown> | undefined;
    if (message?.role === "assistant" && message.stopReason === "error") {
      lastClassification = classifyFailure({
        errorMessage: message.errorMessage as string | undefined,
        afterProviderStatus: lastStatus,
      });
    }
    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      const messages = (event as { messages?: unknown }).messages;
      const last = lastAssistantOf(messages);
      // A clean tail means nothing failed — the 402 latch alone never acts (W12).
      if (!last || last.stopReason !== "error") return;
      const classification = classifyFailure({
        errorMessage: last.errorMessage as string | undefined,
        afterProviderStatus: lastStatus,
      });
      await considerSwitch(classification, last, ctx, "end");
    } catch (error) {
      console.error("ai-badger router-fallback: agent_end switch failed — notice-only", error);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const latched = pending;
      mintEpisode();
      // The latched retryable failure survived pi's retries: reap it under the new
      // episode's zeroed budget, then settle (W9′). Non-latched settles just re-arm.
      if (latched !== undefined && !disabled()) {
        const verdict = shouldSwitch(switchState(), latched.classification, now());
        if (verdict.action === "switch") {
          await attemptSwitch(latched.classification, ctx);
        }
      }
    } catch (error) {
      console.error("ai-badger router-fallback: agent_settled switch failed — notice-only", error);
    }
  });

  pi.on("model_select", (event) => {
    const select = event as { model?: unknown; source?: unknown };
    if (select.source === "set") {
      landed = select.model as RouterFallbackModelRef | undefined;
      inFlight = undefined;
    }
    return undefined;
  });

  pi.on("before_provider_request", (event) => {
    // Tag-only: mark the payload of the in-flight fallback attempt, never block.
    if (inFlight !== undefined) {
      const payload = (event as { payload?: unknown }).payload;
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        (payload as Record<string, unknown>).routerFallbackAttempt = true;
      }
      inFlight = undefined;
    }
    return undefined;
  });

  // ---------------------------------------------------------------- command

  const statusText = (ctx: ExtensionContext): string => {
    const serving = servingOf();
    const budget = maxSwitchesPerEpisode(env);
    const used = switchEpisodeId === episodeId ? switchCount : 0;
    const lines = [
      "router-fallback status",
      `episode: ${episodeId} (switches used ${used}/${budget})`,
      `serving: ${serving ? `${serving.id} (${serving.model})` : "unknown"}`,
      `last failure: ${lastClassification ? `${lastClassification.kind} — ${lastClassification.reason}` : "none"}`,
      `last switch: ${lastSwitch ? `${lastSwitch.notice.from.provider}/${lastSwitch.notice.from.model} → ${lastSwitch.notice.to.provider}/${lastSwitch.notice.to.model} (${lastSwitch.notice.kind})` : "none"}`,
      `landed: ${landed ? `${landed.provider}/${landed.id}` : "none"}`,
      `session override: ${sessionOverride === undefined ? "none" : sessionOverride ? "off" : "on"}`,
      `kill-switch: ${isDisabled(env) ? "disabled via PI_BADGER_ROUTER_FALLBACK=0" : "enabled"}`,
    ];
    return capNoticeText(lines.join("\n"));
  };

  pi.registerCommand(ROUTER_FALLBACK_COMMAND, {
    description: "Router-fallback status and controls: status (default), reset (new episode), off/on (session override).",
    getArgumentCompletions(argumentPrefix) {
      const first = argumentPrefix.trim();
      const items = ROUTER_FALLBACK_SUBCOMMANDS.filter((verb) => verb.startsWith(first)).map((verb) => ({
        value: verb,
        label: verb,
        description: `fallback ${verb}`,
      }));
      return items.length > 0 ? items : null;
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const trimmed = args.trim();
      const notify = (message: string, type: "info" | "warning" | "error"): void => {
        ctx.ui.notify(message, type);
      };
      if (trimmed === "" || trimmed === "status") {
        notify(statusText(ctx), "info");
        return;
      }
      if (trimmed === "reset") {
        mintEpisode();
        notify(`router-fallback: reset — new episode ${episodeId} with a zeroed switch count.`, "info");
        return;
      }
      if (trimmed === "off") {
        sessionOverride = true;
        notify("router-fallback: off for this session (env kill-switch unchanged).", "warning");
        return;
      }
      if (trimmed === "on") {
        sessionOverride = undefined;
        notify("router-fallback: session override lifted (env kill-switch decides).", "info");
        return;
      }
      notify(ROUTER_FALLBACK_USAGE, "info");
    },
  });

  // ---------------------------------------------------------------- renderer

  pi.registerMessageRenderer(ROUTER_FALLBACK_CUSTOM_TYPE, (message, options, theme) => {
    const body = typeof message.content === "string" ? message.content : "";
    if (!body) return undefined;
    const details = message.details as { kind?: string } | undefined;
    const tone = details?.kind === "switched" ? "success" : details?.kind === "hold" ? "warning" : "error";
    const box = new Box(options.outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
    const lines = body.split("\n");
    box.addChild(new Text([theme.fg(tone, lines[0] ?? ""), ...lines.slice(1)].join("\n"), 0, 0));
    return box;
  });

  // ---------------------------------------------------------------- shutdown

  pi.on("session_shutdown", () => {
    clearWaitTimer();
    mintEpisode();
    lastStatus = undefined;
    lastHeaders = undefined;
    lastClassification = undefined;
    lastSwitch = undefined;
    landed = undefined;
    sessionOverride = undefined;
    pi.appendEntry(ROUTER_FALLBACK_SHUTDOWN_ENTRY, { episodeId });
  });
}
