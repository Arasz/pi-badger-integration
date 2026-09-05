/**
 * Adapter `resources_discover` contract (plan rev 3 §1 M4 / §2 P2, decision D2):
 * the adapter contributes the project's `.ai-badger/skills` directory as a pi
 * skill path — UNGATED. The handler reads `event.cwd` (pi's runner derives the
 * event from the session cwd, `runner.js:935-947`) and must never consult the
 * extension context: no `ctx.cwd`, no `ctx.isProjectTrusted()` — the effective
 * trust decision is installing the adapter user-globally (ADR-0023 asymmetry).
 *
 * Absent-safe: a project without `.ai-badger/skills` contributes no paths and
 * the handler never throws.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapterFactory from "../../features/pi/adjustments/adapter/index.ts";

interface Harness {
	pi: unknown;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	commands: Map<string, unknown>;
}

function harness(): Harness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, options: unknown) => {
			commands.set(name, options);
		},
	};
	return { pi, handlers, commands };
}

/** A context stub whose EVERY access is observable: the ungated contract means
 * the handler must leave these counters at zero. */
function observingCtx(cwd: string): {
	ctx: unknown;
	reads: { cwd: number; isProjectTrusted: number };
} {
	const reads = { cwd: 0, isProjectTrusted: 0 };
	const ctx = {
		get cwd() {
			reads.cwd++;
			return cwd;
		},
		isProjectTrusted: () => {
			reads.isProjectTrusted++;
			return true;
		},
		mode: "print",
		hasUI: false,
		ui: { notify: () => undefined, setStatus: () => undefined, confirm: async () => true },
	};
	return { ctx, reads };
}

const cleanup: string[] = [];

describe("adapter resources_discover (ungated skills contribution, M4/D2)", () => {
	function tempProject(withSkills: boolean): string {
		const dir = mkdtempSync(join(tmpdir(), "adapter-resources-"));
		cleanup.push(dir);
		if (withSkills) {
			mkdirSync(join(dir, ".ai-badger", "skills"), { recursive: true });
			// A real skill inside, mirroring what the scaffold ships.
			writeFileSync(join(dir, ".ai-badger", "skills", "design-tests"), "placeholder", "utf-8");
		}
		return dir;
	}

	test("the factory registers a resources_discover handler", async () => {
		const h = harness();
		await adapterFactory(h.pi as never);
		expect(h.handlers.has("resources_discover")).toBe(true);
	});

	test("returns { skillPaths: [<event.cwd>/.ai-badger/skills] } when the directory exists", async () => {
		const project = tempProject(true);
		const h = harness();
		await adapterFactory(h.pi as never);
		const { ctx, reads } = observingCtx(tempProject(false)); // ctx.cwd deliberately elsewhere

		const result = (await h.handlers.get("resources_discover")!(
			{ type: "resources_discover", cwd: project, reason: "startup" },
			ctx,
		)) as { skillPaths?: string[] };

		expect(result).toEqual({ skillPaths: [join(project, ".ai-badger", "skills")] });
		// Ungated, event-driven: the context was never consulted.
		expect(reads.cwd).toBe(0);
		expect(reads.isProjectTrusted).toBe(0);
	});

	test("absent-safe: no .ai-badger/skills directory means no paths, never a throw", async () => {
		const project = tempProject(false);
		const h = harness();
		await adapterFactory(h.pi as never);
		const { ctx, reads } = observingCtx(project);

		const result = (await h.handlers.get("resources_discover")!(
			{ type: "resources_discover", cwd: project, reason: "reload" },
			ctx,
		)) as { skillPaths?: string[] };

		expect(result.skillPaths).toEqual([]);
		expect(reads.cwd).toBe(0);
		expect(reads.isProjectTrusted).toBe(0);
	});

	test("is ungated: even an UNTRUSTED-project context contributes the skills path", async () => {
		const project = tempProject(true);
		const h = harness();
		await adapterFactory(h.pi as never);
		const reads = { isProjectTrusted: 0 };
		const untrustedCtx = {
			cwd: tempProject(false),
			isProjectTrusted: () => {
				reads.isProjectTrusted++;
				return false;
			},
			mode: "print",
			hasUI: false,
			ui: { notify: () => undefined, setStatus: () => undefined, confirm: async () => true },
		};

		const result = (await h.handlers.get("resources_discover")!(
			{ type: "resources_discover", cwd: project, reason: "startup" },
			untrustedCtx,
		)) as { skillPaths?: string[] };

		expect(result).toEqual({ skillPaths: [join(project, ".ai-badger", "skills")] });
		expect(reads.isProjectTrusted).toBe(0);
	});

	test("works for both discover reasons (startup and reload)", async () => {
		const project = tempProject(true);
		const h = harness();
		await adapterFactory(h.pi as never);
		const { ctx } = observingCtx(project);

		for (const reason of ["startup", "reload"] as const) {
			const result = (await h.handlers.get("resources_discover")!(
				{ type: "resources_discover", cwd: project, reason },
				ctx,
			)) as { skillPaths?: string[] };
			expect(result).toEqual({ skillPaths: [join(project, ".ai-badger", "skills")] });
		}
	});

	test("learned/ subtree is never contributed (mirror of ai-badger 0.163.1)", async () => {
		const project = mkdtempSync(join(tmpdir(), "adapter-learned-"));
		cleanup.push(project);
		const skills = join(project, ".ai-badger", "skills");
		mkdirSync(join(skills, "code-review"), { recursive: true });
		mkdirSync(join(skills, "learned", "uncategorized", "code-review"), { recursive: true });
		const h = harness();
		await adapterFactory(h.pi as never);
		const { ctx } = observingCtx(project);

		const result = (await h.handlers.get("resources_discover")!(
			{ type: "resources_discover", cwd: project, reason: "startup" },
			ctx,
		)) as { skillPaths?: string[] };
		const paths = result.skillPaths ?? [];
		expect(paths).toContain(join(skills, "code-review"));
		expect(paths).not.toContain(skills);
		expect(paths.filter((p) => p.split("/").includes("learned"))).toEqual([]);
	});
});

// rmSync the temp projects; bun runs describes eagerly so cleanup is registered per-file.
process.on("exit", () => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
