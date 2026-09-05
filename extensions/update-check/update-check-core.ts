/**
 * Pure update-check core for the update-check extension.
 *
 * Everything the wiring (session_start background check, `/update-check`
 * command) needs that can be decided without a process, a clock, network or
 * pi itself: semver parse/compare over GitHub release tags, the session-start
 * decision matrix, and the notice-text cap.
 *
 * Purity rules (house convention, copied from `router-fallback-core.ts`):
 *   - zero imports — compare is arithmetic, capping is slicing;
 *   - no wall-clock reads, no fs/net/pi — versions and reachability arrive as
 *     an injected input record per call;
 *   - every side effect (fetch, marker read, notices, scheduling) belongs to
 *     the wiring in `index.ts`.
 *
 * Matrix (normative — every cell pinned by test):
 *   - offline → silent always (an offline session never nags);
 *   - fetch failure with network up → silent at session start (the error is
 *     reported verbosely only under `/update-check check`);
 *   - no releases published yet → silent (nothing to compare against);
 *   - malformed remote tag → silent (the maintainer's problem, not the
 *     session's — never nag a user over a tag typo);
 *   - exact installed version → compared against remote (newer → update
 *     notice, same or installed-newer → silent); it always wins over describe;
 *   - no exact version but a recorded `git describe --long` (untagged dev
 *     checkout) → its base tag is compared instead: base at/after remote →
 *     silent (ahead of releases, nothing to install), base behind remote →
 *     update notice naming base + ahead count and remote;
 *   - no version and no usable describe with NO marker file → guidance notice
 *     (publish once to record it — actionable: publish writes the marker);
 *   - no version and no usable describe WITH a marker file (tagless checkout:
 *     publish ran where no git tag was reachable) → guidance notice naming
 *     `git fetch --tags` + re-publish (actionable: re-publish then records
 *     describe and the notice clears — a bare re-publish can never fix this,
 *     so the publish-once text must not be shown here);
 *   - remote newer → update notice naming both versions plus the exact
 *     commands (`git pull` + `bun run publish`);
 *   - same or installed-newer → silent (up to date covers equal; a dev
 *     checkout ahead of releases is not "behind").
 *
 * There is deliberately NO auto-install: the update path mutates user scope
 * (and, with `--ai-badger`, another checkout), which needs a human decision.
 * There is deliberately NO pi-version check: pi exposes no update lifecycle
 * event and no version in the extension context, so `pi update` stays the pi
 * path by documentation, not by code.
 */

/** Whole-notice cap for one update notice card (4 KB — shorter than fallback cards). */
export const UPDATE_CHECK_NOTICE_CAP_CHARS = 4 * 1024;

/** Kill-switch: the literal string `"0"` disables the background check. */
export const UPDATE_CHECK_ENV = "PI_BADGER_UPDATE_CHECK";

/** GitHub repo the check reads releases from (name only — no credentials). */
export const UPDATE_CHECK_REPO = "Arasz/pi-badger-integration";

/** API endpoint for the latest published release (releases, not tags — drafts excluded). */
export const UPDATE_CHECK_RELEASES_URL = `https://api.github.com/repos/${UPDATE_CHECK_REPO}/releases/latest`;

/** Strict semver with optional `v` prefix; no prereleases, no leading zeros. */
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parse a release tag into [major, minor, patch]; garbage → undefined (never throws). */
export function parseVersion(tag: string): [number, number, number] | undefined {
	try {
		const m = SEMVER.exec(tag.trim());
		if (!m) return undefined;
		return [Number(m[1]), Number(m[2]), Number(m[3])];
	} catch {
		return undefined;
	}
}

/** Parse `git describe --tags --long` output (`v1.2.3-5-gabc1234`) into its base
 * tag, parsed base version and ahead count; garbage → undefined (never throws). */
export function parseDescribe(describe: string): { base: [number, number, number]; baseTag: string; ahead: number } | undefined {
	try {
		const m = /^((?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-(\d+)-g([0-9a-fA-F]+)$/.exec(describe.trim());
		if (!m) return undefined;
		const base = parseVersion(m[1]);
		if (base === undefined) return undefined;
		return { base, baseTag: m[1].trim(), ahead: Number(m[2]) };
	} catch {
		return undefined;
	}
}

/** "v1.0.0 (+5 commits)" — how a describe position reads in notices and status. */
export function formatDescribed(described: { baseTag: string; ahead: number }): string {
	return `${described.baseTag} (+${described.ahead} commit${described.ahead === 1 ? "" : "s"})`;
}
/** Compare two parsed versions: -1 | 0 | 1. */
export function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): -1 | 0 | 1 {
	for (let i = 0; i < 3; i += 1) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return 0;
}

/** Input to `decideCheck` — versions as strings, reachability as booleans. */
export interface CheckInput {
	/** False → silent, unconditionally (offline never nags). */
	readonly networkUp: boolean;
	/** Installed version from the marker file; null = no marker (never installed via publish). */
	readonly installed: string | null;
	/** `git describe --tags --long` as recorded at publish; null = tagless checkout
	 * or a marker written before describe was recorded. Compared via its base tag
	 * when `installed` is null; `installed` always wins when both are present. */
	readonly installedDescribe?: string | null;
	/** False (or absent, for callers predating it) = no marker file at all → the
	 * publish-once guidance. True with no usable version info = tagless checkout
	 * → the fetch-tags guidance (a bare re-publish cannot fix that state). */
	readonly markerPresent?: boolean;
	/** Latest remote release tag; null = none published yet or fetch failed. */
	readonly remoteTag: string | null;
	/** Present when the fetch itself failed (reported verbosely, never at session start). */
	readonly remoteError?: string;
}

export type CheckDecision =
	| { readonly action: "silent"; readonly reason: string }
	| { readonly action: "notice"; readonly kind: "guidance" | "update"; readonly reason: string; readonly text: string };

/** Cap a notice into budget, keeping the TAIL (commands live at the end). */
export function capCheckText(text: string): string {
	const budget = UPDATE_CHECK_NOTICE_CAP_CHARS;
	if (text.length <= budget) return text;
	const marker = (dropped: number) => `[...${dropped} earlier characters dropped]\n`;
	const tailLength = budget - marker(text.length).length;
	if (tailLength <= 0) return text.slice(0, budget);
	return marker(text.length - tailLength) + text.slice(text.length - tailLength);
}

/**
 * Decide one check: silent or a notice card. Never throws on any input —
 * unparseable versions degrade to silent/guidance, never to an exception.
 */
export function decideCheck(input: CheckInput): CheckDecision {
	if (!input.networkUp) {
		return { action: "silent", reason: "silent: offline — update checks need network" };
	}
	if (input.remoteTag === null) {
		if (input.remoteError !== undefined) {
			return { action: "silent", reason: `silent: release fetch failed (${input.remoteError}) — verbose under /update-check check` };
		}
		return { action: "silent", reason: "silent: no releases published yet — nothing to compare against" };
	}
	const remote = parseVersion(input.remoteTag);
	if (remote === undefined) {
		return { action: "silent", reason: `silent: remote tag ${input.remoteTag} is not semver — maintainer's problem, not the session's` };
	}
	if (input.installed === null) {
		const described = input.installedDescribe != null ? parseDescribe(input.installedDescribe) : undefined;
		if (described !== undefined) {
			const order = compareVersions(described.base, remote);
			if (order >= 0) {
				return {
					action: "silent",
					reason:
						order === 0
							? `silent: dev checkout at ${formatDescribed(described)} (ahead of latest release ${input.remoteTag})`
							: `silent: installed base ${formatDescribed(described)} is ahead of latest release ${input.remoteTag} (dev checkout)`,
				};
			}
			return {
				action: "notice",
				kind: "update",
				reason: `update: ${input.remoteTag} is newer than installed ${formatDescribed(described)}`,
				text: capCheckText(
					`update-check: integration update available — installed ${formatDescribed(described)}, latest release ${input.remoteTag}.\n` +
						"To update:\n" +
						"  git pull\n" +
						"  bun run publish\n" +
						"  bun run check\n" +
						"For pi itself, run `pi update`.",
				),
			};
		}
		if (input.markerPresent === true) {
			return {
				action: "notice",
				kind: "guidance",
				reason: "guidance: marker present but the checkout has no git tags for publish to record — fetch tags and re-publish",
				text: capCheckText(
					"update-check: installed version unknown (this checkout has no git tags for publish to record).\n" +
						"Fetch tags once, then re-publish: `git fetch --tags && bun run publish`. " +
						"Future sessions then compare against GitHub releases automatically. " +
						"For pi itself, `pi update` stays the path.",
				),
			};
		}
		return {
			action: "notice",
			kind: "guidance",
			reason: "guidance: no installed-version marker — publish records it",
			text: capCheckText(
				"update-check: installed version unknown (no marker file).\n" +
					"Publish this checkout once to record it: `bun run publish`. " +
					"Future sessions then compare against GitHub releases automatically. " +
					"For pi itself, `pi update` stays the path.",
			),
		};
	}
	const installed = parseVersion(input.installed);
	if (installed === undefined) {
		return {
			action: "notice",
			kind: "guidance",
			reason: "guidance: installed marker is corrupt — re-publish to repair it",
			text: capCheckText(
				"update-check: installed-version marker is corrupt.\n" +
					"Re-publish this checkout to repair it: `bun run publish`.",
			),
		};
	}
	const order = compareVersions(installed, remote);
	if (order >= 0) {
		return {
			action: "silent",
			reason:
				order === 0
					? `silent: up to date at ${input.installed}`
					: `silent: installed ${input.installed} is ahead of latest release ${input.remoteTag} (dev checkout)`,
		};
	}
	return {
		action: "notice",
		kind: "update",
		reason: `update: ${input.remoteTag} is newer than installed ${input.installed}`,
		text: capCheckText(
			`update-check: integration update available — installed ${input.installed}, latest release ${input.remoteTag}.\n` +
				"To update:\n" +
				"  git pull\n" +
				"  bun run publish\n" +
				"  bun run check\n" +
				"For pi itself, run `pi update`.",
		),
	};
}

/** True iff the background check is disabled via the literal `"0"`. */
export function isDisabled(env: { readonly [name: string]: string | undefined } = {}): boolean {
	return env[UPDATE_CHECK_ENV] === "0";
}
