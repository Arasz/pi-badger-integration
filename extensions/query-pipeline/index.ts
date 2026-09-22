/**
 * query-pipeline extension entry: wiring only.
 *
 * The extension owns two hooks and nothing else:
 *  - `session_start` — one gated, session-scoped, fail-open Jev warm call to pay
 *    the measured cold-first-call penalty (≈$0.00002/session).
 *  - `session_shutdown` — reset the session scope and clear the pinned status /
 *    widget keys (guarded; a stale ctx must never throw).
 *
 * The runner itself is a library (`pipeline.ts`) consumed by mem-based-rag; this
 * file exists so the preload runs once per session and so a future command
 * surface has a home. Tests inject every seam.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JEV_API_KEY_ENV, QP_STATUS_KEY, QP_WIDGET_KEY, QUERY_PIPELINE_ENV, type PipelineScheduler } from "./types.ts";
import { warmJevScore, type JevScoreDeps } from "./jev-client.ts";
import { defaultJevFetch } from "./pipeline.ts";

/** Injectable seams; every one defaults to the live pi/process surface. */
export interface QueryPipelineExtensionDeps {
	/** Preload call; defaults to one tiny Jev score call. */
	warm?: () => Promise<void>;
	/** Env record, read PER CALL. Defaults to process.env (live, never copied). */
	env?: Record<string, string | undefined>;
	/** Defaults to the globals. */
	scheduler?: PipelineScheduler;
	/** Defaults to Date.now. */
	now?: () => number;
	/** Defaults to the global fetch adapter. */
	fetchFn?: JevScoreDeps["fetchFn"];
}

const REAL_SCHEDULER: PipelineScheduler = {
	setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export default function queryPipelineExtension(pi: ExtensionAPI, deps: QueryPipelineExtensionDeps = {}): void {
	/** Session scope: one warm per session instance; reset by session_shutdown. */
	let warmed = false;

	const clearSurface = (ctx: unknown): void => {
		try {
			const ui = (ctx as { ui?: { setStatus?: (k: string, t: string | undefined) => void; setWidget?: (k: string, c: string[] | undefined) => void } }).ui;
			ui?.setStatus?.(QP_STATUS_KEY, undefined);
			ui?.setWidget?.(QP_WIDGET_KEY, undefined);
		} catch {
			// a stale ctx must never break shutdown
		}
	};

	pi.on("session_start", async () => {
		const env = deps.env ?? process.env;
		if (env[QUERY_PIPELINE_ENV] === "0") return;
		const key = env[JEV_API_KEY_ENV];
		if (key === undefined || key.trim() === "") return;
		if (warmed) return;
		warmed = true;
		try {
			const warm =
				deps.warm ??
				(() =>
					warmJevScore({
						fetchFn: deps.fetchFn ?? defaultJevFetch,
						scheduler: deps.scheduler ?? REAL_SCHEDULER,
						now: deps.now ?? Date.now,
						env,
					}));
			await warm().catch(() => {
				// fail-open by contract: the preload never blocks or fails a session
			});
		} catch {
			// a throwing seam is still fail-open
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		warmed = false;
		clearSurface(ctx);
	});
}
