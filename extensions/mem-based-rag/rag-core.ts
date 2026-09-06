/**
 * Pure core of the mem-based-rag extension: the enrichment filter, the RAG query
 * extraction, and the injected block formatting. No pi imports, no processes, no
 * env reads here — the wiring (index.ts) owns all of that. Every rule below is
 * unit-pinned in tests/mem-based-rag/rag-core.test.ts.
 *
 * Contract with the user (f: 2026-09-06):
 *   - inject via before_agent_start, never rewrite the prompt;
 *   - block shape: "Memory context:" with memories + code snippet sections and
 *     explicit pointers to memory_get / code_get for full content;
 *   - skip list: commands, too-short prompts, bare skill calls, plus the
 *     8-unique-words (≥3 chars ex-noise-dict) thinness gate — filters, not a score floor,
 *     eliminate meaningless prompts;
 *   - modes: default (search snippets) vs expanded (memory_get/code_get per hit).
 */

/** Bare skill invocation with no extension text: `/skill:name` and nothing else. */
const BARE_SKILL_RE = /^\/skill:[a-z0-9_-]+\s*$/i;

/** Skill-call prefix to strip when a skill call carries extension text. */
const SKILL_PREFIX_RE = /^\/skill:[a-z0-9_-]+\s+/i;

/** Exact control words that never need context, whatever their length. */
const CONTROL_WORDS = new Set([
	"stop",
	"continue",
	"exit",
	"quit",
	"clear",
	"help",
	"ping",
]);

export type SkipReason =
	| "empty"
	| "command"
	| "control-word"
	| "bare-skill-call"
	| "too-short"
	| "too-thin";

export interface EnrichDecision {
	enrich: boolean;
	reason: SkipReason | "ok";
	/** The query to send when enrich is true (skill prefix stripped). */
	query: string;
	/** Unique words of 3+ chars outside the noise dictionary (the thinness signal). */
	uniqueWords: number;
}

/**
 * Noise dictionary: high-frequency closed-class 3-letter English words
 * (articles, conjunctions, prepositions, pronouns, auxiliaries, contraction
 * stubs) that carry no query signal. Curated and extendable — content-bearing
 * 3-letter tokens (`fix`, `api`, `env`, `bus`, `url`, …) are deliberately NOT
 * here: in terse technical prompts they are often the intent itself.
 */
export const NOISE_3CHAR_WORDS: ReadonlySet<string> = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
	"had", "has", "her", "was", "one", "our", "out", "off", "him", "his",
	"how", "she", "too", "who", "did", "its", "own", "few", "via", "per",
	"don", "isn", "wasn", "yet", "nor",
]);

/** Lowercase alphanumeric tokens of 3+ chars, minus the noise dictionary, deduplicated. */
export function uniqueLongWords(text: string): Set<string> {
	const words = new Set<string>();
	for (const token of text.toLowerCase().split(/[^a-z0-9_]+/)) {
		if (token.length >= 3 && !NOISE_3CHAR_WORDS.has(token)) words.add(token);
	}
	return words;
}

/**
 * Decide whether a raw user prompt (pre-expansion, as the `input` event sees it)
 * deserves a memory_search. Order matters: the bare-skill and command gates run
 * before the length gates, so `/skill:task` reports `bare-skill-call` instead of
 * the misleading `too-short`.
 */
export function shouldEnrich(
	rawPrompt: string,
	opts?: { minChars?: number; minWords?: number },
): EnrichDecision {
	const minChars = opts?.minChars ?? 20;
	const minWords = opts?.minWords ?? 8;
	const text = rawPrompt.trim();
	if (!text) return { enrich: false, reason: "empty", query: "", uniqueWords: 0 };
	// Bare skill call: an invocation with no extension text carries no query.
	if (BARE_SKILL_RE.test(text)) {
		return { enrich: false, reason: "bare-skill-call", query: "", uniqueWords: 0 };
	}
	const low = text.toLowerCase();
	if (CONTROL_WORDS.has(low)) {
		return { enrich: false, reason: "control-word", query: "", uniqueWords: 0 };
	}
	// Single-token slash commands (/delegations, /monitors, …) need no context.
	// A skill call WITH extension text is not single-token and passes through.
	if (text.startsWith("/") && text.split(/\s+/).length === 1) {
		return { enrich: false, reason: "command", query: "", uniqueWords: 0 };
	}
	const query = extractQuery(text);
	if (query.length < minChars) {
		return { enrich: false, reason: "too-short", query: "", uniqueWords: 0 };
	}
	const uniqueWords = uniqueLongWords(query).size;
	if (uniqueWords < minWords) {
		return { enrich: false, reason: "too-thin", query: "", uniqueWords };
	}
	return { enrich: true, reason: "ok", query, uniqueWords };
}

/**
 * The RAG query for an enrichable prompt: the raw text with a leading
 * `/skill:name` invocation prefix stripped, so the bank is queried for the
 * user's words — never the skill call and never expanded skill content.
 */
export function extractQuery(rawPrompt: string): string {
	return rawPrompt.trim().replace(SKILL_PREFIX_RE, "").trim();
}

// ------------------------------------------------------------------ formatting

export interface MemoryHit {
	hash: string;
	ranking?: number | string;
	path?: string;
	snippet?: string;
	sourceFile?: string;
	lineStart?: number;
	lineEnd?: number;
}

function oneLine(text: string | undefined, max: number): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function memLine(index: number, hit: MemoryHit, snippetChars: number): string {
	const rank = hit.ranking ?? "?";
	return `[m${index}] ${hit.path ?? "?"} (rank ${rank}) :: ${oneLine(hit.snippet, snippetChars)}`;
}

function codeLine(index: number, hit: MemoryHit, snippetChars: number): string {
	const rank = hit.ranking ?? "?";
	const lines =
		hit.lineStart !== undefined && hit.lineEnd !== undefined
			? `:${hit.lineStart}-${hit.lineEnd}`
			: "";
	return `[c${index}] ${hit.path ?? "?"}${lines} (rank ${rank}) :: ${oneLine(hit.snippet, snippetChars)}`;
}

export interface BlockOpts {
	snippetChars?: number;
	maxMem?: number;
	maxCode?: number;
	queryEchoChars?: number;
}

/**
 * Default mode: snippets straight from the search result. Self-contained by
 * construction — header names the source and mode, each section names the tool
 * that serves full content, footer states the truncation.
 */
export function toMemoryContext(
	query: string,
	mem: MemoryHit[],
	code: MemoryHit[],
	opts?: BlockOpts,
): string {
	const snippetChars = opts?.snippetChars ?? 300;
	const memHits = mem.slice(0, opts?.maxMem ?? 3);
	const codeHits = code.slice(0, opts?.maxCode ?? 2);
	const lines = [
		`Memory context (ai-raccoon memory_search, snippets — query: "${oneLine(query, opts?.queryEchoChars ?? 80)}"):`,
		"- memories (snippets — to get full content use memory_get with the hash):",
	];
	if (memHits.length === 0) lines.push("  (no memory hits)");
	memHits.forEach((hit, i) => lines.push(memLine(i + 1, hit, snippetChars)));
	lines.push("- code (snippets — to get full content use code_get with the hash):");
	if (codeHits.length === 0) lines.push("  (no code hits)");
	codeHits.forEach((hit, i) => lines.push(codeLine(i + 1, hit, snippetChars)));
	lines.push(`(snippets truncated to ${snippetChars} chars; hashes identify the full entries)`);
	return lines.join("\n");
}

/**
 * Expanded mode: one memory_get/code_get value per kept hit, with path and
 * chunk/line provenance. A per-hit failure falls back to that hit's snippet so
 * one unreadable entry never sinks the whole block.
 */
export function toExpandedMemoryContext(
	query: string,
	items: Array<{ hit: MemoryHit; kind: "memory" | "code"; value?: string; path?: string; chunk?: string }>,
	opts?: BlockOpts & { valueChars?: number },
): string {
	const valueChars = opts?.valueChars ?? 1200;
	const lines = [
		`Memory context (ai-raccoon memory_get/code_get, expanded — query: "${oneLine(query, opts?.queryEchoChars ?? 80)}"):`,
		"- memories (full content below — no further fetch needed):",
	];
	const memItems = items.filter((item) => item.kind === "memory");
	const codeItems = items.filter((item) => item.kind === "code");
	if (memItems.length === 0) lines.push("  (no memory hits)");
	memItems.forEach((item, i) => {
		const body = item.value !== undefined ? oneLine(item.value, valueChars) : oneLine(item.hit.snippet, opts?.snippetChars ?? 300);
		lines.push(`[m${i + 1}] ${item.path ?? item.hit.path ?? "?"}${item.chunk ? ` (${item.chunk})` : ""} :: ${body}`);
	});
	lines.push("- code (full content below — no further fetch needed):");
	if (codeItems.length === 0) lines.push("  (no code hits)");
	codeItems.forEach((item, i) => {
		const body = item.value !== undefined ? oneLine(item.value, valueChars) : oneLine(item.hit.snippet, opts?.snippetChars ?? 300);
		lines.push(`[c${i + 1}] ${item.path ?? item.hit.path ?? "?"}${item.chunk ? ` (${item.chunk})` : ""} :: ${body}`);
	});
	lines.push(`(values truncated to ${valueChars} chars)`);
	return lines.join("\n");
}
