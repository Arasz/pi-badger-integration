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

/** True when the content is already an ack (terminal — never reply to it). */
export function isAck(content: string): boolean {
	return content.trimStart().toLowerCase().startsWith(ACK_PREFIX);
}

/**
 * Build the ack body for one received message, or undefined when the message
 * is itself an ack (the no-reply-to-ack rule). The ack echoes the original
 * content verbatim up to the cap — acks confirm receipt, disagreement travels
 * as review-feedback (a separate send, itself acked once).
 */
export function buildAckContent(message: Pick<BusMessage, "content">): string | undefined {
	if (isAck(message.content)) return undefined;
	const body = message.content.length > ACK_CONTENT_CAP_CHARS - ACK_PREFIX.length - 1
		? `${message.content.slice(0, ACK_CONTENT_CAP_CHARS - ACK_PREFIX.length - 2)}…`
		: message.content;
	return `${ACK_PREFIX} ${body}`;
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

/**
 * Startup summary for newly delivered DIRECT mail (the user-only card text).
 * Broadcasts are consumed silently on start, so they never appear here.
 * Empty batch → "" (the caller appends nothing).
 */
export function composeDirectStartNotice(messages: BusMessage[]): string {
	const directs = filterDirect(messages);
	if (directs.length === 0) return "";
	const head = `message-bus: ${directs.length} private message${directs.length === 1 ? "" : "s"} (broadcasts skipped on startup)`;
	const rows = directs.slice(0, 10).map((m) => `#${m.id} [direct] ${excerpt(m.content)}`);
	const tail = directs.length > 10 ? `…and ${directs.length - 10} more (see /messages)` : "see /messages for the grouped list";
	return [head, ...rows, tail].join("\n");
}

/**
 * The startup user-decision question. Asked via ctx.ui.confirm before any
 * direct mail enters LLM context — a "no" leaves the cursor advanced
 * (mail marked read, nothing further sent).
 */
export function buildDirectStartQuestion(count: number): string {
	return `agent got ${count} private message${count === 1 ? "" : "s"}, do you want to act on them?`;
}
