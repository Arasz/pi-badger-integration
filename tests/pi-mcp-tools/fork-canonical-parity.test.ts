/**
 * Fork↔canonical parity gate for pi-mcp-tools (plan rev 3 §2 P2, outcome R5).
 *
 * The canonical copy in repo A is FLAT (`extensions/pi-mcp-tools/*.ts`, NO src/):
 * pi loads the directory's index.ts, and a src/ directory would double-load the
 * extension via the stale upstream `pi.extensions` field (the hazard P1 fixed in
 * the fork's package.json and P2 synced). Every synced source file, the fixed
 * package.json and the capability doc must stay byte-identical to the P1 fork
 * at ~/RiderProjects/pi-mcp-tools-fork.
 *
 * The mirrored tests are deliberate ports (vitest → bun:test) and are NOT
 * compared byte-wise — repo A's test layout owns them.
 *
 * When the fork checkout is absent the gate LOUDLY SKIPS: a printed warning and
 * a skipped suite — never a silent green.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FORK_ROOT = join(process.env.HOME ?? "", "RiderProjects", "pi-mcp-tools-fork");
const CANONICAL_DIR = join(import.meta.dir, "..", "..", "extensions", "pi-mcp-tools");

const forkPresent = existsSync(join(FORK_ROOT, "src")) && existsSync(join(FORK_ROOT, "package.json"));

if (!forkPresent) {
	console.warn(
		`[fork-canonical-parity] LOUD SKIP: fork checkout not found at ${FORK_ROOT} — the parity gate is ` +
			`BLIND while it is absent; canonical↔fork byte-identity is unverified. Restore the fork to re-arm.`,
	);
}

function forkSrcFiles(): string[] {
	return readdirSync(join(FORK_ROOT, "src")).filter((f) => f.endsWith(".ts")).sort();
}

function canonicalTsFiles(): string[] {
	return readdirSync(CANONICAL_DIR).filter((f) => f.endsWith(".ts")).sort();
}

describe.skipIf(!forkPresent)("fork↔canonical parity (extensions/pi-mcp-tools)", () => {
	test("canonical stays flat — no src/ directory that could double-load via pi.extensions", () => {
		expect(existsSync(join(CANONICAL_DIR, "src"))).toBe(false);
	});

	test("canonical .ts file set == fork src/ file set", () => {
		expect(canonicalTsFiles()).toEqual(forkSrcFiles());
	});

	test("every synced .ts file is byte-identical to the fork", () => {
		for (const name of forkSrcFiles()) {
			const forkBytes = readFileSync(join(FORK_ROOT, "src", name));
			const canonicalBytes = readFileSync(join(CANONICAL_DIR, name));
			expect(canonicalBytes.equals(forkBytes), `${name} diverged from the fork`).toBe(true);
		}
	});

	test("package.json is byte-identical (stale main/pi.extensions would regress the double-load hazard)", () => {
		const canonical = readFileSync(join(CANONICAL_DIR, "package.json"));
		const fork = readFileSync(join(FORK_ROOT, "package.json"));
		expect(canonical.equals(fork), "package.json diverged from the fork").toBe(true);
	});

	test("CAPABILITY_PROJECT_SCOPE_MCP ships byte-identical", () => {
		const canonical = readFileSync(join(CANONICAL_DIR, "CAPABILITY_PROJECT_SCOPE_MCP"));
		const fork = readFileSync(join(FORK_ROOT, "CAPABILITY_PROJECT_SCOPE_MCP"));
		expect(canonical.equals(fork), "CAPABILITY_PROJECT_SCOPE_MCP diverged from the fork").toBe(true);
	});

	test("the installed marker .ai-badger-capability-project-scope-mcp exists in canonical (the adjustment gate reads it at user scope)", () => {
		expect(existsSync(join(CANONICAL_DIR, ".ai-badger-capability-project-scope-mcp"))).toBe(true);
	});
});
