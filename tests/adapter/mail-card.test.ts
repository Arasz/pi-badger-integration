/**
 * Adapter `ai-badger` mail card (mail as JSON envelope, not raw JSON).
 *
 * The python delivery prints each mail as a JSON envelope string
 * ({sender: {sessionId, projectId}, content, timestamp}) and the adapter's
 * wake path forwards it verbatim as the message content. pi renders custom
 * types with no renderer as `[ai-badger]` + the raw string — every alive
 * session staring at JSON. The renderer registered here turns the envelope
 * into head (sender short id + timestamp) + body; plain strings pass through
 * like the message-bus-event card; empty/non-string content renders nothing.
 */
import { describe, expect, test } from "bun:test";
import adapterFactory from "../../features/pi/adjustments/adapter/index.ts";
import { AI_BADGER_CUSTOM_TYPE } from "../../features/pi/adjustments/adapter/hook-bridge.ts";
import { splitMailCard } from "../../features/pi/adjustments/adapter/hook-bridge.ts";
import { createFakePi } from "../helpers/fake-pi.ts";

const ENVELOPE = JSON.stringify({
	sender: { sessionId: "01a0737e-11cd-75a0-a693-f981c37ddced", projectId: "b0e32c16-f502-4896-9b97-0bbee0fb321d" },
	content: "ack: [jsaa] merged: #1098 to main — rebase your lanes.",
	timestamp: "2026-09-05T21:52:10.731Z",
});

const theme = {
	fg: (_tone: unknown, text: unknown) => String(text),
	bg: (_slot: unknown, line: string) => line,
};
const options = { outputPad: 2 };

describe("splitMailCard (pure)", () => {
	test("envelope JSON splits into sender-short head plus inner body", () => {
		const split = splitMailCard(ENVELOPE);
		expect(split).toBeDefined();
		expect(split!.head).toContain("01a0737e");
		expect(split!.head).toContain("2026-09-05T21:52:10.731Z");
		expect(split!.body).toContain("rebase your lanes");
		expect(split!.body).not.toContain("sessionId");
	});
	test("plain strings pass through with no head", () => {
		const split = splitMailCard("ai-badger: message bus probe failed, delivery spawned anyway");
		expect(split).toEqual({ head: null, body: "ai-badger: message bus probe failed, delivery spawned anyway" });
	});
	test("garbage JSON passes through, never throws", () => {
		const split = splitMailCard("{[not json");
		expect(split).toEqual({ head: null, body: "{[not json" });
	});
	test("empty, blank and non-string content split to nothing", () => {
		expect(splitMailCard("")).toBeUndefined();
		expect(splitMailCard("   \n ")).toBeUndefined();
		expect(splitMailCard(null)).toBeUndefined();
		expect(splitMailCard(undefined)).toBeUndefined();
		expect(splitMailCard({ nope: true })).toBeUndefined();
	});
	test("envelope-shaped object (not just its JSON string) splits the same way", () => {
		const split = splitMailCard(JSON.parse(ENVELOPE));
		expect(split!.head).toContain("01a0737e");
		expect(split!.body).toContain("rebase your lanes");
	});
	test("envelope without usable inner content splits to nothing; other JSON passes through", () => {
		expect(splitMailCard(JSON.stringify({ sender: { sessionId: "x" } }))).toBeUndefined();
		expect(splitMailCard(JSON.stringify({ content: 42 }))).toEqual({ head: null, body: JSON.stringify({ content: 42 }) });
	});
});

describe("ai-badger renderer registration + behavior", () => {
	test("the factory registers the ai-badger renderer", async () => {
		const pi = createFakePi();
		await adapterFactory(pi as never);
		expect(pi.renderers.has(AI_BADGER_CUSTOM_TYPE)).toBe(true);
	});

	test("envelope and plain strings render a card; empty renders nothing, garbage never throws", async () => {
		const pi = createFakePi();
		await adapterFactory(pi as never);
		const render = pi.renderers.get(AI_BADGER_CUSTOM_TYPE)!;
		expect(render({ content: ENVELOPE } as never, options as never, theme as never)).toBeDefined();
		expect(render({ content: "plain notice line" } as never, options as never, theme as never)).toBeDefined();
		expect(render({ content: "{[not json" } as never, options as never, theme as never)).toBeDefined();
		expect(render({ content: "" } as never, options as never, theme as never)).toBeUndefined();
		expect(render({ content: null } as never, options as never, theme as never)).toBeUndefined();
	});
});
