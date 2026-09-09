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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ACK_PREFIX,
	buildAckContent,
	buildDirectStartQuestion,
	buildReplyTargets,
	composeDeliveryNotice,
	composeDirectStartNotice,
	DEFAULT_LIST_DEPTH,
	filterDirect,
	formatDropLine,
	formatIdentityHeader,
	formatList,
	isAck,
	isValidBusId,
	MESSAGE_BUS_ENV,
	normalizeSendTargets,
	REGISTRY_TTL_S,
	registryVersion,
	selfSendWarning,
	type BusMessage,
	type RegistryEntry,
	type RegistrySnapshot,
	type StartupDropStats,
	unknownTargetWarning,
} from "./message-bus-core.ts";
/** Re-exported from core (single-source pin): the registry TTL, snapshot
 * types and kill-switch name live in core — this module stamps snapshots
 * with them but never redefines them. */
export { MESSAGE_BUS_ENV, REGISTRY_TTL_S, type RegistryEntry, type RegistrySnapshot } from "./message-bus-core.ts";
import { tickCoordinator } from "./coordinator.ts";
import { buildChannelCache, groupByScope, type ChannelCache } from "./coordinator-group.ts";

/** The message-bus card's custom message type. */
export const MESSAGE_BUS_CUSTOM_TYPE = "message-bus-event";

/** User-only startup summary entry (appendEntry — never enters LLM context). */
export const MESSAGE_BUS_START_ENTRY_TYPE = "message-bus-start";

/** Data stored on the user-only startup summary card. dropped* are P4:
 * present when the store reported silently-consumed counts, absent for
 * old stores (unknown, never zero). */
export interface MessageBusStartCardData {
	text: string;
	count: number;
	ids: number[];
	droppedDirects?: number;
	droppedBroadcasts?: number;
}

/** The LLM-facing tool name. */
export const MESSAGE_BUS_TOOL_NAME = "message-bus";

/** The human command. */
export const MESSAGE_BUS_COMMAND_NAME = "messages";

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

// ---------------------------------------------------------------------------
// registry heartbeat (PKG-1): read-side staleness + throttled touch
// ---------------------------------------------------------------------------

/** Touch throttle: at most one registry write per session per TTL/4. */
export const REGISTRY_TOUCH_INTERVAL_MS = (REGISTRY_TTL_S * 1000) / 4;

/** Live-registry read: rows newer than REGISTRY_TTL_S, stably ordered, with a
 * version pin. Fail-open (D31): a store without the read seam — or an
 * unreadable one — reads as empty, never throws. */
export function readRegistrySnapshot(store: Pick<BusStore, "listIdentities">, now: () => number): RegistrySnapshot {
	let rows: RegistryEntry[] = [];
	try {
		if (typeof store.listIdentities === "function") rows = store.listIdentities();
	} catch (error) {
		console.error("ai-badger message-bus: registry read failed — fail-open, snapshot reads empty", error);
		return { entries: [], version: registryVersion([]) };
	}
	const fresh = now() - REGISTRY_TTL_S * 1000;
	const entries = rows.filter((r) => r.lastSeenMs >= fresh).sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
	return { entries, version: registryVersion(entries) };
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
	 * broadcasts are consumed silently and never re-delivered on turn_start.
	 * dropped* (P4) count the swept-past mail when the store knows them —
	 * absent on old stores (unknown, never zero). */
	deliverDirectForSession(sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number; droppedDirects?: number; droppedBroadcasts?: number };
	/** Hook-path read (A1): the deliverForSession selection WITHOUT the cursor
	 * write, so the hook can hand the card to pi BEFORE the cursor passes it.
	 * OPTIONAL with fallback — stores without it keep deliver-then-post. The
	 * `check` tool never uses it. */
	peekForSession?(sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number };
	/** Hook-path read for startup (A1): the deliverDirectForSession selection
	 * WITHOUT the cursor write. Same optional-with-fallback contract. */
	peekDirectForSession?(sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number; droppedDirects?: number; droppedBroadcasts?: number };
	getCursor(sessionId: string): number;
	/** Identity registry (P3, OPTIONAL with fallback): extension-owned
	 * `bus_identities` rows written best-effort at session_start. Absent on
	 * old fakes — the wiring skips unknown-target warnings, still sends. */
	recordIdentity?(args: { sessionId: string; projectId: string | null }): void;
	hasIdentity?(sessionId: string): boolean;
	/** Registry read seam (PKG-1, OPTIONAL with fallback): live rows for
	 * readRegistrySnapshot. Absent on old fakes — the snapshot reads empty. */
	listIdentities?(): RegistryEntry[];
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
	`CREATE TABLE IF NOT EXISTS bus_identities (
		session_id TEXT PRIMARY KEY,
		project_id TEXT,
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
	/** Shared full-batch selection (A1): peek and deliver read the same rows —
	 * the only difference is the cursor write, so the hook can post the card
	 * before the cursor passes it with zero selection divergence. */
	const selectBatch = (db: SqliteDb, sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number } => {
		const cursorRow = db.prepare("SELECT cursor_id FROM cursors WHERE session_id = ?").get(sessionId) as { cursor_id?: unknown } | null | undefined;
		if (cursorRow === null || cursorRow === undefined) {
			const cutoff = new Date(now() - FIRST_READ_WINDOW_MS).toISOString();
			const rows = readAddressed(db, sessionId, projectId, 0, cutoff);
			const messages = rows.slice(0, FIRST_READ_CAP).map(rowToMessage);
			const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
			return { messages, cursor: Number(maxRow?.max_id ?? 0) };
		}
		const rows = readAddressed(db, sessionId, projectId, Number(cursorRow.cursor_id ?? 0), null);
		const messages = rows.map(rowToMessage);
		return { messages, cursor: messages.length > 0 ? messages[messages.length - 1]!.id : Number(cursorRow.cursor_id ?? 0) };
	};
	/** Shared direct-batch selection (A1): same read/write split for startup. */
	const selectDirectBatch = (
		db: SqliteDb,
		sessionId: string,
		projectId: string | null,
	): { messages: BusMessage[]; cursor: number; droppedDirects: number; droppedBroadcasts: number } => {
		const cursorRow = db.prepare("SELECT cursor_id FROM cursors WHERE session_id = ?").get(sessionId) as { cursor_id?: unknown } | null | undefined;
		// P4 swept-past counters: directs to me above the old cursor this
		// batch does NOT deliver (older-than-window + over-cap) +
		// broadcasts addressed to me above the old cursor (never
		// delivered on start — the cursor still lands past MAX).
		const countDirects = (afterId: number): number => {
			const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE target_session = ? AND id > ? AND sender_session <> ?").get(sessionId, afterId, sessionId) as { n?: unknown };
			return Number(row?.n ?? 0);
		};
		const countBroadcasts = (afterId: number): number => {
			if (!projectId) return 0; // project-less sessions are never delivered broadcasts (readAddressed parity)
			const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE target_session IS NULL AND (target_project = ? OR target_project IS NULL) AND id > ? AND sender_session <> ?").get(projectId, afterId, sessionId) as { n?: unknown };
			return Number(row?.n ?? 0);
		};
		if (cursorRow === null || cursorRow === undefined) {
			const cutoff = new Date(now() - FIRST_READ_WINDOW_MS).toISOString();
			const rows = readDirect(db, sessionId, 0, cutoff);
			const messages = rows.slice(0, FIRST_READ_CAP).map(rowToMessage);
			const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
			return { messages, cursor: Number(maxRow?.max_id ?? 0), droppedDirects: countDirects(0) - messages.length, droppedBroadcasts: countBroadcasts(0) };
		}
		const cursor = Number(cursorRow.cursor_id ?? 0);
		const rows = readDirect(db, sessionId, cursor, null);
		const messages = rows.map(rowToMessage);
		let nextCursor: number;
		if (messages.length > 0) {
			const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
			nextCursor = Number(maxRow?.max_id ?? 0);
		} else {
			const maxRow = db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as { max_id?: unknown };
			nextCursor = Math.max(cursor, Number(maxRow?.max_id ?? 0));
		}
		return { messages, cursor: nextCursor, droppedDirects: countDirects(cursor) - messages.length, droppedBroadcasts: countBroadcasts(cursor) };
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
		recordIdentity(args) {
			withDb((db) => {
				db.prepare("INSERT INTO bus_identities(session_id, project_id, ts) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, ts = excluded.ts").run(
					args.sessionId,
					args.projectId,
					new Date(now()).toISOString(),
				);
			});
		},
		hasIdentity(sessionId) {
			return withDb((db) => {
				const row = db.prepare("SELECT session_id FROM bus_identities WHERE session_id = ?").get(sessionId) as { session_id?: unknown } | null;
				return row !== null && row !== undefined;
			});
		},
		listIdentities() {
			return withDb((db) => {
				const rows = db.prepare("SELECT session_id, project_id, ts FROM bus_identities").all() as Array<{ session_id?: unknown; project_id?: unknown; ts?: unknown }>;
				return rows.map((r) => ({ sessionId: String(r.session_id), projectId: (r.project_id as string | null) ?? null, lastSeenMs: Date.parse(String(r.ts)) }));
			});
		},
		deliverForSession(sessionId, projectId) {
			return withDb((db) => {
				const selected = selectBatch(db, sessionId, projectId);
				db.prepare("INSERT INTO cursors(session_id, cursor_id, ts) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cursor_id = excluded.cursor_id, ts = excluded.ts").run(
					sessionId,
					selected.cursor,
					new Date(now()).toISOString(),
				);
				return selected;
			});
		},
		peekForSession(sessionId, projectId) {
			return withDb((db) => selectBatch(db, sessionId, projectId));
		},
		deliverDirectForSession(sessionId, projectId) {
			return withDb((db) => {
				const selected = selectDirectBatch(db, sessionId, projectId);
				db.prepare("INSERT INTO cursors(session_id, cursor_id, ts) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET cursor_id = excluded.cursor_id, ts = excluded.ts").run(
					sessionId,
					selected.cursor,
					new Date(now()).toISOString(),
				);
				return selected;
			});
		},
		peekDirectForSession(sessionId, projectId) {
			return withDb((db) => selectDirectBatch(db, sessionId, projectId));
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

// ---------------------------------------------------------------------------
// coordinator tick log (file-append: console.* breaks the pi TUI)
//
// Pi's ExtensionAPI/Context expose no log sink (no logger on either surface —
// verified against pi-coding-agent's extension types), so tick observability
// appends one line per turn_start here instead of stdout. Override with
// PI_BADGER_MESSAGE_BUS_TICK_LOG; empty string disables. Fail-open: a bad
// path or full disk never breaks the turn.
/** Env override for the coordinator tick log file; empty string disables it. */
export const COORDINATOR_TICK_LOG_ENV = "PI_BADGER_MESSAGE_BUS_TICK_LOG";

/** Coordinator tick log file (default: pi user-scope agent dir). */
export function coordinatorTickLogPath(env: Record<string, string | undefined>): string {
	const override = env[COORDINATOR_TICK_LOG_ENV];
	if (typeof override === "string") {
		if (!override.trim()) return "";
		return override.trim();
	}
	return join(homedir(), ".pi", "agent", "message-bus-coordinator-tick.log");
}

/** Fail-open single-line append for the coordinator tick (never throws). */
export function appendCoordinatorTickLog(env: Record<string, string | undefined>, line: string): void {
	const path = coordinatorTickLogPath(env);
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// observability-only — a bad path or full disk must not break the turn
	}
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
	/** Heartbeat touch (PKG-1): the SAME recordIdentity upsert session_start
	 * uses — no second write path. Throttled to one write per session per
	 * REGISTRY_TOUCH_INTERVAL_MS; best-effort, failure-silent (one console
	 * line). The stamp moves only on success so a failure retries next turn. */
	const lastRegistryTouch = new Map<string, number>();
	const touchRegistry = (store: BusStore, sessionId: string, projectId: string | null, force = false): void => {
		if (!sessionId) return;
		if (env[MESSAGE_BUS_ENV] === "0") return; // kill-switch: hooks AND registry writes stop, tools stay
		const t = now();
		if (!force) {
			const last = lastRegistryTouch.get(sessionId);
			if (last !== undefined && t - last < REGISTRY_TOUCH_INTERVAL_MS) return;
		}
		try {
			store.recordIdentity?.({ sessionId, projectId });
			lastRegistryTouch.set(sessionId, t);
		} catch (error) {
			console.error("ai-badger message-bus: identity upsert failed — fail-open", error);
		}
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

	/** Shared check: deliver + card when there is new mail. Returns human text
	 * with the identity header first (P2 co-order: header → body). */
	const runCheck = (ctx: ExtensionContext, triggerTurn: boolean): { text: string; cursor: number } => {
		const sessionId = resolveSid(ctx);
		if (!sessionId) return { text: "message-bus unavailable: no session id (sessionManager.getSessionId() answered empty)", cursor: 0 };
		let store: BusStore;
		try {
			store = storeFor(ctx.cwd);
		} catch (error) {
			return { text: `message-bus unavailable: ${error instanceof Error ? error.message : String(error)}`, cursor: 0 };
		}
		const projectId = resolvePid(ctx);
		const header = formatIdentityHeader(sessionId, projectId);
		touchRegistry(store, sessionId, projectId);
		let result: { messages: BusMessage[]; cursor: number };
		try {
			result = store.deliverForSession(sessionId, projectId);
		} catch (error) {
			console.error("ai-badger message-bus: delivery failed — fail-open, mail stays queued", error);
			let cursor = 0;
			try {
				cursor = store.getCursor(sessionId);
			} catch {
				// cursor stays unknown — the text already says mail is queued
			}
			return { text: `message-bus check failed (mail stays queued): ${error instanceof Error ? error.message : String(error)}`, cursor };
		}
		if (result.messages.length === 0) return { text: `${header}\nno new messages.`, cursor: result.cursor };
		const notice = `${header}\n${composeDeliveryNotice(result.messages)}`;
		sendCard(notice, { kind: "delivery", count: result.messages.length, ids: result.messages.map((m) => m.id) }, triggerTurn);
		return { text: notice, cursor: result.cursor };
	};

	/** Hook-path check (turn_start, A1): the delivery card must be agent-visible
	 * BEFORE the cursor passes it. Peeks without advancing, hands the card to
	 * pi, and advances only after acceptance — a rejected card holds the cursor
	 * so the next turn redelivers (at-least-once on the hook path ONLY). The
	 * `check` tool keeps deliver-then-post (runCheck); stores without the peek
	 * seam fall back to it. */
	const runHookCheck = (ctx: ExtensionContext): { text: string; cursor: number } => {
		const sessionId = resolveSid(ctx);
		if (!sessionId) return { text: "message-bus unavailable: no session id (sessionManager.getSessionId() answered empty)", cursor: 0 };
		let store: BusStore;
		try {
			store = storeFor(ctx.cwd);
		} catch (error) {
			return { text: `message-bus unavailable: ${error instanceof Error ? error.message : String(error)}`, cursor: 0 };
		}
		const peek = store.peekForSession;
		if (!peek) return runCheck(ctx, false);
		const projectId = resolvePid(ctx);
		const header = formatIdentityHeader(sessionId, projectId);
		touchRegistry(store, sessionId, projectId);
		let preview: { messages: BusMessage[]; cursor: number };
		try {
			preview = peek(sessionId, projectId);
		} catch (error) {
			console.error("ai-badger message-bus: delivery failed — fail-open, mail stays queued", error);
			let cursor = 0;
			try {
				cursor = store.getCursor(sessionId);
			} catch {
				// cursor stays unknown — the text already says mail is queued
			}
			return { text: `message-bus check failed (mail stays queued): ${error instanceof Error ? error.message : String(error)}`, cursor };
		}
		if (preview.messages.length === 0) return runCheck(ctx, false);
		const notice = `${header}\n${composeDeliveryNotice(preview.messages)}`;
		try {
			sendCard(notice, { kind: "delivery", count: preview.messages.length, ids: preview.messages.map((m) => m.id) }, false);
		} catch (error) {
			console.error("ai-badger message-bus: hook card rejected — fail-open, cursor held for redelivery", error);
			let cursor = 0;
			try {
				cursor = store.getCursor(sessionId);
			} catch {
				// cursor stays unknown — the mail stays queued either way
			}
			return { text: notice, cursor };
		}
		// Card accepted: settle the cursor past it (re-read discarded — the
			// preview above is what the agent was shown). Micro-race note: a
			// cross-process send landing between peek and settle advances past
			// unseen mail (silent skip); the window is synchronous microseconds —
			// targeted cursor-write was rejected as the bigger shape.
		try {
			const advanced = store.deliverForSession(sessionId, projectId);
			return { text: notice, cursor: advanced.cursor };
		} catch (error) {
			console.error("ai-badger message-bus: hook cursor advance failed — fail-open, next turn redelivers", error);
			let cursor = 0;
			try {
				cursor = store.getCursor(sessionId);
			} catch {
				// cursor stays unknown — the mail stays queued either way
			}
			return { text: notice, cursor };
		}
	};

	/** Startup read: direct-only batch (broadcasts consumed silently via cursor). */
	/** Startup read: direct-only batch (broadcasts consumed silently via cursor).
	 * Returns the full batch: counts ride along when the store reports them,
	 * absent on old stores (unknown, never zero — the caller keeps silence). */
	const deliverDirectBatch = (store: BusStore, sessionId: string, projectId: string | null): { messages: BusMessage[]; cursor: number; droppedDirects?: number; droppedBroadcasts?: number } => {
		if (typeof store.deliverDirectForSession === "function") {
			return store.deliverDirectForSession(sessionId, projectId);
		}
		const result = store.deliverForSession(sessionId, projectId);
		return { messages: filterDirect(result.messages), cursor: result.cursor };
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
		// A1: on stores with the peek seam, read WITHOUT advancing so the card is
		// accepted before the cursor passes it; the cursor settles after the post
		// (or after a "no"). Old stores keep deliver-then-post, byte for byte.
		const peekDirect = store.peekDirectForSession;
		let cardRejected = false;
		const settleCursor = (): void => {
			if (!peekDirect || cardRejected) return;
			try {
				deliverDirectBatch(store, sessionId, resolvePid(ctx));
			} catch (error) {
				console.error("ai-badger message-bus: startup cursor advance failed — fail-open, next turn redelivers", error);
			}
		};
		const postStartupCard = (directs: BusMessage[], ids: number[]): void => {
			if (!peekDirect) {
				// old path: a throw propagates to the session_start guard, as before
				sendCard(composeDeliveryNotice(directs), { kind: "delivery", count: directs.length, ids }, true);
				return;
			}
			try {
				sendCard(composeDeliveryNotice(directs), { kind: "delivery", count: directs.length, ids }, true);
			} catch (error) {
				cardRejected = true;
				console.error("ai-badger message-bus: startup card rejected — fail-open, cursor held for redelivery", error);
			}
		};
		let batch: { messages: BusMessage[]; cursor: number; droppedDirects?: number; droppedBroadcasts?: number };
		try {
			batch = peekDirect ? peekDirect(sessionId, resolvePid(ctx)) : deliverDirectBatch(store, sessionId, resolvePid(ctx));
		} catch (error) {
			console.error("ai-badger message-bus: startup delivery failed — fail-open, mail stays queued", error);
			return `message-bus startup check failed (mail stays queued): ${error instanceof Error ? error.message : String(error)}`;
		}
		const directs = batch.messages;
		// P4: present counts or unknown (old stores) — unknown keeps today's
		// silence, never a zero-drop claim.
		const stats: StartupDropStats | undefined =
			typeof batch.droppedDirects === "number" || typeof batch.droppedBroadcasts === "number"
				? { droppedDirects: batch.droppedDirects ?? 0, droppedBroadcasts: batch.droppedBroadcasts ?? 0 }
				: undefined;
		const dropped = (stats?.droppedDirects ?? 0) + (stats?.droppedBroadcasts ?? 0);
		if (directs.length === 0) {
			if (stats && dropped > 0) {
				// Broadcasts-only startup USED to be silent (no summary, no card).
				// P4 changes that on purpose: the cursor still consumed mail, so a
				// user-only entry now names what was swept past — no agent card,
				// no turn, no confirm (nothing to act on).
				const text = `message-bus: no new private messages (${formatDropLine(stats)})`;
				try {
					pi.appendEntry<MessageBusStartCardData>(MESSAGE_BUS_START_ENTRY_TYPE, { text, count: 0, ids: [], ...stats });
				} catch (error) {
					console.error("ai-badger message-bus: startup summary append failed — fail-open", error);
				}
				settleCursor();
				return text;
			}
			settleCursor();
			return "no new private messages.";
		}
		const notice = composeDirectStartNotice(directs, stats);
		const ids = directs.map((m) => m.id);
		try {
			pi.appendEntry<MessageBusStartCardData>(MESSAGE_BUS_START_ENTRY_TYPE, { text: notice, count: directs.length, ids, ...(stats ?? {}) });
		} catch (error) {
			console.error("ai-badger message-bus: startup summary append failed — fail-open", error);
		}
		const canAsk =
			(ctx as { hasUI?: boolean }).hasUI !== false &&
			typeof (ctx as unknown as { ui?: { confirm?: unknown } }).ui?.confirm === "function";
		if (!canAsk) {
			// No user to ask (print/json/rpc or headless ctx): surface to the agent
			// so the mail is not silently consumed — same wire as the old start.
			// A1: the cursor settles only after the card is accepted.
			postStartupCard(directs, ids);
			settleCursor();
			return notice;
		}
		try {
			const confirm = (ctx as unknown as { ui: { confirm: (title: string, message: string) => Promise<boolean> } }).ui.confirm;
			const acted = await confirm("Private messages", buildDirectStartQuestion(directs.length));
			if (acted) {
				postStartupCard(directs, ids);
			}
			settleCursor();
			return notice;
		} catch (error) {
			console.error("ai-badger message-bus: startup confirm failed — surfacing to agent instead of losing mail", error);
			postStartupCard(directs, ids);
			settleCursor();
			return notice;
		}
	};

	// ---- hooks (turn-boundary seam; the adapter's timer owns the idle wake)

	pi.on("session_start", async (_event, ctx) => {
		if (hooksDisabled()) return undefined;
		// P3 registry-lite: record our own session id best-effort so future
		// direct senders get silence instead of an unknown-target warning.
		// Never blocks delivery — a registry failure just logs. The sid guard
		// keeps an empty identity from opening the store for a write that
		// touchRegistry would then discard (no spurious fail-open line).
		const sid = resolveSid(ctx);
		if (sid) {
			try {
				touchRegistry(storeFor(ctx.cwd), sid, resolvePid(ctx), true);
			} catch (error) {
			console.error("ai-badger message-bus: identity upsert failed — fail-open", error);
			}
		}
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
			runHookCheck(ctx);
		} catch (error) {
			console.error("ai-badger message-bus: turn_start delivery failed — fail-open", error);
		}
		return undefined;
	});

	// ---- coordinator tick wire-in (PKG-4A): piggyback wake-set inside live turns
	//
	// Composes PKG-1 (readRegistrySnapshot) → PKG-2 (groupByScope, version-gated
	// buildChannelCache) → PKG-3 (tickCoordinator), read-only end to end: the
	// tick only computes WHO has pending mail and the result is file-append
	// observability (coordinator tick log — console.* breaks the pi TUI)
	// — zero cards, zero cursor writes, zero registry writes.
	// Fail-open per-tick catch: any failure logs one line and the turn proceeds.
	// Idle-machine wake is struck by design (d-728: no pi host owns a durable
	// tick) — this seam only observes turns that are starting anyway.
	let coordinatorChannels: ChannelCache | null = null;
	const runCoordinatorTick = async (ctx: ExtensionContext): Promise<void> => {
		const sessionId = resolveSid(ctx);
		if (!sessionId) return;
		let store: BusStore;
		try {
			store = storeFor(ctx.cwd);
		} catch (error) {
			console.error("ai-badger message-bus: coordinator tick unavailable — fail-open", error);
			return;
		}
		try {
			const snapshot = readRegistrySnapshot(store, now);
			const projectId = resolvePid(ctx);
			// PKG-2 observability: group this turn's peeked rows into channels
			// (pure; the cache rebuilds only when the registry version moves).
			// Read-only like the tick; its failure never breaks the wake set.
			let channelSummary = "n/a";
			try {
				// Lazy preview: the peek runs INSIDE the compute closure, so it
				// executes only on a cache miss — steady-state cache hits cost
				// zero store reads. Still fail-open via the wrapper below.
				coordinatorChannels = buildChannelCache(coordinatorChannels, snapshot, () => {
					const preview =
						typeof store.peekForSession === "function"
							? store.peekForSession(sessionId, projectId)
							: { messages: store.listForSession(sessionId, projectId).filter((m) => m.id > store.getCursor(sessionId)) };
					return groupByScope(preview.messages, projectId);
				});
				channelSummary = Object.entries(coordinatorChannels.channels)
					.map(([key, rows]) => `${key}:${rows.length}`)
					.join(",");
			} catch {
				// grouping is observability-only — the wake set still computes
			}
			const result = await tickCoordinator(store, snapshot, { now: now(), env });
			appendCoordinatorTickLog(
				env,
				`coordinator tick: woke=[${result.woke.join(",")}] errors=${result.errors.length} truncated=${result.truncated} channels={${channelSummary}}`,
			);
		} catch (error) {
			console.error("ai-badger message-bus: coordinator tick failed — fail-open", error);
		}
	};

	pi.on("turn_start", (_event, ctx) => {
		if (hooksDisabled()) return undefined;
		return runCoordinatorTick(ctx);
	});
	// ---- end coordinator tick wire-in (PKG-4A)

	// ---- tool

	const ToolParams = Type.Object({
		action: Type.Union([Type.Literal("send"), Type.Literal("list"), Type.Literal("check"), Type.Literal("ack"), Type.Literal("reply"), Type.Literal("whoami")], {
			description: "send: store one message; list: grouped inbox (no cursor advance); check: deliver new mail now; ack: ack one received message by id; reply: answer the sender of one received message by id — never copy a session id from message content, reply by id; whoami: your session id + project id + cursor",
		}),
		content: Type.Optional(Type.String({ description: "send/reply: message body (required for send and reply)" })),
		sessionId: Type.Optional(Type.String({ description: "send: target session id for a 1:1 send (wins over projectId)" })),
		projectId: Type.Optional(Type.String({ description: "send: target project id for a project broadcast (omit both for machine broadcast)" })),
		id: Type.Optional(Type.Number({ description: "ack/reply: the received message id to ack or reply to (see list)" })),
		depth: Type.Optional(Type.Number({ description: `list: per-scope depth (default ${DEFAULT_LIST_DEPTH})` })),
	});
	type ToolParams = { action: "send" | "list" | "check" | "ack" | "reply" | "whoami"; content?: string; sessionId?: string; projectId?: string; id?: number; depth?: number };

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
				// P3 shape gate (pre-insert): every non-blank raw target id must be
				// well-formed — blanks read as unset (normalize), malformed (#672)
				// rejects before a row exists.
				for (const raw of [params.sessionId, params.projectId]) {
					if (typeof raw === "string" && raw.trim() && !isValidBusId(raw.trim())) {
						throw new Error(`send refused: invalid target id shape (whitespace / $(...) / backtick / newline rejected)`);
					}
				}
				const targets = normalizeSendTargets(params.sessionId, params.projectId);
				const store = storeFor(context.cwd);
				const rowId = store.send({ senderSession, senderProject, content, ...targets });
				const scope = targets.targetSession ? "direct" : targets.targetProject ? "project broadcast" : "machine broadcast";
				// P3 fail-open warnings: success + warning, never a block. A
				// registry failure (or an old store without the registry) stays
				// silent — the send already landed.
				let warning: string | undefined;
				if (targets.targetSession === senderSession) {
					warning = selfSendWarning(senderSession);
				} else if (targets.targetSession && typeof store.hasIdentity === "function") {
					try {
						if (!store.hasIdentity(targets.targetSession)) warning = unknownTargetWarning(targets.targetSession);
					} catch (error) {
						// registry unreadable — fail-open, send stands without warning
						console.error("ai-badger message-bus: identity check failed — fail-open, send stands without warning", error);
					}
				}
				const text = warning ? `sent ${rowId} (${scope}) — warning: ${warning}` : `sent ${rowId} (${scope})`;
				return textResult(text, warning ? { rowId, ...targets, warning } : { rowId, ...targets });
			}
			case "list": {
				const sessionId = resolveSid(context);
				if (!sessionId) throw new Error("message-bus unavailable: no session id");
				const depth = Number.isFinite(params.depth) && (params.depth as number) > 0 ? Math.min(10, Math.floor(params.depth as number)) : DEFAULT_LIST_DEPTH;
				const store = storeFor(context.cwd);
				const projectId = resolvePid(context);
				const messages = store.listForSession(sessionId, projectId);
				let cursor = 0;
				try {
					cursor = store.getCursor(sessionId);
				} catch {
					// fail-open: list without a cursor still answers
				}
				return textResult(`${formatIdentityHeader(sessionId, projectId)}\n${formatList(messages, cursor, depth)}`, { count: messages.length, cursor });
			}
			case "check": {
				const { text, cursor } = runCheck(context, false);
				return textResult(text, { action: "check", cursor });
			}
			case "whoami": {
				const sessionId = resolveSid(context);
				const projectId = resolvePid(context);
				if (!sessionId) return textResult("message-bus unavailable: no session id (sessionManager.getSessionId() answered empty)", { sessionId: "", projectId, cursor: 0 });
				let cursor = 0;
				try {
					cursor = storeFor(context.cwd).getCursor(sessionId);
				} catch {
					// fail-open: identity without a cursor is still an answer
				}
				return textResult(formatIdentityHeader(sessionId, projectId), { sessionId, projectId, cursor });
			}
			case "reply": {
				if (!Number.isFinite(params.id)) throw new Error('message-bus reply needs "id" — the received message id (see list)');
				const content = params.content?.trim();
				if (!content) throw new Error('message-bus reply needs "content"');
				const sessionId = resolveSid(context);
				if (!sessionId) throw new Error("send refused: missing sender identity (sessionId)");
				const senderProject = resolvePid(context);
				if (!senderProject) throw new Error("send refused: missing sender identity (projectId)");
				const store = storeFor(context.cwd);
				const original = findInInbox(store, sessionId, senderProject, Math.floor(params.id as number));
				if (!original) throw new Error(`no message #${params.id} in your inbox — see list`);
				if (original.senderSession === sessionId) throw new Error(`message #${params.id} is your own send — a reply would self-send (never deliverable)`);
				if (isAck(original.content)) throw new Error(`message #${params.id} is already an ack — acks are terminal, never reply to one`);
				const targets = buildReplyTargets(original);
				const rowId = store.send({ senderSession: sessionId, senderProject, content, ...targets });
				// F1 replay: the sender may be dead (no identity row) — P3
				// warning helper reused, success + warning, never a block.
				let warning: string | undefined;
				if (typeof store.hasIdentity === "function") {
					try {
						if (!store.hasIdentity(targets.targetSession)) warning = unknownTargetWarning(targets.targetSession);
					} catch (error) {
						// registry unreadable — fail-open, reply stands without warning
						console.error("ai-badger message-bus: identity check failed — fail-open, reply stands without warning", error);
					}
				}
				const sid8 = targets.targetSession.slice(0, 8);
				const text = warning
					? `sent ${rowId} (replied to #${original.id} from ${sid8}) — warning: ${warning}`
					: `sent ${rowId} (replied to #${original.id} from ${sid8})`;
				return textResult(text, warning ? { rowId, repliedTo: original.id, ...targets, warning } : { rowId, repliedTo: original.id, ...targets });
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
				throw new Error('message-bus action must be one of send, list, check, ack, reply, whoami');
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
			"ack id (ack one received message once as a project broadcast — acks are terminal, never ack an ack);",
			"reply id content (answer the sender of one received message 1:1 — never copy a session id from message content, reply by id);",
			"whoami (your session id + project id + cursor).",
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
					const projectId = resolvePid(ctx);
					notify(`${formatIdentityHeader(sessionId, projectId)}\n${formatList(store.listForSession(sessionId, projectId), store.getCursor(sessionId), DEFAULT_LIST_DEPTH)}`, "info");
				} catch (error) {
					notify(`message-bus list failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (trimmed === "check") {
				notify(runCheck(ctx, false).text, "info");
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
					// P3 shape gate parity with tool send (pre-insert): malformed
					// rejects before a row exists.
					const rawTarget = sendToMatch[1]!.trim();
					if (rawTarget && !isValidBusId(rawTarget)) {
						throw new Error(`send refused: invalid target id shape (whitespace / $(...) / backtick / newline rejected)`);
					}
					const store = storeFor(ctx.cwd);
					const rowId = store.send({ senderSession: sessionId, senderProject, content: sendToMatch[2]!.trim(), ...targets });
					// P3 fail-open warnings parity with tool send (success + warning).
					let warning: string | undefined;
					if (targets.targetSession === sessionId) {
						warning = selfSendWarning(sessionId);
					} else if (targets.targetSession && typeof store.hasIdentity === "function") {
						try {
							if (!store.hasIdentity(targets.targetSession)) warning = unknownTargetWarning(targets.targetSession);
						} catch (error) {
							console.error("ai-badger message-bus: identity check failed — fail-open, send stands without warning", error);
						}
					}
					notify(warning ? `sent ${rowId} (direct to ${sendToMatch[1]}) — warning: ${warning}` : `sent ${rowId} (direct to ${sendToMatch[1]})`, "info");
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
