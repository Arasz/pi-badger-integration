/**
 * P2 durable delivery + ack (RED-first lane, on top of committed P1 `31e4e51`).
 *
 * The finding (verified before fixing — see the M3/triggerTurn note below):
 * /ask surfaces ONLY via `ctx.ui.notify`, whose getter can throw stale
 * (`runner.assertActive`, extensions/runner.js `get ui()`), with the throw
 * swallowed by the handler's try/catch wrapper — notify executes yet the user
 * sees nothing. P2 adds a second channel that never routes through `ctx.ui`:
 * a `pi.sendMessage` custom card from the factory closure (`pi`), plus an
 * immediate ack notify on accepted queries.
 *
 * M3 triggerTurn choice (pinned by "success pins triggerTurn explicitly" +
 * "loop-freedom"): subagent's `{deliverAs:"followUp",triggerTurn:true}`
 * precedent fires in the STREAMING context (tool result mid-turn — followUp
 * queues behind the running turn). /ask runs in `prompt()`'s commands-first
 * IDLE branch (agent-session `prompt()` → `_tryExecuteExtensionCommand`,
 * returns with no turn started), so `triggerTurn:true` there would start a
 * FRESH parent LLM turn per answer (cost + behavior change). P2 cards are
 * therefore append-only: `{ triggerTurn: false }`, no `deliverAs`
 * (`deliverAs` only places streaming-queue messages; idle has no queue).
 * Loop-freedom at handler level: cards are `role:"custom"` (customType set,
 * never user text), commands dispatch only from `/`-prefixed user input, and
 * no input-queue seeding happens after a card (fake-pi has no streaming
 * concept, so no full router simulation — the pins below are the evidence:
 * every sent message carries the ASK customType and triggerTurn:false).
 *
 * Emission contract (thin-skip = notify-only; answers/failures = card
 * (+notify per counts) — P1's H1 exactly-once pin must keep passing):
 *   success / bank-error / no-hits / child-exit≠0 / spawn-reject / no-answer
 *     → 2 notifies (ack info + terminal) + 1 card
 *   thin-skip / mode-off / no-project-id / no-session-id
 *     → 1 notify + 0 cards (no ack — query never accepted)
 *   abort (shutdown mid-spawn) → ack only (pre-shutdown), 0 cards,
 *     0 post-shutdown notifies
 */
import { describe, expect, test, afterEach } from "bun:test";
import { createFakePi, type FakePi } from "../helpers/fake-pi.ts";
import factory from "../../extensions/mem-based-rag/index.ts";
import * as memRag from "../../extensions/mem-based-rag/index.ts";

/** New P2 export; undefined pre-implementation so every pin below REDs first. */
const ASK_CUSTOM_TYPE: string | undefined = (memRag as unknown as Record<string, unknown>)[
	"ASK_CUSTOM_TYPE"
] as string | undefined;

// ------------------------------------------------------------------ env hygiene

const RAG_KEYS = [
	"PI_BADGER_MEM_RAG",
	"PI_BADGER_MEM_RAG_MODE",
	"PI_BADGER_MEM_RAG_MIN_WORDS",
	"PI_BADGER_MEM_RAG_MIN_CHARS",
	"PI_BADGER_MEM_RAG_TIMEOUT_MS",
	"PI_BADGER_MEM_RAG_ASK_CHILD_TIMEOUT_MS",
	"PI_BADGER_MEM_RAG_SNIPPET_CHARS",
	"PI_BADGER_MEM_RAG_BIN",
	"AI_BADGER_PROJECT_ID",
] as const;

const ORIG_ENV: Record<string, string | undefined> = {};
for (const k of RAG_KEYS) ORIG_ENV[k] = process.env[k];

afterEach(() => {
	for (const k of RAG_KEYS) {
		const v = ORIG_ENV[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function clearRagEnv(): void {
	for (const k of RAG_KEYS) delete process.env[k];
}

// ------------------------------------------------------------------ helpers

interface Notify {
	message: string;
	type: string;
}

const P1 = "explain how delegation timeout interacts with slow CI runners tomorrow morning please";
const MEM_HITS = [
	{ hash: "m1", ranking: 1, path: "shared/a.md", snippet: "first memory snippet about delegation" },
	{ hash: "m2", ranking: 0.9, path: "shared/b.md", snippet: "second memory snippet about timeouts" },
];
const CODE_HITS = [{ hash: "c1", ranking: 1, path: "src/a.ts", snippet: "some code snippet", lineStart: 10, lineEnd: 20 }];

function jsonlAnswer(text: string): string {
	return [
		JSON.stringify({ type: "session", id: "sess-ask" }),
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		}),
	].join("\n");
}

function never<T = string>(): Promise<T> {
	return new Promise<T>(() => {});
}

interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

function installAsk(opts: {
	search?: (tool: string) => Promise<string>;
	spawn?: (cmd: string, argv: string[], o: { cwd: string; timeoutMs: number }) => Promise<SpawnResult>;
}): { pi: FakePi; spawnCalls: Array<{ cmd: string; argv: string[]; opts: { cwd: string; timeoutMs: number } }> } {
	const pi = createFakePi();
	const spawnCalls: Array<{ cmd: string; argv: string[]; opts: { cwd: string; timeoutMs: number } }> = [];
	const search =
		opts.search ??
		(async (): Promise<string> => JSON.stringify({ data: { results: MEM_HITS, code: CODE_HITS } }));
	const spawnImpl =
		opts.spawn ??
		(async (): Promise<SpawnResult> => ({ stdout: jsonlAnswer("default canned answer"), stderr: "", exitCode: 0 }));
	const spawn = async (
		cmd: string,
		argv: string[],
		o: { cwd: string; timeoutMs: number },
	): Promise<SpawnResult> => {
		spawnCalls.push({ cmd, argv, opts: o });
		return spawnImpl(cmd, argv, o);
	};
	(factory as (pi: unknown, deps: unknown) => void)(pi as never, {
		createClient: () => ({ call: search, stop: () => {} }),
		spawnAsk: spawn,
	});
	return { pi, spawnCalls };
}

function makeAskCtx(cwd: string, sessionId: string, notes: Notify[]) {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string, type: string) => notes.push({ message, type }) },
	};
}

/** Dead-notify variant A: every `ctx.ui` access throws stale (assertActive). */
function makeThrowingUiCtx(cwd: string, sessionId: string, attempts: { count: number }) {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		get ui(): never {
			attempts.count += 1;
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	};
}

/** Dead-notify variant B: no ui surface at all — `?.` short-circuits silently. */
function makeNoUiCtx(cwd: string, sessionId: string) {
	return { cwd, sessionManager: { getSessionId: () => sessionId }, ui: undefined };
}

async function fireAsk(pi: FakePi, args: string, ctx: unknown): Promise<unknown> {
	const cmd = pi.commands.get("ask") as unknown as {
		handler: (args: string, ctx: unknown) => Promise<unknown>;
	};
	expect(cmd).toBeDefined();
	return cmd.handler(args, ctx as never);
}

const themeStub = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };

function renderAsk(pi: FakePi, message: unknown, theme: unknown): unknown {
	const renderer = pi.renderers.get(ASK_CUSTOM_TYPE as string);
	expect(renderer).toBeDefined();
	return (renderer as (m: unknown, o: unknown, t: unknown) => unknown)(
		message,
		{ outputPad: 0, expanded: false },
		theme,
	);
}

function renderedText(component: unknown): string {
	if (component === undefined || component === null) return "";
	const maybe = component as { render?: (width: number) => string[] };
	if (typeof maybe?.render === "function") return maybe.render(100).join("\n");
	return String(component);
}

// ------------------------------------------------------------------ AC1/M3 counts + triggerTurn + loop-freedom

describe("P2 AC1/M3 emission counts + explicit triggerTurn + loop-freedom", () => {
	test("success pins triggerTurn explicitly: 2 notifies (ack→answer) + 1 append-only card", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-counts-ok";
		const answer = "the durable isolated answer about delegation timeouts";
		const { pi } = installAsk({
			spawn: async () => ({ stdout: jsonlAnswer(answer), stderr: "", exitCode: 0 }),
		});
		const notes: Notify[] = [];
		const result = await fireAsk(pi, P1, makeAskCtx("/tmp/p2-ok", "sess-p2-ok", notes));
		expect(result).toBe(notes[notes.length - 1]!.message);
		// Exact counts: ack + answer notify, one card.
		expect(notes).toHaveLength(2);
		expect(notes[0]!.type).toBe("info");
		expect(notes[1]!.type).toBe("info");
		expect(notes[1]!.message).toContain(answer);
		expect(pi.sent).toHaveLength(1);
		// triggerTurn pinned EXPLICITLY append-only (never subagent's true).
		expect(pi.sent[0]!.options).toEqual({ triggerTurn: false });
		expect(pi.sent[0]!.message.customType).toBe(ASK_CUSTOM_TYPE);
		expect(pi.sent[0]!.message.display).toBe(true);
		expect(String(pi.sent[0]!.message.content)).toContain(answer);
		expect((pi.sent[0]!.message.details as Record<string, unknown>)["kind"]).toBe("answer");
		expect((pi.sent[0]!.message.details as Record<string, unknown>)["query"]).toBe(P1);
		// Loop-freedom at handler level: every emission is a custom card —
		// never user text, so nothing re-dispatches a command or seeds input.
		for (const s of pi.sent) expect(s.message.customType).toBe(ASK_CUSTOM_TYPE);
	});

	test("per-path counts: failures/skips after acceptance are 2 notifies + 1 card", async () => {
		const cases: Array<{
			name: string;
			search?: (tool: string) => Promise<string>;
			spawn?: (cmd: string, argv: string[], o: { cwd: string; timeoutMs: number }) => Promise<SpawnResult>;
			notifyTypes: [string, string];
			cardContains: string;
			cardKind: string;
		}> = [
			{
				name: "bank-error",
				search: async (tool: string): Promise<string> => {
					if (tool === "memory_search") throw new Error("bank exploded");
					return JSON.stringify({ data: {} });
				},
				notifyTypes: ["info", "info"],
				cardContains: "bank error",
				cardKind: "skip",
			},
			{
				name: "no-hits",
				search: async (): Promise<string> => JSON.stringify({ data: { results: [], code: [] } }),
				notifyTypes: ["info", "info"],
				cardContains: "no-hits",
				cardKind: "skip",
			},
			{
				name: "child-exit-1",
				spawn: async () => ({ stdout: jsonlAnswer("partial"), stderr: "boom", exitCode: 1 }),
				notifyTypes: ["info", "warning"],
				cardContains: "exit 1",
				cardKind: "failure",
			},
			{
				name: "spawn-reject",
				spawn: async (): Promise<SpawnResult> => {
					throw new Error("ask child timed out after 500ms");
				},
				notifyTypes: ["info", "warning"],
				cardContains: "timed out",
				cardKind: "failure",
			},
			{
				name: "no-answer",
				spawn: async () => ({ stdout: "not json\n", stderr: "", exitCode: 0 }),
				notifyTypes: ["info", "info"],
				cardContains: "no answer from child",
				cardKind: "skip",
			},
		];
		for (const c of cases) {
			clearRagEnv();
			process.env["AI_BADGER_PROJECT_ID"] = `proj-p2-counts-${c.name}`;
			const { pi } = installAsk({ ...(c.search ? { search: c.search } : {}), ...(c.spawn ? { spawn: c.spawn } : {}) });
			const notes: Notify[] = [];
			let threw = false;
			try {
				await fireAsk(pi, P1, makeAskCtx(`/tmp/p2-${c.name}`, `sess-p2-${c.name}`, notes));
			} catch {
				threw = true;
			}
			expect(threw, c.name).toBe(false);
			expect(notes.map((n) => n.type), c.name).toEqual(c.notifyTypes);
			expect(pi.sent, c.name).toHaveLength(1);
			expect(pi.sent[0]!.options, c.name).toEqual({ triggerTurn: false });
			expect(pi.sent[0]!.message.customType, c.name).toBe(ASK_CUSTOM_TYPE);
			expect(String(pi.sent[0]!.message.content), c.name).toContain(c.cardContains);
			expect((pi.sent[0]!.message.details as Record<string, unknown>)["kind"], c.name).toBe(c.cardKind);
		}
	});

	test("thin-skip stays NOTIFY-ONLY: exactly 1 notify, 0 cards, no ack (P1 H1 compat)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-thin";
		const { pi } = installAsk({});
		const notes: Notify[] = [];
		const result = await fireAsk(pi, "hi", makeAskCtx("/tmp/p2-thin", "sess-p2-thin", notes));
		expect(result).toBeUndefined();
		expect(notes).toHaveLength(1);
		expect(notes[0]!.message).toContain("too-short");
		expect(notes[0]!.type).toBe("info");
		expect(pi.sent).toHaveLength(0);
	});

	test("pre-acceptance skips stay NOTIFY-ONLY: mode-off / no-project / no-session → 1 notify, 0 cards", async () => {
		// mode off
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-pre-off";
		{
			const { pi } = installAsk({});
			const rag = pi.commands.get("rag") as unknown as {
				handler: (args: string, ctx: unknown) => Promise<void>;
			};
			await rag.handler("mode off", makeAskCtx("/tmp/p2-pre", "sess-p2-pre", []) as never);
			const notes: Notify[] = [];
			await fireAsk(pi, P1, makeAskCtx("/tmp/p2-pre", "sess-p2-pre", notes));
			expect(notes).toHaveLength(1);
			expect(pi.sent).toHaveLength(0);
		}
		// no project id
		clearRagEnv();
		{
			const { pi } = installAsk({});
			const notes: Notify[] = [];
			await fireAsk(pi, P1, makeAskCtx("/tmp/p2-pre-noproj-zzz", "sess-p2-pre", notes));
			expect(notes).toHaveLength(1);
			expect(notes[0]!.message).toContain("no project id");
			expect(pi.sent).toHaveLength(0);
		}
		// no session id
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-pre-nosess";
		{
			const { pi } = installAsk({});
			const notes: Notify[] = [];
			await fireAsk(pi, P1, makeAskCtx("/tmp/p2-pre", "", notes));
			expect(notes).toHaveLength(1);
			expect(notes[0]!.message).toContain("no session id");
			expect(pi.sent).toHaveLength(0);
		}
	});
});

// ------------------------------------------------------------------ AC2/H2 durable with notify dead

describe("P2 AC2/H2 durable delivery with notify dead", () => {
	test("throwing ctx.ui getter: success answer STILL surfaces via card (RED first: zero notify calls yet card present)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-h2-throw";
		const answer = "durable answer tail surviving dead notify";
		const { pi } = installAsk({
			spawn: async () => ({ stdout: jsonlAnswer(answer), stderr: "", exitCode: 0 }),
		});
		const attempts = { count: 0 };
		let threw = false;
		let result: unknown = "sentinel";
		try {
			result = await fireAsk(pi, P1, makeThrowingUiCtx("/tmp/p2-h2", "sess-p2-h2", attempts));
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).toBe(answer);
		// Every notify attempt died inside the swallowing wrapper…
		expect(attempts.count).toBeGreaterThanOrEqual(2);
		// …yet the card is present, exactly once, append-only, with the tail.
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.options).toEqual({ triggerTurn: false });
		expect(pi.sent[0]!.message.customType).toBe(ASK_CUSTOM_TYPE);
		expect(String(pi.sent[0]!.message.content)).toContain(answer);
	});

	test("ui: undefined ctx: success answer STILL surfaces via card, no throw", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-h2-noui";
		const answer = "durable answer tail with no ui surface";
		const { pi } = installAsk({
			spawn: async () => ({ stdout: jsonlAnswer(answer), stderr: "", exitCode: 0 }),
		});
		let threw = false;
		try {
			await fireAsk(pi, P1, makeNoUiCtx("/tmp/p2-h2n", "sess-p2-h2n"));
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.options).toEqual({ triggerTurn: false });
		expect(String(pi.sent[0]!.message.content)).toContain(answer);
	});

	test("bank-error + no-hits likewise durable with notify dead", async () => {
		for (const [name, search, needle] of [
			[
				"bank-error",
				async (tool: string): Promise<string> => {
					if (tool === "memory_search") throw new Error("bank exploded");
					return JSON.stringify({ data: {} });
				},
				"bank error",
			],
			["no-hits", async (): Promise<string> => JSON.stringify({ data: { results: [], code: [] } }), "no-hits"],
		] as const) {
			clearRagEnv();
			process.env["AI_BADGER_PROJECT_ID"] = `proj-p2-h2-${name}`;
			const { pi } = installAsk({ search });
			const attempts = { count: 0 };
			let threw = false;
			try {
				await fireAsk(pi, P1, makeThrowingUiCtx(`/tmp/p2-h2-${name}`, `sess-p2-h2-${name}`, attempts));
			} catch {
				threw = true;
			}
			expect(threw, name).toBe(false);
			expect(pi.sent, name).toHaveLength(1);
			expect(pi.sent[0]!.options, name).toEqual({ triggerTurn: false });
			expect(String(pi.sent[0]!.message.content), name).toContain(needle);
		}
	});

	test("thin-skip with notify dead sends NO card (notify-only forever, P1 M5)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-h2-thin";
		const { pi } = installAsk({});
		const attempts = { count: 0 };
		let threw = false;
		try {
			await fireAsk(pi, "hi", makeThrowingUiCtx("/tmp/p2-h2t", "sess-p2-h2t", attempts));
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(attempts.count).toBe(1);
		expect(pi.sent).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ AC3/H4 ack

describe("P2 AC3/H4 immediate ack", () => {
	test("accepted query emits ack notify naming query + budget BEFORE first await (hung spawn: ack present while result pending)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-h4";
		// SHOULD-1 needs a sleepable budget: 500ms (P1 precedent) instead of the
		// 90s child default, so the post-shutdown stray-emission wait stays ~1s.
		process.env["PI_BADGER_MEM_RAG_ASK_CHILD_TIMEOUT_MS"] = "500";
		const { pi, spawnCalls } = installAsk({ spawn: async (): Promise<SpawnResult> => never() });
		const notes: Notify[] = [];
		const pending = fireAsk(pi, P1, makeAskCtx("/tmp/p2-h4", "sess-p2-h4", notes));
		const deadline = Date.now() + 5000;
		while (spawnCalls.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(spawnCalls).toHaveLength(1);
		// Result still pending (hung spawn) — but the ack is already here.
		expect(notes).toHaveLength(1);
		expect(notes[0]!.type).toBe("info");
		expect(notes[0]!.message).toContain(P1);
		expect(notes[0]!.message).toContain("500");
		expect(pi.sent).toHaveLength(0);
		// Cleanup: shutdown settles the hung turn with no further emissions.
		await fireSession(pi, "session_shutdown");
		await pending;
		expect(notes).toHaveLength(1);
		expect(pi.sent).toHaveLength(0);
		// SHOULD-1: outlive the orphaned askSettle budget (500ms) — a delayed
		// stray finish would land here; re-assert post-shutdown silence.
		await new Promise((r) => setTimeout(r, 1200));
		expect(notes).toHaveLength(1);
		expect(pi.sent).toHaveLength(0);
	}, 10_000);

	test("order pin: ack precedes the terminal answer notify", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-h4-order";
		const answer = "ordered answer after ack";
		const { pi } = installAsk({
			spawn: async () => ({ stdout: jsonlAnswer(answer), stderr: "", exitCode: 0 }),
		});
		const notes: Notify[] = [];
		await fireAsk(pi, P1, makeAskCtx("/tmp/p2-h4o", "sess-p2-h4o", notes));
		expect(notes).toHaveLength(2);
		expect(notes[0]!.message).toContain(P1);
		expect(notes[0]!.message).not.toContain(answer);
		expect(notes[1]!.message).toContain(answer);
	});
});

async function fireSession(pi: FakePi, event: "session_start" | "session_shutdown"): Promise<void> {
	for (const h of pi.handlers.get(event) ?? []) {
		await (h as (e: unknown, c: unknown) => unknown)({}, { cwd: "/tmp/p2", sessionManager: { getSessionId: () => "s" } });
	}
}

// ------------------------------------------------------------------ AC4/M4 /rag bare notify

describe("P2 AC4/M4 throwing-ui scope", () => {
	test("/rag status with throwing ctx.ui getter does not throw (RED-forced wrap)", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-m4";
		const { pi } = installAsk({});
		const rag = pi.commands.get("rag") as unknown as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		expect(rag).toBeDefined();
		const attempts = { count: 0 };
		let threw = false;
		try {
			await rag.handler("status", makeThrowingUiCtx("/tmp/p2-m4", "sess-p2-m4", attempts) as never);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(attempts.count).toBe(1);
	});
});

// ------------------------------------------------------------------ AC5/S1 renderer + S2 fallback

describe("P2 AC5/S1 ask card renderer (never toCardLines)", () => {
	test("renderer registered for ASK_CUSTOM_TYPE; prose passes through verbatim (no bullet rewrite)", async () => {
		clearRagEnv();
		const { pi } = installAsk({});
		const prose = [
			"the isolated answer opens with plain prose about delegation",
			"- memories are tricky prose that toCardLines would collapse",
			"[m1] looks-like-a-hit but is prose and must survive intact",
			"closing line with a tail marker",
		].join("\n");
		const text = renderedText(
			renderAsk(pi, { content: prose, details: { kind: "answer", query: P1 } }, themeStub),
		);
		expect(text).toContain("the isolated answer opens with plain prose");
		expect(text).toContain("- memories are tricky prose that toCardLines would collapse");
		expect(text).toContain("[m1] looks-like-a-hit but is prose and must survive intact");
		expect(text).not.toContain("• ");
	});

	test("renderer never throws: throwing theme + missing paint helpers fall back to plain Text", async () => {
		clearRagEnv();
		const { pi } = installAsk({});
		const body = "fallback body that must survive a hostile theme";
		const throwing = {
			fg: (): string => {
				throw new Error("theme boom");
			},
			bg: (_c: string, t: string) => t,
		};
		let threw = false;
		let a: unknown;
		try {
			a = renderAsk(pi, { content: body, details: { kind: "failure" } }, throwing);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(renderedText(a)).toContain(body);
		let b: unknown;
		try {
			b = renderAsk(pi, { content: body }, {});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(renderedText(b)).toContain(body);
	});

	test("non-string / empty content renders undefined", async () => {
		clearRagEnv();
		const { pi } = installAsk({});
		expect(renderAsk(pi, { content: undefined }, themeStub)).toBeUndefined();
		expect(renderAsk(pi, { content: "" }, themeStub)).toBeUndefined();
	});
});

describe("P2 AC5/S2 sendMessage-throw falls back to notify", () => {
	test("throwing pi.sendMessage: answer still surfaces via notify fallback, turn never throws", async () => {
		clearRagEnv();
		process.env["AI_BADGER_PROJECT_ID"] = "proj-p2-s2";
		const answer = "answer surviving a throwing sendMessage";
		const { pi } = installAsk({
			spawn: async () => ({ stdout: jsonlAnswer(answer), stderr: "", exitCode: 0 }),
		});
		pi.sendMessage = (): void => {
			throw new Error("extension runtime stale");
		};
		const notes: Notify[] = [];
		let threw = false;
		try {
			await fireAsk(pi, P1, makeAskCtx("/tmp/p2-s2", "sess-p2-s2", notes));
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(pi.sent).toHaveLength(0);
		// ack + answer notify + send-throw fallback notify.
		expect(notes).toHaveLength(3);
		expect(notes[0]!.message).toContain(P1);
		expect(notes.filter((n) => n.message.includes(answer))).toHaveLength(2);
	});
});
