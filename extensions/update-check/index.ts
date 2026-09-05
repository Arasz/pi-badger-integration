/**
 * Update-check wiring: session_start background release check + `/update-check`.
 *
 * What this is NOT (read before extending): pi exposes no update lifecycle
 * event, so nothing here "hooks into `pi update`". The extension checks the
 * integration repo's GitHub releases in the background after startup and
 * posts at most one notice per session when a newer release exists. `pi
 * update` stays the path for pi itself, by documentation only.
 *
 * Notify-only, never auto-install: the update path (`git pull` + publish)
 * mutates user scope and possibly another checkout, which needs a human.
 * Offline and fetch failures are silent at session start (next session
 * retries); `/update-check check` reports them verbosely instead.
 *
 * Session-only: the noticed flag resets on `session_shutdown`, nothing is
 * persisted, and `PI_BADGER_UPDATE_CHECK=0` disables the background check.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	UPDATE_CHECK_ENV,
	UPDATE_CHECK_RELEASES_URL,
	decideCheck,
	isDisabled,
} from "./update-check-core.ts";

/** The human command: `/update-check [status|check]`. */
export const UPDATE_CHECK_COMMAND = "update-check";

/** Custom message type of the update notice cards. */
export const UPDATE_CHECK_CUSTOM_TYPE = "update-check-event";

/** Usage line answered to unknown `/update-check` subcommands. */
export const UPDATE_CHECK_USAGE = "usage: /update-check [status|check]";

/** The `/update-check` subcommands offered by argument completion. */
export const UPDATE_CHECK_SUBCOMMANDS = ["status", "check"] as const;

/** Per-attempt fetch ceiling (ms). */
export const UPDATE_CHECK_FETCH_TIMEOUT_MS = 15_000;

/** Injectable fetch seam so tests stub the releases API. */
export type UpdateCheckFetch = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Injectable timer seam so tests fire the deferred check synchronously. */
export interface UpdateCheckScheduler {
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Injectable seams: fetch, scheduler, env, marker path, timeout. */
export interface UpdateCheckDeps {
	/** Defaults to global fetch. */
	fetchFn?: UpdateCheckFetch;
	/** Defaults to the globals. */
	scheduler?: UpdateCheckScheduler;
	/** Env record, read PER CALL. Defaults to process.env (live, never copied). */
	env?: { readonly [name: string]: string | undefined };
	/** Installed-version marker written by publish. Defaults to the user-scope path. */
	markerPath?: string;
	/** Fetch ceiling. Defaults to 15 s. */
	timeoutMs?: number;
}

function defaultMarkerPath(): string {
	// Sibling of extensions/, not inside the owned extension dir: publish's
	// --check enforces exact file-set equality per owned dir, so per-install
	// state lives outside it (written by publish, read here).
	return join(homedir(), ".pi", "agent", "update-check", "installed.json");
}

interface CheckReport {
	installed: string | null;
	remoteTag: string | null;
	conclusion: string;
}

export default function (pi: ExtensionAPI, deps: UpdateCheckDeps = {}) {
	if (typeof pi?.registerCommand !== "function") {
		console.error(
			"ai-badger: pi.registerCommand is not a function — this pi build's extension API has moved; the update check is not installed.",
		);
		return;
	}

	const scheduler: UpdateCheckScheduler = deps.scheduler ?? {
		setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const env = deps.env ?? process.env;
	const markerPath = deps.markerPath ?? defaultMarkerPath();
	const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_FETCH_TIMEOUT_MS;
	const fetchFn: UpdateCheckFetch =
		deps.fetchFn ??
		((url, init) => (globalThis.fetch as typeof fetch)(url, init as RequestInit) as never);

	let timer: unknown;
	let noticedThisSession = false;
	let lastReport: CheckReport | undefined;

	const readInstalled = (): string | null => {
		try {
			const raw = readFileSync(markerPath, "utf8");
			const parsed = JSON.parse(raw) as { version?: unknown };
			return typeof parsed.version === "string" ? parsed.version : null;
		} catch {
			return null;
		}
	};

	const fetchRemoteTag = async (): Promise<{ tag: string | null; error?: string }> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchFn(UPDATE_CHECK_RELEASES_URL, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-badger-update-check" },
				signal: controller.signal,
			});
			if (!response.ok) {
				// 404 = no releases published yet → null tag, no error (a state, not a failure).
				if (response.status === 404) return { tag: null };
				return { tag: null, error: `HTTP ${response.status}` };
			}
			const body = (await response.json()) as { tag_name?: unknown };
			return typeof body.tag_name === "string" ? { tag: body.tag_name } : { tag: null, error: "release without tag_name" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { tag: null, error: controller.signal.aborted ? "timeout" : message };
		} finally {
			clearTimeout(timeout);
		}
	};

	const sendNotice = (content: string, details: Record<string, unknown>): void => {
		pi.sendMessage(
			{ customType: UPDATE_CHECK_CUSTOM_TYPE, content, display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	/** Run one check; notices at most once per session. Returns the report either way. */
	const runCheck = async (): Promise<CheckReport> => {
		const installed = readInstalled();
		const remote = await fetchRemoteTag();
		const decision = decideCheck({
			networkUp: true,
			installed,
			remoteTag: remote.tag,
			remoteError: remote.error,
		});
		const report: CheckReport = {
			installed,
			remoteTag: remote.tag,
			conclusion:
				decision.action === "notice"
					? decision.reason
					: remote.error !== undefined
						? `check failed (${remote.error}) — silent at session start, retrying next session`
						: decision.reason,
		};
		lastReport = report;
		if (decision.action === "notice" && !noticedThisSession) {
			noticedThisSession = true;
			sendNotice(decision.text, { kind: decision.kind, installed, remoteTag: remote.tag });
		}
		return report;
	};

	const statusText = (): string => {
		if (lastReport === undefined) {
			const installed = readInstalled();
			return [
				"update-check status",
				`installed: ${installed ?? "unknown (publish this checkout to record it)"}`,
				"remote: unchecked this session",
				`kill-switch: ${isDisabled(env) ? `disabled via ${UPDATE_CHECK_ENV}=0` : "enabled"}`,
			].join("\n");
		}
		return [
			"update-check status",
			`installed: ${lastReport.installed ?? "unknown"}`,
			`remote: ${lastReport.remoteTag ?? "none"}`,
			`last check: ${lastReport.conclusion}`,
			`kill-switch: ${isDisabled(env) ? `disabled via ${UPDATE_CHECK_ENV}=0` : "enabled"}`,
		].join("\n");
	};

	pi.on("session_start", () => {
		if (isDisabled(env)) return undefined;
		if (timer !== undefined) scheduler.clearTimeout(timer);
		timer = scheduler.setTimeout(() => {
			timer = undefined;
			// Returned (not floated) so tests and shutdown can await the check;
			// real timers ignore a timeout handler's return value.
			return runCheck().catch((error) => {
				console.error("ai-badger update-check: background check failed — notice-only", error);
			});
		}, 1000);
		return undefined;
	});

	pi.on("session_shutdown", () => {
		if (timer !== undefined) {
			scheduler.clearTimeout(timer);
			timer = undefined;
		}
		noticedThisSession = false;
		lastReport = undefined;
	});

	pi.registerCommand(UPDATE_CHECK_COMMAND, {
		description: "Integration update status: status (default) shows installed/remote, check runs a verbose check now.",
		getArgumentCompletions(argumentPrefix) {
			const first = argumentPrefix.trim();
			const items = UPDATE_CHECK_SUBCOMMANDS.filter((verb) => verb.startsWith(first)).map((verb) => ({
				value: verb,
				label: verb,
				description: `update-check ${verb}`,
			}));
			return items.length > 0 ? items : null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const trimmed = args.trim();
			const notify = (message: string, type: "info" | "warning" | "error"): void => {
				ctx.ui.notify(message, type);
			};
			if (trimmed === "" || trimmed === "status") {
				notify(statusText(), "info");
				return;
			}
			if (trimmed === "check") {
				const report = await runCheck();
				notify(
					[
						`installed: ${report.installed ?? "unknown"}`,
						`remote: ${report.remoteTag ?? "none"}`,
						report.conclusion,
					].join("\n"),
					report.conclusion.startsWith("update:") ? "warning" : "info",
				);
				return;
			}
			notify(UPDATE_CHECK_USAGE, "info");
		},
	});

	pi.registerMessageRenderer(UPDATE_CHECK_CUSTOM_TYPE, (message, options, theme) => {
		const body = typeof message.content === "string" ? message.content : "";
		if (!body) return undefined;
		const box = new Box(options.outputPad, 1, (line: string) => theme.bg("customMessageBg", line));
		const lines = body.split("\n");
		box.addChild(new Text([theme.fg("warning", lines[0] ?? ""), ...lines.slice(1)].join("\n"), 0, 0));
		return box;
	});
}
