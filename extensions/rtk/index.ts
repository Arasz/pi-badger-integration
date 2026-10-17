/**
 * rtk for pi: rewrites bash tool calls to their token-saving `rtk` equivalents, passes large
 * tool results through `rtk hook claude`, shows savings in the footer, and routes the stock
 * anthropic provider through a running rtk-proxy. Routing adds rtk's directives and about 320
 * uncached input tokens per request; set RTK_PI_PROXY=0 to keep pi direct.
 *
 * Adapted from rtk's stock pi extension (github.com/rtk-ai/rtk hooks/pi/rtk.ts at e542dca0,
 * Apache-2.0). Rewrite rules live in the `rtk rewrite` binary; this file only applies its
 * verdict. Needs rtk >= 0.23.0 on PATH; set RTK_DISABLED=1 to switch rewriting off.
 */

import type { ExtensionAPI, ToolCallEvent, BashToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { runHook, timeoutFor } from "./rtk-hook-runner.ts";
import { fromHookOutput, toHookPayload } from "./rtk-posthook.ts";
import { formatStatus, parseGain, parseProxyStatus, shouldRefresh, type ProxyState } from "./rtk-status.ts";
import { isRouted, proxyBind, proxyDbPath, proxyHeaders, proxyUrl, readProxyUsage } from "./rtk-proxy.ts";
import { decideRewrite, isRewriteCandidate, REWRITE_TIMEOUT_MS, versionProblem } from "./rtk-core.ts";

type StatusContext = {
	cwd: string;
	model?: { provider?: string; baseUrl?: string };
	ui?: { setStatus?: (key: string, text: string) => void };
};
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

const ANTHROPIC_URL = "https://api.anthropic.com";

function isStockAnthropic(baseUrl: string | undefined): boolean {
	try {
		return baseUrl !== undefined && new URL(baseUrl).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

export type RtkDeps = {
	runHook: typeof runHook;
	env: Record<string, string | undefined>;
	now: () => number;
	readProxyUsage: typeof readProxyUsage;
	/** Resolved path of rtk-proxy.db. */
	proxyDb: string;
};

/** Builds the extension with injected I/O; the default export wires the real ones. */
export function createRtkExtension(deps: RtkDeps) {
	return (pi: ExtensionAPI) => setup(pi, deps);
}

export default function (pi: ExtensionAPI) {
	const env = process.env;
	setup(pi, { runHook, env, now: Date.now, readProxyUsage, proxyDb: proxyDbPath(env, homedir(), process.platform) });
}

function setup(pi: ExtensionAPI, deps: RtkDeps) {
	// Probe in the background so a slow binary never delays pi's startup; handlers await it.
	const unavailable = probe(pi);
	// Results sent to `rtk hook claude` this session, and how many it shortened.
	const post = { sent: 0, compressed: 0 };
	let disabledShown = false;
	let lastRefresh: number | undefined;
	// Bumped by each refresh and by shutdown; a refresh that is no longer the latest drops its result.
	let generation = 0;
	// The stock anthropic baseUrl this instance replaced with the proxy URL; set only while routed.
	let stockBaseUrl: string | undefined;
	const routingAllowed = () => deps.env.RTK_PI_PROXY !== "0" && deps.env.RTK_DISABLED !== "1";

	void unavailable.then((problem) => {
		if (problem) console.warn(`[rtk] ${problem} — extension disabled`);
	});

	const setStatus = (ctx: StatusContext, text: string) => {
		try {
			ctx.ui?.setStatus?.("rtk", text);
		} catch {
			// Status is cosmetic; never let it break the fail-open path.
		}
	};

	/** Recomputes the footer; a disabled rtk shows only its reason, once. Never rejects. */
	const refreshStatus = async (ctx: StatusContext) => {
		try {
			const mine = ++generation;
			lastRefresh = deps.now();
			const problem = await unavailable;
			if (problem) {
				if (!disabledShown) setStatus(ctx, `[rtk disabled · ${problem}]`);
				disabledShown = true;
				return;
			}
			const [gain, status] = await Promise.all([
				pi.exec("rtk", ["gain", "-p", "-f", "json"], { cwd: ctx.cwd, timeout: REWRITE_TIMEOUT_MS }).catch(() => undefined),
				pi.exec("rtk", ["llm-proxy", "status"], { timeout: REWRITE_TIMEOUT_MS }).catch(() => undefined),
			]);
			let usage: { pct: number | undefined } | undefined;
			try {
				usage = deps.readProxyUsage(deps.proxyDb, ctx.cwd);
			} catch {
				usage = undefined;
			}
			if (mine !== generation) return;
			const up = status !== undefined && parseProxyStatus(status.stdout, status.code) === "up";
			syncRouting(ctx, up);
			const routed = isRouted(ctx.model?.baseUrl, proxyBind(deps.env));
			const proxy: ProxyState = routed ? (up ? "routed" : "routed-down") : up ? "up" : "off";
			const cmdPct = gain ? parseGain(gain.stdout)?.pct : undefined;
			setStatus(ctx, formatStatus({ proxy, cmdPct, proxyPct: usage?.pct, post: { ...post } }));
		} catch (error) {
			console.warn("[rtk] status refresh failed", error);
		}
	};

	/** Re-registers only baseUrl, so another extension's anthropic settings survive (unregister would drop them). */
	const restore = (stock: string) => {
		stockBaseUrl = undefined;
		pi.registerProvider("anthropic", { baseUrl: stock });
	};

	/** Points stock anthropic at rtk-proxy while it is up; restores stock when it is down, also after an earlier instance. */
	const syncRouting = (ctx: StatusContext, up: boolean) => {
		try {
			const anthropic = ctx.model?.provider === "anthropic";
			if (!up && stockBaseUrl !== undefined) restore(stockBaseUrl);
			else if (!up && anthropic && routingAllowed() && isRouted(ctx.model?.baseUrl, proxyBind(deps.env))) restore(ANTHROPIC_URL);
			else if (up && stockBaseUrl === undefined && anthropic && routingAllowed() && isStockAnthropic(ctx.model?.baseUrl)) {
				const stock = ctx.model?.baseUrl as string;
				pi.registerProvider("anthropic", { baseUrl: proxyUrl(deps.env) });
				stockBaseUrl = stock;
			}
		} catch (error) {
			console.warn("[rtk] could not change the anthropic provider route", error);
		}
	};

	// pi keeps the model runtime across /reload and /new, so routing must not outlive this instance.
	pi.on("session_shutdown", () => {
		generation++;
		try {
			if (stockBaseUrl !== undefined) restore(stockBaseUrl);
		} catch (error) {
			console.warn("[rtk] could not restore the anthropic provider on shutdown", error);
		}
	});

	pi.on("before_provider_headers", (event, ctx) => {
		try {
			const c = ctx as StatusContext & ResultContext;
			if (!routingAllowed() || c.model?.provider !== "anthropic" || !isRouted(c.model.baseUrl, proxyBind(deps.env))) return;
			Object.assign(event.headers, proxyHeaders(c.cwd, c.sessionManager?.getSessionId?.()));
		} catch (error) {
			console.warn("[rtk] could not add proxy attribution headers", error);
		}
	});

	pi.on("session_start", (_event, ctx) => {
		void refreshStatus(ctx as StatusContext);
	});

	pi.on("model_select", (_event, ctx) => {
		void refreshStatus(ctx as StatusContext);
	});

	// Unthrottled so a proxy that died since the last turn is routed around before this request goes out.
	pi.on("before_agent_start", async (_event, ctx) => {
		await refreshStatus(ctx as StatusContext);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (shouldRefresh(deps.now(), lastRefresh)) void refreshStatus(ctx as StatusContext);
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
