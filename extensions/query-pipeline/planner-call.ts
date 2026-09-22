/**
 * Pi adapter half of the planner (plan §3): `createRegistryPlanner` resolves a
 * model through the pi 0.84.4 `ModelRegistry` seam and calls `complete`, then
 * hands the extracted text to the pure `parsePlan` half in `planner.ts`.
 *
 * Purity rules: no `@earendil-works/pi-ai` import — the registry, the model and
 * the assistant message are narrowed structurally, so text extraction is
 * inlined and there is no version-skew surface. No clock and no ambient env:
 * the injected env record is read per call. Never throws: every failure
 * resolves a typed `PlannerResult`.
 */

import { DELEGATOR_PERSONA, PLANNER_ADDENDUM, buildPlannerUserPrompt, parsePlan } from "./planner.ts";
import { QUERY_PIPELINE_PLANNER_MODEL_ENV } from "./types.ts";
import type { PlannerResult, PipelinePlannerFn } from "./types.ts";

// ------------------------------------------------------------------ structural views (no pi-ai import)

interface RegistryLike {
	find?: (provider: string, modelId: string) => unknown;
	complete?: (model: unknown, context: PlannerContext, options: { signal?: AbortSignal }) => unknown;
}

interface PlannerContext {
	systemPrompt: string;
	messages: Array<{ role: "user"; content: string }>;
}

interface AssistantMessageLike {
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

export interface CreateRegistryPlannerOptions {
	/** `ctx.modelRegistry`; narrowed structurally, never imported from pi. */
	registry: unknown;
	/** `ctx.model` — the fallback model when the env ref is unset. */
	model: unknown;
	/** Default `process.env` at the call site (PKG-4); this file never reads ambient env. */
	env?: Record<string, string | undefined>;
	/** Reserved for seam parity with the other factories; unused (no clock reads here). */
	now?: () => number;
}

// ------------------------------------------------------------------ inline text extraction

/** Join every `type === "text"` part; ignore thinking, tool calls and malformed parts. */
function extractText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as AssistantMessageLike).content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") text += record.text;
	}
	return text;
}

/** A function boundary keeps TS from narrowing `aborted` to `false` across the await. */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

// ------------------------------------------------------------------ factory

/**
 * `PipelinePlannerFn` over `registry.complete`. Resolution order: the
 * `PI_BADGER_QUERY_PIPELINE_PLANNER_MODEL` ref (`provider/model`, split on the
 * first `/`; a ref with no slash is `no-model`) via `registry.find`, else the
 * injected `model`. Every failure resolves a typed fallback — never throws.
 */
export function createRegistryPlanner(options: CreateRegistryPlannerOptions): PipelinePlannerFn {
	const registry = options.registry as RegistryLike | null | undefined;
	const fallbackModel = options.model;
	const env = options.env ?? {};

	return async (query, signal): Promise<PlannerResult> => {
		try {
			// A signal already aborted before dispatch is a timeout, not a transport error.
			if (isAborted(signal)) return { status: "fallback", reason: "timeout" };

			const find = registry?.find;
			const complete = registry?.complete;
			if (typeof find !== "function" || typeof complete !== "function") {
				return { status: "fallback", reason: "no-model" };
			}

			let resolved = fallbackModel;
			const modelRef = env[QUERY_PIPELINE_PLANNER_MODEL_ENV];
			if (modelRef !== undefined) {
				const slash = modelRef.indexOf("/");
				if (slash < 0) return { status: "fallback", reason: "no-model" };
				resolved = find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
			}
			if (resolved === null || resolved === undefined) return { status: "fallback", reason: "no-model" };

			const context: PlannerContext = {
				systemPrompt: `${DELEGATOR_PERSONA}\n\n${PLANNER_ADDENDUM}`,
				messages: [{ role: "user", content: buildPlannerUserPrompt(query) }],
			};
			const message = await complete(resolved, context, { signal });

			if (isAborted(signal)) return { status: "fallback", reason: "timeout" };
			const messageRecord = typeof message === "object" && message !== null ? (message as AssistantMessageLike) : null;
			if (messageRecord?.stopReason === "aborted") return { status: "fallback", reason: "timeout" };
			if (messageRecord?.stopReason === "error") return { status: "fallback", reason: "transport" };

			const parsed = parsePlan(extractText(message));
			if (parsed.status === "ok") return { status: "ok", plan: parsed.plan };
			return { status: "fallback", reason: parsed.reason };
		} catch {
			// Sync auth throw, rejected promise, malformed registry — all transport,
			// unless the abort signal is the reason the promise rejected.
			return { status: "fallback", reason: isAborted(signal) ? "timeout" : "transport" };
		}
	};
}
