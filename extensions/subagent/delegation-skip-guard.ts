/**
 * P5 delegation-skip advisory guard (PKG-5 P5): a tripwire that makes the NEXT
 * undeclared `pi`-via-shell spawn visible, not a fix for an ongoing behaviour
 * (F6 measured zero bash-spawned pi over ~22 sessions).
 *
 * A bash/powershell tool call whose command spawns `pi` directly notifies
 * "spawning pi directly — prefer `delegate`" and records a `delegation-skip`
 * session entry. Advisory ONLY: the handler returns `undefined` on every path
 * and wraps notify+record in try/catch, because pi core RETHROWS handler errors
 * (`beforeToolCall` catch → "Extension failed, blocking execution") — an
 * unguarded recorder would convert this advisory into a blocking guard on any
 * `appendEntry`/UI failure. Kill switch: `PI_BADGER_DELEGATION_SKIP_GUARD=0`
 * (read per call; unset/invalid → enabled), mirroring `PI_BADGER_WAIT_GUARD`.
 *
 * The runner's own children never reach this guard: delegation-runner.ts spawns
 * pi via `node:child_process`, never through the `bash` TOOL, so no bash
 * `tool_call` event fires for them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Env kill switch: `"0"` disables the guard; unset or any other value → enabled. */
export const DELEGATION_SKIP_GUARD_ENV = "PI_BADGER_DELEGATION_SKIP_GUARD";

/** Session-transcript entry type for recorded skips — queryable, no new table. */
export const DELEGATION_SKIP_ENTRY_TYPE = "delegation-skip";

/** The advisory text: names the preferred surface and says plainly it never blocks. */
export const SKIP_ADVISORY_MESSAGE =
  "ai-badger: spawning pi directly — prefer `delegate` (this notice is advisory; the command still runs)";

/**
 * Command-position `pi`-spawn predicate (spike §AC2, measured 33/33: 15/15
 * MUST-detect, 18/18 MUST-NOT). Command-position deliberately, NOT bare-token:
 * `echo pi` / `grep pi README.md` / `pip install pi` stay silent. Optional
 * `VAR=x` env prefixes, `sudo`/`nohup`/`npx`/`bunx`/`uvx`/`timeout <arg>`
 * runner prefixes, and multi-segment path prefixes (`./pi`,
 * `/usr/local/bin/pi`); trailing `[^\w-]` keeps `pip`/`pi3`/`my-pi` silent
 * while `pi run`, `pi;`, `pi&`, `pi)` fire. Case-sensitive: the unix binary is
 * lowercase, so `PI run` is silent. No `/g/` flag — `test()` must stay
 * stateless across calls.
 */
export const PI_SPAWN_COMMAND =
  /(?:^|[;|&()\n{}`!]|\b(?:elif|else|then|do|while|until|for|if|in)\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|nohup|npx|bunx|uvx|timeout\s+\S+)\s+)*(?:[\w.+-]*\/)*pi(?:[^\w-]|$)/;

export type PiSpawnDecision = { readonly action: "notify" } | { readonly action: "silent" };

/** Pure decision half: empty/undefined commands are silent. */
export function piSpawnDecision(command: string | undefined): PiSpawnDecision {
  if (command === undefined || command.trim() === "") return { action: "silent" };
  return PI_SPAWN_COMMAND.test(command) ? { action: "notify" } : { action: "silent" };
}

/** The kill switch reads PER CALL: only `"0"` disables; unset/invalid → enabled. */
function guardEnabled(): boolean {
  const raw = process.env[DELEGATION_SKIP_GUARD_ENV];
  return raw === undefined || raw.trim() !== "0";
}

/**
 * Wire the guard onto the `tool_call` seam (bash/powershell `input.command`,
 * the monitor `shellCommandOf` precedent). Returns `undefined` on EVERY path —
 * match, non-match, disabled, and recorder-failure alike — so the tool always
 * runs: this guard can never block a spawn.
 */
export function registerDelegationSkipGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    try {
      if (!guardEnabled()) return undefined;
      const call = event as { toolName?: string; input?: { command?: unknown } } | undefined;
      if (call?.toolName === undefined || !/^(bash|powershell)$/i.test(call.toolName)) return undefined;
      const command = call.input?.command;
      if (typeof command !== "string") return undefined;
      if (piSpawnDecision(command).action !== "notify") return undefined;
      const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
      if (ctx.hasUI) ctx.ui.notify(SKIP_ADVISORY_MESSAGE, "warning");
      pi.appendEntry(DELEGATION_SKIP_ENTRY_TYPE, { command, toolCallId, ts: Date.now() });
      return undefined;
    } catch {
      // Fail-open by construction: a throwing tool_call handler BLOCKS the tool
      // call in pi core, so anything failing above must still let the spawn run.
      return undefined;
    }
  });
}

export default registerDelegationSkipGuard;
