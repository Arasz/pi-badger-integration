/**
 * rtk-proxy helpers: bind address and URL, routing detection, attribution headers, and the
 * project's savings share read from the proxy database (rtk-proxy.db, opened read-only).
 */

import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const DEFAULT_BIND = "127.0.0.1:8080";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Location of rtk-proxy.db: absolute RTK_PROXY_DB, else the platform data dir. */
export function proxyDbPath(env: Record<string, string | undefined>, home: string, platform: string): string {
	const override = env.RTK_PROXY_DB;
	if (override && isAbsolute(override)) return override;
	if (platform === "darwin") return join(home, "Library", "Application Support", "rtk", "llm-proxy", "rtk-proxy.db");
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "rtk", "llm-proxy", "rtk-proxy.db");
}

/** Savings share for rows whose project is `project` or under `project/`; undefined on any failure. */
export function readProxyUsage(dbPath: string, project: string): { pct: number | undefined } | undefined {
	try {
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const row = db
				.prepare(
					"SELECT COUNT(*) AS n, SUM(tokens_in) AS tin, SUM(tokens_saved) AS saved FROM usage_records WHERE project = ? OR project LIKE ? || '/%' ESCAPE '\\'",
				)
				.get(project, project.replace(/[\\%_]/g, "\\$&")) as { n: number; tin: number | null; saved: number | null };
			const pct = row.n > 0 && isNum(row.tin) && row.tin > 0 && isNum(row.saved) ? (row.saved / row.tin) * 100 : undefined;
			return { pct };
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

export function proxyBind(env: Record<string, string | undefined>): string {
	return env.RTK_PROXY_BIND || DEFAULT_BIND;
}

export function proxyUrl(env: Record<string, string | undefined>): string {
	return `http://${proxyBind(env)}`;
}

function hostPort(raw: string): string | undefined {
	try {
		const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
		if (!u.hostname) return undefined;
		const host = u.hostname.toLowerCase();
		return `${host === "localhost" ? "127.0.0.1" : host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
	} catch {
		return undefined;
	}
}

/** True when `baseUrl` points at the proxy `bind` (host:port match, path ignored). */
export function isRouted(baseUrl: string | undefined, bind: string): boolean {
	if (!baseUrl) return false;
	const a = hostPort(baseUrl);
	const b = hostPort(bind);
	return a !== undefined && a === b;
}

// fetch rejects header values outside Latin-1 after the handler returns, failing the request.
const sendable = (value: string | undefined): value is string => !!value && /^[\x20-\x7e]*$/.test(value);

/** Attribution headers for rtk-proxy; each is omitted when absent or not printable ASCII. */
export function proxyHeaders(cwd: string, sessionId: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	if (sendable(cwd)) headers["x-rtk-project"] = cwd;
	if (sendable(sessionId)) headers["x-rtk-session"] = sessionId;
	return headers;
}
