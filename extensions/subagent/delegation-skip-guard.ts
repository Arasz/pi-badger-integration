/**
 * P5 delegation-skip blocking guard (PKG-5 P5, f: 2026-09-08 — advisory gave us
 * nothing, so the guard now BLOCKS): a bash/powershell tool call whose command
 * spawns `pi` directly is refused with "use `delegate` instead" and records a
 * `delegation-skip` session entry. Help/version invocations (`pi --help`, `-h`,
 * `--version`, `-v`, including `pi <subcommand> --help`) stay silent — they are
 * documentation reads, not delegation skips.
 *
 * Fail-open: predicate crashes return `undefined` (allow), because pi
 * core RETHROWS handler errors (`beforeToolCall` catch → "Extension failed,
 * blocking execution") — an unguarded throw would block with a confusing message.
 * A RECORD failure still blocks (the block is intentional; the record is audit).
 * There is intentionally no env kill switch: agents set
 * `PI_BADGER_DELEGATION_SKIP_GUARD=0` on every call to dodge the guard,
 * so the guard always enforces — use `delegate` instead.
 *
 * The runner's own children never reach this guard: delegation-runner.ts spawns
 * pi via `node:child_process`, never through the `bash` TOOL, so no bash
 * `tool_call` event fires for them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session-transcript entry type for recorded skips — queryable, no new table. */
export const DELEGATION_SKIP_ENTRY_TYPE = "delegation-skip";

/** The block reason: names the preferred surface. */
export const SKIP_BLOCK_MESSAGE =
  "ai-badger: spawning pi directly is blocked — use `delegate` instead";

/**
 * Command-position `pi`-spawn predicate (spike §AC2 plus the FP fixes that followed
 * it: 18/18 MUST-block rows, 9 help/version rows, 26/26 MUST-NOT rows in the matrix).
 * Command-position deliberately, NOT bare-token:
 * `echo pi` / `grep pi README.md` / `pip install pi` stay silent. Data is blanked to
 * spaces before the scan — quoted spans (blankQuotedSpans): quoted data can neither
 * fake a segment separator (a `grep` pattern's `|features/pi` or a multi-line commit
 * message's next-line path) nor smuggle a benign flag — then single-quoted
 * here-document bodies (blankSingleQuotedHeredocBodies), the one quoting form the
 * `$(`-keeps-code exception hands through verbatim. Optional
 * `VAR=x` env prefixes, `sudo`/`nohup`/`npx`/`bunx`/`uvx`/`timeout <arg>`
 * runner prefixes, and multi-segment path prefixes (`./pi`,
 * `/usr/local/bin/pi`); trailing `[^\w./-]` keeps `pip`/`pi3`/`my-pi`/`pi.run` AND
 * every mid-path segment (`for f in features/pi/…`, `./features/pi/build.sh`) silent
 * while `pi run`, `pi;`, `pi&`, `pi)` fire — `pi` must be the LAST segment of the
 * command word. The shell keyword `in` is deliberately NOT a spawn prefix: it only
 * introduces a word list (for/select/case), whose commands arrive behind `; do`, `)`
 * or another separator the class already covers — as a prefix it read the FP
 * `for f in features/pi/adjustments/adapter/*; do …` as a spawn.
 * Case-sensitive: the unix binary is lowercase, so `PI run` is silent. No `/g/` flag —
 * `test()` must stay stateless across calls.
 */
export const PI_SPAWN_COMMAND =
  /(?:^|[;|&()\n{}`!]|\b(?:elif|else|then|do|while|until|for|if)\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|nohup|npx|bunx|uvx|timeout\s+\S+)\s+)*(?:[\w.+-]*\/)*pi(?:[^\w./-]|$)/;

/**
 * Global twin of PI_SPAWN_COMMAND that captures each real `pi` invocation's
 * trailing args (up to the next shell separator). Used ONLY to scope the
 * help/version allowlist to the pi invocation itself — so `echo --help; pi run`
 * still blocks (the flag belongs to echo) and `pi run; echo --help` still
 * blocks (the flag belongs to echo, not pi).
 */
const PI_INVOCATION_ARGS_GLOBAL =
  /(?:^|[;|&()\n{}`!]|\b(?:elif|else|then|do|while|until|for|if)\b)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|nohup|npx|bunx|uvx|timeout\s+\S+)\s+)*(?:[\w.+-]*\/)*pi((?:\s+[^\s;|&()\n{}`!]+)*)(?:(?=[^\w./-])|$)/g;

/** Help/version tokens: documentation reads, never delegation skips. */
const BENIGN_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

function invocationArgsAreBenign(args: string): boolean {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => BENIGN_FLAGS.has(token));
}

/**
 * The command with every quoted span blanked to spaces (length-preserving), so the
 * predicates below can never read quoted DATA as command position: a grep pattern
 * (`"bun test\|features/pi"`) or a multi-line `git commit -m` message whose next
 * line starts with such a path would otherwise fake a segment separator and block.
 * Bash rules approximated: `'…'` is pure data to its closing quote; `"…"` ends at
 * the first unescaped `"`; an unbalanced quote blanks to the end (bash would not run
 * the command at all); a quoted newline becomes spaces — a line break inside quotes
 * is data, not a segment boundary. Coarse exception, safety-first: a DOUBLE-quoted
 * span containing a command substitution (`$(` or a backtick) is left verbatim,
 * because substitutions EXECUTE inside double quotes and blanking them would hide a
 * real spawn — such a span can over-block like before, never miss. PowerShell
 * quoting is approximated the same way.
 */
function blankQuotedSpans(command: string): string {
  const out = command.split("");
  let i = 0;
  while (i < out.length) {
    const quote = out[i];
    if (quote !== "'" && quote !== '"') {
      i += 1;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < out.length && out[j] !== quote) {
      if (quote === '"' && out[j] === "\\") j += 1; // escaped char (incl. \" and \\)
      j += 1;
    }
    const end = Math.min(j + 1, out.length); // through the closing quote (or EOS)
    const span = command.slice(start, end);
    const keepsCode = quote === '"' && (span.includes("$(") || span.includes("`"));
    if (!keepsCode) out.fill(" ", start, end);
    i = end;
  }
  return out.join("");
}

/**
 * The bodies of single-quoted here-documents blanked to spaces (length-preserving,
 * like blankQuotedSpans): bash performs NO expansion inside `<<'TAG'` / `<<-'TAG'`
 * bodies, so their text is pure data and a command-shaped line in it can never spawn
 * `pi` — the same rule as a quoted span, extended to the quoting form
 * blankQuotedSpans cannot see: a `$(cat <<'EOF' …)` commit message passes through
 * the double-quote `$(`-keeps-code exception verbatim and would otherwise block on
 * its own prose (`fix(pi):`, `… in pi …`).
 *
 * Safety, both directions:
 *  - only a SINGLE-quoted tag counts; `<<TAG` bodies still expand `$(…)`
 *    (and the spawn may hide in that expansion), so they stay scannable;
 *  - the body starts on the line AFTER the marker's line — same-line commands after
 *    `;` are commands, not body — and is blanked ONLY when a terminator line exists:
 *    an unterminated marker leaves everything verbatim, because blanking to EOS could
 *    swallow a real command that merely follows a quoted fake marker. Unterminated
 *    therefore over-blocks (data scanned as commands), which is the safe direction.
 */
function blankSingleQuotedHeredocBodies(command: string): string {
  const out = command.split("");
  const marker = /<<-?'([A-Za-z_][A-Za-z0-9_]*)'/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(command)) !== null) {
    const tag = match[1];
    const lineEnd = command.indexOf("\n", marker.lastIndex);
    if (lineEnd === -1) continue; // the body would start on the next line — none exists
    const bodyStart = lineEnd + 1;
    const terminator = new RegExp(`^[ \\t]*${tag}[ \\t]*$`, "m").exec(command.slice(bodyStart));
    if (terminator === null) continue; // unterminated: leave verbatim (never miss)
    const bodyEnd = bodyStart + terminator.index;
    for (let i = bodyStart; i < bodyEnd; i += 1) out[i] = " ";
    // Continue after this heredoc: a marker INSIDE the blanked body is data, not a second heredoc.
    marker.lastIndex = bodyStart + terminator.index + terminator[0].length;
  }
  return out.join("");
}

/**
 * True when EVERY real `pi` invocation in the command is a help/version read.
 * A mix (`pi --help; pi run`) is NOT benign — the prompt run still blocks.
 * Runs on the blanked text: a `--help` inside quoted argument text never exempts.
 */
export function isBenignPiSpawn(command: string): boolean {
  command = blankQuotedSpans(blankSingleQuotedHeredocBodies(command));
  PI_INVOCATION_ARGS_GLOBAL.lastIndex = 0;
  let found = false;
  let allBenign = true;
  let match: RegExpExecArray | null;
  while ((match = PI_INVOCATION_ARGS_GLOBAL.exec(command)) !== null) {
    found = true;
    if (!invocationArgsAreBenign(match[1] ?? "")) {
      allBenign = false;
      break;
    }
    // Guard against zero-length-match loops (the args group is optional).
    if (match[0].length === 0) PI_INVOCATION_ARGS_GLOBAL.lastIndex += 1;
  }
  PI_INVOCATION_ARGS_GLOBAL.lastIndex = 0;
  return found && allBenign;
}

export type PiSpawnDecision =
  | { readonly action: "block"; readonly reason: string }
  | { readonly action: "silent" };

/** Pure decision half: empty/undefined commands are silent; help/version reads are silent.
 * Both halves see the blanked text (quoted spans + single-quoted heredoc bodies), so
 * quoted argument text can neither fake a spawn position nor smuggle a `--help` exemption. */
export function piSpawnDecision(command: string | undefined): PiSpawnDecision {
  if (command === undefined || command.trim() === "") return { action: "silent" };
  const scan = blankQuotedSpans(blankSingleQuotedHeredocBodies(command));
  if (!PI_SPAWN_COMMAND.test(scan)) return { action: "silent" };
  if (isBenignPiSpawn(scan)) return { action: "silent" };
  return { action: "block", reason: SKIP_BLOCK_MESSAGE };
}

/**
 * Wire the guard onto the `tool_call` seam (bash/powershell `input.command`,
 * the monitor `shellCommandOf` precedent). A prompt-like `pi` spawn returns
 * `{ block: true, reason }` — pi core refuses the tool call with the reason.
 * Anything unexpected returns `undefined` (fail-open): a throwing tool_call
 * handler BLOCKS the call in pi core with a confusing message, so predicate
 * crashes must still let the spawn run. A record failure still blocks — the
 * block is intentional, the record is audit.
 */
export function registerDelegationSkipGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, _ctx) => {
    try {
      const call = event as { toolName?: string; input?: { command?: unknown } } | undefined;
      if (call?.toolName === undefined || !/^(bash|powershell)$/i.test(call.toolName)) return undefined;
      const command = call.input?.command;
      if (typeof command !== "string") return undefined;
      const decision = piSpawnDecision(command);
      if (decision.action !== "block") return undefined;
      const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
      try {
        pi.appendEntry(DELEGATION_SKIP_ENTRY_TYPE, { command, toolCallId, ts: Date.now(), blocked: true });
      } catch {
        // Record failure must not unblock — the block is intentional.
      }
      return { block: true, reason: decision.reason };
    } catch {
      // Fail-open by construction for UNEXPECTED failures (predicate crash, env
      // read throw): pi core turns a throwing handler into a block, so anything
      // failing above must still let the spawn run rather than block confusingly.
      return undefined;
    }
  });
}

export default registerDelegationSkipGuard;
