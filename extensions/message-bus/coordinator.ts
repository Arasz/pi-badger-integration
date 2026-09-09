/**
 * Wake-only, read-only coordinator tick for the message-bus extension.
 *
 * Sessions self-read on their own turn boundaries; the tick only computes
 * WHO has pending mail (a wake list for the orchestrator's own wake path).
 * It never moves a cursor, never stores a row, never touches pi — the read
 * seam is `peekForSession` with a `getCursor`+`listForSession` fallback, both
 * of which leave all cursors and tables exactly as found.
 *
 * Fail-open: every per-target read failure becomes an `errors` entry, never
 * a throw — one sick session must not blind the rest of the tick.
 *
 * Single-flight: overlapping ticks collapse onto the in-flight run, so
 * concurrent callers share one store pass (max concurrency 1).
 *
 * Rotation: ticks serve the registry round-robin in snapshot order, `budget`
 * entries per tick; `truncated` says whether unserved fresh entries remain in
 * this pass. A new snapshot `version` restarts the rotation.
 *
 * Kill-switch: `PI_BADGER_MESSAGE_BUS === "0"` returns `{ disabled: true }`
 * before touching the store at all.
 */

/** Registry freshness window (s): entries unseen longer than this are skipped. MEASUREMENT-TODO (V6): validate 300 against real idle-session lifetimes. */
export const REGISTRY_TTL_S = 300;

/** Default and max sessions served per tick. MEASUREMENT-TODO (V6): validate 25 against real registry sizes and peek latency. */
export const MAX_TICK_SESSIONS = 25;

/** One registry row: who the session is and when it was last seen. */
export interface CoordinatorRegistryEntry {
	sessionId: string;
	projectId: string | null;
	lastSeenMs: number;
}

/** The registry view one tick rotates over. */
export interface RegistrySnapshot {
	entries: CoordinatorRegistryEntry[];
	version: string;
}

/** Tick knobs: `budget` caps sessions served (default/max MAX_TICK_SESSIONS). */
export interface CoordinatorTickOptions {
	budget?: number;
	now: number;
	env?: Record<string, string | undefined>;
}

/** One per-target read failure (fail-open value, never a throw). */
export interface CoordinatorTickError {
	sessionId: string;
	error: string;
}

/** Wake list plus rotation state. `disabled` is set only by the kill-switch. */
export interface CoordinatorTickResult {
	woke: string[];
	errors: CoordinatorTickError[];
	truncated: boolean;
	disabled?: boolean;
}

/** Minimal read seam (structural subset of BusStore, write paths omitted by design). */
export interface CoordinatorStore {
	peekForSession?(sessionId: string, projectId: string | null): { messages: unknown[]; cursor: number } | Promise<{ messages: unknown[]; cursor: number }>;
	listForSession?(sessionId: string, projectId: string | null): Array<{ id: number }> | Promise<Array<{ id: number }>>;
	getCursor?(sessionId: string): number | Promise<number>;
}

const KILL_SWITCH = "PI_BADGER_MESSAGE_BUS";

/** Overlapping ticks collapse onto this run; cleared on settle. */
let inFlight: Promise<CoordinatorTickResult> | null = null;

/** Rotation state: where the next tick resumes, and which registry view it was for. */
let lastVersion: string | null = null;
let roundRobinOffset = 0;

/** Wake-only tick: compute who has pending mail. Read-only, fail-open, single-flight. */
export function tickCoordinator(store: CoordinatorStore, snapshot: RegistrySnapshot, opts: CoordinatorTickOptions): Promise<CoordinatorTickResult> {
	const env = opts.env ?? process.env;
	if (env[KILL_SWITCH] === "0") return Promise.resolve({ woke: [], errors: [], truncated: false, disabled: true });
	if (inFlight) return inFlight;
	const run = runTick(store, snapshot, opts);
	inFlight = run;
	const clear = (): void => {
		if (inFlight === run) inFlight = null;
	};
	run.then(clear, clear);
	return run;
}

async function runTick(store: CoordinatorStore, snapshot: RegistrySnapshot, opts: CoordinatorTickOptions): Promise<CoordinatorTickResult> {
	const limit =
		typeof opts.budget === "number" && Number.isInteger(opts.budget) && opts.budget > 0 ? Math.min(opts.budget, MAX_TICK_SESSIONS) : MAX_TICK_SESSIONS;
	if (lastVersion !== snapshot.version) {
		lastVersion = snapshot.version;
		roundRobinOffset = 0;
	}
	const fresh = snapshot.entries.filter((entry) => opts.now - entry.lastSeenMs <= REGISTRY_TTL_S * 1000);
	if (roundRobinOffset >= fresh.length) roundRobinOffset = 0;
	if (fresh.length === 0) {
		roundRobinOffset = 0;
		return { woke: [], errors: [], truncated: false };
	}
	const start = roundRobinOffset;
	const slice = fresh.slice(start, start + limit);
	const canPeek = typeof store.peekForSession === "function";
	const canFallback = typeof store.listForSession === "function" && typeof store.getCursor === "function";
	const woke: string[] = [];
	const errors: CoordinatorTickError[] = [];
	// Sequential, one session at a time: a bare fan-out would let one
	// rejection escape and blind the rest, so each target gets its own
	// try/catch and the tick degrades per-target instead of failing whole.
	for (const entry of slice) {
		try {
			let pending: boolean;
			if (canPeek) {
				const preview = await store.peekForSession!(entry.sessionId, entry.projectId);
				pending = preview.messages.length > 0;
			} else if (canFallback) {
				const cursor = await store.getCursor!(entry.sessionId);
				const rows = await store.listForSession!(entry.sessionId, entry.projectId);
				pending = rows.some((row) => row.id > cursor);
			} else {
				throw new Error("coordinator: store has no read seam (peek / list+cursor absent)");
			}
			if (pending) woke.push(entry.sessionId);
		} catch (error) {
			errors.push({ sessionId: entry.sessionId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (start + slice.length >= fresh.length) {
		roundRobinOffset = 0;
		return { woke, errors, truncated: false };
	}
	roundRobinOffset = start + slice.length;
	return { woke, errors, truncated: true };
}
