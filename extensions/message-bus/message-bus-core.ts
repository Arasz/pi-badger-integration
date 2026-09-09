/**
 * Pure message-bus core for the message-bus extension.
 *
 * Everything the wiring (tools, /messages command, delivery hooks, card
 * renderer) needs that can be decided without a process, a clock, a database
 * or pi itself: scope classification, send-target normalization, ack
 * discipline, last-N-per-scope grouping, list formatting and delivery-notice
 * composition.
 *
 * Purity rules (house convention):
 *   - zero imports — strings and arithmetic only;
 *   - no wall-clock reads, no fs/net/pi — rows and cursors arrive as args;
 *   - every side effect (sqlite I/O, pi.sendMessage, notify) belongs to the
 *     wiring in `index.ts`.
 *
 * Backend contract (mirrors ai-badger badger_store.py, cited per symbol):
 *   - addressing normalises at write: a given target_session makes the row
 *     1:1 with target_project stored NULL; target_project alone is a project
 *     broadcast; neither is a machine broadcast (D3);
 *   - wake classification counts the DELIVERED batch: 1:1 + project rows are
 *     addressed, both-targets-NULL rows are broadcast (C2/_delivery_summary);
 *   - delivery excludes the sender's own rows (R2);
 *   - protocol lives in multi-agent-communication: ack every non-ack once as
 *     `ack: [<taskId>] <event>`, never reply to an ack.
 */

/** The ack prefix (multi-agent-communication: `ack: ...` is terminal). */
export const ACK_PREFIX = "ack:";

/** Whole-ack cap: acks confirm receipt, they never relay the full body. */
export const ACK_CONTENT_CAP_CHARS = 2048;

/** Default per-scope list depth for /messages (last 3 per group). */
export const DEFAULT_LIST_DEPTH = 3;

/** Kill-switch env var: the literal string "0" disables the delivery hooks
 * (tools stay). Single-sourced here so the wiring (`index.ts`) and the
 * coordinator tick share one name without the tick importing pi wiring. */
export const MESSAGE_BUS_ENV = "PI_BADGER_MESSAGE_BUS";

/** Registry freshness window (s): entries unseen longer than this are skipped.
 * MEASUREMENT-TODO (V6): validate 300 against real idle-session lifetimes.
 * Read-side only: stale rows are filtered by readRegistrySnapshot, never
 * deleted, so old DBs keep working with zero DDL change. */
export const REGISTRY_TTL_S = 300;

/** One live-registry row: who was last seen, where, and when (ms since epoch). */
export interface RegistryEntry {
	sessionId: string;
	projectId: string | null;
	lastSeenMs: number;
}

/** Read-side snapshot: live entries only, plus a version pin of
 * max(lastSeenMs):count:snapshot-hash for cheap change detection. */
export interface RegistrySnapshot {
	entries: RegistryEntry[];
	version: string;
}

/** Snapshot version pin: max(lastSeenMs):count:identity-hash. The hash covers
 * session+project+stamp, so a membership swap with the same max and count
 * still moves the version — a bare max:count pin would let the channel cache
 * serve stale channels across the swap. Loop-form max (no spread). */
export function registryVersion(entries: Array<Pick<RegistryEntry, "sessionId" | "projectId" | "lastSeenMs">>): string {
	let max = 0;
	for (const e of entries) if (e.lastSeenMs > max) max = e.lastSeenMs;
	const canonical = entries.map((e) => `${e.sessionId}|${e.projectId ?? ""}|${e.lastSeenMs}`).join("\n");
	let hash = 5381;
	for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) + hash + canonical.charCodeAt(i)) >>> 0;
	return `${max}:${entries.length}:${hash.toString(16).padStart(8, "0")}`;
}

/** One bus row as the extension passes it (sender + addressing + body). */
export interface BusMessage {
	id: number;
	senderSession: string;
	senderProject: string;
	targetSession: string | null;
	targetProject: string | null;
	content: string;
	timestamp: string;
}

/** Delivery scope of one row (C2 classes: direct+project = addressed). */
export type Scope = "direct" | "project" | "broadcast";

/** Classify one row: session set → direct, project-only → project, neither → broadcast. */
export function scopeOf(message: Pick<BusMessage, "targetSession" | "targetProject">): Scope {
	if (message.targetSession !== null && message.targetSession !== undefined) return "direct";
	if (message.targetProject !== null && message.targetProject !== undefined) return "project";
	return "broadcast";
}

/** Normalised send targets (D3 session-wins): blanks read as unset. */
export function normalizeSendTargets(
	targetSession?: string | null,
	targetProject?: string | null,
): { targetSession: string | null; targetProject: string | null } {
	const session = typeof targetSession === "string" && targetSession.trim() ? targetSession.trim() : null;
	if (session !== null) return { targetSession: session, targetProject: null };
	const project = typeof targetProject === "string" && targetProject.trim() ? targetProject.trim() : null;
	return { targetSession: null, targetProject: project };
}

/** Validate one bus id SHAPE (after normalizeSendTargets — blanks already unset).
 * Accepts uuids and short ids; rejects anything carrying whitespace, `$(`,
 * backticks or newlines (#672 stored a literal `$(cat …` substitution verbatim).
 * Shape only — deliverability (unknown-but-well-formed) is a wiring warning. */
export function isValidBusId(id: string): boolean {
	if (!id) return false;
	if (/[\s`]/.test(id)) return false;
	if (id.includes("$(")) return false;
	return true;
}

/** Warning for a well-formed direct target with no identity row (P3 fail-open:
 * success + warning, never a block — the target may live on another machine
 * or simply predate the registry). Reply reuses this helper (F1 replay). */
export function unknownTargetWarning(targetSession: string): string {
	return `target ${targetSession} unknown — never seen on this machine; prefer reply by id`;
}

/** Warning for a direct send to the sender's own session id: the store's
 * sender-exclusion filter makes self-sends silent no-ops (F4 #698). */
export function selfSendWarning(sessionId: string): string {
	return `self-send to ${sessionId} is never deliverable (sender-exclusion filter)`;
}

/** Wire identity anchor (P2): every list/check/whoami output opens with this
 * line so the agent's own id is on the wire, never just in prose (F2).
 * Truncated to 8 chars — full ids never echo (anti-tautology pin). Lives in
 * the wiring OUTSIDE formatList (core list snapshots frozen). */
export function formatIdentityHeader(sessionId: string, projectId: string | null): string {
	const pid = projectId ? projectId.slice(0, 8) : "(none)";
	return `you are ${sessionId.slice(0, 8)} in project ${pid}`;
}

/** Reply targets: the ORIGINAL SENDER 1:1 (session-wins per D3 —
 * targetProject NULL even when the original was a broadcast). Never parsed
 * out of content (F2: ids in prose are untrusted, incl. stale bindings). */
export function buildReplyTargets(message: Pick<BusMessage, "senderSession">): { targetSession: string; targetProject: null } {
	return { targetSession: message.senderSession, targetProject: null };
}

/** True when the content is already an ack (terminal — never reply to it). */
export function isAck(content: string): boolean {
	return content.trimStart().toLowerCase().startsWith(ACK_PREFIX);
}

/**
 * Build the ack body for one received message, or undefined when the message
 * is itself an ack (the no-reply-to-ack rule). The ack is a metadata-only
 * stub — id plus terminal marker, zero body bytes. F7 (owner addendum
 * 9cc29df): echoing the original text let sibling 01a08098 read ack #701's
 * echoed second-person imperative as a live request (#703). Any body-derived
 * excerpt, however short, can reopen that hazard — request originals
 * routinely OPEN with the imperative — so the stub carries no excerpt at
 * all (this deliberately drops the owner's parenthetical title prefix:
 * recognizability comes from the `ack:` prefix + `#id` + terminal marker,
 * never from quoted body). Disagreement travels as review-feedback (a
 * separate send, itself acked once).
 */
export function buildAckContent(message: Pick<BusMessage, "id" | "content">): string | undefined {
	if (isAck(message.content)) return undefined;
	return `${ACK_PREFIX} #${message.id} — terminal, no reply expected`;
}

/** Last-N per scope, oldest-first within each group (stable reading order). */
export function groupLastPerScope(
	messages: BusMessage[],
	depth: number = DEFAULT_LIST_DEPTH,
): Record<Scope, BusMessage[]> {
	const grouped: Record<Scope, BusMessage[]> = { direct: [], project: [], broadcast: [] };
	for (const message of messages) grouped[scopeOf(message)].push(message);
	for (const scope of Object.keys(grouped) as Scope[]) {
		grouped[scope].sort((a, b) => a.id - b.id);
		grouped[scope] = grouped[scope].slice(Math.max(0, grouped[scope].length - depth));
	}
	return grouped;
}

/** One-line excerpt: whitespace-collapsed, capped, never multiline. */
function excerpt(content: string, cap = 100): string {
	const oneLine = content.replace(/\s+/g, " ").trim();
	return oneLine.length > cap ? `${oneLine.slice(0, cap)}…` : oneLine;
}

/**
 * Human list text: three scope groups (direct / project-broadcast /
 * machine-broadcast), last-N each, rows marked received (✓ id <= cursor) or
 * new (●). Never raw JSON — one `#[id] mark excerpt` line per row plus a
 * sender suffix. Empty inbox states so in one line.
 */
export function formatList(messages: BusMessage[], cursorId: number, depth: number = DEFAULT_LIST_DEPTH): string {
	if (messages.length === 0) return "no messages for this session.";
	const grouped = groupLastPerScope(messages, depth);
	const titles: Record<Scope, string> = {
		direct: "direct (1:1)",
		project: "project broadcast",
		broadcast: "machine broadcast",
	};
	const lines: string[] = [];
	for (const scope of ["direct", "project", "broadcast"] as Scope[]) {
		const rows = grouped[scope];
		lines.push(`${titles[scope]} — last ${rows.length}:`);
		if (rows.length === 0) {
			lines.push("  (none)");
			continue;
		}
		for (const row of rows) {
			const mark = row.id <= cursorId ? "✓" : "●";
			lines.push(`  ${mark} #${row.id} ${excerpt(row.content)} (from ${row.senderSession})`);
		}
	}
	return lines.join("\n");
}

/**
 * Delivery-notice body for newly delivered mail (the card text): counts by
 * scope plus one excerpt line per message. Empty batch → "" (the caller sends
 * nothing — delivery silence is not a card).
 */
export function composeDeliveryNotice(messages: BusMessage[]): string {
	if (messages.length === 0) return "";
	const addressed = messages.filter((m) => scopeOf(m) !== "broadcast").length;
	const broadcast = messages.length - addressed;
	const head = `message-bus: ${messages.length} new (${addressed} addressed, ${broadcast} broadcast)`;
	const rows = messages.slice(0, 10).map((m) => `#${m.id} [${scopeOf(m)}] ${excerpt(m.content)}`);
	const tail = messages.length > 10 ? `…and ${messages.length - 10} more (see /messages)` : "see /messages for the grouped list";
	return [head, ...rows, tail].join("\n");
}

/** Keep only 1:1 rows (session_start reads directs, never broadcasts). */
export function filterDirect(messages: BusMessage[]): BusMessage[] {
	return messages.filter((m) => scopeOf(m) === "direct");
}

/** Silently-consumed counts for one startup read (P4): mail the cursor
 * swept past without delivering — older-than-window / over-cap directs +
 * broadcasts skipped on start. Absent stats mean "unknown" (old stores),
 * never zero: only a present {0,0} renders the zero-drop text. */
export interface StartupDropStats {
	droppedDirects: number;
	droppedBroadcasts: number;
}

/** The exact-count oracle line: `n older directs and m broadcasts …`. */
export function formatDropLine(stats: StartupDropStats): string {
	return `${stats.droppedDirects} older directs and ${stats.droppedBroadcasts} broadcasts were marked read without delivery (30-min window / startup gate)`;
}

/**
 * Startup summary for newly delivered DIRECT mail (the user-only card text).
 * Broadcasts are consumed silently on start, so they never appear here.
 * Empty batch → "" (the caller appends nothing).
 * stats is backward-compat: absent (or both zero) renders today's text
 * byte-identical; otherwise the drop line lands between rows and tail.
 */
export function composeDirectStartNotice(messages: BusMessage[], stats?: StartupDropStats): string {
	const directs = filterDirect(messages);
	if (directs.length === 0) return "";
	const head = `message-bus: ${directs.length} private message${directs.length === 1 ? "" : "s"} (broadcasts skipped on startup)`;
	const rows = directs.slice(0, 10).map((m) => `#${m.id} [direct] ${excerpt(m.content)}`);
	const tail = directs.length > 10 ? `…and ${directs.length - 10} more (see /messages)` : "see /messages for the grouped list";
	const dropped = (stats?.droppedDirects ?? 0) + (stats?.droppedBroadcasts ?? 0) > 0 ? [formatDropLine(stats!)] : [];
	return [head, ...rows, ...dropped, tail].join("\n");
}

/**
 * The startup user-decision question. Asked via ctx.ui.confirm before any
 * direct mail enters LLM context — a "no" leaves the cursor advanced
 * (mail marked read, nothing further sent).
 */
export function buildDirectStartQuestion(count: number): string {
	return `agent got ${count} private message${count === 1 ? "" : "s"}, do you want to act on them?`;
}
