/**
 * Publish flow for the extensions this repo owns. Run with bun:
 *
 *   bun publish.ts                     install canonical → pi user scope
 *   bun publish.ts --check             read-only: report drift, exit 1 on any
 *   bun publish.ts --ai-badger <path>  ALSO vendor the adapter into an ai-badger
 *                                      checkout (never combined with --check)
 *
 * The repo owns two extensions:
 *   1. the ai-badger hooks adapter — canonical at
 *      features/pi/adjustments/adapter/ (dir mirrors ai-badger's vendored path so
 *      tests import unchanged); ai-badger vendors it because its scaffold-freshness
 *      gates require the shipping copy in-repo.
 *   2. shift-enter-newline — canonical at extensions/shift-enter-newline.ts;
 *      a standalone single-file extension installed only at user scope.
 *
 * Semantics folded in from the plan review (2026-08-29):
 *   - --check NEVER writes; --ai-badger always writes and always announces it.
 *   - the adapter target enforces exact file-set equality (missing, extra AND
 *     byte-differing files all fail --check): adjust_hooks.py's copy contract ships
 *     any .ts/.json with no cleanup, so a renamed canonical file would leave a stale
 *     extra at user scope and break every fresh pi session.
 *   - installs write to a temp file then rename, so a pi session starting
 *     mid-publish cannot load a mixed old/new pair (running sessions are unaffected —
 *     jiti has already loaded their modules).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Byte-identical to ai-badger's adjust_hooks.py copy contract — never add a file here
 * without vendoring it there too, or scaffolds will ship it while --check calls it extra. */
const ADAPTER_FILES = ["index.ts", "hook-bridge.ts", "package.json"] as const;

const ADAPTER_SOURCE_DIR = "features/pi/adjustments/adapter";
const SHIFT_ENTER_SOURCE = "extensions/shift-enter-newline.ts";
const USER_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");
const ADAPTER_USER_DIR = join(USER_EXTENSIONS_DIR, "ai-badger");
const SHIFT_ENTER_USER_PATH = join(USER_EXTENSIONS_DIR, "shift-enter-newline.ts");

const ROOT = dirnameOf(import.meta.url);

interface Target {
	name: string;
	/** Canonical file → its expected content hash source. */
	pairs: Array<{ source: string; destination: string }>;
	/** Set only when this target owns the WHOLE destination directory: extra files there
	 * are drift. A single-file target must not set it — its destination dir is shared with
	 * every other extension pi loads. */
	ownedDir?: string;
}

function dirnameOf(url: string): string {
	return new URL(".", url).pathname;
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

function shiftEnterTarget(): Target {
	return {
		name: `shift-enter-newline (${SHIFT_ENTER_USER_PATH})`,
		pairs: [{ source: join(ROOT, SHIFT_ENTER_SOURCE), destination: SHIFT_ENTER_USER_PATH }],
	};
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Missing / extra / byte-differing, from the destination's point of view. */
function drifts(target: Target): string[] {
	const problems: string[] = [];
	for (const { source, destination } of target.pairs) {
		if (!existsSync(source)) problems.push(`canonical source missing: ${source}`);
		else if (!existsSync(destination)) problems.push(`not installed: ${destination}`);
		else if (sha256(source) !== sha256(destination)) problems.push(`differs: ${destination}`);
	}
	const destinationDir = target.ownedDir ? target.ownedDir : undefined;
	if (destinationDir !== undefined && existsSync(destinationDir)) {
		for (const entry of readdirSync(destinationDir)) {
			const shipped = target.pairs.some((p) => p.destination === join(destinationDir, entry));
			if (!shipped) {
				problems.push(`extra file at destination (not canonical): ${join(destinationDir, entry)}`);
			}
		}
	}
	return problems;
}

function dirnameOf2(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

/** Install one file atomically enough for a directory pi reads at session start. */
function install(source: string, destination: string): void {
	mkdirSync(dirnameOf2(destination), { recursive: true });
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

function main(argv: string[]): number {
	const check = argv.includes("--check");
	const aiBadgerFlag = argv.indexOf("--ai-badger");
	const aiBadgerPath = aiBadgerFlag >= 0 ? argv[aiBadgerFlag + 1] : undefined;
	if (aiBadgerFlag >= 0 && !aiBadgerPath) {
		console.error("FATAL: --ai-badger needs a path to an ai-badger checkout");
		return 1;
	}

	const targets = [adapterTarget(ADAPTER_USER_DIR), shiftEnterTarget()];

	if (check) {
		const problems = targets.flatMap((target) => drifts(target).map((p) => `[${target.name}] ${p}`));
		if (problems.length > 0) {
			console.error(`OUT OF SYNC (${problems.length}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
			return 1;
		}
		console.log("in sync: canonical source == user scope for all owned extensions");
		return 0;
	}

	if (aiBadgerPath) vendorAdapter(aiBadgerPath);
	for (const target of targets) installTarget(target);
	return 0;
}

process.exit(main(process.argv.slice(2)));
