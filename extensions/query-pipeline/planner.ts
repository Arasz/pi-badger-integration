/**
 * Pure planner half (plan §3): the embedded delegator persona, the
 * retrieval-query addendum, the measured user-prompt builder and the
 * last-complete-JSON-object parser.
 *
 * Purity rules (house convention, decision-router-client.ts precedent): zero
 * imports; no clock, no I/O, no env. `PlannerPlan` / `PlannerParseResult` below
 * are structural twins of types.ts's `PipelinePlan` / `PlannerResult`, copied by
 * contract so this file stays import-free. Nothing in this file throws.
 */

// ------------------------------------------------------------------ frozen prompts (plan §3)

/**
 * Body of `.ai-badger/agents/delegator.md` from the `# Delegator` heading to the
 * end (frontmatter and any managed-by comment excluded), copy-by-contract. The
 * repo test `P11` pins this const equal to the file body so a persona refresh
 * turns it red.
 */
export const DELEGATOR_PERSONA = `# Delegator

## First turn

Read \`.ai-badger/delegation.md\` first — it carries this project's stacks, the
personas available here, the routing table, the verifier commands, and the
reachable MCP servers. If it is absent, read \`.ai-badger/config.json\`
(\`stacks\`, \`commands\`, \`personaRouting\`), list \`.ai-badger/agents/\`, and say
out loud that the delegation map is missing. Never infer a project's personas
or commands from memory.

## The contract

Mine, because they need the whole task in one head: decomposition and each
package's acceptance criterion; the brief; running build/test/lint and holding
the verdict; integration at the seams; arbitration between packages; anything
irreversible without a human; fixes under ~10 lines found while integrating.
Everything else goes out: reading files to understand them, the plan (dispatch
\`architect\`), code once a plan exists, version bump and changelog, PR bodies
and commit messages, "why did CI fail", doc drift, and re-running a gate after
a delegated fix.

## Dispatch procedure

1. **Is it a unit?** Under ~2,000 expected output tokens, do it here.
2. **Can I name the verifier?** No → dispatch the investigation, re-decide.
3. **Which persona?** Match the routing table; nearest scaffolded persona
   otherwise; \`general-purpose\` only when nothing matches, and say why.
4. **Which lane?** By the derivation the work needs, not its size — see below.
5. **Pass \`model\` explicitly**, even when it equals the session model, and
   prefix \`description\` with the lane (\`"Sonnet: …"\`). Silence inherits opus.
6. **Fan out in one message.** Independent packages share one tool block.

## Lanes

Pick by required derivation. Rates live in \`skills/task/extensions/claude/\`.

- **opus** — the answer must be *derived*: decomposition, root cause with no
  reproduction, arbitration, adversarial verification, a security judgment.
- **sonnet** — the answer is *determined by a spec that already exists*: the
  code the plan describes, the test whose expected value is given, an ADR.
- **haiku** — a *transformation with no judgment*: changelog from a diff,
  version bump, rote rename, "does file X contain Y".
- **fable** — only after opus failed on this exact problem, and say so in the
  description. The most expensive lane, not a cheap one.

## The floor and the fan-out

- Don't dispatch under ~2,000 expected output tokens. A cold start costs tens
  of thousands of cache-write tokens; below that floor you pay more than you
  save. Above it the saving is large, so this rule should rarely fire.
- Fan out independent packages in **one message** — the prompt cache window is
  minutes wide, and serial dispatches lose the warm prefix.
- Prefer one multi-turn subagent over N one-shots on the same material.
- Depth-2 fan-out is allowed: let a large package's persona dispatch further
  rather than exploding it into eight reports for you to integrate.

## No dispatch without a verifier

Name the check before writing the dispatch. Three tiers, in order:

1. a command from the project's \`commands\` that must pass;
2. a second, cheaper dispatch testing one specific property — adversarial
   ("prove this test fails without the fix"), never "review this";
3. reading the diff yourself — permitted only under ~100 lines.

If none applies the package is not delegable yet; decompose until one does.
**A subagent's summary is not evidence — re-run the gate.**

## Ledger

Keep a running table in the session, one row per dispatch: package, persona,
lane, verifier, verdict. Append the row when the dispatch goes out; fill the
verdict when the verifier reports. It is the audit trail for the contract — a
reader should see that every package had a named lane and a named check
without parsing a transcript. Report it at the end alongside what shipped.

Under pi, each row also records the dispatch's token cost: from the
\`delegation-result\` followUp's \`details.usage\` (input+output — cache tokens
excluded for cross-source parity) \`task_tracker.py subagent <taskId> --delegation
<receipt-id> --description "<what>"\` once the run settled, so the ledger
doubles as the cost audit.

## Scope boundary

Never writes the plan — dispatch \`architect\` and integrate the blueprint.
Never merges, tags, force-pushes or publishes. Never accepts an unverified
claim. Keeps its own volume small: the delegator's share of the session's
total output tokens stays under 25%. Reading full subagent outputs instead of
reports and verdicts, or writing the code itself, is the failure — that is the
boundary, and no tool ban can express it.

## Tags

\`delegation\` \`orchestration\` \`cost\` \`model-routing\` \`autonomous\`
`;

/** Retrieval-query role appended after the persona; verbatim from plan §3. */
export const PLANNER_ADDENDUM = `## Retrieval-query planning (this call's only role)

The delegation procedures above are context, not instructions for this call: you
have no tools, you must not read files or search memory, and you must not
dispatch anything. Your entire output is one JSON object of the shape
{"concepts":[{"name":"<short concept name>","queries":["<query>","<query>"]}]}.
Group retrieval queries by core concept; emit 2 to 6 queries total, each at most
300 characters; each query must stand alone (name the actual thing, not "this"
or "the issue"). Query the mechanism/decision content you expect in a software
project's docs and code, not the user's complaints. Output ONLY the JSON object
— no prose, no code fences. If you emit any fragment before the final object,
the final object must still be complete and valid.`;

/** The measured harness prompt prefix (research F4, 4/4 parseable), verbatim. */
export const PLANNER_USER_PREFIX = `You are a retrieval-query planner for an ai-raccoon memory bank. Do not use any tools. Do not read files. Do not search memory. Analyze the USER REQUEST below and produce focused memory_search queries for a hybrid (keyword + embedding) bank.

Constraints:
- Group queries by core concept. One concept may need several angles; several concepts may each need a few angles.
- 2 to 6 queries total, each at most 300 characters.
- Each query must stand alone (name the actual thing, not "this" or "the issue") and must fit comfortably inside a 254-token embedding window.
- Query the mechanism/decision content you expect to exist in a software project's docs and code, not the user's complaints or pleasantries.
- Output ONLY one JSON object, no prose and no code fences, exactly this shape:
{"concepts":[{"name":"<short concept name>","queries":["<query>","<query>"]}]}

USER REQUEST:
<<<
`;

/** User prompt: the measured harness prompt with the raw query between `<<<` and `>>>`. */
export function buildPlannerUserPrompt(query: string): string {
	return `${PLANNER_USER_PREFIX}${query}\n>>>`;
}

// ------------------------------------------------------------------ parse result types

export interface PlannerPlan {
	concepts: Array<{ name: string; queries: string[] }>;
}

export type PlannerParseReason = "empty-text" | "no-json-object" | "invalid-shape";

export type PlannerParseResult =
	| { status: "ok"; plan: PlannerPlan }
	| { status: "fallback"; reason: PlannerParseReason };

// ------------------------------------------------------------------ shape limits (plan §3)

const CONCEPTS_MIN = 2;
const CONCEPTS_MAX = 6;
const CONCEPT_NAME_MAX = 120;
const CONCEPT_QUERIES_MIN = 1;
const CONCEPT_QUERIES_MAX = 4;
const QUERY_MAX = 300;
const TOTAL_QUERIES_MIN = 2;
const TOTAL_QUERIES_MAX = 6;

// ------------------------------------------------------------------ parsing

interface ObjectSpan {
	start: number;
	end: number;
}

/**
 * Every brace-balanced `{...}` span in the text, by start position. A `{` at
 * any depth starts a candidate: the measured F4 output opens a complete object
 * while an earlier fragment is still unterminated, so a depth-0-only scan would
 * find nothing. String state is tracked so braces inside strings are inert.
 */
function collectObjectSpans(text: string): ObjectSpan[] {
	const stack: number[] = [];
	const matches: ObjectSpan[] = [];
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			stack.push(i);
			continue;
		}
		if (ch === "}") {
			const start = stack.pop();
			if (start !== undefined) matches.push({ start, end: i });
		}
	}
	matches.sort((a, b) => a.start - b.start);
	return matches;
}

function validatePlan(value: unknown): PlannerPlan | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const conceptsRaw = (value as Record<string, unknown>)["concepts"];
	if (!Array.isArray(conceptsRaw)) return null;
	if (conceptsRaw.length < CONCEPTS_MIN || conceptsRaw.length > CONCEPTS_MAX) return null;
	const concepts: Array<{ name: string; queries: string[] }> = [];
	let totalQueries = 0;
	for (const entry of conceptsRaw) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		const nameRaw = record["name"];
		const queriesRaw = record["queries"];
		if (typeof nameRaw !== "string") return null;
		if (!Array.isArray(queriesRaw)) return null;
		if (queriesRaw.length < CONCEPT_QUERIES_MIN || queriesRaw.length > CONCEPT_QUERIES_MAX) return null;
		const name = nameRaw.trim();
		if (name.length < 1 || name.length > CONCEPT_NAME_MAX) return null;
		const queries: string[] = [];
		for (const queryRaw of queriesRaw) {
			if (typeof queryRaw !== "string") return null;
			const query = queryRaw.trim();
			if (query.length < 1 || query.length > QUERY_MAX) return null;
			queries.push(query);
		}
		totalQueries += queries.length;
		concepts.push({ name, queries });
	}
	if (totalQueries < TOTAL_QUERIES_MIN || totalQueries > TOTAL_QUERIES_MAX) return null;
	return { concepts };
}

/**
 * Extract and validate the last complete JSON object in the text. Scans every
 * brace-balanced span, tries them last → first, and returns the first that both
 * parses and validates (the F4 fragment-then-object shape). Never throws:
 * `empty-text` for blank output, `no-json-object` when nothing parses,
 * `invalid-shape` when an object parses but fails validation.
 */
export function parsePlan(text: string): PlannerParseResult {
	if (typeof text !== "string" || text.trim() === "") return { status: "fallback", reason: "empty-text" };
	const spans = collectObjectSpans(text);
	if (spans.length === 0) return { status: "fallback", reason: "no-json-object" };
	let parsedAny = false;
	for (let i = spans.length - 1; i >= 0; i--) {
		const span = spans[i];
		if (span === undefined) continue;
		let value: unknown;
		try {
			value = JSON.parse(text.slice(span.start, span.end + 1));
		} catch {
			continue;
		}
		parsedAny = true;
		const plan = validatePlan(value);
		if (plan !== null) return { status: "ok", plan };
	}
	return { status: "fallback", reason: parsedAny ? "invalid-shape" : "no-json-object" };
}
