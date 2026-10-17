/**
 * Pure helpers for the rtk statusline: parse `rtk gain` / `rtk llm-proxy status`, read proxy
 * savings from its SQLite file read-only, detect proxy routing, and format the status text.
 */

import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

export type ProxyState = "routed" | "routed-down" | "up" | "off";

export type StatusInput = {
	proxy: ProxyState;
	cmdPct?: number;
	proxyPct?: number;
	post?: { compressed: number; sent: number };
};

const DEFAULT_BIND = "127.0.0.1:8080";
const dash = "–";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pctText = (v: number | undefined) => (isNum(v) ? `${Math.round(v)}%` : dash);

/** Weighted savings (total_saved / total_input) from `rtk gain -f json`; undefined when malformed. */
export function parseGain(json: string): { pct: number | undefined; commands: number } | undefined {
	try {
		const summary = (JSON.parse(json) as { summary?: Record<string, unknown> } | null)?.summary;
		if (!summary || typeof summary !== "object") return undefined;
		const { total_commands: commands, total_input: input, total_saved: saved } = summary;
		if (!isNum(commands)) return undefined;
		const pct = isNum(input) && input > 0 && isNum(saved) ? (saved / input) * 100 : undefined;
		return { pct, commands };
	} catch {
		return undefined;
	}
}

/** `up` only for exit 0 with a "running at" line; everything else is `down`. */
export function parseProxyStatus(stdout: string, code: number): "up" | "down" {
	return code === 0 && typeof stdout === "string" && /^\s*running at\b/.test(stdout) ? "up" : "down";
}

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

export function formatStatus(input: StatusInput): string {
	const cmd = `cmd ${pctText(input.cmdPct)}`;
	switch (input.proxy) {
		case "routed": {
			const parts = ["rtk ⇄proxy", cmd, `proxy ${pctText(input.proxyPct)}`];
			if (input.post && input.post.sent > 0) parts.push(`post ${input.post.compressed}/${input.post.sent}`);
			return parts.join(" · ");
		}
		case "routed-down":
			return `rtk proxy down! · ${cmd}`;
		case "up":
			return `rtk proxy up · pi direct · ${cmd}`;
		case "off":
			return `rtk proxy off · ${cmd}`;
	}
}

export function shouldRefresh(now: number, last: number | undefined, minMs = 10_000): boolean {
	return last === undefined || now - last >= minMs;
}

/** Attribution headers for rtk-proxy; the session header is omitted when absent. */
export function proxyHeaders(cwd: string, sessionId: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { "x-rtk-project": cwd };
	if (sessionId) headers["x-rtk-session"] = sessionId;
	return headers;
}
