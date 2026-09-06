import { describe, expect, test } from "bun:test";
import {
	ACK_PREFIX,
	buildAckContent,
	buildDirectStartQuestion,
	composeDeliveryNotice,
	composeDirectStartNotice,
	filterDirect,
	formatList,
	groupLastPerScope,
	isAck,
	normalizeSendTargets,
	scopeOf,
	type BusMessage,
} from "../../extensions/message-bus/message-bus-core.ts";

const msg = (over: Partial<BusMessage> & { id: number }): BusMessage => ({
	senderSession: "s-other",
	senderProject: "p1",
	targetSession: null,
	targetProject: null,
	content: "hello",
	timestamp: "2026-09-05T00:00:00.000Z",
	...over,
});

describe("scopeOf", () => {
	test("1:1 row is direct", () => {
		expect(scopeOf(msg({ id: 1, targetSession: "s-me", targetProject: "p1" }))).toBe("direct");
	});
	test("session-wins: session set means direct even with project set", () => {
		expect(scopeOf(msg({ id: 1, targetSession: "s-me", targetProject: "p1" }))).toBe("direct");
	});
	test("project row is project", () => {
		expect(scopeOf(msg({ id: 2, targetSession: null, targetProject: "p1" }))).toBe("project");
	});
	test("both-targets-NULL is broadcast", () => {
		expect(scopeOf(msg({ id: 3, targetSession: null, targetProject: null }))).toBe("broadcast");
	});
});

describe("normalizeSendTargets", () => {
	test("session wins over project", () => {
		expect(normalizeSendTargets("s1", "p1")).toEqual({ targetSession: "s1", targetProject: null });
	});
	test("project-only is project broadcast", () => {
		expect(normalizeSendTargets(undefined, "p1")).toEqual({ targetSession: null, targetProject: "p1" });
	});
	test("neither is machine broadcast", () => {
		expect(normalizeSendTargets(undefined, undefined)).toEqual({ targetSession: null, targetProject: null });
	});
	test("blank strings read as unset", () => {
		expect(normalizeSendTargets("  ", " ")).toEqual({ targetSession: null, targetProject: null });
	});
});

describe("ack discipline", () => {
	test("isAck matches ack: prefix case-insensitively", () => {
		expect(isAck("ack: [t] done")).toBe(true);
		expect(isAck("ACK: [t] done")).toBe(true);
		expect(isAck("  ack: x")).toBe(true);
		expect(isAck("acknowledged")).toBe(false);
		expect(isAck("done")).toBe(false);
	});
	test("buildAckContent wraps original once", () => {
		expect(buildAckContent(msg({ id: 1, content: "[t] starting: x" }))).toBe("ack: [t] starting: x");
	});
	test("buildAckContent refuses an ack (no reply to ack)", () => {
		expect(buildAckContent(msg({ id: 2, content: "ack: [t] starting: x" }))).toBeUndefined();
	});
	test("buildAckContent caps long content", () => {
		const long = "x".repeat(5000);
		const ack = buildAckContent(msg({ id: 3, content: long }))!;
		expect(ack.startsWith("ack: ")).toBe(true);
		expect(ack.length).toBeLessThanOrEqual(2048);
	});
});

describe("groupLastPerScope", () => {
	test("last 3 per scope, oldest-first within group", () => {
		const all = [
			msg({ id: 1, targetSession: "s-me" }),
			msg({ id: 2, targetSession: "s-me" }),
			msg({ id: 3, targetSession: "s-me" }),
			msg({ id: 4, targetSession: "s-me" }),
			msg({ id: 10, targetSession: null, targetProject: "p1" }),
			msg({ id: 20 }),
		];
		const g = groupLastPerScope(all, 3);
		expect(g.direct.map((m) => m.id)).toEqual([2, 3, 4]);
		expect(g.project.map((m) => m.id)).toEqual([10]);
		expect(g.broadcast.map((m) => m.id)).toEqual([20]);
	});
	test("empty input groups empty", () => {
		expect(groupLastPerScope([], 3)).toEqual({ direct: [], project: [], broadcast: [] });
	});
});

describe("formatList", () => {
	test("groups with headers, received marks, no raw JSON", () => {
		const all = [
			msg({ id: 1, targetSession: "s-me", content: "one" }),
			msg({ id: 2, targetSession: null, targetProject: "p1", content: "two" }),
			msg({ id: 3, content: "three" }),
		];
		const text = formatList(all, 0, 3);
		expect(text).toContain("direct");
		expect(text).toContain("project");
		expect(text).toContain("broadcast");
		expect(text).toContain("one");
		expect(text).not.toContain('"target_session"');
		expect(text).not.toContain('"content"');
		// cursor 0 → everything is new
		expect(text).toContain("●");
	});
	test("delivered rows marked received", () => {
		const all = [msg({ id: 1, targetSession: "s-me", content: "one" })];
		const text = formatList(all, 1, 3);
		expect(text).toContain("✓");
	});
	test("empty inbox states so", () => {
		expect(formatList([], 0, 3)).toMatch(/no messages/i);
	});
});

describe("composeDeliveryNotice", () => {
	test("names counts, empty states silent-shape", () => {
		const notice = composeDeliveryNotice([msg({ id: 1, targetSession: "s-me" }), msg({ id: 2 })]);
		expect(notice).toContain("1");
		const empty = composeDeliveryNotice([]);
		expect(empty).toBe("");
	});
});

describe("startup direct gate", () => {
	test("filterDirect keeps only 1:1 rows", () => {
		const all = [
			msg({ id: 1, targetSession: "s-me", content: "one" }),
			msg({ id: 2, targetSession: null, targetProject: "p1", content: "two" }),
			msg({ id: 3, content: "three" }),
		];
		expect(filterDirect(all).map((m) => m.id)).toEqual([1]);
	});
	test("composeDirectStartNotice names private count, skips broadcasts", () => {
		const notice = composeDirectStartNotice([
			msg({ id: 1, targetSession: "s-me", content: "one" }),
			msg({ id: 2, targetSession: null, targetProject: "p1", content: "two" }),
			msg({ id: 3, content: "three" }),
		]);
		expect(notice).toContain("1 private");
		expect(notice).toContain("one");
		expect(notice).not.toContain("two");
		expect(notice).not.toContain("three");
		expect(notice).toMatch(/broadcasts skipped/i);
	});
	test("composeDirectStartNotice empty states silent-shape", () => {
		expect(composeDirectStartNotice([])).toBe("");
		expect(composeDirectStartNotice([msg({ id: 2, targetSession: null, targetProject: "p1" })])).toBe("");
	});
	test("buildDirectStartQuestion matches the user-decision wording", () => {
		expect(buildDirectStartQuestion(1)).toBe("agent got 1 private message, do you want to act on them?");
		expect(buildDirectStartQuestion(3)).toBe("agent got 3 private messages, do you want to act on them?");
	});
});

describe("ACK_PREFIX", () => {
	test("is the ack: prefix", () => {
		expect(ACK_PREFIX).toBe("ack:");
	});
});
