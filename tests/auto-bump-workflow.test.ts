/**
 * The auto-bump workflow, exercised for real against a local origin.
 *
 * The workflow's script is the release machinery: it turns a push to main into one
 * patch release. It used to push the bump commit straight to main — which the
 * ruleset rejects, because a GITHUB_TOKEN push triggers no workflow run, so the
 * commit can never carry the required `test` check. The bump now travels as a pull
 * request, and this test drives that script with a fake `gh` and a local bare repo:
 * the bump lands on main, the tag points at it, the release is cut — and a failing
 * check stops everything before a merge.
 *
 * The script is read out of the workflow file rather than copied here: a copy
 * would test itself, not the thing that ships.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "auto-bump.yml");

/** The workflow's own bump script, extracted from the file that ships it. */
function bumpScript(): string {
	const workflow = readFileSync(WORKFLOW, "utf-8");
	const step = workflow.split("- name: Bump patch and push")[1];
	if (!step) throw new Error("the auto-bump workflow has no 'Bump patch and push' step");
	const script = step.split("run: |")[1];
	if (!script) throw new Error("the bump step has no run script");
	// The step's own lines are indented by 10 spaces in the YAML block.
	return script
		.split("\n")
		.map((line) => line.replace(/^ {10}/, ""))
		.join("\n");
}

/** A fake `gh`: the PR, the checks, the merge and the release, without a network. */
function fakeGh(stateDir: string, checks: "pass" | "fail"): string {
	return `#!/bin/bash
set -u
STATE="${stateDir}"
mkdir -p "$STATE"
case "$1 $2" in
  "pr create")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--head" ]; then echo "$2" > "$STATE/branch"; fi
      shift
    done
    echo "https://github.com/o/r/pull/7" ;;
  "pr checks")
    if [ "${checks}" = "fail" ]; then echo "test\\tfail"; exit 1; fi
    echo "test\\tpass"; exit 0 ;;
  "pr merge")
    git push -q origin "$(cat "$STATE/branch")":main ;;
  "release view") exit 1 ;;
  "release create") echo "$3" > "$STATE/release" ;;
  *) echo "unexpected gh call: $*" >&2; exit 97 ;;
esac
`;
}

interface Sandbox {
	dir: string;
	origin: string;
	work: string;
	state: string;
	bin: string;
}

/** A local origin with a VERSION file, a work clone and a fake `gh` on the PATH. */
function sandbox(checks: "pass" | "fail"): Sandbox {
	const dir = mkdtempSync(join(tmpdir(), "aib-auto-bump-"));
	const origin = join(dir, "origin.git");
	const work = join(dir, "work");
	const state = join(dir, "state");
	const bin = join(dir, "bin");
	mkdirSync(origin);
	mkdirSync(work);
	mkdirSync(bin);
	const git = (args: string[], cwd = work) =>
		execFileSync("git", args, { cwd, encoding: "utf-8" });
	git(["init", "--bare", "-b", "main", origin], dir);
	git(["init", "-b", "main", work], dir);
	git(["remote", "add", "origin", origin], work);
	git(["config", "user.name", "t"], work);
	git(["config", "user.email", "t@t"], work);
	writeFileSync(join(work, "VERSION"), "1.4.0\n");
	writeFileSync(join(work, "README.md"), "x\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "init"]);
	git(["push", "-q", "origin", "main"]);
	const gh = join(bin, "gh");
	writeFileSync(gh, fakeGh(state, checks));
	chmodSync(gh, 0o755);
	return { dir, origin, work, state, bin };
}

/** Run the workflow's script in the sandbox, with the fake `gh` on the PATH. */
function runBump(box: Sandbox, baseSha: string): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("bash", ["-c", bumpScript()], {
		cwd: box.work,
		encoding: "utf-8",
		env: {
			...process.env,
			PATH: `${box.bin}:${process.env.PATH ?? ""}`,
			BASE_SHA: baseSha,
			GH_TOKEN: "test-token",
		},
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The file `git show <ref>:<path>` reads out of the origin. */
function show(box: Sandbox, ref: string, path: string): string {
	return execFileSync("git", ["show", `${ref}:${path}`], { cwd: box.origin, encoding: "utf-8" });
}

describe("the auto-bump workflow", () => {
	test("a push to main becomes one patch release, through a pull request", () => {
		const box = sandbox("pass");
		try {
			const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: box.work, encoding: "utf-8" }).trim();
			const result = runBump(box, base);

			expect(result.status).toBe(0);
			// The bump landed on main as a merged pull request.
			expect(show(box, "main", "VERSION").trim()).toBe("1.4.1");
			expect(existsSync(join(box.state, "branch"))).toBe(true);
			// The tag points at the commit that carries the new version.
			const tags = execFileSync("git", ["tag"], { cwd: box.origin, encoding: "utf-8" }).trim();
			expect(tags).toBe("v1.4.1");
			const main = execFileSync("git", ["rev-parse", "main"], { cwd: box.origin, encoding: "utf-8" }).trim();
			const tagged = execFileSync("git", ["rev-list", "-n", "1", "v1.4.1"], { cwd: box.origin, encoding: "utf-8" }).trim();
			expect(tagged).toBe(main);
			// And the release exists.
			expect(existsSync(join(box.state, "release"))).toBe(true);
		} finally {
			rmSync(box.dir, { recursive: true, force: true });
		}
	});

	test("a push that already touched VERSION stands down: no branch, no release", () => {
		const box = sandbox("pass");
		try {
			// A second commit that touches VERSION is what a manual version push looks like.
			execFileSync("git", ["checkout", "-q", "-b", "manual"], { cwd: box.work });
			writeFileSync(join(box.work, "VERSION"), "2.0.0\n");
			execFileSync("git", ["add", "-A"], { cwd: box.work });
			execFileSync("git", ["commit", "-q", "-m", "manual version"], { cwd: box.work });
			execFileSync("git", ["push", "-q", "origin", "manual:main"], { cwd: box.work });
			const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: box.work, encoding: "utf-8" }).trim();

			const result = runBump(box, base);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("standing down");
			expect(existsSync(join(box.state, "branch"))).toBe(false);
			expect(show(box, "main", "VERSION").trim()).toBe("2.0.0");
		} finally {
			rmSync(box.dir, { recursive: true, force: true });
		}
	});

	test("a failing check stops the bump before anything is merged", () => {
		const box = sandbox("fail");
		try {
			const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: box.work, encoding: "utf-8" }).trim();
			const result = runBump(box, base);

			expect(result.status).not.toBe(0);
			expect(show(box, "main", "VERSION").trim()).toBe("1.4.0");
			const tags = execFileSync("git", ["tag"], { cwd: box.origin, encoding: "utf-8" }).trim();
			expect(tags).toBe("");
		} finally {
			rmSync(box.dir, { recursive: true, force: true });
		}
	});
});
