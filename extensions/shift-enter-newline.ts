/**
 * Shift+Enter inserts a newline in terminals whose Shift+Enter bytes would otherwise
 * be consumed as a follow-up submit (JetBrains IDE terminal).
 *
 * The JetBrains terminal sends Shift+Enter as ESC+CR (\x1b\r), which terminals
 * conventionally read as Alt+Enter — and pi binds Alt+Enter to
 * app.message.followUp, which submits/queues the prompt before the editor's
 * newline handling ever runs. When that sequence (or a bare CR, as from Apple
 * Terminal-style fallbacks) arrives and the physical Shift key is held on the
 * local Mac keyboard, rewrite it to the Kitty CSI-u sequence so the editor
 * inserts a newline instead. Without Shift held, ESC+CR passes through so the
 * genuine Option+Enter follow-up binding keeps working.
 *
 * Diagnostics: /shift-enter-debug reports pipeline state and writes a detailed
 * trace (recent control/sequence inputs, the Shift poll result at the last CR,
 * effective newLine/submit bindings) to /tmp/shift-enter-debug.log.
 *
 * Limitations (inherited from the mechanism, same as pi's Apple Terminal
 * fallback): reads the physical keyboard of the machine pi runs on, so it does
 * nothing useful over SSH, and Shift+Enter can no longer be used to submit.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { appendFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/** Kitty keyboard protocol CSI-u encoding for Shift+Enter (what pi's native fallback emits). */
export const SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

const DEBUG_LOG = "/tmp/shift-enter-debug.log";

export interface ModifierHelper {
	isModifierPressed(key: "shift"): boolean;
}

interface RecordedInput {
	data: string;
	/** Shift poll result at arrival; null for non-CR inputs. */
	shift: boolean | null;
	at: number;
}

const recentInputs: RecordedInput[] = [];

function recordInput(data: string, shift: boolean | null) {
	recentInputs.push({ data, shift, at: Date.now() });
	if (recentInputs.length > 8) recentInputs.shift();
}

/**
 * Locate pi-tui's native modifier helper (CGEventSource-backed) shipped with the
 * pi installation. Returns undefined when unavailable (non-macOS, unsupported
 * arch, or unknown install layout) and the editor then behaves exactly like the
 * default one.
 */
export function loadShiftHelper(): ModifierHelper | undefined {
	if (process.platform !== "darwin") return undefined;
	if (process.arch !== "arm64" && process.arch !== "x64") return undefined;
	const relative = path.join(
		"@earendil-works",
		"pi-tui",
		"native",
		"darwin",
		"prebuilds",
		`darwin-${process.arch}`,
		"darwin-modifiers.node",
	);
	const nodeRequire = createRequire(import.meta.url);
	const candidates: string[] = [];
	try {
		candidates.push(
			path.join(path.dirname(nodeRequire.resolve("@earendil-works/pi-tui/package.json")), relative),
		);
	} catch {
		// No node_modules chain above the extension; rely on the install-layout roots below.
	}
	for (const root of [
		path.join(homedir(), ".bun", "install", "global", "node_modules"),
		path.join(path.dirname(process.execPath), "..", "lib", "node_modules"),
		path.join("/opt", "homebrew", "lib", "node_modules"),
		path.join("/usr/local", "lib", "node_modules"),
	]) {
		candidates.push(path.join(root, relative));
	}
	for (const candidate of candidates) {
		try {
			if (!existsSync(candidate)) continue;
			const helper = nodeRequire(candidate) as ModifierHelper;
			if (typeof helper?.isModifierPressed === "function") return helper;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/**
 * Editor that rewrites a bare CR to the Kitty Shift+Enter sequence while the
 * physical Shift key is held. Retries the helper load lazily so a transient
 * failure at startup recovers on first use instead of dying silently.
 */
export class ShiftEnterEditor extends CustomEditor {
	private shiftHelper: ModifierHelper | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		shiftHelper: ModifierHelper | undefined,
	) {
		super(tui, theme, keybindings);
		this.shiftHelper = shiftHelper;
	}

	override handleInput(data: string): void {
		if (data === "\r" || data === "\x1b\r") {
			if (!this.shiftHelper) this.shiftHelper = loadShiftHelper();
			const shift = this.shiftHelper?.isModifierPressed("shift") ?? null;
			recordInput(data, shift);
			if (shift) data = SHIFT_ENTER_SEQUENCE;
		} else if (data.length !== 1 || data.charCodeAt(0) < 32) {
			recordInput(data, null);
		}
		super.handleInput(data);
	}
}

function describeInput(entry: RecordedInput): string {
	const escaped = JSON.stringify(entry.data);
	const shift = entry.shift === null ? "" : ` shift=${entry.shift}`;
	return `${escaped}${shift}`;
}

export default function (pi: ExtensionAPI) {
	const shiftHelper = loadShiftHelper();
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new ShiftEnterEditor(tui, theme, keybindings, shiftHelper),
		);
	});

	pi.registerCommand("shift-enter-debug", {
		description:
			"Report shift+enter pipeline state; press Shift+Enter once first, then run this",
		handler: async (_args, ctx) => {
			const helper = shiftHelper ?? loadShiftHelper();
			const factory = ctx.ui.getEditorComponent();
			const editorInstalled = String(factory).includes("ShiftEnterEditor");
			const liveShift = helper ? helper.isModifierPressed("shift") : null;
			const kb = getKeybindings();
			const newLineKeys = kb.getKeys("tui.input.newLine");
			const submitKeys = kb.getKeys("tui.input.submit");
			const lines = [
				`state: helper=${helper ? "loaded" : "missing"} editor=${editorInstalled ? "installed" : "default"} shiftNow=${liveShift ?? "n/a"} platform=${process.platform}/${process.arch} TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "-"} TERMINAL_EMULATOR=${process.env.TERMINAL_EMULATOR ?? "-"} pid=${process.pid} started=${new Date(process.uptime() ? Date.now() - process.uptime() * 1000 : Date.now()).toLocaleTimeString()}`,
				`bindings: newLine=[${newLineKeys.join(", ")}] submit=[${submitKeys.join(", ")}]`,
				`recent inputs (oldest first):`,
				...recentInputs.map((entry) => `  ${new Date(entry.at).toLocaleTimeString()} ${describeInput(entry)}`),
			];
			try {
				appendFileSync(DEBUG_LOG, `${lines.join("\n")}\n`);
			} catch {
				// Logging is best-effort; the notify below still shows the summary.
			}
			const lastCr = [...recentInputs].reverse().find((entry) => entry.data === "\r");
			const lastCrSummary = lastCr
				? `last CR saw shift=${lastCr.shift}`
				: "no bare CR has reached the editor yet";
			ctx.ui.notify(
				`shift-enter: ${lastCrSummary}; details -> ${DEBUG_LOG}`,
				helper && editorInstalled ? "info" : "warning",
			);
		},
	});
}
