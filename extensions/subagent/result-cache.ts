/**
 * The in-memory delegation result cache (f: 2026-09-02, option (c)): a ring of the LAST 8
 * structured result entries, indexed by `delegation_id` and secondarily grouped by `parent_id`
 * in insertion order. In-memory only — the cache dies with the session; nothing persists.
 *
 * Pure by construction: no imports at all. The note input is a structural slice of
 * DelegationNote, so this module never depends on the runner, pi, or index.ts (no cycles —
 * delegation-status.ts reads the cache through the `{ byId, byParent }` opts seam).
 *
 * `put` stamps `timestamp` from the injected clock: DelegationNote carries no absolute finish
 * time (only `durationMs`), so the put moment IS the finish record — no phantom field is
 * invented on the note.
 */

/** The note slice the cache reads — structurally compatible with DelegationNote. */
export interface ResultNoteInput {
	id: string;
	agent: string;
	task: string;
	answer: string;
	/** The delegating session's id; undefined → the entry omits `parent_id` entirely. */
	sessionId?: string;
}

/** One structured delegation result (f: 2026-09-02 user spec, field order pinned). */
export interface DelegationResultEntry {
	/** The delegating session's id — omitted when the note carried none (schema stays honest). */
	parent_id?: string;
	delegation_id: string;
	/** The task's first line, capped at TASK_SUMMARY_MAX_CHARS; a truncated line carries the
	 *  `…` marker after the cap (so a truncated summary is the cap plus one marker char). */
	task_summary: string;
	/** The persona the task ran as (DelegationNote.agent). */
	persona: string;
	/** The task, head-capped at RESULT_INPUT_MAX_CHARS with `…`. */
	input: string;
	/** The answer, tail-kept at RESULT_OUTPUT_MAX_CHARS — the answer lives at the end. */
	output: string;
	/** ISO timestamp stamped from the injected clock at put time. */
	timestamp: string;
}

/** Ring size: the cache keeps the LAST 8 results (design pin). */
export const RESULT_CACHE_LIMIT = 8;

/** task_summary cap: the task's first line, ≤ 120 chars — deliberately NOT taskExcerpt's 100. */
export const TASK_SUMMARY_MAX_CHARS = 120;

/** input cap: the task, head-capped (the ask reads from the top). */
export const RESULT_INPUT_MAX_CHARS = 2000;

/** output cap: the answer, tail-kept with the codebase's drop marker (the answer lives at the end). */
export const RESULT_OUTPUT_MAX_CHARS = 6000;

/** Head-cap with the codebase's `…` marker (input and task_summary — caps count chars). */
function headCap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** Tail-keep with the same `[...N earlier characters dropped]` marker capTail/capOutput use. */
function tailKeep(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `[...${text.length - limit} earlier characters dropped]\n${text.slice(-limit)}`;
}

/** The note→entry builder: caps applied, timestamp from the injected clock, parent_id omitted
 * when the note has no session. Exported so tests and diagnostics can build an entry without a
 * cache instance; the card wiring never builds — it reads entries back through the cache. */
export function buildResultEntry(note: ResultNoteInput, now: () => number): DelegationResultEntry {
	const firstLine = note.task.split("\n")[0] ?? "";
	const entry: DelegationResultEntry = {
		delegation_id: note.id,
		task_summary: headCap(firstLine, TASK_SUMMARY_MAX_CHARS),
		persona: note.agent,
		input: headCap(note.task, RESULT_INPUT_MAX_CHARS),
		output: tailKeep(note.answer, RESULT_OUTPUT_MAX_CHARS),
		timestamp: new Date(now()).toISOString(),
	};
	if (note.sessionId !== undefined) entry.parent_id = note.sessionId;
	return entry;
}

/**
 * The result cache. One instance per session, constructed in index.ts beside the registry and
 * handed to the status surface through the `resultCache` opts seam ({ byId, byParent }).
 */
export class DelegationResultCache {
	/** Oldest → newest; the ring is the eviction authority. */
	private readonly ring: DelegationResultEntry[] = [];
	private readonly idIndex = new Map<string, DelegationResultEntry>();
	private readonly parentIndex = new Map<string, DelegationResultEntry[]>();

	/** Build the entry for `note` and insert it as the newest. A re-put of an existing
	 * delegation_id removes the old entry from ring and parent index first; eviction of the
	 * oldest removes it from the ring AND both indexes (a parent array is spliced with the
	 * remaining order kept, and the parent key is deleted when its array empties). */
	put(note: ResultNoteInput, clock: { now: () => number }): DelegationResultEntry {
		const entry = buildResultEntry(note, clock.now);
		const existing = this.idIndex.get(entry.delegation_id);
		if (existing) this.evict(existing);
		this.ring.push(entry);
		this.idIndex.set(entry.delegation_id, entry);
		if (entry.parent_id !== undefined) {
			const siblings = this.parentIndex.get(entry.parent_id);
			if (siblings) siblings.push(entry);
			else this.parentIndex.set(entry.parent_id, [entry]);
		}
		while (this.ring.length > RESULT_CACHE_LIMIT) {
			this.evict(this.ring[0]!); // the oldest leaves the ring and both indexes together
		}
		return entry;
	}

	/** The cached entry for one delegation, or undefined. */
	byId(id: string): DelegationResultEntry | undefined {
		return this.idIndex.get(id);
	}

	/** One parent session's entries, insertion order (oldest first) — a copy: callers embed
	 *  returned entries into card details and tool results, and must never hold live internals. */
	byParent(parentId: string): DelegationResultEntry[] {
		return [...(this.parentIndex.get(parentId) ?? [])];
	}

	/** Every cached entry, ring order (oldest first) — tests and diagnostics. */
	all(): DelegationResultEntry[] {
		return [...this.ring];
	}

	/** Remove one entry everywhere: ring, byId, byParent (spliced; empty parent key deleted). */
	private evict(entry: DelegationResultEntry): void {
		const ringIndex = this.ring.indexOf(entry);
		if (ringIndex >= 0) this.ring.splice(ringIndex, 1);
		this.idIndex.delete(entry.delegation_id);
		if (entry.parent_id !== undefined) {
			const siblings = this.parentIndex.get(entry.parent_id);
			if (siblings) {
				const index = siblings.indexOf(entry);
				if (index >= 0) siblings.splice(index, 1);
				if (siblings.length === 0) this.parentIndex.delete(entry.parent_id);
			}
		}
	}
}
