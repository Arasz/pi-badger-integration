/**
 * Tests for publish.ts's generic extension-directory model (package P2 of
 * docs/plans/2026-extension-directory-packages.md).
 *
 * SAFETY: every test here aims directoryTarget/drifts/main at injected TEMP
 * fixture trees (mkdtemp under os.tmpdir). Nothing in this file may touch the
 * real ~/.pi/agent/extensions/ — main() is only ever called with --check plus
 * injected targets, or with argument combinations that refuse before any
 * filesystem access — and the repo's real extensions/ dir is never a
 * destination. --check must stay read-only, and one test pins that at the
 * fixture level.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_FILES, directoryTarget, drifts, main, type InstallDeps } from "../../publish.ts";

/** The repo root — for reading canonical SOURCE trees only (never a destination). */
function rootDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const cleanup: string[] = [];
afterEach(() => {
	while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

/** A fresh { root, userDir } pair to inject into directoryTarget — both temp dirs. */
function fixture(): { root: string; userDir: string } {
	return { root: tempDir("publish-p2-root-"), userDir: tempDir("publish-p2-user-") };
}

function writeTree(base: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(base, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

function extensionSource(root: string, name: string): string {
	return join(root, "extensions", name);
}

function allFilesUnder(base: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		const full = join(base, entry.name);
		if (entry.isDirectory()) out.push(...allFilesUnder(full));
		else out.push(full);
	}
	return out;
}

const EXTRA_SUFFIX = " — delete it, or add it to canonical and ship it";
function extraFileProblem(file: string): string {
	return `extra file at destination (not canonical): ${file}${EXTRA_SUFFIX}`;
}

function captureConsole(): { lines: string[]; restore(): void } {
	const lines: string[] = [];
	const originals = { log: console.log, warn: console.warn, error: console.error };
	for (const key of ["log", "warn", "error"] as const) {
		console[key] = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	}
	return { lines, restore: () => Object.assign(console, originals) };
}

describe("directoryTarget: one pair per non-node_modules file, recursively", () => {
	test("derives flat files, a nested subdir, and excludes the node_modules subtree", () => {
		const { root, userDir } = fixture();
		const src = extensionSource(root, "pi-cron");
		writeTree(src, {
			"index.ts": "export default {};",
			"package.json": '{ "name": "fixture" }',
			"config.ts": "export const a = 1;",
			"run-job.ts": "export const b = 2;",
			"nested/deep/helper.ts": "export const c = 3;",
			"node_modules/dep/index.js": "module.exports = 1;",
			"node_modules/dep/package.json": "{}",
		});

		const target = directoryTarget("pi-cron", { root, userDir });

		const rels = target.pairs.map((p) => relative(src, p.source)).sort();
		expect(rels).toEqual(["config.ts", "index.ts", "nested/deep/helper.ts", "package.json", "run-job.ts"]);
		for (const p of target.pairs) {
			expect(p.destination).toBe(join(userDir, "pi-cron", relative(src, p.source)));
		}
		expect(target.ownedDir).toBe(join(userDir, "pi-cron"));
		expect(target.pairs.some((p) => p.source.includes("node_modules"))).toBe(false);
		expect(target.pairs.some((p) => p.destination.includes("node_modules"))).toBe(false);
	});
});

describe("extra-file check: the node_modules subtree is exempt, nested strays are not", () => {
	test("a populated destination node_modules is never flagged as extra", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), {
			"index.ts": "A;",
			"package.json": "{}",
			"nested/keep.ts": "K;",
		});
		const dest = join(userDir, "pi-cron");
		writeTree(dest, {
			"index.ts": "A;",
			"package.json": "{}",
			"nested/keep.ts": "K;",
			"node_modules/dep/index.js": "runtime dep bytes",
			"node_modules/dep/nested/deeper.js": "more dep bytes",
		});

		const { problems, warnings } = drifts(directoryTarget("pi-cron", { root, userDir }));

		expect(problems).toEqual([]);
		// node_modules present on BOTH sides → nothing to warn about either
		expect(warnings).toEqual([]);
	});

	test("nested non-node_modules strays ARE flagged, alongside top-level ones", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), { "index.ts": "A;", "package.json": "{}" });
		const dest = join(userDir, "pi-cron");
		writeTree(dest, {
			"index.ts": "A;",
			"package.json": "{}",
			"node_modules/leftover.js": "exempt derived state",
			"stale.ts": "top-level stray",
			"nested/stale.ts": "nested stray",
		});

		const { problems } = drifts(directoryTarget("pi-cron", { root, userDir }));

		expect([...problems].sort()).toEqual(
			[extraFileProblem(join(dest, "nested/stale.ts")), extraFileProblem(join(dest, "stale.ts"))].sort(),
		);
	});
});

describe("drifts classification: problems vs warnings", () => {
	test("missing, byte-differing, and extra canonical files each land in problems", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), {
			"index.ts": "A;",
			"package.json": "{}",
			"nested/keep.ts": "K;",
			"node_modules/dep/index.js": "dep",
		});
		const dest = join(userDir, "pi-cron");
		writeTree(dest, {
			"index.ts": "DIFFERENT BYTES;", // byte-differing
			"nested/keep.ts": "K;", // in sync
			"stowaway.ts": "extra",
			// package.json absent at destination → missing
		});

		const { problems } = drifts(directoryTarget("pi-cron", { root, userDir }));

		expect([...problems].sort()).toEqual(
			[
				`not installed: ${join(dest, "package.json")}`,
				`differs: ${join(dest, "index.ts")}`,
				extraFileProblem(join(dest, "stowaway.ts")),
			].sort(),
		);
	});

	test("absent destination node_modules is a warning, never a problem", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), {
			"index.ts": "A;",
			"package.json": "{}",
			"node_modules/dep/index.js": "dep",
		});
		const dest = join(userDir, "pi-cron");
		writeTree(dest, { "index.ts": "A;", "package.json": "{}" });

		const { problems, warnings } = drifts(directoryTarget("pi-cron", { root, userDir }));

		expect(problems).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(join(dest, "node_modules"));
	});
});

describe("CLI contract", () => {
	test("--check combined with --ai-badger is refused (exit 1)", () => {
		expect(main(["--check", "--ai-badger", "/tmp/irrelevant"])).toBe(1);
	});

	test("--ai-badger without a path is refused (exit 1)", () => {
		expect(main(["--ai-badger"])).toBe(1);
	});

	test("warnings never make --check fatal; problems do", () => {
		const warning = fixture();
		writeTree(extensionSource(warning.root, "pi-cron"), {
			"index.ts": "A;",
			"node_modules/dep/index.js": "dep",
		});
		writeTree(join(warning.userDir, "pi-cron"), { "index.ts": "A;" }); // no node_modules → warning only
		const captured = captureConsole();
		try {
			expect(main(["--check"], { targets: [directoryTarget("pi-cron", warning)] })).toBe(0);
			expect(captured.lines.join("\n")).toContain(join(warning.userDir, "pi-cron", "node_modules"));
		} finally {
			captured.restore();
		}

		const problem = fixture();
		writeTree(extensionSource(problem.root, "pi-cron"), { "index.ts": "A;" });
		// destination never created → "not installed" problem → non-zero exit
		expect(main(["--check"], { targets: [directoryTarget("pi-cron", problem)] })).toBe(1);
	});

	test("--check is read-only: an out-of-sync fixture gains no files and no .publishing strays", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), { "index.ts": "A;", "package.json": "{}" });
		const dest = join(userDir, "pi-cron");
		writeTree(dest, { "index.ts": "STALE;" });

		const captured = captureConsole();
		try {
			expect(main(["--check"], { targets: [directoryTarget("pi-cron", { root, userDir })] })).toBe(1);
		} finally {
			captured.restore();
		}
		expect(readFileSync(join(dest, "index.ts"), "utf8")).toBe("STALE;");
		expect(readdirSync(dest)).toEqual(["index.ts"]);
	});
});

// Beyond the plan's ①–④ list (added because the AC "install writes every
// non-node_modules file … with .publishing-<pid> staging" and the loud
// absent-node_modules warning have no other coverage). Same safety rule:
// main() runs with INJECTED targets whose destinations are temp dirs.
describe("install (into injected temp targets)", () => {
	test("writes every canonical file recursively, copies node_modules recursively, leaves no strays", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), {
			"index.ts": "A;",
			"package.json": "{}",
			"nested/deep/helper.ts": "H;",
			"node_modules/dep/index.js": "dep bytes",
			"node_modules/dep/sub/deeper.js": "deep dep bytes",
		});
		const captured = captureConsole();
		try {
			expect(main([], { targets: [directoryTarget("pi-cron", { root, userDir })] })).toBe(0);
		} finally {
			captured.restore();
		}

		const dest = join(userDir, "pi-cron");
		expect(readFileSync(join(dest, "index.ts"), "utf8")).toBe("A;");
		expect(readFileSync(join(dest, "package.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(dest, "nested/deep/helper.ts"), "utf8")).toBe("H;");
		expect(readFileSync(join(dest, "node_modules/dep/index.js"), "utf8")).toBe("dep bytes");
		expect(readFileSync(join(dest, "node_modules/dep/sub/deeper.js"), "utf8")).toBe("deep dep bytes");
		expect(allFilesUnder(dest).some((f) => f.includes(".publishing-"))).toBe(false);
	});

	test("absent source node_modules publishes without deps but warns loudly", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), { "index.ts": "A;" });
		const captured = captureConsole();
		let code: number;
		try {
			code = main([], { targets: [directoryTarget("pi-cron", { root, userDir })] });
		} finally {
			captured.restore();
		}
		expect(code).toBe(0);
		expect(captured.lines.join("\n")).toContain("WITHOUT node_modules");
	});
});

// Auto-install model: a source dir with a package.json but no node_modules gets one
// automatic `bun install` on the install path only. Every test stubs the runner —
// none of these may hit the network — and the --check test pins that the read-only
// contract survives the new phase.
describe("auto-install: a missing node_modules gets one bun install before shipping", () => {
	test("runs the installer in the source dir when package.json is present, then ships the fresh deps", () => {
		const { root, userDir } = fixture();
		const src = extensionSource(root, "pi-cron");
		writeTree(src, { "index.ts": "A;", "package.json": '{ "dependencies": { "x": "*" } }' });
		const installedIn: string[] = [];
		const runInstall: InstallDeps = (dir) => {
			installedIn.push(dir);
			writeTree(join(dir, "node_modules/x"), { "index.js": "dep bytes" });
		};
		const captured = captureConsole();
		let code: number;
		try {
			code = main([], { targets: [directoryTarget("pi-cron", { root, userDir })], runInstall });
		} finally {
			captured.restore();
		}

		expect(code).toBe(0);
		expect(installedIn).toEqual([src]);
		// installTarget re-lists node_modules at copy time, so post-install deps ship
		expect(readFileSync(join(userDir, "pi-cron/node_modules/x/index.js"), "utf8")).toBe("dep bytes");
		expect(captured.lines.join("\n")).toContain("running bun install automatically");
	});

	test("skips the installer without a package.json — nothing to install, loud warning remains", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), { "index.ts": "A;" });
		let called = 0;
		const runInstall: InstallDeps = () => {
			called += 1;
		};
		const captured = captureConsole();
		let code: number;
		try {
			code = main([], { targets: [directoryTarget("pi-cron", { root, userDir })], runInstall });
		} finally {
			captured.restore();
		}

		expect(code).toBe(0);
		expect(called).toBe(0);
		expect(captured.lines.join("\n")).toContain("WITHOUT node_modules");
	});

	test("a failed install is never fatal — degrades to the loud shipping warning", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), { "index.ts": "A;", "package.json": "{}" });
		const runInstall: InstallDeps = () => {
			throw new Error("offline");
		};
		const captured = captureConsole();
		let code: number;
		try {
			code = main([], { targets: [directoryTarget("pi-cron", { root, userDir })], runInstall });
		} finally {
			captured.restore();
		}

		expect(code).toBe(0);
		const out = captured.lines.join("\n");
		expect(out).toContain("automatic bun install failed");
		expect(out).toContain("offline");
		expect(out).toContain("WITHOUT node_modules");
	});

	test("node_modules already present → the installer is not called and existing deps ship", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-cron"), {
			"index.ts": "A;",
			"package.json": "{}",
			"node_modules/dep/index.js": "existing dep",
		});
		let called = 0;
		const runInstall: InstallDeps = () => {
			called += 1;
		};
		const captured = captureConsole();
		let code: number;
		try {
			code = main([], { targets: [directoryTarget("pi-cron", { root, userDir })], runInstall });
		} finally {
			captured.restore();
		}

		expect(code).toBe(0);
		expect(called).toBe(0);
		expect(readFileSync(join(userDir, "pi-cron/node_modules/dep/index.js"), "utf8")).toBe("existing dep");
	});

	test("--check never runs the installer (read-only contract holds under the new phase)", () => {
		const { root, userDir } = fixture();
		const src = extensionSource(root, "pi-cron");
		writeTree(src, { "index.ts": "A;", "package.json": "{}" });
		writeTree(join(userDir, "pi-cron"), { "index.ts": "A;" }); // package.json missing at dest → fatal problem
		const runInstall: InstallDeps = () => {
			throw new Error("--check must never install");
		};
		const captured = captureConsole();
		try {
			expect(main(["--check"], { targets: [directoryTarget("pi-cron", { root, userDir })], runInstall })).toBe(1);
		} finally {
			captured.restore();
		}

		expect(captured.lines.join("\n")).not.toContain("--check must never install");
		expect(readdirSync(src).sort()).toEqual(["index.ts", "package.json"]); // source gained no node_modules
	});
});

describe("dotfiles ship as canonical pairs (P2 capability markers)", () => {
	test("directoryTarget picks dotfiles up as pairs — a marker must install to user scope", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-mcp-tools"), {
			"index.ts": "export default {};",
			".ai-badger-capability-project-scope-mcp": "marker bytes",
		});

		const target = directoryTarget("pi-mcp-tools", { root, userDir });
		const markerPair = target.pairs.find((p) => p.source.endsWith(".ai-badger-capability-project-scope-mcp"));
		expect(markerPair).toBeDefined();
		expect(markerPair!.destination).toBe(join(userDir, "pi-mcp-tools", ".ai-badger-capability-project-scope-mcp"));
	});

	test("--check treats a missing dotfile at destination as a fatal problem (canonical pair, not an extra)", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-mcp-tools"), {
			"index.ts": "export default {};",
			".ai-badger-capability-project-scope-mcp": "marker bytes",
		});
		// destination has the code file but NOT the marker
		writeTree(join(userDir, "pi-mcp-tools"), { "index.ts": "export default {};" });

		const report = drifts(directoryTarget("pi-mcp-tools", { root, userDir }));
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain(".ai-badger-capability-project-scope-mcp");
		expect(report.problems[0]).toContain("not installed");
	});

	test("a dotfile at destination that is NOT canonical is still flagged as extra", () => {
		const { root, userDir } = fixture();
		writeTree(extensionSource(root, "pi-mcp-tools"), { "index.ts": "export default {};" });
		writeTree(join(userDir, "pi-mcp-tools"), {
			"index.ts": "export default {};",
			".some-stray-dotfile": "stray",
		});

		const report = drifts(directoryTarget("pi-mcp-tools", { root, userDir }));
		expect(report.problems.some((p) => p.includes(".some-stray-dotfile"))).toBe(true);
	});
});

describe("adapter capability marker (P2)", () => {
	test("ADAPTER_FILES carries .ai-badger-capability-resources-discover (installed at user scope, gated on by the adjustments)", () => {
		expect(ADAPTER_FILES).toContain(".ai-badger-capability-resources-discover");
	});

	test("the canonical adapter dir matches ADAPTER_FILES exactly (add a file ⇒ list it; list a file ⇒ ship it)", () => {
		const adapterDir = join(rootDir(), "features", "pi", "adjustments", "adapter");
		const onDisk = readdirSync(adapterDir).sort();
		expect(onDisk).toEqual([...ADAPTER_FILES].sort());
	});
});
