/**
 * Publish flow for the extensions this repo owns. Run with bun:
 *
 *   bun publish.ts                     install canonical → pi user scope
 *   bun publish.ts --check             read-only: report drift, exit 1 on problems
 *   bun publish.ts --ai-badger <path>  ALSO vendor the adapter into an ai-badger
 *                                      checkout (never combined with --check)
 *
 * What gets installed:
 *   1. the ai-badger hooks adapter — canonical at
 *      features/pi/adjustments/adapter/ (dir mirrors ai-badger's vendored path so
 *      tests import unchanged); ai-badger vendors it because its scaffold-freshness
 *      gates require the shipping copy in-repo. Exact-set contract (below).
 *   2. every extension directory under extensions/ (pi-cron, pi-mcp-tools,
 *      session-signals, shift-enter-newline, subagent): the whole directory is
 *      canonical. Every file EXCEPT the node_modules subtree ships, recursively,
 *      to ~/.pi/agent/extensions/<name>/ (directory name = install name).
 *
 * Semantics folded in from the plan review (2026-08-29; directory-package model):
 *   - --check NEVER writes; --ai-badger always writes and always announces it.
 *   - the adapter target enforces exact file-set equality (missing, extra AND
 *     byte-differing files all fail --check): adjust_hooks.py's copy contract ships
 *     any .ts/.json with no cleanup, so a renamed canonical file would leave a stale
 *     extra at user scope and break every fresh pi session. Directory targets get
 *     the same rule via the generic extra-file walk over their owned dir.
 *   - node_modules is derived state (re-creatable via bun install from the shipped
 *     package.json + bun.lock): it is exempt from the extra-file check and never
 *     byte-compared. --check reports a missing destination node_modules as a
 *     WARNING (exit 0); only problems (missing/extra/byte-differing canonical
 *     files) exit 1.
 *   - Install auto-installs deps (2026-09-02; auto-install model): an extension
 *     dir whose node_modules is absent but which has a package.json gets one
 *     automatic `bun install` BEFORE canonical pairs are computed, so the
 *     bun.lock it writes ships in the same run and a fresh clone publishes
 *     complete extensions with no manual step. Best-effort, never fatal:
 *     failure (no bun, offline, no package.json) degrades to the loud shipping
 *     warning — host-provided imports (pi-coding-agent, typebox, pi-tui) need
 *     no node_modules at all. The local node_modules then copies recursively;
 *     shipping without deps still warns loudly — pi-mcp-tools needs
 *     @modelcontextprotocol/sdk at runtime, so that must never be silent.
 *   - installs write to a temp file then rename, so a pi session starting
 *     mid-publish cannot load a partially written file (running sessions are
 *     unaffected — jiti has already loaded their modules). Per-file atomicity,
 *     not per-set: a session starting between two renames can observe a mixed
 *     set — sub-millisecond window.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Byte-identical to ai-badger's adjust_hooks.py copy contract — never add a file here
 * without vendoring it there too, or scaffolds will ship it while --check calls it extra.
 * .ai-badger-capability-resources-discover is the installed capability marker the
 * migration adjustments gate on (R8/R9) — a dotfile ON PURPOSE: it must ship with
 * the adapter to user scope (P2 of aib-pi-stack-mcp-skills-parity). */
export const ADAPTER_FILES = [
	"index.ts",
	"hook-bridge.ts",
	"bus-prefilter.ts",
	"bus-store.ts",
	"package.json",
	".ai-badger-capability-resources-discover",
] as const;

const ADAPTER_SOURCE_DIR = "features/pi/adjustments/adapter";
/** Directory names under extensions/, each installed as ~/.pi/agent/extensions/<name>/. */
const EXTENSION_DIRS = ["pi-cron", "pi-mcp-tools", "session-signals", "shift-enter-newline", "subagent", "monitor", "router-fallback"] as const;

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const USER_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");
const ADAPTER_USER_DIR = join(USER_EXTENSIONS_DIR, "ai-badger");

interface Target {
	name: string;
	/** Canonical file → its expected content hash source. */
	pairs: Array<{ source: string; destination: string }>;
	/** Set only when this target owns the WHOLE destination directory: extra files there
	 * are drift (the node_modules subtree exempt — derived state). A target whose
	 * destination dir is shared with other extensions must not set it. */
	ownedDir?: string;
	/** Set only for extension-directory targets: governs the node_modules warning under
	 * --check and the recursive node_modules copy at install time. */
	nodeModules?: { source: string; destination: string };
}

function adapterTarget(userDir: string): Target {
	return {
		name: `ai-badger adapter (${userDir})`,
		pairs: ADAPTER_FILES.map((name) => ({
			source: join(ROOT, ADAPTER_SOURCE_DIR, name),
			destination: join(userDir, name),
		})),
		ownedDir: userDir,
	};
}

/**
 * An extension-directory target: every file under `<root>/extensions/<name>/` except
 * the node_modules subtree ships, recursively, to `<userDir>/<name>/` (directory name
 * = install name). Source root and user dir are injectable so tests aim at temp
 * fixture trees instead of the developer's real user scope.
 */
export function directoryTarget(
	name: string,
	{ root = ROOT, userDir = USER_EXTENSIONS_DIR }: { root?: string; userDir?: string } = {},
): Target {
	const sourceDir = join(root, "extensions", name);
	const destinationDir = join(userDir, name);
	const pairs = listFiles(sourceDir, /* skipNodeModules */ true).map((source) => ({
		source,
		destination: join(destinationDir, relative(sourceDir, source)),
	}));
	return {
		name: `${name} (${destinationDir})`,
		pairs,
		ownedDir: destinationDir,
		nodeModules: { source: join(sourceDir, "node_modules"), destination: join(destinationDir, "node_modules") },
	};
}

/** Every regular file under dir, recursively. node_modules subtrees are skipped when
 * skipNodeModules is set (derived state — never canonical, never drift). Symlinks and
 * other non-regular entries are skipped: pi loads files, and publish never follows
 * links out of the tree. Sorted for deterministic output. */
function listFiles(dir: string, skipNodeModules: boolean): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (skipNodeModules && entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(full, skipNodeModules));
		else if (entry.isFile()) files.push(full);
	}
	return files.sort();
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface DriftReport {
	/** Missing / extra / byte-differing canonical files — fatal under --check. */
	problems: string[];
	/** Worth telling the operator about, never fatal (e.g. missing destination
	 * node_modules: derived state, re-creatable via bun install). */
	warnings: string[];
}

/** Missing / extra / byte-differing, from the destination's point of view. */
export function drifts(target: Target): DriftReport {
	const problems: string[] = [];
	const warnings: string[] = [];
	for (const { source, destination } of target.pairs) {
		if (!existsSync(source)) problems.push(`canonical source missing: ${source}`);
		else if (!existsSync(destination)) problems.push(`not installed: ${destination}`);
		else if (sha256(source) !== sha256(destination)) problems.push(`differs: ${destination}`);
	}
	const destinationDir = target.ownedDir;
	if (destinationDir !== undefined && existsSync(destinationDir)) {
		// Recursive walk, node_modules subtree exempt: nested stale files are caught,
		// nested canonical files are not misflagged as extras.
		for (const file of listFiles(destinationDir, true)) {
			if (!target.pairs.some((p) => p.destination === file)) {
				problems.push(
					`extra file at destination (not canonical): ${file}` +
						` — delete it, or add it to canonical and ship it`,
				);
			}
		}
	}
	const nm = target.nodeModules;
	if (nm && existsSync(nm.source) && !existsSync(nm.destination)) {
		warnings.push(
			`destination node_modules missing: ${nm.destination}` +
				` — derived state; re-create with bun install (shipped package.json + bun.lock)`,
		);
	}
	return { problems, warnings };
}

/** Runs the dependency install for one extension source dir. Throws on failure. */
export type InstallDeps = (sourceDir: string) => void;

/** Default runner: `bun install` in the extension dir, output inherited so the operator
 * sees exactly what ran (loud, never silent). process.execPath under `bun publish.ts`
 * IS the bun binary — dodges PATH issues; under a node runtime the spawn fails and the
 * caller degrades to the loud warning, which is the pre-auto-install behavior. */
function bunInstall(sourceDir: string): void {
	execFileSync(process.execPath, ["install"], { cwd: sourceDir, stdio: "inherit" });
}

/** Fresh-clone gap filler: an extension dir that declares deps (package.json) but has no
 * node_modules gets one automatic install before anything is computed or copied. On the
 * default path this runs BEFORE directoryTarget listing so the bun.lock it writes lands
 * in the canonical pair set on the same run — otherwise --check would call bun.lock
 * `not installed` until a second publish. Best-effort: a failed install only logs; the
 * per-target shipping warning in installTarget stays the single loud signal that deps
 * are missing. (Injected targets were constructed by the caller before this runs, so
 * their pairs cannot pick up a new bun.lock — irrelevant for stub fixtures, which write
 * only node_modules files, and installTarget re-lists node_modules at copy time.) */
function ensureDependencies(sourceDirs: string[], runInstall: InstallDeps): void {
	for (const dir of sourceDirs) {
		if (existsSync(join(dir, "node_modules"))) continue;
		if (!existsSync(join(dir, "package.json"))) continue;
		console.log(`node_modules missing in ${dir} — running bun install automatically…`);
		try {
			runInstall(dir);
		} catch (error) {
			console.warn(
				`WARNING: automatic bun install failed in ${dir}: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** Install one file atomically (no partially written file ever appears at the
 * destination; a crashed publish leaves only a `.publishing-<pid>` stray that --check
 * names). Note this is per-file atomicity, not per-set: a session starting between two
 * renames of a multi-file target can observe a mixed set — sub-millisecond window. */
function install(source: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true });
	const staged = `${destination}.publishing-${process.pid}`;
	copyFileSync(source, staged);
	renameSync(staged, destination);
}

function installTarget(target: Target): void {
	for (const { source, destination } of target.pairs) {
		if (!existsSync(source)) {
			console.error(`FATAL: canonical source missing: ${source}`);
			process.exit(1);
		}
		install(source, destination);
	}
	const nm = target.nodeModules;
	if (nm !== undefined) {
		if (!existsSync(nm.source)) {
			// Loud, never silent: shipping an extension that declares runtime deps
			// (pi-mcp-tools → @modelcontextprotocol/sdk) without them breaks it at load.
			// ensureDependencies has already tried one automatic bun install; reaching
			// here means it was skipped (no package.json) or failed (logged above).
			console.error(
				`WARNING: ${nm.source} does not exist — publishing ${target.name} WITHOUT node_modules. ` +
					`Automatic bun install was skipped or failed; if this extension needs runtime deps, fix that and re-run.`,
			);
		} else {
			const files = listFiles(nm.source, false);
			for (const file of files) install(file, join(nm.destination, relative(nm.source, file)));
			console.log(`installed node_modules (${files.length} file(s)) → ${nm.destination}`);
		}
	}
	console.log(`installed ${target.pairs.length} file(s) → ${target.name}`);
}

function vendorAdapter(aiBadgerPath: string): void {
	const destinationDir = resolve(aiBadgerPath, ADAPTER_SOURCE_DIR);
	if (!existsSync(destinationDir)) {
		console.error(
			`FATAL: refusing to vendor — ${destinationDir} does not exist. ` +
				`--ai-badger only updates an existing ai-badger checkout's vendored adapter; it never creates one.`,
		);
		process.exit(1);
	}
	const target = adapterTarget(destinationDir);
	console.log(`vendoring ${target.pairs.length} file(s) → ${destinationDir}`);
	installTarget(target);
}

/**
 * `targets` is injectable so tests can run the --check CLI path against temp fixture
 * targets; without it the default owned set (adapter + every extension dir) is used.
 * `runInstall` is injectable so auto-install tests stub `bun install` instead of
 * hitting the network.
 */
export function main(argv: string[], inject?: { targets?: Target[]; runInstall?: InstallDeps }): number {
	const check = argv.includes("--check");
	const aiBadgerFlag = argv.indexOf("--ai-badger");
	const aiBadgerPath = aiBadgerFlag >= 0 ? argv[aiBadgerFlag + 1] : undefined;
	if (aiBadgerFlag >= 0 && !aiBadgerPath) {
		console.error("FATAL: --ai-badger needs a path to an ai-badger checkout");
		return 1;
	}
	if (check && aiBadgerFlag >= 0) {
		// M1 (review): silently dropping the vendoring request would let an operator
		// believe the durability step happened. Refuse instead.
		console.error("FATAL: --ai-badger cannot be combined with --check — checking never writes; vendoring always does");
		return 1;
	}

	const defaultTargets = () => [
		adapterTarget(ADAPTER_USER_DIR),
		...EXTENSION_DIRS.map((name) => directoryTarget(name)),
	];

	if (check) {
		const targets = inject?.targets ?? defaultTargets();
		const reports = targets.map((target) => ({ target, ...drifts(target) }));
		// Warnings print unconditionally and never decide the exit code (review F4:
		// the old string[] shape had no non-fatal channel); only problems are fatal.
		for (const report of reports) {
			for (const warning of report.warnings) console.warn(`[${report.target.name}] WARNING: ${warning}`);
		}
		const problems = reports.flatMap((report) => report.problems.map((p) => `[${report.target.name}] ${p}`));
		if (problems.length > 0) {
			console.error(`OUT OF SYNC (${problems.length}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
			return 1;
		}
		console.log(
			reports.some((r) => r.warnings.length > 0)
				? `in sync (with ${reports.reduce((n, r) => n + r.warnings.length, 0)} warning(s) above)`
				: "in sync: canonical source == user scope for all owned extensions",
		);
		return 0;
	}

	// --ai-badger is VENDOR-ONLY (review m1): the README flow runs ai-badger's tests
	// between vendoring and the user-scope install, so propagation to user scope is a
	// deliberate separate step.
	if (aiBadgerPath) {
		vendorAdapter(aiBadgerPath);
		return 0;
	}

	// Auto-install BEFORE target construction (default path) so a freshly written
	// bun.lock is canonical on the same run. --check never reaches this (read-only);
	// --ai-badger never reaches this (the adapter declares no deps).
	const runInstall = inject?.runInstall ?? bunInstall;
	// The extension dir is the PARENT of its node_modules entry (adapter targets have
	// none and are filtered out).
	ensureDependencies(
		inject?.targets
			? inject.targets
					.map((t) => (t.nodeModules ? dirname(t.nodeModules.source) : undefined))
					.filter((d): d is string => d !== undefined)
			: EXTENSION_DIRS.map((name) => join(ROOT, "extensions", name)),
		runInstall,
	);
	for (const target of inject?.targets ?? defaultTargets()) installTarget(target);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
