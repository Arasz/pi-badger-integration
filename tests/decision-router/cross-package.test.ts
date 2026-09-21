/**
 * P4 cross-package gates for the decision-router extension (plan v2 R15/F19).
 *
 * Rows:
 * - X-import: client + core stay I/O-free — banned tokens absent; only the
 *   injected seam declarations may mention setTimeout.
 * - X-membership: publish.ts EXTENSION_DIRS owns decision-router.
 * - X-content: package.json shape (main/type/no-dependencies/metadata-only),
 *   extension README (headings + every env name), catalog section, repo README
 *   row, ADR required headings.
 * - X-fixture-flow: a raw measured fixture body parsed by the REAL client
 *   parser, decided by the REAL policy core over a stub context, reaching a
 *   stub wiring apply; plus the real wired factory over a stub fetch — no
 *   network anywhere.
 * - X-consts: the frozen threshold/budget values.
 *
 * The suite is deliberately file-existence dependent: every gate below was seen
 * red on the unfilled P4 tree (missing package.json / README / ADR / publish
 * entry) before the files landed.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	CACHE_MAX_ENTRIES,
	DEMOTE_CONFIDENCE_GATE,
	MIN_PROMPT_CHARS,
	parseJevResponseBody,
	REQUEST_TIMEOUT_MS,
	TOOL_CONFIDENCE_GATE,
	TOOL_PROB_FLOOR,
	UPGRADE_CONFIDENCE_GATE,
	type JevAnswerSpec,
	type JevFetchFn,
	type JevScheduler,
} from "../../extensions/decision-router/decision-router-client.ts";
import {
	decidePolicies,
	type PolicyOutcome,
	type RoutingRecord,
} from "../../extensions/decision-router/decision-router-core.ts";
import createDecisionRouter from "../../extensions/decision-router/index.ts";
import { createFakePi } from "../helpers/fake-pi.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXTENSION_DIR = join(REPO_ROOT, "extensions", "decision-router");
const RAW_DIR = join(import.meta.dir, "fixtures", "raw");

function read(relativePath: string): string {
	return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

// ------------------------------------------------------------------ X-import

describe("X-import — client + core stay I/O-free (F11 banned tokens, allowlisted seams)", () => {
	test("no process.env, globalThis.fetch, bare fetch(, Date.now(, bare setTimeout(", () => {
		for (const file of ["decision-router-client.ts", "decision-router-core.ts"]) {
			const source = readFileSync(join(EXTENSION_DIR, file), "utf8");
			expect(source).not.toContain("process.env");
			expect(source).not.toContain("globalThis.fetch");
			expect(source).not.toContain("Date.now(");
			expect(source).not.toMatch(/(?<![A-Za-z0-9_$])fetch\(/);
			const withoutInjectionPoints = source
				.replaceAll("scheduler.setTimeout(", "")
				.replace("setTimeout(handler: () => void, timeoutMs: number): unknown;", "");
			expect(withoutInjectionPoints).not.toContain("setTimeout(");
		}
	});
});

// ------------------------------------------------------------------ X-membership

describe("X-membership — publish.ts installs the new directory", () => {
	test("EXTENSION_DIRS contains decision-router", () => {
		const source = read("publish.ts");
		const line = source.split("\n").find((text) => text.includes("EXTENSION_DIRS ="));
		expect(line).toBeDefined();
		expect(line!).toContain('"decision-router"');
	});
});

// ------------------------------------------------------------------ X-content

describe("X-content — manifest, docs and ADR carry the shipped surface", () => {
	test("package.json: main index.ts, type module, metadata-only note, NO dependencies key", () => {
		const pkg = JSON.parse(readFileSync(join(EXTENSION_DIR, "package.json"), "utf8")) as Record<string, unknown>;
		expect(pkg["main"]).toBe("index.ts");
		expect(pkg["type"]).toBe("module");
		expect(String(pkg["description"])).toMatch(/metadata only/i);
		expect("dependencies" in pkg).toBe(false);
	});

	test("extension README: required headings and every env name", () => {
		const readme = readFileSync(join(EXTENSION_DIR, "README.md"), "utf8");
		for (const heading of [
			"# decision-router",
			"## What it does",
			"## Environment variables",
			"## Policy defaults",
			"## Fallback",
			"## Commands",
			"## Handler order",
		]) {
			expect(readme).toContain(heading);
		}
		for (const envName of [
			"OPENROUTER_API_KEY",
			"PI_BADGER_DECISION_ROUTER",
			"PI_BADGER_DECISION_ROUTER_TOOLS",
			"PI_BADGER_DECISION_ROUTER_MODEL",
			"PI_BADGER_DECISION_ROUTER_ROUTING",
			"PI_BADGER_JEV_MODEL",
			"PI_BADGER_JEV_ENDPOINT",
			"PI_BADGER_JEV_TIMEOUT_MS",
			"PI_BADGER_JEV_TIER_LOW_MODEL",
			"PI_BADGER_JEV_TIER_MEDIUM_MODEL",
			"PI_BADGER_JEV_TIER_HIGH_MODEL",
		]) {
			expect(readme).toContain(envName);
		}
		expect(readme).toContain("`0`");
		expect(readme).toContain("/decisions");
		expect(readme).toContain("setActiveTools");
	});

	test("catalog section and repo README row exist", () => {
		const catalog = read("docs/reference/extension-catalog.md");
		expect(catalog).toMatch(/^## The decision-router extension/m);
		const repoReadme = read("README.md");
		expect(repoReadme).toMatch(/^\| decision-router \|/m);
	});

	test("ADR carries Context / Decision / Consequences / Alternatives and the F2 evidence", () => {
		const adr = read("docs/work/2026-09-21-jev-decision-router-adr.md");
		for (const heading of ["## Context", "## Decision", "## Consequences", "## Alternatives"]) {
			expect(adr).toContain(heading);
		}
		expect(adr).toContain("types.d.ts:539");
		expect(adr).toContain("agent-session.js:915");
		expect(adr).toContain("runner.js:881-930");
		expect(adr).toContain("tests/decision-router/probe/hook-probe.md");
		expect(adr).toContain("635");
	});
});

// ------------------------------------------------------------------ X-consts

describe("X-consts — frozen plan v2 values", () => {
	test("thresholds, prompt floor, timeout and cache cap are the frozen numbers", () => {
		expect(TOOL_PROB_FLOOR).toBe(0.2);
		expect(TOOL_CONFIDENCE_GATE).toBe(0.7);
		expect(UPGRADE_CONFIDENCE_GATE).toBe(0.6);
		expect(DEMOTE_CONFIDENCE_GATE).toBe(0.85);
		expect(MIN_PROMPT_CHARS).toBe(12);
		expect(REQUEST_TIMEOUT_MS).toBe(2500);
		expect(CACHE_MAX_ENTRIES).toBe(50);
	});
});

// ------------------------------------------------------------------ X-fixture-flow

/** Stub wiring apply mirroring the extension's tools→model→ring order. */
interface StubWiring {
	tools: string[][];
	model: unknown[];
	ring: RoutingRecord[];
}

function applyOutcome(wiring: StubWiring, outcome: PolicyOutcome): void {
	if (outcome.tools.status === "actuate") wiring.tools.push([...outcome.tools.enable]);
	if (outcome.tier.status === "actuate") wiring.model.push({ ...outcome.tier });
	wiring.ring.push(outcome.routing.record);
}

describe("X-fixture-flow — measured body through the real parser, policy and wiring", () => {
	test("raw 06 parses with the real client parser, decides through the real core, reaches a stub apply", () => {
		const rawText = readFileSync(join(RAW_DIR, "06-json-state.response.json"), "utf8");
		const spec: JevAnswerSpec = {
			questions: {
				first_tool: { type: "choice", options: ["bash", "grep", "edit", "delegate", "read", "write"] },
				needs_subagent: { type: "noul" },
			},
		};
		const parsed = parseJevResponseBody(rawText, spec);
		expect(parsed.status).toBe("ok");
		if (parsed.status !== "ok") throw new Error("measured fixture did not parse");

		const outcome = decidePolicies({
			enabled: { tools: true, model: true, routing: true },
			toolsAnswer: parsed.answers["first_tool"],
			tierAnswer: undefined,
			skillAnswer: undefined,
			catalogue: ["bash", "grep", "edit", "delegate", "read", "write"],
			activeTools: [],
			currentModel: "test/tier-low-model",
			tierModels: { low: "test/low", medium: "test/medium", high: "test/high" },
			upgradesLatched: false,
			promptHash: "measured-06",
		});

		const wiring: StubWiring = { tools: [], model: [], ring: [] };
		applyOutcome(wiring, outcome);
		// Measured bash 0.90 clears the 0.2 floor and 0.89 clears the 0.7 gate.
		expect(wiring.tools).toEqual([["bash"]]);
		expect(outcome.tier).toEqual({ status: "hold", reason: "answer-reject" });
		expect(wiring.model).toEqual([]);
		expect(wiring.ring).toEqual([
			{ question: "skill", choice: "none", confidence: 0, promptHash: "measured-06" },
		]);
	});

	test("the real wired factory actuates tools from the measured body over a stub fetch", async () => {
		const raw = JSON.parse(readFileSync(join(RAW_DIR, "06-json-state.response.json"), "utf8")) as {
			answers: Record<string, unknown>;
		};
		// The measured answer payload is verbatim; only the probe's question key
		// (`first_tool`) is remapped to the extension's question name (`tools`).
		const toolsAnswer = raw.answers["first_tool"];
		const body = JSON.stringify({
			...raw,
			answers: { tools: toolsAnswer, needs_subagent: raw.answers["needs_subagent"] },
		});

		const pi = createFakePi();
		const fetchFn: JevFetchFn = () =>
			Promise.resolve({
				status: 200,
				headers: { get: () => null },
				text: () => Promise.resolve(body),
			});
		const scheduler: JevScheduler = {
			setTimeout: () => 1,
			clearTimeout: () => {},
		};
		const appliedTools: string[][] = [];
		const appliedModel: unknown[] = [];
		const toolState = { active: [] as string[] };
		createDecisionRouter(pi as never, {
			fetchFn,
			scheduler,
			now: () => 1_700_000_000_000,
			env: { OPENROUTER_API_KEY: "test-key" },
			getAllToolsFn: () => [
				{ name: "bash", description: "Run shell commands" },
				{ name: "grep", description: "Search file contents" },
				{ name: "read", description: "Read files" },
			],
			getActiveToolsFn: () => [...toolState.active],
			setActiveToolsFn: (names) => {
				appliedTools.push([...names]);
				toolState.active = [...names];
			},
			setModelFn: async (model) => {
				appliedModel.push(model);
				return true;
			},
			setThinkingLevelFn: () => {},
			getModelFn: () => ({ provider: "test", id: "tier-low-model" }),
			tierModels: { low: "test/low", medium: "test/medium", high: "test/high" },
		});
		const handler = pi.handlers.get("before_agent_start")?.[0];
		expect(handler).toBeDefined();
		await handler!(
			{
				type: "before_agent_start",
				prompt: "Why does the build fail in the deploy pipeline?",
				systemPrompt: "",
				systemPromptOptions: { skills: [] },
			},
			{ getModel: () => ({ provider: "test", id: "tier-low-model" }), ui: { notify: () => {} } },
		);
		expect(appliedTools).toEqual([["bash"]]);
		expect(appliedModel).toEqual([]);
	});
});
