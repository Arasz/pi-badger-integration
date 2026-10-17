/**
 * Live round trip through the real `rtk hook claude` (local only: skipped when rtk is not on
 * PATH). Hermetic: rtk's config and databases point into a temp dir through runHook's env
 * option; process.env is never touched and only `rtk hook claude` / `rtk pipeline show` run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createFakePi } from "../helpers/fake-pi.ts";
import { fire } from "../router-fallback/helpers.ts";
import { createRtkExtension } from "../../extensions/rtk/index.ts";
import { runHook, type HookOptions } from "../../extensions/rtk/rtk-hook-runner.ts";

const hasRtk = (() => {
	try {
		return Bun.spawnSync(["rtk", "pipeline", "show", "rtk:posthook"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
})();

const PIPELINE = `schema_version = 1

[pipeline]
name = "pi-live-test"
extends = ["rtk:posthook"]

[[hook.after_tool.shell]]
name = "size-marker"
when = { tokens_gt = 5000 }
use = ["term"]
`;

const TRAILER = "\n\nCommand exited with code 1";

type Row = Record<string, unknown>;

/** Opens a sqlite file strictly read-only; a WAL db without its -shm falls back to immutable when no -wal is pending. */
function readRows(path: string, sql: string, ...params: string[]): Row[] | undefined {
	if (!existsSync(path)) return [];
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		db.prepare("select 1").get();
	} catch {
		if (existsSync(`${path}-wal`)) return undefined;
		const url = pathToFileURL(path);
		url.searchParams.set("immutable", "1");
		db = new DatabaseSync(url, { readOnly: true });
	}
	try {
		return db.prepare(sql).all(...params) as Row[];
	} finally {
		db.close();
	}
}

/** A failing `npm run build` log of `lines` lines: a run of one repeated warning, then distinct type errors. */
function buildLog(lines: number): string {
	const out: string[] = ["> app@1.0.0 build", "> tsc -p . && vite build", ""];
	const errors = Math.floor(lines / 4);
	for (let i = 0; i < lines - errors; i++) {
		out.push("warning: src/components/widget.tsx: React Hook useEffect has a missing dependency: 'options'.");
	}
	for (let i = 0; i < errors; i++) {
		out.push(`src/components/widget${i % 9}.tsx(${i + 10},5): error TS2322: Type 'string' is not assignable to type 'number'.`);
	}
	out.push("", `Found ${errors} errors in 9 files.`);
	return out.join("\n");
}

describe.skipIf(!hasRtk)("rtk live: pi tool results through the real rtk hook claude", () => {
	let tmp: string;
	let cfg: string;
	let env: NodeJS.ProcessEnv;
	const sent: Array<Record<string, any>> = [];

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-rtk-live-"));
		cfg = join(tmp, "cfg");
		mkdirSync(cfg);
		writeFileSync(join(cfg, "pipeline.toml"), PIPELINE);
		env = {
			...process.env,
			RTK_CONFIG_DIR: cfg,
			RTK_DB_PATH: join(tmp, "h.db"),
			RTK_RECALL_DB: join(tmp, "r.db"),
			RTK_TELEMETRY_DISABLED: "1",
		};
	});

	afterAll(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	async function extension() {
		const pi = createFakePi() as unknown as Record<string, any> & { handlers: Map<string, unknown[]> };
		pi.exec = async (_command: string, args: string[]) =>
			args[0] === "--version" ? { stdout: "rtk 1.0.1\n", stderr: "", code: 0, killed: false } : { stdout: "", stderr: "", code: 1, killed: false };
		const liveHook = (payload: unknown, opts: HookOptions) => {
			sent.push(payload as Record<string, any>);
			return runHook(payload, { ...opts, env });
		};
		await createRtkExtension({ runHook: liveHook, env: {}, now: () => 0, readProxyUsage: () => undefined, proxyDb: "" })(pi as never);
		return pi;
	}

	const ctx = () => ({ cwd: tmp, signal: new AbortController().signal, sessionManager: { getSessionId: () => "live-1" } });
	const history = (like: string) =>
		readRows(join(tmp, "h.db"), "select rtk_cmd, input_tokens, output_tokens, project_path from commands where rtk_cmd like ?", like) ?? [];

	test("the temp config's size-marker rule is live for shell results", () => {
		const shown = Bun.spawnSync(["rtk", "pipeline", "show"], { cwd: tmp, env });
		const text = shown.stdout.toString();
		expect(shown.exitCode).toBe(0);
		expect(text).toContain("Pipeline: pi-live-test");
		expect(text).toMatch(/size-marker\s+\[[^\]]*cfg\/pipeline\.toml\] when tokens_gt=5000 -> use=\[term\]/);
	});

	test("jv-2: a grep result is replaced and recorded in the temp history with the project path", async () => {
		const pi = await extension();
		const body = Array.from(
			{ length: 40 },
			(_, i) => `src/module${i % 4}/file${i % 4}.ts:${i * 3 + 1}: const value${i} = computeSomething(argument${i}, options); // trailing`,
		).join("\n");
		expect(body.length).toBeGreaterThan(2_500);
		const event = { type: "tool_result", toolCallId: "g1", toolName: "grep", input: { pattern: "value" }, content: [{ type: "text", text: body }], isError: false, details: undefined };

		const [result] = (await fire(pi as never, "tool_result", event, ctx())) as Array<Record<string, any> | undefined>;

		const text: string = result?.content?.[0]?.text;
		expect(text.startsWith("40 matches in")).toBe(true);
		expect(text.length).toBeLessThan(body.length);
		expect(result?.details?.rtk).toEqual({ from: body.length, to: text.length });
		const rows = history("rtk posthook grep%");
		expect(rows.length).toBe(1);
		expect(rows[0].project_path).toBe(realpathSync(tmp));
	});

	const bashEvent = (body: string) => ({
		type: "tool_result",
		toolCallId: "b1",
		toolName: "bash",
		input: { command: "rtk npm run build" },
		content: [{ type: "text", text: body + TRAILER }],
		isError: true,
		structuredContent: { exit_code: 1, stdout: body, stderr: "" },
		details: undefined,
	});

	test("jv-3: an oversized rtk bash result reaches the size rule and keeps its exit-code trailer", async () => {
		const pi = await extension();
		const body = buildLog(275);
		expect(body.length).toBeGreaterThan(25_000);
		expect(body.length).toBeLessThan(28_000);
		const before = sent.length;

		const [result] = (await fire(pi as never, "tool_result", bashEvent(body), ctx())) as Array<Record<string, any> | undefined>;

		expect(sent.length).toBe(before + 1);
		const text: string = result?.content?.[0]?.text;
		expect(text.endsWith(TRAILER)).toBe(true);
		expect(text.length).toBeLessThan(body.length + TRAILER.length);
		expect(result?.structuredContent).toEqual({ exit_code: 1, stdout: body, stderr: "" });
		const rows = history("rtk posthook bash%");
		expect(rows.length).toBe(1);
		expect(Number(rows[0].input_tokens)).toBeGreaterThan(5_000);
		expect(Number(rows[0].output_tokens)).toBeLessThan(Number(rows[0].input_tokens));
		expect(rows[0].project_path).toBe(realpathSync(tmp));
		const recall = readRows(join(tmp, "r.db"), "select command, cwd from recall") ?? [];
		expect(recall.map((r) => r.cwd)).toContain(realpathSync(tmp));
	});

	test("jv-3 control: the same rtk bash shape at ~6.6 KB is never sent and stays untouched", async () => {
		const pi = await extension();
		const body = buildLog(69);
		expect(body.length).toBeGreaterThan(6_000);
		expect(body.length).toBeLessThan(7_000);
		const before = sent.length;
		const rowsBefore = history("rtk posthook bash%").length;

		const [result] = await fire(pi as never, "tool_result", bashEvent(body), ctx());

		expect(result).toBeUndefined();
		expect(sent.length).toBe(before);
		expect(history("rtk posthook bash%").length).toBe(rowsBefore);
	});

	test("jv-2: the global rtk history and recall dbs get no rows for the temp project (runs last)", () => {
		if (process.platform !== "darwin") return;
		const base = join(homedir(), "Library", "Application Support", "rtk");
		const real = realpathSync(tmp);
		const globalHistory = readRows(join(base, "history.db"), "select 1 from commands where project_path in (?, ?)", real, tmp);
		const globalRecall = readRows(join(base, "recall.db"), "select 1 from recall where cwd in (?, ?)", real, tmp);
		expect(globalHistory).toEqual([]);
		expect(globalRecall).toEqual([]);
	});
});
