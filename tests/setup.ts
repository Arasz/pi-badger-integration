/**
 * Shared harness: loads the real extension through pi's loading mechanism
 * (jiti + package alias) and builds editors against the real pi-tui editor
 * chain with stubbed TUI/theme.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The canonical extension source this repo owns — never the user-scope copy.
 * publish.ts is what propagates canonical → user scope, so the tests here gate
 * exactly what will ship. */
export const EXTENSION_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"extensions",
	"shift-enter-newline.ts",
);

const GLOBAL_PI = join(
	homedir(),
	".bun/install/global/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const require2 = createRequire(GLOBAL_PI);
const { createJiti } = require2("jiti");

// The full default table (tui.* + app.*) — the app.* entries matter because
// app.message.followUp (alt+enter) is what intercepts ESC+CR in real pi. The
// subpath is not in the package exports map, so require it by absolute path.
const { KEYBINDINGS } = require2(join(dirname(GLOBAL_PI), "dist", "core", "keybindings.js"));

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
	// resolve from the global install's own tree, so the aliased packages are the exact
	// copies the running pi uses (no local duplicate to drift)
	alias: {
		"@earendil-works/pi-coding-agent": join(dirname(GLOBAL_PI), "dist", "index.js"),
		"@earendil-works/pi-tui": join(dirname(GLOBAL_PI), "..", "pi-tui", "dist", "index.js"),
	},
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the extension is user-authored TS
let cached: any;

/** Load the real extension module (cached for the suite). */
export async function loadExtension() {
	cached ??= await jiti.import(EXTENSION_PATH);
	return cached;
}

/** Minimal TUI stub: the editor paths under test only need requestRender. */
export function tuiStub() {
	return { requestRender() {} };
}

/** Theme stub returning no-op stylers for every requested color. */
export function themeStub() {
	return new Proxy({} as Record<string | symbol, unknown>, {
		get: (_target, key) => (key === "borderColor" ? "" : () => ""),
	}) as never;
}

export interface HelperStub {
	isModifierPressed(key: "shift"): boolean;
}

export interface EditorHarness {
	editor: {
		handleInput(data: string): void;
		getText(): string;
		setText(text: string): void;
		onSubmit?: (text: string) => void;
		onAction(action: string, handler: () => void): void;
	};
	submitted: { value: string | null };
	followUpCalled: { value: boolean };
}

/**
 * Build the extension's own ShiftEnterEditor against the full default
 * keybindings (tui + app) with submit and follow-up spies wired the way
 * interactive-mode wires them. `helper` is the shift stub under test; pass
 * undefined to exercise the no-helper path.
 */
export async function makeEditor(helper: HelperStub | undefined): Promise<EditorHarness> {
	const ext = await loadExtension();
	const { KeybindingsManager } = require2("@earendil-works/pi-tui");
	const editor = new ext.ShiftEnterEditor(tuiStub(), themeStub(), new KeybindingsManager(KEYBINDINGS), helper);
	const submitted = { value: null as string | null };
	const followUpCalled = { value: false };
	editor.onSubmit = (text: string) => {
		submitted.value = text;
	};
	editor.onAction("app.message.followUp", () => {
		followUpCalled.value = true;
	});
	return { editor, submitted, followUpCalled };
}
