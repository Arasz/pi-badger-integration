import { describe, expect, test } from "bun:test";
import {
	buildChannelCache,
	defaultGroupKey,
	groupByScope,
	type ChannelCache,
	type RegistrySnapshot,
} from "../../extensions/message-bus/coordinator-group.ts";
import { registryVersion } from "../../extensions/message-bus/message-bus-core.ts";
import type { BusMessage } from "../../extensions/message-bus/message-bus-core.ts";

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

const entry = (over: { sessionId?: string; projectId?: string | null; lastSeenMs?: number } = {}) => ({
	sessionId: "s-1",
	projectId: "p1" as string | null,
	lastSeenMs: 1000,
	...over,
});

describe("groupByScope", () => {
	test("AC1: mixed inbox groups into broadcast-collect + per-project dict keyed on per-read projectId", () => {
		const inbox = [
			msg({ id: 1, targetSession: "s-me", targetProject: null, content: "dm" }),
			msg({ id: 2, targetSession: "s-me", targetProject: "p1", content: "session-wins dm" }),
			msg({ id: 3, targetSession: null, targetProject: "p1", content: "proj" }),
			msg({ id: 4, targetSession: null, targetProject: null, content: "machine" }),
		];
		const channels = groupByScope(inbox, "p1");
		expect(channels["direct"]?.map((m) => m.id)).toEqual([1, 2]);
		expect(channels["project:p1"]?.map((m) => m.id)).toEqual([3]);
		expect(channels["broadcast"]?.map((m) => m.id)).toEqual([4]);
	});

	test("AC2: project-less session (projectId null) groups directs only — readAddressed parity", () => {
		const inbox = [
			msg({ id: 1, targetSession: "s-me", targetProject: null, content: "dm" }),
			msg({ id: 2, targetSession: null, targetProject: "p1", content: "proj" }),
			msg({ id: 3, targetSession: null, targetProject: null, content: "machine" }),
		];
		const channels = groupByScope(inbox, null);
		expect(channels["direct"]?.map((m) => m.id)).toEqual([1]);
		expect(Object.values(channels).flat().map((m) => m.id)).toEqual([1]);
	});

	test("defaultGroupKey: direct collect, broadcast collect, per-project namespaced keys", () => {
		expect(defaultGroupKey(msg({ id: 1, targetSession: "s-me" }))).toBe("direct");
		expect(defaultGroupKey(msg({ id: 2 }))).toBe("broadcast");
		expect(defaultGroupKey(msg({ id: 3, targetSession: null, targetProject: "p9" }))).toBe("project:p9");
	});

	test("SHAPE-PLACEHOLDER (SPIKE-S2): per-session granularity variant via a custom groupKey — if the transport spike reshapes channels per session, THIS test must break loudly and be rewritten, not patched", () => {
		const perSessionKey = (m: BusMessage): string | null => {
			if (m.targetSession !== null) return `direct:${m.targetSession}`;
			if (m.targetProject !== null) return `project:${m.targetProject}`;
			return "broadcast";
		};
		const inbox = [
			msg({ id: 1, targetSession: "s-a", content: "dm a" }),
			msg({ id: 2, targetSession: "s-b", content: "dm b" }),
			msg({ id: 3, targetSession: null, targetProject: "p1", content: "proj" }),
		];
		const channels = groupByScope(inbox, "p1", perSessionKey);
		expect(Object.keys(channels).sort()).toEqual(["direct:s-a", "direct:s-b", "project:p1"]);
		expect(channels["direct:s-a"]?.map((m) => m.id)).toEqual([1]);
	});
});

describe("registryVersion", () => {
	test("SWAP-PIN: membership swap with same max+count must move the version (else the channel cache aliases)", () => {
		const a = [entry({ sessionId: "s-1", lastSeenMs: 1000 })];
		const b = [entry({ sessionId: "s-2", lastSeenMs: 1000 })];
		expect(registryVersion(b)).not.toBe(registryVersion(a));
		let calls = 0;
		const prev = buildChannelCache(null, { version: registryVersion(a) }, () => {
			calls++;
			return {};
		});
		const next = buildChannelCache(prev, { version: registryVersion(b) }, () => {
			calls++;
			return {};
		});
		expect(next).not.toBe(prev);
		expect(calls).toBe(2);
	});

	test("version is max(lastSeenMs):count:identity-hash", () => {
		expect(registryVersion([entry({ lastSeenMs: 100 }), entry({ lastSeenMs: 300 }), entry({ lastSeenMs: 200 })])).toMatch(/^300:3:[0-9a-f]{8}$/);
	});

	test("empty snapshot versions as zero", () => {
		expect(registryVersion([])).toMatch(/^0:0:[0-9a-f]{8}$/);
	});

	test("count change alone bumps the version", () => {
		expect(registryVersion([entry()])).not.toBe(registryVersion([entry(), entry({ sessionId: "s-2" })]));
	});
});

describe("buildChannelCache", () => {
	test("AC3: same snapshot version returns identical cached object with no recompute; bumped version recomputes", () => {
		const snapshot: RegistrySnapshot = { entries: [entry()], version: registryVersion([entry()]) };
		let calls = 0;
		const compute = () => {
			calls++;
			return groupByScope([], "p1");
		};
		const first: ChannelCache = buildChannelCache(null, snapshot, compute);
		expect(calls).toBe(1);
		const second: ChannelCache = buildChannelCache(first, snapshot, compute);
		expect(second).toBe(first);
		expect(calls).toBe(1);
		const bumped: RegistrySnapshot = {
			entries: [entry(), entry({ sessionId: "s-2", lastSeenMs: 2000 })],
			version: registryVersion([entry(), entry({ sessionId: "s-2", lastSeenMs: 2000 })]),
		};
		expect(bumped.version).not.toBe(snapshot.version);
		const third: ChannelCache = buildChannelCache(second, bumped, compute);
		expect(third).not.toBe(second);
		expect(third.version).toBe(bumped.version);
		expect(calls).toBe(2);
	});
});
