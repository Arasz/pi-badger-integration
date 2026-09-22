/**
 * Pure rank+merge rule (plan §2): document identity, the total-order comparator,
 * the per-kind dedupe pool and the document-aware five-slot `mergeSelect`.
 *
 * Purity rules (house convention, decision-router-client.ts precedent): zero
 * imports; no clock, no I/O, no env. `MergeCandidate` below is a structural twin
 * of types.ts's `PipelineCandidate`, copied by contract so this file stays
 * import-free.
 *
 * Merge contract: 5 slots total across memory + code (R3). Pass 1 takes the best
 * chunk per distinct document (null-scored distinct documents included — a null
 * is missing evidence about one chunk, not proof the document is irrelevant).
 * Pass 2 backfills only from documents already admitted, in global rank order,
 * never repeating a chosen chunk.
 */

export const MERGE_SLOTS = 5;

export interface MergeCandidate {
	hash: string;
	path?: string;
	sourceFile?: string;
	snippet?: string;
	ranking?: number | string;
	lineStart?: number;
	lineEnd?: number;
	kind?: "memory" | "code";
	score?: number | null;
	query?: string;
	concept?: string;
}

/** Document identity: `path:` + trimmed path/sourceFile, else `hash:` + trimmed hash. */
export function docKey(hit: MergeCandidate): string {
	const path = (hit.path ?? hit.sourceFile ?? "").trim();
	if (path !== "" && path !== "?") return `path:${path}`;
	return `hash:${(hit.hash ?? "").trim()}`;
}

function effectiveSnippet(hit: MergeCandidate): string {
	return (hit.snippet ?? "").trim();
}

/** `? ::` parity with rag-core `isDroppableHit`: missing path AND snippet (either alone is kept). */
function isDroppableHit(hit: MergeCandidate): boolean {
	const path = (hit.path ?? hit.sourceFile ?? "").trim();
	const snippet = effectiveSnippet(hit);
	return (path === "" || path === "?") && snippet === "";
}

/** Drop droppables first, then dedupe on non-empty hash OR identical non-empty snippet; first wins. */
function dedupeKind(hits: MergeCandidate[]): MergeCandidate[] {
	const seenHashes = new Set<string>();
	const seenSnippets = new Set<string>();
	const out: MergeCandidate[] = [];
	for (const hit of hits) {
		if (isDroppableHit(hit)) continue;
		const hashKey = (hit.hash ?? "").trim();
		const snippetKey = effectiveSnippet(hit);
		if (hashKey !== "" && seenHashes.has(hashKey)) continue;
		if (snippetKey !== "" && seenSnippets.has(snippetKey)) continue;
		if (hashKey !== "") seenHashes.add(hashKey);
		if (snippetKey !== "") seenSnippets.add(snippetKey);
		out.push(hit);
	}
	return out;
}

/** `pruneHits` parity, run per kind: mem and code dedupe independently. */
export function dedupePool(
	mem: MergeCandidate[],
	code: MergeCandidate[],
): { mem: MergeCandidate[]; code: MergeCandidate[] } {
	return { mem: dedupeKind(mem), code: dedupeKind(code) };
}

/** Finite score in [0,3], or null for missing evidence. */
function scoreOf(hit: MergeCandidate): number | null {
	return typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : null;
}

/** Numeric server rank, or +Infinity when absent/non-numeric. */
function serverRankOf(hit: MergeCandidate): number {
	// Plan §2: finite number → itself; numeric string → parsed; anything else → +Infinity.
	const raw = hit.ranking;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Number.POSITIVE_INFINITY;
}

/** Total order: scored before null, score desc, server rank asc, insertion order (stable). */
export function compareCandidates(a: MergeCandidate, b: MergeCandidate): number {
	const aScore = scoreOf(a);
	const bScore = scoreOf(b);
	if (aScore !== null && bScore === null) return -1;
	if (aScore === null && bScore !== null) return 1;
	if (aScore !== null && bScore !== null && aScore !== bScore) return bScore - aScore;
	const aRank = serverRankOf(a);
	const bRank = serverRankOf(b);
	if (aRank !== bRank) return aRank - bRank;
	return 0;
}

/** The plan §2 name for the comparator. */
export const comparator = compareCandidates;

/** Stable sort by decorate-sort-undecorate so tie order never depends on the engine. */
function stableSort<T>(items: T[], compare: (a: T, b: T) => number): T[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => compare(a.item, b.item) || a.index - b.index)
		.map((entry) => entry.item);
}

export function mergeSelect(
	candidates: MergeCandidate[],
	slots = MERGE_SLOTS,
): { mem: MergeCandidate[]; code: MergeCandidate[] } {
	if (candidates.length === 0) return { mem: [], code: [] };
	const ranked = stableSort(candidates.slice(), compareCandidates);
	const chosen: MergeCandidate[] = [];
	const chosenHashes = new Set<string>();
	const seenDocs = new Set<string>();
	// Pass 1: the best chunk per distinct document, null-scored docs included.
	for (const candidate of ranked) {
		if (chosen.length === slots) break;
		const key = docKey(candidate);
		if (seenDocs.has(key)) continue;
		seenDocs.add(key);
		chosen.push(candidate);
		chosenHashes.add(candidate.hash);
	}
	// Pass 2: backfill only from already-included documents, never a chosen chunk.
	if (chosen.length < slots) {
		for (const candidate of ranked) {
			if (chosen.length === slots) break;
			if (chosenHashes.has(candidate.hash)) continue;
			if (!seenDocs.has(docKey(candidate))) continue;
			chosen.push(candidate);
			chosenHashes.add(candidate.hash);
		}
	}
	return {
		mem: chosen.filter((hit) => hit.kind === "memory"),
		code: chosen.filter((hit) => hit.kind === "code"),
	};
}
