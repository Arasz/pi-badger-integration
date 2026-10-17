/**
 * rtk for pi: rewrites bash tool calls to their token-saving `rtk` equivalents.
 *
 * Adapted from rtk's stock pi extension (github.com/rtk-ai/rtk hooks/pi/rtk.ts at e542dca0,
 * Apache-2.0). Rewrite rules live in the `rtk rewrite` binary; this file only applies its
 * verdict. Needs rtk >= 0.23.0 on PATH; set RTK_DISABLED=1 to switch rewriting off.
 */

import type { ExtensionAPI, ToolCallEvent, BashToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { runHook, timeoutFor } from "./rtk-hook-runner.ts";
import { fromHookOutput, toHookPayload } from "./rtk-posthook.ts";
import { decideRewrite, isRewriteCandidate, REWRITE_TIMEOUT_MS, versionProblem } from "./rtk-core.ts";

type StatusContext = { ui?: { setStatus?: (key: string, text: string) => void } };
type ResultContext = { cwd: string; signal?: AbortSignal; sessionManager?: { getSessionId?: () => string } };

// A local guard: the package's isToolCallEventType is a value export that loads the whole barrel.
function isBash(event: ToolCallEvent): event is BashToolCallEvent {
	return event.toolName === "bash";
}

async function probe(pi: ExtensionAPI): Promise<string | undefined> {
	try {
		const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS });
		if (ver.code !== 0) return "rtk binary not found in PATH";
		return versionProblem(ver.stdout);
	} catch {
		return "rtk binary not found in PATH";
	}
}

export type RtkDeps = { runHook: typeof runHook; env: Record<string, string | undefined> };

/** Builds the extension with injected I/O; the default export wires the real ones. */
export function createRtkExtension(deps: RtkDeps) {
	return (pi: ExtensionAPI) => setup(pi, deps);
}

export default function (pi: ExtensionAPI) {
	setup(pi, { runHook, env: process.env });
}

function setup(pi: ExtensionAPI, deps: RtkDeps) {
	// Probe in the background so a slow binary never delays pi's startup; handlers await it.
	const unavailable = probe(pi);
	let sessionContext: StatusContext | undefined;
	let reason: string | undefined;
	// Results sent to `rtk hook claude` this session, and how many it shortened.
	const post = { sent: 0, compressed: 0 };

	const showStatus = () => {
		if (!reason || !sessionContext) return;
		try {
			sessionContext.ui?.setStatus?.("rtk", `RTK disabled: ${reason}`);
		} catch {
			// Status is cosmetic; never let it break the fail-open path.
		}
	};

	void unavailable.then((problem) => {
		if (!problem) return;
		reason = problem;
		console.warn(`[rtk] ${problem} — extension disabled`);
		showStatus();
	});

	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx as StatusContext;
		showStatus();
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isBash(event)) return;
			const command = event.input.command;
			if (!isRewriteCandidate(command, deps.env)) return;
			if (await unavailable) return;

			const result = await pi.exec("rtk", ["rewrite", command], { timeout: REWRITE_TIMEOUT_MS, signal: ctx.signal });
			const decision = decideRewrite(command, result);
			if (decision.kind === "rewrite") event.input.command = decision.command;
			if (decision.kind === "block") return { block: true, reason: decision.reason };
		} catch (error) {
			// pi blocks the tool when a tool_call handler throws; rtk must never do that.
			console.warn("[rtk] rewrite failed; passing the command through", error);
		}
		return undefined;
	});
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (await unavailable) return undefined;
			const c = ctx as ResultContext;
			const request = toHookPayload(event as ToolResultEvent, c.cwd, deps.env);
			if (!request) return undefined;
			const payload = { ...request.payload, session_id: c.sessionManager?.getSessionId?.() ?? "" };
			post.sent++;
			const r = await deps.runHook(payload, { cwd: c.cwd, timeoutMs: timeoutFor(request.bodyChars), signal: c.signal });
			const patch = fromHookOutput(r.stdout, r.code, r.killed, event as ToolResultEvent, request.trailer);
			if (patch) post.compressed++;
			return patch;
		} catch (error) {
			console.warn("[rtk] after-tool pipeline failed; keeping the original result", error);
			return undefined;
		}
	});
}
