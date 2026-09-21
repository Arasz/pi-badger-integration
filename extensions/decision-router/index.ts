/**
 * Decision-router wiring: one async `before_agent_start` hook plus `/decisions`.
 *
 * The hook fans one Jev classify call out per enabled DISTINCT turn (tools,
 * tier and shadow-routing questions in a single body), then applies the policy
 * verdicts in tools→model→routing-log order with each step independently
 * fail-open. Every no-op path leaves the tool set and the model untouched, the
 * handler always resolves void, and the key, headers, bodies and prompt text
 * never reach any log surface (the ring stores prompt hashes only).
 *
 * All seams are injected (fetch, scheduler, clock, env, tool/model getters and
 * setters); the pi-bound fallbacks keep the factory usable live. Env is read
 * per call from the live record, never copied.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildRoutingRequest,
	buildTierChoiceRequest,
	buildToolChoiceRequest,
	CACHE_MAX_ENTRIES,
	createFallbackClassifier,
	createJevClassifier,
	JEV_API_KEY_ENV,
	JEV_MODEL_DEFAULT,
	JEV_MODEL_ENV,
	PROMPT_CHAR_CAP,
	type JevFetchFn,
	type JevQuestion,
	type JevScheduler,
} from "./decision-router-client.ts";
import {
	DECISION_ROUTER_ENV,
	decidePolicies,
	decideRouting,
	decideTier,
	decideTools,
	evaluateTurn,
	isCapabilityEnabled,
	keyOf,
	type CapabilityEnablement,
	type RoutingRecord,
	type TierThinking,
} from "./decision-router-core.ts";
import { ROUTER_FALLBACK_CHANNEL } from "../router-fallback/index.ts";

/** The human command: `/decisions [status|off|on|check|shadow|reset]`. */
export const DECISIONS_COMMAND = "decisions";

/** Usage line answered to unknown `/decisions` subcommands. */
export const DECISIONS_USAGE = "usage: /decisions [status|off|on|check|shadow|reset]";

/** The `/decisions` subcommands offered by argument completion. */
export const DECISIONS_SUBCOMMANDS = ["status", "off", "on", "check", "shadow", "reset"] as const;

/** Tier target overrides, read per call (fall back to the injected tierModels, then the current model). */
export const TIER_LOW_MODEL_ENV = "PI_BADGER_JEV_TIER_LOW_MODEL";
export const TIER_MEDIUM_MODEL_ENV = "PI_BADGER_JEV_TIER_MEDIUM_MODEL";
export const TIER_HIGH_MODEL_ENV = "PI_BADGER_JEV_TIER_HIGH_MODEL";

/** Minimal model reference traded with the injected model seams. */
export interface DecisionRouterModelRef {
	readonly provider: string;
	readonly id: string;
}

/** Minimal tool view traded with the injected tool seams. */
export interface DecisionRouterToolInfo {
	readonly name: string;
	readonly description?: string;
}

/** Minimal skill view read off the turn's system-prompt options. */
export interface DecisionRouterSkillInfo {
	readonly name: string;
	readonly description?: string;
	readonly disableModelInvocation?: boolean;
}

/** Injectable seams: classifier I/O plus the pi tool/model surfaces tests stub. */
export interface DecisionRouterDeps {
	/** Defaults to global fetch. */
	fetchFn?: JevFetchFn;
	/** Defaults to the globals. */
	scheduler?: JevScheduler;
	/** Injected clock for cooldown timestamps. Defaults to Date.now. */
	now?: () => number;
	/** Env record, read PER CALL. Defaults to process.env (live, never copied). */
	env?: Record<string, string | undefined>;
	/** Defaults to the bound pi function, else an empty catalogue. */
	getAllToolsFn?: () => DecisionRouterToolInfo[];
	/** Defaults to the bound pi function, else an empty set. */
	getActiveToolsFn?: () => string[];
	/** Defaults to the bound pi function, else a no-op. */
	setActiveToolsFn?: (toolNames: string[]) => void;
	/** Single positional full registry model. Defaults to the bound pi setModel, else a declined false. */
	setModelFn?: (model: Record<string, unknown>) => Promise<boolean>;
	/** Defaults to the bound pi function, else a no-op. */
	setThinkingLevelFn?: (level: TierThinking) => void;
	/** No pi-level getter exists — falls back to ctx.getModel per call. */
	getModelFn?: () => DecisionRouterModelRef | undefined;
	/** Tier targets when the env carries no override. Defaults to the current model (all-hold). */
	tierModels?: { readonly low: string; readonly medium: string; readonly high: string };
	/** Marker-prefix predicate (provisional, F18). Defaults to never-marker. */
	isMarkerPrefixed?: (prompt: string) => boolean;
}

/** Shadow-ring cap: the newest records survive. */
const RING_MAX_RECORDS = 20;

/** Stored lastError cap (F15): the line never carries more than this. */
const LAST_ERROR_CAP_CHARS = 120;

function hashOf(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function capError(text: string): string {
	return text.length <= LAST_ERROR_CAP_CHARS ? text : text.slice(0, LAST_ERROR_CAP_CHARS);
}

function modelIdOf(model: unknown): string {
	if (typeof model === "string") return model;
	const ref = model as { provider?: unknown; id?: unknown } | null | undefined;
	if (ref && typeof ref.provider === "string" && typeof ref.id === "string") {
		return `${ref.provider}/${ref.id}`;
	}
	return "unknown";
}

/** Parse a configured `provider/model-id` target; empty/whitespace/dishonest shapes are unusable. */
function parseTargetId(targetId: string): { provider: string; id: string } | undefined {
	const trimmed = targetId.trim();
	if (trimmed === "") return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const id = trimmed.slice(slash + 1).trim();
	if (provider === "" || id === "") return undefined;
	return { provider, id };
}

/** Minimal registry view read off `ctx.modelRegistry` (mirrors router-fallback's RegistrySource). */
interface ModelRegistrySource {
	find?: (provider: string, modelId: string) => Record<string, unknown> | undefined;
}

/**
 * Full catalog model for a target, resolved fresh per apply (M1): pi stores the
 * `setModel` argument verbatim as `session.model` with no registry re-lookup,
 * so passing a bare `{provider,id}` stub breaks the next provider request
 * (`No API provider registered for api: undefined`). A miss or an unreadable
 * registry is not actuable.
 */
function findFullModel(
	ctx: ExtensionContext,
	provider: string,
	id: string,
): Record<string, unknown> | undefined {
	try {
		const registry = (ctx as unknown as { modelRegistry?: ModelRegistrySource }).modelRegistry;
		return registry?.find?.(provider, id) ?? undefined;
	} catch {
		return undefined;
	}
}

function hasApiKey(env: Record<string, string | undefined>): boolean {
	const key = env[JEV_API_KEY_ENV];
	return key !== undefined && key.trim() !== "";
}

export default function (pi: ExtensionAPI, deps: DecisionRouterDeps = {}) {
	if (typeof pi?.registerCommand !== "function") {
		console.error(
			"ai-badger: pi.registerCommand is not a function — this pi build's extension API has moved; the decision router is not installed.",
		);
		return;
	}

	const scheduler: JevScheduler = deps.scheduler ?? {
		setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const now = deps.now ?? Date.now;
	const env = deps.env ?? process.env;
	const isMarkerPrefixed = deps.isMarkerPrefixed ?? (() => false);

	type PiWithTools = {
		getAllTools?: () => Array<{ name: string; description?: string }>;
		getActiveTools?: () => string[];
		setActiveTools?: (toolNames: string[]) => void;
		setModel?: (model: unknown) => Promise<boolean>;
		setThinkingLevel?: (level: TierThinking) => void;
	};
	const toolsApi = pi as unknown as PiWithTools;
	const getAllTools = deps.getAllToolsFn ?? (() => toolsApi.getAllTools?.() ?? []);
	const getActiveTools = deps.getActiveToolsFn ?? (() => toolsApi.getActiveTools?.() ?? []);
	const setActiveTools =
		deps.setActiveToolsFn ?? ((names) => void toolsApi.setActiveTools?.(names));
	const setModel: (model: Record<string, unknown>) => Promise<boolean> =
		deps.setModelFn ?? ((model) => toolsApi.setModel?.(model) ?? Promise.resolve(false));
	const setThinkingLevel =
		deps.setThinkingLevelFn ?? ((level) => void toolsApi.setThinkingLevel?.(level));
	const fetchFn: JevFetchFn =
		deps.fetchFn ??
		((url, init) => (globalThis.fetch as typeof fetch)(url, init as RequestInit) as never);

	// ---- session state (all of it resets on reset/shutdown)
	const cachedTurns = new Map<string, number>();
	let cacheHits = 0;
	let cooldownUntilMs = 0;
	let cooldownKind: string | undefined;
	let inFlight = false;
	let sessionDecisionsOn = true;
	let upgradesLatched = false;
	let failedSinceLatch = false;
	let lastAppliedTarget: string | undefined;
	let pendingTarget: string | undefined;
	let lastTurn = "none yet";
	let lastDecision: { tools: string; model: string; routing: string } | undefined;
	let lastError: string | undefined;
	let lastFallback: string | undefined;
	let lastPrompt: string | undefined;
	let totalCost = 0;
	const ring: RoutingRecord[] = [];

	const clearCache = (): void => {
		cachedTurns.clear();
		cacheHits = 0;
	};

	const resetSession = (withOverride: boolean): void => {
		clearCache();
		cooldownUntilMs = 0;
		cooldownKind = undefined;
		inFlight = false;
		upgradesLatched = false;
		failedSinceLatch = false;
		lastAppliedTarget = undefined;
		pendingTarget = undefined;
		lastTurn = "none yet";
		lastDecision = undefined;
		lastError = undefined;
		lastFallback = undefined;
		ring.length = 0;
		if (withOverride) {
			sessionDecisionsOn = true;
			totalCost = 0;
			lastPrompt = undefined;
		}
	};

	const readCatalogue = (): Array<{ name: string; description: string }> => {
		let list: DecisionRouterToolInfo[];
		try {
			list = getAllTools();
		} catch {
			return [];
		}
		return list
			.filter((tool) => typeof tool?.name === "string")
			.map((tool) => ({ name: tool.name, description: tool.description ?? "" }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	};

	/**
	 * Active tool names, or undefined when the read threw. The caller holds the
	 * tool step on undefined: the additive write unions with this set, so
	 * treating a read fault as `[]` would remove the real active tools (S2).
	 */
	const readActive = (): string[] | undefined => {
		try {
			return getActiveTools().filter((name) => typeof name === "string");
		} catch {
			return undefined;
		}
	};

	const readModelRef = (ctx: ExtensionContext): DecisionRouterModelRef | undefined => {
		try {
			const fromDeps = deps.getModelFn?.();
			if (fromDeps !== undefined) return fromDeps;
			const getModel = (ctx as unknown as { getModel?: () => unknown }).getModel;
			if (typeof getModel !== "function") return undefined;
			const model = getModel.call(ctx) as { provider?: unknown; id?: unknown } | undefined;
			if (model && typeof model.provider === "string" && typeof model.id === "string") {
				return { provider: model.provider, id: model.id };
			}
			return undefined;
		} catch {
			return undefined;
		}
	};

	const readSkills = (event: unknown): Array<{ name: string; description: string }> => {
		const skills = (event as { systemPromptOptions?: { skills?: DecisionRouterSkillInfo[] } })
			.systemPromptOptions?.skills;
		if (!Array.isArray(skills)) return [];
		return skills
			.filter((skill) => typeof skill?.name === "string" && skill.disableModelInvocation !== true)
			.map((skill) => ({ name: skill.name, description: skill.description ?? "" }));
	};

	const pushRing = (record: RoutingRecord): void => {
		ring.push(record);
		while (ring.length > RING_MAX_RECORDS) ring.shift();
	};

	/** One decide-and-apply pass. Never throws; bypass skips cooldown+cache only. */
	const runTurn = async (
		prompt: string,
		skills: Array<{ name: string; description: string }>,
		ctx: ExtensionContext,
		opts: { bypass?: boolean },
	): Promise<void> => {
		const nowMs = now();
		const promptHash = hashOf(prompt);
		const catalogue = readCatalogue();
		const catalogueNames = catalogue.map((tool) => tool.name);
		const catalogueHash = hashOf(JSON.stringify(catalogue.map((tool) => [tool.name, tool.description])));
		const activeTools = readActive();
		const currentRef = readModelRef(ctx);
		const currentId = modelIdOf(currentRef);
		const tierModels = {
			low: env[TIER_LOW_MODEL_ENV] ?? deps.tierModels?.low ?? currentId,
			medium: env[TIER_MEDIUM_MODEL_ENV] ?? deps.tierModels?.medium ?? currentId,
			high: env[TIER_HIGH_MODEL_ENV] ?? deps.tierModels?.high ?? currentId,
		};
		const decision = evaluateTurn({
			prompt,
			promptHash,
			catalogueHash,
			modelId: currentId,
			env,
			sessionDecisionsOn,
			cooldownUntilMs: opts.bypass === true ? 0 : cooldownUntilMs,
			nowMs,
			inFlight,
			cacheKeys: opts.bypass === true ? new Set<string>() : new Set(cachedTurns.keys()),
			isMarkerPrefixed,
		});
		if (decision.status === "skip") {
			const shown =
				decision.reason === "cooldown" && cooldownKind !== undefined ? cooldownKind : decision.reason;
			lastTurn = `skip (${shown})`;
			if (decision.reason === "cache-hit") {
				cacheHits += 1;
				const cacheKey = keyOf({ promptHash, catalogueHash, modelId: currentId });
				const stored = cachedTurns.get(cacheKey);
				if (stored !== undefined) {
					cachedTurns.delete(cacheKey);
					cachedTurns.set(cacheKey, stored);
				}
			}
			return;
		}
		const enabled: CapabilityEnablement = decision.enabled;

		// Fan-out: exactly the enabled questions in one body (D25 narrows, never pads).
		const jevModel = env[JEV_MODEL_ENV] ?? JEV_MODEL_DEFAULT;
		let toolsHold: string | undefined;
		let toolsState: ReadonlyArray<{ name: string; description: string }> | undefined;
		let toolsQuestion: JevQuestion | undefined;
		if (enabled.tools) {
			if (activeTools === undefined) {
				toolsHold = "active-read-failed";
			} else {
				const built = buildToolChoiceRequest({ task: prompt, tools: catalogue, model: jevModel });
				if (built.status === "ok") {
					toolsQuestion = built.request.questions["tools"];
					toolsState = built.request.state.tools;
				} else {
					toolsHold = built.reason;
				}
			}
		}
		const questions: Record<string, JevQuestion> = {};
		if (toolsQuestion !== undefined) questions["tools"] = toolsQuestion;
		if (enabled.model) {
			const tierQuestion = buildTierChoiceRequest({ task: prompt, model: jevModel }).questions["tier"];
			if (tierQuestion !== undefined) questions["tier"] = tierQuestion;
		}
		let routingQuestions: Record<string, JevQuestion> = {};
		if (enabled.routing) {
			routingQuestions = buildRoutingRequest({ task: prompt, skills, model: jevModel }).questions;
			for (const [name, question] of Object.entries(routingQuestions)) questions[name] = question;
		}
		if (Object.keys(questions).length === 0) {
			// Only tools enabled but the catalogue cannot be asked (e.g. empty): hold, no priced work.
			lastDecision = {
				tools: `hold (${toolsHold ?? "capability-killed"})`,
				model: "hold (capability-killed)",
				routing: "record none (capability-killed)",
			};
			lastTurn = "decided";
			failedSinceLatch = false;
			return;
		}

		const classifier = createJevClassifier({ fetchFn, scheduler, now, env });
		inFlight = true;
		try {
			const outcome = await classifier.classify({
				model: jevModel,
				state: {
					task: prompt.slice(0, PROMPT_CHAR_CAP),
					...(toolsState !== undefined ? { tools: [...toolsState] } : {}),
				},
				questions,
			});
			if (outcome.status === "error") {
				if (outcome.kind === "rate-limited" && outcome.retryAfterMs !== undefined) {
					cooldownUntilMs = now() + outcome.retryAfterMs;
					cooldownKind = "rate-limited";
				}
				lastError = capError(`${outcome.kind} — ${outcome.detail}`);
				// Observe-only fallback (D8/D10): classify for the record, never actuate.
				const fallback = createFallbackClassifier().classify(prompt, catalogueNames);
				const toolsBit =
					fallback.tools.status === "ok" ? fallback.tools.names.join(",") : fallback.tools.reason;
				lastFallback = `tools=${toolsBit} tier=hold route=none`;
				pushRing({ question: "skill", choice: "none", confidence: 0, promptHash });
				lastDecision = {
					tools: `hold (${outcome.kind})`,
					model: `hold (${outcome.kind})`,
					routing: "record none (fallback)",
				};
				lastTurn = `error (${outcome.kind})`;
				failedSinceLatch = true;
				return;
			}

			const answers = outcome.response.answers;
			const toolsAnswer = enabled.tools && toolsHold === undefined ? answers["tools"] : undefined;
			const tierAnswer = enabled.model ? answers["tier"] : undefined;
			const skillAnswer = enabled.routing ? answers["skill"] : undefined;
			const policies = decidePolicies({
				enabled,
				toolsAnswer,
				tierAnswer,
				skillAnswer,
				catalogue: catalogueNames,
				activeTools: activeTools ?? [],
				currentModel: currentId,
				tierModels,
				upgradesLatched,
				promptHash,
			});

			// Apply tools→model→routing-log, each step independently fail-open.
			let toolsSummary: string;
			const toolsAction = toolsHold !== undefined ? null : policies.tools;
			if (toolsAction === null) {
				toolsSummary = `hold (${toolsHold})`;
			} else if (toolsAction.status === "actuate") {
				try {
					// activeTools is defined here: an undefined read set toolsHold, which nulls toolsAction.
					setActiveTools([...new Set([...(activeTools ?? []), ...toolsAction.enable])].sort());
					toolsSummary = `actuate [${toolsAction.enable.join(", ")}]`;
				} catch {
					toolsSummary = "hold (apply-failed)";
				}
			} else {
				toolsSummary = `hold (${toolsAction.reason})`;
			}

			let modelSummary: string;
			const tierAction = policies.tier;
			if (tierAction.status === "actuate") {
				try {
					const parsed = parseTargetId(tierAction.targetModel);
					const full = parsed === undefined ? undefined : findFullModel(ctx, parsed.provider, parsed.id);
					if (parsed === undefined) {
						modelSummary = "hold (tier-target-unset)";
					} else if (full === undefined) {
						modelSummary = "hold (target-not-in-registry)";
					} else {
						// provider/id forced from the configured target; the registry
						// supplies api/baseUrl/reasoning/… for the full model object.
						const target = { ...full, provider: parsed.provider, id: parsed.id };
						// N2: pi emits model_select before setModel resolves; the pending id
						// keeps that own switch from being treated as foreign and clearing
						// the cache mid-turn.
						pendingTarget = tierAction.targetModel;
						let ok = false;
						try {
							ok = await setModel(target);
						} finally {
							pendingTarget = undefined;
						}
						if (ok) {
							lastAppliedTarget = tierAction.targetModel;
							try {
								setThinkingLevel(tierAction.thinking);
							} catch {
								// Thinking is advisory next to the landed model — notice-only.
							}
							modelSummary = `${tierAction.direction} → ${tierAction.targetModel} (thinking ${tierAction.thinking})`;
						} else {
							modelSummary = "hold (set-model-declined)";
						}
					}
				} catch {
					modelSummary = "hold (apply-failed)";
				}
			} else {
				modelSummary = `hold (${tierAction.reason})`;
			}

			pushRing(policies.routing.record);
			const routingSummary = `skill=${policies.routing.record.choice} conf=${policies.routing.record.confidence}`;

			lastDecision = { tools: toolsSummary, model: modelSummary, routing: routingSummary };
			lastTurn = "decided";
			lastFallback = undefined;
			failedSinceLatch = false;
			if (typeof outcome.response.usage.cost === "number") totalCost += outcome.response.usage.cost;
			cachedTurns.set(decision.key, now());
			while (cachedTurns.size > CACHE_MAX_ENTRIES) {
				const oldest = cachedTurns.keys().next();
				if (oldest.done === true) break;
				cachedTurns.delete(oldest.value);
			}
		} finally {
			inFlight = false;
		}
	};

	// ---------------------------------------------------------------- handler

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const prompt = (event as { prompt?: unknown }).prompt;
			if (typeof prompt !== "string") return undefined;
			lastPrompt = prompt;
			await runTurn(prompt, readSkills(event), ctx, {});
		} catch (error) {
			lastError = capError(
				`internal — ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return undefined;
	});

	pi.on("model_select", (event) => {
		try {
			const select = event as { model?: unknown };
			const id = modelIdOf(select.model);
			if (id !== lastAppliedTarget && id !== pendingTarget) clearCache();
		} catch {
			// Invalidation is advisory — a bad event never breaks the turn.
		}
		return undefined;
	});

	pi.on("agent_settled", () => {
		// The latch clears on a settled successful turn: any Jev error since the
		// latch keeps it armed, otherwise the episode proved the session healthy.
		if (!failedSinceLatch) upgradesLatched = false;
		failedSinceLatch = false;
		return undefined;
	});

	pi.events.on(ROUTER_FALLBACK_CHANNEL, (notice) => {
		try {
			// Only switches are emitted on this channel (holds/exhausted stay
			// notice-only in router-fallback) — any notice object is a switch.
			if (notice !== null && typeof notice === "object") {
				clearCache();
				upgradesLatched = true;
			}
		} catch {
			// Bus noise never breaks the turn.
		}
	});

	pi.on("session_shutdown", () => {
		resetSession(true);
		return undefined;
	});

	// ---------------------------------------------------------------- command

	const statusText = (): string => {
		const yesNo = (value: boolean): string => (value ? "yes" : "no");
		const lines = [
			"decisions status",
			`config: tools=${yesNo(isCapabilityEnabled(env, sessionDecisionsOn, "tools"))} model=${yesNo(isCapabilityEnabled(env, sessionDecisionsOn, "model"))} routing=${yesNo(isCapabilityEnabled(env, sessionDecisionsOn, "routing"))} (session ${sessionDecisionsOn ? "on" : "off"})`,
			`key: ${hasApiKey(env) ? "present" : "missing"}`,
			`last turn: ${lastTurn}`,
			`last tools: ${lastDecision?.tools ?? "none yet"}`,
			`last model: ${lastDecision?.model ?? "none yet"}`,
			`last routing: ${lastDecision?.routing ?? "none yet"}`,
		];
		if (lastFallback !== undefined) lines.push(`fallback: ${lastFallback}`);
		lines.push(`lastError: ${lastError ?? "none"}`);
		if (cooldownUntilMs > now()) {
			const remaining = Math.ceil((cooldownUntilMs - now()) / 1000);
			lines.push(`cooldown: armed (${cooldownKind ?? "cooldown"}, ${remaining}s remaining)`);
		} else {
			lines.push("cooldown: none");
		}
		lines.push(`latch: ${upgradesLatched ? "upgrades held" : "none"}`);
		lines.push(`cache: ${cachedTurns.size} entries, ${cacheHits} hits`);
		lines.push(`cost: $${totalCost.toFixed(6)}`);
		lines.push(`ring: ${ring.length} records`);
		return lines.join("\n");
	};

	pi.registerCommand(DECISIONS_COMMAND, {
		description:
			"Decision-router status and controls: status (default), off/on (session override), check (decide now, bypassing cooldown+cache), shadow (recent routing records), reset (clear session state).",
		getArgumentCompletions(argumentPrefix) {
			const first = argumentPrefix.trim();
			const items = DECISIONS_SUBCOMMANDS.filter((verb) => verb.startsWith(first)).map((verb) => ({
				value: verb,
				label: verb,
				description: `decisions ${verb}`,
			}));
			return items.length > 0 ? items : null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const notify = (message: string, type: "info" | "warning" | "error"): void => {
				ctx.ui.notify(message, type);
			};
			try {
				const trimmed = args.trim();
				const space = trimmed.indexOf(" ");
				const verb = space < 0 ? trimmed : trimmed.slice(0, space);
				const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
				if (verb === "" || verb === "status") {
					notify(statusText(), "info");
					return;
				}
				if (verb === "off") {
					sessionDecisionsOn = false;
					notify("decisions: off for this session (env kill-switches still apply).", "warning");
					return;
				}
				if (verb === "on") {
					sessionDecisionsOn = true;
					notify("decisions: on for this session (env kill-switches still apply).", "info");
					return;
				}
				if (verb === "check") {
					const prompt = rest !== "" ? rest : (lastPrompt ?? "");
					if (prompt === "") {
						notify("decisions check: no prompt yet — pass a prompt or run a turn first.", "info");
						return;
					}
					let skills: Array<{ name: string; description: string }> = [];
					try {
						const options = ctx.getSystemPromptOptions?.();
						if (Array.isArray(options?.skills)) {
							skills = options.skills
								.filter(
									(skill) => typeof skill?.name === "string" && skill.disableModelInvocation !== true,
								)
								.map((skill) => ({ name: skill.name, description: skill.description ?? "" }));
						}
					} catch {
						skills = [];
					}
					// check bypasses cooldown+cache but not kill/key/session/prompt gates.
					await runTurn(prompt, skills, ctx, { bypass: true });
					notify(`decisions check: ${lastTurn}`, "info");
					return;
				}
				if (verb === "shadow") {
					if (ring.length === 0) {
						notify("decisions shadow: no records", "info");
						return;
					}
					notify(
						ring
							.map(
								(record, index) =>
									`shadow ${index + 1}: skill=${record.choice} conf=${record.confidence} hash=${record.promptHash}`,
							)
							.join("\n"),
						"info",
					);
					return;
				}
				if (verb === "reset") {
					resetSession(false);
					notify("decisions: reset — cache, cooldown, errors, latch and ring cleared.", "info");
					return;
				}
				notify(DECISIONS_USAGE, "info");
			} catch (error) {
				notify(
					`decisions: internal error (${error instanceof Error ? error.message : String(error)})`,
					"error",
				);
			}
		},
	});
}

// Re-exported so tests and the probe share the exact env surface (F15 posture:
// the key value itself is never importable from here — presence only).
export { DECISION_ROUTER_ENV, decidePolicies, decideRouting, decideTier, decideTools };
