/**
 * Native pi message-bus on the ai-badger user-DB backend.
 *
 * What this is: an LLM tool (`message-bus` send/list/check/ack), a human
 * command (`/messages ...`), turn-boundary delivery hooks (session_start +
 * turn_start) and a card renderer — all against the SAME SQLite bus tables the
 * `send-message` skill writes (`messages` + `cursors` in the user DB).
 *
 * Startup gate: session_start reads DIRECT mail only (broadcasts are consumed
 * silently via the cursor landing past MAX), prints a user-only summary via
 * appendEntry (never LLM context), and asks via ctx.ui.confirm before the
 * agent ever sees the mail. A "no" leaves the cursor advanced (marked read).
 * Headless sessions (no confirm surface) surface directs to the agent so mail
 * is never silently consumed. turn_start and `check` keep delivering all mail.
 *
 * What this is NOT:
 *   - not a new transport: the backend is ai-badger's bus (badger_store.py's
 *     `messages` DDL); the protocol is multi-agent-communication (ack once,
 *     never reply to an ack);
 *   - not a push waker: idle-session wake stays with the adapter's poll timer
 *     (bus-store.ts/bus-prefilter.ts). These hooks are the turn-boundary seam:
 *     mail is injected as context for a turn that is starting anyway;
 *   - not exact python parity: first-read has the 30-minute gate + 16-cap and
 *     lands the cursor past MAX(id) like deliver_for_session, but the
 *     leg-scoped landing for project-less sessions (L1/R1a) is simplified to
 *     the same global landing — documented divergence, sessions without a
 *     resolvable project are rare in pi (cwd-based resolve almost always
 *     answers) and the cost is only a skipped re-read of project mail that a
 *     later project-ful check would otherwise surface.
 *
 * Fail-open (D31): every backend failure is a value — an error tool result, a
 * command notify, a silent hook skip with one console.error line. A broken bus
 * never breaks a session. A missing DB file is data (bus unavailable), never
 * created as a side effect (the bus-store.ts ENOENT rule).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ACK_PREFIX,
	buildAckContent,
	buildDirectStartQuestion,
	composeDeliveryNotice,
	composeDirectStartNotice,
	DEFAULT_LIST_DEPTH,
	filterDirect,
	formatList,
	isAck,
	normalizeSendTargets,
	type BusMessage,
} from "./message-bus-core.ts";

/** The message-bus card's custom message type. */
export const MESSAGE_BUS_CUSTOM_TYPE = "message-bus-event";

/** User-only startup summary entry (appendEntry — never enters LLM context). */
export const MESSAGE_BUS_START_ENTRY_TYPE = "message-bus-start";

/** Data stored on the user-only startup summary card. */
export interface MessageBusStartCardData {
	text: string;
	count: number;
	ids: number[];
}

/** The LLM-facing tool name. */
export const MESSAGE_BUS_TOOL_NAME = "message-bus";

/** The human command. */
export const MESSAGE_BUS_COMMAND_NAME = "messages";

/** Kill-switch: the literal string "0" disables the delivery hooks (tools stay). */
export const MESSAGE_BUS_ENV = "PI_BADGER_MESSAGE_BUS";

/** First-read history gate (mirrors deliver_for_session's 30-minute window). */
export const FIRST_READ_WINDOW_MS = 30 * 60_000;

/** First-read delivery cap (mirrors deliver_for_session's 16). */
export const FIRST_READ_CAP = 16;

/** Injectable seams for tests (store, clock, identity, db path, env). */
export interface MessageBusDeps {
	store?: BusStore;
	now?: () => number;
	env?: Record<string, string | undefined>;
	dbPath?: string;
	sessionId?: (ctx: ExtensionContext) => string;
	projectId?: (ctx: ExtensionContext) => string | null;
}

/** The backend surface the wiring needs (default: node:sqlite over the user DB). */
export interface BusStore {
	send(args: {
		senderSession: string;
		senderProject: string;
		content: string;
		targetSession: string | null;
		targetProject: string | null;
	}): number;
	getMessage(id: number): BusMessage | null;
	listForSession(sessionId: string, projectId: string | null): BusMessage[];
	deliverForSession(sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number };
	/** Startup read: direct-only batch, cursor still lands past MAX(id) so stale
	 * broadcasts are consumed silently and never re-delivered on turn_start. */
	deliverDirectForSession(sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number };
	getCursor(sessionId: string): number;
}

// ---------------------------------------------------------------------------
// identity + paths (mirrors of badger_store.py semantics, pi-side)
// ---------------------------------------------------------------------------

/** The user DB path, resolved as the Python store resolves it (bus-store.ts mirror). */
export function userDbPath(env: Record<string, string | undefined>, cwd: string): string {
	const root = env.AI_BADGER_USER_ROOT;
	if (root) return resolve(cwd, root, "ai-badger.db");
	return join(homedir(), ".ai-badger", "ai-badger.db");
}

/** Sender session: the session manager's id only (bus-prefilter.ts C6 — no env fallback). */
export function resolveSessionId(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) return id;
	} catch {
		// an older build's session manager shape must not take down the call
	}
	return "";
}

/** Sender project: AI_BADGER_PROJECT_ID wins, else nearest .ai-badger/project-id above cwd. */
export function resolveProjectId(cwd: string, env: Record<string, string | undefined>): string | null {
	const override = env.AI_BADGER_PROJECT_ID;
	if (typeof override === "string" && override.trim()) return override.trim();
	let dir = resolve(cwd);
	for (;;) {
		const aib = join(dir, ".ai-badger");
		if (existsSync(join(aib, "project-id"))) {
			try {
				const value = readFileSync(join(aib, "project-id"), "utf8").trim();
				if (value) return value;
			} catch {
				return null;
			}
			return null;
		}
		if (existsSync(aib)) return null; // nearest .ai-badger wins and stops the walk
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// ---------------------------------------------------------------------------
// default sqlite store (node:sqlite, read-write for send/deliver)
// ---------------------------------------------------------------------------

const BUS_DDL = [
	`CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts TEXT NOT NULL,
		sender_session TEXT NOT NULL,
		sender_project TEXT NOT NULL,
		target_session TEXT,
		target_project TEXT,
		content TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS cursors (
		session_id TEXT PRIMARY KEY,
		cursor_id INTEGER NOT NULL,
		ts TEXT NOT NULL
	)`,
];

interface SqliteDb {
	prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): { lastInsertRowid?: unknown } };
	exec(sql: string): void;
	close(): void;
}

function rowToMessage(row: Record<string, unknown>): BusMessage {
	return {
		id: Number(row.id),
		senderSession: String(row.sender_session),
		senderProject: String(row.sender_project),
		targetSession: (row.target_session as string | null) ?? null,
		targetProject: (row.target_project as string | null) ?? null,
		content: String(row.content),
		timestamp: String(row.ts),
	};
}

/** node:sqlite busy-wait (ms) applied to every opened handle — python parity
 * (badger_store.py: connect timeout 5s + `PRAGMA busy_timeout = 5000`).
 * node:sqlite defaults to 0 (fail instantly), which turned ordinary
 * multi-session contention into `database is locked` on the DDL write every
 * open starts with. A waiter serialises behind the holder instead. */
export const BUS_BUSY_TIMEOUT_MS = 5000;

/** Open one handle with the contention pragma applied. Throws on backend
 * failure — the wiring converts (same contract as createSqliteStore).
 * Exported as the test seam: the suite pins the pragma value through it. */
export function openBusDb(dbPath: string): SqliteDb {
	let DatabaseSync: new (path: string) => SqliteDb;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		DatabaseSync = (require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb }).DatabaseSync;
	} catch {
		throw new Error("bus unavailable — node:sqlite is not available in this runtime");
	}
	const db = new DatabaseSync(dbPath);
	db.exec(`PRAGMA busy_timeout = ${BUS_BUSY_TIMEOUT_MS}`);
	return db;
}

/** Default store over the user DB. Throws on backend failure — the wiring converts. */
export function createSqliteStore(dbPath: string, now: () => number = Date.now): BusStore {
	if (!existsSync(dbPath)) throw new Error(`bus unavailable — no user DB at ${dbPath}`);
	const withDb = <T>(fn: (db: SqliteDb) => T): T => {
		const db = openBusDb(dbPath);
		try {
			for (const ddl of BUS_DDL) db.exec(ddl);
			return fn(db);
		} finally {
			try {
				db.close();
			} catch {
				// a failed close must not mask the result
			}
		}
	};
	const readAddressed = (
		db: SqliteDb,
		sessionId: string,
		projectId: string | null,
		afterId: number,
		sinceTs: string | null,
	): Record<string, unknown>[] => {
		const shapes = ["target_session = ?"];
		const params: unknown[] = [sessionId];
		if (projectId) {
			shapes.push("(target_session IS NULL AND target_project = ?)");
			shapes.push("(target_session IS NULL AND target_project IS NULL)");
			params.push(projectId);
		}
		const clauses = [`(${shapes.join(" OR ")})`, "id > ?", "sender_session <> ?"];
		params.push(afterId, sessionId);
		if (sinceTs !== null) {
			clauses.push("ts >= ?");
			params.push(sinceTs);
		}
		return db
			.prepare(
				`SELECT id, ts, sender_session, sender_project, content, target_session, target_project FROM messages WHERE ${clauses.join(" AND ")} ORDER BY id ASC`,
			)
			.all(...params) as Record<string, unknown>[];
	};
	const readDirect = (db: SqliteDb, sessionId: string, afterId: number, sinceTs: string | null): Record<string, unknown>[] => {
		const clauses = ["target_session = ?", "id > ?", "sender_session <> ?"];
		const params: unknown[] = [sessionId, afterId, sessionId];
		if (sinceTs !== null) {
			clauses.push("ts >= ?");
			params.push(sinceTs);
		}
		return db
			.prepare(
				`SELECT id, ts, sender_session, sender_project, content, target_session, target_project FROM messages WHERE ${clauses.join(" AND ")} ORDER BY id ASC`,
			)
			.all(...params) as Record<string, unknown>[];
	};
	return {
		send(args) {
			if (!args.senderSession) throw new Error("send refused: missing sender identity (sessionId)");
			if (!args.senderProject) throw new Error("send refused: missing sender identity (projectId)");
			if (!args.content) throw new Error("send refused: content is empty");
			return withDb((db) => {
				const result = db
					.prepare(
						"INSERT INTO messages(ts, sender_session, sender_project, target_session, target_project, content) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(new Date(now()).toISOString(), args.senderSession, args.senderProject, args.targetSession, args.targetProject, args.content);
				return Number(result.lastInsertRowid ?? 0);
			});
		},
		getMessage(id) {
			return withDb((db) => {
				const row = db.prepare("SELECT id, ts, sender_session, sender_project, content, target_session, target_project FROM messages WHERE id = ?").get(id) as Record<
					string,
					unknown
				> | null;
				return row ? rowToMessage(row) : null;
			});
		},
		listForSession(sessionId, projectId) {
			return withDb((db) => readAddressed(db, sessionId, projectId, 0, null).map(rowToMessage));
		},
		getCursor(sessionId) {
			return withDb((db) => {
				const row = db.prepare("SELECT cursor_id FROM cursors WHERE session_id = ?").get(sessionId) as { cursor_id?: unknown } | null;
				return Number(row?.cursor_id ?? 0);
			});
		},
		deliverForSession(sessionId, projectId) {
			return withDb((db) => {
				const cursorRow = db.prepare("SELECT cursor_id FROM cursors WHERE session_id = ?").get(sessionId) as { cursor_id?: unknown } | null | undefined;
				let messages: BusMessage[];
				let nextCursor: number;
				if (cursorRow === null || cursorRow === undefined) {
					const cutoff = new Date(now() - FIRST_READ_WINDOW_MS).toISOString();
					const rows = readAddressed(db, sessionId, projectId, 0, cutoff);
					messages = rows.slice(0, FIRST_READ_CAP).map(rowToMessage);
					const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
					nextCursor = Number(maxRow?.max_id ?? 0);
				} else {
					const rows = readAddressed(db, sessionId, projectId, Number(cursorRow.cursor_id ?? 0), null);
					messages = rows.map(rowToMessage);
					nextCursor = messages.length > 0 ? messages[messages.length - 1]!.id : Number(cursorRow.cursor_id ?? 0);
				}
				db.prepare("INSERT INTO cursors(session_id, cursor_id, ts) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cursor_id = excluded.cursor_id, ts = excluded.ts").run(
					sessionId,
					nextCursor,
					new Date(now()).toISOString(),
				);
				return { messages, cursor: nextCursor };
			});
		},
		deliverDirectForSession(sessionId, _projectId) {
			return withDb((db) => {
				const cursorRow = db.prepare("SELECT cursor_id FROM cursors WHERE session_id = ?").get(sessionId) as { cursor_id?: unknown } | null | undefined;
				let messages: BusMessage[];
				let nextCursor: number;
				if (cursorRow === null || cursorRow === undefined) {
					const cutoff = new Date(now() - FIRST_READ_WINDOW_MS).toISOString();
					const rows = readDirect(db, sessionId, 0, cutoff);
					messages = rows.slice(0, FIRST_READ_CAP).map(rowToMessage);
					const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
					nextCursor = Number(maxRow?.max_id ?? 0);
				} else {
					const cursor = Number(cursorRow.cursor_id ?? 0);
					const rows = readDirect(db, sessionId, cursor, null);
					messages = rows.map(rowToMessage);
					if (messages.length > 0) {
						const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
						nextCursor = Number(maxRow?.max_id ?? 0);
					} else {
						const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
						nextCursor = Math.max(cursor, Number(maxRow?.max_id ?? 0));
					}
				}
				db.prepare("INSERT INTO cursors(session_id, cursor_id, ts) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cursor_id = excluded.cursor_id, ts = excluded.ts").run(
					sessionId,
					nextCursor,
					new Date(now()).toISOString(),
				);
				return { messages, cursor: nextCursor };
			});
		},
	};
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export default function (pi: ExtensionAPI, deps: MessageBusDeps = {}) {
	if (typeof pi?.registerTool !== "function") {
		console.error(
			"ai-badger: pi.registerTool is not a function — this pi build's extension API has moved; the message-bus tool is not installed.",
		);
		return;
	}

	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const resolveSid = deps.sessionId ?? resolveSessionId;
	const resolvePid = deps.projectId ?? ((ctx) => resolveProjectId(ctx.cwd, env));
	const storeFor = (defaultCwd: string): BusStore => {
		if (deps.store) return deps.store;
		return createSqliteStore(deps.dbPath ?? userDbPath(env, defaultCwd), now);
	};

	const hooksDisabled = (): boolean => env[MESSAGE_BUS_ENV] === "0";

	const sendCard = (content: string, details: Record<string, unknown>, triggerTurn: boolean): void => {
		pi.sendMessage({ customType: MESSAGE_BUS_CUSTOM_TYPE, content, display: true, details }, { deliverAs: "followUp", triggerTurn });
	};

	/** Inbox membership: only messages addressed to this session can be acked (protocol: ack what you received). */
	const findInInbox = (store: BusStore, sessionId: string, projectId: string | null, id: number): BusMessage | null => {
		const found = store.listForSession(sessionId, projectId).find((m) => m.id === id);
		return found ?? null;
	};

	/** Shared check: deliver + card when there is new mail. Returns human text. */
	const runCheck = (ctx: ExtensionContext, triggerTurn: boolean): string => {
		const sessionId = resolveSid(ctx);
		if (!sessionId) return "message-bus unavailable: no session id (sessionManager.getSessionId() answered empty)";
		let store: BusStore;
		try {
			store = storeFor(ctx.cwd);
		} catch (error) {
			return `message-bus unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
		let delivered: BusMessage[];
		try {
			delivered = store.deliverForSession(sessionId, resolvePid(ctx)).messages;
		} catch (error) {
			console.error("ai-badger message-bus: delivery failed — fail-open, mail stays queued", error);
			return `message-bus check failed (mail stays queued): ${error instanceof Error ? error.message : String(error)}`;
		}
		if (delivered.length === 0) return "no new messages.";
		const notice = composeDeliveryNotice(delivered);
		sendCard(notice, { kind: "delivery", count: delivered.length, ids: delivered.map((m) => m.id) }, triggerTurn);
		return notice;
	};

	/** Startup read: direct-only batch (broadcasts consumed silently via cursor). */
	const deliverDirectBatch = (store: BusStore, sessionId: string, projectId: string | null): BusMessage[] => {
		if (typeof store.deliverDirectForSession === "function") {
			return store.deliverDirectForSession(sessionId, projectId).messages;
		}
		return filterDirect(store.deliverForSession(sessionId, projectId).messages);
	};

	/**
	 * Startup gate: read directs, print a user-only summary, ask before the
	 * agent ever sees the mail. A "no" leaves the cursor advanced (marked read).
	 * User-only, never a prompt by default: the summary rides appendEntry so it
	 * renders in the TUI transcript without entering LLM context (update-check
	 * pattern — even triggerTurn:false would leak into history on next turn).
	 */
	const runDirectStart = async (ctx: ExtensionContext): Promise<string> => {
		const sessionId = resolveSid(ctx);
		if (!sessionId) return "message-bus unavailable: no session id (sessionManager.getSessionId() answered empty)";
		let store: BusStore;
		try {
			store = storeFor(ctx.cwd);
		} catch (error) {
			return `message-bus unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
		let directs: BusMessage[];
		try {
			directs = deliverDirectBatch(store, sessionId, resolvePid(ctx));
		} catch (error) {
			console.error("ai-badger message-bus: startup delivery failed — fail-open, mail stays queued", error);
			return `message-bus startup check failed (mail stays queued): ${error instanceof Error ? error.message : String(error)}`;
		}
		if (directs.length === 0) return "no new private messages.";
		const notice = composeDirectStartNotice(directs);
		const ids = directs.map((m) => m.id);
		try {
			pi.appendEntry<MessageBusStartCardData>(MESSAGE_BUS_START_ENTRY_TYPE, { text: notice, count: directs.length, ids });
		} catch (error) {
			console.error("ai-badger message-bus: startup summary append failed — fail-open", error);
		}
		const canAsk =
			(ctx as { hasUI?: boolean }).hasUI !== false &&
			typeof (ctx as unknown as { ui?: { confirm?: unknown } }).ui?.confirm === "function";
		if (!canAsk) {
			// No user to ask (print/json/rpc or headless ctx): surface to the agent
			// so the mail is not silently consumed — same wire as the old start.
			sendCard(composeDeliveryNotice(directs), { kind: "delivery", count: directs.length, ids }, true);
			return notice;
		}
		try {
			const confirm = (ctx as unknown as { ui: { confirm: (title: string, message: string) => Promise<boolean> } }).ui.confirm;
			const acted = await confirm("Private messages", buildDirectStartQuestion(directs.length));
			if (acted) {
				sendCard(composeDeliveryNotice(directs), { kind: "delivery", count: directs.length, ids }, true);
			}
			return notice;
		} catch (error) {
			console.error("ai-badger message-bus: startup confirm failed — surfacing to agent instead of losing mail", error);
			sendCard(composeDeliveryNotice(directs), { kind: "delivery", count: directs.length, ids }, true);
			return notice;
		}
	};

	// ---- hooks (turn-boundary seam; the adapter's timer owns the idle wake)

	pi.on("session_start", async (_event, ctx) => {
		if (hooksDisabled()) return undefined;
		try {
			await runDirectStart(ctx);
		} catch (error) {
			console.error("ai-badger message-bus: session_start delivery failed — fail-open", error);
		}
		return undefined;
	});

	pi.on("turn_start", (_event, ctx) => {
		if (hooksDisabled()) return undefined;
		try {
			runCheck(ctx, false);
		} catch (error) {
			console.error("ai-badger message-bus: turn_start delivery failed — fail-open", error);
		}
		return undefined;
	});

	// ---- tool

	const ToolParams = Type.Object({
		action: Type.Union([Type.Literal("send"), Type.Literal("list"), Type.Literal("check"), Type.Literal("ack")], {
			description: "send: store one message; list: grouped inbox (no cursor advance); check: deliver new mail now; ack: ack one received message by id",
		}),
		content: Type.Optional(Type.String({ description: "send: message body (required for send)" })),
		sessionId: Type.Optional(Type.String({ description: "send: target session id for a 1:1 send (wins over projectId)" })),
		projectId: Type.Optional(Type.String({ description: "send: target project id for a project broadcast (omit both for machine broadcast)" })),
		id: Type.Optional(Type.Number({ description: "ack: the received message id to ack" })),
		depth: Type.Optional(Type.Number({ description: `list: per-scope depth (default ${DEFAULT_LIST_DEPTH})` })),
	});
	type ToolParams = { action: "send" | "list" | "check" | "ack"; content?: string; sessionId?: string; projectId?: string; id?: number; depth?: number };

	const execute = async (_toolCallId: string, params: ToolParams, _signal: unknown, _onUpdate: unknown, ctx: unknown): Promise<ToolResult> => {
		const context = ctx as ExtensionContext;
		switch (params.action) {
			case "send": {
				const content = params.content?.trim();
				if (!content) throw new Error('message-bus send needs "content"');
				const senderSession = resolveSid(context);
				if (!senderSession) throw new Error("send refused: missing sender identity (sessionId)");
				const senderProject = resolvePid(context);
				if (!senderProject) throw new Error("send refused: missing sender identity (projectId) — run inside a project carrying .ai-badger/project-id");
				const targets = normalizeSendTargets(params.sessionId, params.projectId);
				const rowId = storeFor(context.cwd).send({ senderSession, senderProject, content, ...targets });
				const scope = targets.targetSession ? "direct" : targets.targetProject ? "project broadcast" : "machine broadcast";
				return textResult(`sent ${rowId} (${scope})`, { rowId, ...targets });
			}
			case "list": {
				const sessionId = resolveSid(context);
				if (!sessionId) throw new Error("message-bus unavailable: no session id");
				const depth = Number.isFinite(params.depth) && (params.depth as number) > 0 ? Math.min(10, Math.floor(params.depth as number)) : DEFAULT_LIST_DEPTH;
				const store = storeFor(context.cwd);
				const messages = store.listForSession(sessionId, resolvePid(context));
				const cursor = store.getCursor(sessionId);
				return textResult(formatList(messages, cursor, depth), { count: messages.length, cursor });
			}
			case "check": {
				const text = runCheck(context, false);
				return textResult(text, { action: "check" });
			}
			case "ack": {
				if (!Number.isFinite(params.id)) throw new Error('message-bus ack needs "id" — the received message id (see list)');
				const sessionId = resolveSid(context);
				if (!sessionId) throw new Error("send refused: missing sender identity (sessionId)");
				const senderProject = resolvePid(context);
				if (!senderProject) throw new Error("send refused: missing sender identity (projectId)");
				const store = storeFor(context.cwd);
				const senderProjectForAck = resolvePid(context);
				const original = findInInbox(store, sessionId, senderProjectForAck, Math.floor(params.id as number));
				if (!original) throw new Error(`no message #${params.id} in your inbox — see list`);
				if (isAck(original.content)) throw new Error(`message #${params.id} is already an ack — acks are terminal, never reply to one`);
				const ackBody = buildAckContent(original);
				if (!ackBody) throw new Error(`message #${params.id} is already an ack — acks are terminal, never reply to one`);
				const rowId = store.send({ senderSession: sessionId, senderProject, content: ackBody, targetSession: null, targetProject: senderProject });
				return textResult(`ack sent ${rowId} (${ACK_PREFIX} #${original.id})`, { rowId, ackedId: original.id });
			}
			default:
				throw new Error('message-bus action must be one of send, list, check, ack');
		}
	};

	pi.registerTool({
		name: MESSAGE_BUS_TOOL_NAME,
		label: "Message Bus",
		description: [
			"Native pi message-bus on the ai-badger backend. Actions:",
			'send content (+sessionId for 1:1, +projectId for project broadcast, neither for machine broadcast);',
			"list (grouped inbox for this session: direct / project / broadcast, last N each, no cursor advance);",
			"check (deliver new mail now, posts a card when there is any);",
			"ack id (ack one received message once as a project broadcast — acks are terminal, never ack an ack).",
			"Fail-open: a broken bus returns an error result, never breaks the session.",
		].join(" "),
		parameters: ToolParams,
		execute,
	});

	// ---- command

	const MESSAGES_USAGE = "usage: /messages [list|check|ack <id>|send <text>|send-to <session-id> <text>]";

	pi.registerCommand(MESSAGE_BUS_COMMAND_NAME, {
		description: "Message-bus inbox: list (default) shows last 3 per scope, check delivers now, ack <id> acks once, send/send-to posts.",
		getArgumentCompletions(argumentPrefix) {
			const first = argumentPrefix.trim().split(/\s+/)[0] ?? "";
			const verbs = ["list", "check", "ack", "send", "send-to"].filter((v) => v.startsWith(first));
			const items = verbs.map((verb) => ({ value: verb, label: verb, description: `messages ${verb}` }));
			return items.length > 0 ? items : null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const notify = (message: string, type: "info" | "warning" | "error"): void => {
				ctx.ui.notify(message, type);
			};
			const trimmed = args.trim();
			if (trimmed === "" || trimmed === "list") {
				try {
					const sessionId = resolveSid(ctx);
					if (!sessionId) {
						notify("message-bus unavailable: no session id", "error");
						return;
					}
					const store = storeFor(ctx.cwd);
					notify(formatList(store.listForSession(sessionId, resolvePid(ctx)), store.getCursor(sessionId), DEFAULT_LIST_DEPTH), "info");
				} catch (error) {
					notify(`message-bus list failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (trimmed === "check") {
				notify(runCheck(ctx, false), "info");
				return;
			}
			const ackMatch = /^ack\s+(\d+)\s*$/.exec(trimmed);
			if (ackMatch) {
				try {
					const sessionId = resolveSid(ctx);
					const senderProject = resolvePid(ctx);
					if (!sessionId || !senderProject) {
						notify("send refused: missing sender identity", "error");
						return;
					}
					const store = storeFor(ctx.cwd);
					const original = findInInbox(store, sessionId, senderProject, Number(ackMatch[1]));
					if (!original) {
						notify(`no message #${ackMatch[1]} in your inbox`, "error");
						return;
					}
					const ackBody = buildAckContent(original);
					if (!ackBody) {
						notify(`message #${ackMatch[1]} is already an ack — never reply to one`, "warning");
						return;
					}
					const rowId = store.send({ senderSession: sessionId, senderProject, content: ackBody, targetSession: null, targetProject: senderProject });
					notify(`ack sent ${rowId} (${ACK_PREFIX} #${original.id})`, "info");
				} catch (error) {
					notify(`ack failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			const sendToMatch = /^send-to\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
			if (sendToMatch) {
				try {
					const sessionId = resolveSid(ctx);
					const senderProject = resolvePid(ctx);
					if (!sessionId || !senderProject) {
						notify("send refused: missing sender identity", "error");
						return;
					}
					const targets = normalizeSendTargets(sendToMatch[1], undefined);
					const rowId = storeFor(ctx.cwd).send({ senderSession: sessionId, senderProject, content: sendToMatch[2]!.trim(), ...targets });
					notify(`sent ${rowId} (direct to ${sendToMatch[1]})`, "info");
				} catch (error) {
					notify(`send failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			const sendMatch = /^send\s+([\s\S]+)$/.exec(trimmed);
			if (sendMatch) {
				try {
					const sessionId = resolveSid(ctx);
					const senderProject = resolvePid(ctx);
					if (!sessionId || !senderProject) {
						notify("send refused: missing sender identity", "error");
						return;
					}
					const rowId = storeFor(ctx.cwd).send({ senderSession: sessionId, senderProject, content: sendMatch[1]!.trim(), targetSession: null, targetProject: senderProject });
					notify(`sent ${rowId} (project broadcast)`, "info");
				} catch (error) {
					notify(`send failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			notify(MESSAGES_USAGE, "info");
		},
	});

	// ---- renderers (delivery card for the agent, startup card user-only)

	pi.registerMessageRenderer(MESSAGE_BUS_CUSTOM_TYPE, (message, options, theme) => {
		const body = typeof message.content === "string" ? message.content : "";
		if (!body) return undefined;
		const box = new Box(options.outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
		const lines = body.split("\n");
		box.addChild(new Text([theme.fg("success", lines[0] ?? ""), ...lines.slice(1)].join("\n"), 0, 0));
		return box;
	});

	// User-only startup summary: appendEntry keeps it out of LLM context and
	// never triggers a turn (update-check pattern). Guarded: older pi builds
	// without registerEntryRenderer simply skip the card (the confirm still gates).
	if (typeof (pi as unknown as { registerEntryRenderer?: unknown }).registerEntryRenderer === "function") {
		pi.registerEntryRenderer<MessageBusStartCardData>(MESSAGE_BUS_START_ENTRY_TYPE, (entry, _options, theme) => {
			const body = entry.data?.text ?? "";
			if (!body) return undefined;
			const box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
			const lines = body.split("\n");
			box.addChild(new Text([theme.fg("success", lines[0] ?? ""), ...lines.slice(1)].join("\n"), 0, 0));
			return box;
		});
	}
}
