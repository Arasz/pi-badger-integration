/**
 * Pure grouping + channel cache for the message-delivery coordinator (PKG-2).
 *
 * One read's inbox rows → delivery channels via `groupByScope` (parameterised
 * `groupKey` so a later transport spike can reshape without rewrite), cached
 * across ticks by `buildChannelCache` (rebuilt only when the snapshot
 * `version` from `snapshotVersion` differs). House-pure: no I/O, no clock —
 * rows and snapshots arrive as args; `scopeOf` is imported, never duplicated.
 */

import { scopeOf, type BusMessage } from "./message-bus-core.ts";

/** One registry row as the registry reader reports it per tick. */
export interface RegistryEntry {
	sessionId: string;
	projectId: string | null;
	lastSeenMs: number;
}

/** Registry snapshot per tick: entries plus the `snapshotVersion` hash. */
export interface RegistrySnapshot {
	entries: RegistryEntry[];
	version: string;
}

/** Channel key for one row (null excludes it); parameterised per H2. */
export type GroupKey = (message: BusMessage) => string | null;

/** Default key: directs collect, machine broadcasts collect, project rows per-project. */
export function defaultGroupKey(message: BusMessage): string | null {
	const scope = scopeOf(message);
	if (scope === "direct") return "direct";
	if (scope === "broadcast") return "broadcast";
	return `project:${message.targetProject}`;
}

/** Delivery channels: broadcast-collect + per-project dict (+ direct-collect). */
export type ChannelGroups = Record<string, BusMessage[]>;

/**
 * Group one read's inbox rows into channels. `projectId` is the per-read
 * resolved project: null (project-less) keeps directs only — parity with the
 * store's readAddressed, which never selects project/broadcast rows w/o one.
 */
export function groupByScope(messages: BusMessage[], projectId: string | null, groupKey: GroupKey = defaultGroupKey): ChannelGroups {
	const channels: ChannelGroups = {};
	for (const message of messages) {
		if (projectId === null && scopeOf(message) !== "direct") continue;
		const key = groupKey(message);
		if (key === null) continue;
		(channels[key] ??= []).push(message);
	}
	return channels;
}

/** Cached channels: rebuilt only when the snapshot `version` differs. */
export interface ChannelCache {
	version: string;
	channels: ChannelGroups;
}

/**
 * Version-gated rebuild: same version returns the previous cache object
 * itself (===, `compute` untouched); a bumped version recomputes. Explicit
 * prev-in/cache-out — no module state, so the module stays house-pure.
 */
export function buildChannelCache(prev: ChannelCache | null, snapshot: { version: string }, compute: () => ChannelGroups): ChannelCache {
	if (prev !== null && prev.version === snapshot.version) return prev;
	return { version: snapshot.version, channels: compute() };
}

/** Snapshot version hash: max(lastSeenMs)+count — a clock bump or a membership change both move it. */
export function snapshotVersion(entries: Array<Pick<RegistryEntry, "lastSeenMs">>): string {
	let max = 0;
	for (const e of entries) if (e.lastSeenMs > max) max = e.lastSeenMs;
	return `${max}:${entries.length}`;
}
